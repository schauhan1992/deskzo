"use server";

import type { JournalSource, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser, moduleAccessFor } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { logActivity } from "@/lib/activity";
import { getSecurityPolicy } from "@/lib/security/store";
import { exportDecision } from "@/lib/security/policy";
import { notMigratedYet } from "@/lib/not-migrated";
import { indiaClock, MONTH_NAMES } from "@/lib/time/zone";
import { financialYearBounds } from "@/lib/india-time";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/chart";
import { bookingRate } from "@/lib/ledger/posting";
import { settleInvoice } from "@/lib/receivables";
import { RAISED_IN_DESKZO } from "@/lib/documents/imported";
import { fromPaise, round2, toPaise } from "@/lib/accounts/money";
import { resolvePage, resolvePageSize } from "@/lib/pagination";
import { dateParam, tableToCsv, type Cell, type ReportColumn, type ReportResult, type ReportRow, type ReportTable } from "@/components/reports/accounts/table";
import type { ActionResult } from "@/actions/company";
import { docTypeIn } from "@/lib/trade-documents";

/**
 * Accounting reports, under Finance → Accounts (owner, 22 Oct 2026): the day book, the cash and bank books,
 * the sales, purchase and journal registers, expenses by month, a GST summary, and the audit history of
 * vouchers and stock vouchers — what BUSY and Tally keep under "Display".
 *
 * Read-only, from the ledger and the documents already there; nothing here stores a figure. Each reads the
 * books, so each needs `ledger.viewReports` — except the cash and bank books, which the finance function
 * (`payments.manage`) keeps too. Downloading as CSV is `data.exportFinance` as well, within the workspace's
 * export row limit, and is logged either way. The GST summary is a summary of documents, never a return filed.
 */

export type AccountsReportKey = "day-book" | "cash-book" | "sales" | "purchase" | "journal" | "expenses" | "gst" | "audit";

export type AccountsReportParams = {
  page?: string | number;
  pageSize?: string | number;
  from?: string;
  to?: string;
  account?: string;
  party?: string;
  q?: string;
  source?: string;
  entity?: string;
};

const KEYS: readonly AccountsReportKey[] = ["day-book", "cash-book", "sales", "purchase", "journal", "expenses", "gst", "audit"];
const EXPORT_CAP = 100_000;
const NOT_RETURNED = ["DRAFT", "CANCELLED", "EXPIRED", "REJECTED"] as const;

const TITLES: Record<AccountsReportKey, string> = {
  "day-book": "Day book",
  "cash-book": "Cash & bank book",
  sales: "Sales register",
  purchase: "Purchase register",
  journal: "Journal register",
  expenses: "Expenses by month",
  gst: "GST summary",
  audit: "Voucher audit history",
};

const SOURCE_LABEL: Record<JournalSource, string> = {
  INVOICE: "Invoice",
  CREDIT_NOTE: "Credit note",
  DEBIT_NOTE: "Debit note",
  BILL: "Bill",
  PAYMENT: "Payment",
  EXPENSE: "Expense",
  MANUAL: "Manual journal",
  OPENING: "Opening",
  PAYROLL: "Payroll",
  DEPRECIATION: "Depreciation",
  CLOSING: "Year end",
  FX: "Exchange",
  REVENUE: "Revenue",
  SCHEDULE: "Schedule",
  VENDOR_CREDIT: "Vendor credit",
  VOUCHER: "Voucher",
  INVENTORY: "Inventory",
};
const SOURCES = Object.keys(SOURCE_LABEL) as JournalSource[];

// ─── Who may read ────────────────────────────────────────────────────────────────────────────────

async function access() {
  const user = await requireModuleUser("accounting");
  const [books, finance, exportFinance] = await Promise.all([can(user.id, "ledger.viewReports"), can(user.id, "payments.manage"), can(user.id, "data.exportFinance")]);
  return { user, books, finance, exportFinance };
}

function allowed(key: AccountsReportKey, a: { books: boolean; finance: boolean }) {
  return key === "cash-book" ? a.books || a.finance : a.books;
}

/** Which of the reports this person may open, and whether they may download them. */
export async function accountsReportAccess() {
  const a = await access();
  return { books: a.books, cashBook: a.books || a.finance, gstReturns: a.finance, export: (a.books || a.finance) && a.exportFinance };
}

/** The bank and cash accounts a cash or bank book can be kept for. */
export async function accountsReportOptions() {
  const a = await access();
  if (!(a.books || a.finance)) return { moneyAccounts: [] };
  return { moneyAccounts: await moneyAccounts() };
}

async function moneyAccounts() {
  const rows = await db.ledgerAccount.findMany({
    where: { isGroup: false, OR: [{ systemKey: { in: [SYSTEM_ACCOUNTS.CASH, SYSTEM_ACCOUNTS.BANK] } }, { bankAccount: { isNot: null } }] },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true, systemKey: true, active: true, bankAccount: { select: { name: true } } },
  });
  return rows.map((r) => ({ value: r.id, label: `${r.code} · ${r.name}${r.active ? "" : " (closed)"}`, cash: r.systemKey === SYSTEM_ACCOUNTS.CASH }));
}

