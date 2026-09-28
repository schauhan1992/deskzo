"use server";

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { hasEffectivePermission } from "@/actions/permission";
import { can } from "@/lib/authz/resolve";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/chart";
import { buildCashFlow, type AccountMovement } from "@/lib/ledger/cashflow";
import { buildGstr1, buildGstr3b, buildTdsSummary, type ReturnDocument } from "@/lib/ledger/gst-returns";
import { profitAndLoss } from "@/actions/ledger-reports";
import { endOfIndianDay, istMidnight, startOfIndianDay } from "@/lib/india-time";
import { listRegistrationChoices } from "@/lib/branches/identity";
import type { RegistrationChoice } from "@/lib/branches/format";

/**
 * The statutory returns and the cash flow statement.
 *
 * All read-only, all built from documents and the ledger that are already there — nothing here
 * stores a return. A filed return is a statement made to the government on a day; re-deriving it
 * from the same documents gives the same answer, and storing a copy would only create a second
 * version to disagree with.
 */

async function requireAccounts() {
  const user = await requireModuleUser("accounting");
  const allowed = await hasEffectivePermission(user.id, "payments.manage");
  return { user, allowed };
}

/**
 * A return month, in India: from midnight IST on the 1st up to — not including — midnight IST on the
 * 1st of the next month. Queries use `gte: from, lt: before`.
 *
 * It used to be the UTC month, inclusive, so a document issued between 00:00 and 05:30 IST on the 1st
 * landed in the previous month's return (X4). Past months' figures change with the fix, because those
 * were the wrong ones. `to` — the month's last millisecond — is only for the pages' labels.
 */
function monthBounds(month: number, year: number) {
  const from = istMidnight(year, month - 1, 1);
  // `month` is 1-based and istMidnight's is 0-based, so this is the next month; December carries into January.
  const before = istMidnight(year, month, 1);
  return { from, before, to: new Date(before.getTime() - 1) };
}

/** The GSTIN a return is filed for, as the pages show it. */
type ReturnRegistration = { id: string; gstin: string; stateCode: string; code: string };

/**
 * Which registration's return to build: the one asked for, else the head office's, else the first
 * there is. Null only when there is no registration to file for — then the return is unfiltered, as it
 * was before registrations existed.
 *
 * Reads through `listRegistrationChoices`, so an inactive registration still has its returns while
 * anything names it: a return for a GSTIN surrendered last month is still due.
 */
async function returnRegistration(requested: string | undefined): Promise<ReturnRegistration | null> {
  const choices = await listRegistrationChoices();
  const chosen =
    (requested ? choices.find((c) => c.id === requested) : undefined) ?? choices.find((c) => c.isHeadOffice) ?? choices[0];
  return chosen ? { id: chosen.id, gstin: chosen.gstin, stateCode: chosen.stateCode, code: chosen.code } : null;
}

/** The registrations there are returns for, for the page's picker: the active ones, and any still referenced. */
export async function listReturnRegistrations(): Promise<RegistrationChoice[]> {
  const { allowed } = await requireAccounts();
  if (!allowed) return [];
  return listRegistrationChoices();
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
   * The party's GSTIN as it was on the document, not as the company record reads today.
   *
   * A return is a statement about what was supplied on a date, and the customer's registration can
   * change afterwards — filing this month's return with next year's GSTIN would break the match
   * against the buyer's own credit. On a sale the party is the buyer; on a purchase it is the seller,
   * and `buyerGstin` is ours (X1 — see `toReturnDocument`).
   */
  direction: true,
  buyerGstin: true,
  sellerGstin: true,
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
  direction: string;
  buyerGstin: string | null;
  sellerGstin: string | null;
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
    // A purchase records the vendor as the seller and us as the buyer; before branches it kept the
    // vendor's GSTIN in `buyerGstin`, and the migration moved it (X1).
    partyGstin: d.direction === "PURCHASE" ? d.sellerGstin : d.buyerGstin,
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

/**
 * GSTR-1 for one registration — a return is filed per GSTIN, never for the company (spec §8.4).
 * `gstRegistrationId` defaults to the head office's; see `returnRegistration`.
 */
export async function gstr1(params: { month: number; year: number; gstRegistrationId?: string }) {
  const { allowed } = await requireAccounts();
  if (!allowed) return null;

  const { from, before, to } = monthBounds(params.month, params.year);
  const registration = await returnRegistration(params.gstRegistrationId);
  const docs = await db.tradeDocument.findMany({
    where: {
      docType: { in: ["INVOICE", "CREDIT_NOTE"] },
      issueDate: { gte: from, lt: before },
      ...(registration ? { gstRegistrationId: registration.id } : {}),
    },
    orderBy: { issueDate: "asc" },
    select: documentSelect,
  });

  return toPlain({
    month: params.month,
    year: params.year,
    from,
    to,
    registration,
    ...buildGstr1(docs.map((d) => toReturnDocument(d as unknown as RawDoc))),
  });
}

// ─── GSTR-3B ──────────────────────────────────────────────────────────────────

/**
 * GSTR-3B for one registration: its outward supplies, the credit on bills raised to it, and its own
 * GST lines in the ledger to check both against. Defaults as `gstr1` does.
 */
export async function gstr3b(params: { month: number; year: number; gstRegistrationId?: string }) {
  const { allowed } = await requireAccounts();
  if (!allowed) return null;

  const { from, before, to } = monthBounds(params.month, params.year);
  const registration = await returnRegistration(params.gstRegistrationId);
  const ofRegistration = registration ? { gstRegistrationId: registration.id } : {};
  const [outward, inward, ledger] = await Promise.all([
    db.tradeDocument.findMany({
      where: { docType: { in: ["INVOICE", "CREDIT_NOTE"] }, issueDate: { gte: from, lt: before }, ...ofRegistration },
      select: documentSelect,
    }),
    db.tradeDocument.findMany({
      where: { docType: "BILL", issueDate: { gte: from, lt: before }, ...ofRegistration },
      select: documentSelect,
    }),
    ledgerTaxTotals(from, before, registration?.id ?? null),
  ]);

  return toPlain({
    month: params.month,
    year: params.year,
    from,
    to,
    registration,
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
 *
 * With a registration, only the lines tagged with it: the GST accounts are shared by every GSTIN of the
 * company (one set of books), and the tag is what says whose return a line belongs to. `before` is
 * exclusive, as in `monthBounds`.
 */
async function ledgerTaxTotals(from: Date, before: Date, gstRegistrationId: string | null) {
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
    where: {
      accountId: { in: accounts.map((a) => a.id) },
      entry: { date: { gte: from, lt: before } },
      ...(gstRegistrationId ? { gstRegistrationId } : {}),
    },
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

  // Not a GST return: TDS is accounted for under a TAN, not per GSTIN, so this stays company-wide.
  const { from, before, to } = monthBounds(params.month, params.year);
  const docs = await db.tradeDocument.findMany({
    where: {
      docType: { in: ["INVOICE", "BILL"] },
      issueDate: { gte: from, lt: before },
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
  const user = await requireModuleUser("accounting");
  // The page checks this too, but a server action can be called without its page: the books are
  // `ledger.viewReports`, as everywhere else in src/actions/ledger-reports.ts.
  if (!(await can(user.id, "ledger.viewReports"))) throw new Error("You don't have permission to see the books.");
  // Indian days, as the returns' months are — not UTC days, which began and ended at 05:30 IST.
  const from = startOfIndianDay(params.from) ?? new Date(NaN);
  const toNext = endOfIndianDay(params.to);
  const to = toNext ? new Date(toNext.getTime() - 1) : new Date(NaN);

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
