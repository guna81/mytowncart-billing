# Architecture

MyTownCart Billing is a Tauri 2 desktop app: a Rust shell that owns SQLite,
the OS keychain, photos and backup files, and a React webview that owns the
UI and all decision logic. The marketplace integration is a typed connector
that the UI drives; the shell only stores what the connector returns.

```
┌──────────────────────────── apps/web (React 19, HashRouter, Zustand, Tailwind) ─┐
│ screens/            PosScreen, ItemsScreen, ItemFormScreen, StockScreen,        │
│                     BillsScreen, BillDetailScreen, CustomersScreen,             │
│                     ReportsScreen, MyTownCartScreen (+ SyncPanel), Settings,    │
│                     SetupWizard                                                  │
│ components/         Layout (nav + screen log), BackupPanel, DiagnosticsPanel    │
│ print/PrintView     receipt (58/80 mm) and A4 invoice, window.print()           │
│ lib/                repository (adapter selection), syncEngine, cryptoStore,     │
│                     connection (token), marketplace (connector singleton),       │
│                     remoteSeen, diagnostics, labels, tauri (command wrappers)    │
└──────────────┬───────────────────────────────────────────────┬─────────────────┘
               │ imports                                        │ invoke() over IPC
┌──────────────▼──────────────┐   ┌───────────────────────────▼─────────────────┐
│ packages/core (pure TS)     │   │ apps/desktop/src-tauri (Rust)                │
│ money, quantity, tax, bill, │   │ lib.rs    command registry                   │
│ invoice, stock, publish,    │   │ db.rs     migrations (forward-only)          │
│ sync, reports, csv, media   │   │ repo.rs   shop, items, bills, ledger, held   │
└──────────────┬──────────────┘   │ sync.rs   outbox, cursors, pull, orders      │
               │                  │ reconcile.rs  local-wins fixes               │
┌──────────────▼──────────────┐   │ media.rs  photo sniff/store/read/delete      │
│ packages/storage            │   │ backup.rs VACUUM INTO, gzip, atomic write,   │
│ BillingRepository interface │   │           same-volume check, restore         │
│ • tauri.ts   → IPC commands │   │ keychain.rs  OS credential store             │
│ • memory.ts  → in-memory    │   └───────────────────────────┬─────────────────┘
└──────────────┬──────────────┘                               │
┌──────────────▼──────────────┐                 SQLite: app-data/mytowncart-billing.db
│ packages/connector-mytowncart│
│ MarketplaceConnector iface   │─── HTTPS ──▶ api.mytowncart.com/api/v1/integrations
│ MyTownCartConnector (HTTP)   │             (catalog, images, stock, orders)
└─────────────────────────────┘
┌─────────────────────────────┐
│ packages/backup             │  .mtcb envelope + AES-256-GCM/HKDF (pure TS, WebCrypto)
└─────────────────────────────┘
```

## Layers and the rules that hold them apart

| Package | May import | Must not import | Enforced by |
|---|---|---|---|
| `packages/core` | nothing from the repo | react, tauri, DOM, fs, node | ESLint `no-restricted-imports`; tsconfig `lib: ["ES2022"]`, `types: []` |
| `packages/storage` | `core` | react, tauri JS API | review |
| `packages/connector-mytowncart` | `core` | react, storage | review |
| `packages/backup` | `core` | react, tauri (paths via `invoke` injected) | object shape `Invoke` |
| `apps/web` | everything above | `@tauri-apps/api` outside `lib/tauri.ts`, `lib/connection.ts`, `lib/cryptoStore.ts` | review |

`packages/core` is where every number is decided: integer paise for money,
integer thousandths (`qtyMilli`) for quantities, basis points for tax
(`taxRateBp`, 0–2800). Floats never carry money or quantity.

## Repository adapters

`apps/web/src/lib/repository.ts` picks one at first use (in priority order):

- **Tauri** (`isInTauri()` true, i.e. `window.__TAURI_INTERNALS__` exists):
  `TauriRepository`, one Rust command per method.
