import type { VoucherLineInput } from "@/lib/accounts/vouchers";
import { db } from "@/lib/db";
import { RowReader } from "@/lib/portability/importers/types";
import { leftBehind, type UnitOutcome } from "./documents";
import { findParty, splitInputTax, stateCodeOf, vendorStateCode, voucherLinesProblem, writeMigratedVoucher, type StepContext } from "./ledger";

/**
 * A migrated year's expenses (src/lib/migration): what was paid without a bill — rent by bank transfer, a
 * taxi in cash, a card subscription — each written as Deskzo's own payment voucher on its date: the expense
 * account it went to, the input tax it carried, and the account it was paid through. One paid through an
 * account that isn't bank or cash (a credit card's liability, an employee to reimburse) is a journal voucher.
 *
 *   · **One row an expense**, as Zoho Books exports them; rows sharing an Expense ID are one itemised expense.
 *   · **The amount** is before tax, or with tax when the file says it's inclusive; the tax is the file's
 *     amount, else its rate. CGST and SGST, or IGST when the vendor's state (the file's, else the vendor's
 *     own) isn't ours.
 *   · **The vendor** is named on the voucher when it's in Deskzo; an unknown one is kept in the narration, not
 *     refused — expenses are often from people who were never set up as vendors.
 *   · Without an ID, an expense is known by its date, account, amount and reference — so the same file again
 *     brings nothing twice, and two alike on one day are two.
 */

export const EXPENSE_COLUMNS = {
  id: "Expense ID",
  date: "Date",
  accountCode: "Account code",
  account: "Expense account",
  paidThrough: "Paid through",
  vendor: "Vendor",
  amount: "Amount",
  inclusive: "Tax inclusive",
  tax: "Tax %",
  taxAmount: "Tax amount",
  supply: "Source of supply",
  total: "Total",
  reference: "Reference",
  description: "Description",
  status: "Status",
} as const;
const E = EXPENSE_COLUMNS;

const ALIASES: Record<string, string[]> = {
  [E.id]: ["Expense Reference ID", "Expense Number", "Expense#", "Expense No", "Entity ID"],
  [E.date]: ["Expense Date"],
  [E.accountCode]: ["Account Code", "GL Code"],
  [E.account]: ["Expense Account Name", "Account", "Account Name", "Category", "Expense Category"],
  [E.paidThrough]: ["Paid Through Account", "Paid From", "Payment Account", "Paid Through Account Name"],
  [E.vendor]: ["Vendor Name", "Merchant", "Merchant Name", "Supplier"],
  [E.amount]: ["Expense Amount", "Amount (BCY)", "Sub Total"],
  [E.inclusive]: ["Is Inclusive Tax", "Amount Is Tax Inclusive", "Tax Inclusive?", "Inclusive of Tax"],
  [E.tax]: ["Tax Percentage", "GST %", "GST Rate", "Tax Rate"],
  [E.taxAmount]: ["GST Amount", "Tax"],
  [E.supply]: ["Source Of Supply", "Place of Supply", "Vendor State"],
  [E.total]: ["Total Amount", "Expense Total", "Grand Total"],
  [E.reference]: ["Reference#", "Reference Number", "Reference No", "Bill Number", "Invoice Number"],
  [E.description]: ["Notes", "Expense Description", "Memo", "Narration"],
  [E.status]: ["Expense Status"],
};

export const expenseHeadings = { templateColumns: Object.values(E) as string[], headerAliases: ALIASES };
export const expenseColumns = (): string[] => Object.values(E);

export type LedgerUnit = { key: string; label: string; firstLine: number; rows: { line: number; row: Record<string, string> }[] };

/** Rows sharing an Expense ID are one; a row without is its own, known by what it says (the nth alike, if more than one). */
export function expenseUnits(rows: Record<string, string>[]): LedgerUnit[] {
  const units: LedgerUnit[] = [];
  const byId = new Map<string, LedgerUnit>();
  const alike = new Map<string, number>();
  rows.forEach((row, i) => {
    const line = i + 2;
    const id = (row[E.id] ?? "").trim();
    if (id) {
      const unit = byId.get(id);
      if (unit) return void unit.rows.push({ line, row });
      const made = { key: `EXPENSE:${id}`, label: id, firstLine: line, rows: [{ line, row }] };
      units.push(made);
      byId.set(id, made);
      return;
    }
    const says = [E.date, E.accountCode, E.account, E.amount, E.total, E.reference].map((c) => (row[c] ?? "").trim().toLowerCase()).join("|");
    if (!says.replace(/\|/g, "")) return;
    const n = (alike.get(says) ?? 0) + 1;
    alike.set(says, n);
    units.push({ key: `EXPENSE:${says}#${n}`, label: `Row ${line}`, firstLine: line, rows: [{ line, row }] });
  });
  return units;
}

