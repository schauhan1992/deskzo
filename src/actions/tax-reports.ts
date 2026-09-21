"use server";

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { toPlain } from "@/lib/serialize";
import { hasEffectivePermission } from "@/actions/permission";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/chart";
import { buildCashFlow, type AccountMovement } from "@/lib/ledger/cashflow";
import { buildGstr1, buildGstr3b, buildTdsSummary, type ReturnDocument } from "@/lib/ledger/gst-returns";
import { profitAndLoss } from "@/actions/ledger-reports";

/**
 * The statutory returns and the cash flow statement.
 *
 * All read-only, all built from documents and the ledger that are already there — nothing here
 * stores a return. A filed return is a statement made to the government on a day; re-deriving it
 * from the same documents gives the same answer, and storing a copy would only create a second
 * version to disagree with.
 */

async function requireAccounts() {
  const user = await requireUser();
  const allowed = await hasEffectivePermission(user.id, "payments.manage");
  return { user, allowed };
}

function monthBounds(month: number, year: number) {
  return {
    from: new Date(Date.UTC(year, month - 1, 1, 0, 0, 0)),
    to: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)),
  };
}

const documentSelect = {
  docNumber: true,
  docType: true,
  issueDate: true,
  status: true,
  placeOfSupplyCode: true,
  taxableValue: true,
  cgstAmount: true,
  sgstAmount: true,
  igstAmount: true,
  withholdingAmount: true,
  total: true,
  /**
   * The buyer's GSTIN as it was on the document, not as the company record reads today.
   *
   * A return is a statement about what was supplied on a date, and the customer's registration can
   * change afterwards — filing this month's return with next year's GSTIN would break the match
   * against the buyer's own credit.
   */
  buyerGstin: true,
  company: { select: { name: true, panNumber: true } },
  lines: {
    select: {
      hsnCode: true,
      name: true,
      unit: true,
      quantity: true,
      taxableValue: true,
      taxRatePercent: true,
      cgstAmount: true,
      sgstAmount: true,
      igstAmount: true,
    },
  },
} satisfies Prisma.TradeDocumentSelect;

type RawDoc = {
  docNumber: string;
  docType: string;
  issueDate: Date;
  status: string;
  placeOfSupplyCode: string | null;
  buyerGstin: string | null;
  taxableValue: unknown;
  cgstAmount: unknown;
  sgstAmount: unknown;
  igstAmount: unknown;
  total: unknown;
  company: { name: string; panNumber: string | null };
  lines: {
    hsnCode: string | null;
    name: string;
    unit: string | null;
    quantity: unknown;
    taxableValue: unknown;
    taxRatePercent: unknown;
    cgstAmount: unknown;
    sgstAmount: unknown;
    igstAmount: unknown;
  }[];
};

function toReturnDocument(d: RawDoc): ReturnDocument {
  return {
    docNumber: d.docNumber,
    docType: d.docType as ReturnDocument["docType"],
    issueDate: d.issueDate,
    status: d.status,
    partyName: d.company.name,
    partyGstin: d.buyerGstin,
    placeOfSupplyCode: d.placeOfSupplyCode,
    taxableValue: Number(d.taxableValue),
    cgstAmount: Number(d.cgstAmount),
    sgstAmount: Number(d.sgstAmount),
    igstAmount: Number(d.igstAmount),
    total: Number(d.total),
    lines: d.lines.map((l) => ({
      hsnCode: l.hsnCode,
      name: l.name,
      unit: l.unit,
      quantity: Number(l.quantity),
      taxableValue: Number(l.taxableValue),
      taxRatePercent: Number(l.taxRatePercent),
      cgstAmount: Number(l.cgstAmount),
      sgstAmount: Number(l.sgstAmount),
      igstAmount: Number(l.igstAmount),
    })),
  };
}

// ─── GSTR-1 ───────────────────────────────────────────────────────────────────

export async function gstr1(params: { month: number; year: number }) {
  const { allowed } = await requireAccounts();
  if (!allowed) return null;

  const { from, to } = monthBounds(params.month, params.year);
  const docs = await db.tradeDocument.findMany({
    where: { docType: { in: ["INVOICE", "CREDIT_NOTE"] }, issueDate: { gte: from, lte: to } },
    orderBy: { issueDate: "asc" },
    select: documentSelect,
  });

  return toPlain({
    month: params.month,
    year: params.year,
    from,
    to,
    ...buildGstr1(docs.map((d) => toReturnDocument(d as unknown as RawDoc))),
  });
}

// ─── GSTR-3B ──────────────────────────────────────────────────────────────────

export async function gstr3b(params: { month: number; year: number }) {
  const { allowed } = await requireAccounts();
  if (!allowed) return null;

  const { from, to } = monthBounds(params.month, params.year);
  const [outward, inward, ledger] = await Promise.all([
    db.tradeDocument.findMany({
      where: { docType: { in: ["INVOICE", "CREDIT_NOTE"] }, issueDate: { gte: from, lte: to } },
      select: documentSelect,
    }),
    db.tradeDocument.findMany({
      where: { docType: "BILL", issueDate: { gte: from, lte: to } },
      select: documentSelect,
    }),
    ledgerTaxTotals(from, to),
  ]);

  return toPlain({
    month: params.month,
    year: params.year,
    from,
    to,
    ...buildGstr3b({
      outwardDocs: outward.map((d) => toReturnDocument(d as unknown as RawDoc)),
      inwardDocs: inward.map((d) => toReturnDocument(d as unknown as RawDoc)),
      ledger,
    }),
  });
}

