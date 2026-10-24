import { Prisma, type PaymentMethod } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeCompanyName } from "@/lib/company-name";
import { postPaymentToLedger } from "@/lib/ledger/journal";
import type { HistoryWindow } from "@/lib/portability/documents";
import { RowReader } from "@/lib/portability/importers/types";
import type { workspaceClock } from "@/lib/time/workspace";
import { refreshSettledStatus, settlementOf, type UnitOutcome } from "./documents";

/**
 * A migrated year's payments (src/lib/migration): customer receipts, and payments made to vendors. Each on
 * the day the money moved, applied to the invoices or bills the file names, and posted as Record payment would
 * post it — money in and Receivables down, or Payables down and money out — with nothing else that recording
 * one sets off (no workflow, no order booked, no receipt emailed).
 *
 *   · **One row a document it paid**, as Zoho Books exports payments: rows sharing a payment number are one
 *     payment, its amount and date read from the first; each row with an invoice or bill says how much went
 *     to it. A single one with no amount applied takes as much of the payment as it still owed.
 *   · **What isn't applied stays on account**, as an advance does.
 *   · **The invoice or bill must be in Deskzo**, for the same party — brought across in this migration, or
 *     still open from before the year (the open-documents import). A bill is named by the vendor's own number,
 *     as the old system shows it.
 *   · The bank account it went into or came out of, by name, when the file says; cash when it says cash;
 *     otherwise where Record payment would put it.
 */

export type PaymentSide = "RECEIVED" | "PAID";

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
type Columns = { [K in keyof typeof RECEIPT_COLUMNS]: string };

/** A vendor payment's own words for the same columns. */
export const VENDOR_PAYMENT_COLUMNS: Columns = { ...RECEIPT_COLUMNS, party: "Vendor", depositTo: "Paid through", invoice: "Bill" };

const columnsOf = (side: PaymentSide): Columns => (side === "RECEIVED" ? RECEIPT_COLUMNS : VENDOR_PAYMENT_COLUMNS);

/** The usual headings, Zoho Books' payments among them. To be tightened against a real backup. */
function aliasesOf(side: PaymentSide): Record<string, string[]> {
  const C = columnsOf(side);
  const shared = {
    [C.number]: ["Payment Number", "Payment #", "Payment No", ...(side === "RECEIVED" ? ["Receipt Number", "Receipt No"] : ["Vendor Payment Number", "Vendor Payment #"])],
    [C.date]: ["Payment Date", ...(side === "RECEIVED" ? ["Receipt Date"] : [])],
    [C.amount]: ["Payment Amount", side === "RECEIVED" ? "Amount Received" : "Amount Paid", "Total Amount"],
    [C.mode]: ["Payment Mode", "Mode of Payment", "Payment Method"],
    [C.reference]: ["Reference Number", "Reference#", "Reference No", "Cheque Number", "UTR", "Transaction ID"],
    [C.applied]: [`Amount Applied to ${side === "RECEIVED" ? "Invoice" : "Bill"}`, "Applied Amount", `${side === "RECEIVED" ? "Invoice" : "Bill"} Payment Amount`, "Amount Applied", "Payment Applied"],
    [C.notes]: ["Description", "Remarks", side === "RECEIVED" ? "Customer Notes" : "Vendor Notes"],
  };
  return side === "RECEIVED"
    ? {
        ...shared,
        [C.party]: ["Customer Name", "Party Name", "Company Name"],
        [C.depositTo]: ["Deposit To", "Paid Through", "Bank Account", "Deposited To"],
        [C.invoice]: ["Invoice Number", "Invoice#", "Invoice No", "Applied Invoice Number"],
      }
    : {
        ...shared,
        [C.party]: ["Vendor Name", "Supplier Name", "Supplier", "Party Name"],
        [C.depositTo]: ["Paid Through", "Paid From", "Bank Account", "Payment Account"],
        [C.invoice]: ["Bill Number", "Bill#", "Bill No", "Applied Bill Number", "Vendor Invoice Number"],
      };
}

