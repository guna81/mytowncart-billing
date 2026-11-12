# Data model

SQLite (bundled `rusqlite`), forward-only migrations in
`apps/desktop/src-tauri/migrations/`. The runner in `db.rs` copies the database
to `backups-local/pre-migration-<ts>.db` before applying anything and refuses
to open a database newer than the binary (downgrade guard).

TypeScript mirrors live in `packages/storage/src/types.ts`.

## Units and conventions

| Concept | Type | Storage | Example |
|---|---|---|---|
| Money | integer paise | `*_paise` INTEGER | ₹12.50 → `1250` |
| Quantity | integer thousandths | `qty_milli`, `stock_milli` | 250 g → `250000`; 1 pc → `1000` |
| Tax rate | basis points | `tax_rate_bp` (0–2800) | 5 % GST → `500` |
| Timestamps | ISO-8601 with local offset | TEXT, sortable | `2026-11-05T13:00:00.000+05:30` |
| Dates | `YYYY-MM-DD` | TEXT | `2026-11-05` |
| Booleans | 0/1 | INTEGER | — |
| Financial year | `YYYY-YY` | TEXT | `2026-27` (1 Apr – 31 Mar) |

External marketplace ids are UUID strings. Migration 0003 notes that 0002
declared them INTEGER; SQLite is dynamically typed so they are stored as
TEXT regardless.

## Tables

### `shop_profile` (single row, `id = 1`)

One shop per install. `name`, `gst_enabled`, `prices_include_tax`,
`invoice_prefix`, `address`, `phone`, `gstin`, `receipt_footer`,
`low_stock_threshold_milli`, `updated_at`.

`prices_include_tax` decides how the POS treats list prices: when true, GST
is carved out of the price (`computeLineAmounts`); when false it is added.
`invoice_prefix` is part of the invoice-number key.

### `categories`

`name` UNIQUE, `marketplace_category_id` (nullable). A category is mappable
to one marketplace category; mapping happens on the MyTownCart screen. The
publish planner refuses to map two local categories to the same remote id.

### `items`

Billing master data plus publishing state.

| Column | Meaning |
|---|---|
| `name`, `barcode`, `category_id` | master data; `barcode` is not unique (lookups pick the active match) |
| `unit_kind` | `count` \| `weight` \| `volume`; drives how quantities are entered and rendered |
| `price_paise`, `mrp_paise`, `tax_rate_bp` | selling price, strike-through price, GST rate |
| `stock_milli` | cached stock = sum of `stock_movements.delta_milli` (written in the same transaction as each movement) |
| `is_active` | inactive items are hidden from the POS but stay on past bills |
| `photo_path` | relative file name in the app-data `photos/` folder — never an absolute path |
| `image_hash` | SHA-256 hex of the photo bytes; null when no photo |
| `image_uploaded_at` | set when the marketplace confirmed the photo currently attached |
| `publish_state` | last publish outcome (`local_only`, `published`, …) |
| `remote_product_id`, `remote_variant_id` | marketplace ids; non-null means "linked" |
| `content_hash` | fingerprint of the content last accepted by the marketplace |
| `remote_hash` | fingerprint the marketplace reported (B5 reconcile) |
| `updated_at` | master-data edit time |

**D9 — photo gate.** An item without a photo is published hidden
(`visible: false`) and is listed as "photo pending" on the MyTownCart screen.
Uploading a photo re-upserts the item so it becomes visible; no separate
"publish again" step.

### `inventory_snapshot`

`code` UNIQUE — the stock-take codes printed on shelf labels, linked to
`item_id`. `items.barcode` is what the scanner reads; this table holds the
short internal codes used on the floor.

### `customers`

`name`, `phone` (indexed), timestamps. Bills may be anonymous
(`customer_id` NULL); credit sales record the customer.

### `bills` / `bill_lines` / `payments`

Bills are **immutable** once saved.

| `bills` | |
|---|---|
| `number` | formatted from prefix + per-FY sequence; UNIQUE per `(fy, number)` |
| `fy` | financial year at `created_at` |
| `status` | `active` \| `void` |
| `customer_id` | nullable |
| `subtotal_paise`, `tax_paise`, `total_paise` | header totals |
| `created_at`, `voided_at`, `void_reason` | |

| `bill_lines` | |
|---|---|
| `item_id` | nullable — a deleted item keeps its line |
| `name_snapshot` | item name at sale time |
| `qty_milli`, `unit_price_paise`, `tax_rate_bp`, `tax_paise`, `total_paise` | line values at sale time |

| `payments` | |
|---|---|
| `mode` | `cash` \| `upi` \| `card` \| `credit` |
| `amount_paise` | |

A mistake is fixed by **void with a reason** (`validateVoidReason` rejects a
blank reason). Voiding keeps the bill rows and writes compensating `void`
stock movements, so history and reports stay auditable.

### `invoice_counters`

`(fy, prefix) → next_no`. `create_bill` reads and increments this row inside
a `BEGIN IMMEDIATE` transaction, so numbers are gap-free per FY even after a
crash that rolls the bill back.

### `stock_movements` (the ledger)

`item_id`, `delta_milli`, `reason`, `ref_type`, `ref_id`, `created_at`.

