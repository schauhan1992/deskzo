"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { canSeeCompany, paymentScope, viaCompanyScope } from "@/lib/authz/company-scope";
import { toPlain } from "@/lib/serialize";
import { hasEffectivePermission, viewerHas } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { postExchangeDifferenceToLedger, postPaymentToLedger } from "@/lib/ledger/journal";
import { bookingRate, crossCurrencyPaymentAmount, settlementRateError, takenFromPayment } from "@/lib/ledger/posting";
import { formatMoney, formatRate, isBaseCurrency } from "@/lib/currency";
import { firstOpenDate } from "@/lib/ledger/period";
import { ensureHeadOffice } from "@/lib/branches/identity";
import { syncBillingMilestones } from "@/lib/projects/billing-sync";
import { bookOnFirstPayment } from "@/lib/orders/handoff";
import {
  settleInvoice,
  settledStatus,
  agingBucket,
  daysOverdue,
  emptyAging,
  withRunningBalance,
  type AgingBucket,
} from "@/lib/receivables";
import { applyCreditNoteSchema, recordInvoicePaymentSchema } from "@/lib/validation/receivable";
import type { ActionResult } from "@/actions/company";

/** Everything needed to settle an invoice, in one shape the whole module reads. */
const invoiceSettlementInclude = {
  payments: { select: { amount: true } },
  creditsReceived: { select: { amount: true } },
} as const;

type SettlementRow = {
  total: Prisma.Decimal | number;
  payments: { amount: Prisma.Decimal | number }[];
  creditsReceived: { amount: Prisma.Decimal | number }[];
};

function settlementOf(invoice: SettlementRow) {
  const sum = (rows: { amount: Prisma.Decimal | number }[]) => rows.reduce((t, r) => t + Number(r.amount), 0);
  return settleInvoice(Number(invoice.total), sum(invoice.payments), sum(invoice.creditsReceived));
}

/**
 * Brings an invoice's stored status in line with what's been settled against it. The status is a
 * cache of the applications, so it's recomputed after every one rather than nudged by hand — that's
 * how an invoice ends up marked PAID with money still outstanding.
 *
 * A cancelled invoice is left alone: it isn't collectable, and re-deriving would resurrect it.
 */
async function syncInvoiceStatus(invoiceId: string) {
  const invoice = await db.tradeDocument.findUnique({
    where: { id: invoiceId },
    select: { id: true, status: true, total: true, ...invoiceSettlementInclude },
  });
  if (!invoice || invoice.status === "CANCELLED" || invoice.status === "DRAFT") return;

  const next = settledStatus(settlementOf(invoice));
  if (next !== invoice.status) {
    await db.tradeDocument.update({ where: { id: invoiceId }, data: { status: next } });
  }
  // The project billing stage raised on this invoice, if any — see src/lib/projects/billing-sync.ts.
  await syncBillingMilestones(invoiceId);
}

/**
 * Records a payment and applies it to one invoice in a single step — the common case, and the one
 * Zoho Books leads with. The amount is capped at what's actually outstanding, so a payment can't
 * settle more than the invoice is worth.
 */