/**
 * Customers or vendors matching what's typed, for the registers' party filter — the companies with a document of
 * that direction, so the list offers only those the register can show.
 */
export async function searchRegisterParties(term: string, direction: "SALES" | "PURCHASE") {
  const a = await access();
  if (!a.books) return [];
  const q = term.trim();
  if (q.length < 2) return [];
  return db.company.findMany({
    where: { name: { contains: q, mode: "insensitive" }, tradeDocuments: { some: { direction } } },
    orderBy: { name: "asc" },
    take: 15,
    select: { id: true, name: true },
  });
}

/** The party a register is filtered to, by name — for the filter to show what is chosen. */
export async function registerParty(id: string | undefined) {
  const a = await access();
  if (!a.books || !id) return null;
  return db.company.findUnique({ where: { id }, select: { id: true, name: true } });
}

/** One report, a page of it, with totals over everything the filters match. */
export async function accountsReport(key: AccountsReportKey, params: AccountsReportParams = {}): Promise<ReportResult> {
  const a = await access();
  if (!KEYS.includes(key)) return { status: "invalid", message: "There's no such report." };
  if (!allowed(key, a)) return { status: "forbidden" };
  try {
    return { status: "ok", table: await build(key, params, false) };
  } catch (err) {
    if (notMigratedYet(err)) return { status: "not-migrated" };
    if (err instanceof ReportInputError) return { status: "invalid", message: err.message };
    throw err;
  }
}

/** A report as CSV — every row, not one page — for whoever may read it and holds the finance export permission. */
export async function exportAccountsReportCsv(key: AccountsReportKey, params: AccountsReportParams = {}): Promise<ActionResult<{ filename: string; csv: string; rows: number }>> {
  const a = await access();
  if (!KEYS.includes(key)) return { ok: false, error: "There's no such report." };
  if (!allowed(key, a)) return { ok: false, error: "You don't have permission to see this report." };
  const title = TITLES[key];
  if (!a.exportFinance) {
    await logActivity({ kind: "PERMISSION_DENIED", severity: "WARNING", summary: `${a.user.name} tried to download the ${title.toLowerCase()} without the export permission`, metadata: { report: key } });
    return { ok: false, error: "You can read this report but not download it. Downloading financial data needs the export permission." };
  }
  let table: ReportTable;
  try {
    table = await build(key, params, true);
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: "This workspace's database hasn't been brought up to date for this report yet." };
    if (err instanceof ReportInputError) return { ok: false, error: err.message };
    throw err;
  }
  const meta: Record<string, string | boolean> = {};
  const lines: [string, string][] = [];
  for (const [k, label] of [["from", "From"], ["to", "To"], ["source", "Source"], ["entity", "Records"]] as const) {
    const v = params[k];
    if (v) {
      lines.push([label, String(v)]);
      meta[k] = String(v);
    }
  }
  if (params.account) meta.account = params.account;
  if (params.party) meta.party = params.party;
  if (params.q?.trim()) {
    lines.push(["Search", params.q.trim()]);
    meta.search = true;
  }
  const verdict = exportDecision(table.rows.length, await getSecurityPolicy());
  if (!verdict.allowed) {
    await logActivity({ kind: "EXPORT", severity: "WARNING", summary: `${a.user.name} was refused a download of the ${title.toLowerCase()} — ${table.rows.length} rows, over the limit`, metadata: { report: key, rows: table.rows.length, filters: meta } });
    return { ok: false, error: verdict.reason };
  }
  const csv = tableToCsv(table, [...lines, ["Run by", a.user.name ?? ""]]);
  await logActivity({ kind: "EXPORT", severity: "NOTICE", summary: `${a.user.name} downloaded the ${title.toLowerCase()} — ${table.rows.length} row(s)`, metadata: { report: key, rows: table.rows.length, filters: meta } });
  return { ok: true, data: { filename: `${key}-${indiaClock.today()}.csv`, csv, rows: table.rows.length } };
}

// ─── At a glance ─────────────────────────────────────────────────────────────────────────────────

export type GlanceCard = { key: string; label: string; value: number; kind: "money" | "count"; hint?: string; href: string; tone?: "warning" | "danger" };

/**
 * The Accounts overview's strip: what needs looking at, each figure only for somebody who may open the page it
 * links to, and only once the workspace has what it counts.
 */
