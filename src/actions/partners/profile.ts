"use server";

import type { PartnerRole } from "@wroffy/control-client";
import { partnerRefusal, requirePartner, revalidatePortal, type PartnerMode } from "@/lib/partners/guard";
import { updatePartnerSelf, type PartnerSelfInput } from "@/lib/partners/registry";
import { requestPayoutChange, requestProfileChange, withdrawRequest, type ProfileChangeInput } from "@/lib/partners/requests";
import type { PartnerSessionState } from "@/lib/partners/session";
import { PARTNER_ADMINS, PARTNER_MONEY, PartnerRefused, type PartnerResult, type PayoutInput } from "@/lib/partners/types";

/**
 * The company profile — always the signed-in user's own partner.
 *
 *   partnerUpdateProfile         ADMIN    the fields a partner edits itself: display name, phone, website, public listing and blurb
 *   partnerRequestProfileChange  ADMIN    legal name, country, contact, address, tax ids — for staff to review
 *   partnerRequestPayoutChange   ADMIN, FINANCE  new bank details: sealed on arrival, never shown or returned again
 *                                         (the request keeps only their mask); staff review them, and every admin is emailed
 *   partnerWithdrawRequest       ADMIN, FINANCE  one of the partner's own PENDING requests, of a kind the role may make
 *
 * One PROFILE and one PAYOUT request may wait at a time ("A change is already waiting for review —
 * withdraw it first."). src/lib/partners/registry.ts and requests.ts check everything again and
 * write the activity log. Another partner's request is refused exactly as one that does not exist.
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

const asObject = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
/** Text as sent; refused when far longer than any field allows — never cut short, so nothing is kept that was not typed. */
const text = (value: unknown, max: number): string => {
  const typed = String(value ?? "");
  if (typed.length > max) throw new PartnerRefused("That is too long.");
  return typed;
};
/** A field left out stays out (undefined: unchanged); null clears it; anything else is text. */
const maybeText = (value: unknown, max: number): string | null | undefined => (value === undefined ? undefined : value === null ? null : text(value, max));

export async function partnerUpdateProfile(input: PartnerSelfInput): Promise<PartnerResult<{ changed: string[] }>> {
  return asPartner(PARTNER_ADMINS, "write", async ({ user }) => {
    const x = asObject(input);
    const done = await updatePartnerSelf(user, {
      ...(x.displayName !== undefined ? { displayName: text(x.displayName, 400) } : {}),
      ...(x.contactPhone !== undefined ? { contactPhone: maybeText(x.contactPhone, 200) } : {}),
      ...(x.website !== undefined ? { website: maybeText(x.website, 600) } : {}),
      ...(x.publicBlurb !== undefined ? { publicBlurb: maybeText(x.publicBlurb, 2000) } : {}),
      ...(x.publicListing !== undefined ? { publicListing: x.publicListing === true } : {}),
    });
    revalidatePortal();
    return done;
  });
}

export async function partnerRequestProfileChange(input: ProfileChangeInput): Promise<PartnerResult<{ id: string }>> {
  return asPartner(PARTNER_ADMINS, "write", async ({ user }) => {
    const x = asObject(input);
    const change: ProfileChangeInput = {};
    if (x.legalName !== undefined) change.legalName = text(x.legalName, 400);
    if (x.country !== undefined) change.country = text(x.country, 100);
    if (x.contactName !== undefined) change.contactName = text(x.contactName, 400);
    if (x.contactEmail !== undefined) change.contactEmail = text(x.contactEmail, 320);
    if (x.address !== undefined) {
      const a = asObject(x.address);
      change.address = { line1: maybeText(a.line1, 400), line2: maybeText(a.line2, 400), city: maybeText(a.city, 240), region: maybeText(a.region, 240), postalCode: maybeText(a.postalCode, 40) };
    }
    if (x.taxIds !== undefined) {
      // At most four are allowed; a few more still reach the check, so its own refusal explains the limit.
      change.taxIds = (Array.isArray(x.taxIds) ? x.taxIds : []).slice(0, 10).map((t) => {
        const id = asObject(t);
        return { kind: text(id.kind, 100), value: text(id.value, 400) };
      });
    }
    const made = await requestProfileChange(user, change);
    revalidatePortal();
    return made;
  });
}

export async function partnerRequestPayoutChange(details: PayoutInput): Promise<PartnerResult<{ id: string }>> {
  return asPartner(PARTNER_MONEY, "write", async ({ user }) => {
    const x = asObject(details);
    const made = await requestPayoutChange(user, {
      accountHolder: text(x.accountHolder, 400),
      bankName: text(x.bankName, 400),
      country: text(x.country, 100),
      currency: text(x.currency, 100),
      accountNumber: maybeText(x.accountNumber, 80) ?? null,
      ifsc: maybeText(x.ifsc, 40) ?? null,
      iban: maybeText(x.iban, 80) ?? null,
      swift: maybeText(x.swift, 40) ?? null,
      routingNumber: maybeText(x.routingNumber, 40) ?? null,
      note: maybeText(x.note, 1000) ?? null,
    });
    revalidatePortal();
    // Only the request's id: the details were sealed on arrival and are never sent back.
    return { id: made.id };
  });
}

export async function partnerWithdrawRequest(requestId: string): Promise<PartnerResult<null>> {
  return asPartner(PARTNER_MONEY, "write", async ({ user }) => {
    await withdrawRequest(user, String(requestId ?? "").slice(0, 40));
    revalidatePortal();
    return null;
  });
}