export async function recordInvoicePayment(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("receivables");
  if (!(await hasEffectivePermission(user.id, "payments.record"))) {
    return { ok: false, error: "You don't have permission to record payments." };
  }
  const parsed = recordInvoicePaymentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { invoiceId, amount, paidOn, method, reference, notes } = parsed.data;

  const invoice = await db.tradeDocument.findUnique({
    where: { id: invoiceId },
    select: {
      id: true, companyId: true, docType: true, status: true, docNumber: true, total: true, branchId: true,
      currency: true, exchangeRate: true, ...invoiceSettlementInclude,
    },
  });
  if (!invoice) return { ok: false, error: "That invoice no longer exists." };
  if (invoice.docType !== "INVOICE") return { ok: false, error: "Payments are recorded against a tax invoice." };
  if (invoice.status === "DRAFT") return { ok: false, error: "Issue the invoice before recording a payment." };
  if (invoice.status === "CANCELLED") return { ok: false, error: "This invoice has been cancelled." };

  const settlement = settlementOf(invoice);
  if (amount > settlement.balance) {
    return {
      ok: false,
      error: `Only ${formatMoney(settlement.balance, invoice.currency)} is outstanding on this invoice. Record the excess as a separate payment so it stays unapplied.`,
    };
  }

  // The rate the money actually came in at. A foreign invoice asks for it ("Rate on the day"), and it
  // defaults to the invoice's own; a rupee invoice is 1, whatever rate an older row still carries.
  const rate = isBaseCurrency(invoice.currency) ? 1 : (parsed.data.exchangeRate ?? bookingRate(invoice));
  const rateError = settlementRateError(rate);
  if (rateError) return { ok: false, error: rateError };

  // The money comes in to the branch that billed it (an invoice from before branches: the head office).
  // Resolved before the transaction — the head office lookup uses its own connection.
  const branchId = invoice.branchId ?? (await ensureHeadOffice()).id;

  // One payment, one application — written together so a payment can never exist without the
  // allocation that explains it.
  const payment = await db.$transaction(async (tx) => {
    const created = await tx.payment.create({
      data: {
        companyId: invoice.companyId,
        branchId,
        amount: new Prisma.Decimal(amount),
        // The amount is in the invoice's currency — it was checked against the invoice's balance — so
        // the payment is too, at the rate it came in at. Its posting is Dr Bank amount × that rate /
        // Cr AR the same; the exchange difference below adds back what the invoice booked at its own
        // rate, so AR clears by exactly amount × the invoice's rate and the rest is a realised gain or
        // loss. $1,000 of an invoice booked at ₹83, received at ₹84.10: Bank 84,100, AR 83,000, gain 1,100.
        currency: invoice.currency,
        exchangeRate: new Prisma.Decimal(rate),
        paidOn: new Date(paidOn),
        method,
        reference: reference || null,
        notes: notes || null,
        recordedByUserId: user.id,
      },
      select: { id: true },
    });
    await tx.paymentAllocation.create({
      data: { paymentId: created.id, documentId: invoiceId, amount: new Prisma.Decimal(amount), allocatedByUserId: user.id },
    });
    // Money against an invoice raised for an in-hand order is money against that order: it counts as
    // booked from this first payment (O-D2).
    await bookOnFirstPayment(tx, { documentLines: { some: { documentId: invoiceId } } }, new Date());
    // Posted in the same transaction, so cash in the ledger can't disagree with the payment record.
    await postPaymentToLedger(tx, created.id, user.id);
    // And the exchange difference, if the invoice was raised at a different rate to the one the
    // money came in at. Domestic settlements pass straight through — both rates are 1.
    await postExchangeDifferenceToLedger(tx, {
      paymentId: created.id,
      documentId: invoiceId,
      allocatedAmount: amount,
      userId: user.id,
    });
    return created;
  });

  await syncInvoiceStatus(invoiceId);
  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "Payment",
    entityId: payment.id,
    entityLabel: `${formatMoney(amount, invoice.currency)}${isBaseCurrency(invoice.currency) ? "" : ` at ${formatRate(rate)}`} against ${invoice.docNumber}`,
  });

  revalidatePath(`/documents/${invoiceId}`);
  revalidatePath(`/companies/${invoice.companyId}`);
  revalidatePath("/sales/invoices");
  revalidatePath("/receivables");
  return { ok: true, data: { id: payment.id } };
}