export async function accountsGlance(): Promise<GlanceCard[]> {
  const user = await requireModuleUser("accounting");
  const [items, receivables, payables] = await Promise.all([moduleAccessFor(user.id, "items"), moduleAccessFor(user.id, "receivables"), moduleAccessFor(user.id, "payables")]);
  const [invView, invReceive, invTransfer, invAdjust, invManage, approveAdj, approveVouchers, finance] = await Promise.all([
    can(user.id, "inventory.view"),
    can(user.id, "inventory.receive"),
    can(user.id, "inventory.transfer"),
    can(user.id, "inventory.adjust"),
    can(user.id, "inventory.manage"),
    can(user.id, "inventory.approveAdjustments"),
    can(user.id, "vouchers.approve"),
    can(user.id, "payments.manage"),
  ]);
  const seesStock = items === "available" && (invView || invReceive || invTransfer || invAdjust || invManage);
  const cards: GlanceCard[] = [];
  const quietly = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch (err) {
      if (!notMigratedYet(err)) throw err;
    }
  };

  if (seesStock) {
    await quietly(async () => {
      const [value, withLevel] = await Promise.all([
        db.stockBalance.aggregate({ _sum: { value: true } }),
        db.item.findMany({ where: { type: "GOOD", trackInventory: true, active: true, reorderLevel: { not: null } }, select: { reorderLevel: true, stockQuantity: true } }),
      ]);
      cards.push({ key: "stockValue", label: "Stock value", value: round2(Number(value._sum.value ?? 0)), kind: "money", hint: "At cost, every warehouse", href: "/items/stock-reports?report=valuation" });
      const below = withLevel.filter((i) => Number(i.stockQuantity) <= Number(i.reorderLevel)).length;
      cards.push({ key: "reorder", label: "Items to reorder", value: below, kind: "count", hint: "At or below reorder level", href: "/items/stock-reports?report=reorder", tone: below > 0 ? "warning" : undefined });
    });
  }
  const overdue = async (docType: "INVOICE" | "BILL") => {
    const now = new Date();
    const rows = await db.tradeDocument.findMany({
      where: { docType, status: { notIn: ["DRAFT", "CANCELLED", "PAID"] }, OR: [{ dueDate: { lt: now } }, { dueDate: null, issueDate: { lt: now } }] },
      select: {
        total: true, paidBefore: true, currency: true, exchangeRate: true,
        payments: { select: { amount: true } }, creditsReceived: { select: { amount: true } }, vendorCredits: { select: { amount: true } },
      },
    });
    let count = 0;
    let amount = 0;
    for (const r of rows) {
      const { balance } = settleInvoice(
        Number(r.total),
        r.payments.reduce((t, p) => t + Number(p.amount), 0),
        r.creditsReceived.reduce((t, c) => t + Number(c.amount), 0) + r.vendorCredits.reduce((t, c) => t + Number(c.amount), 0),
        Number(r.paidBefore),
      );
      if (balance <= 0) continue;
      count += 1;
      amount += balance * bookingRate(r);
    }
    return { count, amount: round2(amount) };
  };
  if (receivables === "available") {
    const o = await overdue("INVOICE");
    cards.push({ key: "overdueInvoices", label: "Overdue invoices", value: o.amount, kind: "money", hint: `${o.count} invoice(s) past due`, href: "/receivables", tone: o.count > 0 ? "danger" : undefined });
  }
  if (payables === "available") {
    const o = await overdue("BILL");
    cards.push({ key: "overdueBills", label: "Overdue bills", value: o.amount, kind: "money", hint: `${o.count} bill(s) past due`, href: "/payables", tone: o.count > 0 ? "warning" : undefined });
  }
  if (approveVouchers) {
    await quietly(async () => {
      const waiting = await db.accountVoucher.count({ where: { status: "PENDING_APPROVAL" } });
      cards.push({ key: "vouchers", label: "Vouchers to approve", value: waiting, kind: "count", href: "/accounting/vouchers?status=PENDING_APPROVAL", tone: waiting > 0 ? "warning" : undefined });
    });
  }
  if (items === "available" && approveAdj) {
    await quietly(async () => {
      const waiting = await db.stockDocument.count({ where: { status: "PENDING_APPROVAL" } });
      cards.push({ key: "adjustments", label: "Stock adjustments to approve", value: waiting, kind: "count", href: "/items/stock?status=PENDING_APPROVAL", tone: waiting > 0 ? "warning" : undefined });
    });
  }
  if (finance) {
    const unmatched = await db.bankStatementLine.count({ where: { matchedLineId: null } });
    cards.push({ key: "unreconciled", label: "Statement lines to reconcile", value: unmatched, kind: "count", href: "/accounting/banking", tone: unmatched > 0 ? "warning" : undefined });
  }
  return cards;
}

// ─── The reports ─────────────────────────────────────────────────────────────────────────────────

class ReportInputError extends Error {}

type Paging = { page: number; pageSize: number; skip: number; take: number };

