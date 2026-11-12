# Marketplace sync (B2 + B5)

How local data reaches MyTownCart and how the marketplace reaches back. The
decision log entries that this implements are `DECISIONS.md` B3-1, B5-1 and
B4-2; the connector contract is `packages/connector-mytowncart/src/index.ts`.

## Connection

The seller opens **MyTownCart**, clicks *Connect*, and the app shows a
device-code panel:

1. The app POSTs to create a connect session and displays a user code plus a
   link to `mytowncart.com`.
2. The seller approves on the website while signed in.
3. The app polls until a `ConnectionToken` arrives and stores it:
   - desktop: OS keychain, key `mytowncart.integration`;
   - browser dev: module memory only.

Scopes requested: `catalog`, `stock`, `orders` (`CONNECT_SCOPES`). Revoking
on the website leads to `unauthorized` / `expired_token` on the next call,
which clears the connection and asks the seller to reconnect.

**Never** put the token in SQLite, `localStorage`, a log, or a diagnostics
event. `redact()` drops token-shaped strings before an event is recorded.

## Reading the comparison

`reconcile()` in `packages/core/src/sync.ts` compares **remote** stock with
the **last-pushed remote hash** rather than the local `stock_milli`: the
difference between remote stock and what was last pushed is what happened
online. "Local wins" is the default answer for each row (BR5); the seller can
also *pull* the remote value into the till.

When the seller picks *local wins*, the connector writes the local value and
the app clears the item's `content_hash` so the next sync pushes catalog
content again.

## What is sent, and when

| Data | Trigger | Sent |
|---|---|---|
| Catalog (item changes) | *Publish* on the MyTownCart screen | name, barcode, price, MRP, stock, category mapping, visibility |
| Photos | *Upload photos* (pending list) | the stored JPEG/PNG/WebP bytes, as the main image |
| Stock deltas | every sync run | merged net whole-unit deltas per item |
| Orders | every sync run, by cursor | nothing (read only) |
| Stock feed | every sync run, by cursor | nothing (read only) |

No bills, customers, addresses or payment details are ever sent.

## Stock push: the outbox

Every sale, void and adjustment on a remote-linked item also writes an
`outbox` row in the same transaction as the ledger movement
(`bill:<billId>:<movementId>` or `adj:<movementId>`). The outbox is the source
of truth for "what the marketplace still needs to hear".

- **Reasons mirrored:** `sale` → `sale`, `void` → `order_cancel`,
  `adjustment` → `adjustment`. Opening stock, purchases and imports are local
  and never pushed.
- **Whole units only.** A delta that is not a multiple of 1000 thousandths
  (e.g. a by-weight correction) stays local. Pushing a truncated number would
  look like a real sale online. The Rust `enqueue_movement` and the memory
  adapter both apply this rule.
- **Merge per run.** `netDeltas()` sums all pending rows per external id.
  Zero-sum sets are settled without a call.
- **Fresh idempotency key.** Each merged move gets
  `itm_<id>:merge:<epoch ms>:<random>`. Per-movement keys would replay
  intermediate values; a new key per merged delta means the marketplace can
  still de-duplicate a retried HTTP call (the same body, same key) but never
  re-applies an old partial number.
- **Backoff.** A failed batch schedules every item in it at
  30 s × 2^attempts, capped at 30 min (`backoffMs`). `attempts` grows on each
  failure; only rows whose `next_attempt_at` has passed are sent.
- **Settlement.** Accepted rows are deleted from the outbox; rejected rows stay
  pending and show up under *problems* in the Sync panel.

## Stock pull

`connector.pullStock(cursor)` returns movements made online (online orders
cancel sales, order cancellations restock, remote adjustments) plus
`nextCursor`. The app applies each batch through
`applyStockPull(nextCursor, moves)`:

- the cursor and the movements are **one transaction** — a crash either
  applies both or neither, so nothing is applied twice or skipped;
- each move becomes a movement with
  `reason = online_order | order_cancel | remote_adjustment` and
  `ref_type = remote`;
- unknown external ids are reported back and skipped.

The pull loop runs until the feed returns no new cursor.

## Catalog push

`pushCatalog` runs after the stock push so the marketplace receives the same
stock it just acknowledged.

1. Refresh local items.
2. For remote-linked items that the marketplace now reports as changed, write
   the marketplace's numbers back locally (`syncedAt`, stock, price) so the
   content hash matches.
3. `planPublish(toPlanInputs(items, categories), marketplaceCategories)`
   decides what is ready vs blocked:
   - **blocked** — no category mapping, duplicate barcode, missing photo
     (published hidden), invalid price/MRP (`mrp < price`), etc.;
   - **ready** — send via `upsertItems` with `visible: !photoMissing`.
4. Accepted results store `remote_product_id`, `content_hash`,
   `remote_hash`, `publish_state`.

Only items whose content changed (`needsCatalogPush`) are re-sent after the
first publish.

## Photos (D9)

An item without a photo is published hidden; the MyTownCart screen keeps a
pending list. On *Upload photos*, each photo is sent with
`isMain = !imageUploadedAt` (the first one becomes the main image) and
recorded with `recordImageUploads`, which stores `image_uploaded_at` only
when the hash still matches the file on disk — replacing the photo while an
upload is in flight does not mark the new bytes as uploaded.

Accepted uploads make the item visible on the next catalog push.

## Reconcile

`SyncPanel` lists `listReconcileRows()`: price differences, stock
differences, items that vanished remotely (`missing_remote`) and items still
active remotely although deactivated locally (`remote_inactive`). For each
row the seller picks:

- **Local wins** (default) — `applyReconcileFixes([{kind: remote}]…)` writes
  the local value remotely and clears `content_hash` so the catalog push
  re-sends it;
- **Pull** — `{kind: local}` writes the remote value locally (as an
  adjustment movement), so the ledger explains the change.

The remote snapshot used for this comes from `remote.seen`, refreshed on each
sync and ignored after 7 days.

## Online orders

Billing does not list online orders. Fulfilment stays in the MyTownCart seller
app; billing only keeps the stock effect (through the stock pull). The old
`remote_orders` cache and `pullOrders` were removed (migration 0013).

## Scheduling

The Sync panel runs an automatic sync every 5 minutes while open (in the
desktop shell only) and offers *Sync now*. The outcome is stored as
`sync.last` in `app_settings` and summarised: moves pushed, pulled,
restocked, catalog sent/failed, orders, and a list of problems.

## Rate limit and common messages

`GET stock/` and `GET orders/` allow one poll per token every 120 s; *Sync now* sends `force=1` and
bypasses it. If two clients share a token, the other gets "Couldn't fetch stock changes. Will retry."
until the next interval or *Sync now*. New items are uploaded only when *Sync all items*
(`sync.list_enabled`) is on; with it off only already-published items are kept up to date.
"Couldn't read your MyTownCart catalog" in a browser (LAN) view means sync is not supported there.

## Failure rules

- **Never block the sale.** Local bills and movements are written first.
- **Network errors** never lose data; the outbox keeps the rows.
- **Bad tokens** stop the run and ask for a reconnect.
- **Unexpected remote data** (unknown item, malformed move) is skipped and
  listed as a problem for the seller, not retried forever.
- **Browser build**: `syncAvailable()` is false; the panel explains that sync
  needs the desktop app.
