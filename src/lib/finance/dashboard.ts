import { db } from "@/lib/db";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/chart";
import { settleInvoice } from "@/lib/receivables";
import { bucketOf } from "@/lib/analytics/types";
import { financialYearBounds } from "@/lib/ledger/period";

/**
 * The finance headline figures, read off the ledger rather than recomputed.
 *
 * Every number here already exists somewhere: an invoice posts to income, a bill posts to expense,
 * a receipt moves cash. So these read the journal, which is the one place all of that has already
 * been reconciled — rather than summing invoices and bills and expense claims separately and
 * arriving at a fifth opinion about what the month was worth. If a figure here disagrees with the
 * P&L, the ledger is wrong, and that is a far more useful thing to discover than a dashboard that
 * quietly keeps its own books.
 */

export type Basis = "accrual" | "cash";

const money = (v: unknown) => Number(v ?? 0);

/**
 * The financial year containing a date, as Dates.
 *
 * Wrapping `financialYearBounds` rather than working it out again: that function is what the
 * accounting screens, the invoice numbering series and the GST returns already run on, and a
 * second definition of when the year starts is a dashboard that disagrees with every filing the
 * business makes. It returns ISO strings because that is what those callers want; this returns
 * Dates because a journal query needs them.
 */
export function fiscalYearOf(date: Date): { from: Date; to: Date; label: string } {
  const bounds = financialYearBounds(date);
  return {
    from: new Date(`${bounds.from}T00:00:00`),
    to: new Date(`${bounds.to}T23:59:59.999`),
    label: `FY ${bounds.label}`,
  };
}
/**
 * Which entries count on each basis, and — the part that is easy to get wrong — which lines.
 *
 * **Accrual** is the straightforward one: the income and expense accounts, netted. An invoice is
 * income the day it is raised, whether or not anybody has paid.
 *
 * **Cash** cannot be the same query with a filter on it, and my first attempt at it was wrong in a
 * way worth recording. Under double entry a receipt never touches an income account — it moves
 * money from receivables to the bank. So "income lines on payment entries" returns nothing, and
 * the card would have shown a confident zero rather than failing. Cash basis therefore reads the
 * *cash accounts* instead: money in is income, money out is expense, which is what a business
 * without deferred revenue means by the phrase.
 *
 * The consequence is that cash basis has no expense-account breakdown — money leaving the bank
 * does not say what it was for until the bill it settles is looked up. Top expenses is therefore
 * an accrual figure whatever the toggle says, and says so on the card.
 */
const CASH_SOURCES = ["PAYMENT", "EXPENSE", "PAYROLL"] as const;

const CASH_ACCOUNTS = [SYSTEM_ACCOUNTS.BANK, SYSTEM_ACCOUNTS.CASH, SYSTEM_ACCOUNTS.CHEQUES_IN_HAND];

type Line = {
  amount: number;
  type: string;
  accountName: string;
  at: Date;
};

async function incomeExpenseLines(from: Date, to: Date, basis: Basis): Promise<Line[]> {
  if (basis === "cash") {
    const rows = await db.journalLine.findMany({
      where: {
        account: { systemKey: { in: CASH_ACCOUNTS } },
        entry: { date: { gte: from, lte: to }, source: { in: [...CASH_SOURCES] } },
      },
      select: { debit: true, credit: true, account: { select: { name: true } }, entry: { select: { date: true } } },
    });

    // One journal line is either a receipt or a payment, never both, so each becomes a single
    // row on the side it belongs to.
    return rows.map((r) => {
      const inAmt = money(r.debit);
      const outAmt = money(r.credit);
      return {
        amount: inAmt > 0 ? inAmt : outAmt,
        type: inAmt > 0 ? "INCOME" : "EXPENSE",
        accountName: r.account.name,
        at: r.entry.date,
      };
    });
  }

  const rows = await db.journalLine.findMany({
    where: {
      account: { type: { in: ["INCOME", "EXPENSE"] } },
      entry: { date: { gte: from, lte: to } },
    },
    select: {
      debit: true,
      credit: true,
      account: { select: { type: true, name: true } },
      entry: { select: { date: true } },
    },
  });

  return rows.map((r) => ({
    // Income is a credit balance and expense a debit one, so each is netted in its own
    // direction. Taking the absolute value instead would turn a credit note into extra revenue.
    amount:
      r.account.type === "INCOME" ? money(r.credit) - money(r.debit) : money(r.debit) - money(r.credit),
    type: r.account.type,
    accountName: r.account.name,
    at: r.entry.date,
  }));
}
export type IncomeExpense = {
  months: { key: string; label: string; income: number; expense: number }[];
  totalIncome: number;
  totalExpense: number;
  basis: Basis;
};

/** Income against expense, month by month, over whatever window is asked for. */
export async function incomeAndExpense(from: Date, to: Date, basis: Basis): Promise<IncomeExpense> {
  const lines = await incomeExpenseLines(from, to, basis);

  // Every month in the window, present or not. A fiscal year with a gap where March should be reads
  // as missing data; a March at zero reads as a quiet month, which is what it is.
  const months = new Map<string, { key: string; label: string; income: number; expense: number }>();
  for (let d = new Date(from.getFullYear(), from.getMonth(), 1); d <= to; d.setMonth(d.getMonth() + 1)) {
    const b = bucketOf(d, "month");
    months.set(b.key, { ...b, income: 0, expense: 0 });
  }

  for (const line of lines) {
    const slot = months.get(bucketOf(line.at, "month").key);
    if (!slot) continue;
    if (line.type === "INCOME") slot.income += line.amount;
    else slot.expense += line.amount;
  }

  const out = [...months.values()];
  return {
    months: out,
    totalIncome: round(out.reduce((t, m) => t + m.income, 0)),
    totalExpense: round(out.reduce((t, m) => t + m.expense, 0)),
    basis,
  };
}

