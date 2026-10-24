import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { createDraftDocument } from "@/lib/documents/create-draft";
import { postDocumentToLedger } from "@/lib/ledger/journal";
import { DOCUMENT_COLUMNS, aliasesFor, groupRows, resolveGroup, type Group, type HistoryWindow } from "@/lib/portability/documents";
import { RowReader } from "@/lib/portability/importers/types";
import { settleInvoice, settledStatus } from "@/lib/receivables";
import { tradeDocumentLabels } from "@/lib/trade-documents";
import type { workspaceClock } from "@/lib/time/workspace";

/**
 * A migrated year's invoices and credit notes (src/lib/migration): the open-documents import's reading of a
 * file — rows sharing a number are one document, the party found by name, the lines by item, the total checked
 * to the rupee (src/lib/portability/documents.ts) — with three differences:
 *
 *   · dated inside the year, and settled ones too: this is history, not what is still open;
 *   · posted as they happened: issued and posted on their own date, their plain entry and nothing else —
 *     no stock, no e-invoice, no revenue schedule, no notification (postDocumentToLedger `history`);
 *   · their e-invoice (IRN, acknowledgement, signed QR) and e-way bill kept as the old system issued them, so a
 *     reprint looks like the original. Marked as generated outside Deskzo: nothing here cancels or regenerates
 *     them (src/lib/documents/imported.ts `isImported`).
 *
 * A void or draft in the old system isn't brought: it was never a sale. A credit note is applied to the
 * invoice it names — the amount the file says, else as much as the invoice still had to pay.
 */

export type DocumentStepType = "INVOICE" | "CREDIT_NOTE";
type Clock = Awaited<ReturnType<typeof workspaceClock>>;

/** The history-only columns, beside the open-documents import's own. */
export const HISTORY_COLUMNS = {
  irn: "IRN",
  ackNo: "Ack number",
  ackDate: "Ack date",
  signedQr: "Signed QR code",
  ewayNumber: "E-way bill number",
  ewayDate: "E-way bill date",
  ewayValidUntil: "E-way bill valid until",
  applied: "Amount applied",
} as const;
const H = HISTORY_COLUMNS;
const C = DOCUMENT_COLUMNS;

/** The usual headings in exports, Zoho Books' among them. To be tightened against a real backup. */
const HISTORY_ALIASES: Record<string, string[]> = {
  [H.irn]: ["IRN Number", "IRN No", "e-Invoice IRN", "E-Invoice IRN", "Invoice Reference Number"],
  [H.ackNo]: ["Ack No", "Ack No.", "Acknowledgement Number", "Acknowledgement No", "e-Invoice Ack No"],
  [H.ackDate]: ["Ack Dt", "Acknowledgement Date", "e-Invoice Ack Date"],
  [H.signedQr]: ["Signed QR", "QR Code", "Signed QR Code Data", "SignedQRCode", "e-Invoice QR Code"],
  [H.ewayNumber]: ["E-Way Bill No", "E-Way Bill Number", "Eway Bill Number", "EWB Number", "EWB No"],
  [H.ewayDate]: ["E-Way Bill Date", "EWB Date"],
  [H.ewayValidUntil]: ["E-Way Bill Valid Till", "E-Way Bill Valid Upto", "EWB Valid Till", "Valid Upto"],
  [H.applied]: ["Credits Applied", "Amount Applied to Invoice", "Applied Amount", "Credit Applied"],
};

const ALL_COLUMNS: string[] = [...Object.values(C), ...Object.values(H)];

export function documentHeadings(type: DocumentStepType) {
  return { templateColumns: ALL_COLUMNS, headerAliases: { ...aliasesFor(type), ...HISTORY_ALIASES } };
}

/** The template's columns: what the open-documents import asks, less its balance and validity, plus these. */
export function documentStepColumns(type: DocumentStepType): string[] {
  const own = Object.values(C).filter((c) => c !== C.balance && c !== C.validUntil && (c !== C.against || type === "CREDIT_NOTE"));
  const history = type === "INVOICE" ? [H.irn, H.ackNo, H.ackDate, H.signedQr, H.ewayNumber, H.ewayDate, H.ewayValidUntil] : [H.irn, H.ackNo, H.ackDate, H.signedQr, H.applied];
  return [...own, ...history];
}

