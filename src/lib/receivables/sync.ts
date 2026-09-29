import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { settleInvoice, settledStatus } from "@/lib/receivables";
import { syncBillingMilestones } from "@/lib/projects/billing-sync";

/**
 * Brings an invoice's stored status back in line with what has actually been settled against it.
 *
 * The status is a *cache* of the applications, not a fact of its own, so it is re-derived after
 * anything that changes them rather than nudged by hand — nudging is how an invoice ends up marked
 * PAID with money still outstanding.
 *
 * Lifted out of `src/actions/receivable.ts`, where it was module-private, because deleting a
 * payment needed it too and did not have it: the allocations went and the status stayed, so an
 * unpaid invoice read PAID, dropped out of the ageing report and was never chased again. A
 * "use server" module cannot share a helper without also publishing it as an endpoint, which is
 * why this lives here instead.
 *
 * A cancelled or draft invoice is left alone: neither is collectable, and re-deriving would
 * resurrect it.
 */

const settlementInclude = {
  payments: { select: { amount: true } },
  creditsReceived: { select: { amount: true } },
} as const;

type SettlementRow = {
  total: Prisma.Decimal | number;
  payments: { amount: Prisma.Decimal | number }[];
  creditsReceived: { amount: Prisma.Decimal | number }[];
};

export function settlementOf(invoice: SettlementRow) {
  const sum = (rows: { amount: Prisma.Decimal | number }[]) => rows.reduce((t, r) => t + Number(r.amount), 0);
  return settleInvoice(Number(invoice.total), sum(invoice.payments), sum(invoice.creditsReceived));
}

export async function syncInvoiceStatus(invoiceId: string) {
  const invoice = await db.tradeDocument.findUnique({
    where: { id: invoiceId },
    select: { id: true, status: true, total: true, ...settlementInclude },
  });
  if (!invoice || invoice.status === "CANCELLED" || invoice.status === "DRAFT") return;

  const next = settledStatus(settlementOf(invoice));
  if (next !== invoice.status) {
    await db.tradeDocument.update({ where: { id: invoiceId }, data: { status: next } });
  }
  // A project billing stage raised on this invoice follows it: paid, or back to invoiced.
  await syncBillingMilestones(invoiceId);
}