/**
 * The biggest expense accounts in the window, largest first.
 *
 * Always accrual, and deliberately takes no basis argument. Money leaving the bank does not say
 * what it was for, so there is no cash-basis version of this breakdown to offer — and a function
 * that accepted the parameter and ignored it would be a lie with a signature.
 */
export async function topExpenses(from: Date, to: Date, limit = 6) {
  const lines = (await incomeExpenseLines(from, to, "accrual")).filter((l) => l.type === "EXPENSE");

  const byAccount = new Map<string, number>();
  for (const l of lines) byAccount.set(l.accountName, (byAccount.get(l.accountName) ?? 0) + l.amount);

  return [...byAccount.entries()]
    // A credit-balance expense account is a refund, not a cost, and has no place in "top expenses".
    .filter(([, amount]) => amount > 0)
    .map(([name, amount]) => ({ name, amount: round(amount) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
}

export type CashFlow = {
  points: { key: string; label: string; balance: number }[];
  opening: number;
  incoming: number;
  outgoing: number;
  closing: number;
};

/**
 * What the bank and cash accounts did over the window.
 *
 * The opening balance is everything posted before the window, not a stored figure — a stored one is
 * a number that has to be maintained, and the first time somebody back-dates an entry it is wrong
 * with nothing to indicate it. Summing the history costs a query and cannot drift.
 */
export async function cashFlow(from: Date, to: Date): Promise<CashFlow> {
  const cashAccounts = {
    account: {
      systemKey: { in: [SYSTEM_ACCOUNTS.BANK, SYSTEM_ACCOUNTS.CASH, SYSTEM_ACCOUNTS.CHEQUES_IN_HAND] },
    },
  };

  const [before, during] = await Promise.all([
    db.journalLine.aggregate({
      where: { ...cashAccounts, entry: { date: { lt: from } } },
      _sum: { debit: true, credit: true },
    }),
    db.journalLine.findMany({
      where: { ...cashAccounts, entry: { date: { gte: from, lte: to } } },
      select: { debit: true, credit: true, entry: { select: { date: true } } },
      orderBy: { entry: { date: "asc" } },
    }),
  ]);

  // Cash is an asset: debits increase it, credits reduce it.
  const opening = round(money(before._sum.debit) - money(before._sum.credit));

  const months = new Map<string, { key: string; label: string; delta: number }>();
  for (let d = new Date(from.getFullYear(), from.getMonth(), 1); d <= to; d.setMonth(d.getMonth() + 1)) {
    const b = bucketOf(d, "month");
    months.set(b.key, { ...b, delta: 0 });
  }

  let incoming = 0;
  let outgoing = 0;
  for (const line of during) {
    const inAmt = money(line.debit);
    const outAmt = money(line.credit);
    incoming += inAmt;
    outgoing += outAmt;
    const slot = months.get(bucketOf(line.entry.date, "month").key);
    if (slot) slot.delta += inAmt - outAmt;
  }

  // Running balance, so the line shows where the money got to rather than what moved each month —
  // the second is a different chart and answers a different question.
  const points = [...months.values()].reduce<CashFlow["points"]>((acc, m) => {
    const previous = acc.length === 0 ? opening : acc[acc.length - 1]!.balance;
    return [...acc, { key: m.key, label: m.label, balance: round(previous + m.delta) }];
  }, []);

  return {
    points,
    opening,
    incoming: round(incoming),
    outgoing: round(outgoing),
    closing: points.length === 0 ? opening : points[points.length - 1]!.balance,
  };
}

export type Outstanding = { total: number; current: number; overdue: number; count: number };

/**
 * What is owed, split by whether it is late yet.
 *
 * Balance rather than face value: an invoice half paid is half outstanding, and the settlement
 * arithmetic — payments, credit notes, and never going below zero on an overpayment — already lives
 * in `settleInvoice`. Reimplementing it here is how two screens come to disagree about a debt.
 */
async function outstandingOf(docType: "INVOICE" | "BILL", direction: "SALES" | "PURCHASE"): Promise<Outstanding> {
  const asOf = new Date();
  const rows = await db.tradeDocument.findMany({
    where: { docType, direction, status: { notIn: ["DRAFT", "CANCELLED", "PAID"] } },
    select: {
      total: true,
      dueDate: true,
      issueDate: true,
      payments: { select: { amount: true } },
      creditsReceived: { select: { amount: true } },
    },
  });

  let current = 0;
  let overdue = 0;
  let count = 0;
  for (const row of rows) {
    const { balance } = settleInvoice(
      money(row.total),
      row.payments.reduce((t, p) => t + money(p.amount), 0),
      row.creditsReceived.reduce((t, c) => t + money(c.amount), 0),
    );
    if (balance <= 0) continue;
    count += 1;
    const due = new Date(row.dueDate ?? row.issueDate);
    if (due < asOf) overdue += balance;
    else current += balance;
  }

  return { total: round(current + overdue), current: round(current), overdue: round(overdue), count };
}

export const receivablesOutstanding = () => outstandingOf("INVOICE", "SALES");
export const payablesOutstanding = () => outstandingOf("BILL", "PURCHASE");

const round = (n: number) => Math.round(n * 100) / 100;