- **HTTP (development LAN)** (`window.__MTC_LAN_SERVER__` true):
  `HttpRepository`, calling the desktop server at the page origin. The Rust
  `server.rs` serves assets/photos and dispatches `/api/invoke` to the host
  repository. See [LAN access and limits](LAN.md).
- **Memory**: `MemoryRepository`, used by Vitest and by the Vite dev server /
  Playwright. Data lives in Maps and is lost on reload; it implements the
  same semantics (invoice counters per FY+prefix, compensating void
  movements, per-row CSV import isolation, outbox mirroring).

All three adapters implement `BillingRepository` (`packages/storage/src/repository.ts`).
A behaviour change must cover each applicable adapter and the LAN dispatcher, with a `memory.test.ts` case.

## Tauri commands

Registered in `apps/desktop/src-tauri/src/lib.rs`. All return
`Result<T, String>` and take camelCase args.

| Group | Commands |
|---|---|
| Health | `db_status`, `db_hello` |
| Keychain (desktop only) | `keychain_set`, `keychain_get`, `keychain_delete` |
| Shop / master data | `save_shop_profile`, `upsert_category`, `upsert_customer`, `upsert_item`, `import_items`, `query_rows` (read side) |
| Stock | `adjust_stock`, `enqueue_stock_outbox`, `record_outbox_results`, `drop_outbox`, `apply_stock_pull` |
| Billing | `create_bill`, `void_bill` |
| Held bills | `save_held_bill`, `take_held_bill` |
| Media | `set_item_photo`, `clear_item_photo`, `read_item_photo`, `record_image_uploads` |
| Marketplace | `record_publish`, `record_remote_catalog`, `record_orders`, `apply_reconcile_fixes`, `set_sync_cursor` |
| Settings | `get_app_setting`, `set_app_setting` |
| Backup | `data_dir`, `db_snapshot`, `write_backup_file`, `read_backup_file`, `backup_file_info`, `same_volume`, `restore_snapshot` |

The webview never runs SQL.

## Boot sequence

1. `apps/web/src/main.tsx` mounts `App`.
2. `App` loads `getShopProfile()` and the `pilot.diagnostics` setting in
   parallel, starts the diagnostics recorder if enabled, then sets `booted`.
3. No profile → setup wizard (every route redirects to `#/setup`).
   With a profile → `Layout` + the routed screen + `PrintView`.
4. Every route change is logged to diagnostics as `screen <path>` with
   numeric ids collapsed to `:id`.

## Printing

`PrintView` renders `.print-area` and calls `window.print()` once painted.
`afterprint` (or the on-screen *Close preview*) hides the document and clears
the print job; the clear happens one task after `afterprint` so a dialog
that closes synchronously cannot unmount the document before it is shown.
The print CSS hides `main` while `body.printing` is set.

## Error handling

- Repository and connector failures surface as inline notices on the screen
  that caused them (`pos-notice`, `sync-error`, `backup-error`, …); nothing is
  swallowed silently.
- Sync failures never block billing: the bill is written locally first and the
  movement waits in the outbox (see `SYNC.md`).
- Rust errors are plain strings aimed at a human; the UI prefixes context.

## Where decisions live

`DECISIONS.md` holds every deviation from the roadmap spec, numbered
`B<phase>-<n>` with date and rationale. Read it before changing a shape that
the marketplace sees (publish input, push/pull payloads, backup envelope).

## Expanded application workflows

Migrations 0006–0008 add discounts, customer payments, returns/credit notes,
suppliers/purchases, users/audit records, batches, loyalty, alternate barcodes
and day-end closures. The route inventory is in [SCREENS.md](SCREENS.md).

At boot the UI also attempts an overdue configured desktop backup and checks
for a newer published release. `lib/updateCheck.ts` validates and compares the
release response, uses a 24-hour local cache and an 8-second request timeout.
`UpdateAvailableButton` opens the release URL; it never installs application code.
