"use server";

import type { PartnerRole } from "@deskzo/control-client";
import { partnerRefusal, requirePartner, revalidatePortal, type PartnerMode } from "@/lib/partners/guard";
import type { DealRow } from "@/lib/partners/portal-data";
import { registerDeal, withdrawDeal } from "@/lib/partners/referrals";
import type { PartnerSessionState } from "@/lib/partners/session";
import { PARTNER_SELLERS, PartnerRefused, type PartnerResult } from "@/lib/partners/types";

/**
 * Deal registrations — a partner's claim on a prospect company by its email domain (spec §4.3).
 * src/lib/partners/referrals.ts checks the domain, the territories and the limits (20 a day, 200
 * open, counted in the database), refuses a company already held or a customer with one message that
 * names nobody, and writes the activity log.
 *
 *   partnerRegisterDeal  ADMIN, SALES while the partner is ACTIVE ("sell"); the new row as the list shows it
 *   partnerWithdrawDeal  ADMIN, SALES ("write"): one of its own PENDING or APPROVED registrations
 *
 * Another partner's registration is refused exactly as one that does not exist.
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
const optionalText = (value: unknown, max: number): string | null => (value === null || value === undefined ? null : text(value, max));

export async function partnerRegisterDeal(input: {
  companyName: string;
  domain: string;
  country: string;
  contactName?: string | null;
  contactEmail?: string | null;
  expectedPlanKey?: string | null;
  note?: string | null;
}): Promise<PartnerResult<DealRow>> {
  return asPartner(PARTNER_SELLERS, "sell", async ({ user }) => {
    const deal = await registerDeal(user, {
      companyName: text(input?.companyName, 400),
      domain: text(input?.domain, 300),
      country: text(input?.country, 100),
      contactName: optionalText(input?.contactName, 400),
      contactEmail: optionalText(input?.contactEmail, 320),
      expectedPlanKey: optionalText(input?.expectedPlanKey, 64),
      note: optionalText(input?.note, 4000),
    });
    revalidatePortal();
    return deal;
  });
}

export async function partnerWithdrawDeal(dealId: string): Promise<PartnerResult<null>> {
  return asPartner(PARTNER_SELLERS, "write", async ({ user }) => {
    await withdrawDeal(user, String(dealId ?? "").slice(0, 40));
    revalidatePortal();
    return null;
  });
}
