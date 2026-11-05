# MyTownCart Billing

![MyTownCart Billing](apps/web/public/brand/logo-full.svg)

Free, open-source desktop billing for local shops — Windows-first — with a
one-click **Publish to MyTownCart** for the shop's catalog.

- **Status:** B1–B5 complete in code — POS/billing, items with photos, stock,
  bills, customers, reports; MyTownCart publishing (catalog, photos, order
  pull, stock push/pull and reconcile); encrypted local-folder backups;
  opt-in diagnostics. The browser-only dev mode runs against an in-memory
  repository (data resets on reload). See `DECISIONS.md` and the roadmap
  (`my-town-cart` repo, `roadmap/billing-integration.md`).
- **Stack:** Tauri 2 (Rust) + React + TypeScript (strict) + SQLite, pnpm
  monorepo.
- **Docs:** start at [`docs/`](docs/README.md) — architecture, data model,
  marketplace sync, backup format, screens, developer guide, pilot runbook.
- **Licence:** Apache-2.0 (see `LICENSE`, `NOTICE`). The name is a trademark
  — forks must rename (see `TRADEMARK.md`).

## Layout

```
packages/
  core/                  pure TS domain logic — no react/tauri/DOM/fs (ESLint-enforced)
  storage/               BillingRepository interface + Tauri and in-memory adapters
  connector-mytowncart/  MarketplaceConnector interface + HTTP client
  backup/                encrypted local-folder backup (.mtcb envelope + crypto)
apps/
  web/                   React UI (all screens, print preview, sync engine)
  desktop/               Tauri 2 shell: SQLite, migrations runner, keychain,
                         photos, backup files
docs/                    architecture, data model, sync, backup, screens, pilot
tooling/                 CI/release helpers (e.g. the launch smoke test)
.github/workflows/       ci.yml (OS matrix), release.yml (tag → installers)
```

## Develop

Prereqs: Node ≥ 20, pnpm (via corepack), Rust stable. On Linux also the
Tauri system deps (see `ci.yml`).

```sh
pnpm install
pnpm lint          # ESLint incl. the packages/core boundary rule
pnpm typecheck
pnpm test          # Vitest (+ passWithNoTests placeholders)
pnpm build         # web UI
pnpm --filter @mytowncart-billing/desktop test   # cargo test (migrations runner)
pnpm --filter @mytowncart-billing/web dev   # browser-only UI (in-memory data)
pnpm desktop:dev   # run the full desktop app (SQLite + keychain)
pnpm desktop:build # build installers for the current OS
```

The database lives in the OS app-data dir (e.g.
`%APPDATA%/com.mytowncart.billing/mytowncart-billing.db`). Upgrading the
schema copies the old file to `backups-local/pre-migration-*.db` first.
Secrets (integration token, backup recovery key) go to the OS credential
store via Tauri commands — never into SQLite.

## Privacy: what leaves the machine

Only what Publish and sync need: catalog fields (name, price, MRP, stock,
barcode, category, photo), stock deltas and order pulls, and only when the
shop has linked a MyTownCart account. Bills and customer data stay on the
shop's PC. Backups are encrypted on the machine before being written to the
chosen folder (encrypted local copies, not an upload). Diagnostics are off by
default; when enabled they stay on the machine and redact keys and tokens.

## Installing a release build

Builds are **unsigned** (zero-spend, see `DECISIONS.md` B0-6):

- **Windows (supported):** SmartScreen will warn — click **More info → Run
  anyway**. Verify the installer against `checksums-windows-latest.txt`
  attached to the release (`certutil -hashfile <file> SHA256`).
- **macOS / Linux (unsupported community builds):** macOS needs
  right-click → Open; no support promise until roadmap decision O6.

Auto-update is not enabled yet (`DECISIONS.md` B4-2 — updater signing keys are
an owner task), so upgrading means downloading the new installer from the
releases page and running it; the SQLite database is kept in the app-data dir
and survives the reinstall.

## CI

`.github/workflows/ci.yml` runs lint, typecheck, unit tests, `cargo test`,
`tauri build`, and a launch smoke test on a Windows/macOS/Linux matrix.
**Windows is required** (the only supported platform in v1, D11); macOS and
Linux jobs run the same pipeline but are informational (`continue-on-error`)
until O6. Pushing a `v*` tag runs `release.yml`, which attaches all
installers + SHA-256 checksums to one GitHub Release via `tauri-action`.

## Using it

- **Shop operator:** follow [`docs/PILOT.md`](docs/PILOT.md) (day-one setup,
  daily routine, troubleshooting, turning on diagnostics).
- **Billing:** scan or type a code, Enter adds a line; F2 scan field, F4 hold,
  F9 save & print. See [`docs/SCREENS.md`](docs/SCREENS.md) for every screen.
- **Backups:** one encrypted `.mtcb` file per backup in a folder you choose,
  unlocked by a 32-character recovery key you write down once — see
  [`docs/BACKUP.md`](docs/BACKUP.md).

## Contributing

See `CONTRIBUTING.md` for ground rules and [`docs/DEVELOPING.md`](docs/DEVELOPING.md)
for the developer guide.
