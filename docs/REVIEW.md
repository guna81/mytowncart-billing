# MyTownCart Billing — Product Review: Missing Features & UI Improvements

**Date:** 2026-11-06 · **Version reviewed:** 0.1.0 (commit `e81b766`)
**Scope:** static review of `apps/web` (React screens), `packages/core`, `packages/storage`, the SQLite schema and docs. I did not run the app; `pnpm` is not installed in this shell, so the test suite was not executed.

---

## 1. Summary

The foundation is **stronger than the UI**. Money is integer paise, quantities are integer milli-units, invoice numbers are gap-free per financial year, bills are immutable with void-and-compensate, and the stock ledger, encrypted backup and outbox sync are carefully designed. For a v0.1 this is a trustworthy core.

What is missing is what a counter operator needs every day. The POS has no discount, no returns, no split payment, and no customer credit ledger. The invoice is not a full GST tax invoice. The UI is a functional admin skin, with no accessibility work, no dark or touch mode, and no empty-state guidance.

**Biggest risks to a real shop pilot (fix first):**

1. **Credit sales cannot be collected.** "Credit" records an unpaid bill, but there is no outstanding balance, no payment-received flow and no statement.
2. **No discounts, returns or exchanges.** A shopkeeper cannot give ₹10 off or take back one item. The only remedy is to void the entire bill.
3. **Invoice is not GST-compliant.** There is no HSN/SAC code, no customer GSTIN or address, no tax-rate breakup, no amount in words, and no IGST for inter-state sales.
4. **Overpayment can be saved with a typo.** Cash tendered is a free-text field with no quick-cash buttons and no confirmation of the change amount.
5. **No users or roles.** Anyone at the PC can void bills, adjust stock and read reports.

---

## 2. Missing features

Priority: **P0** = blocks real-world use · **P1** = expected within the first months · **P2** = nice to have.

### 2.1 Billing / POS

| # | Feature | Priority | Evidence / why |
|---|---|---|---|
| 1 | **Discounts** (per line and whole bill, % or ₹) | P0 | No discount field in `BillLineInput`, `NewBillPayload` or the schema. `money.ts` only mentions bill-level discount in a comment. Tax must be computed after the discount. |
| 2 | **Returns / credit notes / exchanges** | P0 | The only correction is `voidBill` (whole bill). Partial returns need a credit-note document linked to the original bill, with a stock movement. |
| 3 | **Split payments** (e.g. ₹200 cash + ₹300 UPI) | P1 | The schema stores multiple `payments` rows, but the POS UI offers one mode only. |
| 4 | **Partial / advance payment on credit sales** | P0 | `credit` charges the full total. There is no "paid ₹300, ₹700 due". |
| 5 | **Customer ledger**: outstanding balance, receive-payment entry, statement | P0 | `CustomersScreen` shows only name and phone. Docs say "customers, credit bills", but nothing aggregates unpaid credit. |
| 6 | **Edit item price on the bill** (manual override) and **ad-hoc / open-price item** | P1 | Price is locked to the catalog. Shops often sell "misc ₹50" or negotiate. |
| 7 | **Add customer from the POS** without leaving the screen | P1 | The customer dropdown lists only existing customers. |
| 8 | **Item search with suggestions** (type "par" → list → pick) | P0 | `onScan` refuses ambiguous names ("N items match — type a barcode") instead of showing a list. This breaks for items without barcodes. |
| 9 | **Quick-add tiles** for frequent or barcode-less items (loose vegetables, tea) | P1 | Common in kirana shops. |
| 10 | **Multiple held bills labelled by customer**, plus a hold count badge | P2 | The label is "N item(s)". Operators cannot tell holds apart. |
| 11 | **Bill-level notes / PO number / vehicle number** | P2 | Needed for B2B invoices. |
| 12 | **Round-off line** (nearest ₹1) | P1 | Common in India. It needs a rounding adjustment line so the total stays reconcilable. |
| 13 | **Cash drawer open and shift open/close with cash count** | P1 | Daily reconciliation is documented as a manual routine in `PILOT.md`. |

### 2.2 GST, invoicing and printing

