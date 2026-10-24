import type { VoucherLineInput } from "@/lib/accounts/vouchers";
import { db } from "@/lib/db";
import { RowReader } from "@/lib/portability/importers/types";
import { leftBehind, type UnitOutcome } from "./documents";
import { alreadyBrought, type LedgerUnit } from "./expenses";
import { findParty, voucherLinesProblem, voucherTypeOf, writeMigratedVoucher, type StepContext } from "./ledger";

/**
 * A migrated year's manual journals (src/lib/migration): provisions, reclassifications, bank charges, owner's
 * drawings, transfers between the company's own accounts — whatever the old system's accountant wrote by
 * hand. Each comes across as a voucher of the kind its lines make it (a journal, or a payment, receipt or
 * contra when money moved) on its own date, numbered in Deskzo's series, the old number kept as its reference.
 *
 *   · **One row a line**, as Zoho Books exports journals: rows sharing a journal number are one journal.
 *   · **Accounts** by code or name; a line on Receivables or Payables names its **contact**, which must be in
 *     Deskzo — as it must on a voucher typed in.
 *   · A journal that doesn't balance is refused with both sides' totals. Draft ones stay behind.
 *
 * Anything the old system posted that no other file brings — a fund transfer, a deposit, an inventory
 * adjustment — can be written into this file as a journal, so the months agree.
 */

export const JOURNAL_COLUMNS = {
  number: "Journal number",
  date: "Date",
  reference: "Reference",
  notes: "Notes",
  status: "Status",
  accountCode: "Account code",
  account: "Account",
  description: "Description",
  contact: "Contact",
  debit: "Debit",
  credit: "Credit",
} as const;
const J = JOURNAL_COLUMNS;

const ALIASES: Record<string, string[]> = {
  [J.number]: ["Journal Number", "Journal#", "Journal No", "Entry Number", "Voucher Number", "Voucher No"],
  [J.date]: ["Journal Date", "Entry Date", "Voucher Date"],
  [J.reference]: ["Reference Number", "Reference#", "Reference No"],
  [J.notes]: ["Journal Notes", "Narration", "Memo"],
  [J.status]: ["Journal Status"],
  [J.accountCode]: ["Account Code", "GL Code", "Ledger Code"],
  [J.account]: ["Account Name", "Ledger", "Ledger Name", "Particulars"],
  [J.description]: ["Line Description", "Line Notes"],
  [J.contact]: ["Contact Name", "Customer Name", "Vendor Name", "Party", "Party Name"],
  [J.debit]: ["Debits", "Dr", "Debit Amount"],
  [J.credit]: ["Credits", "Cr", "Credit Amount"],
};

export const journalHeadings = { templateColumns: Object.values(J) as string[], headerAliases: ALIASES };
export const journalColumns = (): string[] => Object.values(J);

