"use server";

import type { AccountType } from "@prisma/client";
import { indiaClock } from "@/lib/time/zone";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { requireModuleUser } from "@/lib/modules-access";
import { ensureChartOfAccounts } from "@/lib/ledger/journal";
import { isDebitNatured, isProfitAndLoss, SYSTEM_ACCOUNTS } from "@/lib/ledger/chart";

const round2 = (n: number) => Math.round(n * 100) / 100;

export type AccountBalance = {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  parentId: string | null;
  isGroup: boolean;
  debit: number;
  credit: number;
  /** Positive on the account's natural side — an asset with 1,000 Dr reads as 1,000, not −1,000. */
  balance: number;
};

/**
 * Which lines a report sums: one branch's, the ones attributed to no branch (`"unassigned"` — payroll,
 * depreciation, a manual line nobody tagged), or — when absent — every line, which is the company.
 */
type BranchScope = string | "unassigned";

/**
 * Sums every posted line per account, optionally within a window.
 *
 * `from` is what separates the two kinds of report: a P&L asks "what happened between these dates",
 * a balance sheet asks "where do we stand as at this date" and so takes everything up to it.
 */
async function balances(params: { from?: Date; to?: Date; branchId?: BranchScope }) {
  const grouped = await db.journalLine.groupBy({
    by: ["accountId"],
    where: {
      entry: {
        date: {
          ...(params.from ? { gte: params.from } : {}),
          ...(params.to ? { lte: params.to } : {}),
        },
      },
      ...(params.branchId ? { branchId: params.branchId === "unassigned" ? null : params.branchId } : {}),
    },
    _sum: { debit: true, credit: true },
  });
  return new Map(
    grouped.map((g) => [
      g.accountId,
      { debit: Number(g._sum.debit ?? 0), credit: Number(g._sum.credit ?? 0) },
    ]),
  );
}

/**
 * Every account with its sums. `branchId` narrows the lines to one branch; only the P&L passes it —
 * the trial balance and balance sheet stay company-wide, because one company keeps one set of books
 * and a branch's "balance sheet" would not balance (spec §8.5).
 */
async function accountsWithBalances(params: { from?: Date; to?: Date; branchId?: BranchScope }): Promise<AccountBalance[]> {
  await ensureChartOfAccounts();
  const [accounts, sums] = await Promise.all([
    db.ledgerAccount.findMany({
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true, type: true, parentId: true, isGroup: true },
    }),
    balances(params),
  ]);

  return accounts.map((a) => {
    const s = sums.get(a.id) ?? { debit: 0, credit: 0 };
    const net = round2(s.debit - s.credit);
    return {
      ...a,
      debit: round2(s.debit),
      credit: round2(s.credit),
      balance: isDebitNatured(a.type) ? net : round2(-net),
    };
  });
}

/**
 * Rolls a child's balance up into every ancestor, so a group row shows what's underneath it.
 *
 * Groups take no postings of their own, so without this a report's headings would all read zero.
 */
