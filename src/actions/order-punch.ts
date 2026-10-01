"use server";

import type { CompanyRelationshipType, PaymentTerms } from "@prisma/client";
import { db } from "@/lib/db";
import { isModuleEntitled, requireModuleUser } from "@/lib/modules-access";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { viewerHas } from "@/actions/permission";
import type { getCreditSnapshot } from "@/actions/credit";
import { toPlain } from "@/lib/serialize";
import { isCustomerRelationshipType } from "@/lib/validation/company";
import { termsExceed } from "@/lib/credit/engine";
import { assessCompany } from "@/lib/credit/load";
import { describePriceSource, resolveResellerPrice } from "@/lib/reseller-pricing";

/**
 * What the order-punching form looks up while it is filled in: one call when the customer is chosen,
 * one when the product is.
 *
 * Each used to be several actions — locations, proposals, commission parties, end customers and
 * credit for the customer; the earlier order and the reseller's price for the product. Next runs a
 * client's server actions one at a time, and every one of them works out the session, the
 * permissions and the account scope again, so choosing a customer was five round trips in a row.
 * These ask the same questions behind one scope check each, with the queries side by side.
 *
 * Each answer keeps the rule of the action it replaces — the account scope, the plan, the payments
 * view for credit — so nothing comes back here that one of those would have refused.
 */

/** The credit snapshot exactly as `getCreditSnapshot` gives it, so the form reads one shape either way. */
type CreditSnapshot = NonNullable<Awaited<ReturnType<typeof getCreditSnapshot>>>;

/** An id as a client sent it. A server action can be called with anything, and anything but a non-empty string is no id. */
function idOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The customer's credit for whoever `getCreditSnapshot` shows it to: Receivables in the plan, a
 * customer rather than a vendor, and the payments view — reading a customer's credit is reading their
 * money. The caller has already settled the account scope.
 *
 * Read-only, where that action is not: it also writes the rating back onto the company. The stored
 * copy only lets the credit list sort and filter, and the scheduled tick keeps it fresh, so choosing a
 * customer on the punch form does not need to be a database write.
 */
async function creditFor(company: {
  id: string;
  relationshipType: CompanyRelationshipType;
  paymentTerms: PaymentTerms;
}): Promise<CreditSnapshot | null> {
  if (!(await isModuleEntitled("receivables"))) return null;
  if (!isCustomerRelationshipType(company.relationshipType)) return null;
  if (!(await viewerHas("payments.view"))) return null;
  const [assessment, canOverride] = await Promise.all([assessCompany(company.id), viewerHas("credit.override")]);
  if (!assessment) return null;
  return toPlain({
    rating: assessment.rating,
    score: assessment.score,
    reasons: assessment.reasons,
    recommendedTerms: assessment.recommendedTerms,
    suggestedLimit: assessment.suggestedLimit,
    manualLimit: assessment.manualLimit,
    limit: assessment.limit,
    limitSource: assessment.limitSource,
    outstanding: assessment.outstanding,
    overdue: assessment.overdue,
    oldestOverdueDays: assessment.oldestOverdueDays,
    metrics: assessment.metrics,
    defaultTerms: company.paymentTerms,
    /** The customer's standing terms are longer than their record now supports. */
    termsBeyond: termsExceed(company.paymentTerms, assessment.recommendedTerms),
    canOverride,
  });
}

/**
 * Everything the form needs once a customer is chosen, or null when there is no such customer — or
 * none this person may see, which answers the same way, so a guessed id learns nothing.
 *
 * Its offices with the primary first (the form selects that one), the proposals on its leads, the
 * commission parties tied to it, its end customers when it is a reseller, and its credit.
 */
