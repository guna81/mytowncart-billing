# Manual checks before a release

The automated tests cover logic and the web screens in a browser. They do **not**
run the Tauri window, a real SQLite file with old data, or a second device on the
LAN. Run these on a **copy** of real shop data (Settings → Backup first).

## 1. Upgrade an existing database (migration 0009)

1. Install or run the new build over a copy of a database that already has users.
2. Start the app. Expect: it opens, and a `backups-local/pre-migration-v8-*.db` copy exists.
3. Lock the terminal and log in with an existing user's old PIN. Expect: it works.
4. With the sqlite3 CLI on the data file: `select pin from users;` is empty for
   every row and `select count(*) from user_pins;` equals the number of users with a PIN.

## 2. Roles in the desktop window

1. Log in as a **cashier**. Expect: no Users, Settings, Suppliers, Purchases,
   Stock audit or MyTownCart in the sidebar; opening `#/users` shows "Owner only".
2. Make a bill, hold and resume a bill, receive a customer payment, close the day. Expect: all work.
3. Open a saved bill. Expect: no Void button. Stock screen: no Adjust link.
4. Lock, log in as the **owner**, void a test bill and adjust a stock level.
   Expect: both work, and *Users → Activity log* names the owner for each.
5. Enter a wrong PIN 8 times. Expect: "Too many wrong PINs" for ~30 s, even with the right PIN.
6. Try to demote the only owner to cashier. Expect: refused.

## 3. LAN browser (second device)

1. Settings → LAN server → start. Open the shown address (it contains `?key=`) on a phone.
2. Expect: the page loads, asks for a PIN, and the key disappears from the address bar.
3. Open the same address **without** `?key=` in a private tab. Expect: data calls fail with 401.
4. Log in as a cashier on the phone and make a bill. Expect: works.
5. As the cashier, try to void a bill (e.g. from another tab's console or an old page).
   Expect: "needs the owner".
6. Stop and restart the LAN server. Expect: the old link stops working; the new one works.

## 4. Billing numbers

1. Tax-exclusive shop, 18% item at ₹1000, bill discount ₹100. Expect: total ₹1080.
2. Pay a ₹100 bill with ₹120 UPI + ₹10 cash. Expect: refused (change larger than cash).
3. Credit sale ₹500 to a customer, then a credit note for ₹200 of it. Expect:
   the customer's balance drops to ₹300 and the ledger shows the credit note.
4. Try to receive ₹400 from that customer. Expect: refused (owes ₹300).
5. Try to void the bill that has a credit note. Expect: refused.
6. Reopen the saved bill. Expect: discount, round-off and HSN codes are shown and printed.
7. Redeem loyalty points on a bill, then check the balance. Expect: points changed once.
8. Pay a ₹380 cash bill with ₹500. At Day end, expected cash should rise by ₹380, not ₹500.
9. Return an item from a UPI sale or a credit sale. Day end should show no cash refund.