function paging(p: AccountsReportParams, all: boolean): Paging {
  if (all) return { page: 1, pageSize: EXPORT_CAP, skip: 0, take: EXPORT_CAP };
  const page = resolvePage(p.page === undefined ? undefined : String(p.page));
  const pageSize = resolvePageSize(p.pageSize === undefined ? undefined : String(p.pageSize));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

/** The window a report covers: as asked, else `fallback`'s — this month, or the financial year to date. */
function period(p: AccountsReportParams, fallback: "month" | "year" | "none") {
  const today = indiaClock.today();
  let from = dateParam(p.from);
  const to = dateParam(p.to) ?? (fallback === "none" ? null : today);
  if (!from && fallback === "month") from = `${today.slice(0, 7)}-01`;
  if (!from && fallback === "year") from = financialYearBounds(new Date()).from;
  if (from && to && from > to) throw new ReportInputError("The From date is after the To date.");
  const range = indiaClock.dayRange(from, to);
  const filter: Prisma.DateTimeFilter | undefined = range ? { ...(range.gte ? { gte: range.gte } : {}), ...(range.lt ? { lt: range.lt } : {}) } : undefined;
  const label =
    from && to
      ? `${indiaClock.date(indiaClock.startOfDay(from)!)} to ${indiaClock.date(indiaClock.startOfDay(to)!)}`
      : from
        ? `From ${indiaClock.date(indiaClock.startOfDay(from)!)}`
        : to
          ? `Up to ${indiaClock.date(indiaClock.startOfDay(to)!)}`
          : "All dates";
  return { from, to, filter, label };
}

async function build(key: AccountsReportKey, p: AccountsReportParams, all: boolean): Promise<ReportTable> {
  const pg = paging(p, all);
  switch (key) {
    case "day-book":
      return entriesTable("day-book", p, pg, {});
    case "journal":
      return entriesTable("journal", p, pg, { source: { in: ["MANUAL", "VOUCHER"] } });
    case "cash-book":
      return cashBook(p, pg);
    case "sales":
      return register("sales", p, pg);
    case "purchase":
      return register("purchase", p, pg);
    case "expenses":
      return expenses(p, pg);
    case "gst":
      return gstSummary(p, pg);
    case "audit":
      return audit(p, pg);
  }
}

/** Where an entry came from, linked: its voucher, its document, its stock voucher — or the journal. */
function entryCell(e: {
  id: string;
  entryNumber: string;
  documentId: string | null;
  accountVoucherId: string | null;
  stockDocumentId: string | null;
  document: { docNumber: string } | null;
  accountVoucher: { number: string } | null;
  stockDocument: { number: string } | null;
}): Cell {
  if (e.accountVoucher && e.accountVoucherId) return { text: e.entryNumber, href: `/accounting/vouchers/${e.accountVoucherId}`, sub: e.accountVoucher.number };
  if (e.stockDocument && e.stockDocumentId) return { text: e.entryNumber, href: `/items/stock/${e.stockDocumentId}`, sub: e.stockDocument.number };
  if (e.document && e.documentId) return { text: e.entryNumber, href: `/documents/${e.documentId}`, sub: e.document.docNumber };
  return { text: e.entryNumber, href: `/accounting/journal?q=${encodeURIComponent(e.entryNumber)}` };
}

const entrySelect = {
  id: true, entryNumber: true, date: true, narration: true, source: true, reversesId: true,
  documentId: true, accountVoucherId: true, stockDocumentId: true,
  document: { select: { docNumber: true } },
  accountVoucher: { select: { number: true } },
  stockDocument: { select: { number: true } },
  lines: {
    orderBy: { sortOrder: "asc" },
    select: { id: true, debit: true, credit: true, narration: true, account: { select: { id: true, code: true, name: true } }, company: { select: { id: true, name: true } } },
  },
} satisfies Prisma.JournalEntrySelect;

// The day book, and the journal register (hand-written entries and vouchers): every entry, line by line.
async function entriesTable(key: "day-book" | "journal", p: AccountsReportParams, pg: Paging, scope: Prisma.JournalEntryWhereInput): Promise<ReportTable> {
  const w = period(p, "month");
  const q = p.q?.trim();
  const source = SOURCES.includes(p.source as JournalSource) ? (p.source as JournalSource) : null;
  const where: Prisma.JournalEntryWhereInput = {
    AND: [
      scope,
      ...(w.filter ? [{ date: w.filter }] : []),
      ...(source ? [{ source }] : []),
      ...(q ? [{ OR: [{ entryNumber: { contains: q, mode: "insensitive" as const } }, { narration: { contains: q, mode: "insensitive" as const } }] }] : []),
    ],
  };
  const [entries, total, sums] = await Promise.all([
    db.journalEntry.findMany({ where, orderBy: [{ date: "asc" }, { entryNumber: "asc" }], skip: pg.skip, take: pg.take, select: entrySelect }),
    db.journalEntry.count({ where }),
    db.journalLine.aggregate({ where: { entry: where }, _sum: { debit: true, credit: true } }),
  ]);
  const rows: ReportRow[] = [];
  for (const e of entries) {
    e.lines.forEach((l, i) => {
      rows.push({
        id: l.id,
        continues: i > 0,
        tone: e.reversesId ? "muted" : undefined,
        cells: {
          date: indiaClock.dateKey(e.date),
          entry: entryCell(e),
          source: `${SOURCE_LABEL[e.source]}${e.reversesId ? " (reversal)" : ""}`,
          account: { text: `${l.account.code} · ${l.account.name}`, href: `/accounting/ledger/${l.account.id}`, sub: l.company?.name ?? null },
          narration: l.narration ?? e.narration,
          debit: n(l.debit) || null,
          credit: n(l.credit) || null,
        },
      });
    });
  }
  return {
    key,
    title: TITLES[key],
    subtitle: w.label,
    page: pg.page,
    pageSize: pg.pageSize,
    columns: [
      { key: "date", label: "Date", kind: "date", group: true },
      { key: "entry", label: "Entry", group: true },
      { key: "source", label: "From", group: true },
      { key: "account", label: "Account" },
      { key: "narration", label: "Narration" },
      { key: "debit", label: "Debit", kind: "money" },
      { key: "credit", label: "Credit", kind: "money" },
    ],
    rows,
    totals: { debit: round2(n(sums._sum.debit)), credit: round2(n(sums._sum.credit)) },
    total,
    unit: "entries",
    notes: key === "journal" ? ["Hand-written journal entries and posted payment, receipt, contra and journal vouchers."] : ["Every posted entry, in date order — documents, payments, vouchers, stock and payroll alike."],
  };
}

// The cash book or a bank book: one money account's lines, receipts and payments, with a running balance.
async function cashBook(p: AccountsReportParams, pg: Paging): Promise<ReportTable> {
  const accounts = await moneyAccounts();
  if (accounts.length === 0) throw new ReportInputError("There's no bank or cash account in the chart yet.");
  const chosen = accounts.find((a) => a.value === p.account) ?? accounts.find((a) => a.cash) ?? accounts[0]!;
  const account = await db.ledgerAccount.findUniqueOrThrow({ where: { id: chosen.value }, select: { id: true, code: true, name: true } });
  const w = period(p, "month");
  const inRange: Prisma.JournalLineWhereInput = { accountId: account.id, ...(w.filter ? { entry: { date: w.filter } } : {}) };
  const order: Prisma.JournalLineOrderByWithRelationInput[] = [{ entry: { date: "asc" } }, { entry: { entryNumber: "asc" } }, { sortOrder: "asc" }, { id: "asc" }];
  const [opening, total, sums, earlier, lines] = await Promise.all([
    w.filter?.gte ? db.journalLine.aggregate({ where: { accountId: account.id, entry: { date: { lt: w.filter.gte as Date } } }, _sum: { debit: true, credit: true } }) : null,
    db.journalLine.count({ where: inRange }),
    db.journalLine.aggregate({ where: inRange, _sum: { debit: true, credit: true } }),
    pg.skip > 0 ? db.journalLine.findMany({ where: inRange, orderBy: order, take: pg.skip, select: { debit: true, credit: true } }) : [],
    db.journalLine.findMany({
      where: inRange,
      orderBy: order,
      skip: pg.skip,
      take: pg.take,
      select: {
        id: true, debit: true, credit: true, narration: true, reconciledAt: true,
        company: { select: { name: true } },
        entry: {
          select: {
            id: true, entryNumber: true, date: true, narration: true, source: true, documentId: true, accountVoucherId: true, stockDocumentId: true,
            document: { select: { docNumber: true } }, accountVoucher: { select: { number: true } }, stockDocument: { select: { number: true } },
            lines: { where: { accountId: { not: account.id } }, select: { account: { select: { name: true } } } },
          },
        },
      },
    }),
  ]);
  const openPaise = toPaise(n(opening?._sum.debit)) - toPaise(n(opening?._sum.credit));
  let balance = openPaise + earlier.reduce((t, l) => t + toPaise(n(l.debit)) - toPaise(n(l.credit)), 0);
  const rows: ReportRow[] = [];
  if (pg.page === 1) rows.push({ id: "opening", tone: "muted", cells: { date: w.from, particulars: "Opening balance", balance: fromPaise(openPaise) } });
  for (const l of lines) {
    balance += toPaise(n(l.debit)) - toPaise(n(l.credit));
    const others = [...new Set(l.entry.lines.map((x) => x.account.name))];
    rows.push({
      id: l.id,
      cells: {
        date: indiaClock.dateKey(l.entry.date),
        entry: entryCell(l.entry),
        particulars: { text: others.join(", ") || "—", sub: l.company?.name ?? null },
        narration: l.narration ?? l.entry.narration,
        receipts: n(l.debit) || null,
        payments: n(l.credit) || null,
        balance: fromPaise(balance),
        reconciled: l.reconciledAt ? "Yes" : "",
      },
    });
  }
  const closing = openPaise + toPaise(n(sums._sum.debit)) - toPaise(n(sums._sum.credit));
  return {
    key: "cash-book",
    title: `${chosen.cash ? "Cash book" : "Bank book"} — ${account.name}`,
    subtitle: w.label,
    page: pg.page,
    pageSize: pg.pageSize,
    columns: [
      { key: "date", label: "Date", kind: "date" },
      { key: "entry", label: "Entry" },
      { key: "particulars", label: "Particulars" },
      { key: "narration", label: "Narration" },
      { key: "receipts", label: "Receipts", kind: "money" },
      { key: "payments", label: "Payments", kind: "money" },
      { key: "balance", label: "Balance", kind: "money" },
      ...(chosen.cash ? [] : [{ key: "reconciled", label: "Reconciled" } as ReportColumn]),
    ],
    rows,
    totals: { receipts: round2(n(sums._sum.debit)), payments: round2(n(sums._sum.credit)), balance: fromPaise(closing) },
    total,
    unit: "lines",
    notes: ["A debit balance is money held; below nothing on a bank account is an overdraft."],
  };
}

// The sales register (invoices and credit notes) and the purchase register (bills).
async function register(key: "sales" | "purchase", p: AccountsReportParams, pg: Paging): Promise<ReportTable> {
  const w = period(p, "month");
  const q = p.q?.trim();
  const where: Prisma.TradeDocumentWhereInput = {
    docType: { in: key === "sales" ? ["INVOICE", "CREDIT_NOTE"] : ["BILL"] },
    status: { notIn: [...NOT_RETURNED] },
    ...(w.filter ? { issueDate: w.filter } : {}),
    ...(p.party ? { companyId: p.party } : {}),
    ...(q ? { OR: [{ docNumber: { contains: q, mode: "insensitive" } }, { company: { name: { contains: q, mode: "insensitive" } } }] } : {}),
  };
  const select = {
    id: true, docNumber: true, docType: true, issueDate: true, status: true, currency: true, exchangeRate: true,
    buyerGstin: true, sellerGstin: true, placeOfSupplyCode: true, partyName: true,
    taxableValue: true, cgstAmount: true, sgstAmount: true, igstAmount: true, total: true,
    company: { select: { id: true, name: true } },
  } satisfies Prisma.TradeDocumentSelect;
  const [docs, total, everything] = await Promise.all([
    db.tradeDocument.findMany({ where, orderBy: [{ issueDate: "asc" }, { docNumber: "asc" }], skip: pg.skip, take: pg.take, select }),
    db.tradeDocument.count({ where }),
    db.tradeDocument.findMany({ where, select: { docType: true, currency: true, exchangeRate: true, taxableValue: true, cgstAmount: true, sgstAmount: true, igstAmount: true, total: true } }),
  ]);
  const amounts = (d: { docType: string; currency: string; exchangeRate: unknown; taxableValue: unknown; cgstAmount: unknown; sgstAmount: unknown; igstAmount: unknown; total: unknown }) => {
    const sign = d.docType === "CREDIT_NOTE" ? -1 : 1;
    const rate = bookingRate(d);
    const r = (v: unknown) => sign * toPaise(n(v) * rate);
    return { taxable: r(d.taxableValue), cgst: r(d.cgstAmount), sgst: r(d.sgstAmount), igst: r(d.igstAmount), total: r(d.total) };
  };
  const sums = everything.reduce(
    (t, d) => {
      const a = amounts(d);
      return { taxable: t.taxable + a.taxable, cgst: t.cgst + a.cgst, sgst: t.sgst + a.sgst, igst: t.igst + a.igst, total: t.total + a.total };
    },
    { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 },
  );
  return {
    key,
    title: TITLES[key],
    subtitle: w.label,
    page: pg.page,
    pageSize: pg.pageSize,
    columns: [
      { key: "date", label: "Date", kind: "date" },
      { key: "number", label: key === "sales" ? "Invoice / note" : "Bill" },
      { key: "party", label: key === "sales" ? "Customer" : "Vendor" },
      { key: "gstin", label: "GSTIN" },
      { key: "pos", label: "Place of supply" },
      { key: "taxable", label: "Taxable value", kind: "money" },
      { key: "cgst", label: "CGST", kind: "money" },
      { key: "sgst", label: "SGST", kind: "money" },
      { key: "igst", label: "IGST", kind: "money" },
      { key: "total", label: "Total", kind: "money" },
    ],
    rows: docs.map((d) => {
      const a = amounts(d);
      return {
        id: d.id,
        cells: {
          date: indiaClock.dateKey(d.issueDate),
          number: { text: d.docNumber, href: `/documents/${d.id}`, sub: d.docType === "CREDIT_NOTE" ? "Credit note" : d.currency !== "INR" ? d.currency : null },
          party: { text: d.partyName ?? d.company.name, href: `/companies/${d.company.id}` },
          gstin: (key === "sales" ? d.buyerGstin : d.sellerGstin) ?? "Unregistered",
          pos: d.placeOfSupplyCode,
          taxable: fromPaise(a.taxable),
          cgst: fromPaise(a.cgst),
          sgst: fromPaise(a.sgst),
          igst: fromPaise(a.igst),
          total: fromPaise(a.total),
        },
      };
    }),
    totals: { taxable: fromPaise(sums.taxable), cgst: fromPaise(sums.cgst), sgst: fromPaise(sums.sgst), igst: fromPaise(sums.igst), total: fromPaise(sums.total) },
    total,
    unit: "documents",
    notes: ["Issued documents only — drafts and cancelled ones are left out. In rupees, at each document's own rate; a credit note reduces the totals."],
  };
}

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const [ty, tm] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))];
  while ((y < ty || (y === ty && m <= tm)) && out.length < 120) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