export const paymentHeadings = (side: PaymentSide) => ({ templateColumns: Object.values(columnsOf(side)), headerAliases: aliasesOf(side) });
export const paymentColumns = (side: PaymentSide): string[] => Object.values(columnsOf(side));

export type ReceiptGroup = { number: string; firstLine: number; rows: { line: number; row: Record<string, string> }[] };

/** Rows sharing a payment number, in file order; a row with no number belongs to the payment above it. */
export function receiptUnits(rows: Record<string, string>[]): ReceiptGroup[] {
  const groups: ReceiptGroup[] = [];
  const byNumber = new Map<string, ReceiptGroup>();
  rows.forEach((row, i) => {
    const number = (row[RECEIPT_COLUMNS.number] ?? "").trim();
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

/** A migrated bill as the vendor numbered it (src/lib/migration/purchases.ts). */
export const billKey = (vendorName: string, number: string) => `BILL:${normalizeCompanyName(vendorName)}:${number.trim()}`;

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
/** A receipt keeps its number as its key, as it always has; a vendor payment's is told apart from it. */
const recordKey = (side: PaymentSide, number: string) => (side === "RECEIVED" ? number : `PAID:${number}`);

/** The invoice or bill a row names, for that party: a migrated bill by the vendor's number, else the document number. */
async function documentNamed(side: PaymentSide, number: string, party: { id: string; name: string }, migrationId: string) {
  const select = { id: true, branchId: true, issueDate: true } as const;
  const live = { status: { notIn: ["DRAFT", "CANCELLED"] as ("DRAFT" | "CANCELLED")[] } };
  if (side === "RECEIVED") return db.tradeDocument.findFirst({ where: { docNumber: number, docType: "INVOICE", companyId: party.id, ...live }, select });
  const record = await db.migrationRecord.findUnique({ where: { migrationId_kind_key: { migrationId, kind: "document", key: billKey(party.name, number) } }, select: { recordId: true } });
  return db.tradeDocument.findFirst({ where: { ...(record ? { id: record.recordId } : { docNumber: number }), docType: "BILL", companyId: party.id, ...live }, select });
}

async function resolvePayment(side: PaymentSide, group: ReceiptGroup, ctx: Ctx): Promise<{ error: string; line?: number } | { skip: string } | Ready> {
  const C = columnsOf(side);
  const doc = side === "RECEIVED" ? "invoice" : "bill";
  if (!group.number) return { error: `${C.number} is required — each payment keeps the number it had.` };
  const done = await db.migrationRecord.findUnique({ where: { migrationId_kind_key: { migrationId: ctx.migrationId, kind: "payment", key: recordKey(side, group.number) } }, select: { id: true } });
  if (done) return { skip: "already brought across" };

  const head = new RowReader(group.rows[0]!.row, ctx.clock);
  const partyName = head.text(C.party);
  const paidOn = head.date(C.date);
  const amount = head.number(C.amount);
  if (head.error) return { error: head.error };
  if (!partyName) return { error: `${C.party} is required.` };
  if (!paidOn) return { error: `${C.date} is required — the day the money ${side === "RECEIVED" ? "came in" : "went out"}.` };
  const day = paidOn.toISOString().slice(0, 10);
  if (day < ctx.window.from || day >= ctx.window.to) return { error: `It's dated ${day}, outside the year being brought across (${ctx.window.from} to the day before ${ctx.window.to}).` };
  if (amount === undefined || amount <= 0) return { error: `${C.amount} must be more than 0.` };

  const party = await db.company.findUnique({ where: { normalizedName: normalizeCompanyName(partyName) }, select: { id: true, name: true } });
  if (!party) return { error: `No ${side === "RECEIVED" ? "customer" : "vendor"} named "${partyName}". Import ${side === "RECEIVED" ? "Companies" : "Vendors"} first, or correct the spelling.` };

  const through = head.text(C.depositTo);
  const cash = /^(petty\s*)?cash(\s+in\s+hand)?$/i.test(through);
  let bankAccountId: string | null = null;
  if (through && !cash) {
    const bank = await db.bankAccount.findFirst({ where: { name: { equals: through, mode: "insensitive" } }, select: { id: true } });
    if (!bank) return { error: `No bank account named "${through}". Add it under Accounting › Banking first, or leave ${C.depositTo} blank.` };
    bankAccountId = bank.id;
  }

  // What each document it names was paid: the file's amount, else — one alone — what it still owed.
  const allocations: Ready["allocations"] = [];
  let branchId: string | null = null;
  const named = group.rows.filter((r) => (r.row[C.invoice] ?? "").trim());
  for (const { line, row } of named) {
    const r = new RowReader(row, ctx.clock);
    const number = r.text(C.invoice);
    const applied = r.number(C.applied);
    if (r.error) return { error: r.error, line };
    const found = await documentNamed(side, number, party, ctx.migrationId);
    if (!found) return { error: `${side === "RECEIVED" ? "Invoice" : "Bill"} ${number} for ${party.name} isn't in Deskzo. Bring the ${doc}s across first.`, line };
    if (found.issueDate > paidOn) return { error: `${side === "RECEIVED" ? "Invoice" : "Bill"} ${number} is dated after the payment.`, line };
    const owed = (await settlementOf(db, found.id))?.settlement.balance ?? 0;
    const amountFor = applied ?? (named.length === 1 ? Math.min(amount, owed) : undefined);
    if (amountFor === undefined) return { error: `It pays ${named.length} ${doc}s — give ${C.applied} on each row.`, line };
    if (amountFor < 0) return { error: `${C.applied} can't be negative.`, line };
    if (amountFor > owed + 1) return { error: `${rupees(amountFor)} is more than ${doc} ${number} still owed (${rupees(owed)}).`, line };
    if (amountFor > 0) allocations.push({ documentId: found.id, number, amount: round2(Math.min(amountFor, owed)) });
    branchId ??= found.branchId;
  }
  const allocated = round2(allocations.reduce((n, a) => n + a.amount, 0));
  if (allocated > amount + 0.01) return { error: `It applies ${rupees(allocated)} to ${doc}s, more than the payment's ${rupees(amount)}.` };

  return {
    companyId: party.id,
    partyName: party.name,
    amount: round2(amount),
    paidOn,
    method: cash ? "CASH" : methodOf(head.text(C.mode)),
    reference: head.text(C.reference).slice(0, 120) || null,
    notes: head.text(C.notes).slice(0, 1000) || null,
    bankAccountId,
    branchId,
    allocations,
  };
}

export async function checkPayment(side: PaymentSide, group: ReceiptGroup, ctx: Ctx): Promise<UnitOutcome> {
  const label = group.number || `Row ${group.firstLine}`;
  const r = await resolvePayment(side, group, ctx);
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

export async function applyPayment(side: PaymentSide, group: ReceiptGroup, ctx: Ctx): Promise<UnitOutcome> {
  const label = group.number || `Row ${group.firstLine}`;
  const r = await resolvePayment(side, group, ctx);
  if ("error" in r) return { kind: "error", label, line: r.line ?? group.firstLine, error: r.error };
  if ("skip" in r) return { kind: "skip", label, why: r.skip };
  const key = recordKey(side, group.number);
  try {
    await db.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          companyId: r.companyId,
          branchId: r.branchId,
          direction: side,
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
      for (const a of r.allocations) await refreshSettledStatus(tx, a.documentId);
      await tx.migrationRecord.create({ data: { migrationId: ctx.migrationId, kind: "payment", recordId: payment.id, key } });
      if (entry) await tx.migrationRecord.create({ data: { migrationId: ctx.migrationId, kind: "journal", recordId: entry.id, key: `PAYMENT:${key}:entry` } });
    });
  } catch (err) {
    return { kind: "error", label, line: group.firstLine, error: err instanceof Error ? err.message : "It couldn't be posted." };
  }
  return { kind: "create", label: `${group.number} · ${r.partyName}`, detail: rupees(r.amount) };
}
