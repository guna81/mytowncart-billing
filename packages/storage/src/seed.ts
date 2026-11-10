// SPDX-License-Identifier: Apache-2.0
/**
 * Dummy demo data generator and seeder for MyTownCart Billing.
 * Works seamlessly across all BillingRepository implementations
 * (Tauri SQLite, In-Memory dev, and HTTP LAN server).
 */

import {
  computeLineAmounts,
  financialYearFor,
  isoDateOf,
  type PaymentMode,
  type UnitKind,
} from "@mytowncart-billing/core";
import type { BillingRepository, NewBillPayload } from "./repository";

export interface DemoCategorySeed {
  name: string;
}

export interface DemoItemSeed {
  name: string;
  categoryName: string;
  barcode: string;
  unitKind: UnitKind;
  pricePaise: number;
  mrpPaise: number;
  costPricePaise: number;
  taxRateBp: number;
  openingStockMilli: number;
  hsnCode: string;
  brand?: string;
  description?: string;
  customAttributes?: Record<string, string>;
}

export interface DemoCustomerSeed {
  name: string;
  phone: string;
  gstin?: string;
  address?: string;
  loyaltyPoints?: number;
}

export interface DemoSupplierSeed {
  name: string;
  phone: string;
  gstin: string;
  address: string;
}

export const DEMO_SHOP_PROFILE = {
  name: "GKS Mobiles and Computer",
  gstEnabled: true,
  pricesIncludeTax: true,
  invoicePrefix: "INV-",
  address: "42, Gandhi Road, Opp. Old Bus Stand, Salem - 636001, Tamil Nadu",
  phone: "+91 98765 43210",
  gstin: "33AABCG1234F1Z5",
  receiptFooter: "Thank you for shopping at GKS Mobiles & Computer! For warranty & support call +91 98765 43210.",
  lowStockThresholdMilli: 5000,
};

export const DEMO_CATEGORIES: readonly DemoCategorySeed[] = [
  { name: "Smartphones & Tablets" },
  { name: "Mobile Accessories" },
  { name: "Audio & Wearables" },
  { name: "Cables & Chargers" },
  { name: "Storage & Memory" },
  { name: "Computer Peripherals" },
  { name: "Services & Repairs" },
];