/**
 * What the ledger's own GST accounts moved by over the period.
 *
 * This is what makes the 3B checkable. A return built only from documents can be internally perfect
 * and still disagree with the books — an expense claim carrying input tax, a manual journal on a GST
 * account, an invoice that never posted. Filing a figure the ledger cannot support is precisely what
 * an audit looks for.
 */
async function ledgerTaxTotals(from: Date, to: Date) {
  const accounts = await db.ledgerAccount.findMany({
    where: {
      systemKey: {
        in: [
          SYSTEM_ACCOUNTS.OUTPUT_CGST,
          SYSTEM_ACCOUNTS.OUTPUT_SGST,
          SYSTEM_ACCOUNTS.OUTPUT_IGST,
          SYSTEM_ACCOUNTS.INPUT_CGST,
          SYSTEM_ACCOUNTS.INPUT_SGST,
          SYSTEM_ACCOUNTS.INPUT_IGST,
        ],
      },
    },
    select: { id: true, systemKey: true },
  });
  if (accounts.length === 0) return null;

  const sums = await db.journalLine.groupBy({
    by: ["accountId"],
    where: { accountId: { in: accounts.map((a) => a.id) }, entry: { date: { gte: from, lte: to } } },
    _sum: { debit: true, credit: true },
  });

  const value = (key: string, natural: "debit" | "credit") => {
    const account = accounts.find((a) => a.systemKey === key);
    if (!account) return 0;
    const row = sums.find((s) => s.accountId === account.id);
    const debit = Number(row?._sum.debit ?? 0);
    const credit = Number(row?._sum.credit ?? 0);
    return Math.round((natural === "credit" ? credit - debit : debit - credit) * 100) / 100;
  };

  return {
    // Output tax is collected, so it sits on the credit side; input tax is reclaimable, so debit.
    outputCgst: value(SYSTEM_ACCOUNTS.OUTPUT_CGST, "credit"),
    outputSgst: value(SYSTEM_ACCOUNTS.OUTPUT_SGST, "credit"),
    outputIgst: value(SYSTEM_ACCOUNTS.OUTPUT_IGST, "credit"),
    inputCgst: value(SYSTEM_ACCOUNTS.INPUT_CGST, "debit"),
    inputSgst: value(SYSTEM_ACCOUNTS.INPUT_SGST, "debit"),
    inputIgst: value(SYSTEM_ACCOUNTS.INPUT_IGST, "debit"),
  };
}

// ─── TDS ──────────────────────────────────────────────────────────────────────

export async function tdsSummary(params: { month: number; year: number }) {
  const { allowed } = await requireAccounts();
  if (!allowed) return null;

  const { from, to } = monthBounds(params.month, params.year);
  const docs = await db.tradeDocument.findMany({
    where: {
      docType: { in: ["INVOICE", "BILL"] },
      issueDate: { gte: from, lte: to },
      withholdingAmount: { not: 0 },
    },
    select: { ...documentSelect, withholdingAmount: true },
  });

  const withholdings = docs
    .filter((d) => d.status !== "DRAFT" && d.status !== "CANCELLED")
    .map((d) => ({
      docNumber: d.docNumber,
      issueDate: d.issueDate,
      partyName: d.company.name,
      partyPan: d.company.panNumber,
      taxableValue: Number(d.taxableValue),
      withholdingAmount: Number(d.withholdingAmount),
      isPurchase: d.docType === "BILL",
    }));

  return toPlain({
    month: params.month,
    year: params.year,
    from,
    to,
    ...buildTdsSummary({
      docs: docs.map((d) => toReturnDocument(d as unknown as RawDoc)),
      withholdings,
      month: params.month,
      year: params.year,
    }),
  });
}

// ─── Cash flow ────────────────────────────────────────────────────────────────

/**
 * The cash flow statement for a period.
 *
 * Movements are read per account rather than per section, so the classification lives in one pure
 * function that can be checked — see src/lib/ledger/cashflow.ts.
 */
export async function cashFlow(params: { from: string; to: string }) {
  await requireUser();
  const from = new Date(`${params.from}T00:00:00.000Z`);
  const to = new Date(`${params.to}T23:59:59.999Z`);

  const accounts = await db.ledgerAccount.findMany({
    where: { isGroup: false },
    select: { id: true, code: true, name: true, type: true, systemKey: true },
  });

  const [openingSums, periodSums, pl, depreciation] = await Promise.all([
    db.journalLine.groupBy({
      by: ["accountId"],
      where: { entry: { date: { lt: from } } },
      _sum: { debit: true, credit: true },
    }),
    db.journalLine.groupBy({
      by: ["accountId"],
      where: { entry: { date: { gte: from, lte: to } } },
      _sum: { debit: true, credit: true },
    }),
    profitAndLoss({ from: params.from, to: params.to }),
    db.depreciationCharge.aggregate({
      where: { toDate: { gte: from, lte: to } },
      _sum: { amount: true },
    }),
  ]);

  const movements: AccountMovement[] = accounts.map((a) => {
    const natural = a.type === "ASSET" || a.type === "EXPENSE" ? 1 : -1;
    const at = (rows: typeof openingSums) => {
      const row = rows.find((r) => r.accountId === a.id);
      const debit = Number(row?._sum.debit ?? 0);
      const credit = Number(row?._sum.credit ?? 0);
      return Math.round((debit - credit) * natural * 100) / 100;
    };
    const opening = at(openingSums);
    const movement = at(periodSums);
    return {
      accountId: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      systemKey: a.systemKey,
      opening,
      movement,
      closing: Math.round((opening + movement) * 100) / 100,
    };
  });

  return toPlain(
    buildCashFlow({
      from,
      to,
      netProfit: pl.netProfit,
      movements,
      depreciationCharged: Number(depreciation._sum.amount ?? 0),
    }),
  );
}