| `reason` | Written by | `ref_type`/`ref_id` | Mirrored to the outbox? |
|---|---|---|---|
| `opening` | item create with opening stock | — | no (not a sale) |
| `sale` | `create_bill` | `bill` / bill id | yes → `sale` |
| `void` | `void_bill` | `bill` / bill id | yes → `order_cancel` |
| `adjustment` | stock screen | — | yes → `adjustment` |
| `purchase`, `import` | stock screen / CSV import | — | no |
| `online_order`, `order_cancel`, `remote_adjustment` | stock pull | `remote` / external id | no (they came *from* the marketplace) |

Only whole-unit deltas (`delta_milli % 1000 == 0`) on remote-linked items are
mirrored (see `SYNC.md`).

### `outbox`

`kind`, `payload_json`, `idempotency_key` UNIQUE, `attempts`,
`next_attempt_at`, `status` (`pending` \| `done`).

Keys are `bill:<bill_id>:<movement_id>` and `adj:<movement_id>`. The row is
written in the same transaction as the movement, so a movement is never
missing from the queue.

### `sync_state`

Key/value cursors: `stock` (feed cursor). Cursors
advance in the same transaction as the data they cover.

### `held_bills`

`label`, `customer_id`, `lines_json` (`[{itemId, qtyMilli}]`), `created_at`.
A held bill has no number and no stock movement. On resume the lines'
prices, names and tax rates are re-read from `items`, so a price change
between hold and resume is honoured. Resuming and saving consumes the hold;
*discard* deletes it.

**Not modelled as tables:** photos are files, held-bill lines live in `lines_json`, and the marketplace token is in the keychain.

### `app_settings`

Key/value JSON-ish TEXT used by the web layer:

| Key | Written by | Value |
|---|---|---|
| `backup.local` | Backup panel | `{folder, lastSuccessAt, sameDrive}` |
| `sync.last` | Sync panel | last `SyncOutcome` |
| `remote.seen` | sync engine | `itm_<id> → {externalId, stockUnits, pricePaise, isActive}` with a 7-day max age |
| `pilot.diagnostics` | Settings | `"1"` when diagnostics are on, absent otherwise |

### `settings`, `hello_log`, `schema_version`

- `schema_version` — one row per applied migration (version + applied_at).
- `settings` — shell-level key/value (kept from B0; the web layer uses
  `app_settings`).
- `hello_log` — B0 endpoint check (`db_hello`); harmless leftover.

## Later schema additions (0006–0008)

The base tables above are extended by these forward-only migrations. SQL files
are the exact column/default/index reference.

| Migration | Additions |
|---|---|
| `0006_phase1_pilot.sql` | Item HSN/cost price; customer GSTIN/address; bill discount, round-off and notes; line discount/HSN snapshots; `customer_payments` ledger |
| `0007_phase2_daily_driver.sql` | `credit_notes`, `credit_note_lines`, `suppliers`, `purchases`, `purchase_lines`, `users`, `audit_logs` |
| `0008_phase3_growth.sql` | `item_batches`, customer `loyalty_points`, `loyalty_transactions`, `item_barcodes` with pack quantities, `day_end_closures` |

Customer payments record amount, mode (`cash`, `upi`, `card`, `bank`), notes
and timestamp. Credit notes retain a reference to the original bill plus
snapshot lines. Purchases reference suppliers and retain cost/tax snapshots.
Day-end closures store opening cash, sales, credit received, refunds,
expected/actual cash, variance, bill/sales totals, notes and optional user id.

`users` stores name, role, active flag and creation time. PINs are stored in
`user_pins` (migration 0009) as salted, iterated SHA-256 hashes, and `query_rows`
refuses to read that table. The legacy `users.pin` column is emptied at start-up.
Roles are enforced in the Rust shell for both the desktop window and the LAN
browser (see DECISIONS.md B6-1). `audit_logs` receives an entry for each
sensitive action, with the acting user.
The existence of batch and alternate-barcode tables does not mean every
workflow has a dedicated management screen.

The development LAN host also uses app settings `lan.port` (port as text) and
`lan.autostart` (`"true"`/`"false"`; reading also accepts `"1"`).
Release-check cache values `mtc.updateCheck.lastAt` and `mtc.updateCheck.latest`
are browser localStorage entries, not SQLite settings.

## What is not in SQLite

- **Marketplace integration token** — OS keychain, key `mytowncart.integration`
  (desktop); memory only in a browser.
- **Backup recovery key** — OS keychain, key `backup.recovery-key`, wrapped.
- **Photos** — files under the app-data `photos/` folder; the DB stores the
  relative file name and hash only.
- **Backups** — `.mtcb` files in the seller-chosen folder.

## Things that must never reach a log or the repo

Recovery keys (the grouped base32 form), integration tokens, and anything
the diagnostics report might otherwise copy: `redact()` in
`apps/web/src/lib/diagnostics.ts` strips both shapes before an event is
recorded.

## Variants (migration 0014)

`items.variant_group` (shared key, `''` = plain item) and `items.variant_options`
(JSON, e.g. `{"Size":"M"}`). Each variant is its own item, so barcode, stock,
price and bill lines work unchanged; names are stored as `Base – M / Red`.
Removed options are set inactive, never deleted (bill history). Each option also
has its own cost price (blank = the shared one).

Marketplace sync: by default every variant is published as a separate product.
With the client flag on (`VITE_VARIANT_SYNC=1` or `localStorage mtc.variantSync=1`)
and a server running `INTEGRATIONS_VARIANTS_ENABLED`, a group is sent as ONE
product (`external_id` = the group key) whose variants are linked by their own
`external_id` (= the item id). Stock, orders and photos then resolve per variant.
A plain item can become a group from its edit form only while it is unpublished.
