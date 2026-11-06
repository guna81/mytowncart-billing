# Developing

## Prerequisites

- Node ≥ 20 and pnpm via `corepack enable`.
- Rust stable (for the desktop shell).
- Windows: WebView2 (present on current Windows 10/11).
- Linux: the Tauri/WebKitGTK packages listed in `.github/workflows/ci.yml`
  (WebKitGTK 4.1, libsoup 3, appindicator, librsvg, patchelf).

## Commands

All run from the repo root.

| Command | What it does |
|---|---|
| `pnpm install` | install workspace dependencies |
| `pnpm lint` | ESLint, including the `packages/core` boundary rule |
| `pnpm typecheck` | `tsc --noEmit` in every package + `cargo check` for the shell |
| `pnpm test` | Vitest in every package + `cargo test` (Vitest runs with `--passWithNoTests` where a package has no tests yet) |
| `pnpm build` | typecheck the web app and build it to `apps/web/dist` |
| `pnpm --filter @mytowncart-billing/web dev` | browser-only UI on <http://localhost:5173> (in-memory data) |
| `pnpm desktop:dev` | the real desktop app (SQLite, keychain, files) |
| `pnpm desktop:build` | installers for the current OS |
| `pnpm --filter @mytowncart-billing/desktop test` | `cargo test` only |
| `tooling/scripts/smoke-app.sh <binary>` | launch the built app and require it to survive 15 s (CI) |

## Browser-only development

`vite` alone runs the full UI against `MemoryRepository`:

- no Tauri ⇒ marketplace sync is disabled, backups show a "desktop app"
  notice, and the integration token lives in module memory;
- a reload resets all data (no seeding; use the setup wizard first);
- `VITE_MTC_WEB_URL` / `VITE_MTC_API_URL` point the connector at a local
  backend if one is running (dev only, never in a shipped build).

To exercise the Sync tab in the browser without a backend, save a fake
connection with `saveConnection`, override `getConnector().me` and
`listCategories`, then open `#/mytowncart`.

### Driving the UI

There is no committed Playwright suite yet (see `DECISIONS.md` B0-4).
`@playwright/test` is a dependency of `apps/web`. For manual checks, drive
the dev server with Playwright (or the IDE browser) and use these handles: `setup-shop-name`, `setup-gst-no`, `setup-start`,
`items-new`, `item-name`, `item-barcode`, `item-price`,
`item-opening-stock`, `item-save`, `items-scan`, `pos-scan`, `pos-qty-<itemId>`,
`pos-tendered`, `pos-save-print`, `pos-notice`, `pos-held`,
`pos-resume-<id>`, `stock-<itemId>`, `stock-delta`, `stock-adjust-save`,
`bill-open-<number>`, `bill-void`, `void-reason`, `void-confirm`,
`customers-add`, `customer-name`, `customer-save`, `reports-export-*`,
`backup-panel`, `pilot-toggle`, `mtc-tab-*`, `sync-panel`.

Headless Chromium has no print dialog: stub `window.print` in an init
script (e.g. dispatch `afterprint` after a tick) if you drive the
save-and-print path.

## Running the desktop app on macOS

Prerequisites: Xcode Command Line Tools (`xcode-select -p` must print a
path), Rust stable (`rustup`), Node ≥ 20 and pnpm. The first build compiles
the Rust shell and takes several minutes; later builds are incremental.

| Command | What it does |
|---|---|
| `pnpm desktop:dev` | starts Vite on :5173, builds the shell, opens the **MyTownCart Billing** window against real SQLite/keychain |
| `pnpm desktop:build` | builds release installers into `apps/desktop/src-tauri/target/release/bundle/` (macOS: `.app` + `.dmg`) |

- `desktop:dev` uses a development data directory; `desktop:build` users get
  the real one under `~/Library/Application Support/com.mytowncart.billing/`
  (the app shows the path in Settings).
- Backups and the recovery key use the macOS **login keychain**. At runtime
  macOS may ask "MyTownCart Billing wants to use your confidential
  information…"; allow it. Clear the entries in Keychain Access under the
  service name the shell uses if you need a clean slate.
- `desktop:build` output is **unsigned and not notarized** (`B0-6`), so
  Gatekeeper blocks it on other Macs (showing "is damaged and can't be opened").
  Clear the quarantine flag once with:
  `xattr -cr "/Applications/MyTownCart Billing.app"`.
- Apple Silicon and Intel runners both work; `pnpm desktop:build` produces a
  binary for the host architecture only. Universal builds need
  `cargo tauri build --target universal-apple-darwin` (Rust targets for both
  architectures installed).
- The shell prints startup errors and migration lines to the terminal you
  launched it from. The opt-in in-app report is in Settings → Pilot
  diagnostics.

## Where to change things

| Task | Files |
|---|---|
| A calculation (money, tax, FY, invoice number) | `packages/core/src/` + its test |
| A repository method | `packages/storage/src/repository.ts`, `memory.ts`, `tauri.ts`, matching Rust fn in `apps/desktop/src-tauri/src/` + `lib.rs` registration |
| A new table/column | new migration `NNNN_name.sql` (never edit an applied one), `packages/storage/src/types.ts`, both adapters |
| A Tauri command | `apps/desktop/src-tauri/src/*.rs` + `invoke_handler` list in `lib.rs` + wrapper in `apps/web/src/lib/tauri.ts` |
| A screen | `apps/web/src/screens/`, route in `App.tsx`, keys in `apps/web/src/i18n/en.ts` |
| Marketplace API shape | `packages/connector-mytowncart/src/` — and write it down in `DECISIONS.md` |
| Sync behaviour | `apps/web/src/lib/syncEngine.ts` (+ `packages/core/src/sync.ts`), doc in `docs/SYNC.md` |

## Tests

| Suite | Location | Notes |
|---|---|---|
| core | `packages/core/test/` | pure functions incl. goldens for money rounding and FY boundaries |
| storage | `packages/storage/test/memory.test.ts` | MemoryRepository semantics |
| connector | `packages/connector-mytowncart/test/` | HTTP layer with a fake `fetch` |
| backup | `packages/backup/test/crypto.test.ts` | envelope round trip, tamper, truncation, key parsing |
| web | `apps/web/src/lib/*.test.ts` | sync engine (fake connector), diagnostics redaction |
| Rust | `#[cfg(test)]` in `apps/desktop/src-tauri/src/` | migrations (forward-only, downgrade refusal, pre-migration copy), backup round trip, media names |

Golden-value tests are deliberate: change a rounding rule only together
with its golden in the same commit.

## Code style

- TypeScript `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`;
  `lib: ["ES2022"]` in core (no DOM types — lookup browser globals
  structurally, as `media.ts` and `backup/crypto.ts` do).
- Comments explain *why*; i18n keys are the user-visible strings.
- Money/quantity integers only (see `DATA-MODEL.md`).
- Error messages reaching the user go through i18n keys on the web side and
  plain human sentences on the Rust side.

## Releasing

Follow the [release and download runbook](RELEASING.md) for version updates,
tagging, installer verification, and publishing a draft GitHub Release. It also
lists the stable download filenames and the first public release.

Builds are unsigned until certs exist (`DECISIONS.md` B0-6). Updater
artifacts are off (`B4-2`); turning them on needs an updater signing key
generated and kept by the owner.

## Commit hygiene

- Never commit secrets, tokens, recovery keys, or personal seller data.
- Never write history-rewriting git commands in automation; the maintainer
  commits manually.
- Note spec deviations in `DECISIONS.md` in the same change.
