# MyTownCart Billing — Free, Open-Source Billing Software for Local Shops

![MyTownCart Billing — desktop POS, invoicing, and inventory software](apps/web/public/brand/logo-full.svg)

**MyTownCart Billing** is free, open-source desktop billing software for local
shops and small retail businesses. Create bills and GST invoices, scan barcodes,
print receipts, track inventory, and review sales reports from a Windows-first
point of sale (POS) app.

Everyday billing uses a local SQLite database on the shop's computer. Connect a
MyTownCart account to publish your product catalog and synchronize marketplace
orders and stock when online.

[Installation](#installing-a-release-build) ·
[Features](#billing-and-inventory-features) ·
[Getting started](#getting-started-with-your-shop) ·
[Developer setup](#developer-setup) ·
[Documentation](docs/README.md) ·
[Releases](https://github.com/guna81/mytowncart-billing/releases)

## Download MyTownCart Billing

- [Windows (64-bit)](https://github.com/guna81/mytowncart-billing/releases/latest/download/MyTownCart-Billing-windows-x64.exe)
- [macOS — Apple Silicon (M1 and newer)](https://github.com/guna81/mytowncart-billing/releases/latest/download/MyTownCart-Billing-macos-arm64.dmg)
- [macOS — Intel](https://github.com/guna81/mytowncart-billing/releases/latest/download/MyTownCart-Billing-macos-x64.dmg)
- [Linux — Debian / Ubuntu (64-bit)](https://github.com/guna81/mytowncart-billing/releases/latest/download/MyTownCart-Billing-linux-x64.deb)
- [Linux — AppImage (64-bit)](https://github.com/guna81/mytowncart-billing/releases/latest/download/MyTownCart-Billing-linux-x64.AppImage)

**Downloads become available after the first release using this workflow is published.**
macOS and Linux are community builds; a failed platform build may have no download.
See [all releases](https://github.com/guna81/mytowncart-billing/releases) for available
installers and `checksums-<platform>.txt` files. Builds are unsigned; read the
[installation notes](#installing-a-release-build) before installing.

## Billing and inventory features

| Feature | What you can do |
| --- | --- |
| Retail POS billing | Add products by barcode or name, change quantities, and hold and resume bills. |
| GST invoices | Configure GST registration, tax-inclusive or tax-exclusive prices, and CGST/SGST calculations. |
| Receipt and invoice printing | Preview and print 58 mm or 80 mm receipts and A4 invoices through the system print dialog. |
| Payment recording | Record cash, UPI, card, and customer credit sales, with cash-change calculations. |
| Product catalog | Manage prices, MRP, barcodes, categories, units, product photos, and CSV imports and exports. |
| Inventory management | Track stock levels, low-stock indicators, adjustments, and stock movement history. |
| Customer records | Store customer names and phone numbers and associate customers with bills and credit sales. |
| Sales reports | Review daily sales, item sales, and payment-mode totals, with CSV downloads. |
| MyTownCart integration | Publish products and photos, pull online orders, and reconcile marketplace stock. |
| Encrypted backups | Back up and restore local data using encrypted files in a folder you choose. |

## Getting started with your shop

1. Install a desktop build when available on the
   [GitHub Releases page](https://github.com/guna81/mytowncart-billing/releases),
   or follow the [developer setup](#developer-setup) to build from source.
2. Open the app and enter your shop name, GST settings, and invoice prefix.
3. Add products with prices, barcodes, and opening stock, or import a product CSV.
4. Scan or search for products, record the payment, and save and print your first bill.
5. Set up encrypted backups in Settings and keep your recovery key somewhere safe.

See the [shop operator guide](docs/PILOT.md) for setup and daily routines, or the
[screen and workflow guide](docs/SCREENS.md) for detailed instructions.

## Project status and supported platforms

The code includes POS billing, products, inventory, customers, reports,
MyTownCart publishing and sync, encrypted local backups, and opt-in diagnostics.
Implementation decisions and limitations are recorded in [DECISIONS.md](DECISIONS.md).

**Windows is the supported platform for v1.** macOS and Linux builds are
unsupported community builds. The browser-only development mode uses an
in-memory repository and resets its data on reload; use the desktop app for
persistent shop data, backups, and marketplace sync.

The app uses **Tauri 2, Rust, React, TypeScript, and SQLite** in a pnpm monorepo.

## Repository structure

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

## Developer setup

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
  anyway**. Verify the installer against `checksums-windows-x64.txt`
  attached to the release (`certutil -hashfile <file> SHA256`).
- **macOS / Linux (unsupported community builds):** macOS needs
  right-click → Open; no support promise until roadmap decision O6.

Auto-update is not enabled yet (`DECISIONS.md` B4-2 — updater signing keys are
an owner task), so upgrading means downloading the new installer from the
releases page and running it; the SQLite database is kept in the app-data dir
and survives the reinstall.

## Continuous integration and releases

`.github/workflows/ci.yml` runs lint, typecheck, unit tests, `cargo test`,
`tauri build`, and a launch smoke test on a Windows/macOS/Linux matrix.
**Windows is required** (the only supported platform in v1, D11); macOS and
Linux jobs run the same pipeline but are informational (`continue-on-error`)
until O6. Pushing a `v*` tag runs `release.yml`, which attaches all
installers + SHA-256 checksums to one draft GitHub Release via `tauri-action`.
The workflow also uploads fixed filenames for the download links above, with
separate Apple Silicon and Intel macOS builds. Review the completed builds and
publish the draft from GitHub Releases to make downloads public.

## Billing shortcuts and operator guides

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

## Frequently asked questions

### Is MyTownCart Billing free and open source?

Yes. The software is available under the [Apache License 2.0](LICENSE).
The MyTownCart name and logo are subject to the [trademark policy](TRADEMARK.md);
forks must use a different name.

### Can I use the billing software offline?

The desktop app stores bills, products, customers, and stock locally in SQLite
for everyday billing. Publishing to MyTownCart and synchronizing marketplace
orders and stock require an internet connection and a linked account.

### Does it support GST billing and receipt printers?

The app supports shop GST settings, item tax rates, CGST/SGST calculations,
and A4 invoices. It prints 58 mm and 80 mm receipts through the operating
system's print dialog. See the [printing guide](docs/SCREENS.md#printer-tips).

### Does recording a UPI or card payment process the payment?

The POS records the payment mode on a bill. Complete the payment using your
usual UPI or card payment service.

### Where can I report a bug or request a feature?

Open an issue in the
[GitHub issue tracker](https://github.com/guna81/mytowncart-billing/issues).
For code contributions, read the [contribution guide](CONTRIBUTING.md).

## Documentation

- [Documentation overview](docs/README.md)
- [Shop setup and pilot guide](docs/PILOT.md)
- [POS screens, invoicing, inventory, and printing](docs/SCREENS.md)
- [Encrypted backup and restore](docs/BACKUP.md)
- [MyTownCart marketplace synchronization](docs/SYNC.md)
- [Architecture](docs/ARCHITECTURE.md) and [data model](docs/DATA-MODEL.md)
- [Developer guide](docs/DEVELOPING.md)
- [Logo and brand assets](docs/BRANDING.md)

## License and trademarks

Copyright and license details are in [LICENSE](LICENSE) and [NOTICE](NOTICE).
MyTownCart and MyTownCart Billing are project trademarks. See
[TRADEMARK.md](TRADEMARK.md) before distributing a renamed fork or using the brand.