| # | Feature | Priority | Evidence / why |
|---|---|---|---|
| 14 | **HSN/SAC code per item**, printed on the invoice | P0 | Absent from schema and UI. Mandatory on B2B invoices above the turnover threshold. |
| 15 | **Customer GSTIN, billing and shipping address** on B2B invoices | P0 | The customer record has name and phone only. |
| 16 | **IGST** for inter-state sales, with place of supply | P1 | `tax.ts` supports only a CGST/SGST split. |
| 17 | **Per-rate tax summary** (5% / 12% / 18% taxable value + tax) on the invoice | P0 | The invoice prints one lump CGST and SGST total. |
| 18 | **Amount in words**, "Authorised signatory", terms | P1 | Standard on A4 invoices. |
| 19 | **Receipt shows tax lines only when tax > 0 but the A4 invoice always does** | P2 | Inconsistent. A non-GST shop's A4 invoice shows ₹0.00 CGST/SGST rows. `gst_enabled` is stored but the print views read `taxPaise`, not the flag. |
| 20 | **Shop logo on receipt/invoice**, UPI QR code for payment | P1 | The UPI QR removes a very common manual step. |
| 21 | **Thermal printer direct (ESC/POS) and auto-cut / cash-drawer kick** | P2 | Printing goes through `window.print()` and the system dialog on every bill. This is slow at a busy counter. Offer a "print silently to default printer" option. |
| 22 | **Share bill by WhatsApp / SMS / PDF / email** | P1 | The customer has to take paper. A PDF export and a WhatsApp link are expected in 2026. |
| 23 | **GST reports**: GSTR-1 style summary, HSN summary, tax by rate | P1 | `reports.ts` has daily, by item and by payment mode only. |

### 2.3 Inventory and purchasing

| # | Feature | Priority | Evidence / why |
|---|---|---|---|
| 24 | **Purchase / supplier management** (suppliers, purchase bills, cost price) | P0 | Stock reason `purchase` exists but there is no purchase document and no cost price. |
| 25 | **Cost price and profit / margin reports** | P0 | The `items` table has `price_paise` and `mrp_paise` but no cost field. The owner cannot see profit. |
| 26 | **Batch / expiry tracking** | P1 | Important for groceries and medicines. Add expiry alerts. |
| 27 | **Low-stock report and reorder list** | P1 | Low stock is only a badge in the list, with one global threshold. A per-item reorder level and a "shopping list to print" are missing. |
| 28 | **Multiple barcodes / pack sizes per item, and variants** | P1 | One barcode per item. |
| 29 | **Barcode label printing** and barcode generation for loose items | P1 | |
| 30 | **Physical stock-take / audit mode** (count, compare, adjust in bulk) | P1 | Only single-item adjust dialogs exist. `PILOT.md` tells shops to do a stock-take, but the app does not help. |
| 31 | **Bulk edit** (price change by category/percentage, bulk activate/deactivate) | P1 | |
| 32 | **Item delete / archive with confirmation** | P2 | Only an "active" checkbox. Nothing indicates inactive items in the list. |

### 2.4 Customers

| # | Feature | Priority | Evidence / why |
|---|---|---|---|
| 33 | **Edit and delete customers** | P0 | The docs say "Add/edit", but `CustomersScreen` has an add dialog only. A typo in a phone number cannot be corrected. |
| 34 | **Customer detail page**: purchase history, total spent, outstanding | P1 | |
| 35 | **Loyalty points / customer price lists** | P2 | |
| 36 | **Duplicate-phone detection** | P1 | `customers.phone` is only indexed. Nothing stops two records for one number. |

### 2.5 Reports and dashboard

| # | Feature | Priority | Evidence / why |
|---|---|---|---|
| 37 | **Home dashboard**: today's sales, bills, cash/UPI split, top items, low stock | P0 | The app opens directly to the POS and there is no at-a-glance view. |
| 38 | **Charts** (sales trend, category share, hourly heat map) | P1 | Reports are tables only. |
| 39 | **Quick range presets** (Today, Yesterday, This week, This month, This FY) | P1 | `ReportsScreen` has two raw date inputs and a 30-day default. |
| 40 | **Reports: by category, by customer, by cashier, profit, voids/returns, tax, outstanding credit** | P1 | Only three reports exist. |
| 41 | **Reports scale**: aggregate in SQL, not in the browser | P1 | `ReportsScreen` calls `listBills` and then `getBill(id)` for **every bill in range** (an N+1 query). 30 days of busy sales will be slow, and a full FY report may freeze the UI. |
| 42 | **Export to PDF / Excel (.xlsx)**, scheduled end-of-day summary | P2 | CSV only. |
| 43 | **Day-end (Z) report** that can be printed on the receipt printer | P1 | |

