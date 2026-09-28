"use server";

import type { PartnerRole } from "@wroffy/control-client";
import { partnerRefusal, requirePartner, revalidatePortal, type PartnerMode } from "@/lib/partners/guard";
import { requestReseller, type ResellerProposal } from "@/lib/partners/requests";
import type { PartnerSessionState } from "@/lib/partners/session";
import { PARTNER_ADMINS, PartnerRefused, type PartnerResult } from "@/lib/partners/types";

/**
 * A distributor's resellers, from the Resellers page.
 *
 *   partnerRequestReseller  ADMIN of a distributor: proposes a reseller inside its own territories, for
 *                           staff to review — at most ten waiting at once. Approved, staff make it under
 *                           this distributor and invite its contact as the reseller's first admin.
 *
 * Withdrawing a proposal is `partnerWithdrawRequest` (profile.ts). src/lib/partners/requests.ts checks
 * everything again and writes the activity log. A reseller has no resellers, and is refused.
 */

async function asPartner<T>(roles: readonly PartnerRole[], mode: PartnerMode, work: (session: PartnerSessionState) => Promise<T>): Promise<PartnerResult<T>> {
  let session: PartnerSessionState;
  try {
    session = await requirePartner(roles, mode);
  } catch (err) {
    const refused = partnerRefusal(err);
    if (refused) return refused;
    throw err;
  }
  try {
    return { ok: true, data: await work(session) };
  } catch (err) {
    const refused = partnerRefusal(err);
    if (refused) return refused;
    throw err;
  }
}

/** Text as sent; refused when far longer than any field allows — never cut short, so nothing is kept that was not typed. */
const text = (value: unknown, max: number): string => {
  const typed = String(value ?? "");
  if (typed.length > max) throw new PartnerRefused("That is too long.");
  return typed;
};

export async function partnerRequestReseller(input: ResellerProposal): Promise<PartnerResult<{ id: string }>> {
  return asPartner(PARTNER_ADMINS, "write", async ({ user }) => {
    if (user.partner.kind !== "DISTRIBUTOR") throw new PartnerRefused("Only a distributor can propose resellers.");
    const x = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    // Country codes, each once; far more than there are countries is not a list anybody typed.
    const territories = [...new Set((Array.isArray(x.territories) ? x.territories : []).map((c) => text(c, 100)))];
    if (territories.length > 300) throw new PartnerRefused("That is too long.");
    const made = await requestReseller(user, {
      legalName: text(x.legalName, 400),
      displayName: text(x.displayName, 400),
      country: text(x.country, 100),
      territories,
      contactName: text(x.contactName, 400),
      contactEmail: text(x.contactEmail, 320),
      note: x.note === null || x.note === undefined ? null : text(x.note, 4000),
    });
    revalidatePortal();
    return made;
  });
}
