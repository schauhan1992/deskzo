import type { PaymentTerms } from "@prisma/client";
import { db } from "@/lib/db";
import { calculateOrderAmount } from "@/lib/gst";
import { formatOrderId } from "@/lib/order-id";
import { assessCredit, TERMS_DAYS, type Bill, type CreditAssessment } from "@/lib/credit/engine";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * The database side of the credit engine: a customer's history as `Bill`s, then assessed.
 *
 * Batched — every query takes a list of companies — because the credit list and the tick assess a
 * page or a few hundred at once, and one query per customer per table would be thousands.
 *
 * Not a "use server" module: it answers for any company it is handed, so it must only be reached
 * through actions that have already checked who is asking (src/actions/credit.ts).
 */

const DAY = 86_400_000;
/** The invoice states that mean "we billed them and they owe it" — not a draft, not withdrawn. */
const BILLED_INVOICE = ["ISSUED", "PARTIALLY_PAID", "PAID"] as const;

export type CreditSubject = {
  companyId: string;
  bills: Bill[];
  manualLimit: number | null;
  defaultTerms: PaymentTerms;
  isReseller: boolean;
};

export async function loadCreditSubjects(companyIds: string[]): Promise<Map<string, CreditSubject>> {
  const ids = [...new Set(companyIds)];
  const subjects = new Map<string, CreditSubject>();
  if (ids.length === 0) return subjects;

  const [companies, invoices, orders] = await Promise.all([
    db.company.findMany({
      where: { id: { in: ids } },
      select: { id: true, paymentTerms: true, creditLimit: true, relationshipType: true, resellerProfile: { select: { creditLimit: true } } },
    }),
    db.tradeDocument.findMany({
      where: { companyId: { in: ids }, docType: "INVOICE", direction: "SALES", status: { in: [...BILLED_INVOICE] } },
      select: {
        id: true,
        companyId: true,
        docNumber: true,
        issueDate: true,
        dueDate: true,
        total: true,
        exchangeRate: true,
        payments: { select: { amount: true, payment: { select: { paidOn: true } } } },
        creditsReceived: { select: { amount: true, createdAt: true } },
      },
    }),
    db.companyProduct.findMany({
      where: {
        companyId: { in: ids },
        orderStatus: { in: ["APPROVED", "PROCESSING", "FULFILLED"] },
        /**
         * Not an order that has been invoiced. Then the invoice is the bill, and its payments are
         * allocated to the invoice — counting the order as well would show the same sale twice, the
         * second time as never paid.
         */
        documentLines: { none: { document: { docType: "INVOICE", status: { in: [...BILLED_INVOICE] } } } },
      },
      select: {
        id: true,
        companyId: true,
        orderSeq: true,
        quantity: true,
        unitPrice: true,
        paymentTerms: true,
        accountsApprovedAt: true,
        createdAt: true,
        item: { select: { sellingPrice: true, taxRatePercent: true } },
        allocations: { select: { amount: true, payment: { select: { paidOn: true } } } },
      },
    }),
  ]);

  for (const c of companies) {
    // A reseller's limit is kept on its reseller profile, where onboarding sets it — one number, one place.
    const manual = c.relationshipType === "RESELLER" ? c.resellerProfile?.creditLimit : c.creditLimit;
    subjects.set(c.id, {
      companyId: c.id,
      bills: [],
      manualLimit: manual === null || manual === undefined ? null : Number(manual),
      defaultTerms: c.paymentTerms,
      isReseller: c.relationshipType === "RESELLER",
    });
  }

  for (const inv of invoices) {
    const subject = subjects.get(inv.companyId);
    if (!subject) continue;
    // A foreign-currency invoice is weighed in rupees, at the rate it was raised at.
    const rate = Number(inv.exchangeRate) || 1;
    const amount = Number(inv.total) * rate;
    if (amount <= 0) continue;
    subject.bills.push({
      id: inv.id,
      kind: "INVOICE",
      ref: inv.docNumber,
      issuedOn: inv.issueDate,
      // No due date means due on the day it was raised — the same rule the ageing report uses.
      dueOn: inv.dueDate ?? inv.issueDate,
      amount,
      settlements: [
        ...inv.payments.map((p) => ({ on: p.payment.paidOn, amount: Number(p.amount) * rate })),
        ...inv.creditsReceived.map((c) => ({ on: c.createdAt, amount: Number(c.amount) * rate })),
      ],
    });
  }

  for (const o of orders) {
    const subject = subjects.get(o.companyId);
    if (!subject) continue;
    const { total } = calculateOrderAmount({
      quantity: o.quantity,
      unitPrice: Number(o.unitPrice ?? o.item.sellingPrice),
      taxRatePercent: o.item.taxRatePercent ? Number(o.item.taxRatePercent) : null,
    });
    if (total <= 0) continue;
    // Billed when accounts approved it; due its own terms after that, or the customer's default.
    const issuedOn = o.accountsApprovedAt ?? o.createdAt;
    const terms = o.paymentTerms ?? subject.defaultTerms;
    subject.bills.push({
      id: o.id,
      kind: "ORDER",
      ref: formatOrderId(o.orderSeq),
      issuedOn,
      dueOn: new Date(issuedOn.getTime() + TERMS_DAYS[terms] * DAY),
      amount: total,
      settlements: o.allocations.map((a) => ({ on: a.payment.paidOn, amount: Number(a.amount) })),
    });
  }

  return subjects;
}

