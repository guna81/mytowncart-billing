# Pilot runbook (B4)

For the first shops running MyTownCart Billing for real. Goal: real bills on
real days with a safe way back and enough information to fix problems.

See [recent improvements](WHATS-NEW.md) for feature availability in source
versus the published installer. LAN access is a development feature; follow
[LAN.md](LAN.md) before enabling it.

## Before day one

1. **Install** the Windows installer from the release page, allow the
   SmartScreen prompt (*More info → Run anyway*), and verify the SHA-256
   against the release's checksum file (`certutil -hashfile <file> SHA256`).
2. **Setup wizard:** shop name, GST on/off, prices include tax or not, invoice
   prefix. These can be edited later in Settings, but the prefix starts a new
   number sequence, so decide it first.
3. **Settings → Shop profile:** address, phone, GSTIN and receipt footer —
   they print on every receipt and invoice. Set the low-stock threshold.
4. **Print test:** make one test bill, *Print receipt*, and check alignment on
   the receipt printer; *Print invoice* for A4. Then void the test bill with
   a reason so reports stay clean.
5. **Users and PINs:** in *Users*, add yourself first as an **Owner** with a
   4–6 digit PIN, then add each cashier. Once the first PIN exists the terminal
   asks for a PIN; use *Lock* in the sidebar when stepping away. Cashiers cannot
   void bills, adjust stock, or change shop, LAN and branding settings. Keep the
   owner PIN private and written down somewhere safe. A restored backup brings
   the old PINs back with it. Forgot the owner PIN? See
   [Forgotten owner PIN](#forgotten-owner-pin).
6. **Items:** add (or CSV-import) the catalog with prices, GST rates and
   opening stock. Take a stock-take first — opening stock is what the app
   trusts until the first count. Re-importing a CSV with existing barcodes
   updates those items but **ignores** their `opening_stock` column; use the
   Stock screen's adjust/purchase action for later corrections.
7. **Backup:** Settings → Backup and restore → create the recovery key,
   write it down, acknowledge, plug in a USB drive, enter its folder,
   remember it, and run *Back up now*. Confirm the file exists on the drive
   and that a second computer can open it with the key (optional but
   recommended).
8. **MyTownCart:** connect, map categories, publish. Items without photos
   publish hidden; upload photos from the Photos panel to make them visible.

## Every day

- Bill with the scanner; use *Hold (F4)* for a customer who steps away.
- At close: review **Reports** and **Day end**. Enter opening cash and
  denomination counts, compare expected cash with counted cash, save the
  closure and print the Z-report. Reconcile UPI/card totals with those services.
- Run *Sync now* (MyTownCart → Sync) before closing, and read the problems
  and reconcile lists.
- Plug in the backup drive and run *Back up now*. The panel warns after 7
  days without a backup.

## Troubleshooting

| Symptom | What to do |
|---|---|
| SmartScreen blocked the installer | *More info → Run anyway*; verify the SHA-256 first |
| Scanner types but nothing is added | Click the scan field (or press F2) and scan again; the code must match an item's barcode exactly |
| "N items match — type a barcode" | Two items share the search text; scan the barcode instead |
| Bill won't save: "Payment is short" | Enter the tendered amount for cash, or pick the right payment mode |
| Sync shows problems | Network issues clear on the next sync; a rejected move (unknown item) needs the item fixed on the marketplace |
| "Session expired" on MyTownCart | Disconnect and connect again; approval on the website is time-limited |
| Restore fails with "wrong key" | Check the key was typed in full (8 groups); try an older backup |
| App won't open after an update | The previous database is intact; reinstall the release that worked and report the version |

## When something goes wrong

1. **Don't delete anything.** The app keeps `backups-local/` copies before
   migrations and restores.
2. Settings → Pilot diagnostics → tick **Keep a diagnostic log**, use the app
   until the problem repeats, then **Show and copy report** and send that
   text. It contains the version, platform, window size and a short list of
   screens and error messages — recovery keys and tokens are redacted.
3. Note the approximate time of the problem and the bill number if there
   was one.
4. If data looks wrong, stop billing on that machine: take a fresh backup
   and restore yesterday's backup on a spare machine only after talking to
   the maintainer.

## Forgotten owner PIN

Anyone with the owner PIN can set a new PIN for any user in *Users*. If the
owner PIN itself is lost, someone with access to the computer can reset it:

1. Close the app and take a copy of `mytowncart-billing.db` (see the README for
   its folder; on Windows `%APPDATA%\com.mytowncart.billing`).
2. With the SQLite shell (`sqlite3 mytowncart-billing.db`) run
   `DELETE FROM user_pins;` and quit.
3. Open the app. With no PINs, it is back in setup mode: open *Users*, give the
   owner a new PIN first, then each cashier.

Needing file access to the PC is deliberate: it proves the person is at the
shop, and it never exposes bills. This does not work over the LAN.

## Privacy

Bills and customer data stay on the PC. Only catalog fields, stock deltas,
photos and order reads go to MyTownCart, and only while the shop's account
is linked. Backups are encrypted on the machine; diagnostics are opt-in and
local. See `../README.md` and `BACKUP.md`.