const monthLabel = (key: string) => `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;

// Expenses: each expense account's movement, month by month.
async function expenses(p: AccountsReportParams, pg: Paging): Promise<ReportTable> {
  const w = period(p, "year");
  const months = monthsBetween(w.from!, w.to!);
  const lines = await db.journalLine.findMany({
    where: { account: { type: "EXPENSE" }, ...(w.filter ? { entry: { date: w.filter } } : {}) },
    select: { accountId: true, debit: true, credit: true, entry: { select: { date: true } } },
  });
  const byAccount = new Map<string, Record<string, number>>();
  const monthTotals: Record<string, number> = Object.fromEntries(months.map((m) => [m, 0]));
  for (const l of lines) {
    const month = indiaClock.monthKey(l.entry.date);
    const paise = toPaise(n(l.debit)) - toPaise(n(l.credit));
    const row = byAccount.get(l.accountId) ?? {};
    row[month] = (row[month] ?? 0) + paise;
    byAccount.set(l.accountId, row);
    monthTotals[month] = (monthTotals[month] ?? 0) + paise;
  }
  const accounts = await db.ledgerAccount.findMany({ where: { id: { in: [...byAccount.keys()] } }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } });
  const rows = accounts
    .map((a) => ({ a, months: byAccount.get(a.id)!, total: Object.values(byAccount.get(a.id)!).reduce((t, v) => t + v, 0) }))
    .filter((r) => Object.values(r.months).some((v) => v !== 0));
  return {
    key: "expenses",
    title: TITLES.expenses,
    subtitle: w.label,
    page: pg.page,
    pageSize: pg.pageSize,
    columns: [
      { key: "account", label: "Expense account" },
      ...months.map((m): ReportColumn => ({ key: `m_${m}`, label: monthLabel(m), kind: "money" })),
      { key: "total", label: "Total", kind: "money" },
    ],
    rows: rows.slice(pg.skip, pg.skip + pg.take).map((r) => ({
      id: r.a.id,
      cells: {
        account: { text: `${r.a.code} · ${r.a.name}`, href: `/accounting/ledger/${r.a.id}` },
        ...Object.fromEntries(months.map((m) => [`m_${m}`, fromPaise(r.months[m] ?? 0)])),
        total: fromPaise(r.total),
      },
    })),
    totals: { ...Object.fromEntries(months.map((m) => [`m_${m}`, fromPaise(monthTotals[m] ?? 0)])), total: fromPaise(Object.values(monthTotals).reduce((t, v) => t + v, 0)) },
    total: rows.length,
    unit: "accounts",
    notes: ["Each month's debits less credits on every expense account — what was spent, as the ledger has it."],
  };
}

// A GST summary: output tax from sales documents against input tax from bills, month by month and per GSTIN.
async function gstSummary(p: AccountsReportParams, pg: Paging): Promise<ReportTable> {
  const w = period(p, "year");
  const docs = await db.tradeDocument.findMany({
    where: {
      AND: [
        RAISED_IN_DESKZO,
        { docType: docTypeIn(["INVOICE", "CREDIT_NOTE", "DEBIT_NOTE", "BILL"]), status: { notIn: [...NOT_RETURNED] }, ...(w.filter ? { issueDate: w.filter } : {}) },
      ],
    },
    select: {
      docType: true, issueDate: true, currency: true, exchangeRate: true, taxableValue: true, cgstAmount: true, sgstAmount: true, igstAmount: true,
      gstRegistration: { select: { gstin: true } },
    },
  });
  type Slot = { month: string; gstin: string; outTaxable: number; outCgst: number; outSgst: number; outIgst: number; inTaxable: number; inCgst: number; inSgst: number; inIgst: number };
  const slots = new Map<string, Slot>();
  for (const d of docs) {
    const month = indiaClock.monthKey(d.issueDate);
    const gstin = d.gstRegistration?.gstin ?? "Not assigned";
    const k = `${month}|${gstin}`;
    const s = slots.get(k) ?? { month, gstin, outTaxable: 0, outCgst: 0, outSgst: 0, outIgst: 0, inTaxable: 0, inCgst: 0, inSgst: 0, inIgst: 0 };
    const rate = bookingRate(d);
    const r = (v: unknown) => toPaise(n(v) * rate);
    if (d.docType === "BILL") {
      s.inTaxable += r(d.taxableValue);
      s.inCgst += r(d.cgstAmount);
      s.inSgst += r(d.sgstAmount);
      s.inIgst += r(d.igstAmount);
    } else {
      const sign = d.docType === "CREDIT_NOTE" ? -1 : 1;
      s.outTaxable += sign * r(d.taxableValue);
      s.outCgst += sign * r(d.cgstAmount);
      s.outSgst += sign * r(d.sgstAmount);
      s.outIgst += sign * r(d.igstAmount);
    }
    slots.set(k, s);
  }
  const rows = [...slots.values()].sort((a, b) => a.month.localeCompare(b.month) || a.gstin.localeCompare(b.gstin));
  const net = (s: Slot) => s.outCgst + s.outSgst + s.outIgst - (s.inCgst + s.inSgst + s.inIgst);
  const sum = (k: keyof Omit<Slot, "month" | "gstin">) => fromPaise(rows.reduce((t, s) => t + s[k], 0));
  return {
    key: "gst",
    title: TITLES.gst,
    subtitle: w.label,
    page: pg.page,
    pageSize: pg.pageSize,
    columns: [
      { key: "month", label: "Month" },
      { key: "gstin", label: "GSTIN" },
      { key: "outTaxable", label: "Sales taxable", kind: "money" },
      { key: "outCgst", label: "Output CGST", kind: "money" },
      { key: "outSgst", label: "Output SGST", kind: "money" },
      { key: "outIgst", label: "Output IGST", kind: "money" },
      { key: "inTaxable", label: "Purchases taxable", kind: "money" },
      { key: "inCgst", label: "Input CGST", kind: "money" },
      { key: "inSgst", label: "Input SGST", kind: "money" },
      { key: "inIgst", label: "Input IGST", kind: "money" },
      { key: "net", label: "Output less input", kind: "money" },
    ],
    rows: rows.slice(pg.skip, pg.skip + pg.take).map((s) => ({
      id: `${s.month}|${s.gstin}`,
      tone: net(s) < 0 ? "muted" : undefined,
      cells: {
        month: monthLabel(s.month),
        gstin: s.gstin,
        outTaxable: fromPaise(s.outTaxable),
        outCgst: fromPaise(s.outCgst),
        outSgst: fromPaise(s.outSgst),
        outIgst: fromPaise(s.outIgst),
        inTaxable: fromPaise(s.inTaxable),
        inCgst: fromPaise(s.inCgst),
        inSgst: fromPaise(s.inSgst),
        inIgst: fromPaise(s.inIgst),
        net: fromPaise(net(s)),
      },
    })),
    totals: {
      outTaxable: sum("outTaxable"), outCgst: sum("outCgst"), outSgst: sum("outSgst"), outIgst: sum("outIgst"),
      inTaxable: sum("inTaxable"), inCgst: sum("inCgst"), inSgst: sum("inSgst"), inIgst: sum("inIgst"),
      net: fromPaise(rows.reduce((t, s) => t + net(s), 0)),
    },
    total: rows.length,
    unit: "months",
    notes: [
      "A summary of issued documents raised here — not a return, and nothing is filed from it. GST Returns has GSTR-1 and GSTR-3B for filing.",
      "Input tax here is from vendor bills alone; GSTR-3B takes credit from the ledger, which also holds claims on expenses, so it can be more.",
    ],
  };
}

const ENTITY_LABEL: Record<string, string> = { AccountVoucher: "Voucher", StockDocument: "Stock voucher" };

// The audit history of vouchers and stock vouchers: who did what, and when.
async function audit(p: AccountsReportParams, pg: Paging): Promise<ReportTable> {
  const w = period(p, "none");
  const q = p.q?.trim();
  const types = p.entity === "vouchers" ? ["AccountVoucher"] : p.entity === "stock" ? ["StockDocument"] : ["AccountVoucher", "StockDocument"];
  const where: Prisma.AuditLogWhereInput = {
    entityType: { in: types },
    ...(w.filter ? { createdAt: w.filter } : {}),
    ...(q ? { entityLabel: { contains: q, mode: "insensitive" } } : {}),
  };
  const [rows, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: pg.skip,
      take: pg.take,
      select: { id: true, createdAt: true, action: true, entityType: true, entityId: true, entityLabel: true, user: { select: { name: true } }, impersonatedBy: { select: { name: true } } },
    }),
    db.auditLog.count({ where }),
  ]);
  return {
    key: "audit",
    title: TITLES.audit,
    subtitle: w.label,
    page: pg.page,
    pageSize: pg.pageSize,
    columns: [
      { key: "when", label: "When" },
      { key: "who", label: "Who" },
      { key: "action", label: "Action" },
      { key: "record", label: "Record" },
      { key: "what", label: "What happened" },
    ],
    rows: rows.map((r) => ({
      id: r.id,
      cells: {
        when: indiaClock.dateTimeShort(r.createdAt),
        who: { text: r.user.name ?? "—", sub: r.impersonatedBy?.name ? `as viewed by ${r.impersonatedBy.name}` : null },
        action: r.action.charAt(0) + r.action.slice(1).toLowerCase(),
        record: { text: ENTITY_LABEL[r.entityType] ?? r.entityType, href: r.entityType === "AccountVoucher" ? `/accounting/vouchers/${r.entityId}` : `/items/stock/${r.entityId}` },
        what: r.entityLabel,
      },
    })),
    totals: null,
    total,
    unit: "events",
  };
}