/** Rows sharing a journal number, in file order; a row with no number belongs to the journal above it. */
export function journalUnits(rows: Record<string, string>[]): LedgerUnit[] {
  const units: LedgerUnit[] = [];
  const byNumber = new Map<string, LedgerUnit>();
  rows.forEach((row, i) => {
    const line = i + 2;
    const number = (row[J.number] ?? "").trim();
    const unit = number ? byNumber.get(number) : units[units.length - 1];
    if (unit) return void unit.rows.push({ line, row });
    const made: LedgerUnit = { key: number ? `JOURNAL:${number}` : "", label: number || `Row ${line}`, firstLine: line, rows: [{ line, row }] };
    units.push(made);
    if (number) byNumber.set(number, made);
  });
  return units;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Ready = { day: string; narration: string; reference: string; companyId: string | null; lines: VoucherLineInput[]; amount: number; kind: string };

async function resolveJournal(unit: LedgerUnit, ctx: StepContext): Promise<{ error: string; line?: number } | { skip: string } | Ready> {
  const head = new RowReader(unit.rows[0]!.row, ctx.clock);
  const behind = leftBehind(head.text(J.status));
  if (behind) return { skip: behind };
  if (!unit.key) return { error: `${J.number} is required — each journal keeps the number it had.` };
  if (await alreadyBrought(ctx.migrationId, unit.key)) return { skip: "already brought across" };
  const date = head.date(J.date);
  if (head.error) return { error: head.error };
  if (!date) return { error: `${J.date} is required.` };
  const day = date.toISOString().slice(0, 10);
  if (day < ctx.window.from || day >= ctx.window.to) return { error: `It's dated ${day}, outside the year being brought across (${ctx.window.from} to the day before ${ctx.window.to}).` };

  const ledger = await ctx.ledger();
  const lines: VoucherLineInput[] = [];
  const contacts = new Set<string>();
  for (const { line, row } of unit.rows) {
    const r = new RowReader(row, ctx.clock);
    const debit = r.number(J.debit) ?? 0;
    const credit = r.number(J.credit) ?? 0;
    if (r.error) return { error: r.error, line };
    if (debit < 0 || credit < 0) return { error: `${J.debit} and ${J.credit} can't be negative.`, line };
    const net = round2(debit - credit);
    if (net === 0) continue;
    const text = r.text(J.accountCode) || r.text(J.account);
    if (!text) return { error: `${J.account} is required on every line.`, line };
    const account = ledger.chart.find(text);
    if ("error" in account) return { error: account.error, line };
    const contactName = r.text(J.contact);
    const contact = contactName ? await findParty(contactName) : null;
    if (contactName && !contact) return { error: `No contact named "${contactName}". Import Companies or Vendors first, or correct the spelling.`, line };
    if (contact) contacts.add(contact.id);
    lines.push({ accountId: account.id, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0, companyId: contact?.id ?? null, narration: r.text(J.description).slice(0, 200) || null });
  }
  if (lines.length < 2) return { error: "A journal needs at least two lines with an amount." };
  const debits = round2(lines.reduce((t, l) => t + l.debit, 0));
  const credits = round2(lines.reduce((t, l) => t + l.credit, 0));
  if (debits !== credits) return { error: `It doesn't balance: debits ${rupees(debits)}, credits ${rupees(credits)}.` };
  const problem = voucherLinesProblem(lines, ledger);
  if (problem) return { error: problem };

  const number = unit.key.slice("JOURNAL:".length);
  const type = voucherTypeOf(lines, ledger.chart);
  return {
    day,
    narration: head.text(J.notes) || `Journal ${number} from the old system`,
    reference: [number, head.text(J.reference)].filter(Boolean).join(" · "),
    companyId: contacts.size === 1 ? [...contacts][0]! : null,
    lines,
    amount: debits,
    kind: type ? `${type.toLowerCase()} voucher` : "journal entry",
  };
}

export async function checkJournal(unit: LedgerUnit, ctx: StepContext): Promise<UnitOutcome> {
  const r = await resolveJournal(unit, ctx);
  if ("error" in r) return { kind: "error", label: unit.label, line: r.line ?? unit.firstLine, error: r.error };
  if ("skip" in r) return { kind: "skip", label: unit.label, why: r.skip };
  return { kind: "create", label: `${unit.label} · ${r.narration.slice(0, 60)}`, detail: `${r.day} · ${r.lines.length} lines · ${rupees(r.amount)} · as a ${r.kind}` };
}

export async function applyJournal(unit: LedgerUnit, ctx: StepContext): Promise<UnitOutcome> {
  const r = await resolveJournal(unit, ctx);
  if ("error" in r) return { kind: "error", label: unit.label, line: r.line ?? unit.firstLine, error: r.error };
  if ("skip" in r) return { kind: "skip", label: unit.label, why: r.skip };
  const ledger = await ctx.ledger();
  let number = "";
  try {
    await db.$transaction(async (tx) => {
      const made = await writeMigratedVoucher(tx, { day: r.day, narration: r.narration, reference: r.reference, companyId: r.companyId, lines: r.lines, userId: ctx.userId, ledger });
      number = made.number;
      await tx.migrationRecord.create({ data: { migrationId: ctx.migrationId, kind: made.kind, recordId: made.id, key: unit.key } });
    });
  } catch (err) {
    return { kind: "error", label: unit.label, line: unit.firstLine, error: err instanceof Error ? err.message : "It couldn't be posted." };
  }
  return { kind: "create", label: `${unit.label} · ${r.narration.slice(0, 60)}`, detail: `${number} · ${rupees(r.amount)}` };
}
