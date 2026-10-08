"use server";

import { revalidatePath } from "next/cache";
import type { CreditRating, Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { canSeeCompany, companyScope } from "@/lib/authz/company-scope";
import { viewerHas } from "@/actions/permission";
import { toPlain } from "@/lib/serialize";
import { pageSlice } from "@/lib/pagination";
import { isCustomerRelationshipType } from "@/lib/validation/company";
import { assessCredit, termsExceed, type CreditAssessment } from "@/lib/credit/engine";
import { assessCompanies, assessCompany, cacheAssessments } from "@/lib/credit/load";
import { MIN_REASON, recordDecision } from "@/lib/credit/guard";
import { workspaceClock } from "@/lib/time/workspace";
import type { ActionResult } from "@/actions/company";

/**
 * The credit engine's answers, for the screens that show them.
 *
 * Reading a customer's credit is reading their money — what they owe, how late they pay — so it is
 * `payments.view`, and the account scope, like every other figure about an account. Changing the
 * limit is `credit.override`, as is everything else that gives more credit than the engine suggests.
 */

/** The customer, when this person may see its credit — otherwise null, the same as "no such customer". */
async function readableCustomer(companyId: string) {
  const user = await requireModuleUser("receivables");
  if (!(await viewerHas("payments.view"))) return null;
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true, ownerUserId: true, relationshipType: true, paymentTerms: true },
  });
  if (!company || !isCustomerRelationshipType(company.relationshipType)) return null;
  if (!(await canSeeCompany(user.id, company))) return null;
  return { user, company };
}

function summary(a: CreditAssessment, defaultTerms: Parameters<typeof termsExceed>[0]) {
  return {
    rating: a.rating,
    score: a.score,
    reasons: a.reasons,
    recommendedTerms: a.recommendedTerms,
    suggestedLimit: a.suggestedLimit,
    manualLimit: a.manualLimit,
    limit: a.limit,
    limitSource: a.limitSource,
    outstanding: a.outstanding,
    overdue: a.overdue,
    oldestOverdueDays: a.oldestOverdueDays,
    metrics: a.metrics,
    defaultTerms,
    /** The customer's standing terms are longer than their record now supports. */
    termsBeyond: termsExceed(defaultTerms, a.recommendedTerms),
  };
}

/** Rating, terms and limit — enough for the order form to warn before anything is saved. */
export async function getCreditSnapshot(companyId: string) {
  const ctx = await readableCustomer(companyId);
  if (!ctx) return null;
  const assessment = await assessCompany(companyId);
  if (!assessment) return null;
  await cacheAssessments(new Map([[companyId, assessment]]));
  return toPlain({ ...summary(assessment, ctx.company.paymentTerms), canOverride: await viewerHas("credit.override") });
}

/**
 * What the terms field says for a customer who doesn't exist yet: no history, so Advance — the same
 * answer `checkTerms` will give when the form is saved.
 */
export async function newCustomerTermsAdvice() {
  await requireModuleUser("receivables");
  const a = assessCredit([], { asOf: new Date(), clock: await workspaceClock() });
  return { rating: a.rating, score: a.score, recommendedTerms: a.recommendedTerms, canOverride: await viewerHas("credit.override"), currentTerms: null };
}

/** The same for an existing customer's edit form — null for a vendor, or without the payments view. */
export async function customerTermsAdvice(companyId: string) {
  await requireModuleUser("receivables");
  const snapshot = await getCreditSnapshot(companyId);
  if (!snapshot) return null;
  return {
    rating: snapshot.rating,
    score: snapshot.score,
    recommendedTerms: snapshot.recommendedTerms,
    canOverride: snapshot.canOverride,
    currentTerms: snapshot.defaultTerms,
  };
}

/** Everything behind the rating, for the customer's Credit tab. */
export async function getCreditProfile(companyId: string) {
  const ctx = await readableCustomer(companyId);
  if (!ctx) return null;
  const assessment = await assessCompany(companyId);
  if (!assessment) return null;
  await cacheAssessments(new Map([[companyId, assessment]]));
  const [decisions, canOverride] = await Promise.all([
    db.creditDecision.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, kind: true, detail: true, reason: true, rating: true, score: true, createdAt: true, decidedBy: { select: { name: true } } },
    }),
    viewerHas("credit.override"),
  ]);
  return toPlain({
    ...summary(assessment, ctx.company.paymentTerms),
    isReseller: ctx.company.relationshipType === "RESELLER",
    bills: assessment.outcomes.slice(0, 25).map((o) => ({
      id: o.bill.id,
      kind: o.bill.kind,
      ref: o.bill.ref,
      issuedOn: o.bill.issuedOn,
      dueOn: o.bill.dueOn,
      amount: o.bill.amount,
      settled: o.settled,
      outstanding: o.outstanding,
      paidOn: o.paidOn,
      daysLate: o.daysLate,
      overdueDays: o.overdueDays,
    })),
    decisions,
    canOverride,
  });
}