export const DEMO_ITEMS: readonly DemoItemSeed[] = [
  // Smartphones & Tablets
  {
    name: "Apple iPhone 17 (128GB, Midnight)",
    categoryName: "Smartphones & Tablets",
    barcode: "194253123456",
    unitKind: "count",
    pricePaise: 7990000,
    mrpPaise: 8290000,
    costPricePaise: 7200000,
    taxRateBp: 1800,
    openingStockMilli: 6000,
    hsnCode: "85171300",
    brand: "Apple",
    description: "6.1-inch Super Retina XDR display, A18 Bionic chip, advanced camera system.",
    customAttributes: { Storage: "128GB", Color: "Midnight", Warranty: "1 Year Apple Care" },
  },
  {
    name: "Samsung Galaxy A55 5G (8GB/128GB, Awesome Iceblue)",
    categoryName: "Smartphones & Tablets",
    barcode: "880609123456",
    unitKind: "count",
    pricePaise: 2749900,
    mrpPaise: 2999900,
    costPricePaise: 2400000,
    taxRateBp: 1800,
    openingStockMilli: 10000,
    hsnCode: "85171300",
    brand: "Samsung",
    description: "FHD+ Super AMOLED 120Hz display, 50MP triple camera with OIS.",
    customAttributes: { RAM: "8GB", Storage: "128GB", Color: "Awesome Iceblue" },
  },
  {
    name: "Redmi Note 13 Pro 5G (8GB/256GB, Arctic White)",
    categoryName: "Smartphones & Tablets",
    barcode: "694181234567",
    unitKind: "count",
    pricePaise: 2199900,
    mrpPaise: 2499900,
    costPricePaise: 1950000,
    taxRateBp: 1800,
    openingStockMilli: 12000,
    hsnCode: "85171300",
    brand: "Xiaomi",
    description: "200MP ultra-clear camera with OIS, 1.5K 120Hz AMOLED display.",
    customAttributes: { RAM: "8GB", Storage: "256GB", Color: "Arctic White" },
  },
  {
    name: "OnePlus Nord CE 4 (8GB/128GB, Celadon Marble)",
    categoryName: "Smartphones & Tablets",
    barcode: "692181234567",
    unitKind: "count",
    pricePaise: 2499900,
    mrpPaise: 2699900,
    costPricePaise: 2200000,
    taxRateBp: 1800,
    openingStockMilli: 8000,
    hsnCode: "85171300",
  },

  // Mobile Accessories
  {
    name: "Spigen Rugged Armor Case (iPhone 17)",
    categoryName: "Mobile Accessories",
    barcode: "880981234001",
    unitKind: "count",
    pricePaise: 129900,
    mrpPaise: 149900,
    costPricePaise: 75000,
    taxRateBp: 1800,
    openingStockMilli: 25000,
    hsnCode: "39269099",
  },
  {
    name: "Tempered Glass Screen Protector (Edge-to-Edge 9H)",
    categoryName: "Mobile Accessories",
    barcode: "890123456001",
    unitKind: "count",
    pricePaise: 29900,
    mrpPaise: 49900,
    costPricePaise: 8000,
    taxRateBp: 1800,
    openingStockMilli: 50000,
    hsnCode: "70071900",
  },
  {
    name: "boAt 10000mAh Power Bank (22.5W Fast Charging)",
    categoryName: "Mobile Accessories",
    barcode: "890412345001",
    unitKind: "count",
    pricePaise: 119900,
    mrpPaise: 199900,
    costPricePaise: 75000,
    taxRateBp: 1800,
    openingStockMilli: 15000,
    hsnCode: "85044090",
  },
  {
    name: "Magnetic 360° Car Dashboard Mobile Holder",
    categoryName: "Mobile Accessories",
    barcode: "890123456002",
    unitKind: "count",
    pricePaise: 49900,
    mrpPaise: 79900,
    costPricePaise: 22000,
    taxRateBp: 1800,
    openingStockMilli: 20000,
    hsnCode: "39269099",
  },

  // Audio & Wearables
  {
    name: "boAt Airdopes 141 Bluetooth TWS Earbuds",
    categoryName: "Audio & Wearables",
    barcode: "890412345002",
    unitKind: "count",
    pricePaise: 129900,
    mrpPaise: 299000,
    costPricePaise: 78000,
    taxRateBp: 1800,
    openingStockMilli: 18000,
    hsnCode: "85183000",
  },
  {
    name: "OnePlus Bullets Wireless Z2 Neckband (Magico Black)",
    categoryName: "Audio & Wearables",
    barcode: "692181234002",
    unitKind: "count",
    pricePaise: 169900,
    mrpPaise: 229900,
    costPricePaise: 125000,
    taxRateBp: 1800,
    openingStockMilli: 14000,
    hsnCode: "85183000",
  },
  {
    name: "Sony WH-CH520 Wireless Bluetooth Headphones",
    categoryName: "Audio & Wearables",
    barcode: "454873614001",
    unitKind: "count",
    pricePaise: 449000,
    mrpPaise: 499000,
    costPricePaise: 360000,
    taxRateBp: 1800,
    openingStockMilli: 4000, // Trigger low-stock alert (< 5 units)
    hsnCode: "85183000",
  },
  {
    name: "Noise ColorFit Pulse 2 Max Smartwatch (Deep Wine)",
    categoryName: "Audio & Wearables",
    barcode: "890612345001",
    unitKind: "count",
    pricePaise: 159900,
    mrpPaise: 399900,
    costPricePaise: 95000,
    taxRateBp: 1800,
    openingStockMilli: 9000,
    hsnCode: "85176290",
  },

  // Cables & Chargers
  {
    name: "Anker 20W PowerPort III USB-C Fast Charger",
    categoryName: "Cables & Chargers",
    barcode: "194644123001",
    unitKind: "count",
    pricePaise: 129900,
    mrpPaise: 149900,
    costPricePaise: 79000,
    taxRateBp: 1800,
    openingStockMilli: 22000,
    hsnCode: "85044030",
  },
  {
    name: "Portronics Konnect L 1.2m Type-C to Lightning Cable",
    categoryName: "Cables & Chargers",
    barcode: "890423456001",
    unitKind: "count",
    pricePaise: 34900,
    mrpPaise: 59900,
    costPricePaise: 14000,
    taxRateBp: 1800,
    openingStockMilli: 35000,
    hsnCode: "85444299",
  },
  {
    name: "Realme 65W SuperDart USB Type-C Cable",
    categoryName: "Cables & Chargers",
    barcode: "694139900001",
    unitKind: "count",
    pricePaise: 49900,
    mrpPaise: 79900,
    costPricePaise: 23000,
    taxRateBp: 1800,
    openingStockMilli: 16000,
    hsnCode: "85444299",
  },

  // Storage & Memory
  {
    name: "SanDisk Ultra 64GB MicroSDXC Card (100MB/s)",
    categoryName: "Storage & Memory",
    barcode: "619659123001",
    unitKind: "count",
    pricePaise: 54900,
    mrpPaise: 85000,
    costPricePaise: 33000,
    taxRateBp: 1800,
    openingStockMilli: 30000,
    hsnCode: "85235100",
  },
  {
    name: "Kingston DataTraveler 128GB USB 3.2 Gen 1 Flash Drive",
    categoryName: "Storage & Memory",
    barcode: "740617123001",
    unitKind: "count",
    pricePaise: 74900,
    mrpPaise: 120000,
    costPricePaise: 48000,
    taxRateBp: 1800,
    openingStockMilli: 25000,
    hsnCode: "85235100",
  },
  {
    name: "Crucial BX500 500GB 2.5\" SATA SSD",
    categoryName: "Storage & Memory",
    barcode: "649528123001",
    unitKind: "count",
    pricePaise: 289900,
    mrpPaise: 450000,
    costPricePaise: 220000,
    taxRateBp: 1800,
    openingStockMilli: 3000, // Trigger low-stock alert (< 5 units)
    hsnCode: "84717020",
  },

  // Computer Peripherals
  {
    name: "Logitech B100 Optical USB Wired Mouse",
    categoryName: "Computer Peripherals",
    barcode: "097855123001",
    unitKind: "count",
    pricePaise: 34900,
    mrpPaise: 42500,
    costPricePaise: 23000,
    taxRateBp: 1800,
    openingStockMilli: 28000,
    hsnCode: "84716060",
  },
  {
    name: "Dell KB216 Wired Multimedia USB Keyboard",
    categoryName: "Computer Peripherals",
    barcode: "884116123001",
    unitKind: "count",
    pricePaise: 64900,
    mrpPaise: 79900,
    costPricePaise: 44000,
    taxRateBp: 1800,
    openingStockMilli: 15000,
    hsnCode: "84716060",
  },
  {
    name: "TP-Link TL-WN725N 150Mbps Wireless N Nano USB Adapter",
    categoryName: "Computer Peripherals",
    barcode: "693536405001",
    unitKind: "count",
    pricePaise: 49900,
    mrpPaise: 69900,
    costPricePaise: 31000,
    taxRateBp: 1800,
    openingStockMilli: 12000,
    hsnCode: "85176290",
  },

  // Services & Repairs
  {
    name: "Tempered Glass & UV Protector Professional Fitting",
    categoryName: "Services & Repairs",
    barcode: "SERV001",
    unitKind: "count",
    pricePaise: 15000,
    mrpPaise: 20000,
    costPricePaise: 2000,
    taxRateBp: 1800,
    openingStockMilli: 100000,
    hsnCode: "998713",
  },
  {
    name: "Phone Data Transfer & OS Diagnostics Service",
    categoryName: "Services & Repairs",
    barcode: "SERV002",
    unitKind: "count",
    pricePaise: 35000,
    mrpPaise: 50000,
    costPricePaise: 0,
    taxRateBp: 1800,
    openingStockMilli: 100000,
    hsnCode: "998713",
  },
];

