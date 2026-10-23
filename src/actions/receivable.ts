"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { documentAccess, mayAccess, mayAddTo, throughAccount } from "@/lib/authz/access";
import { toPlain } from "@/lib/serialize";
import { hasEffectivePermission, viewerHas } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { postExchangeDifferenceToLedger } from "@/lib/ledger/journal";
import { bookingRate, crossCurrencyPaymentAmount, settlementRateError, takenFromPayment } from "@/lib/ledger/posting";
import { formatMoney, formatRate, isBaseCurrency } from "@/lib/currency";
import { firstOpenDate } from "@/lib/ledger/period";
import { ensureHeadOffice } from "@/lib/branches/identity";
import { syncInvoiceStatus } from "@/lib/receivables/sync";
import { recordPaymentOnInvoice } from "@/lib/receivables/record";
import { isReceivable, RECEIVABLE_DOC_TYPE } from "@/lib/trade-documents";
import { balanceSummaryFor } from "@/lib/receivables/balance-summary";
import { partyStatement } from "@/lib/receivables/statement";
import { agingReportFor, type AgingParams } from "@/lib/receivables/aging";
import { exportAging } from "@/lib/receivables/aging-export";
import type { ExportPayload } from "@/actions/data-export";
import { bookOnFirstPayment } from "@/lib/orders/handoff";
import { settlePromisesFor } from "@/lib/collections/promises";
import { loadFollowUps, mayLogFollowUps, receivableFollowUps } from "@/lib/collections/load";
import {
  settleInvoice,
  agingBucket,
  daysOverdue,
  emptyAging,
  type AgingBucket,
} from "@/lib/receivables";
import { applyCreditNoteSchema, recordInvoicePaymentSchema } from "@/lib/validation/receivable";
import type { ActionResult } from "@/actions/company";

/** Everything needed to settle an invoice, in one shape the whole module reads. */
const invoiceSettlementInclude = {
  paidBefore: true,
  payments: { select: { amount: true } },
  creditsReceived: { select: { amount: true } },
} as const;

/** A credit note's credit still to apply: what it gave, less what it was used for here and before Deskzo. */
const creditLeft = (note: { total: Prisma.Decimal | number; paidBefore: Prisma.Decimal | number; creditsApplied: { amount: Prisma.Decimal | number }[] }) =>
  Math.max(Number(note.total) - Number(note.paidBefore) - note.creditsApplied.reduce((t, a) => t + Number(a.amount), 0), 0);

type SettlementRow = {
  total: Prisma.Decimal | number;
  /** What it had settled in the old system, when it was brought from there (src/lib/receivables.ts). */
  paidBefore: Prisma.Decimal | number;
  payments: { amount: Prisma.Decimal | number }[];
  creditsReceived: { amount: Prisma.Decimal | number }[];
};

