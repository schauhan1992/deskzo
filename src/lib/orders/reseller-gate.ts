import type { CompanyRelationshipType } from "@prisma/client";
import { db } from "@/lib/db";
import { canResellerTrade, resellerStatusLabels } from "@/lib/reseller-onboarding";

/**
 * Why no order may be raised for this company yet, or null.
 *
 * A reseller trades only once its onboarding is signed off — that gate is the whole point of it. Every
 * new order row is a sale to them, so all three ways one is raised ask here: punched (`createOrder`),
 * seats added to a running subscription (`createAddon`), and a renewal (`createRenewalOrder`).
 *
 * The payment-terms override (src/lib/credit/guard.ts `checkTerms`) is deliberately not part of it. It
 * judges terms somebody chose on a new order; seats and renewals choose none — they carry the
 * subscription's own — and approval weighs every order's terms against the credit rating as it stands
 * then (`approveOrder`), whichever way the order was raised.
 */
export async function resellerOrderRefusal(company: {
  id: string;
  name: string;
  relationshipType: CompanyRelationshipType;
}): Promise<string | null> {
  if (company.relationshipType !== "RESELLER") return null;
  const profile = await db.resellerProfile.findUnique({ where: { companyId: company.id }, select: { status: true } });
  if (profile && canResellerTrade(profile.status)) return null;
  const status = profile ? resellerStatusLabels[profile.status] : "not onboarded";
  return `${company.name} can't be ordered for yet — their reseller onboarding is ${status.toLowerCase()}. Finish it on their company page first.`;
}