/**
 * Applies an existing unapplied payment to an invoice — for a lump sum received on account and
 * settled against invoices later, which is the other half of how money actually arrives.
 *
 * `amount` is how much of the **invoice** the money settles, in the invoice's currency — the figure its
 * balance is kept in.
 *
 * **Rupees on account against a foreign invoice** (the payment in INR, the invoice in USD): `rate` is
 * required — the rate agreed on the day, ₹ per unit of the invoice's currency. The allocation settles
 * `amount` of the invoice, takes `round(amount × rate)` rupees out of the payment, and stores both
 * (`paymentAmount`, `exchangeRate`). The payment's own posting credited AR with the rupees when they
 * came in; the invoice booked `amount × its rate` for the part now settled, and the difference is a
 * realised gain or loss (`postExchangeDifferenceToLedger`). ₹84,100 settling $1,000 of an invoice
 * booked at ₹83 is a gain of ₹1,100, and the customer's AR is back to nil.
 *
 * **Same currency** (rupees to a rupee invoice, dollars to a dollar one): the payment's own rate is the
 * rate, so `rate` is left out (or is that rate), and the difference is the payment's rate against the
 * invoice's, as when the payment is recorded against the invoice directly.
 *
 * A payment in one foreign currency is not applied to a document in another: there is no rate between
 * two of them that the books could take.
 *
 * The exchange difference is dated when the settlement became possible: the later of the payment's
 * day and the invoice's — which is also how the close's receivables tie-out counts an allocation (from
 * its payment's date, against documents issued by then), so the two agree at every month end. When
 * that day is in closed books it goes to the first open day instead, as the FX repair does.
 *
 * An action only: there is no form for it in the app yet.
 */
export async function applyPaymentToInvoice(
  paymentId: string,
  invoiceId: string,
  amount: number,
  rate?: number,
): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("receivables");
  if (!(await hasEffectivePermission(user.id, "payments.record"))) {
    return { ok: false, error: "You don't have permission to allocate payments." };
  }
  if (!(Number.isFinite(amount) && amount > 0)) return { ok: false, error: "Enter an amount greater than zero." };
  const settled = Math.round(amount * 100) / 100;

  const [payment, invoice] = await Promise.all([
    db.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true, companyId: true, direction: true, amount: true, currency: true, exchangeRate: true, paidOn: true,
        allocations: { select: { amount: true, paymentAmount: true } },
      },
    }),
    db.tradeDocument.findUnique({
      where: { id: invoiceId },
      select: {
        id: true, companyId: true, docType: true, status: true, docNumber: true, total: true, currency: true, exchangeRate: true,
        issueDate: true, ...invoiceSettlementInclude,
      },
    }),
  ]);
  if (!payment) return { ok: false, error: "That payment no longer exists." };
  if (!invoice) return { ok: false, error: "That invoice no longer exists." };
  if (payment.direction !== "RECEIVED") return { ok: false, error: "That is a payment made, not one received." };
  if (invoice.companyId !== payment.companyId) {
    return { ok: false, error: "That invoice belongs to a different customer." };
  }
  if (invoice.docType !== "INVOICE" || invoice.status === "DRAFT" || invoice.status === "CANCELLED") {
    return { ok: false, error: "That isn't an open invoice." };
  }

  const across = payment.currency !== invoice.currency;
  const given = rate === undefined || rate === null ? null : Number(rate);
  if (across && !isBaseCurrency(payment.currency)) {
    return {
      ok: false,
      error: `This payment is in ${payment.currency} and the invoice in ${invoice.currency}. A ${payment.currency} payment is applied to a ${payment.currency} invoice.`,
    };
  }
  if (across && given === null) {
    return { ok: false, error: `Enter the rate on the day (₹ per ${invoice.currency}) this money settles the invoice at.` };
  }
  if (!across && given !== null && given !== bookingRate(payment)) {
    return { ok: false, error: `This payment is already in ${payment.currency} at ${formatRate(bookingRate(payment))}; it settles at its own rate.` };
  }
  if (across) {
    const rateError = settlementRateError(given!);
    if (rateError) return { ok: false, error: rateError };
  }
  // What this allocation takes out of the payment, in the payment's currency.
  const taken = across ? crossCurrencyPaymentAmount(settled, given!) : settled;

  // The invoice first — it is the figure being typed — then what that comes to against the payment.
  const settlement = settlementOf(invoice);
  if (settled > settlement.balance + 0.001) {
    return { ok: false, error: `Only ${formatMoney(settlement.balance, invoice.currency)} is outstanding on that invoice.` };
  }
  const unapplied =
    Math.round((Number(payment.amount) - payment.allocations.reduce((t, a) => t + takenFromPayment(a), 0)) * 100) / 100;
  if (taken > unapplied + 0.001) {
    return {
      ok: false,
      error: across
        ? `${formatMoney(settled, invoice.currency)} at ${formatRate(given)} is ${formatMoney(taken, payment.currency)}; only ${formatMoney(unapplied, payment.currency)} of this payment is unapplied.`
        : `Only ${formatMoney(unapplied, payment.currency)} of this payment is unapplied.`,
    };
  }

  const settledOn = payment.paidOn.getTime() > invoice.issueDate.getTime() ? payment.paidOn : invoice.issueDate;
  const allocation = await db.$transaction(async (tx) => {
    const lock = await tx.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
    const on = firstOpenDate(settledOn, lock?.lockedUntil);
    const row = await tx.paymentAllocation.create({
      data: {
        paymentId,
        documentId: invoiceId,
        amount: new Prisma.Decimal(settled),
        ...(across ? { paymentAmount: new Prisma.Decimal(taken), exchangeRate: new Prisma.Decimal(given!) } : {}),
        allocatedByUserId: user.id,
      },
    });
    // An invoice raised for an in-hand order: the order counts as booked from its first payment (O-D2).
    await bookOnFirstPayment(tx, { documentLines: { some: { documentId: invoiceId } } }, new Date());
    // The difference only exists once you know which invoice the money is against — the same
    // $1,000 settling an invoice raised at ₹83 and one raised at ₹86 are different gains.
    await postExchangeDifferenceToLedger(tx, {
      paymentId,
      documentId: invoiceId,
      allocatedAmount: settled,
      paymentAmount: across ? taken : null,
      date: on,
      userId: user.id,
    });
    return row;
  });
  await syncInvoiceStatus(invoiceId);
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Payment",
    entityId: paymentId,
    entityLabel: `${formatMoney(settled, invoice.currency)} applied to ${invoice.docNumber}${across ? ` at ${formatRate(given)} (${formatMoney(taken, payment.currency)})` : ""}`,
  });

  revalidatePath(`/documents/${invoiceId}`);
  revalidatePath(`/companies/${invoice.companyId}`);
  revalidatePath("/receivables");
  revalidatePath("/payments");
  return { ok: true, data: { id: allocation.id } };
}

