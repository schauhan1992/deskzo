import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { settleInvoice } from "@/lib/receivables";
import { isReceivable } from "@/lib/trade-documents";

type Client = Pick<typeof db, "tradeDocument">;

/** What a sum of rows comes to. */
const sum = (rows: { amount: Prisma.Decimal | number }[]) => rows.reduce((t, r) => t + Number(r.amount), 0);

/**
 * What's still to pay on an invoice — or a debit note, owed the same way — as Receivables settles it
 * (src/lib/receivables.ts): its total, less payments applied, credit notes applied and what it had settled
 * before Deskzo. Null for anything that isn't an issued, uncancelled invoice or debit note.
 */
export async function invoiceBalance(invoiceId: string, client: Client = db): Promise<{ balance: number; currency: string; total: number } | null> {
  const invoice = await client.tradeDocument.findUnique({
    where: { id: invoiceId },
    select: {
      docType: true,
      status: true,
      total: true,
      currency: true,
      paidBefore: true,
      payments: { select: { amount: true } },
      creditsReceived: { select: { amount: true } },
    },
  });
  if (!invoice || !isReceivable(invoice.docType) || invoice.status === "DRAFT" || invoice.status === "CANCELLED") return null;
  const settled = settleInvoice(Number(invoice.total), sum(invoice.payments), sum(invoice.creditsReceived), Number(invoice.paidBefore));
  return { balance: settled.balance, currency: invoice.currency, total: Number(invoice.total) };
}