function rollUp(rows: AccountBalance[]): AccountBalance[] {
  const byId = new Map(rows.map((r) => [r.id, { ...r }]));
  for (const row of rows) {
    if (row.isGroup) continue;
    let parentId = row.parentId;
    // Guarded against a chart someone has accidentally made circular by re-parenting.
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      parent.debit = round2(parent.debit + row.debit);
      parent.credit = round2(parent.credit + row.credit);
      parent.balance = round2(parent.balance + row.balance);
      parentId = parent.parentId;
    }
  }
  return [...byId.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * The trial balance: every account's debit and credit totals as at a date.
 *
 * Its whole purpose is the bottom line — if total debits don't equal total credits, something has
 * gone in wrong, and every report built on top of it is unreliable until that's explained.
 */

/**
 * Who may read the books.
 *
 * Every export in this file was reachable by any signed-in session — a calling agent, a profile-only
 * account, anybody. Between them they return the trial balance, the profit & loss, the balance
 * sheet, any account's ledger and the whole journal: the company's revenue, its liabilities and its
 * aggregate payroll cost, to a person whose job is to make phone calls.
 *
 * Gated on reading rather than on posting, because they are different jobs: an auditor should see
 * the books without being able to write to them, and a clerk who records a receipt has no reason to
 * read the balance sheet.
 */
async function mayReadBooks() {
  const user = await requireModuleUser("accounting");
  if (!(await can(user.id, "ledger.viewReports"))) {
    return { ok: false as const, error: "You don't have permission to see the books." };
  }
  return { ok: true as const };
}

export async function trialBalance(params?: { to?: string }) {
  const gate = await mayReadBooks();
  if (!gate.ok) throw new Error(gate.error);
  await requireModuleUser("accounting");
  const to = params?.to ? endOfDay(params.to) : undefined;
  const rows = (await accountsWithBalances({ to })).filter((r) => !r.isGroup);
  const withMovement = rows.filter((r) => r.debit !== 0 || r.credit !== 0);
  const totals = withMovement.reduce(
    (t, r) => ({ debit: round2(t.debit + r.debit), credit: round2(t.credit + r.credit) }),
    { debit: 0, credit: 0 },
  );
  return {
    asAt: to ?? new Date(),
    rows: withMovement,
    totals,
    balanced: totals.debit === totals.credit,
    difference: round2(totals.debit - totals.credit),
  };
}

/**
 * Profit and loss for a period. Income less expenses, both shown positive on their natural side so
 * the statement reads the way it's spoken rather than as a column of signed numbers.
 *
 * `branchId` narrows it to one branch's lines, or to `"unassigned"` — the lines no branch owns, such as
 * payroll and depreciation. An id that names no branch is ignored, and the statement is the company's;
 * `branch` in the result says which one the figures are.
 */
export async function profitAndLoss(params: { from: string; to: string; branchId?: string }) {
  const gate = await mayReadBooks();
  if (!gate.ok) throw new Error(gate.error);
  await requireModuleUser("accounting");
  const branch: { id: string; name: string } | "unassigned" | null =
    params.branchId === "unassigned"
      ? "unassigned"
      : params.branchId
        ? await db.branch.findUnique({ where: { id: params.branchId }, select: { id: true, name: true } })
        : null;
  const rows = rollUp(
    await accountsWithBalances({
      from: startOfDay(params.from),
      to: endOfDay(params.to),
      branchId: branch === "unassigned" ? "unassigned" : branch?.id,
    }),
  );
  const income = rows.filter((r) => r.type === "INCOME");
  const expense = rows.filter((r) => r.type === "EXPENSE");
  const totalIncome = sumTop(income);
  const totalExpense = sumTop(expense);
  return {
    from: startOfDay(params.from),
    to: endOfDay(params.to),
    branch,
    income,
    expense,
    totalIncome,
    totalExpense,
    netProfit: round2(totalIncome - totalExpense),
  };
}

/**
 * Balance sheet as at a date.
 *
 * Retained earnings is computed rather than stored: profit to date is simply income less expenses
 * for all time, and posting a year-end closing entry to move it would be a second source of truth
 * that can drift. The statement balances when assets equal liabilities plus equity plus that profit.
 */
export async function balanceSheet(params?: { to?: string }) {
  const gate = await mayReadBooks();
  if (!gate.ok) throw new Error(gate.error);
  await requireModuleUser("accounting");
  const to = params?.to ? endOfDay(params.to) : new Date();
  const rows = rollUp(await accountsWithBalances({ to }));

  const assets = rows.filter((r) => r.type === "ASSET");
  const liabilities = rows.filter((r) => r.type === "LIABILITY");
  const equity = rows.filter((r) => r.type === "EQUITY" && r.balance !== 0);
  const pl = rows.filter((r) => isProfitAndLoss(r.type) && !r.isGroup);

  const totalAssets = sumTop(assets);
  const totalLiabilities = sumTop(liabilities);
  const totalEquity = equity.filter((r) => r.parentId === null || !equity.some((e) => e.id === r.parentId)).reduce((t, r) => round2(t + r.balance), 0);
  const retainedEarnings = round2(
    pl.filter((r) => r.type === "INCOME").reduce((t, r) => t + r.balance, 0) -
      pl.filter((r) => r.type === "EXPENSE").reduce((t, r) => t + r.balance, 0),
  );

  const totalEquityWithProfit = round2(totalEquity + retainedEarnings);
  return {
    asAt: to,
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity: totalEquityWithProfit,
    retainedEarnings,
    balanced: totalAssets === round2(totalLiabilities + totalEquityWithProfit),
    difference: round2(totalAssets - totalLiabilities - totalEquityWithProfit),
  };
}

/** One account's transactions with a running balance — the drill-down from every other report. */
export async function accountLedger(params: { accountId: string; from?: string; to?: string }) {
  const gate = await mayReadBooks();
  if (!gate.ok) throw new Error(gate.error);
  await requireModuleUser("accounting");
  const account = await db.ledgerAccount.findUnique({
    where: { id: params.accountId },
    select: { id: true, code: true, name: true, type: true, description: true },
  });
  if (!account) return null;

  const from = params.from ? startOfDay(params.from) : undefined;
  const to = params.to ? endOfDay(params.to) : undefined;

  // Everything before the window collapses into one opening figure, so the running balance is right
  // even when you only asked for last month.
  const opening = from
    ? await db.journalLine.aggregate({
        where: { accountId: account.id, entry: { date: { lt: from } } },
        _sum: { debit: true, credit: true },
      })
    : null;

  const lines = await db.journalLine.findMany({
    where: {
      accountId: account.id,
      entry: { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } },
    },
    orderBy: [{ entry: { date: "asc" } }, { entry: { entryNumber: "asc" } }, { sortOrder: "asc" }],
    select: {
      id: true, debit: true, credit: true, narration: true,
      company: { select: { id: true, companySeq: true, name: true } },
      entry: {
        select: {
          id: true, entryNumber: true, date: true, narration: true, source: true,
          documentId: true, paymentId: true,
        },
      },
    },
  });

  const sign = isDebitNatured(account.type) ? 1 : -1;
  let balance = opening ? round2((Number(opening._sum.debit ?? 0) - Number(opening._sum.credit ?? 0)) * sign) : 0;
  const openingBalance = balance;

  const rows = lines.map((l) => {
    const debit = Number(l.debit);
    const credit = Number(l.credit);
    balance = round2(balance + (debit - credit) * sign);
    return {
      id: l.id,
      entryId: l.entry.id,
      entryNumber: l.entry.entryNumber,
      date: l.entry.date,
      source: l.entry.source,
      narration: l.narration ?? l.entry.narration,
      party: l.company,
      documentId: l.entry.documentId,
      debit,
      credit,
      balance,
    };
  });

  return {
    account,
    openingBalance,
    rows,
    closingBalance: balance,
    totals: rows.reduce(
      (t, r) => ({ debit: round2(t.debit + r.debit), credit: round2(t.credit + r.credit) }),
      { debit: 0, credit: 0 },
    ),
  };
}

