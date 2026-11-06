# MyTownCart Billing — UI Improvement Implementation Plan

Audience: an implementing agent with repo access. Target: `mytowncart-billing/apps/web` (React 19, Tailwind 4, Vite, react-router, zustand; wrapped by Tauri).
Source of findings: live walkthrough of the web build at `localhost:5173` (every sidebar screen, with 3 seeded items and 1 saved bill, at 1470px and 1024px wide). Evidence is stated per finding.

## Ground rules
- The working tree has MANY uncommitted user changes (`git status` shows ~40 modified + untracked files, including every screen). Do NOT `git checkout`/`git stash`/`git reset` these files. Ask the user to commit first, or work on a branch and only make additive edits.
- Make no behaviour/data changes except where a finding below says so (F2, F5). Keep all `data-testid` values (e2e in `apps/web/e2e`). All user-visible strings go through `src/i18n/{en,hi,ta}.ts` (`t("key")`); add any new key to all three files.
- Shared primitives live in `src/components/ui` (Button, Input, Badge, Modal, Money). Screens currently use raw Tailwind and import none of them; prefer extending primitives over per-screen classes.
- Verify after each phase: `pnpm --filter @mytowncart-billing/web typecheck`, `pnpm test`, `pnpm --filter @mytowncart-billing/web test:e2e`.

## Findings (priority order)

### P0 — functional problems
**F1. POS right-hand panel is cut off at 1024px wide.** At 1024x640 the Total Payable / Payment / Save area is clipped off the right edge, so the cashier cannot finish a sale. `PosScreen.tsx:515` uses `grid-cols-1 lg:grid-cols-[1fr_21rem]`; the `1fr` track can't shrink (needs `minmax(0,1fr)`), and the 15rem sidebar (`Layout.tsx:187-189`) takes most of the width. Also at 1470x738 the panel bottom (Save / Clear) touches the viewport edge and isn't visibly scrollable.
**F2. Day-End shows a red "CASH SHORTAGE ₹-2158.00" on an untouched drawer.** Nothing has been counted, so the alarming state is misleading. Show a neutral "Count the drawer to see variance" state until at least one denomination is entered (`DayEndScreen.tsx`).
**F3. Low-stock alerts disagree across screens.** Root cause: the threshold default is 0 (`SetupWizard.tsx:36`), and screens treat 0 differently. Dashboard (`DashboardScreen.tsx:45`), Stock (`StockScreen.tsx:181`) and Items (`ItemsScreen.tsx:49`) use the raw value, so 0 means "never low". Stock Audit's reorder list (`StockAuditScreen.tsx:100-104`) silently falls back to 5 when the value is 0. Result: Parle-G (stock 2) is "healthy" on Dashboard but appears in the Stock Audit reorder badge. Fix (decided): one shared helper (e.g. `effectiveLowStockThreshold(profile)` in `src/lib`) used by all four screens; new shops get 5 (5000 milli) in `SetupWizard`; do NOT migrate existing profiles; when the saved value is 0, Dashboard's low-stock card shows "Low-stock alerts are off. Set a threshold in Settings" with a link. Add a unit test for the helper. Note: the threshold is one global number, so weight-based items (kg/litre) may need a different value; per-item thresholds are out of scope.

### P1 — usability
**F4. Bare empty states.** Items, Bills, Customers, Reports, POS cart, Held bills show a single grey line (`items.empty`, `bills.empty`, `customers.empty`, `reports.empty`, `pos.empty`, `pos.resume_empty`). Suppliers/Purchases/Users use an empty table row instead — inconsistent. No action/CTA.
**F5. Bills list rows are not clickable.** Only the small blue "View" link opens a bill (`BillsScreen.tsx`). Make the whole row a link/keyboard-activatable target; keep "View".
**F6. POS actions are always enabled.** "Save & print (F9)", "Save", "Hold" are active with an empty cart. Disable them (with `aria-disabled` + tooltip) until a line exists; show change due when Tendered > total.
**F7. POS right panel density/hierarchy.** Totals, discount, GST, round-off, payment, tendered, customer, 2 save buttons stacked in one undifferentiated column. Group into Totals / Payment / Customer sections with dividers; make Save the sticky footer of the panel so it is always visible (ties in with F1). The line-discount inputs render the "0" in orange, which reads like a warning; use normal text colour (placeholder style only when empty).
**F8. Sidebar is 13 flat items** and the bottom ones (Reports, MyTownCart) fall off-screen below ~700px height (nav scrolls but nothing hints at it). Group under labelled headings: Sell (Billing, Bills, Customers), Inventory (Items, Stock, Stock Audit, Suppliers, Purchases), Manage (Day-End, Reports, Users & Roles, MyTownCart). Auto-collapse to the icon rail below ~1280px (`Layout.tsx` already has `collapsed` state). The bottom-left `=?` icon has no label/tooltip — add `title`/`aria-label` or remove.
**F9. Date formats are ambiguous.** Reports range shows `08/10/2026 → 06/11/2026` (native date inputs); Bills shows `06/11/2026, 15:53:48`. Format display dates as `6 Nov 2026` (central helper in `src/lib`), and keep the native inputs only where editing. Reports quick-range buttons (Today / Yesterday / This week / …) have no active state — add `aria-pressed` + selected styling.

