import { Prisma, type PaymentMethod } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeCompanyName } from "@/lib/company-name";
import { postPaymentToLedger } from "@/lib/ledger/journal";
import type { HistoryWindow } from "@/lib/portability/documents";
import { RowReader } from "@/lib/portability/importers/types";
import { settleInvoice } from "@/lib/receivables";
import type { workspaceClock } from "@/lib/time/workspace";
import { refreshInvoiceStatus, type UnitOutcome } from "./documents";

/**
 * A migrated year's customer receipts (src/lib/migration): each payment on the day it came in, applied to the
 * invoices the file names, and posted as Record payment would post it — money in, Receivables down — with
 * nothing else that recording one sets off (no workflow, no order booked, no receipt emailed).
 *
 *   · **One row an invoice it paid**, as Zoho Books exports them: rows sharing a payment number are one
 *     payment, its amount and date read from the first; each row with an invoice says how much went to it.
 *     A single invoice with no amount applied takes as much of the payment as it still owed.
 *   · **What isn't applied stays on account**, as an advance does.
 *   · **The invoice must be in Deskzo** — brought across in this migration, or still open from before the year
 *     (the open-documents import) — and for the same customer.
 *   · The bank account it went into, by name, when the file says; otherwise where Record payment would put it.
 */

export const RECEIPT_COLUMNS = {
  number: "Payment number",
  date: "Date",
  party: "Customer",
  amount: "Amount",
  mode: "Mode",
  reference: "Reference",
  depositTo: "Deposit to",
  invoice: "Invoice",
  applied: "Amount applied",
  notes: "Notes",
} as const;
const R = RECEIPT_COLUMNS;

/** The usual headings, Zoho Books' customer payments among them. To be tightened against a real backup. */
const ALIASES: Record<string, string[]> = {
  [R.number]: ["Payment Number", "Payment #", "Payment No", "Receipt Number", "Receipt No"],
  [R.date]: ["Payment Date", "Receipt Date"],
  [R.party]: ["Customer Name", "Party Name", "Company Name"],
  [R.amount]: ["Payment Amount", "Amount Received", "Total Amount"],
  [R.mode]: ["Payment Mode", "Mode of Payment", "Payment Method"],
  [R.reference]: ["Reference Number", "Reference#", "Reference No", "Cheque Number", "UTR", "Transaction ID"],
  [R.depositTo]: ["Deposit To", "Paid Through", "Bank Account", "Deposited To"],
  [R.invoice]: ["Invoice Number", "Invoice#", "Invoice No", "Applied Invoice Number"],
  [R.applied]: ["Amount Applied to Invoice", "Applied Amount", "Invoice Payment Amount", "Amount Applied", "Payment Applied"],
  [R.notes]: ["Description", "Remarks", "Customer Notes"],
};

export const receiptHeadings = { templateColumns: Object.values(R) as string[], headerAliases: ALIASES };
export const receiptColumns = (): string[] => Object.values(R);

export type ReceiptGroup = { number: string; firstLine: number; rows: { line: number; row: Record<string, string> }[] };

/** Rows sharing a payment number, in file order; a row with no number belongs to the payment above it. */
export function receiptUnits(rows: Record<string, string>[]): ReceiptGroup[] {
  const groups: ReceiptGroup[] = [];
  const byNumber = new Map<string, ReceiptGroup>();
  rows.forEach((row, i) => {
    const number = (row[R.number] ?? "").trim();
    const group = number ? byNumber.get(number) : groups[groups.length - 1];
    if (group) group.rows.push({ line: i + 2, row });
    else {
      const made: ReceiptGroup = { number, firstLine: i + 2, rows: [{ line: i + 2, row }] };
      groups.push(made);
      if (number) byNumber.set(number, made);
    }
  });
  return groups;
}