export async function assessCompanies(companyIds: string[], asOf = new Date()): Promise<Map<string, CreditAssessment>> {
  const [subjects, clock] = await Promise.all([loadCreditSubjects(companyIds), workspaceClock()]);
  const out = new Map<string, CreditAssessment>();
  // Days late are the workspace's days.
  for (const [id, s] of subjects) out.set(id, assessCredit(s.bills, { asOf, manualLimit: s.manualLimit, clock }));
  return out;
}

export async function assessCompany(companyId: string, asOf = new Date()): Promise<CreditAssessment | null> {
  return (await assessCompanies([companyId], asOf)).get(companyId) ?? null;
}

/**
 * Writes the ratings just computed back to the companies they belong to, where they changed.
 *
 * The stored copy exists only so the credit list can filter and sort; every decision recomputes.
 * Writing it whenever it is computed anyway keeps it as fresh as the last time anybody looked.
 */
export async function cacheAssessments(assessments: Map<string, CreditAssessment>, at = new Date()) {
  const ids = [...assessments.keys()];
  if (ids.length === 0) return;
  const current = await db.company.findMany({
    where: { id: { in: ids } },
    select: { id: true, creditRating: true, creditScore: true },
  });
  const changed = current.filter((c) => {
    const a = assessments.get(c.id)!;
    return c.creditRating !== a.rating || c.creditScore !== a.score;
  });
  await Promise.all(
    changed.map((c) => {
      const a = assessments.get(c.id)!;
      return db.company.update({ where: { id: c.id }, data: { creditRating: a.rating, creditScore: a.score, creditScoredAt: at } });
    }),
  );
  // The unchanged ones are still fresh — stamp them so the tick leaves them alone.
  const unchanged = ids.filter((id) => !changed.some((c) => c.id === id));
  if (unchanged.length) await db.company.updateMany({ where: { id: { in: unchanged } }, data: { creditScoredAt: at } });
}

/**
 * Re-rates the customers whose stored rating is oldest, for the scheduled tick.
 *
 * A rating changes with nothing happening — an invoice simply passing its due date — so waiting for
 * an event would leave a customer rated Reliable for a month after they stopped paying. Customers
 * with no bills at all are rated New once and then left alone; there is nothing to go stale.
 */
export async function refreshStaleCreditRatings(opts: { limit: number; olderThanHours?: number }): Promise<number> {
  const cutoff = new Date(Date.now() - (opts.olderThanHours ?? 12) * 3_600_000);
  const due = await db.company.findMany({
    where: {
      relationshipType: { in: ["CLIENT", "RESELLER"] },
      OR: [{ creditScoredAt: null }, { creditScoredAt: { lt: cutoff } }],
    },
    orderBy: [{ creditScoredAt: { sort: "asc", nulls: "first" } }],
    take: opts.limit,
    select: { id: true },
  });
  if (due.length === 0) return 0;
  await cacheAssessments(await assessCompanies(due.map((d) => d.id)));
  return due.length;
}