### P2 — polish and consistency
**F10. Page layout is inconsistent.** Settings, Items form and Bill detail are left-aligned narrow columns with large empty right areas; Items/Bills tables are full width. Introduce one `PageHeader` (title, subtitle, right-aligned actions) and constrain forms/detail pages to a consistent centred max width. Items form (`ItemFormScreen.tsx`): the Save button sits below the fold at 682px height — make the form footer sticky.
**F11. Low-contrast small text.** 30 uses of `text-gray-400` plus many `text-xs text-gray-500` captions. Raise to at least `text-gray-600` (≥4.5:1 on white) and don't go below 12px for anything operational.
**F12. Charts.** Reports "Revenue Trend" with a single day renders one dot with a "11-06" axis label; Dashboard hourly chart has very large x-axis labels (0h … 23h) relative to the bars. Show a "Not enough data for a trend" message when <2 points; reduce axis label size, show value on hover/focus for bars.
**F13. Bill detail.** Page fills only ~60% width; actions (Print receipt, Print A4 invoice, Return/Credit Note, Void bill…) are four equal-weight buttons. Make Print primary, Return secondary, Void a separated destructive action. Show payment breakdown as a labelled row, not a bare "Payments: Cash 158.00" line.
**F14. Primitives not used.** Convert screens to `Button`/`Input`/`Badge` gradually (do this opportunistically inside the phases above; don't do a repo-wide churn PR).

## Phases

### Phase 1 — Foundations (no behaviour change)
1. Add `components/ui/EmptyState.tsx` (props: `icon`, `title`, `hint`, `action`, optional `data-testid`) and export from `ui/index.ts`. Apply to F4 screens; keep `data-testid="reports-empty"`. Add hint + CTA strings (e.g. "Add your first item" → `/items/new`, "Import CSV") to all 3 locales.
2. Add `components/ui/PageHeader.tsx` and a `lib/formatDate.ts` helper; unit test the helper (vitest).
3. F11: grep `text-gray-400|text-gray-500` + `text-xs` and raise contrast/size on operational text.
Done when: typecheck + unit + e2e green; before/after screenshots of Items, Bills, Customers, Reports, Suppliers, Purchases.

### Phase 2 — POS (highest value)
1. F1: change grid to `lg:grid-cols-[minmax(0,1fr)_20rem]`; ensure the cart table has `min-w-0`/horizontal scroll inside its card; auto-collapse sidebar under 1280px. Test at 1024x640, 1280x720, 1470x738.
2. F7: restructure the right panel into sections with a sticky footer holding the primary Save button; keep F9/F4/F2 shortcuts and all existing `data-testid`s.
3. F6: disabled states, change-due display, selected payment mode clearly highlighted.
4. Replace orange discount "0".
Done when: a full cash sale, UPI sale, split payment and hold/resume work with keyboard only at 1024px; e2e green.

### Phase 3 — Navigation and data screens
1. F8 sidebar grouping + labels + tooltip for `=?`; keep collapse behaviour.
2. F5 clickable bill rows; F9 date formats + Reports active range; F13 bill detail hierarchy.
3. F10 apply `PageHeader`/container to Settings, Items form (sticky footer), Bill detail.

### Phase 4 — Correctness and charts
1. F2 Day-End neutral state (no counted denominations → no shortage banner).
2. F3 shared low-stock helper, default 5 for new shops, hint when 0 (decided above).
3. F12 chart empty/low-data states and axis sizing.

### Phase 5 — Verification
- `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @mytowncart-billing/web test:e2e`.
- Manual pass at 1024x640, 1280x720, 1470x738 across all 13 sidebar screens; compare with baseline screenshots taken before Phase 1.
- Keyboard-only run of the POS: F2 focus scan, add items, F4 hold, F9 save.
- Check Hindi/Tamil locales for text overflow in sidebar group labels and the POS panel (longer strings).
- Desktop (Tauri) check: `pnpm desktop:dev` once to confirm nothing depends on web-only layout.

## Out of scope / not reviewed
- Customers/Suppliers/Purchases/Users forms and modals, Barcode Labels, Stock Adjust modal, PIN lock, Keyboard shortcuts modal, receipt/A4 print templates, MyTownCart connected state, dark mode (none exists), mobile widths below 1024px.
- Browser build has temporary data only; backup/restore screens were not exercised.

## Decisions (made with the user)
1. Low-stock default: 5 units for new shops; existing shops are not migrated; show an "alerts are off" hint when the threshold is 0 (see F3).
2. Minimum supported POS screen: 1024x768; design target 1280x720. Sidebar auto-collapses below 1280px. Phone widths stay out of scope.
3. Sidebar: visual grouping and labels only. Do NOT change route paths or their order (e2e tests, F-key shortcuts, bookmarks and the Tauri build depend on them). Keep Billing first.
