/**
 * Whether the ledger still agrees with the documents and payments it was posted from.
 *
 * The posting engine being right doesn't make the books right: a path that cancels a document, deletes
 * a payment or removes an allocation without reversing what it posted leaves figures in the accounts
 * for something that no longer exists, and nothing about that looks wrong until somebody reads the
 * P&L. `npm run check:postings` runs this against the workspace; check:payments-fx runs it against its
 * scratch books, where each case is made to happen.
 *
 * Each entry is judged by its source, because more than one kind of entry names a document or a
 * payment:
 *
 *   · a document's own posting (INVOICE, CREDIT_NOTE, BILL) — issued means one is live, cancelled
 *     means none is;
 *   · an exchange difference (FX) names both the payment and the document it settled. It stands while
 *     the payment is set against a live document, and is reversed with the payment, the allocation or
 *     the document (journal.ts `reversePaymentPosting`, `reverseAllocationExchange`,
 *     `reverseDocumentPosting`). This check used to read every entry carrying a cancelled document as
 *     the document's own, and so could not tell a document's posting left standing from a payment's;
 *   · a payment's own posting and its cheque clearing (PAYMENT) stand while the payment does.
 *
 * Read-only.
 */
import type { PrismaClient, Prisma } from "@prisma/client";
import { DOCUMENT_SOURCES, PAYMENT_SOURCES } from "@/lib/ledger/posting";

type Client = PrismaClient | Prisma.TransactionClient;

export type DriftProblem = {
  kind: "unposted" | "cancelled-live" | "cancelled-fx-live" | "orphan-payment-entry" | "fx-without-allocation" | "unbalanced";
  message: string;
};

const LIVE = { reversesId: null, reversedBy: { is: null } } satisfies Prisma.JournalEntryWhereInput;

export async function findLedgerDrift(db: Client): Promise<{ problems: DriftProblem[]; documentsChecked: number }> {
  const problems: DriftProblem[] = [];

  // Issued, and nothing of its own was ever posted. An exchange difference naming it is not its posting.
  const unposted = await db.tradeDocument.findMany({
    where: {
      docType: { in: [...DOCUMENT_SOURCES] },
      status: { notIn: ["DRAFT", "CANCELLED"] },
      journalEntries: { none: { source: { in: [...DOCUMENT_SOURCES] } } },
    },
    select: { docNumber: true, docType: true },
  });
  for (const d of unposted) {
    problems.push({ kind: "unposted", message: `${d.docType} ${d.docNumber} is issued but has no ledger entry.` });
  }

  // Cancelled, and something that names it still stands: its own posting, or an exchange difference a
  // payment booked against it.
  const cancelled = await db.tradeDocument.findMany({
    where: { status: "CANCELLED", journalEntries: { some: { source: { in: [...DOCUMENT_SOURCES, "FX"] }, ...LIVE } } },
    select: {
      docNumber: true,
      journalEntries: { where: { source: { in: [...DOCUMENT_SOURCES, "FX"] }, ...LIVE }, select: { entryNumber: true, source: true } },
    },
  });
  for (const d of cancelled) {
    for (const e of d.journalEntries) {
      problems.push(
        e.source === "FX"
          ? { kind: "cancelled-fx-live", message: `${d.docNumber} is cancelled but the exchange difference ${e.entryNumber} settled against it has not been reversed.` }
          : { kind: "cancelled-live", message: `${d.docNumber} is cancelled but ${e.entryNumber} has not been reversed.` },
      );
    }
  }

  // A payment's entries still standing after the payment went: the foreign key let go of it (SetNull).
  // A payroll or reimbursement payment names its run or claim instead, and is not a payment row's.
  const orphans = await db.journalEntry.findMany({
    where: { source: { in: [...PAYMENT_SOURCES] }, paymentId: null, expenseId: null, payrollRunId: null, ...LIVE },
    select: { entryNumber: true, source: true, narration: true },
  });
  for (const e of orphans) {
    problems.push({ kind: "orphan-payment-entry", message: `${e.entryNumber} (${e.source}, "${e.narration}") belongs to a payment that no longer exists and has not been reversed.` });
  }

  // More exchange differences standing for a payment and a document than the payment has allocations
  // to it: one was left behind when an allocation was removed.
  const fx = await db.journalEntry.findMany({
    where: { source: "FX", paymentId: { not: null }, documentId: { not: null }, ...LIVE },
    select: { entryNumber: true, paymentId: true, documentId: true },
  });
  if (fx.length > 0) {
    const allocations = await db.paymentAllocation.groupBy({
      by: ["paymentId", "documentId"],
      where: { paymentId: { in: [...new Set(fx.map((e) => e.paymentId!))] } },
      _count: { _all: true },
    });
    const allowed = new Map(allocations.map((a) => [`${a.paymentId}|${a.documentId}`, a._count._all]));
    const standing = new Map<string, string[]>();
    for (const e of fx) {
      const key = `${e.paymentId}|${e.documentId}`;
      standing.set(key, [...(standing.get(key) ?? []), e.entryNumber]);
    }
    for (const [key, entries] of standing) {
      const extra = entries.length - (allowed.get(key) ?? 0);
      if (extra > 0) {
        problems.push({
          kind: "fx-without-allocation",
          message: `${entries.join(", ")}: ${entries.length} exchange difference(s) standing for ${allowed.get(key) ?? 0} allocation(s) of that payment to that document.`,
        });
      }
    }
  }

  const unbalanced: { entryNumber: string }[] = await db.$queryRaw`
    SELECT e."entryNumber" FROM journal_lines l
    JOIN journal_entries e ON e.id = l."entryId"
    GROUP BY e."entryNumber" HAVING SUM(l.debit) <> SUM(l.credit)`;
  for (const r of unbalanced) {
    problems.push({ kind: "unbalanced", message: `${r.entryNumber} does not balance in the database.` });
  }

  return { problems, documentsChecked: unposted.length + cancelled.length };
}