### 2.6 Security, accounts and operations

| # | Feature | Priority | Evidence / why |
|---|---|---|---|
| 44 | **Users, roles and PIN lock** (owner vs cashier; restrict void, price override, stock adjust, reports) | P0 | There is no user concept. Void has a reason but no "who". Bills have no cashier. |
| 45 | **Audit log** (who voided, adjusted, changed price, when) | P1 | Stock movements are logged, but settings, price and customer edits are not. |
| 46 | **Automatic scheduled backups** and backup retention | P1 | Backups are manual and the panel warns after 7 days. `DECISIONS.md` B0-2 says pre-migration copies "are never deleted automatically yet". |
| 47 | **Auto-update** | P1 | Disabled, B4-2. Needs updater signing keys. |
| 48 | **Code signing** | P1 | Builds are unsigned (B0-6). SmartScreen and Gatekeeper warnings will put off non-technical shopkeepers. |
| 49 | **Multi-device / multi-counter** support | P2 | Single-PC SQLite. The README states this. Worth a roadmap line. |
| 50 | **Localisation** (Tamil, Hindi, etc.) | P1 | English only, although every string is already in `en.ts`, so the groundwork exists. Target shops are local Indian stores. |
| 51 | **Data import from other billing software** (Tally, Vyapar, Excel templates) | P2 | CSV items only. No customer import. |
| 52 | **Keyboard shortcut cheat sheet and in-app help / onboarding tour** | P2 | Shortcuts (F2/F4/F9) are documented only in README and SCREENS.md. |

### 2.7 Quality gaps that act like missing features

- **E2E tests:** `apps/web/e2e/` is empty, even though Playwright is a dependency. The UI has two unit test files (`diagnostics.test.ts`, `syncEngine.test.ts`) and many `data-testid`s waiting for tests. Money-critical flows (save bill, void, print, restore) deserve end-to-end coverage.
- **Error handling in `save()`:** `createBill` is wrapped in `try/finally` with **no `catch`**. A failed save (disk full, DB locked) leaves an unhandled promise rejection and **no message to the operator**. The same applies to `hold()`, `resume()` and `onVoid()`.
- **Window `confirm()` dialogs** (`PosScreen` discard, `BackupPanel` restore) are native blocking dialogs. They look unlike the rest of the app and are unreliable in some webviews.

---

## 3. UI / UX improvements

### 3.1 Billing screen (highest impact)

1. **Make the total the hero.** The total sits in a small 20 rem side card at `text-base`. Show it large (36–48 px) and sticky, since this is what both operator and customer look at.
2. **Search-as-you-type dropdown** under the scan field (name, barcode, category), with arrow keys and Enter. This replaces the "N items match" error.
3. **Line editing.** Replace the free-text qty field with `−  qty  +` steppers. Provide larger touch targets (min 40 px). Show unit (pcs/kg/L) next to the quantity. Currently weight items show only a bare number.
4. **Quick-cash buttons** (Exact, ₹100, ₹200, ₹500, ₹2000) and a large "Change to return: ₹X" panel. Today the change line is one small green sentence.
5. **Payment area.** Show the selected mode as a clear segmented control with icons, and indicate keyboard keys (e.g. `F5 Cash`, `F6 UPI`). Add split payment.
6. **Disable "Save" when the bill is empty or payment is short**, and say why, instead of letting the click fail with a notice.
7. **Save feedback.** The green "Saved bill INV-0042" notice persists and is easy to miss. Show a toast or a brief full-width banner with "Print again" and "New bill" actions.
8. **Show a running line count and item count**, and highlight the most recently added line, so a scan visibly "lands".
9. **Audible or visual scan feedback** (beep or flash on success, red flash on unknown barcode). Operators scan without looking at the screen.
10. **Currency formatting.** The code mixes `formatPaise(...)` with and without the ₹ prefix (price column has no symbol, total has). Use one `<Money>` component. Use Indian digit grouping (₹1,23,456.00) via `Intl.NumberFormat("en-IN")`, and right-align with tabular numerals.
11. **Held bills** are a row of pills under the table. Move them into a visible "Held (3)" drawer with customer names, item counts and totals.
12. **Remove-line control** is a tiny red text link. Use an icon button with an accessible label and a tooltip, plus Undo.