/**
 * Offsets an invoice with a credit note. No money moves — the customer owes less — so this is its
 * own ledger rather than a payment with a negative sign, which is what keeps "received" honest.
 */
export async function applyCreditNote(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("receivables");
  if (!(await hasEffectivePermission(user.id, "payments.record"))) {
    return { ok: false, error: "You don't have permission to apply credit notes." };
  }
  const parsed = applyCreditNoteSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { creditNoteId, invoiceId, amount } = parsed.data;

  const [creditNote, invoice] = await Promise.all([
    db.tradeDocument.findUnique({
      where: { id: creditNoteId },
      select: { id: true, companyId: true, docType: true, status: true, total: true, docNumber: true, currency: true, creditsApplied: { select: { amount: true } } },
    }),
    db.tradeDocument.findUnique({
      where: { id: invoiceId },
      select: { id: true, companyId: true, docType: true, status: true, docNumber: true, total: true, currency: true, ...invoiceSettlementInclude },
    }),
  ]);
  if (!creditNote || creditNote.docType !== "CREDIT_NOTE") return { ok: false, error: "That isn't a credit note." };
  if (!invoice || invoice.docType !== "INVOICE") return { ok: false, error: "That isn't a tax invoice." };
  if (creditNote.status === "DRAFT") return { ok: false, error: "Issue the credit note before applying it." };
  if (invoice.status === "DRAFT" || invoice.status === "CANCELLED") {
    return { ok: false, error: "That invoice isn't open." };
  }
  if (creditNote.companyId !== invoice.companyId) {
    return { ok: false, error: "The credit note and invoice belong to different customers." };
  }
  // Both balances are kept in each document's own currency, and a credit application books nothing to
  // convert one into the other — $100 of credit would take ₹100 off a rupee invoice.
  if (creditNote.currency !== invoice.currency) {
    return { ok: false, error: `The credit note is in ${creditNote.currency} and the invoice in ${invoice.currency}; a credit note is applied to an invoice in its own currency.` };
  }

  const creditRemaining =
    Number(creditNote.total) - creditNote.creditsApplied.reduce((t, a) => t + Number(a.amount), 0);
  if (amount > creditRemaining + 0.001) {
    return { ok: false, error: `Only ${formatMoney(creditRemaining, creditNote.currency)} of this credit note is unapplied.` };
  }
  const settlement = settlementOf(invoice);
  if (amount > settlement.balance + 0.001) {
    return { ok: false, error: `Only ${formatMoney(settlement.balance, invoice.currency)} is outstanding on that invoice.` };
  }

  try {
    await db.creditNoteApplication.create({
      data: { creditNoteId, invoiceId, amount: new Prisma.Decimal(amount), appliedByUserId: user.id },
    });
  } catch (err) {
    // The unique pair means a second application to the same invoice is an edit, not a new row.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "This credit note is already applied to that invoice — remove it first to change the amount." };
    }
    throw err;
  }

  await syncInvoiceStatus(invoiceId);
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "TradeDocument",
    entityId: creditNoteId,
    entityLabel: `${creditNote.docNumber} applied to ${invoice.docNumber}`,
  });

  revalidatePath(`/documents/${invoiceId}`);
  revalidatePath(`/documents/${creditNoteId}`);
  revalidatePath(`/companies/${invoice.companyId}`);
  revalidatePath("/receivables");
  return { ok: true, data: { id: invoiceId } };
}

