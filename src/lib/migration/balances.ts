import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeEntry } from "@/lib/ledger/journal";
import { readHeadings } from "@/lib/portability/import";
import { RowReader, parseNumber } from "@/lib/portability/importers/types";
import { afterMonth, asDate, migrationMonths, monthEnd, MigrationRefused, type MigrationRow } from "./state";

/**
 * The month-end check (src/lib/migration): the old system's trial balance at each month end, against what
 * Deskzo's own books say at the same moment. A migration is finished only when every month agrees, account by
 * account, to the rupee — or a difference is covered by an adjustment somebody made, with a reason.
 *
 * The old balances come from one file (a Month column), or one file a month (the month chosen as it's
 * uploaded); uploading a month again replaces it. Accounts are found by code, else by name — as the opening
 * import finds them. Deskzo's side is every journal line dated before the next month starts, India time:
 * the opening entry, the migrated documents and payments, the adjustments, and anything else posted.
 */

export const BALANCE_COLUMNS = { month: "Month", code: "Account code", account: "Account", debit: "Debit", credit: "Credit", balance: "Balance" } as const;
const B = BALANCE_COLUMNS;
const ALIASES: Record<string, string[]> = {
  [B.month]: ["Period", "Month End", "As Of", "As On", "Date"],
  [B.code]: ["Code", "Ledger Code", "GL Code", "Account No", "Account Code"],
  [B.account]: ["Account Name", "Ledger", "Ledger Name", "Particulars", "Account Head"],
  [B.debit]: ["Dr", "Debit Amount", "Net Debit", "Debit Balance", "Closing Debit"],
  [B.credit]: ["Cr", "Credit Amount", "Net Credit", "Credit Balance", "Closing Credit"],
  [B.balance]: ["Closing Balance", "Net Balance"],
};
export const balanceHeadings = { templateColumns: Object.values(B) as string[], headerAliases: ALIASES };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** "2026-04", "Apr 2026", "April 2026", "30/04/2026", "2026-04-30" → "2026-04"; null when it isn't one. */
export function monthOf(text: string): string | null {
  const t = text.trim().toLowerCase();
  let m = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(t);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}`;
  m = /^([a-z]{3,9})[\s,'-]+(\d{2,4})$/.exec(t);
  if (m) {
    const idx = MONTHS.indexOf(m[1]!.slice(0, 3));
    const year = m[2]!.length === 2 ? `20${m[2]}` : m[2];
    if (idx >= 0) return `${year}-${String(idx + 1).padStart(2, "0")}`;
  }
  return null;
}

export type BalanceUpload = { months: string[]; accounts: number; failed: { line: number; error: string }[] };

/**
 * Reads a trial balance file into the migration's month-end balances. Every row must be usable, or nothing is
 * kept: half a trial balance compared is a list of differences that aren't.
 */
export async function uploadBalances(m: MigrationRow, fileRows: Record<string, string>[], chosenMonth: string | null): Promise<BalanceUpload> {
  if (m.status !== "OPEN") throw new MigrationRefused("The migration isn't open.");
  const months = migrationMonths(m);
  const { rows } = readHeadings(balanceHeadings, fileRows);
  const accounts = await db.ledgerAccount.findMany({ select: { id: true, code: true, name: true, isGroup: true } });
  const sums = new Map<string, number>();
  const failed: BalanceUpload["failed"] = [];
  rows.forEach((row, i) => {
    const line = i + 2;
    const r = new RowReader(row);
    const code = r.text(B.code);
    const name = r.text(B.account);
    if (!code && (!name || /^(grand\s+)?total\b/i.test(name))) return;
    const monthCell = r.text(B.month);
    const month = monthCell ? monthOf(monthCell) : chosenMonth;
    if (!month) return void failed.push({ line, error: monthCell ? `${B.month} "${monthCell}" isn't a month — write it as 2026-04 or Apr 2026.` : "Which month is it? Add a Month column, or choose the month as you upload." });
    if (!months.includes(month)) return void failed.push({ line, error: `${month} isn't a month being brought across (${months[0]} to ${months[months.length - 1]}).` });
    let debit = r.number(B.debit) ?? 0;
    let credit = r.number(B.credit) ?? 0;
    if (r.error) return void failed.push({ line, error: r.error });
    const balanceText = r.text(B.balance).trim();
    if (balanceText && !debit && !credit) {
      const side = /\b(dr|cr)\.?\s*$/i.exec(balanceText)?.[1]?.toLowerCase();
      const parsed = parseNumber(B.balance, balanceText.replace(/\b(dr|cr)\.?\s*$/i, ""));
      if (parsed.error || parsed.value === undefined) return void failed.push({ line, error: parsed.error ?? `${B.balance} "${balanceText}" isn't an amount.` });
      const value = side === "cr" ? -Math.abs(parsed.value) : side === "dr" ? Math.abs(parsed.value) : parsed.value;
      if (value >= 0) debit = value;
      else credit = -value;
    }
    if (!debit && !credit) return;
    const byCode = code ? accounts.find((a) => a.code.toLowerCase() === code.toLowerCase()) : undefined;
    const byName = !byCode && name ? accounts.filter((a) => a.name.toLowerCase() === name.toLowerCase()) : [];
    if (byName.length > 1) return void failed.push({ line, error: `More than one account is called "${name}" — give its ${B.code}.` });
    const account = byCode ?? byName[0];
    if (!account) return void failed.push({ line, error: `No account ${code ? `with code "${code}"` : `called "${name}"`}. Import your chart of accounts first, or correct it.` });
    if (account.isGroup) return void failed.push({ line, error: `${account.name} is a group — give the accounts under it, as the trial balance lists them.` });
    const key = `${month}|${account.id}`;
    sums.set(key, round2((sums.get(key) ?? 0) + debit - credit));
  });
  if (failed.length) return { months: [], accounts: 0, failed };
  const touched = [...new Set([...sums.keys()].map((k) => k.split("|")[0]!))];
  if (touched.length === 0) return { months: [], accounts: 0, failed: [{ line: 1, error: "There are no balances in that file." }] };
  await db.$transaction(async (tx) => {
    await tx.migrationBalance.deleteMany({ where: { migrationId: m.id, month: { in: touched } } });
    await tx.migrationBalance.createMany({
      data: [...sums].map(([key, balance]) => {
        const [month, accountId] = key.split("|") as [string, string];
        return { migrationId: m.id, month, accountId, balance: new Prisma.Decimal(balance) };
      }),
    });
  });
  return { months: touched.sort(), accounts: new Set([...sums.keys()].map((k) => k.split("|")[1])).size, failed: [] };
}

