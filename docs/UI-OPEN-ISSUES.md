# MyTownCart Billing — Open UI Issues (round 2 review)

Audience: an implementing agent with repo access. Target: `apps/web` (React 19, Tailwind 4, Vite, react-router hash routes, zustand).
Source: live review of the build at `http://192.168.31.239:8080/#/` (all 16 screens, 1470x681 plus 1024x768 for POS), after a first round of fixes was applied by another agent.
Supersedes the "not done" parts of `docs/UI-IMPROVEMENT-PLAN.md`; that file still holds the original findings (F1-F14) and decisions.

## Ground rules
- The working tree has many uncommitted changes. Do NOT run `git checkout`, `git stash` or `git reset`. Make additive, targeted edits only.
- Keep every existing `data-testid` (e2e in `apps/web/e2e`). All user-visible strings go through `src/i18n/{en,hi,ta}.ts`; add new keys to all three.
- Prefer shared primitives in `src/components/ui` over per-screen Tailwind.
- Verify: `pnpm --filter @mytowncart-billing/web typecheck`, `pnpm test`, `pnpm --filter @mytowncart-billing/web test:e2e`.
- Decisions already made: minimum POS screen 1024x768 (design target 1280x720); sidebar changes are visual only (no route changes); no migration of existing low-stock thresholds.

## Already done (do not redo)
POS panel no longer clipped and has a pinned Save footer (F1, F7); disabled Save buttons on an empty cart (F6); Day-End neutral "Count the drawer" state (F2); EmptyState with CTA on Customers, Suppliers, Purchases, Users (F4); grouped sidebar SELL/INVENTORY/MANAGE (F8); `6 Nov 2026` dates and active Reports range button (F9); whole Bills row opens the bill (F5); Bill detail hierarchy (F13); Dashboard "Low-stock alerts are off" hint (F3, partial).

## Issues to fix (priority order)

### P0 / High — Add Item form (`ItemFormScreen.tsx`, route `#/items/new`)
**N1. Floating action bar overlaps the form.** On load, the white Cancel/Save bar sits over the "Opening stock" field (visible at y~590 of a 681px viewport). It is narrower than the form, off-centre relative to the page and has a heavy shadow, so it looks like a stray box. Fix: make it a real sticky footer: `sticky bottom-0`, same width as the form card, border-top instead of a big shadow, background matching the card, and add bottom padding to the form so no field is ever hidden behind it. Test at 1024x640 and 1470x681.
**N2. One long undifferentiated column.** 14 fields in a single stack, optional ones (HSN, MRP, Cost) between required ones. Restructure into three cards, each with a heading and a 2-column grid at >=768px:
  1. Basics: Item name (required), Barcode (+ hint), Category, Sold by.
  2. Pricing: Selling price (required), MRP, GST rate, Cost price, HSN/SAC.
  3. Stock & status: Opening stock, Active (sellable), Photo.
Mark required fields with an asterisk; keep optional ones visually secondary. Keep all `data-testid`s and field order in the DOM compatible with e2e (check `apps/web/e2e` before moving anything).
**N3. Category control and photo box.** Category is a `<select>` plus a separate "Or type a new category name…" input; merge into one combobox with a "Create 'xyz'" option (or keep both but put the new-category input directly under the select, shown only when "New category…" is chosen). The Photo area shows a box with the word "None"; replace it with an icon placeholder and the existing "Save the item first, then add a photo" note.
**N3b. Page width.** The form is a narrow centred column while Items/Bills are full width. Use the same centred `max-w` container for all form/detail pages (Settings, Items form, Bill detail), with a shared `PageHeader` (F10).

### P1 / Medium
**N4. POS tendered quick-amount chips wrap and clip.** In the right panel the chips Exact / 100 / 200 / 500 wrap and the 2000 chip is orphaned and cut off at the bottom of the scrolling area; the panel scrolls internally with no hint. Fix: lay the chips out in a fixed 3-4 column grid, shrink the vertical rhythm of the panel (totals block, Payment) so Save is visible without internal scroll at 1280x720, and add a subtle bottom fade or shadow where the panel can scroll.
**N6. Charts.** Reports "Revenue Trend" still draws a single dot and an axis label `11-06` even though it shows "Not enough data for a trend". When there are fewer than 2 points hide the plot area and axis entirely (empty state only). Dashboard "Hourly Store Traffic" has oversized axis labels (0h, 3h, ... 23h) and empty bars rendered as dashes: reduce label size (`text-xs`), show labels every 3h, and show a value tooltip on hover/focus.
**F10. Shared page layout (not done).** Add `components/ui/PageHeader.tsx` (title, subtitle, right-aligned actions) and use it on every screen; define one container width for forms/detail pages and a full-width one for tables.
**F11. Contrast (not done).** About 30 uses of `text-gray-400` plus many `text-xs text-gray-500` captions. Raise to `text-gray-600` or darker (>=4.5:1 on white); keep operational text >=12px (sidebar group labels, table headers, hints).

### P2 / Low
**N5. POS Held bills card.** It renders as a large empty block under the cart. Collapse it to a single line ("No held bills") or hide it until a bill is held.
**N7. Sidebar bottom-left `=?` icon** has no label or tooltip; add `title` and `aria-label` (it appears to be a shortcuts/help trigger) or remove it.
**N8. Sidebar scroll hint.** At ~680px height the MANAGE group (Reports, Users, Settings, MyTownCart) is cut off; the nav scrolls but nothing signals it. Add a fade/shadow at the bottom of the nav, and auto-collapse to the icon rail below 1280px width (state `collapsed` already exists in `Layout.tsx`).
**N9. Low-stock default.** Settings still shows threshold `0` for the existing shop (expected: no migration). Confirm new shops created via `SetupWizard` get 5 (5000 milli) and that Dashboard, Stock, Items and Stock Audit all use one shared helper such as `effectiveLowStockThreshold(profile)` in `src/lib` (Stock Audit's reorder list previously fell back to 5 when the value was 0). Add a unit test. A global threshold is also wrong for kg/litre items; per-item thresholds are out of scope.

## Not yet reviewed (please check as part of the work)
Hindi/Tamil locales (overflow in sidebar group labels, POS panel, new form cards); 1280px sidebar auto-collapse; Customers/Suppliers/Purchases/Users modals; Barcode Labels; Stock Adjust modal; PIN lock; print templates.

## Acceptance checklist
- [x] Add Item form: no element overlaps another at 1024x640, 1280x720, 1470x681; Save always visible and never covers a field; three cards.
- [x] Item can be created with keyboard only (Tab order: Basics -> Pricing -> Stock -> Save).
- [x] POS at 1024x768: Save & print is visible without scrolling the right panel; chips do not clip.
- [x] Reports with a single day shows only the empty message, no dot or axis.
- [x] `PageHeader` used on all screens; contrast raised (grep shows no `text-gray-400` on operational text).
- [x] typecheck, unit and e2e all green; before/after screenshots attached for Items form, POS, Reports, Dashboard.