export async function removeCreditNoteApplication(id: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("receivables");
  if (!(await hasEffectivePermission(user.id, "payments.delete"))) {
    return { ok: false, error: "You don't have permission to remove a credit application." };
  }
  const application = await db.creditNoteApplication.findUnique({ where: { id }, select: { invoiceId: true, creditNoteId: true } });
  if (!application) return { ok: false, error: "That application no longer exists." };

  await db.creditNoteApplication.delete({ where: { id } });
  await syncInvoiceStatus(application.invoiceId);

  revalidatePath(`/documents/${application.invoiceId}`);
  revalidatePath(`/documents/${application.creditNoteId}`);
  revalidatePath("/receivables");
  return { ok: true, data: { id: application.invoiceId } };
}

/**
 * The account-scope guard for a function handed a `companyId` by its caller.
 *
 * Filtering achieves nothing on these — the caller has already named the customer — so the company
 * is looked up for its account manager and the answer is a refusal rather than a shorter list. A
 * customer that no longer exists is refused the same way, so a company id can't be used to find out
 * which accounts are real.
 */
async function maySeeCustomer(userId: string, companyId: string): Promise<boolean> {
  const company = await db.company.findUnique({ where: { id: companyId }, select: { ownerUserId: true } });
  return company !== null && (await canSeeCompany(userId, company.ownerUserId));
}

/** One invoice's settlement, with the payments and credits that produced it. */
export async function getInvoiceSettlement(invoiceId: string) {
  const user = await requireModuleUser("receivables");
  if (!(await viewerHas("payments.view"))) return null;
  const invoice = await db.tradeDocument.findFirst({
    // Reached through the party, like the invoice itself: what has been paid and what is still
    // outstanding is the account's business, not everybody's. `findFirst` so the scope can travel
    // beside the id, and an invoice outside the viewer's book reads as missing.
    where: { id: invoiceId, ...(await viaCompanyScope(user.id)) },
    select: {
      id: true,
      total: true,
      // Every figure below is in this currency; the panel shows them in it, and asks for the rate a
      // foreign receipt came in at against this one.
      currency: true,
      exchangeRate: true,
      payments: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          amount: true,
          paymentAmount: true,
          exchangeRate: true,
          createdAt: true,
          payment: { select: { id: true, paidOn: true, method: true, reference: true, currency: true, exchangeRate: true } },
        },
      },
      creditsReceived: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          amount: true,
          creditNote: { select: { id: true, docNumber: true, issueDate: true } },
        },
      },
    },
  });
  if (!invoice) return null;

  return toPlain({
    ...settleInvoice(
      Number(invoice.total),
      invoice.payments.reduce((t, p) => t + Number(p.amount), 0),
      invoice.creditsReceived.reduce((t, c) => t + Number(c.amount), 0),
    ),
    currency: invoice.currency,
    exchangeRate: bookingRate(invoice),
    payments: invoice.payments,
    credits: invoice.creditsReceived,
  });
}