function settlementOf(invoice: SettlementRow) {
  const sum = (rows: { amount: Prisma.Decimal | number }[]) => rows.reduce((t, r) => t + Number(r.amount), 0);
  return settleInvoice(Number(invoice.total), sum(invoice.payments), sum(invoice.creditsReceived), Number(invoice.paidBefore));
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
      company: { select: { ownerUserId: true, relationshipType: true } },
    },
  });
  // An invoice this person can open, on a customer they may record payments for: the permission says
  // they may record payments, not whose.
  if (!invoice || !(await mayAccess(user.id, "documents", "view", invoice.id)) || !(await mayAddTo(user.id, "payments", invoice.company))) {
    return { ok: false, error: "That invoice no longer exists." };
  }
  // A debit note is owed like the invoice it adds to (src/lib/trade-documents.ts `RECEIVABLE_TYPES`).
  if (!isReceivable(invoice.docType)) return { ok: false, error: "Payments are recorded against a tax invoice or a debit note." };
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
  // allocation that explains it (src/lib/receivables/record.ts, which a paid pay-now link shares).
  const payment = await db.$transaction((tx) =>
    recordPaymentOnInvoice(tx, {
      invoiceId,
      companyId: invoice.companyId,
      branchId,
      // The amount is in the invoice's currency — it was checked against the invoice's balance — so the
      // payment is too, at the rate it came in at.
      amount,
      applied: amount,
      currency: invoice.currency,
      rate,
      paidOn: new Date(paidOn),
      method,
      reference: reference || null,
      notes: notes || null,
      userId: user.id,
    }),
  );

  await syncInvoiceStatus(invoiceId);
  // A promise to pay this invoice, kept by this money (src/lib/collections/promises.ts). Never fails the payment.
  await settlePromisesFor({ documentIds: [invoiceId] });
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
  // Applying money changes the payment and settles the invoice: both have to be this person's to touch.
  if (!payment || !(await mayAccess(user.id, "payments", "edit", payment.id))) return { ok: false, error: "That payment no longer exists." };
  if (!invoice || !(await mayAccess(user.id, "documents", "edit", invoice.id))) return { ok: false, error: "That invoice no longer exists." };
  if (payment.direction !== "RECEIVED") return { ok: false, error: "That is a payment made, not one received." };
  if (invoice.companyId !== payment.companyId) {
    return { ok: false, error: "That invoice belongs to a different customer." };
  }
  if (!isReceivable(invoice.docType) || invoice.status === "DRAFT" || invoice.status === "CANCELLED") {
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
  await settlePromisesFor({ documentIds: [invoiceId] });
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
      select: { id: true, companyId: true, docType: true, status: true, total: true, paidBefore: true, docNumber: true, currency: true, creditsApplied: { select: { amount: true } } },
    }),
    db.tradeDocument.findUnique({
      where: { id: invoiceId },
      select: { id: true, companyId: true, docType: true, status: true, docNumber: true, total: true, currency: true, ...invoiceSettlementInclude },
    }),
  ]);
  // Both documents are this person's to touch, or neither is found — the same answer a made-up id gets.
  if (creditNote && !(await mayAccess(user.id, "documents", "edit", creditNote.id))) return { ok: false, error: "That isn't a credit note." };
  if (invoice && !(await mayAccess(user.id, "documents", "edit", invoice.id))) return { ok: false, error: "That isn't a tax invoice." };
  if (!creditNote || creditNote.docType !== "CREDIT_NOTE") return { ok: false, error: "That isn't a credit note." };
  if (!invoice || !isReceivable(invoice.docType)) return { ok: false, error: "That isn't a tax invoice." };
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

  const creditRemaining = creditLeft(creditNote);
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
  // A credit note settles too: a promise is kept when the invoice's settled amount rises by what was promised.
  await settlePromisesFor({ documentIds: [invoiceId] });
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
  // Taking the credit off reopens the invoice, so the invoice has to be this person's to change.
  if (!application || !(await mayAccess(user.id, "documents", "edit", application.invoiceId))) {
    return { ok: false, error: "That application no longer exists." };
  }

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
  const company = await db.company.findUnique({ where: { id: companyId }, select: { ownerUserId: true, relationshipType: true } });
  return company !== null && (await canSeeCompany(userId, company));
}