export type AccountDifference = { accountId: string; code: string; name: string; deskzo: number; old: number; difference: number };
export type MonthCheck = { month: string; uploaded: boolean; agrees: boolean; differences: AccountDifference[]; accounts: number };

/** Every month's comparison, in order. */
export async function compareMonths(m: MigrationRow): Promise<MonthCheck[]> {
  const months = migrationMonths(m);
  const [accounts, uploaded] = await Promise.all([
    db.ledgerAccount.findMany({ select: { id: true, code: true, name: true } }),
    db.migrationBalance.findMany({ where: { migrationId: m.id }, select: { month: true, accountId: true, balance: true } }),
  ]);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const out: MonthCheck[] = [];
  for (const month of months) {
    const old = new Map(uploaded.filter((u) => u.month === month).map((u) => [u.accountId, Number(u.balance)]));
    if (old.size === 0) {
      out.push({ month, uploaded: false, agrees: false, differences: [], accounts: 0 });
      continue;
    }
    const grouped = await db.journalLine.groupBy({ by: ["accountId"], where: { entry: { date: { lt: afterMonth(month) } } }, _sum: { debit: true, credit: true } });
    const here = new Map(grouped.map((g) => [g.accountId, round2(Number(g._sum.debit ?? 0) - Number(g._sum.credit ?? 0))]));
    const differences: AccountDifference[] = [];
    for (const accountId of new Set([...old.keys(), ...here.keys()])) {
      const deskzo = here.get(accountId) ?? 0;
      const theirs = old.get(accountId) ?? 0;
      const difference = round2(deskzo - theirs);
      if (Math.abs(difference) >= 1) {
        const a = byId.get(accountId);
        differences.push({ accountId, code: a?.code ?? "", name: a?.name ?? "(an account no longer here)", deskzo, old: theirs, difference });
      }
    }
    differences.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
    out.push({ month, uploaded: true, agrees: differences.length === 0, differences, accounts: old.size });
  }
  return out;
}