/** How much of a credit note is still available to apply. */
export async function getCreditNoteBalance(creditNoteId: string) {
  const user = await requireModuleUser("receivables");
  if (!(await viewerHas("payments.view"))) return null;
  const creditNote = await db.tradeDocument.findFirst({
    where: { id: creditNoteId, ...(await viaCompanyScope(user.id)) },
    select: {
      total: true,
      currency: true,
      creditsApplied: {
        orderBy: { createdAt: "desc" },
        select: { id: true, amount: true, invoice: { select: { id: true, docNumber: true, issueDate: true } } },
      },
    },
  });
  if (!creditNote) return null;
  const applied = creditNote.creditsApplied.reduce((t, a) => t + Number(a.amount), 0);
  return toPlain({
    currency: creditNote.currency,
    total: Number(creditNote.total),
    applied,
    remaining: Math.max(Number(creditNote.total) - applied, 0),
    applications: creditNote.creditsApplied,
  });
}

/** Open invoices for a customer — the picker when applying a payment or a credit note. */
export async function listOpenInvoices(companyId: string) {
  const user = await requireModuleUser("receivables");
  if (!(await viewerHas("payments.view"))) return [];
  // Every unpaid invoice a customer has, with what is still owed on each — the picker is reached
  // from a credit note the viewer is already on, so this only refuses an id passed in by hand.
  if (!(await maySeeCustomer(user.id, companyId))) return [];
  const invoices = await db.tradeDocument.findMany({
    where: { companyId, docType: "INVOICE", status: { notIn: ["DRAFT", "CANCELLED"] } },
    orderBy: { issueDate: "asc" },
    select: { id: true, docNumber: true, issueDate: true, dueDate: true, total: true, currency: true, ...invoiceSettlementInclude },
  });
  return invoices
    .map((invoice) => ({
      id: invoice.id,
      docNumber: invoice.docNumber,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      currency: invoice.currency,
      ...settlementOf(invoice),
    }))
    .filter((invoice) => invoice.balance > 0.01);
}

/**
 * A customer's statement of account: every invoice, payment and credit note in date order with a
 * running balance, plus the aging of what's still outstanding.
 */