export async function punchCustomerContext(companyId: string) {
  const user = await requireModuleUser("orders");
  const id = idOf(companyId);
  if (!id) return null;
  const company = await db.company.findUnique({
    where: { id },
    select: { id: true, ownerUserId: true, relationshipType: true, paymentTerms: true },
  });
  if (!company || !(await canSeeCompany(user.id, company.ownerUserId))) return null;

  const [locations, proposals, links, endCustomers, credit] = await Promise.all([
    db.companyLocation.findMany({
      where: { companyId: company.id },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      select: { id: true, label: true, isPrimary: true },
    }),
    // The rows `listProposalOptions` gives. It adds the account scope inside the lead clause; every
    // lead here is on this one company, already in scope, so that would narrow nothing.
    db.proposal.findMany({
      where: { lead: { companyId: company.id } },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, validUntil: true, lead: { select: { title: true } } },
    }),
    // Only the ids: the form already has every commission party, and flags and sorts these first.
    db.commissionPartyLink.findMany({ where: { companyId: company.id }, select: { commissionPartyId: true } }),
    // An end customer is only ever reached through the reseller who manages it.
    company.relationshipType === "RESELLER"
      ? db.company.findMany({ where: { managedByResellerId: company.id }, orderBy: { name: "asc" }, select: { id: true, name: true } })
      : Promise.resolve([]),
    creditFor(company),
  ]);

  return { locations, proposals, linkedPartyIds: links.map((l) => l.commissionPartyId), endCustomers, credit };
}

export type PunchCustomerContext = NonNullable<Awaited<ReturnType<typeof punchCustomerContext>>>;

export type PunchItemContext = {
  /** The customer already has this product on an order that was not cancelled or rejected — most likely a renewal. */
  hasExistingOrder: boolean;
  /** A reseller's own price for it, and where that number came from; null for anyone else. */
  resellerPrice: { unitPrice: number; note: string } | null;
};

/**
 * What a reseller pays for an item — the logic of `getResellerPriceForItem`, resolved the way the
 * form always resolved it: a special price for this item, else the tier discount, else the catalogue.
 * Only with Resellers in the plan, as that action is.
 */
async function resellerPriceFor(resellerId: string, itemId: string): Promise<PunchItemContext["resellerPrice"]> {
  if (!(await isModuleEntitled("resellers"))) return null;
  const [profile, special, item] = await Promise.all([
    db.resellerProfile.findUnique({ where: { companyId: resellerId }, select: { discountPercent: true } }),
    db.resellerItemPrice.findUnique({ where: { resellerId_itemId: { resellerId, itemId } }, select: { price: true } }),
    db.item.findUnique({ where: { id: itemId }, select: { sellingPrice: true } }),
  ]);
  if (!item) return null;
  const resolved = resolveResellerPrice({
    catalogPrice: Number(item.sellingPrice),
    specialPrice: special ? Number(special.price) : null,
    discountPercent: profile?.discountPercent ? Number(profile.discountPercent) : null,
  });
  return { unitPrice: resolved.unitPrice, note: describePriceSource(resolved) };
}

/**
 * Everything the form needs once the product is chosen for a customer: whether it looks like a
 * renewal, and a reseller's price.
 *
 * Scoped like `punchCustomerContext`. A customer that does not exist, or that this person may not
 * see, gets the answer a brand-new sale to an ordinary customer gets — no earlier order, no reseller
 * price — so the question cannot be used to ask whether some other account buys a product.
 */
export async function punchItemContext(input: { companyId: string; itemId: string }): Promise<PunchItemContext> {
  const user = await requireModuleUser("orders");
  const nothing: PunchItemContext = { hasExistingOrder: false, resellerPrice: null };
  const companyId = idOf(input?.companyId);
  const itemId = idOf(input?.itemId);
  if (!companyId || !itemId) return nothing;
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { id: true, ownerUserId: true, relationshipType: true },
  });
  if (!company || !(await canSeeCompany(user.id, company.ownerUserId))) return nothing;

  const [existing, resellerPrice] = await Promise.all([
    // The question `hasExistingOrderForItem` asks. Its account scope is the check just made.
    db.companyProduct.findFirst({
      where: { companyId: company.id, itemId, orderStatus: { notIn: ["REJECTED", "CANCELLED"] } },
      select: { id: true },
    }),
    company.relationshipType === "RESELLER" ? resellerPriceFor(company.id, itemId) : Promise.resolve(null),
  ]);
  return { hasExistingOrder: !!existing, resellerPrice };
}
