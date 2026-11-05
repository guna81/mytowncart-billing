# Screens and workflows

Every route is a hash route (`HashRouter`), so the desktop build works from
`file://`-style asset loading. All text comes from `apps/web/src/i18n/en.ts`
via `t(key)`; add a key there rather than hard-coding a string.

| Route | Screen | Purpose |
|---|---|---|
| `#/setup` | `SetupWizard` | first run: shop name, GST, invoice prefix |
| `#/` | `PosScreen` | billing (the home screen) |
| `#/items`, `#/items/new`, `#/items/:id/edit` | `ItemsScreen`, `ItemFormScreen` | catalog |
| `#/bills`, `#/bills/:id` | `BillsScreen`, `BillDetailScreen` | history, void, reprint |
| `#/customers` | `CustomersScreen` | customers, credit bills |
| `#/stock` | `StockScreen` | stock levels, adjustments, movement history |
| `#/reports` | `ReportsScreen` | daily / by item / by payment mode, CSV export |
| `#/mytowncart` | `MyTownCartScreen` (Catalog / Sync tabs) | connect, map, publish, sync |
| `#/settings` | `SettingsScreen` | shop profile, backup, diagnostics, printer/updates/language notes |

## Setup wizard

Shown until a shop profile exists; every other route redirects to `#/setup`.
Collects the shop name (required), whether the shop is GST-registered
(off by default) and whether prices include tax, plus the invoice prefix
(`INV-` by default). The prefix is part of the invoice-number key per FY —
changing it later starts a new sequence, it does not renumber old bills.

## Billing (POS)

Keyboard-first, barcode-first.

- **Scan field** (always focused, `F2` re-focuses): Enter looks up the exact
  barcode; if nothing matches the barcode, a single exact-name match is used,
  several matches are refused with "N items match — type a barcode".
  Scanning the same item again adds one more unit to its line.
- **Line quantity:** type a value and press Enter or leave the field.
  Quantities are plain numbers in the item's unit (`parseQty`: up to three
  decimals) — e.g. `2` pieces, `0.25` for 250 g / litre. A `count` item must
  be a whole number — `validateBill` rejects `0.5` pcs; `weight`/`volume`
  items accept decimals.
- **Payment:** Cash / UPI / Card / Credit. Cash with a tendered amount shows
  the change; overpayment is only allowed on cash (`payment.overpay_requires_cash`).
  Empty tendered means exact amount. Credit is recorded as unpaid; pick the
  customer so the credit sale is attributable.
- **Customer** (optional) is attached to the bill.
- **Hold (`F4`)** parks the bill: only `{itemId, qtyMilli}` is stored, so on
  *resume* prices, names, tax rates and the customer are re-read. Missing
  items (deleted since) are dropped with a warning; a hold with nothing left
  cannot be resumed. *Discard* deletes a hold. A resumed bill that is saved
  consumes the hold.
- **Save (`F9` = save & print)** writes the bill and its stock movements in
  one transaction, clears the form, and (when printing) opens the receipt
  preview. Invoices print with `Create bill`/invoice from the bill detail.
- Saved/error outcomes show as a notice above the table.

Sales reduce stock through the ledger. A bill is immutable; mistakes are
voided from the bill detail.

## Items

- Search by name/barcode.
- **Scan field:** a scanner (keyboard wedge) or typed code opens the matching
  item's edit screen; an exact name opens it too; otherwise a notice is shown.
- **New / Edit:** name (required), barcode, category (existing or type a new
  name), unit kind (`count` / `weight` / `volume`), price, MRP, GST rate,
  opening stock (new items only).
- **Photo:** JPEG/PNG/WebP up to 5 MB (`checkImage`), stored on disk, hashed
  with SHA-256. See `SYNC.md` for the photo gate (D9).
- **CSV import/export:** header
  `name,barcode,category,unit_kind,price,mrp,tax_rate_bp,opening_stock`;
  each row is validated independently and failures are listed with their
  line numbers.

## Stock

- Stock levels with *low stock* badges below the threshold from Settings
  (`isLowStock`, inclusive).
- **Adjust** opens a dialog for a positive or negative delta with a reason
  (`adjustment`, `purchase`, `import`); every change is a ledger movement.
- Click the item name to show its movement history (time, delta, reason).
- Local drift can be corrected here; the marketplace is not told about
  purchases/imports, only about adjustments on linked items.

## Bills

- Search by number or customer; open a bill to see lines, totals, payments.
- **Print receipt** (80 mm) / **Print invoice** (A4): re-render through
  `PrintView`, then `window.print()`.
- **Void** requires a reason; it keeps the bill and writes compensating
  stock movements. Voided bills stay in the list and reports.

## Customers

Add/edit name and phone; a customer is required for credit sales and is shown
on bills and invoices.

## Reports

Three sections for the selected date range, each with its own CSV download:

- **Daily sales** — per-day bills, net, tax, gross.
- **By item** — quantity sold and revenue per item (uses bill line
  snapshots, so past prices are preserved).
- **By payment mode** — cash / UPI / card / credit totals.

Voided bills are excluded from the totals. Money is shown with
`formatPaise`; totals are computed in `packages/core/src/reports.ts`.

## MyTownCart

**Catalog tab** (unlinked): *Connect* starts the device-code flow and shows
the user code and a link; approval on the website completes it.

**Catalog tab** (linked):

- **Account** — seller name, store status (approved / pending), disconnect.
- **Category mapping** — one local category → one marketplace category.
- **Publish** — review of ready vs blocked items (reason per item), then
  *Publish*. Blocked items and the reason list come from `planPublish`.
- **Photos** — items whose photo has not been uploaded yet; *Upload photos*
  sends them and makes the items visible.

**Sync tab** (`SyncPanel`): see `SYNC.md` for the behaviour; the panel shows
last run, pending outbox rows, problems, the reconcile table (*Local wins* /
*Pull* per row) and recent online orders. *Sync now* runs immediately; in the
desktop shell an automatic run happens every 5 minutes while the panel is
open. The browser build disables the button with an explanation.

## Settings

- **Shop profile:** name, phone, address, GSTIN, receipt footer, invoice
  prefix, low-stock threshold, GST-registered, prices include tax.
- **Backup and restore:** see `BACKUP.md`. The browser build shows a note
  that backups need the desktop app.
- **Pilot diagnostics:** off by default; enabling keeps an in-memory log of
  screens visited (ids collapsed) and errors (message only). *Show and copy
  report* produces the environment summary plus events, with recovery keys
  and token-like strings redacted. Nothing is sent automatically.
- **Printer / Updates / Language:** informational; printing uses the system
  dialog, auto-update is not enabled yet (`DECISIONS.md` B4-2), English only.

### Printer tips

In the system dialog choose the receipt printer, set to 80 mm roll (or 58 mm)
for receipts and A4 for invoices. The preview itself is on screen before the
dialog opens, so the seller can check totals first.

## Print preview

`PrintView` renders the receipt (58/80 mm) or A4 invoice into `.print-area`,
calls `window.print()` once painted, and closes on `afterprint` or *Close
preview*. While previewing, the normal UI is hidden. A receipt shows shop
name/address/GSTIN, invoice number and time, lines (name, qty × price,
amount), subtotal, CGST/SGST (only when tax > 0), total, payment lines and
the footer/thank-you text.