export async function customerStatement(companyId: string, opts?: { from?: string; to?: string }) {
  const user = await requireModuleUser("receivables");
  if (!(await viewerHas("payments.view"))) return null;
  const asOf = new Date();

  /**
   * Scoped rather than refused, because the statement's shape is what the page is built on and a
   * customer outside the viewer's book should read as one they have no history with.
   *
   * Spread into all five queries below, not just the first: the aging comes from the invoices, but
   * the closing balance comes from the payments and the unapplied figures from two aggregates, and
   * a statement scoped in four places out of five still publishes what the account has paid us.
   */
  const documentScope = await viaCompanyScope(user.id);
  const receiptScope = await paymentScope(user.id);

  const [invoices, payments, creditNotes] = await Promise.all([
    db.tradeDocument.findMany({
      where: { companyId, ...documentScope, docType: "INVOICE", status: { notIn: ["DRAFT", "CANCELLED"] } },
      orderBy: { issueDate: "asc" },
      select: { id: true, docNumber: true, issueDate: true, dueDate: true, total: true, currency: true, ...invoiceSettlementInclude },
    }),
    db.payment.findMany({
      where: { companyId, ...receiptScope },
      orderBy: { paidOn: "asc" },
      select: { id: true, amount: true, paidOn: true, method: true, reference: true },
    }),
    db.tradeDocument.findMany({
      where: { companyId, ...documentScope, docType: "CREDIT_NOTE", status: { notIn: ["DRAFT", "CANCELLED"] } },
      orderBy: { issueDate: "asc" },
      select: { id: true, docNumber: true, issueDate: true, total: true },
    }),
  ]);

  const entries = [
    ...invoices.map((i) => ({
      id: i.id,
      date: i.issueDate,
      kind: "INVOICE" as const,
      reference: i.docNumber,
      description: "Tax invoice",
      debit: Number(i.total),
      credit: 0,
      href: `/documents/${i.id}`,
    })),
    ...payments.map((p) => ({
      id: p.id,
      date: p.paidOn,
      kind: "PAYMENT" as const,
      reference: p.reference ?? p.method.replaceAll("_", " "),
      description: "Payment received",
      debit: 0,
      credit: Number(p.amount),
      href: null,
    })),
    ...creditNotes.map((c) => ({
      id: c.id,
      date: c.issueDate,
      kind: "CREDIT_NOTE" as const,
      reference: c.docNumber,
      description: "Credit note",
      debit: 0,
      credit: Number(c.total),
      href: `/documents/${c.id}`,
    })),
  ];

  const filtered = entries.filter((e) => {
    if (opts?.from && e.date < new Date(`${opts.from}T00:00:00`)) return false;
    if (opts?.to && e.date > new Date(`${opts.to}T23:59:59.999`)) return false;
    return true;
  });

  const aging = emptyAging();
  const openInvoices: {
    id: string;
    docNumber: string;
    issueDate: Date;
    dueDate: Date | null;
    /** In the invoice's own currency, which the row shows it in. */
    balance: number;
    currency: string;
    daysOverdue: number;
    bucket: AgingBucket;
  }[] = [];

  for (const invoice of invoices) {
    const settlement = settlementOf(invoice);
    if (settlement.balance < 0.01) continue;
    const bucket = agingBucket(invoice.dueDate, invoice.issueDate, asOf);
    aging[bucket] += settlement.balance;
    openInvoices.push({
      id: invoice.id,
      docNumber: invoice.docNumber,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      balance: settlement.balance,
      currency: invoice.currency,
      daysOverdue: daysOverdue(invoice.dueDate, invoice.issueDate, asOf),
      bucket,
    });
  }

  const invoiced = invoices.reduce((t, i) => t + Number(i.total), 0);
  const received = payments.reduce((t, p) => t + Number(p.amount), 0);
  const credited = creditNotes.reduce((t, c) => t + Number(c.total), 0);

  // Money received or credited that hasn't been set against an invoice yet. Without this the
  // statement reads as a contradiction: nothing outstanding, but a negative closing balance. They
  // measure different things — what's still owed on invoices, versus what's sitting on account.
  // What each allocation took out of its payment (`takenFromPayment`): rupees on account set against a
  // USD invoice settle dollars but spend rupees, and it is the rupees that leave the payment.
  const [appliedPayments, appliedCredits] = await Promise.all([
    db.paymentAllocation.findMany({ where: { payment: { companyId, ...receiptScope } }, select: { amount: true, paymentAmount: true } }),
    db.creditNoteApplication.aggregate({ where: { creditNote: { companyId, ...documentScope } }, _sum: { amount: true } }),
  ]);
  const unappliedPayments = Math.max(received - appliedPayments.reduce((t, a) => t + takenFromPayment(a), 0), 0);
  const unappliedCredits = Math.max(credited - Number(appliedCredits._sum.amount ?? 0), 0);
  const outstanding = Object.values(aging).reduce((t, v) => t + v, 0);

  return toPlain({
    ledger: withRunningBalance(filtered),
    aging,
    openInvoices: openInvoices.sort((a, b) => b.daysOverdue - a.daysOverdue),
    outstanding,
    invoiced,
    received,
    credited,
    unappliedPayments,
    unappliedCredits,
    /** Positive = they owe us; negative = they're in credit with us. */
    netPosition: Math.round((outstanding - unappliedPayments - unappliedCredits) * 100) / 100,
  });
}

