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

`reconcile()` in `packages/core/src/sync.ts` compares linked local items with
the last successfully read remote values, producing stock, price and availability
differences. A difference is not proof of its cause or of an unconsumed feed event.
"Local wins" is the default answer for each row (BR5); the seller can also choose
the remote value.

Stock decisions use the conditional stock protocol described below, not catalog
republishing. Price and visibility decisions retain the metadata reconciliation
path. A catalog snapshot is only a display aid, not a stock revision guarantee.

## What is sent, and when

| Data | Trigger | Sent |
|---|---|---|
| Catalog (item changes) | *Publish* on the MyTownCart screen | name, barcode, price, MRP, stock, category mapping, visibility |
| Photos | *Upload photos* (pending list) | the stored JPEG/PNG/WebP bytes, as the main image |
| Stock deltas | bounded sync runs | immutable, ordered whole-unit source movements |
| Stock feed | periodic and manual sync runs, by cursor | nothing (read only) |

No bills, customers, addresses or payment details are ever sent.

## Stock push: the outbox

Every sale, void and adjustment on a remote-linked item also writes an
`outbox` row in the same transaction as the ledger movement
(`bill:<billId>:<movementId>` or `adj:<movementId>`). The outbox is the source
of truth for "what the marketplace still needs to hear".

- **Reasons:** sales, voids, adjustments, purchases and returns can enqueue
  movements. Each source keeps its reason; the connector maps `sale` to backend
  `pos_sale`. Opening stock and imports are not enqueued as movements.
- **Whole units only.** A delta that is not a multiple of 1000 thousandths
  (e.g. a by-weight correction) stays local. Pushing a truncated number would
  look like a real sale online. The Rust `enqueue_movement` and the memory
  adapter both apply this rule.
- **Ordered delivery.** One persisted delivery owns one exact source row.
  Sale/void pairs are not netted: their order matters when stock clamps at zero.
  An unresolved predecessor blocks later movements for that item, not other items.
- **Stable idempotency.** Payload and key are persisted before network I/O and
  reused after a lost response, restart or expired claim. Claim tokens fence local
  settlement; they do not cancel an already dispatched HTTP request. Backend
  duplicate checks and version-2 generation fences protect remote mutations.
- **Backoff.** Retry scheduling preserves the stored payload and source boundary.
  Attempts use exponential backoff, capped at 30 minutes; later sales cannot be
  folded into an uncertain delivery. Each run is bounded.
- **Settlement.** A matching claim atomically acknowledges the delivery and exact
  source. Permanent errors, unknown/clamped outcomes and ambiguous legacy rows
  remain visible for review rather than being blindly replayed or discarded.
- **Upgrade quarantine.** Migration 0015 quarantines all pre-upgrade pending rows,
  even those with zero recorded attempts: an older merged push may have committed
  under an unknown key. The seller must explicitly resolve the stock baseline.
  Upgrade host/frontend together; older binaries refuse the newer schema.
  Malformed legacy rows retain their exact original payload and key. Host-only
  recovery requires an explicit reason: map the source to a verified linked item
  and resolve its baseline through conditional reconciliation, or record a
  historical-unknown disposition. Mapping never repairs or resends the payload.
  An unresolved mapping blocks its item, not other items. Historical-unknown is
  an administrative record, **not delivery success or proof of correct stock**;
  the quarantined source and its evidence remain in history. This exceptional
  path accepts invalid JSON or a missing, non-string or empty `externalId`, with
  no durable delivery. A nonempty string ID—even whitespace or a stale ID that
  is absent locally—is not silently reclassified as unidentified: it requires
  identity investigation/ordinary stock reconciliation, not administrative discard.

## Stock pull

`connector.pullStock(cursor)` returns movements made online (online orders
cancel sales, order cancellations restock, remote adjustments) plus
`nextCursor`. The app applies each batch through
`applyStockPull(expectedCursor, nextCursor, moves)`:

- the captured starting cursor must still match; concurrent stale pages are
  rejected for a later retry;
- the cursor and the movements are **one transaction** — a crash either
  applies both or neither;
- each move becomes a movement with
  `reason = online_order | order_cancel | remote_adjustment` and
  `ref_type = remote`;
- unknown external ids are reported back and skipped.

The pull loop stops at the final page or its page cap. When immediate
continuation is unavailable, it persists the cursor and resumes after pacing.
Legacy backend IDs are not commit-order safe. Protocol 2 uses a transactional
sequence, epoch and bounded committed watermark; every backend stock writer
must participate in the same lock order. A new epoch requires an explicit
baseline/bootstrap, not reuse of a legacy numeric cursor. A reconciled item's
movements through its snapshot watermark are suppressed locally, while other
items' movements still apply. Baseline suppression and cursor advancement are
transactional. PostgreSQL concurrency tests are required to verify this protocol;
local SQLite atomicity alone cannot prove backend commit ordering.

## Catalog push