### 3.2 Navigation and layout

1. **Replace the top tab bar with a left sidebar** (icons plus labels), collapsible. Eight text tabs in `overflow-x-auto` will scroll or clip on a small window.
2. **`max-w-6xl` container** wastes a wide counter monitor and cramps the POS. Let the POS use full width, and keep a max width only for forms and settings.
3. **Add a status bar**: shop name, today's sales, sync state (online/offline/pending), last backup age with a warning colour, and app version. The backup warning is buried in Settings.
4. **Show the active route's page title** and breadcrumbs on item/bill detail pages. Today "Back" is a text link at top right.
5. **Dead code:** `Layout` still contains a `disabled` nav branch that no item uses.

### 3.3 Visual design and consistency

1. **No design system.** Every screen repeats long Tailwind class strings (`rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50`). Extract `Button` (primary/secondary/danger), `Input`, `Select`, `Table`, `Modal`, `Badge`, `EmptyState` and `Toast` components. This also removes inconsistencies such as button padding `py-1.5` vs `py-2`.
2. **Typography scale.** Everything is `text-sm` with `text-lg` page titles. Increase base size to 15–16 px for a shop counter viewed at arm's length, and give tables more row height.
3. **Colour and branding.** Only generic gray and blue are used. Apply the MyTownCart brand colours to the primary actions, header and focus rings.
4. **Dark mode** is not provided (0 `dark:` classes). Many shops run in dim light, and a high-contrast theme also helps visibility.
5. **Icons.** There are none. Add a consistent icon set for nav, actions (edit, delete, print, void) and payment modes.
6. **Tables** have no sticky headers, no sortable columns, no pagination or virtualisation, and no row hover state on Items, Bills or Customers. The Items and Bills screens will degrade past a few thousand rows.
7. **Status chips** (void / active, low stock, published) use different ad-hoc colours per screen. Standardise them.

### 3.4 Forms and dialogs

1. **Validation errors are weak.** For example, the customer dialog shows the *label text* ("Name") as the error message when the name is blank. The void dialog shows the placeholder text as its error. Use real messages next to the field.
2. **Money fields are plain text.** Use `inputMode="decimal"`, a ₹ prefix, input masks, and inline "invalid amount" errors. The tendered field accepts any text and silently treats unparseable text as `-1`.
3. **Void dialog copy is hard-coded English** ("A bill is never edited. Voiding writes…") outside `i18n/en.ts`, which breaks the documented rule, and the notice for "N items match" is also a literal string.
4. **Modals** lack focus trapping, Escape-to-close, and focus return; the backdrop does not close them.
5. **Unsaved-changes warning** is missing on the item form and settings.
6. **Settings** is one long page. Group it into tabs (Shop, Tax, Printing, Backup, Sync, Diagnostics, About), and make "Printer", "Updates" and "Language" real controls rather than informational paragraphs.
7. **Setup wizard** is a single form. A guided multi-step flow (shop → tax → first products → printer test → backup) would match the checklist in `PILOT.md`, which currently lives only in docs.

### 3.5 Empty, loading and error states

- The empty items list is one grey sentence. Offer "Add your first item", "Import CSV" (with a downloadable template) and a short explanation.
- Loading is a bare text string. Use skeleton rows.
- Failed repository calls on most screens have no visible error UI (`refresh()` calls are `void`-ed with no catch).
- First-run POS empty state should teach scanning, search and shortcuts.

### 3.6 Accessibility

- Only **6** `aria-`/`role` attributes in the whole UI.
- Icon-less text buttons are fine, but icon-only buttons (the held-bill "×") need labels, and some already do.
- Colour-only status (red/green text) needs a text or icon companion, and contrast of `text-gray-500` on white at small sizes is borderline.
- Add visible focus rings, a skip link, table `scope` attributes, `aria-live` regions for notices (so "Saved bill…" is announced), and form `aria-describedby` for errors.
- Support **system font scaling** and a user-selectable larger UI size.

