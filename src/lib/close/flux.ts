import type { AccountType, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { addMonths, monthKeyOf, monthLabel, monthWindow } from "@/lib/close/months";
import { round2 } from "@/lib/close/checks";
import { readCloseSettings } from "@/lib/close/settings";

/**
 * Flux analysis (spec §4.4): how every account moved this month against last month and the same month
 * last year, and which movements are large enough that somebody should say why.
 *
 * The P&L compares **movements** — what the account did in the month. The balance sheet compares
 * **closing balances** at the three month ends. Both are summed from the journal with `groupBy` over India
 * month bounds (half-open), as the cash flow statement is. The year-end closing entry is left out of the
 * P&L movements: it zeroes every income and expense account on 31 March, and March would otherwise read
 * as the month everything stopped.
 *
 * A row is flagged when its change against last month is at least the percentage **and** at least the
 * amount in the close settings — both, so a ₹300 account doubling and a ₹5 crore account moving 1% are
 * both quiet. A change from nothing is an infinite percentage, so only the amount decides it.
 */

export type FluxStatement = "PL" | "BS";

export type FluxRow = {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  statement: FluxStatement;
  active: boolean;
  /** P&L: the month's movement; balance sheet: the closing balance. In the account's natural direction. */
  current: number;
  previous: number;
  lastYear: number;
  /** current − previous, and as a percentage of |previous| (null when previous is 0). */
  changePrev: number;
  changePrevPct: number | null;
  /** current − lastYear, likewise. */
  changeYear: number;
  changeYearPct: number | null;
  flagged: boolean;
  note: { explanation: string; byId: string; byName: string; at: Date } | null;
};

export type FluxReport = {
  month: string;
  label: string;
  thresholds: { percent: number; amount: number };
  rows: FluxRow[];
  flagged: number;
  explained: number;
};

/** Debit-natured accounts (assets, expenses) read debit − credit; the rest credit − debit. */
export function naturalBalance(type: AccountType, debit: number, credit: number): number {
  return round2(type === "ASSET" || type === "EXPENSE" ? debit - credit : credit - debit);
}

export function statementOf(type: AccountType): FluxStatement {
  return type === "INCOME" || type === "EXPENSE" ? "PL" : "BS";
}

/** A change as a percentage of where it started; null from nothing. */
export function percentChange(from: number, to: number): number | null {
  if (Math.abs(from) < 0.005) return null;
  return round2(((to - from) / Math.abs(from)) * 100);
}

/**
 * At least the percentage and at least the amount. A change from nothing passes the percentage by
 * definition. Compared unrounded — |change| × 100 against percent × |previous| — so a change of exactly
 * 20% is 20%, and 19.996% is not rounded up into it.
 */
export function isFlagged(change: number, previous: number, thresholds: { percent: number; amount: number }): boolean {
  if (Math.abs(change) < 0.005) return false;
  if (Math.abs(change) + 1e-9 < thresholds.amount) return false;
  if (Math.abs(previous) < 0.005) return true;
  return Math.abs(change) * 100 + 1e-9 >= thresholds.percent * Math.abs(previous);
}

export type FluxFigures = { accountId: string; type: AccountType; current: number; previous: number; lastYear: number };

/** The comparison for one account's three figures — pure. */
export function fluxFigures(f: FluxFigures, thresholds: { percent: number; amount: number }) {
  const changePrev = round2(f.current - f.previous);
  const changeYear = round2(f.current - f.lastYear);
  const changePrevPct = percentChange(f.previous, f.current);
  return {
    changePrev,
    changePrevPct,
    changeYear,
    changeYearPct: percentChange(f.lastYear, f.current),
    flagged: isFlagged(changePrev, f.previous, thresholds),
  };
}

type Sums = { accountId: string; _sum: { debit: Prisma.Decimal | null; credit: Prisma.Decimal | null } }[];

/** The flux table for a month: every non-group account, P&L and balance sheet. */
export async function fluxFor(month: Date, opts: { thresholds?: { percent: number; amount: number } } = {}): Promise<FluxReport> {
  const settings = opts.thresholds ? null : await readCloseSettings();
  const thresholds = opts.thresholds ?? { percent: settings!.fluxPercent, amount: settings!.fluxAmount };
  const months = [month, addMonths(month, -1), addMonths(month, -12)];
  const windows = months.map(monthWindow);

  const accounts = await db.ledgerAccount.findMany({
    where: { isGroup: false },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true, type: true, active: true },
  });
  const plIds = accounts.filter((a) => statementOf(a.type) === "PL").map((a) => a.id);
  const bsIds = accounts.filter((a) => statementOf(a.type) === "BS").map((a) => a.id);

  const movement = (w: { from: Date; to: Date }) =>
    db.journalLine.groupBy({
      by: ["accountId"],
      where: { accountId: { in: plIds }, entry: { date: { gte: w.from, lt: w.to }, source: { not: "CLOSING" } } },
      _sum: { debit: true, credit: true },
    });
  const closing = (w: { from: Date; to: Date }) =>
    db.journalLine.groupBy({
      by: ["accountId"],
      where: { accountId: { in: bsIds }, entry: { date: { lt: w.to } } },
      _sum: { debit: true, credit: true },
    });

  const [pl, bs, notes] = await Promise.all([
    Promise.all(windows.map(movement)),
    Promise.all(windows.map(closing)),
    db.fluxNote.findMany({
      where: { month },
      select: { accountId: true, explanation: true, byId: true, at: true, by: { select: { name: true } } },
    }),
  ]);

  const valueOf = (rows: Sums, id: string, type: AccountType) => {
    const row = rows.find((r) => r.accountId === id);
    return naturalBalance(type, Number(row?._sum.debit ?? 0), Number(row?._sum.credit ?? 0));
  };
  const noteOf = new Map(notes.map((n) => [n.accountId, n]));

  const rows: FluxRow[] = accounts.map((a) => {
    const source = statementOf(a.type) === "PL" ? pl : bs;
    const figures = {
      accountId: a.id,
      type: a.type,
      current: valueOf(source[0] as Sums, a.id, a.type),
      previous: valueOf(source[1] as Sums, a.id, a.type),
      lastYear: valueOf(source[2] as Sums, a.id, a.type),
    };
    const note = noteOf.get(a.id);
    return {
      accountId: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      statement: statementOf(a.type),
      active: a.active,
      current: figures.current,
      previous: figures.previous,
      lastYear: figures.lastYear,
      ...fluxFigures(figures, thresholds),
      note: note ? { explanation: note.explanation, byId: note.byId, byName: note.by.name, at: note.at } : null,
    };
  });

  const flaggedRows = rows.filter((r) => r.flagged);
  return {
    month: monthKeyOf(month),
    label: monthLabel(month),
    thresholds,
    rows,
    flagged: flaggedRows.length,
    explained: flaggedRows.filter((r) => r.note).length,
  };
}

/** Writes (or rewrites) the explanation for an account's month. */
export async function writeFluxNote(input: { month: Date; accountId: string; explanation: string; userId: string }) {
  return db.fluxNote.upsert({
    where: { month_accountId: { month: input.month, accountId: input.accountId } },
    create: { month: input.month, accountId: input.accountId, explanation: input.explanation, byId: input.userId },
    update: { explanation: input.explanation, byId: input.userId, at: new Date() },
    select: { id: true },
  });
}