export const DEMO_CUSTOMERS: readonly DemoCustomerSeed[] = [
  {
    name: "Karthik Raja",
    phone: "9840112233",
    address: "15, Saradha College Rd, Salem - 636016",
    loyaltyPoints: 150,
  },
  {
    name: "Priya Sundaram",
    phone: "9443223344",
    address: "7, Fairlands Main Road, Salem - 636016",
    loyaltyPoints: 85,
  },
  {
    name: "Apex Infotech (Suresh Kumar)",
    phone: "9894001122",
    gstin: "33AABCA9876C1Z1",
    address: "102, Junction Main Road, Salem - 636005",
    loyaltyPoints: 420,
  },
  {
    name: "Vignesh Murugan",
    phone: "9789123450",
    address: "23, Meyyanur Bypass Road, Salem - 636004",
    loyaltyPoints: 45,
  },
  {
    name: "Deepa Chandran",
    phone: "9600123987",
    address: "8/12, Hasthampatti, Salem - 636007",
    loyaltyPoints: 210,
  },
];

export const DEMO_SUPPLIERS: readonly DemoSupplierSeed[] = [
  {
    name: "Redington India Ltd",
    phone: "044-42243300",
    gstin: "33AABCR5678Q1Z9",
    address: "SPL Guindy House, 95 Mount Road, Chennai - 600032",
  },
  {
    name: "Supertron Electronics Pvt Ltd",
    phone: "044-28345678",
    gstin: "33AAACS1234M1Z2",
    address: "28, Whites Road, Royapettah, Chennai - 600014",
  },
  {
    name: "Salem Mobile Accessories & Spares",
    phone: "0427-2456789",
    gstin: "33AABFS3456D1Z4",
    address: "114, First Agraharam, Salem - 636001",
  },
];