/**
 * An adjustment for a difference that can't be fixed in the files: one balanced entry on the month's last day,
 * between the two accounts it moves, with the reason in its narration — recorded against the migration, listed
 * on its page, and taken back by Undo like everything else it made.
 */
export async function addAdjustment(m: MigrationRow, input: { month: unknown; debitAccountId: unknown; creditAccountId: unknown; amount: unknown; reason: unknown }, userId: string): Promise<{ entryNumber: string }> {
  if (m.status !== "OPEN") throw new MigrationRefused("The migration isn't open.");
  const month = typeof input.month === "string" ? input.month : "";
  if (!migrationMonths(m).includes(month)) throw new MigrationRefused("Choose a month being brought across.");
  const debitAccountId = typeof input.debitAccountId === "string" ? input.debitAccountId : "";
  const creditAccountId = typeof input.creditAccountId === "string" ? input.creditAccountId : "";
  if (!debitAccountId || !creditAccountId || debitAccountId === creditAccountId) throw new MigrationRefused("Choose two different accounts: the one to debit and the one to credit.");
  const amount = typeof input.amount === "number" ? input.amount : Number(String(input.amount ?? "").replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) throw new MigrationRefused("The amount must be more than 0.");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 5) throw new MigrationRefused("Say why — the reason is kept with the adjustment.");
  const accounts = await db.ledgerAccount.findMany({ where: { id: { in: [debitAccountId, creditAccountId] } }, select: { id: true, isGroup: true, active: true } });
  if (accounts.length !== 2 || accounts.some((a) => a.isGroup || !a.active)) throw new MigrationRefused("Both accounts must be open accounts that take postings, not groups.");

  const count = await db.migrationRecord.count({ where: { migrationId: m.id, kind: "journal", key: { startsWith: "ADJUSTMENT:" } } });
  return db.$transaction(async (tx) => {
    const entry = await writeEntry(tx, {
      date: asDate(monthEnd(month)),
      narration: `Migration adjustment — ${reason.slice(0, 300)}`,
      source: "MANUAL",
      userId,
      lines: [
        { accountId: debitAccountId, debit: round2(amount), credit: 0 },
        { accountId: creditAccountId, debit: 0, credit: round2(amount) },
      ],
    });
    await tx.migrationRecord.create({ data: { migrationId: m.id, kind: "journal", recordId: entry.id, key: `ADJUSTMENT:${count + 1}` } });
    return { entryNumber: entry.entryNumber };
  });
}

/** The adjustments made so far, newest first. */
export async function listAdjustments(m: MigrationRow) {
  const records = await db.migrationRecord.findMany({ where: { migrationId: m.id, kind: "journal", key: { startsWith: "ADJUSTMENT:" } }, select: { recordId: true } });
  if (records.length === 0) return [];
  const entries = await db.journalEntry.findMany({
    where: { id: { in: records.map((r) => r.recordId) } },
    orderBy: { createdAt: "desc" },
    select: { id: true, entryNumber: true, date: true, narration: true, lines: { select: { debit: true, credit: true, account: { select: { code: true, name: true } } } } },
  });
  return entries.map((e) => ({
    id: e.id,
    entryNumber: e.entryNumber,
    date: e.date.toISOString().slice(0, 10),
    reason: e.narration.replace(/^Migration adjustment — /, ""),
    debit: e.lines.find((l) => Number(l.debit) > 0)?.account ?? null,
    credit: e.lines.find((l) => Number(l.credit) > 0)?.account ?? null,
    amount: Number(e.lines.find((l) => Number(l.debit) > 0)?.debit ?? 0),
  }));
}