const setLimitSchema = z.object({
  companyId: z.string().min(1),
  /** Null hands the customer back to the engine's suggestion. */
  limit: z.number().nonnegative("A limit can't be negative").max(1e12).nullable(),
  reason: z.string().trim().min(MIN_REASON, "Say why — the reason is kept on the customer's credit record").max(500),
});

/**
 * Sets the most a customer may owe at once, overriding the suggestion — or clears it back to it.
 *
 * A reseller's limit is written to its reseller profile, where onboarding already keeps it, so the
 * two screens that show it can never disagree.
 */
export async function setCreditLimit(input: unknown): Promise<ActionResult<null>> {
  const parsed = setLimitSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { companyId, limit, reason } = parsed.data;
  const ctx = await readableCustomer(companyId);
  if (!ctx) return { ok: false, error: "Customer not found." };
  if (!(await viewerHas("credit.override"))) return { ok: false, error: "You can't set credit limits." };

  const before = await assessCompany(companyId);
  if (!before) return { ok: false, error: "Customer not found." };
  const value = limit === null ? null : Math.round(limit * 100) / 100;
  if (ctx.company.relationshipType === "RESELLER") {
    const profile = await db.resellerProfile.findUnique({ where: { companyId }, select: { id: true } });
    if (!profile) return { ok: false, error: "This reseller has no reseller profile yet." };
    await db.resellerProfile.update({ where: { companyId }, data: { creditLimit: value } });
  } else {
    await db.company.update({ where: { id: companyId }, data: { creditLimit: value } });
  }

  const rupees = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
  const was = before.manualLimit !== null ? `${rupees(before.manualLimit)} set by hand` : `${rupees(before.suggestedLimit)} suggested`;
  await recordDecision({
    userId: ctx.user.id,
    companyId,
    kind: "LIMIT",
    assessment: before,
    detail: value === null ? `Credit limit cleared — back to the suggested ${rupees(before.suggestedLimit)} (was ${was})` : `Credit limit set to ${rupees(value)} (was ${was})`,
    reason,
  });
  revalidatePath(`/companies/${companyId}`);
  revalidatePath("/receivables/credit");
  return { ok: true, data: null };
}

const BILLED = ["ISSUED", "PARTIALLY_PAID", "PAID"] as const;

/**
 * Customers with a payment history, riskiest first — the Customer credit list.
 *
 * The filter and the order run on the rating stored on each company (the database cannot sort by a
 * score it would have to compute), so anything never rated is rated first, and the rows shown are
 * then re-assessed live and written back. A rating on this page is therefore never staler than the
 * page itself.
 */
export async function listCreditRisks(params: { rating?: CreditRating; q?: string; page: number; pageSize: number }) {
  const user = await requireModuleUser("receivables");
  if (!(await viewerHas("payments.view"))) return { rows: [], total: 0, counts: {} as Partial<Record<CreditRating, number>> };

  const base: Prisma.CompanyWhereInput = {
    AND: [
      await companyScope(user.id),
      { relationshipType: { in: ["CLIENT", "RESELLER"] }, managedByResellerId: null },
      {
        OR: [
          { products: { some: { orderStatus: { in: ["APPROVED", "PROCESSING", "FULFILLED"] } } } },
          { tradeDocuments: { some: { docType: "INVOICE", direction: "SALES", status: { in: [...BILLED] } } } },
        ],
      },
      ...(params.q ? [{ name: { contains: params.q, mode: "insensitive" as const } }] : []),
    ],
  };

  const unrated = await db.company.findMany({ where: { AND: [base, { creditScoredAt: null }] }, select: { id: true }, take: 300 });
  if (unrated.length) await cacheAssessments(await assessCompanies(unrated.map((c) => c.id)));

  const where: Prisma.CompanyWhereInput = params.rating ? { AND: [base, { creditRating: params.rating }] } : base;
  const [page, total, grouped] = await Promise.all([
    db.company.findMany({
      where,
      // Lowest score first — Risky, then Fair, then Reliable; New (no score) last.
      orderBy: [{ creditScore: { sort: "asc", nulls: "last" } }, { name: "asc" }],
      select: { id: true, companySeq: true, name: true, paymentTerms: true, relationshipType: true },
      ...pageSlice(params.page, params.pageSize),
    }),
    db.company.count({ where }),
    db.company.groupBy({ by: ["creditRating"], where: base, _count: true }),
  ]);

  const live = await assessCompanies(page.map((c) => c.id));
  await cacheAssessments(live);
  const counts: Partial<Record<CreditRating, number>> = {};
  for (const g of grouped) if (g.creditRating) counts[g.creditRating] = g._count;

  return toPlain({
    rows: page.map((c) => {
      const a = live.get(c.id)!;
      return { id: c.id, companySeq: c.companySeq, name: c.name, isReseller: c.relationshipType === "RESELLER", ...summary(a, c.paymentTerms), reasons: a.reasons.slice(0, 2) };
    }),
    total,
    counts,
  });
}
