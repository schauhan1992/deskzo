"use server";

import type { PartnerRole } from "@wroffy/control-client";
import { partnerRefusal, requirePartner, revalidatePortal, type PartnerMode } from "@/lib/partners/guard";
import type { LinkRow } from "@/lib/partners/portal-data";
import { createPartnerInvite, createReferralLink, endPartnerInvite, endReferralLink } from "@/lib/partners/referrals";
import type { PartnerSessionState } from "@/lib/partners/session";
import { PARTNER_SELLERS, PartnerRefused, type PartnerResult } from "@/lib/partners/types";

/**
 * Invitation codes and referral links — the partner's own, from the Invitations page. ADMIN and SALES
 * while the partner is ACTIVE ("sell"); src/lib/partners/referrals.ts does the work, counts the limits
 * in the database (50 codes a day, 50 live links) and writes the activity log.
 *
 *   partnerCreateInvite  a new code: returned here once, and never again — only its last four after
 *   partnerEndInvite     ends a live code now, by its hash (the list's handle for it)
 *   partnerCreateLink    a new referral link, as the list shows it
 *   partnerEndLink       ends a link now
 *
 * An id or hash of another partner's code or link is refused exactly as one that does not exist.
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

/** Text as sent, or null; refused when far longer than any field allows — never cut short, so nothing is kept that was not typed. */
const optionalText = (value: unknown, max: number): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text.length > max) throw new PartnerRefused("That is too long.");
  return text;
};
const wholeOrUndefined = (value: unknown) => (value === null || value === undefined || String(value).trim() === "" ? undefined : Number(value));

export async function partnerCreateInvite(input: { note?: string | null; uses?: number; days?: number; planKey?: string | null }): Promise<PartnerResult<{ code: string; codeHint: string }>> {
  return asPartner(PARTNER_SELLERS, "sell", async ({ user }) => {
    const made = await createPartnerInvite(user, {
      note: optionalText(input?.note, 1000),
      uses: wholeOrUndefined(input?.uses),
      days: wholeOrUndefined(input?.days),
      planKey: optionalText(input?.planKey, 64),
    });
    revalidatePortal();
    // The code, once, to the person who made it; the hash stays the list's handle.
    return { code: made.code, codeHint: made.codeHint };
  });
}

// Ending a code or a link is "write", not "sell": it only ever takes something away, and a partner
// that is onboarding or suspended may still need to kill a code that leaked (the owner's call).
export async function partnerEndInvite(codeHash: string): Promise<PartnerResult<null>> {
  return asPartner(PARTNER_SELLERS, "write", async ({ user }) => {
    await endPartnerInvite(user, String(codeHash ?? "").slice(0, 64));
    revalidatePortal();
    return null;
  });
}

export async function partnerCreateLink(input: { label?: string | null; planKey?: string | null; days?: number | null }): Promise<PartnerResult<LinkRow>> {
  return asPartner(PARTNER_SELLERS, "sell", async ({ user }) => {
    const made = await createReferralLink(user, { label: optionalText(input?.label, 1000), planKey: optionalText(input?.planKey, 64), days: wholeOrUndefined(input?.days) ?? null });
    revalidatePortal();
    return {
      id: made.id,
      code: made.code,
      url: made.url,
      label: made.label,
      planName: made.planName,
      signups: 0,
      customers: 0,
      expiresAt: made.expiresAt,
      endedAt: null,
      state: "live",
      createdAt: made.createdAt,
    };
  });
}

export async function partnerEndLink(linkId: string): Promise<PartnerResult<null>> {
  return asPartner(PARTNER_SELLERS, "write", async ({ user }) => {
    await endReferralLink(user, String(linkId ?? "").slice(0, 40));
    revalidatePortal();
    return null;
  });
}