/** Brought already — as a voucher, or as a plain entry when its lines weren't one. */
export async function alreadyBrought(migrationId: string, key: string) {
  return (await db.migrationRecord.count({ where: { migrationId, key, kind: { in: ["voucher", "journal"] } } })) > 0;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const YES = /^(y|yes|true|1|inclusive|tax inclusive)$/i;

type Ready = { day: string; narration: string; reference: string | null; companyId: string | null; lines: VoucherLineInput[]; total: number; paidThrough: string; accounts: string[] };

async function resolveExpense(unit: LedgerUnit, ctx: StepContext): Promise<{ error: string; line?: number } | { skip: string } | Ready> {
  const head = new RowReader(unit.rows[0]!.row, ctx.clock);
  const behind = leftBehind(head.text(E.status));
  if (behind) return { skip: behind };
  if (await alreadyBrought(ctx.migrationId, unit.key)) return { skip: "already brought across" };
  const date = head.date(E.date);
  if (head.error) return { error: head.error };
  if (!date) return { error: `${E.date} is required — the day it was paid.` };
  const day = date.toISOString().slice(0, 10);
  if (day < ctx.window.from || day >= ctx.window.to) return { error: `It's dated ${day}, outside the year being brought across (${ctx.window.from} to the day before ${ctx.window.to}).` };

  const ledger = await ctx.ledger();
  const throughText = head.text(E.paidThrough);
  if (!throughText) return { error: `${E.paidThrough} is required — the bank, cash or card account it was paid from.` };
  const through = ledger.chart.find(throughText);
  if ("error" in through) return { error: through.error };
  const vendorName = head.text(E.vendor);
  const vendor = vendorName ? await findParty(vendorName) : null;
  if (through.needsParty && !vendor) return { error: `It was paid through ${through.name}, which needs whose — give a ${E.vendor} that's in Deskzo.` };

  const debits = new Map<string, number>();
  const accounts: string[] = [];
  let tax = 0;
  for (const { line, row } of unit.rows) {
    const r = new RowReader(row, ctx.clock);
    const text = r.text(E.accountCode) || r.text(E.account);
    const amount = r.number(E.amount);
    const total = r.number(E.total);
    const rate = r.number(E.tax);
    const taxGiven = r.number(E.taxAmount);
    if (r.error) return { error: r.error, line };
    if (!text) return { error: `${E.account} is required — what the money was spent on.`, line };
    const account = ledger.chart.find(text);
    if ("error" in account) return { error: account.error, line };
    if (account.isMoney) return { error: `${account.name} is a bank or cash account — money between your own accounts goes in the journals file.`, line };
    if (amount === undefined && total === undefined) return { error: `${E.amount} is required.`, line };
    if ((rate !== undefined && (rate < 0 || rate > 100)) || (taxGiven !== undefined && taxGiven < 0)) return { error: `${E.tax} is 0 to 100, and ${E.taxAmount} can't be negative.`, line };
    const inclusive = YES.test(r.text(E.inclusive));
    // What it cost before tax, and the tax: the file's amount of tax, else its rate — on an amount with or without it.
    let lineTax: number;
    let base: number;
    const gross = amount !== undefined ? (inclusive ? amount : undefined) : total;
    if (taxGiven !== undefined) {
      lineTax = taxGiven;
      base = gross !== undefined ? gross - taxGiven : amount!;
    } else if (rate) {
      lineTax = gross !== undefined ? round2((gross * rate) / (100 + rate)) : round2((amount! * rate) / 100);
      base = gross !== undefined ? gross - lineTax : amount!;
    } else {
      lineTax = 0;
      base = gross ?? amount!;
    }
    base = round2(base);
    if (base <= 0) return { error: "It comes to nothing before tax — check the amount and the tax.", line };
    if (total !== undefined && amount !== undefined && Math.abs(base + lineTax - total) > 1) {
      return { error: `It comes to ${rupees(round2(base + lineTax))} with tax, but the file's ${E.total} is ${rupees(total)}. Check the amount, the tax, and whether it's tax inclusive.`, line };
    }
    debits.set(account.id, round2((debits.get(account.id) ?? 0) + base));
    if (!accounts.includes(account.name)) accounts.push(account.name);
    tax = round2(tax + lineTax);
  }

  const supply = head.text(E.supply);
  const vendorState = supply ? stateCodeOf(supply) : vendor ? await vendorStateCode(vendor.id) : null;
  if (supply && !vendorState) return { error: `${E.supply} "${supply}" isn't a state Deskzo knows — use its name or its two-digit GST code.` };
  const split = splitInputTax(tax, vendorState, ledger.head);
  const { chart } = ledger;
  const lines: VoucherLineInput[] = [
    ...[...debits.entries()].map(([accountId, amount]) => ({ accountId, debit: amount, credit: 0 })),
    { accountId: chart.system("INPUT_CGST").id, debit: split.cgst, credit: 0 },
    { accountId: chart.system("INPUT_SGST").id, debit: split.sgst, credit: 0 },
    { accountId: chart.system("INPUT_IGST").id, debit: split.igst, credit: 0 },
  ].filter((l) => l.debit > 0);
  const total = round2(lines.reduce((t, l) => t + l.debit, 0));
  lines.push({ accountId: through.id, debit: 0, credit: total, companyId: through.needsParty ? vendor!.id : null });
  const problem = voucherLinesProblem(lines, ledger);
  if (problem) return { error: problem };

  const who = vendor?.name ?? vendorName;
  const what = head.text(E.description) || accounts.join(", ");
  return {
    day,
    narration: who && !what.toLowerCase().includes(who.toLowerCase()) ? `${what} — ${who}` : what,
    reference: head.text(E.reference) || null,
    companyId: vendor?.id ?? null,
    lines,
    total,
    paidThrough: through.name,
    accounts,
  };
}

export async function checkExpense(unit: LedgerUnit, ctx: StepContext): Promise<UnitOutcome> {
  const r = await resolveExpense(unit, ctx);
  if ("error" in r) return { kind: "error", label: unit.label, line: r.line ?? unit.firstLine, error: r.error };
  if ("skip" in r) return { kind: "skip", label: unit.label, why: r.skip };
  return { kind: "create", label: `${r.day} · ${r.narration.slice(0, 60)}`, detail: `${rupees(r.total)} to ${r.accounts.join(", ")}, paid through ${r.paidThrough}` };
}

export async function applyExpense(unit: LedgerUnit, ctx: StepContext): Promise<UnitOutcome> {
  const r = await resolveExpense(unit, ctx);
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
  return { kind: "create", label: `${r.day} · ${r.narration.slice(0, 60)}`, detail: `${number} · ${rupees(r.total)}` };
}
