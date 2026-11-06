# Recent improvements

Reviewed against the working source on November 6, 2026.

## Release status

The latest published installer is [v0.1.0](https://github.com/guna81/mytowncart-billing/releases/tag/v0.1.0),
published November 5. The list below describes current source functionality,
not a promise that every feature is included in that installer. A new release
must build the intended committed source; updating docs or GitHub Pages does
not rebuild desktop installers.

## Current source workflows

- **Counter billing:** search suggestions, line and bill discounts, round-off,
  split payments, credit sales, held bills, and receipt/invoice printing.
- **Customer accounts:** GSTIN and address, outstanding credit, received
  payments, and displayed loyalty balances.
- **Returns:** create credit notes from saved bills and retain the original
  sale for history.
- **Purchasing:** supplier records, purchase invoices and received stock,
  item cost prices, and profit reporting.
- **Shop operations:** dashboard, stock audit, barcode labels, user/PIN records,
  and day-end cash counting with expected-versus-counted variance and Z-report.
- **Reports:** date-range sales, item and payment summaries, profit, sales
  trend/payment charts, and B2B/B2CS/CDNR/HSN GSTR-1 CSV datasets for review.
- **Language:** English, Tamil and Hindi selection in Settings. Some operational
  text remains English.
- **Backups:** encrypted folder backups and a startup check that attempts a
  backup when more than 24 hours have passed, provided a folder and recovery
  key already exist. This requires the desktop app running at startup.

## Latest local development changes

These changes were present locally at review time and need inclusion in a
future application commit/build:

- Refreshed navigation, page headers, tables, empty states, forms and chart layout.
- Optional [LAN server](LAN.md) with URL/QR sharing and an HTTP repository
  connected to the desktop host's SQLite database.
- A notify-only **Update available** control, automatic release checks at launch
  throttled to once per 24 hours, and manual checks in Settings. Clicking opens
  the published release in a browser; installation remains manual.
- Shared date formatting and stock-alert helpers, plus additional update and
  repository coverage.

## Operator details

The POS currently handles **F2** for scan/search focus, **F4** to hold, and
**F9** to save and print. The help overlay currently lists different actions
for F4/F7/F9; follow the POS controls until that overlay is aligned.

See [screens and workflows](SCREENS.md), [pilot checklist](PILOT.md), and
[release runbook](RELEASING.md).