/** The journal — every entry, newest first, for browsing and for finding one to reverse. */
export async function listJournalEntries(params: {
  page: number;
  pageSize: number;
  source?: string;
  search?: string;
  from?: string;
  to?: string;
}) {
  const gate = await mayReadBooks();
  if (!gate.ok) throw new Error(gate.error);
  await requireModuleUser("accounting");
  const where = {
    ...(params.source ? { source: params.source as never } : {}),
    ...(params.from || params.to
      ? { date: { ...(params.from ? { gte: startOfDay(params.from) } : {}), ...(params.to ? { lte: endOfDay(params.to) } : {}) } }
      : {}),
    ...(params.search
      ? {
          OR: [
            { entryNumber: { contains: params.search, mode: "insensitive" as const } },
            { narration: { contains: params.search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.journalEntry.findMany({
      where,
      orderBy: [{ date: "desc" }, { entryNumber: "desc" }],
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      select: {
        id: true, entryNumber: true, date: true, narration: true, source: true, documentId: true,
        reversesId: true,
        reversedBy: { select: { id: true, entryNumber: true } },
        company: { select: { id: true, companySeq: true, name: true } },
        // `kind`, so an entry by the Automation account reads "Posted automatically" (src/lib/people.ts).
        createdBy: { select: { name: true, kind: true } },
        lines: {
          orderBy: { sortOrder: "asc" },
          select: {
            id: true, debit: true, credit: true, narration: true,
            account: { select: { id: true, code: true, name: true } },
            company: { select: { id: true, name: true } },
          },
        },
      },
    }),
    db.journalEntry.count({ where }),
  ]);

  return {
    rows: rows.map((e) => ({
      ...e,
      lines: e.lines.map((l) => ({ ...l, debit: Number(l.debit), credit: Number(l.credit) })),
      amount: round2(e.lines.reduce((t, l) => t + Number(l.debit), 0)),
    })),
    total,
  };
}

/** Where a system account lives, for linking a report row straight to its ledger. */
export async function systemAccountId(key: keyof typeof SYSTEM_ACCOUNTS) {
  await requireModuleUser("accounting");
  const row = await db.ledgerAccount.findUnique({ where: { systemKey: key }, select: { id: true } });
  return row?.id ?? null;
}

function sumTop(rows: AccountBalance[]) {
  // Only the roots, since rollUp has already folded each child into its parent — adding every row
  // would count the same amount once per level of the tree.
  return rows.filter((r) => r.parentId === null || !rows.some((o) => o.id === r.parentId)).reduce((t, r) => round2(t + r.balance), 0);
}

/**
 * Where a report's first day begins, in India — whatever the server's clock or the workspace's zone:
 * the books keep India's calendar. `setHours` on the parsed date used the process's zone: right on a
 * laptop in Pune, five and a half hours late on a server in UTC, and a day early in New York. An
 * unreadable date stays unreadable (Invalid Date), as before.
 */
function startOfDay(value: string) {
  return indiaClock.startOfDay(value) ?? new Date(NaN);
}

/**
 * The last millisecond of a report's last day, in India. Inclusive, because every caller here compares
 * with `lte`: the instant before the next Indian midnight (`indiaClock.endOfDay`).
 */
function endOfDay(value: string) {
  const next = indiaClock.endOfDay(value);
  return next ? new Date(next.getTime() - 1) : new Date(NaN);
}