### 3.7 Responsiveness and touch

- Only five responsive breakpoints in all screens. The POS grid collapses below `lg`, but tables do not (horizontal overflow on a small window).
- Many shops use touchscreen all-in-ones or tablets. Provide a touch-friendly POS mode with larger buttons, a numeric keypad overlay, and no hover-only affordances.

### 3.8 Print output

- Receipt: add shop logo, customer name/phone, item count, savings (MRP − price), tax breakup per rate, UPI QR and the bill barcode (for returns lookup).
- The receipt always prints "Thank you" beside the user's own footer. Make this configurable.
- Receipt width is fixed in CSS (`46mm`/`72mm`). Provide a Settings choice for the default paper size, since the POS hard-codes `receipt-80`, so 58 mm printers must reprint from the bill detail screen.
- A4 invoice: add a "Bill to" block, columns for HSN, rate % and taxable value, a bank/UPI block and a terms footer.

---

## 4. Technical observations that affect the UX

| Area | Observation | Suggestion |
|---|---|---|
| Reports performance | N+1 `getBill()` per bill (`ReportsScreen.tsx`) | Add SQL aggregation commands in Rust and keep `packages/core` aggregation for tests. |
| Error handling | `save()` has `try/finally` without `catch` (`PosScreen.tsx`) | Catch, show a persistent error, and keep the cart intact. |
| Concurrency | `addItem` + async `onScan` can race with rapid scans because the notice and query are reset after `await` | Queue scans, or process them with a functional state update and an in-flight guard. |
| Quantity entry | `setQty` silently ignores invalid input, so the field shows a value that is not the one used | Reset the field to the stored value on invalid input, and show an inline error. |
| Whole-count rule | A count item with `0.5` only fails at save time (`line.count_qty_not_whole`), and the message falls through as the raw code | Validate on entry. Map every error code to a message (only 3 are mapped). |
| GST flag | `gst_enabled` is stored but not used to hide tax UI or to switch invoice type (bill of supply vs tax invoice) | Honour it throughout. |
| Held bills | The label is derived from the quantity sum, which gives "3.5 item(s)" for weight items | Use the line count and customer name. |
| Dev vs desktop parity | The browser dev mode resets data on reload | Offer a demo-data seed so reviewers and contributors see realistic screens. |
| i18n | Some strings are hard-coded (void dialog, "N items match") | Add an ESLint rule or test that flags literals in JSX. |

---

## 5. Suggested roadmap

### Phase 1 — Pilot-ready (2–4 weeks)
- Discounts (line + bill), round-off, split and partial payments
- Customer edit, outstanding balance and "receive payment"
- Search-as-you-type on the POS, and an error `catch` on every save path
- HSN, customer GSTIN/address, per-rate tax summary, amount in words on the invoice
- Dashboard (today's sales, low stock, backup age)
- Reports N+1 fix, date presets
- Playwright E2E for save / void / hold / print

### Phase 2 — Daily-driver (1–2 months)
- Returns and credit notes
- Cost price, purchase bills, suppliers, profit report
- Users, roles, PIN and audit log
- Shop-level paper size, direct thermal printing, UPI QR, PDF/WhatsApp share
- Component library, sidebar navigation, dark mode, accessibility pass
- Stock-take mode, batch/expiry, reorder list
- Tamil/Hindi localisation

### Phase 3 — Growth
- Scheduled backups, auto-update with signed builds, code-signed Windows installer
- GSTR-1 export, charts, multi-counter sync, loyalty, data import from other tools

---

## 6. What is already good (keep)

- Integer-only money, quantity and tax maths, with a clear rounding rule and tests (`core/test/*`).
- Immutable bills, with void-with-reason and compensating stock movements.
- Gap-free per-FY invoice numbering inside the save transaction.
- Keyboard-first POS (F2/F4/F9) and held bills that re-read prices on resume.
- Encrypted `.mtcb` backup with a recovery key and a pre-restore safety copy.
- Opt-in, redacted, local-only diagnostics, and a clear privacy statement.
- Good documentation (`DECISIONS.md`, `docs/`) with honest limitations.