`pushCatalog` runs after stock work. Ordinary catalog updates are stock-neutral
on the marketplace; explicit stock reconciliation uses a separate conditional
operation. Initial publication may establish opening stock.

1. Refresh local items.
2. Refresh remote metadata and comparison snapshots. Automatic metadata updates
   may pull prices, but do not set absolute stock from an ordinary catalog read.
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

- **Local wins** for stock uses an explicit backend absolute-set operation with
  expected remote revision, item identity, epoch and generation. Ordinary catalog
  publication cannot perform this stock decision.
- **Pull** for stock establishes a coherent remote baseline and records a local
  adjustment. The selected item's earlier feed movements are suppressed through
  the returned watermark, preventing a represented online order being deducted
  again. Other items' movements remain eligible.

Stock intent is persisted before the request, including its immutable operation
key and local source boundary. Lost responses recover the same operation rather
than sending a new set. Local settlement is atomic with baseline and exact-source
resolution; later sales must be preserved, never overwritten. Backend revision
conflicts require a fresh explicit decision. Generation fences reject stale
requests dispatched before the resolution. If rebasing later local sales onto a
lower remote baseline would produce negative stock, settlement fails closed and
retains the immutable committed result in a needs-review record. The seller can
explicitly approve a reasoned, linked recovery decision with a zero baseline.
That child operation captures a new local source boundary and fresh remote
conditions; it does not replace or rekey the original operation. Its successful
local settlement absorbs only the captured sources, preserves later sales and
records the shortage correction separately. A further negative rebase requires
another explicit linked review. The original shortage is historical evidence;
the approved shortage is recalculated against current stock when the child is
captured. Even if subsequent purchases cover that historical shortage, choosing
this action is still an explicit **new zero baseline**, not a promise to retain
current stock or an automatic retry of the old local settlement. A correction is
never silently clamped or queued behind sales that would exhaust the old remote baseline. Do not discard the
original operation or retry its request with a new key.

Before the first protocol-2 feed, explicitly bootstrap all linked items using the
chosen local or marketplace stock baseline. Partial bootstrap remains visible and
resumable; the global cursor changes epoch only after all linked items are covered.
Ambiguous legacy outbox rows require this explicit decision, not blind replay.
Stock reconciliation is disabled on servers without the required capabilities.

Metadata differences use `remote.seen`, refreshed on sync and ignored after seven
days, plus a fresh preflight. Price/availability operations are not blocked by
unrelated pending stock; a metadata preflight is not a distributed lock.

## Online orders

Billing does not list online orders. Fulfilment stays in the MyTownCart seller
app; billing only keeps the stock effect (through the stock pull). The old
`remote_orders` cache and `pullOrders` were removed (migration 0013).

## Scheduling

Auto-sync is opt-in and runs from the application root, not only while the
Sync panel is open. The stock-poll interval is configurable to 2, 5 or 15
minutes (default 2). Local changes request a debounced stock push; they do not
trigger a full catalog read. Full catalog and photo work runs on startup and
at the first periodic tick at least 15 minutes after the last successful full
run; failures and the selected interval can make this longer. *Sync now* runs
a full sync. The last outcome is stored as `sync.last` in `app_settings`.

## Rate limit and common messages

`GET stock/` and `GET orders/` are normally paced per token (120 seconds by
default); *Sync now* sends `force=1` for stock pulls. Newer servers provide a
bounded continuation for a multi-page stock pull. With an older server, Billing
saves each page's cursor and resumes after the poll interval. A 429 is displayed
as waiting and retried using the server's `Retry-After` when available.
New items are uploaded only when *Sync all items* (`sync.list_enabled`) is on;
with it off only already-published items are kept up to date. Run sync from the
desktop window: the LAN host does not expose all commands needed for a browser
client to complete a sync. See `LAN.md` for the supported LAN workflows.

Desktop webviews share a process-local sync/reconciliation lock; a stuck owner
requires application restart. This lock is only an optimization. Durable database
claims, immutable keys, local transactions and backend generation fences provide
the operation-level protections; a mutex alone cannot fence another process or an
already dispatched request.

**Rollout and verification:** backend support must precede upgrading Billing host
and frontend together. Migration 0016 adds durable recovery evidence and linked
recovery decisions; older binaries must not open that schema. Do not downgrade a
database after migration 0015. Existing
legacy ambiguities and potentially skipped feed history need explicit bootstrap;
new retry keys/ordering cannot retroactively repair them. PostgreSQL concurrency
and migration tests must pass before claiming production readiness. Passing
mocked, memory or SQLite tests is not proof of the remote transaction guarantees.
No production deployment, database migration or capacity measurement is performed
as part of the local verification.

## Failure rules

- **Never block the sale.** Local bills and movements are written first.
- **Network errors** never lose data; the outbox keeps the rows.
- **Bad tokens** stop the run and ask for a reconnect.
- **Unexpected remote data** (unknown item, malformed move) is skipped and
  listed as a problem for the seller, not retried forever.
- **Browser build**: `syncAvailable()` is false; the panel explains that sync
  needs the desktop app.