export function documentUnits(rows: Record<string, string>[]): Group[] {
  return groupRows(rows);
}

type Ctx = { migrationId: string; window: HistoryWindow; clock: Clock; userId: string };
export type UnitOutcome = { kind: "create"; label: string; detail: string } | { kind: "skip"; label: string; why: string } | { kind: "error"; label: string; line: number; error: string };

const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** The old system's status word: void and draft documents stay there. */
function leftBehind(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (/void|cancel/.test(t)) return "void in the old system — not a sale";
  if (/draft/.test(t)) return "a draft in the old system — never issued";
  return null;
}

/** The history columns of a document's first row, read and checked. */
function historyOf(type: DocumentStepType, group: Group, clock: Clock) {
  const head = new RowReader(group.rows[0]!.row, clock);
  const irn = head.text(H.irn);
  const ackNo = head.text(H.ackNo);
  const ackDate = head.date(H.ackDate);
  const signedQr = head.text(H.signedQr);
  const ewayNumber = type === "INVOICE" ? head.text(H.ewayNumber).replace(/\s+/g, "") : "";
  const ewayDate = type === "INVOICE" ? head.date(H.ewayDate) : undefined;
  const ewayValidUntil = type === "INVOICE" ? head.date(H.ewayValidUntil) : undefined;
  const applied = type === "CREDIT_NOTE" ? head.number(H.applied) : undefined;
  if (head.error) return { error: head.error };
  if (irn && !/^[0-9a-f]{64}$/i.test(irn)) return { error: `${H.irn} "${irn.slice(0, 20)}…" isn't one — an IRN is 64 letters and digits.` };
  if (ewayNumber && !/^\d{12}$/.test(ewayNumber)) return { error: `${H.ewayNumber} "${ewayNumber}" isn't one — an e-way bill number is 12 digits.` };
  if (applied !== undefined && applied < 0) return { error: `${H.applied} can't be negative.` };
  return { irn: irn || null, ackNo: ackNo || null, ackDate: ackDate ?? null, signedQr: signedQr || null, ewayNumber: ewayNumber || null, ewayDate: ewayDate ?? null, ewayValidUntil: ewayValidUntil ?? null, applied };
}

/** What one document would be, writing nothing. */
export async function checkDocument(type: DocumentStepType, group: Group, ctx: Ctx): Promise<UnitOutcome> {
  const label = group.number || `Row ${group.firstLine}`;
  const status = new RowReader(group.rows[0]!.row, ctx.clock).text(C.status);
  const behind = leftBehind(status);
  if (behind) return { kind: "skip", label, why: behind };
  const history = historyOf(type, group, ctx.clock);
  if ("error" in history) return { kind: "error", label, line: group.firstLine, error: history.error! };
  const resolved = await resolveGroup(type, group, ctx.clock, null, ctx.window);
  if ("error" in resolved) return { kind: "error", label, line: resolved.line ?? group.firstLine, error: resolved.error };
  if ("skip" in resolved) return { kind: "skip", label, why: "already brought across" };
  const extras = [history.irn ? "e-invoice" : null, history.ewayNumber ? "e-way bill" : null].filter(Boolean);
  return {
    kind: "create",
    label: `${group.number} · ${resolved.partyName}`,
    detail: `${resolved.input.issueDate} · ${resolved.lineCount} line${resolved.lineCount === 1 ? "" : "s"} · ${rupees(resolved.total)}${extras.length ? ` · ${extras.join(", ")}` : ""}`,
  };
}

/** Recomputes an invoice's status from what has been paid and credited against it. */
export async function refreshInvoiceStatus(tx: Prisma.TransactionClient, invoiceId: string): Promise<void> {
  const [doc, paid, credited] = await Promise.all([
    tx.tradeDocument.findUnique({ where: { id: invoiceId }, select: { total: true, paidBefore: true, status: true } }),
    tx.paymentAllocation.aggregate({ where: { documentId: invoiceId }, _sum: { amount: true } }),
    tx.creditNoteApplication.aggregate({ where: { invoiceId }, _sum: { amount: true } }),
  ]);
  if (!doc || doc.status === "CANCELLED" || doc.status === "DRAFT") return;
  const status = settledStatus(settleInvoice(Number(doc.total), Number(paid._sum.amount ?? 0), Number(credited._sum.amount ?? 0), Number(doc.paidBefore ?? 0)));
  if (status !== doc.status) await tx.tradeDocument.update({ where: { id: invoiceId }, data: { status } });
}

