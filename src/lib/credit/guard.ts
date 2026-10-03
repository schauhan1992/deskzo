import type { CompanyRelationshipType, CreditDecisionKind } from "@prisma/client";
import { db } from "@/lib/db";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { paymentTermsLabels } from "@/lib/gst";
import { isCustomerRelationshipType } from "@/lib/validation/company";
import { assessCredit, MIN_OVERRIDE_REASON, RATING_LABELS, termsExceed, type CreditAssessment, type TermsKey } from "@/lib/credit/engine";
import { assessCompany } from "@/lib/credit/load";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * The rule every place that gives credit shares: terms longer than the rating supports need
 * `credit.override` and a reason, and the reason is kept.
 *
 * Used by the company forms (a customer's default terms), order punching (an order's own terms) and
 * order approval (terms, and the credit limit). Each asks `checkTerms`, refuses or carries on,
 * and — once its own write has succeeded — calls `recordDecision`, so a refused save leaves no trace
 * of a decision that did not happen.
 */

export const MIN_REASON = MIN_OVERRIDE_REASON;

export type OverrideCheck =
  | { ok: true; decision: null }
  | { ok: true; decision: { assessment: CreditAssessment; detail: string; reason: string } }
  | { ok: false; error: string };

/**
 * Whether giving `terms` to this customer needs an override, and if so whether this person has one
 * and has said why.
 *
 * `companyId` null is a customer being created: nobody has any history on day one, so they are
 * assessed as new — which suggests Advance, the default the create form already offers.
 */
export async function checkTerms(opts: {
  userId: string;
  companyId: string | null;
  relationshipType: CompanyRelationshipType;
  terms: TermsKey;
  /** What they are on now; unchanged terms are not a new decision, however long they are. */
  previousTerms?: TermsKey | null;
  reason?: string | null;
  /** What is being given, for the record — "Default terms", "Terms on ORD-000042". */
  subject: string;
}): Promise<OverrideCheck> {
  // A vendor's terms are what we owe them — nothing to do with credit we give.
  if (!isCustomerRelationshipType(opts.relationshipType)) return { ok: true, decision: null };
  if (opts.previousTerms && opts.previousTerms === opts.terms) return { ok: true, decision: null };

  const assessment = opts.companyId ? await assessCompany(opts.companyId) : assessCredit([], { asOf: new Date(), clock: await workspaceClock() });
  if (!assessment || !termsExceed(opts.terms, assessment.recommendedTerms)) return { ok: true, decision: null };

  const given = paymentTermsLabels[opts.terms];
  const suggested = paymentTermsLabels[assessment.recommendedTerms];
  const rated = RATING_LABELS[assessment.rating].toLowerCase();
  if (!(await hasEffectivePermission(opts.userId, "credit.override"))) {
    return {
      ok: false,
      error: `${given} is longer than the ${suggested} this customer's credit record supports (${rated}). Choose ${suggested} or shorter, or ask someone who can override credit terms.`,
    };
  }
  const reason = opts.reason?.trim() ?? "";
  if (reason.length < MIN_REASON) {
    return {
      ok: false,
      error: `${given} is longer than the suggested ${suggested} (${rated}) — say why you're giving it; the reason is kept on the customer's credit record.`,
    };
  }
  return { ok: true, decision: { assessment, detail: `${opts.subject}: ${given} (suggested ${suggested})`, reason } };
}

/** Writes the decision a check allowed, once the thing it allowed has actually been saved. */
export async function recordDecision(opts: {
  userId: string;
  companyId: string;
  orderId?: string | null;
  kind: CreditDecisionKind;
  assessment: CreditAssessment;
  detail: string;
  reason: string;
}) {
  await db.creditDecision.create({
    data: {
      companyId: opts.companyId,
      orderId: opts.orderId ?? null,
      kind: opts.kind,
      detail: opts.detail,
      reason: opts.reason.trim(),
      rating: opts.assessment.rating,
      score: opts.assessment.score,
      decidedById: opts.userId,
    },
  });
  await recordAudit({
    userId: opts.userId,
    action: "UPDATE",
    entityType: "Company",
    entityId: opts.companyId,
    entityLabel: `Credit override — ${opts.detail}. Reason: ${opts.reason.trim()}`,
  });
}
