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
import { ensureHeadOffice } from "@/lib/branches/identity";
import { syncBillingMilestones } from "@/lib/projects/billing-sync";
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
      error: `Only ₹${settlement.balance.toFixed(2)} is outstanding on this invoice. Record the excess as a separate payment so it stays unapplied.`,
    };
  }

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
        // the payment is too, at the invoice's rate: the ledger then clears exactly the rupees the
        // invoice booked. Without them a $1,000 receipt posted as ₹1,000 against a receivable the
        // invoice booked at ₹83,000. (No rate of its own is asked for yet, so no exchange difference
        // is booked here; a payment that carries one gets it from postExchangeDifferenceToLedger.)
        currency: invoice.currency,
        exchangeRate: invoice.exchangeRate,
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
    entityLabel: `₹${amount.toFixed(2)} against ${invoice.docNumber}`,
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
 */
export async function applyPaymentToInvoice(
  paymentId: string,
  invoiceId: string,
  amount: number,
): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("receivables");
  if (!(await hasEffectivePermission(user.id, "payments.record"))) {
    return { ok: false, error: "You don't have permission to allocate payments." };
  }
  if (!(amount > 0)) return { ok: false, error: "Enter an amount greater than zero." };

  const [payment, invoice] = await Promise.all([
    db.payment.findUnique({ where: { id: paymentId }, include: { allocations: { select: { amount: true } } } }),
    db.tradeDocument.findUnique({
      where: { id: invoiceId },
      select: { id: true, companyId: true, docType: true, status: true, total: true, ...invoiceSettlementInclude },
    }),
  ]);
  if (!payment) return { ok: false, error: "That payment no longer exists." };
  if (!invoice) return { ok: false, error: "That invoice no longer exists." };
  if (invoice.companyId !== payment.companyId) {
    return { ok: false, error: "That invoice belongs to a different customer." };
  }
  if (invoice.docType !== "INVOICE" || invoice.status === "DRAFT" || invoice.status === "CANCELLED") {
    return { ok: false, error: "That isn't an open invoice." };
  }

  const unapplied =
    Number(payment.amount) - payment.allocations.reduce((t, a) => t + Number(a.amount), 0);
  if (amount > unapplied + 0.001) {
    return { ok: false, error: `Only ₹${unapplied.toFixed(2)} of this payment is unapplied.` };
  }
  const settlement = settlementOf(invoice);
  if (amount > settlement.balance + 0.001) {
    return { ok: false, error: `Only ₹${settlement.balance.toFixed(2)} is outstanding on that invoice.` };
  }

  const allocation = await db.$transaction(async (tx) => {
    const row = await tx.paymentAllocation.create({
      data: { paymentId, documentId: invoiceId, amount: new Prisma.Decimal(amount), allocatedByUserId: user.id },
    });
    // The difference only exists once you know which invoice the money is against — the same
    // $1,000 settling an invoice raised at ₹83 and one raised at ₹86 are different gains.
    await postExchangeDifferenceToLedger(tx, {
      paymentId,
      documentId: invoiceId,
      allocatedAmount: amount,
      userId: user.id,
    });
    return row;
  });
  await syncInvoiceStatus(invoiceId);

  revalidatePath(`/documents/${invoiceId}`);
  revalidatePath(`/companies/${invoice.companyId}`);
  revalidatePath("/receivables");
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
      select: { id: true, companyId: true, docType: true, status: true, total: true, docNumber: true, creditsApplied: { select: { amount: true } } },
    }),
    db.tradeDocument.findUnique({
      where: { id: invoiceId },
      select: { id: true, companyId: true, docType: true, status: true, docNumber: true, total: true, ...invoiceSettlementInclude },
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

  const creditRemaining =
    Number(creditNote.total) - creditNote.creditsApplied.reduce((t, a) => t + Number(a.amount), 0);
  if (amount > creditRemaining + 0.001) {
    return { ok: false, error: `Only ₹${creditRemaining.toFixed(2)} of this credit note is unapplied.` };
  }
  const settlement = settlementOf(invoice);
  if (amount > settlement.balance + 0.001) {
    return { ok: false, error: `Only ₹${settlement.balance.toFixed(2)} is outstanding on that invoice.` };
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
      payments: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          amount: true,
          createdAt: true,
          payment: { select: { id: true, paidOn: true, method: true, reference: true } },
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
      creditsApplied: {
        orderBy: { createdAt: "desc" },
        select: { id: true, amount: true, invoice: { select: { id: true, docNumber: true, issueDate: true } } },
      },
    },
  });
  if (!creditNote) return null;
  const applied = creditNote.creditsApplied.reduce((t, a) => t + Number(a.amount), 0);
  return toPlain({
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
    select: { id: true, docNumber: true, issueDate: true, dueDate: true, total: true, ...invoiceSettlementInclude },
  });
  return invoices
    .map((invoice) => ({
      id: invoice.id,
      docNumber: invoice.docNumber,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
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
      select: { id: true, docNumber: true, issueDate: true, dueDate: true, total: true, ...invoiceSettlementInclude },
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
    balance: number;
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
  const [appliedPayments, appliedCredits] = await Promise.all([
    db.paymentAllocation.aggregate({ where: { payment: { companyId, ...receiptScope } }, _sum: { amount: true } }),
    db.creditNoteApplication.aggregate({ where: { creditNote: { companyId, ...documentScope } }, _sum: { amount: true } }),
  ]);
  const unappliedPayments = Math.max(received - Number(appliedPayments._sum.amount ?? 0), 0);
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
    select: { id: true, docNumber: true, total: true, creditsApplied: { select: { amount: true } } },
  });
  return creditNotes
    .map((c) => {
      const applied = c.creditsApplied.reduce((t, a) => t + Number(a.amount), 0);
      return {
        id: c.id,
        docNumber: c.docNumber,
        total: Number(c.total),
        remaining: Math.max(Number(c.total) - applied, 0),
      };
    })
    .filter((c) => c.remaining > 0.01);
}
