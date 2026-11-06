// SPDX-License-Identifier: Apache-2.0
import { serializeCsv } from "./csv";
import { formatPaise } from "./money";
import { formatQty } from "./quantity";
import type { ReportBill } from "./reports";

/**
 * GSTR-1 Tax Return Filing Engine.
 * Formats data according to the GST portal offline tool specifications:
 * - Table 4A: B2B Invoices (taxable supplies to registered persons)
 * - Table 7 / 5: B2C Small Invoices (intra-state consumer sales grouped by tax rate)
 * - Table 9B: Credit / Debit Notes Registered (CDNR)
 * - Table 12: HSN Summary of Outward Supplies
 */

export interface Gstr1CustomerInfo {
  gstin: string;
  name: string;
  stateCode?: string; // 2-digit state code e.g. "33" for Tamil Nadu, "27" for Maharashtra
}

export interface Gstr1CreditNoteRecord {
  number: string;
  billNumber: string;
  createdAt: string;
  customerGstin?: string;
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
  reason: string;
}

export interface Gstr1B2bRow {
  gstin: string;
  customerName: string;
  invoiceNumber: string;
  invoiceDate: string;
  invoiceValue: string;
  placeOfSupply: string;
  reverseCharge: "N" | "Y";
  ratePct: string;
  taxableValue: string;
  cessAmount: string;
}

export interface Gstr1B2csRow {
  type: string;
  placeOfSupply: string;
  ratePct: string;
  taxableValue: string;
  cessAmount: string;
}

export interface Gstr1HsnRow {
  hsnCode: string;
  description: string;
  uqc: string; // Unit Quantity Code e.g. "NOS", "KGS", "LTR"
  totalQty: string;
  totalValue: string;
  taxableValue: string;
  integratedTax: string;
  centralTax: string;
  stateTax: string;
  cess: string;
}

export interface Gstr1Dataset {
  b2bRows: Gstr1B2bRow[];
  b2csRows: Gstr1B2csRow[];
  cdnrRows: (string | number)[][];
  hsnRows: Gstr1HsnRow[];
}

export function generateGstr1Dataset(
  bills: ReportBill[],
  customersMap: Map<number, Gstr1CustomerInfo>,
  creditNotes: Gstr1CreditNoteRecord[] = [],
  shopStateCode = "33",
): Gstr1Dataset {
  const b2bRows: Gstr1B2bRow[] = [];
  const b2csRateMap = new Map<number, { taxablePaise: number; totalPaise: number }>();
  const hsnMap = new Map<
    string,
    {
      description: string;
      uqc: string;
      qtyMilli: number;
      taxablePaise: number;
      taxPaise: number;
      totalPaise: number;
    }
  >();

  for (const bill of bills) {
    if (bill.status !== "active") continue;

    // Check if customer is GST registered
    const customer = (bill as { customerId?: number }).customerId ? customersMap.get((bill as { customerId?: number }).customerId!) : undefined;
    const isB2b = Boolean(customer && customer.gstin && customer.gstin.trim().length === 15);

    const invoiceDate = bill.createdAt.slice(0, 10);
    const posState = isB2b && customer?.stateCode ? customer.stateCode : shopStateCode;

    // Aggregate lines
    for (const line of bill.lines) {
      const taxablePaise = line.totalPaise - line.taxPaise;
      const ratePct = taxablePaise > 0 ? Math.round((line.taxPaise / taxablePaise) * 100) : 0;

      if (isB2b && customer) {
        b2bRows.push({
          gstin: customer.gstin,
          customerName: customer.name,
          invoiceNumber: bill.number,
          invoiceDate,
          invoiceValue: formatPaise(bill.totalPaise),
          placeOfSupply: posState,
          reverseCharge: "N",
          ratePct: `${ratePct}%`,
          taxableValue: formatPaise(taxablePaise),
          cessAmount: "0.00",
        });
      } else {
        // B2C Small (grouped by tax rate)
        const current = b2csRateMap.get(ratePct) || { taxablePaise: 0, totalPaise: 0 };
        current.taxablePaise += taxablePaise;
        current.totalPaise += line.totalPaise;
        b2csRateMap.set(ratePct, current);
      }

      // HSN summary line
      const hsn = (line as { hsnCode?: string }).hsnCode || "9999";
      const hsnEntry = hsnMap.get(hsn) || {
        description: line.nameSnapshot,
        uqc: "NOS",
        qtyMilli: 0,
        taxablePaise: 0,
        taxPaise: 0,
        totalPaise: 0,
      };
      hsnEntry.qtyMilli += line.qtyMilli;
      hsnEntry.taxablePaise += taxablePaise;
      hsnEntry.taxPaise += line.taxPaise;
      hsnEntry.totalPaise += line.totalPaise;
      hsnMap.set(hsn, hsnEntry);
    }
  }

  const b2csRows: Gstr1B2csRow[] = Array.from(b2csRateMap.entries()).map(([rate, val]) => ({
    type: "OE", // Other than E-commerce
    placeOfSupply: shopStateCode,
    ratePct: `${rate}%`,
    taxableValue: formatPaise(val.taxablePaise),
    cessAmount: "0.00",
  }));

  const hsnRows: Gstr1HsnRow[] = Array.from(hsnMap.entries()).map(([hsn, val]) => {
    const halfTax = Math.floor(val.taxPaise / 2);
    return {
      hsnCode: hsn,
      description: val.description,
      uqc: val.uqc,
      totalQty: formatQty(val.qtyMilli),
      totalValue: formatPaise(val.totalPaise),
      taxableValue: formatPaise(val.taxablePaise),
      integratedTax: "0.00",
      centralTax: formatPaise(halfTax),
      stateTax: formatPaise(val.taxPaise - halfTax),
      cess: "0.00",
    };
  });

  const cdnrRows: (string | number)[][] = creditNotes.map((cn) => [
    cn.customerGstin || "URP",
    cn.number,
    cn.createdAt.slice(0, 10),
    cn.billNumber,
    "C", // Credit Note
    cn.reason,
    formatPaise(cn.totalPaise),
  ]);

  return { b2bRows, b2csRows, cdnrRows, hsnRows };
}