export function methodOf(text: string): PaymentMethod {
  const t = text.trim().toLowerCase();
  if (/cash/.test(t)) return "CASH";
  if (/cheque|check|\bdd\b|demand draft/.test(t)) return "CHEQUE";
  if (/upi|gpay|phonepe|paytm/.test(t)) return "UPI";
  if (/card/.test(t)) return "CARD";
  if (/bank|neft|rtgs|imps|transfer|wire|ach/.test(t)) return "BANK_TRANSFER";
  return "OTHER";
}

type Clock = Awaited<ReturnType<typeof workspaceClock>>;
type Ctx = { migrationId: string; window: HistoryWindow; clock: Clock; userId: string };
type Ready = {
  companyId: string;
  partyName: string;
  amount: number;
  paidOn: Date;
  method: PaymentMethod;
  reference: string | null;
  notes: string | null;
  bankAccountId: string | null;
  branchId: string | null;
  allocations: { documentId: string; number: string; amount: number }[];
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

async function resolveReceipt(group: ReceiptGroup, ctx: Ctx): Promise<{ error: string; line?: number } | { skip: string } | Ready> {
  if (!group.number) return { error: `${R.number} is required — each payment keeps the number it had.` };
  const done = await db.migrationRecord.findUnique({ where: { migrationId_kind_key: { migrationId: ctx.migrationId, kind: "payment", key: group.number } }, select: { id: true } });
  if (done) return { skip: "already brought across" };

  const head = new RowReader(group.rows[0]!.row, ctx.clock);
  const partyName = head.text(R.party);
  const paidOn = head.date(R.date);
  const amount = head.number(R.amount);
  if (head.error) return { error: head.error };
  if (!partyName) return { error: `${R.party} is required.` };
  if (!paidOn) return { error: `${R.date} is required — the day the money came in.` };
  const day = paidOn.toISOString().slice(0, 10);
  if (day < ctx.window.from || day >= ctx.window.to) return { error: `It's dated ${day}, outside the year being brought across (${ctx.window.from} to the day before ${ctx.window.to}).` };
  if (amount === undefined || amount <= 0) return { error: `${R.amount} must be more than 0.` };

  const party = await db.company.findUnique({ where: { normalizedName: normalizeCompanyName(partyName) }, select: { id: true, name: true } });
  if (!party) return { error: `No customer named "${partyName}". Import Companies first, or correct the spelling.` };

  const depositTo = head.text(R.depositTo);
  let bankAccountId: string | null = null;
  if (depositTo && !/^(petty\s*)?cash$/i.test(depositTo)) {
    const bank = await db.bankAccount.findFirst({ where: { name: { equals: depositTo, mode: "insensitive" } }, select: { id: true } });
    if (!bank) return { error: `No bank account named "${depositTo}". Add it under Accounting › Banking first, or leave ${R.depositTo} blank.` };
    bankAccountId = bank.id;
  }

  // What each invoice it names was paid: the file's amount, else — one invoice alone — what it still owed.
  const allocations: Ready["allocations"] = [];
  let branchId: string | null = null;
  const named = group.rows.filter((r) => (r.row[R.invoice] ?? "").trim());
  for (const { line, row } of named) {
    const r = new RowReader(row, ctx.clock);
    const number = r.text(R.invoice);
    const applied = r.number(R.applied);
    if (r.error) return { error: r.error, line };
    const invoice = await db.tradeDocument.findFirst({
      where: { docNumber: number, docType: "INVOICE", companyId: party.id, status: { notIn: ["DRAFT", "CANCELLED"] } },
      select: { id: true, total: true, paidBefore: true, branchId: true, issueDate: true },
    });
    if (!invoice) return { error: `Invoice ${number} for ${party.name} isn't in Deskzo. Bring the invoices across first.`, line };
    if (invoice.issueDate > paidOn) return { error: `Invoice ${number} is dated after the payment.`, line };
    const [paid, credited] = await Promise.all([
      db.paymentAllocation.aggregate({ where: { documentId: invoice.id }, _sum: { amount: true } }),
      db.creditNoteApplication.aggregate({ where: { invoiceId: invoice.id }, _sum: { amount: true } }),
    ]);
    const owed = settleInvoice(Number(invoice.total), Number(paid._sum.amount ?? 0), Number(credited._sum.amount ?? 0), Number(invoice.paidBefore ?? 0)).balance;
    const amountFor = applied ?? (named.length === 1 ? Math.min(amount, owed) : undefined);
    if (amountFor === undefined) return { error: `It pays ${named.length} invoices — give ${R.applied} on each row.`, line };
    if (amountFor < 0) return { error: `${R.applied} can't be negative.`, line };
    if (amountFor > owed + 1) return { error: `${rupees(amountFor)} is more than invoice ${number} still owed (${rupees(owed)}).`, line };
    if (amountFor > 0) allocations.push({ documentId: invoice.id, number, amount: round2(Math.min(amountFor, owed)) });
    branchId ??= invoice.branchId;
  }
  const allocated = round2(allocations.reduce((n, a) => n + a.amount, 0));
  if (allocated > amount + 0.01) return { error: `It applies ${rupees(allocated)} to invoices, more than the payment's ${rupees(amount)}.` };

  return {
    companyId: party.id,
    partyName: party.name,
    amount: round2(amount),
    paidOn,
    method: methodOf(head.text(R.mode)),
    reference: head.text(R.reference).slice(0, 120) || null,
    notes: head.text(R.notes).slice(0, 1000) || null,
    bankAccountId,
    branchId,
    allocations,
  };
}

export async function checkReceipt(group: ReceiptGroup, ctx: Ctx): Promise<UnitOutcome> {
  const label = group.number || `Row ${group.firstLine}`;
  const r = await resolveReceipt(group, ctx);
  if ("error" in r) return { kind: "error", label, line: r.line ?? group.firstLine, error: r.error };
  if ("skip" in r) return { kind: "skip", label, why: r.skip };
  const applied = r.allocations.reduce((n, a) => n + a.amount, 0);
  const onAccount = round2(r.amount - applied);
  return {
    kind: "create",
    label: `${group.number} · ${r.partyName}`,
    detail: `${r.paidOn.toISOString().slice(0, 10)} · ${rupees(r.amount)}${r.allocations.length ? ` to ${r.allocations.map((a) => a.number).join(", ")}` : ""}${onAccount > 0 ? ` · ${rupees(onAccount)} on account` : ""}`,
  };
}

export async function applyReceipt(group: ReceiptGroup, ctx: Ctx): Promise<UnitOutcome> {
  const label = group.number || `Row ${group.firstLine}`;
  const r = await resolveReceipt(group, ctx);
  if ("error" in r) return { kind: "error", label, line: r.line ?? group.firstLine, error: r.error };
  if ("skip" in r) return { kind: "skip", label, why: r.skip };
  try {
    await db.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          companyId: r.companyId,
          branchId: r.branchId,
          direction: "RECEIVED",
          amount: new Prisma.Decimal(r.amount),
          paidOn: r.paidOn,
          method: r.method,
          reference: r.reference,
          notes: r.notes,
          bankAccountId: r.bankAccountId,
          recordedByUserId: ctx.userId,
        },
        select: { id: true },
      });
      for (const a of r.allocations) {
        await tx.paymentAllocation.create({ data: { paymentId: payment.id, documentId: a.documentId, amount: new Prisma.Decimal(a.amount), allocatedByUserId: ctx.userId } });
      }
      const entry = await postPaymentToLedger(tx, payment.id, ctx.userId);
      for (const a of r.allocations) await refreshInvoiceStatus(tx, a.documentId);
      await tx.migrationRecord.create({ data: { migrationId: ctx.migrationId, kind: "payment", recordId: payment.id, key: group.number } });
      if (entry) await tx.migrationRecord.create({ data: { migrationId: ctx.migrationId, kind: "journal", recordId: entry.id, key: `PAYMENT:${group.number}:entry` } });
    });
  } catch (err) {
    return { kind: "error", label, line: group.firstLine, error: err instanceof Error ? err.message : "It couldn't be posted." };
  }
  return { kind: "create", label: `${group.number} · ${r.partyName}`, detail: rupees(r.amount) };
}