/** One invoice's settlement, with the payments and credits that produced it. */
export async function getInvoiceSettlement(invoiceId: string) {
  const user = await requireModuleUser("receivables");
  if (!(await viewerHas("payments.view"))) return null;
  const invoice = await db.tradeDocument.findFirst({
    // An invoice this person may open (the document rule, src/lib/authz/access.ts): what has been
    // paid and what is still outstanding is the account's business, not everybody's. `findFirst` so
    // the scope can travel beside the id, and an invoice outside the viewer's book reads as missing.
    where: { AND: [{ id: invoiceId }, await documentAccess(user.id, "view")] },
    select: {
      id: true,
      total: true,
      paidBefore: true,
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
      Number(invoice.paidBefore),
    ),
    // Settled in the old system, before it came to Deskzo — part of "paid" above, shown on its own.
    paidBefore: Number(invoice.paidBefore),
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
    where: { AND: [{ id: creditNoteId }, await documentAccess(user.id, "view")] },
    select: {
      total: true,
      paidBefore: true,
      currency: true,
      creditsApplied: {
        orderBy: { createdAt: "desc" },
        select: { id: true, amount: true, invoice: { select: { id: true, docNumber: true, issueDate: true } } },
      },
    },
  });
  if (!creditNote) return null;
  const applied = creditNote.creditsApplied.reduce((t, a) => t + Number(a.amount), 0) + Number(creditNote.paidBefore);
  return toPlain({
    currency: creditNote.currency,
    total: Number(creditNote.total),
    applied,
    remaining: creditLeft(creditNote),
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
    where: { AND: [{ companyId, docType: RECEIVABLE_DOC_TYPE, status: { notIn: ["DRAFT", "CANCELLED"] } }, await documentAccess(user.id, "view")] },
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
 * A customer's statement of account: every invoice, payment, credit note, exchange difference and journal
 * in date order with a running balance, in rupees, the aging of what's still outstanding, and what is open
 * in each foreign currency they deal in (src/lib/receivables/statement.ts; owner, 21 Oct 2026: "rupees, plus
 * a per-currency section"). Its closing balance is their row in the Customer Balance Summary.
 *
 * The whole account, for somebody who reaches the customer — as the balance summary counts it: a statement
 * of only the invoices one may open would show a customer with a payment and no invoice as in credit, and
 * `payments.view` is "money in and owed … the billed and outstanding figures". Out of reach answers null.
 */
export async function customerStatement(companyId: string, opts?: { from?: string; to?: string }) {
  const user = await requireModuleUser("receivables");
  if (!(await viewerHas("payments.view"))) return null;
  if (!(await maySeeCustomer(user.id, companyId))) return null;
  const asOf = new Date();
  const statement = await partyStatement("AR", companyId, opts);

  // Collections: every follow-up on this account's invoices and orders — one history for sales and
  // accounts, to anybody who can see the account (collections' own rule: the account's, not a record's).
  const [followUps, canLogFollowUps] = await Promise.all([
    loadFollowUps({ AND: [{ companyId }, (await throughAccount(user.id, "view")) as Prisma.PaymentFollowUpWhereInput] }, asOf),
    mayLogFollowUps(user.id),
  ]);

  return toPlain({
    followUps,
    canLogFollowUps,
    ledger: statement.lines,
    aging: statement.aging,
    openInvoices: statement.openDocuments,
    outstanding: statement.outstanding,
    invoiced: statement.invoiced,
    received: statement.received,
    credited: statement.credited,
    unappliedPayments: statement.unappliedPayments,
    unappliedCredits: statement.unappliedCredits,
    /** Opening balances and journals naming them. */
    journals: statement.journals,
    /** Positive = they owe us; negative = they're in credit with us. What Accounts Receivable holds for them. */
    netPosition: statement.balance,
    /** What is open in each other currency, as written. */
    currencies: statement.currencies,
  });
}

/**
 * The AR aging report: every customer with something outstanding, bucketed by how overdue it is.
 * Computed in memory because the bucket depends on each invoice's own due date against today,
 * which SQL can't group on without a date-arithmetic expression per bucket.
 */
export async function agingReport(params?: { search?: string; promise?: string }) {
  const user = await requireModuleUser("receivables");
  if (!(await viewerHas("payments.view"))) return { rows: [], totals: { buckets: emptyAging(), total: 0 } };
  const asOf = new Date();
  /** Collections' filters: customers with a broken promise to pay, or one due in the next seven days. */
  const promiseFilter = params?.promise === "broken" || params?.promise === "week" ? params.promise : null;

  const invoices = await db.tradeDocument.findMany({
    where: {
      docType: RECEIVABLE_DOC_TYPE,
      status: { notIn: ["DRAFT", "CANCELLED", "PAID"] },
      /**
       * Both conditions can reach the company, so they go in an `AND` rather than side by side.
       *
       * They were side by side, and a spread is an assignment: the scope wrote `company`,
       * the search wrote `company` again a line later, and the second one won. The report was
       * correctly scoped until somebody typed in the search box, at which point the scope silently
       * vanished — measured at the time: 8 rows became 54, of which 48 were other people's
       * customers, with names and exactly what each owed.
       *
       * Nothing about that is visible in the types, and the unsearched path kept passing, which is
       * why the check now exercises the searched one too.
       */
      AND: [
        // The invoices this person may open (the document rule, src/lib/authz/access.ts).
        await documentAccess(user.id, "view"),
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
      currency: true,
      exchangeRate: true,
      company: { select: { id: true, companySeq: true, name: true } },
      ...invoiceSettlementInclude,
      lines: { where: { companyProductId: { not: null } }, select: { companyProductId: true } },
    },
  });

  const byCompany = new Map<
    string,
    {
      id: string;
      companySeq: number;
      name: string;
      buckets: Record<AgingBucket, number>;
      total: number;
      oldest: number;
      invoiceCount: number;
      /** What of it is owed in other currencies, as the invoices are written. */
      foreign: Record<string, number>;
    }
  >();
  const open: { id: string; companyId: string; orderIds: string[] }[] = [];

  for (const invoice of invoices) {
    const settlement = settlementOf(invoice);
    if (settlement.balance < 0.01) continue;
    open.push({ id: invoice.id, companyId: invoice.company.id, orderIds: invoice.lines.map((l) => l.companyProductId!) });
    const bucket = agingBucket(invoice.dueDate, invoice.issueDate, asOf);
    const overdue = daysOverdue(invoice.dueDate, invoice.issueDate, asOf);
    // In rupees, at the rate the invoice was raised at — what Accounts Receivable holds for it. A $292.76
    // balance was counted as ₹292.76 until 21 Oct 2026; its own figure is kept beside it for the row.
    const rupees = Math.round(settlement.balance * bookingRate(invoice) * 100) / 100;

    const row =
      byCompany.get(invoice.company.id) ??
      { id: invoice.company.id, companySeq: invoice.company.companySeq, name: invoice.company.name, buckets: emptyAging(), total: 0, oldest: 0, invoiceCount: 0, foreign: {} };
    row.buckets[bucket] += rupees;
    row.total += rupees;
    if (!isBaseCurrency(invoice.currency)) row.foreign[invoice.currency] = (row.foreign[invoice.currency] ?? 0) + settlement.balance;
    row.oldest = Math.max(row.oldest, overdue);
    row.invoiceCount += 1;
    byCompany.set(invoice.company.id, row);
  }

  // Each customer's last follow-up and the promise that matters most (src/lib/collections/load.ts) —
  // read for the customers already scoped above, so it can't widen anything.
  const followUps = await receivableFollowUps(open, asOf);
  const rows = [...byCompany.values()]
    .map((row) => {
      const f = followUps.get(row.id);
      return { ...row, lastFollowUp: f?.lastFollowUp ?? null, promise: f?.promise ?? null, broken: f?.broken ?? false, promisedThisWeek: f?.promisedThisWeek ?? false };
    })
    .filter((row) => (promiseFilter === "broken" ? row.broken : promiseFilter === "week" ? row.promisedThisWeek : true))
    .sort((a, b) => b.total - a.total);
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

/**
 * The Customer Balance Summary (owner, 21 Oct 2026; src/lib/receivables/balance-summary.ts): what each
 * customer owes as of a day — open invoices, unused credits, journals and the balance, in rupees and in
 * their own currency. Null for somebody who can't see payments.
 */
export async function customerBalanceSummary(params?: { asOf?: string; search?: string }) {
  const user = await requireModuleUser("receivables");
  if (!(await viewerHas("payments.view"))) return null;
  return toPlain(await balanceSummaryFor(user.id, "AR", params));
}

/**
 * The AR aging report (owner, 21 Oct 2026 — src/lib/receivables/aging.ts): what was open on each invoice at
 * the end of a day, in columns by how far past due (or how old) it was, in chosen intervals. Null for
 * somebody who may not see what customers owe.
 */
export async function receivablesAgingReport(params?: AgingParams) {
  const user = await requireModuleUser("receivables");
  if (!(await viewerHas("payments.view"))) return null;
  return toPlain(await agingReportFor(user.id, "AR", params));
}

/** The same report as a workbook, with every invoice behind it (src/lib/receivables/aging-export.ts). */
export async function exportReceivablesAging(params?: AgingParams): Promise<ActionResult<ExportPayload>> {
  const user = await requireModuleUser("receivables");
  if (!(await viewerHas("payments.view"))) return { ok: false, error: "You can't see what customers owe." };
  return exportAging(user, "AR", params);
}

/** Issued credit notes for a customer that still have an unapplied balance. */
export async function listAvailableCredits(companyId: string) {
  const user = await requireModuleUser("receivables");
  if (!(await viewerHas("payments.view"))) return [];
  if (!(await maySeeCustomer(user.id, companyId))) return [];
  const creditNotes = await db.tradeDocument.findMany({
    where: { AND: [{ companyId, docType: "CREDIT_NOTE", status: { notIn: ["DRAFT", "CANCELLED"] } }, await documentAccess(user.id, "view")] },
    orderBy: { issueDate: "asc" },
    select: { id: true, docNumber: true, total: true, paidBefore: true, currency: true, creditsApplied: { select: { amount: true } } },
  });
  return creditNotes
    .map((c) => {
      return {
        id: c.id,
        docNumber: c.docNumber,
        currency: c.currency,
        total: Number(c.total),
        remaining: creditLeft(c),
      };
    })
    .filter((c) => c.remaining > 0.01);
}