export interface SeedSummary {
  categoriesCount: number;
  itemsCount: number;
  customersCount: number;
  suppliersCount: number;
  purchasesCount: number;
  billsCount: number;
  usersCount: number;
}

/**
 * Format a Date object as a local ISO timestamp string: YYYY-MM-DDTHH:MM:SS.mmm+05:30.
 */
function toLocalIso(d: Date): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const offH = pad(Math.trunc(offset / 60));
  const offM = pad(offset % 60);
  return `${y}-${m}-${day}T${hh}:${mm}:${ss}.${ms}${sign}${offH}:${offM}`;
}

/**
 * Build a bill payload with exact line taxes and totals matching core tax rules.
 */
function buildBillPayload(params: {
  fy: string;
  prefix: string;
  customerId: number | null;
  createdAt: string;
  lines: {
    itemId: number;
    nameSnapshot: string;
    qtyMilli: number;
    unitPricePaise: number;
    taxRateBp: number;
    hsnCode: string;
    discountPaise?: number;
  }[];
  paymentMode: PaymentMode;
  notes?: string;
}): NewBillPayload {
  const { fy, prefix, customerId, createdAt, lines, paymentMode, notes } = params;
  let totalNetPaise = 0;
  let totalTaxPaise = 0;
  let totalGrossPaise = 0;

  const computedLines = lines.map((l) => {
    const amounts = computeLineAmounts({
      qtyMilli: l.qtyMilli,
      unitPricePaise: l.unitPricePaise,
      taxRateBp: l.taxRateBp,
      pricesIncludeTax: true,
      discountPaise: l.discountPaise ?? 0,
    });
    totalNetPaise += amounts.netPaise;
    totalTaxPaise += amounts.taxPaise;
    totalGrossPaise += amounts.totalPaise;
    return {
      itemId: l.itemId,
      nameSnapshot: l.nameSnapshot,
      qtyMilli: l.qtyMilli,
      unitPricePaise: l.unitPricePaise,
      taxRateBp: l.taxRateBp,
      taxPaise: amounts.taxPaise,
      totalPaise: amounts.totalPaise,
      discountPaise: amounts.discountPaise,
      hsnCode: l.hsnCode,
    };
  });

  return {
    fy,
    prefix,
    customerId,
    subtotalPaise: totalNetPaise,
    taxPaise: totalTaxPaise,
    totalPaise: totalGrossPaise,
    discountPaise: 0,
    roundOffPaise: 0,
    notes: notes ?? "",
    createdAt,
    lines: computedLines,
    payments: [{ mode: paymentMode, amountPaise: totalGrossPaise }],
  };
}

/**
 * Seed demo data into the given BillingRepository instance.
 */