/** Brings one document across: made, issued and posted on its own date, recorded against the migration. */
export async function applyDocument(type: DocumentStepType, group: Group, ctx: Ctx): Promise<UnitOutcome> {
  const checked = await checkDocument(type, group, ctx);
  if (checked.kind !== "create") return checked;
  const history = historyOf(type, group, ctx.clock);
  if ("error" in history) return { kind: "error", label: checked.label, line: group.firstLine, error: history.error! };
  const resolved = await resolveGroup(type, group, ctx.clock, null, ctx.window);
  if (!("input" in resolved)) return { kind: "error", label: checked.label, line: group.firstLine, error: "It changed while it was being brought across. Try again." };

  const made = await createDraftDocument({ id: ctx.userId }, resolved.input, "MIGRATED");
  if (!made.ok) return { kind: "error", label: checked.label, line: group.firstLine, error: made.error };
  const id = made.data.id;
  try {
    await db.$transaction(async (tx) => {
      const issueDate = new Date(`${resolved.input.issueDate}T00:00:00Z`);
      await tx.tradeDocument.update({
        where: { id },
        data: {
          status: "ISSUED",
          issuedAt: issueDate,
          einvoiceStatus: history.irn ? "GENERATED" : "NOT_APPLICABLE",
          irn: history.irn,
          ackNo: history.ackNo,
          ackDate: history.ackDate,
          signedQrCode: history.signedQr,
        },
      });
      const doc = await tx.tradeDocument.findUniqueOrThrow({ where: { id }, select: { total: true, againstDocumentId: true } });
      if (history.ewayNumber) {
        await tx.ewayBill.create({
          data: {
            documentId: id,
            declaredValue: doc.total,
            distanceKm: 0,
            status: "GENERATED",
            ewayBillNumber: history.ewayNumber,
            ewayBillDate: history.ewayDate ?? issueDate,
            validUntil: history.ewayValidUntil,
          },
        });
      }
      const entry = await postDocumentToLedger(tx, id, ctx.userId, { history: true });
      const key = `${type}:${group.number}`;
      await tx.migrationRecord.create({ data: { migrationId: ctx.migrationId, kind: "document", recordId: id, key } });
      if (entry) await tx.migrationRecord.create({ data: { migrationId: ctx.migrationId, kind: "journal", recordId: entry.id, key: `${key}:entry` } });

      // A credit note reduces the invoice it names: by what the file says, else by what that invoice still owed.
      if (type === "CREDIT_NOTE" && doc.againstDocumentId) {
        const invoice = await tx.tradeDocument.findUniqueOrThrow({ where: { id: doc.againstDocumentId }, select: { total: true, paidBefore: true } });
        const [paid, credited] = await Promise.all([
          tx.paymentAllocation.aggregate({ where: { documentId: doc.againstDocumentId }, _sum: { amount: true } }),
          tx.creditNoteApplication.aggregate({ where: { invoiceId: doc.againstDocumentId }, _sum: { amount: true } }),
        ]);
        const owed = settleInvoice(Number(invoice.total), Number(paid._sum.amount ?? 0), Number(credited._sum.amount ?? 0), Number(invoice.paidBefore ?? 0)).balance;
        const amount = round2(Math.min(history.applied ?? owed, Number(doc.total), owed));
        if (amount > 0) {
          await tx.creditNoteApplication.create({ data: { creditNoteId: id, invoiceId: doc.againstDocumentId, amount: new Prisma.Decimal(amount), appliedByUserId: ctx.userId } });
          await refreshInvoiceStatus(tx, doc.againstDocumentId);
        }
      }
    });
  } catch (err) {
    // Not half there: the draft goes with the posting that failed.
    await db.tradeDocument.delete({ where: { id } }).catch(() => {});
    return { kind: "error", label: checked.label, line: group.firstLine, error: err instanceof Error ? err.message : "It couldn't be posted." };
  }
  return { kind: "create", label: checked.label, detail: `${tradeDocumentLabels[type]} ${group.number}` };
}