/**
 * The AR aging report: every customer with something outstanding, bucketed by how overdue it is.
 * Computed in memory because the bucket depends on each invoice's own due date against today,
 * which SQL can't group on without a date-arithmetic expression per bucket.
 */
export async function agingReport(params?: { search?: string }) {
  const user = await requireModuleUser("receivables");
  if (!(await viewerHas("payments.view"))) return { rows: [], totals: { buckets: emptyAging(), total: 0 } };
  const asOf = new Date();

  const invoices = await db.tradeDocument.findMany({
    where: {
      docType: "INVOICE",
      status: { notIn: ["DRAFT", "CANCELLED", "PAID"] },
      /**
       * Both conditions reach the company, so they go in an `AND` rather than side by side.
       *
       * They were side by side, and a spread is an assignment: `viaCompanyScope` writes `company`,
       * the search wrote `company` again a line later, and the second one won. The report was
       * correctly scoped until somebody typed in the search box, at which point the scope silently
       * vanished — measured at the time: 8 rows became 54, of which 48 were other people's
       * customers, with names and exactly what each owed.
       *
       * Nothing about that is visible in the types, and the unsearched path kept passing, which is
       * why the check now exercises the searched one too.
       */
      AND: [
        await viaCompanyScope(user.id),
        ...(params?.search
          ? [{ company: { name: { contains: params.search, mode: "insensitive" as const } } }]
          : []),
      ],
    },
    select: {
      id: true,
      docNumber: true,
      issueDate: true,
      dueDate: true,
      total: true,
      company: { select: { id: true, name: true } },
      ...invoiceSettlementInclude,
    },
  });

  const byCompany = new Map<
    string,
    { id: string; name: string; buckets: Record<AgingBucket, number>; total: number; oldest: number; invoiceCount: number }
  >();

  for (const invoice of invoices) {
    const settlement = settlementOf(invoice);
    if (settlement.balance < 0.01) continue;
    const bucket = agingBucket(invoice.dueDate, invoice.issueDate, asOf);
    const overdue = daysOverdue(invoice.dueDate, invoice.issueDate, asOf);

    const row =
      byCompany.get(invoice.company.id) ??
      { id: invoice.company.id, name: invoice.company.name, buckets: emptyAging(), total: 0, oldest: 0, invoiceCount: 0 };
    row.buckets[bucket] += settlement.balance;
    row.total += settlement.balance;
    row.oldest = Math.max(row.oldest, overdue);
    row.invoiceCount += 1;
    byCompany.set(invoice.company.id, row);
  }

  const rows = [...byCompany.values()].sort((a, b) => b.total - a.total);
  const totals = rows.reduce(
    (acc, row) => {
      for (const key of Object.keys(acc.buckets) as AgingBucket[]) acc.buckets[key] += row.buckets[key];
      acc.total += row.total;
      return acc;
    },
    { buckets: emptyAging(), total: 0 },
  );

  return toPlain({ rows, totals });
}

/** Issued credit notes for a customer that still have an unapplied balance. */
export async function listAvailableCredits(companyId: string) {
  const user = await requireModuleUser("receivables");
  if (!(await viewerHas("payments.view"))) return [];
  if (!(await maySeeCustomer(user.id, companyId))) return [];
  const creditNotes = await db.tradeDocument.findMany({
    where: { companyId, docType: "CREDIT_NOTE", status: { notIn: ["DRAFT", "CANCELLED"] } },
    orderBy: { issueDate: "asc" },
    select: { id: true, docNumber: true, total: true, currency: true, creditsApplied: { select: { amount: true } } },
  });
  return creditNotes
    .map((c) => {
      const applied = c.creditsApplied.reduce((t, a) => t + Number(a.amount), 0);
      return {
        id: c.id,
        docNumber: c.docNumber,
        currency: c.currency,
        total: Number(c.total),
        remaining: Math.max(Number(c.total) - applied, 0),
      };
    })
    .filter((c) => c.remaining > 0.01);
}