export async function seedDemoData(
  repo: BillingRepository,
  options?: { dateAnchor?: Date },
): Promise<SeedSummary> {
  const anchor = options?.dateAnchor ?? new Date();
  const todayStr = isoDateOf(anchor);
  const fy = financialYearFor(todayStr);

  // 1. Shop profile
  await repo.saveShopProfile(DEMO_SHOP_PROFILE);

  // 2. Categories
  const categoryMap = new Map<string, number>();
  for (const cat of DEMO_CATEGORIES) {
    const id = await repo.upsertCategory({ name: cat.name });
    categoryMap.set(cat.name, id);
  }

  // 3. Items
  const itemMap = new Map<string, number>(); // barcode -> itemId
  for (const item of DEMO_ITEMS) {
    const categoryId = categoryMap.get(item.categoryName) ?? null;
    const id = await repo.upsertItem({
      name: item.name,
      barcode: item.barcode,
      categoryId,
      unitKind: item.unitKind,
      pricePaise: item.pricePaise,
      mrpPaise: item.mrpPaise,
      costPricePaise: item.costPricePaise,
      taxRateBp: item.taxRateBp,
      openingStockMilli: item.openingStockMilli,
      isActive: true,
      hsnCode: item.hsnCode,
      brand: item.brand,
      description: item.description,
      customAttributes: item.customAttributes,
    });
    itemMap.set(item.barcode, id);
  }

  // 4. Multi-barcodes / pack barcodes
  const tgId = itemMap.get("890123456001");
  if (tgId) {
    await repo.upsertItemBarcode(tgId, "BOX-TG-10", 10000, "Box of 10 pcs");
  }
  const sdId = itemMap.get("619659123001");
  if (sdId) {
    await repo.upsertItemBarcode(sdId, "PACK-SD-5", 5000, "5-Pack Blister");
  }
  const mouseId = itemMap.get("097855123001");
  if (mouseId) {
    await repo.upsertItemBarcode(mouseId, "PACK-MOU-5", 5000, "5-Unit Bundle");
  }

  // 5. Item Batches
  const powerbankId = itemMap.get("890412345001");
  if (powerbankId) {
    await repo.upsertBatch({
      itemId: powerbankId,
      batchNo: "BT-2026-B1",
      mfgDate: "2026-08-01",
      expiryDate: "2028-08-01",
      costPricePaise: 75000,
      mrpPaise: 199900,
      stockMilli: 15000,
    });
  }
  if (sdId) {
    await repo.upsertBatch({
      itemId: sdId,
      batchNo: "SD-BATCH-99",
      mfgDate: "2026-06-01",
      expiryDate: "2031-06-01",
      costPricePaise: 33000,
      mrpPaise: 85000,
      stockMilli: 30000,
    });
  }

  // 6. Customers
  const customerIds: number[] = [];
  for (const c of DEMO_CUSTOMERS) {
    const id = await repo.upsertCustomer({
      name: c.name,
      phone: c.phone,
      gstin: c.gstin ?? "",
      address: c.address ?? "",
    });
    if (c.loyaltyPoints && c.loyaltyPoints > 0) {
      await repo.updateCustomerLoyalty(id, c.loyaltyPoints, null, "Opening balance bonus");
    }
    customerIds.push(id);
  }

  // 7. Suppliers
  const supplierIds: number[] = [];
  for (const s of DEMO_SUPPLIERS) {
    const id = await repo.upsertSupplier({
      name: s.name,
      phone: s.phone,
      gstin: s.gstin,
      address: s.address,
    });
    supplierIds.push(id);
  }

  // 8. Purchases (Receiving incoming inventory)
  let purchasesCount = 0;
  if (supplierIds[0] && itemMap.get("194253123456") && itemMap.get("880609123456")) {
    const pDate = new Date(anchor.getTime() - 4 * 86400000);
    await repo.createPurchase({
      supplierId: supplierIds[0],
      invoiceNo: "RED/2026/0921",
      invoiceDate: isoDateOf(pDate),
      createdAt: toLocalIso(pDate),
      lines: [
        {
          itemId: itemMap.get("194253123456")!,
          nameSnapshot: "Apple iPhone 17 (128GB, Midnight)",
          qtyMilli: 2000,
          unitCostPaise: 7200000,
          taxRateBp: 1800,
        },
        {
          itemId: itemMap.get("880609123456")!,
          nameSnapshot: "Samsung Galaxy A55 5G (8GB/128GB, Awesome Iceblue)",
          qtyMilli: 4000,
          unitCostPaise: 2400000,
          taxRateBp: 1800,
        },
      ],
    });
    purchasesCount++;
  }

  if (supplierIds[1] && itemMap.get("890412345001") && itemMap.get("890412345002")) {
    const pDate2 = new Date(anchor.getTime() - 3 * 86400000);
    await repo.createPurchase({
      supplierId: supplierIds[1],
      invoiceNo: "SUP/TN/4810",
      invoiceDate: isoDateOf(pDate2),
      createdAt: toLocalIso(pDate2),
      lines: [
        {
          itemId: itemMap.get("890412345001")!,
          nameSnapshot: "boAt 10000mAh Power Bank (22.5W Fast Charging)",
          qtyMilli: 5000,
          unitCostPaise: 75000,
          taxRateBp: 1800,
        },
        {
          itemId: itemMap.get("890412345002")!,
          nameSnapshot: "boAt Airdopes 141 Bluetooth TWS Earbuds",
          qtyMilli: 6000,
          unitCostPaise: 78000,
          taxRateBp: 1800,
        },
      ],
    });
    purchasesCount++;
  }

  // 9. Sales Bills (Multi-day distribution: Today, Yesterday, 2 days ago)
  let billsCount = 0;
  const prefix = DEMO_SHOP_PROFILE.invoicePrefix;

  // Helper date creators
  const makeDate = (daysAgo: number, hours: number, minutes: number) => {
    const d = new Date(anchor);
    d.setDate(d.getDate() - daysAgo);
    d.setHours(hours, minutes, 0, 0);
    return toLocalIso(d);
  };

  // --- Today's sales bills (anchor day) ---
  // Bill 1: 10:15 AM - Karthik Raja (boAt Airdopes + Tempered Glass = UPI)
  if (itemMap.get("890412345002") && itemMap.get("890123456001")) {
    await repo.createBill(
      buildBillPayload({
        fy,
        prefix,
        customerId: customerIds[0] ?? null,
        createdAt: makeDate(0, 10, 15),
        paymentMode: "upi",
        lines: [
          {
            itemId: itemMap.get("890412345002")!,
            nameSnapshot: "boAt Airdopes 141 Bluetooth TWS Earbuds",
            qtyMilli: 1000,
            unitPricePaise: 129900,
            taxRateBp: 1800,
            hsnCode: "85183000",
          },
          {
            itemId: itemMap.get("890123456001")!,
            nameSnapshot: "Tempered Glass Screen Protector (Edge-to-Edge 9H)",
            qtyMilli: 1000,
            unitPricePaise: 29900,
            taxRateBp: 1800,
            hsnCode: "70071900",
          },
        ],
      }),
    );
    billsCount++;
  }

  // Bill 2: 11:20 AM - Walk-in customer (Logitech Mouse + Portronics Cable = Cash)
  if (itemMap.get("097855123001") && itemMap.get("890423456001")) {
    await repo.createBill(
      buildBillPayload({
        fy,
        prefix,
        customerId: null,
        createdAt: makeDate(0, 11, 20),
        paymentMode: "cash",
        lines: [
          {
            itemId: itemMap.get("097855123001")!,
            nameSnapshot: "Logitech B100 Optical USB Wired Mouse",
            qtyMilli: 1000,
            unitPricePaise: 34900,
            taxRateBp: 1800,
            hsnCode: "84716060",
          },
          {
            itemId: itemMap.get("890423456001")!,
            nameSnapshot: "Portronics Konnect L 1.2m Type-C to Lightning Cable",
            qtyMilli: 1000,
            unitPricePaise: 34900,
            taxRateBp: 1800,
            hsnCode: "85444299",
          },
        ],
      }),
    );
    billsCount++;
  }

  // Bill 3: 12:05 PM - Priya Sundaram (Samsung Galaxy A55 + Spigen Case + Anker Charger = Card)
  if (itemMap.get("880609123456") && itemMap.get("880981234001") && itemMap.get("194644123001")) {
    await repo.createBill(
      buildBillPayload({
        fy,
        prefix,
        customerId: customerIds[1] ?? null,
        createdAt: makeDate(0, 12, 5),
        paymentMode: "card",
        lines: [
          {
            itemId: itemMap.get("880609123456")!,
            nameSnapshot: "Samsung Galaxy A55 5G (8GB/128GB, Awesome Iceblue)",
            qtyMilli: 1000,
            unitPricePaise: 2749900,
            taxRateBp: 1800,
            hsnCode: "85171300",
          },
          {
            itemId: itemMap.get("880981234001")!,
            nameSnapshot: "Spigen Rugged Armor Case (iPhone 17)",
            qtyMilli: 1000,
            unitPricePaise: 129900,
            taxRateBp: 1800,
            hsnCode: "39269099",
          },
          {
            itemId: itemMap.get("194644123001")!,
            nameSnapshot: "Anker 20W PowerPort III USB-C Fast Charger",
            qtyMilli: 1000,
            unitPricePaise: 129900,
            taxRateBp: 1800,
            hsnCode: "85044030",
          },
        ],
      }),
    );
    billsCount++;
  }

  // Bill 4: 12:40 PM - Apex Infotech (2x Crucial SSD + 2x Dell Keyboard + 2x TP-Link Wi-Fi = Credit)
  if (itemMap.get("649528123001") && itemMap.get("884116123001") && itemMap.get("693536405001")) {
    await repo.createBill(
      buildBillPayload({
        fy,
        prefix,
        customerId: customerIds[2] ?? null,
        createdAt: makeDate(0, 12, 40),
        paymentMode: "credit",
        notes: "Office upgrade order; payment expected next week.",
        lines: [
          {
            itemId: itemMap.get("649528123001")!,
            nameSnapshot: "Crucial BX500 500GB 2.5\" SATA SSD",
            qtyMilli: 2000,
            unitPricePaise: 289900,
            taxRateBp: 1800,
            hsnCode: "84717020",
          },
          {
            itemId: itemMap.get("884116123001")!,
            nameSnapshot: "Dell KB216 Wired Multimedia USB Keyboard",
            qtyMilli: 2000,
            unitPricePaise: 64900,
            taxRateBp: 1800,
            hsnCode: "84716060",
          },
          {
            itemId: itemMap.get("693536405001")!,
            nameSnapshot: "TP-Link TL-WN725N 150Mbps Wireless N Nano USB Adapter",
            qtyMilli: 2000,
            unitPricePaise: 49900,
            taxRateBp: 1800,
            hsnCode: "85176290",
          },
        ],
      }),
    );
    billsCount++;
  }

  // Bill 5: 01:10 PM - Vignesh Murugan (OnePlus Bullets Z2 + SanDisk 64GB = UPI)
  if (itemMap.get("692181234002") && itemMap.get("619659123001")) {
    await repo.createBill(
      buildBillPayload({
        fy,
        prefix,
        customerId: customerIds[3] ?? null,
        createdAt: makeDate(0, 13, 10),
        paymentMode: "upi",
        lines: [
          {
            itemId: itemMap.get("692181234002")!,
            nameSnapshot: "OnePlus Bullets Wireless Z2 Neckband (Magico Black)",
            qtyMilli: 1000,
            unitPricePaise: 169900,
            taxRateBp: 1800,
            hsnCode: "85183000",
          },
          {
            itemId: itemMap.get("619659123001")!,
            nameSnapshot: "SanDisk Ultra 64GB MicroSDXC Card (100MB/s)",
            qtyMilli: 1000,
            unitPricePaise: 54900,
            taxRateBp: 1800,
            hsnCode: "85235100",
          },
        ],
      }),
    );
    billsCount++;
  }

  // Bill 6: 01:25 PM - Walk-in (Tempered Glass + Screen Fitting Service = Cash)
  if (itemMap.get("890123456001") && itemMap.get("SERV001")) {
    await repo.createBill(
      buildBillPayload({
        fy,
        prefix,
        customerId: null,
        createdAt: makeDate(0, 13, 25),
        paymentMode: "cash",
        lines: [
          {
            itemId: itemMap.get("890123456001")!,
            nameSnapshot: "Tempered Glass Screen Protector (Edge-to-Edge 9H)",
            qtyMilli: 1000,
            unitPricePaise: 29900,
            taxRateBp: 1800,
            hsnCode: "70071900",
          },
          {
            itemId: itemMap.get("SERV001")!,
            nameSnapshot: "Tempered Glass & UV Protector Professional Fitting",
            qtyMilli: 1000,
            unitPricePaise: 15000,
            taxRateBp: 1800,
            hsnCode: "998713",
          },
        ],
      }),
    );
    billsCount++;
  }

  // --- Yesterday's sales bills (1 day ago) ---
  if (itemMap.get("890612345001") && itemMap.get("890423456001")) {
    await repo.createBill(
      buildBillPayload({
        fy,
        prefix,
        customerId: customerIds[4] ?? null,
        createdAt: makeDate(1, 10, 30),
        paymentMode: "upi",
        lines: [
          {
            itemId: itemMap.get("890612345001")!,
            nameSnapshot: "Noise ColorFit Pulse 2 Max Smartwatch (Deep Wine)",
            qtyMilli: 1000,
            unitPricePaise: 159900,
            taxRateBp: 1800,
            hsnCode: "85176290",
          },
          {
            itemId: itemMap.get("890423456001")!,
            nameSnapshot: "Portronics Konnect L 1.2m Type-C to Lightning Cable",
            qtyMilli: 1000,
            unitPricePaise: 34900,
            taxRateBp: 1800,
            hsnCode: "85444299",
          },
        ],
      }),
    );
    billsCount++;
  }

  if (itemMap.get("694181234567")) {
    await repo.createBill(
      buildBillPayload({
        fy,
        prefix,
        customerId: null,
        createdAt: makeDate(1, 12, 15),
        paymentMode: "card",
        lines: [
          {
            itemId: itemMap.get("694181234567")!,
            nameSnapshot: "Redmi Note 13 Pro 5G (8GB/256GB, Arctic White)",
            qtyMilli: 1000,
            unitPricePaise: 2199900,
            taxRateBp: 1800,
            hsnCode: "85171300",
          },
        ],
      }),
    );
    billsCount++;
  }

  if (itemMap.get("890412345001") && itemMap.get("694139900001")) {
    await repo.createBill(
      buildBillPayload({
        fy,
        prefix,
        customerId: null,
        createdAt: makeDate(1, 15, 45),
        paymentMode: "cash",
        lines: [
          {
            itemId: itemMap.get("890412345001")!,
            nameSnapshot: "boAt 10000mAh Power Bank (22.5W Fast Charging)",
            qtyMilli: 1000,
            unitPricePaise: 119900,
            taxRateBp: 1800,
            hsnCode: "85044090",
          },
          {
            itemId: itemMap.get("694139900001")!,
            nameSnapshot: "Realme 65W SuperDart USB Type-C Cable",
            qtyMilli: 1000,
            unitPricePaise: 49900,
            taxRateBp: 1800,
            hsnCode: "85444299",
          },
        ],
      }),
    );
    billsCount++;
  }

  if (itemMap.get("740617123001")) {
    await repo.createBill(
      buildBillPayload({
        fy,
        prefix,
        customerId: customerIds[2] ?? null,
        createdAt: makeDate(1, 17, 20),
        paymentMode: "credit",
        lines: [
          {
            itemId: itemMap.get("740617123001")!,
            nameSnapshot: "Kingston DataTraveler 128GB USB 3.2 Gen 1 Flash Drive",
            qtyMilli: 3000,
            unitPricePaise: 74900,
            taxRateBp: 1800,
            hsnCode: "85235100",
          },
        ],
      }),
    );
    billsCount++;
  }

  // --- Sales from 2 days ago ---
  if (itemMap.get("194253123456")) {
    await repo.createBill(
      buildBillPayload({
        fy,
        prefix,
        customerId: null,
        createdAt: makeDate(2, 11, 45),
        paymentMode: "card",
        lines: [
          {
            itemId: itemMap.get("194253123456")!,
            nameSnapshot: "Apple iPhone 17 (128GB, Midnight)",
            qtyMilli: 1000,
            unitPricePaise: 7990000,
            taxRateBp: 1800,
            hsnCode: "85171300",
          },
        ],
      }),
    );
    billsCount++;
  }

  // 10. Customer payment (Apex Infotech paid ₹5,000 credit recovery)
  if (customerIds[2]) {
    await repo.recordCustomerPayment({
      customerId: customerIds[2],
      amountPaise: 500000,
      mode: "upi",
      notes: "Bank transfer towards IT hardware supply bill",
      createdAt: makeDate(0, 11, 45),
    });
  }

  // 11. Users (Owner & Cashier)
  let usersCount = 0;
  await repo.upsertUser({
    name: "Guna (Owner)",
    role: "owner",
    pin: "1234",
    isActive: true,
  });
  usersCount++;

  await repo.upsertUser({
    name: "Rajesh (Cashier)",
    role: "cashier",
    pin: "5678",
    isActive: true,
  });
  usersCount++;

  // 12. Held Bill at POS (parked sale)
  const chargerId = itemMap.get("194644123001");
  const caseId = itemMap.get("880981234001");
  if (chargerId && caseId) {
    await repo.saveHeldBill({
      label: "2 items (Deepa Chandran)",
      customerId: customerIds[4] ?? null,
      lines: [
        { itemId: chargerId, qtyMilli: 1000 },
        { itemId: caseId, qtyMilli: 1000 },
      ],
    });
  }

  // 13. Day-end closure for Yesterday
  const yesterdayDate = new Date(anchor);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yStr = isoDateOf(yesterdayDate);

  await repo.createDayEndClosure({
    closureDate: yStr,
    userId: 2, // Rajesh
    openingCashPaise: 500000,
    cashSalesPaise: 169800,
    creditReceivedPaise: 0,
    cashRefundsPaise: 0,
    expectedCashPaise: 669800,
    actualCashPaise: 669800,
    variancePaise: 0,
    totalBillsCount: 4,
    totalSalesPaise: 2794500,
    notes: "Day-end cash reconciled accurately. Drawer closed with ₹6,698.",
    createdAt: `${yStr}T21:30:00+05:30`,
  });

  return {
    categoriesCount: DEMO_CATEGORIES.length,
    itemsCount: DEMO_ITEMS.length,
    customersCount: DEMO_CUSTOMERS.length,
    suppliersCount: DEMO_SUPPLIERS.length,
    purchasesCount,
    billsCount,
    usersCount,
  };
}
