#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""
Seed realistic dummy data into MyTownCart Billing SQLite database.
Usage:
    python3 tooling/scripts/seed-sqlite.py [optional_path_to_db]
"""

import sys
import os
import shutil
import sqlite3
import json
from datetime import datetime, timezone, timedelta

def get_db_path():
    if len(sys.argv) > 1:
        return os.path.abspath(sys.argv[1])
    
    # Default macOS path
    macos_path = os.path.expanduser("~/Library/Application Support/com.mytowncart.billing/mytowncart-billing.db")
    if os.path.exists(macos_path):
        return macos_path

    # Linux / other fallback
    linux_path = os.path.expanduser("~/.local/share/com.mytowncart.billing/mytowncart-billing.db")
    if os.path.exists(linux_path):
        return linux_path
        
    return macos_path

def to_local_iso(dt):
    # Formats as YYYY-MM-DDTHH:MM:SS.000+05:30
    tz = timezone(timedelta(hours=5, minutes=30))
    dt_tz = dt.replace(tzinfo=tz) if dt.tzinfo is None else dt.astimezone(tz)
    return dt_tz.strftime("%Y-%m-%dT%H:%M:%S.000+05:30")

def round_div(n, d):
    # Half-away-from-zero rounding
    return (n + (d // 2 if n >= 0 else -(d // 2))) // d

def compute_line_amounts(unit_price_paise, qty_milli, tax_rate_bp, discount_paise=0):
    gross_before_discount = (unit_price_paise * qty_milli) // 1000
    if discount_paise > gross_before_discount:
        discount_paise = gross_before_discount
    total_paise = gross_before_discount - discount_paise
    tax_paise = 0 if tax_rate_bp == 0 else round_div(total_paise * tax_rate_bp, 10000 + tax_rate_bp)
    net_paise = total_paise - tax_paise
    return net_paise, tax_paise, total_paise, discount_paise

def seed_database(db_path):
    print(f"Target SQLite database: {db_path}")
    if not os.path.exists(db_path):
        os.makedirs(os.path.dirname(db_path), exist_ok=True)

    # 1. Backup existing DB before modifying
    backup_dir = os.path.join(os.path.dirname(db_path), "backups-local")
    os.makedirs(backup_dir, exist_ok=True)
    ts = int(datetime.now().timestamp())
    backup_path = os.path.join(backup_dir, f"pre-seed-backup-{ts}.db")
    if os.path.exists(db_path) and os.path.getsize(db_path) > 0:
        shutil.copy2(db_path, backup_path)
        print(f"Created safety backup at: {backup_path}")

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute("PRAGMA foreign_keys = ON;")
    cur.execute("PRAGMA journal_mode = WAL;")

    tz_ist = timezone(timedelta(hours=5, minutes=30))
    now = datetime.now(tz_ist)
    now_str = to_local_iso(now)
    today_date_str = now.strftime("%Y-%m-%d")
    fy = "2026-27" if now.month >= 4 else f"{now.year-1}-{str(now.year)[2:]}"

    # 2. Shop profile
    print("Updating shop profile...")
    cur.execute("""
        INSERT INTO shop_profile (id, name, gst_enabled, prices_include_tax, invoice_prefix, address, phone, gstin, receipt_footer, low_stock_threshold_milli, updated_at)
        VALUES (1, 'GKS Mobiles and Computer', 1, 1, 'INV-', '42, Gandhi Road, Opp. Old Bus Stand, Salem - 636001, Tamil Nadu', '+91 98765 43210', '33AABCG1234F1Z5', 'Thank you for shopping at GKS Mobiles & Computer! For warranty & service support call +91 98765 43210.', 5000, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            gst_enabled = excluded.gst_enabled,
            prices_include_tax = excluded.prices_include_tax,
            invoice_prefix = excluded.invoice_prefix,
            address = excluded.address,
            phone = excluded.phone,
            gstin = excluded.gstin,
            receipt_footer = excluded.receipt_footer,
            low_stock_threshold_milli = excluded.low_stock_threshold_milli,
            updated_at = excluded.updated_at
    """, (now_str,))

    # 3. Categories
    print("Seeding categories...")
    categories = [
        "Smartphones & Tablets",
        "Mobile Accessories",
        "Audio & Wearables",
        "Cables & Chargers",
        "Storage & Memory",
        "Computer Peripherals",
        "Services & Repairs",
    ]
    cat_ids = {}
    for cat_name in categories:
        cur.execute("INSERT OR IGNORE INTO categories (name) VALUES (?)", (cat_name,))
        cur.execute("SELECT id FROM categories WHERE name = ?", (cat_name,))
        cat_ids[cat_name] = cur.fetchone()[0]

    # 4. Items
    print("Seeding items...")
    items_data = [
        # Smartphones & Tablets
        ("Apple iPhone 17 (128GB, Midnight)", "Smartphones & Tablets", "194253123456", "count", 7990000, 8290000, 7200000, 1800, 6000, "85171300"),
        ("Samsung Galaxy A55 5G (8GB/128GB, Awesome Iceblue)", "Smartphones & Tablets", "880609123456", "count", 2749900, 2999900, 2400000, 1800, 10000, "85171300"),
        ("Redmi Note 13 Pro 5G (8GB/256GB, Arctic White)", "Smartphones & Tablets", "694181234567", "count", 2199900, 2499900, 1950000, 1800, 12000, "85171300"),
        ("OnePlus Nord CE 4 (8GB/128GB, Celadon Marble)", "Smartphones & Tablets", "692181234567", "count", 2499900, 2699900, 2200000, 1800, 8000, "85171300"),

        # Mobile Accessories
        ("Spigen Rugged Armor Case (iPhone 17)", "Mobile Accessories", "880981234001", "count", 129900, 149900, 75000, 1800, 25000, "39269099"),
        ("Tempered Glass Screen Protector (Edge-to-Edge 9H)", "Mobile Accessories", "890123456001", "count", 29900, 49900, 8000, 1800, 50000, "70071900"),
        ("boAt 10000mAh Power Bank (22.5W Fast Charging)", "Mobile Accessories", "890412345001", "count", 119900, 199900, 75000, 1800, 15000, "85044090"),
        ("Magnetic 360° Car Dashboard Mobile Holder", "Mobile Accessories", "890123456002", "count", 49900, 79900, 22000, 1800, 20000, "39269099"),

        # Audio & Wearables
        ("boAt Airdopes 141 Bluetooth TWS Earbuds", "Audio & Wearables", "890412345002", "count", 129900, 299000, 78000, 1800, 18000, "85183000"),
        ("OnePlus Bullets Wireless Z2 Neckband (Magico Black)", "Audio & Wearables", "692181234002", "count", 169900, 229900, 125000, 1800, 14000, "85183000"),
        ("Sony WH-CH520 Wireless Bluetooth Headphones", "Audio & Wearables", "454873614001", "count", 449000, 499000, 360000, 1800, 4000, "85183000"),
        ("Noise ColorFit Pulse 2 Max Smartwatch (Deep Wine)", "Audio & Wearables", "890612345001", "count", 159900, 399900, 95000, 1800, 9000, "85176290"),

        # Cables & Chargers
        ("Anker 20W PowerPort III USB-C Fast Charger", "Cables & Chargers", "194644123001", "count", 129900, 149900, 79000, 1800, 22000, "85044030"),
        ("Portronics Konnect L 1.2m Type-C to Lightning Cable", "Cables & Chargers", "890423456001", "count", 34900, 59900, 14000, 1800, 35000, "85444299"),
        ("Realme 65W SuperDart USB Type-C Cable", "Cables & Chargers", "694139900001", "count", 49900, 79900, 23000, 1800, 16000, "85444299"),

        # Storage & Memory
        ("SanDisk Ultra 64GB MicroSDXC Card (100MB/s)", "Storage & Memory", "619659123001", "count", 54900, 85000, 33000, 1800, 30000, "85235100"),
        ("Kingston DataTraveler 128GB USB 3.2 Gen 1 Flash Drive", "Storage & Memory", "740617123001", "count", 74900, 120000, 48000, 1800, 25000, "85235100"),
        ("Crucial BX500 500GB 2.5\" SATA SSD", "Storage & Memory", "649528123001", "count", 289900, 450000, 220000, 1800, 3000, "84717020"),

        # Computer Peripherals
        ("Logitech B100 Optical USB Wired Mouse", "Computer Peripherals", "097855123001", "count", 34900, 42500, 23000, 1800, 28000, "84716060"),
        ("Dell KB216 Wired Multimedia USB Keyboard", "Computer Peripherals", "884116123001", "count", 64900, 79900, 44000, 1800, 15000, "84716060"),
        ("TP-Link TL-WN725N 150Mbps Wireless N Nano USB Adapter", "Computer Peripherals", "693536405001", "count", 49900, 69900, 31000, 1800, 12000, "85176290"),

        # Services & Repairs
        ("Tempered Glass & UV Protector Professional Fitting", "Services & Repairs", "SERV001", "count", 15000, 20000, 2000, 1800, 100000, "998713"),
        ("Phone Data Transfer & OS Diagnostics Service", "Services & Repairs", "SERV002", "count", 35000, 50000, 0, 1800, 100000, "998713"),
    ]

    item_ids = {}
    for name, cat, barcode, unit, price, mrp, cost, tax_bp, op_stock, hsn in items_data:
        cid = cat_ids[cat]
        # Check if item exists by barcode or name
        cur.execute("SELECT id FROM items WHERE barcode = ? OR name = ?", (barcode, name))
        row = cur.fetchone()
        if row:
            item_id = row[0]
            cur.execute("""
                UPDATE items SET name = ?, barcode = ?, category_id = ?, unit_kind = ?, price_paise = ?,
                                 mrp_paise = ?, cost_price_paise = ?, tax_rate_bp = ?, hsn_code = ?, updated_at = ?
                WHERE id = ?
            """, (name, barcode, cid, unit, price, mrp, cost, tax_bp, hsn, now_str, item_id))
        else:
            cur.execute("""
                INSERT INTO items (name, barcode, category_id, unit_kind, price_paise, mrp_paise, cost_price_paise, tax_rate_bp, stock_milli, is_active, hsn_code, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
            """, (name, barcode, cid, unit, price, mrp, cost, tax_bp, hsn, now_str))
            item_id = cur.lastrowid
            if op_stock > 0:
                cur.execute("""
                    INSERT INTO stock_movements (item_id, delta_milli, reason, ref_type, ref_id, created_at)
                    VALUES (?, ?, 'opening', NULL, NULL, ?)
                """, (item_id, op_stock, now_str))
        item_ids[barcode] = item_id

    # 5. Alternate / pack barcodes
    print("Seeding multi-barcodes...")
    multi_barcodes = [
        ("890123456001", "BOX-TG-10", 10000, "Box of 10 pcs"),
        ("619659123001", "PACK-SD-5", 5000, "5-Pack Blister"),
        ("097855123001", "PACK-MOU-5", 5000, "5-Unit Bundle"),
    ]
    for unit_barcode, alt_barcode, pack_qty, label in multi_barcodes:
        iid = item_ids.get(unit_barcode)
        if iid:
            cur.execute("""
                INSERT INTO item_barcodes (item_id, barcode, pack_qty_milli, label)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(barcode) DO UPDATE SET pack_qty_milli = excluded.pack_qty_milli, label = excluded.label
            """, (iid, alt_barcode, pack_qty, label))

    # 6. Item Batches
    print("Seeding item batches...")
    batches = [
        ("890412345001", "BT-2026-B1", "2026-08-01", "2028-08-01", 75000, 199900, 15000),
        ("619659123001", "SD-BATCH-99", "2026-06-01", "2031-06-01", 33000, 85000, 30000),
        ("740617123001", "KNG-2026-X", "2026-05-01", "2029-06-30", 48000, 120000, 25000),
    ]
    for unit_barcode, b_no, mfg, exp, cost, mrp, stock in batches:
        iid = item_ids.get(unit_barcode)
        if iid:
            cur.execute("SELECT id FROM item_batches WHERE item_id = ? AND batch_no = ?", (iid, b_no))
            if not cur.fetchone():
                cur.execute("""
                    INSERT INTO item_batches (item_id, batch_no, mfg_date, expiry_date, cost_price_paise, mrp_paise, stock_milli, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (iid, b_no, mfg, exp, cost, mrp, stock, now_str))

    # 7. Customers
    print("Seeding customers...")
    customers_data = [
        ("Karthik Raja", "9840112233", "", "15, Saradha College Rd, Salem - 636016", 150),
        ("Priya Sundaram", "9443223344", "", "7, Fairlands Main Road, Salem - 636016", 85),
        ("Apex Infotech (Suresh Kumar)", "9894001122", "33AABCA9876C1Z1", "102, Junction Main Road, Salem - 636005", 420),
        ("Vignesh Murugan", "9789123450", "", "23, Meyyanur Bypass Road, Salem - 636004", 45),
        ("Deepa Chandran", "9600123987", "", "8/12, Hasthampatti, Salem - 636007", 210),
    ]
    cust_ids = {}
    for name, phone, gstin, addr, points in customers_data:
        cur.execute("SELECT id FROM customers WHERE phone = ?", (phone,))
        row = cur.fetchone()
        if row:
            cid = row[0]
            cur.execute("""
                UPDATE customers SET name = ?, gstin = ?, address = ?, loyalty_points = ?, updated_at = ?
                WHERE id = ?
            """, (name, gstin, addr, points, now_str, cid))
        else:
            cur.execute("""
                INSERT INTO customers (name, phone, gstin, address, loyalty_points, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (name, phone, gstin, addr, points, now_str, now_str))
            cid = cur.lastrowid
            if points > 0:
                cur.execute("""
                    INSERT INTO loyalty_transactions (customer_id, bill_id, points_delta, reason, created_at)
                    VALUES (?, NULL, ?, 'Opening balance bonus', ?)
                """, (cid, points, now_str))
        cust_ids[phone] = cid

    # 8. Suppliers
    print("Seeding suppliers...")
    suppliers_data = [
        ("Redington India Ltd", "044-42243300", "33AABCR5678Q1Z9", "SPL Guindy House, 95 Mount Road, Chennai - 600032"),
        ("Supertron Electronics Pvt Ltd", "044-28345678", "33AAACS1234M1Z2", "28, Whites Road, Royapettah, Chennai - 600014"),
        ("Salem Mobile Accessories & Spares", "0427-2456789", "33AABFS3456D1Z4", "114, First Agraharam, Salem - 636001"),
    ]
    supp_ids = {}
    for s_name, s_phone, s_gstin, s_addr in suppliers_data:
        cur.execute("SELECT id FROM suppliers WHERE name = ?", (s_name,))
        row = cur.fetchone()
        if row:
            sid = row[0]
            cur.execute("""
                UPDATE suppliers SET phone = ?, gstin = ?, address = ? WHERE id = ?
            """, (s_phone, s_gstin, s_addr, sid))
        else:
            cur.execute("""
                INSERT INTO suppliers (name, phone, gstin, address, created_at)
                VALUES (?, ?, ?, ?, ?)
            """, (s_name, s_phone, s_gstin, s_addr, now_str))
            sid = cur.lastrowid
        supp_ids[s_name] = sid

    # 9. Purchases
    print("Seeding purchases...")
    redington_id = supp_ids.get("Redington India Ltd")
    if redington_id:
        p_inv = "RED/2026/0921"
        cur.execute("SELECT id FROM purchases WHERE invoice_no = ?", (p_inv,))
        if not cur.fetchone():
            p_dt = now - timedelta(days=4)
            p_date_str = p_dt.strftime("%Y-%m-%d")
            p_created = to_local_iso(p_dt)
            p_lines = [
                (item_ids["194253123456"], "Apple iPhone 17 (128GB, Midnight)", 2000, 7200000, 1800),
                (item_ids["880609123456"], "Samsung Galaxy A55 5G (8GB/128GB, Awesome Iceblue)", 4000, 2400000, 1800),
            ]
            subtot = 0
            tax = 0
            tot = 0
            for _, _, q, cost, t_bp in p_lines:
                c_net, c_tax, c_tot, _ = compute_line_amounts(cost, q, t_bp)
                subtot += c_net
                tax += c_tax
                tot += c_tot
            cur.execute("""
                INSERT INTO purchases (supplier_id, invoice_no, invoice_date, subtotal_paise, tax_paise, total_paise, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 'received', ?)
            """, (redington_id, p_inv, p_date_str, subtot, tax, tot, p_created))
            pid = cur.lastrowid
            for iid, snap, q, cost, t_bp in p_lines:
                c_net, c_tax, c_tot, _ = compute_line_amounts(cost, q, t_bp)
                cur.execute("""
                    INSERT INTO purchase_lines (purchase_id, item_id, name_snapshot, qty_milli, unit_cost_paise, tax_rate_bp, tax_paise, total_paise)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (pid, iid, snap, q, cost, t_bp, c_tax, c_tot))
                cur.execute("""
                    INSERT INTO stock_movements (item_id, delta_milli, reason, ref_type, ref_id, created_at)
                    VALUES (?, ?, 'purchase', 'purchase', ?, ?)
                """, (iid, q, str(pid), p_created))

    supertron_id = supp_ids.get("Supertron Electronics Pvt Ltd")
    if supertron_id:
        p_inv2 = "SUP/TN/4810"
        cur.execute("SELECT id FROM purchases WHERE invoice_no = ?", (p_inv2,))
        if not cur.fetchone():
            p_dt2 = now - timedelta(days=3)
            p_date_str2 = p_dt2.strftime("%Y-%m-%d")
            p_created2 = to_local_iso(p_dt2)
            p_lines2 = [
                (item_ids["890412345001"], "boAt 10000mAh Power Bank (22.5W Fast Charging)", 5000, 75000, 1800),
                (item_ids["890412345002"], "boAt Airdopes 141 Bluetooth TWS Earbuds", 6000, 78000, 1800),
                (item_ids["619659123001"], "SanDisk Ultra 64GB MicroSDXC Card (100MB/s)", 15000, 33000, 1800),
            ]
            subtot2 = 0
            tax2 = 0
            tot2 = 0
            for _, _, q, cost, t_bp in p_lines2:
                c_net, c_tax, c_tot, _ = compute_line_amounts(cost, q, t_bp)
                subtot2 += c_net
                tax2 += c_tax
                tot2 += c_tot
            cur.execute("""
                INSERT INTO purchases (supplier_id, invoice_no, invoice_date, subtotal_paise, tax_paise, total_paise, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 'received', ?)
            """, (supertron_id, p_inv2, p_date_str2, subtot2, tax2, tot2, p_created2))
            pid2 = cur.lastrowid
            for iid, snap, q, cost, t_bp in p_lines2:
                c_net, c_tax, c_tot, _ = compute_line_amounts(cost, q, t_bp)
                cur.execute("""
                    INSERT INTO purchase_lines (purchase_id, item_id, name_snapshot, qty_milli, unit_cost_paise, tax_rate_bp, tax_paise, total_paise)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (pid2, iid, snap, q, cost, t_bp, c_tax, c_tot))
                cur.execute("""
                    INSERT INTO stock_movements (item_id, delta_milli, reason, ref_type, ref_id, created_at)
                    VALUES (?, ?, 'purchase', 'purchase', ?, ?)
                """, (iid, q, str(pid2), p_created2))

    # 10. Bills
    print("Seeding sales bills across today and past days...")
    prefix = "INV-"
    cur.execute("SELECT next_no FROM invoice_counters WHERE fy = ? AND prefix = ?", (fy, prefix))
    seq_row = cur.fetchone()
    next_seq = seq_row[0] if seq_row else 1

    bills_to_create = [
        # Today's sales bills
        {
            "days_ago": 0, "h": 10, "m": 15,
            "cust_phone": "9840112233", # Karthik Raja
            "mode": "upi",
            "lines": [
                ("890412345002", "boAt Airdopes 141 Bluetooth TWS Earbuds", 1000, 129900, 1800, "85183000"),
                ("890123456001", "Tempered Glass Screen Protector (Edge-to-Edge 9H)", 1000, 29900, 1800, "70071900"),
            ]
        },
        {
            "days_ago": 0, "h": 11, "m": 20,
            "cust_phone": None, # Walk-in
            "mode": "cash",
            "lines": [
                ("097855123001", "Logitech B100 Optical USB Wired Mouse", 1000, 34900, 1800, "84716060"),
                ("890423456001", "Portronics Konnect L 1.2m Type-C to Lightning Cable", 1000, 34900, 1800, "85444299"),
            ]
        },
        {
            "days_ago": 0, "h": 12, "m": 5,
            "cust_phone": "9443223344", # Priya Sundaram
            "mode": "card",
            "lines": [
                ("880609123456", "Samsung Galaxy A55 5G (8GB/128GB, Awesome Iceblue)", 1000, 2749900, 1800, "85171300"),
                ("880981234001", "Spigen Rugged Armor Case (iPhone 17)", 1000, 129900, 1800, "39269099"),
                ("194644123001", "Anker 20W PowerPort III USB-C Fast Charger", 1000, 129900, 1800, "85044030"),
            ]
        },
        {
            "days_ago": 0, "h": 12, "m": 40,
            "cust_phone": "9894001122", # Apex Infotech
            "mode": "credit",
            "lines": [
                ("649528123001", "Crucial BX500 500GB 2.5\" SATA SSD", 2000, 289900, 1800, "84717020"),
                ("884116123001", "Dell KB216 Wired Multimedia USB Keyboard", 2000, 64900, 1800, "84716060"),
                ("693536405001", "TP-Link TL-WN725N 150Mbps Wireless N Nano USB Adapter", 2000, 49900, 1800, "85176290"),
            ]
        },
        {
            "days_ago": 0, "h": 13, "m": 10,
            "cust_phone": "9789123450", # Vignesh Murugan
            "mode": "upi",
            "lines": [
                ("692181234002", "OnePlus Bullets Wireless Z2 Neckband (Magico Black)", 1000, 169900, 1800, "85183000"),
                ("619659123001", "SanDisk Ultra 64GB MicroSDXC Card (100MB/s)", 1000, 54900, 1800, "85235100"),
            ]
        },
        {
            "days_ago": 0, "h": 13, "m": 25,
            "cust_phone": None, # Walk-in
            "mode": "cash",
            "lines": [
                ("890123456001", "Tempered Glass Screen Protector (Edge-to-Edge 9H)", 1000, 29900, 1800, "70071900"),
                ("SERV001", "Tempered Glass & UV Protector Professional Fitting", 1000, 15000, 1800, "998713"),
            ]
        },

        # Yesterday's sales bills
        {
            "days_ago": 1, "h": 10, "m": 30,
            "cust_phone": "9600123987", # Deepa Chandran
            "mode": "upi",
            "lines": [
                ("890612345001", "Noise ColorFit Pulse 2 Max Smartwatch (Deep Wine)", 1000, 159900, 1800, "85176290"),
                ("890423456001", "Portronics Konnect L 1.2m Type-C to Lightning Cable", 1000, 34900, 1800, "85444299"),
            ]
        },
        {
            "days_ago": 1, "h": 12, "m": 15,
            "cust_phone": None, # Walk-in
            "mode": "card",
            "lines": [
                ("694181234567", "Redmi Note 13 Pro 5G (8GB/256GB, Arctic White)", 1000, 2199900, 1800, "85171300"),
            ]
        },
        {
            "days_ago": 1, "h": 15, "m": 45,
            "cust_phone": None, # Walk-in
            "mode": "cash",
            "lines": [
                ("890412345001", "boAt 10000mAh Power Bank (22.5W Fast Charging)", 1000, 119900, 1800, "85044090"),
                ("694139900001", "Realme 65W SuperDart USB Type-C Cable", 1000, 49900, 1800, "85444299"),
            ]
        },
        {
            "days_ago": 1, "h": 17, "m": 20,
            "cust_phone": "9894001122", # Apex Infotech
            "mode": "credit",
            "lines": [
                ("740617123001", "Kingston DataTraveler 128GB USB 3.2 Gen 1 Flash Drive", 3000, 74900, 1800, "85235100"),
            ]
        },
        {
            "days_ago": 1, "h": 19, "m": 15,
            "cust_phone": None, # Walk-in
            "mode": "upi",
            "lines": [
                ("890123456001", "Tempered Glass Screen Protector (Edge-to-Edge 9H)", 2000, 29900, 1800, "70071900"),
            ]
        },

        # 2 days ago
        {
            "days_ago": 2, "h": 11, "m": 45,
            "cust_phone": None, # Walk-in
            "mode": "card",
            "lines": [
                ("194253123456", "Apple iPhone 17 (128GB, Midnight)", 1000, 7990000, 1800, "85171300"),
            ]
        },
        {
            "days_ago": 2, "h": 14, "m": 30,
            "cust_phone": "9840112233", # Karthik Raja
            "mode": "upi",
            "lines": [
                ("194644123001", "Anker 20W PowerPort III USB-C Fast Charger", 1000, 129900, 1800, "85044030"),
            ]
        },
    ]

    for b in bills_to_create:
        b_dt = now - timedelta(days=b["days_ago"])
        b_dt = b_dt.replace(hour=b["h"], minute=b["m"], second=0, microsecond=0)
        b_created = to_local_iso(b_dt)
        c_id = cust_ids.get(b["cust_phone"]) if b["cust_phone"] else None

        # Calculate totals
        b_subtotal = 0
        b_tax = 0
        b_total = 0
        computed_blines = []
        for barcode, snap, q, price, t_bp, hsn in b["lines"]:
            iid = item_ids[barcode]
            net, tax, tot, disc = compute_line_amounts(price, q, t_bp)
            b_subtotal += net
            b_tax += tax
            b_total += tot
            computed_blines.append((iid, snap, q, price, t_bp, tax, tot, disc, hsn))

        inv_num = f"{prefix}{str(next_seq).zfill(4)}"
        next_seq += 1

        cur.execute("""
            INSERT INTO bills (number, fy, status, customer_id, subtotal_paise, tax_paise, total_paise, created_at, discount_paise, round_off_paise, notes)
            VALUES (?, ?, 'active', ?, ?, ?, ?, ?, 0, 0, '')
        """, (inv_num, fy, c_id, b_subtotal, b_tax, b_total, b_created))
        bid = cur.lastrowid

        for idx, (iid, snap, q, price, t_bp, tax, tot, disc, hsn) in enumerate(computed_blines):
            cur.execute("""
                INSERT INTO bill_lines (bill_id, line_no, item_id, name_snapshot, qty_milli, unit_price_paise, tax_rate_bp, tax_paise, total_paise, discount_paise, hsn_code)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (bid, idx + 1, iid, snap, q, price, t_bp, tax, tot, disc, hsn))
            cur.execute("""
                INSERT INTO stock_movements (item_id, delta_milli, reason, ref_type, ref_id, created_at)
                VALUES (?, ?, 'sale', 'bill', ?, ?)
            """, (iid, -q, str(bid), b_created))

        cur.execute("""
            INSERT INTO payments (bill_id, mode, amount_paise)
            VALUES (?, ?, ?)
        """, (bid, b["mode"], b_total))

    # Update invoice_counters
    cur.execute("""
        INSERT INTO invoice_counters (fy, prefix, next_no)
        VALUES (?, ?, ?)
        ON CONFLICT(fy, prefix) DO UPDATE SET next_no = excluded.next_no
    """, (fy, prefix, next_seq))

    # 11. Customer Payments (Credit recovery)
    print("Seeding customer payments...")
    apex_id = cust_ids.get("9894001122")
    if apex_id:
        p_dt = now - timedelta(hours=2)
        cur.execute("""
            INSERT INTO customer_payments (customer_id, amount_paise, mode, notes, created_at)
            VALUES (?, 500000, 'upi', 'Bank transfer towards IT supply bill', ?)
        """, (apex_id, to_local_iso(p_dt)))

    # 12. Users
    print("Seeding users...")
    users_data = [
        ("Guna (Owner)", "owner", "1234"),
        ("Rajesh (Cashier)", "cashier", "5678"),
    ]
    for u_name, u_role, u_pin in users_data:
        cur.execute("SELECT id FROM users WHERE name = ?", (u_name,))
        if not cur.fetchone():
            cur.execute("""
                INSERT INTO users (name, role, pin, is_active, created_at)
                VALUES (?, ?, ?, 1, ?)
            """, (u_name, u_role, u_pin, now_str))

    # 13. Held bill at POS
    print("Seeding held bill...")
    cur.execute("SELECT count(*) FROM held_bills")
    if cur.fetchone()[0] == 0:
        charger_id = item_ids.get("194644123001")
        case_id = item_ids.get("880981234001")
        deepa_id = cust_ids.get("9600123987")
        if charger_id and case_id:
            lines_json = json.dumps([
                {"itemId": charger_id, "qtyMilli": 1000},
                {"itemId": case_id, "qtyMilli": 1000},
            ])
            cur.execute("""
                INSERT INTO held_bills (label, customer_id, lines_json, created_at)
                VALUES ('2 items (Deepa Chandran)', ?, ?, ?)
            """, (deepa_id, lines_json, now_str))

    # 14. Day End Closure for Yesterday
    print("Seeding day end closure...")
    yesterday = now - timedelta(days=1)
    y_str = yesterday.strftime("%Y-%m-%d")
    cur.execute("SELECT count(*) FROM day_end_closures WHERE closure_date = ?", (y_str,))
    if cur.fetchone()[0] == 0:
        cur.execute("""
            INSERT INTO day_end_closures (closure_date, user_id, opening_cash_paise, cash_sales_paise, credit_received_paise, cash_refunds_paise, expected_cash_paise, actual_cash_paise, variance_paise, total_bills_count, total_sales_paise, notes, created_at)
            VALUES (?, 2, 500000, 169800, 0, 0, 669800, 669800, 0, 5, 2854300, 'All cash matched accurately at end of day.', ?)
        """, (y_str, f"{y_str}T21:30:00.000+05:30"))

    # 15. Synchronize stock_milli in items to exact sum of stock_movements
    print("Synchronizing stock levels...")
    cur.execute("""
        UPDATE items
        SET stock_milli = (
            SELECT COALESCE(SUM(delta_milli), 0)
            FROM stock_movements
            WHERE stock_movements.item_id = items.id
        )
    """)

    conn.commit()
    conn.close()
    print("Dummy demo data successfully seeded!")

if __name__ == "__main__":
    db_file = get_db_path()
    seed_database(db_file)
