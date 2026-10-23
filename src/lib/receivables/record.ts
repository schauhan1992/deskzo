import { Prisma, type PaymentMethod } from "@prisma/client";
import type { db } from "@/lib/db";
import { postExchangeDifferenceToLedger, postPaymentToLedger } from "@/lib/ledger/journal";
import { emitPaymentReceived } from "@/lib/automate/emit-records";
import { bookOnFirstPayment } from "@/lib/orders/handoff";

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

/**
 * One payment against one invoice, in the caller's transaction — the payment, how much of it settles the
 * invoice, the order it books, and its postings. What Record payment on an invoice does
 * (src/actions/receivable.ts), and what a paid pay-now link does on its own (src/lib/collect/links.ts), so
 * the books can't tell the two apart.
 *
 * `applied` is how much of the invoice it settles; the payment may be more (a customer who paid a link
 * after part of the invoice was settled by hand) — the rest stays on account, unapplied.
 */
export async function recordPaymentOnInvoice(
  tx: Tx,
  p: {
    invoiceId: string;
    companyId: string;
    branchId: string;
    amount: number;
    applied: number;
    currency: string;
    rate: number;
    paidOn: Date;
    method: PaymentMethod;
    reference: string | null;
    notes: string | null;
    bankAccountId?: string | null;
    userId: string;
  },
): Promise<{ id: string }> {
  const created = await tx.payment.create({
    data: {
      companyId: p.companyId,
      branchId: p.branchId,
      amount: new Prisma.Decimal(p.amount),
      // The amount is in the invoice's currency, at the rate it came in at. Its posting is Dr Bank amount ×
      // that rate / Cr AR the same; the exchange difference below adds back what the invoice booked at its
      // own rate, so AR clears by exactly amount × the invoice's rate and the rest is a realised gain or
      // loss. $1,000 of an invoice booked at ₹83, received at ₹84.10: Bank 84,100, AR 83,000, gain 1,100.
      currency: p.currency,
      exchangeRate: new Prisma.Decimal(p.rate),
      paidOn: p.paidOn,
      method: p.method,
      reference: p.reference,
      notes: p.notes,
      bankAccountId: p.bankAccountId ?? null,
      recordedByUserId: p.userId,
    },
    select: { id: true },
  });
  if (p.applied > 0) {
    await tx.paymentAllocation.create({
      data: { paymentId: created.id, documentId: p.invoiceId, amount: new Prisma.Decimal(p.applied), allocatedByUserId: p.userId },
    });
  }
  // Money against an invoice raised for an in-hand order is money against that order: it counts as
  // booked from this first payment (O-D2).
  await bookOnFirstPayment(tx, { documentLines: { some: { documentId: p.invoiceId } } }, new Date());
  // Posted in the same transaction, so cash in the ledger can't disagree with the payment record.
  await postPaymentToLedger(tx, created.id, p.userId);
  // And the exchange difference, if the invoice was raised at a different rate to the one the money came
  // in at. Domestic settlements pass straight through — both rates are 1.
  if (p.applied > 0) {
    await postExchangeDifferenceToLedger(tx, { paymentId: created.id, documentId: p.invoiceId, allocatedAmount: p.applied, userId: p.userId });
  }
  await emitPaymentReceived(tx, created.id, p.userId, p.invoiceId);
  return created;
}