export function serializeGstr1Csvs(data: Gstr1Dataset): {
  b2bCsv: string;
  b2csCsv: string;
  cdnrCsv: string;
  hsnCsv: string;
} {
  const b2bHeader = [
    "GSTIN/UIN of Recipient",
    "Receiver Name",
    "Invoice Number",
    "Invoice date",
    "Invoice Value",
    "Place Of Supply",
    "Reverse Charge",
    "Rate",
    "Taxable Value",
    "Cess Amount",
  ];
  const b2bBody = data.b2bRows.map((r) => [
    r.gstin,
    r.customerName,
    r.invoiceNumber,
    r.invoiceDate,
    r.invoiceValue,
    r.placeOfSupply,
    r.reverseCharge,
    r.ratePct,
    r.taxableValue,
    r.cessAmount,
  ]);

  const b2csHeader = ["Type", "Place Of Supply", "Rate", "Taxable Value", "Cess Amount"];
  const b2csBody = data.b2csRows.map((r) => [
    r.type,
    r.placeOfSupply,
    r.ratePct,
    r.taxableValue,
    r.cessAmount,
  ]);

  const cdnrHeader = [
    "GSTIN/UIN",
    "Note/Refund Voucher Number",
    "Note/Refund Voucher date",
    "Invoice/Advance Receipt Number",
    "Document Type",
    "Reason For Issuing document",
    "Note/Refund Voucher Value",
  ];

  const hsnHeader = [
    "HSN",
    "Description",
    "UQC",
    "Total Quantity",
    "Total Value",
    "Taxable Value",
    "Integrated Tax Amount",
    "Central Tax Amount",
    "State/UT Tax Amount",
    "Cess Amount",
  ];
  const hsnBody = data.hsnRows.map((r) => [
    r.hsnCode,
    r.description,
    r.uqc,
    r.totalQty,
    r.totalValue,
    r.taxableValue,
    r.integratedTax,
    r.centralTax,
    r.stateTax,
    r.cess,
  ]);

  return {
    b2bCsv: serializeCsv([b2bHeader, ...b2bBody]),
    b2csCsv: serializeCsv([b2csHeader, ...b2csBody]),
    cdnrCsv: serializeCsv([cdnrHeader, ...data.cdnrRows]),
    hsnCsv: serializeCsv([hsnHeader, ...hsnBody]),
  };
}
