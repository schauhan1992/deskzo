"use server";

import type { PartnerRole } from "@deskzo/control-client";
import { partnerActor, partnerRefusal, requirePartner, revalidatePortal, type PartnerMode } from "@/lib/partners/guard";
import type { PartnerSessionState } from "@/lib/partners/session";
import { PARTNER_ADMINS, type PartnerResult, type PartnerSessionRow } from "@/lib/partners/types";
import {
  createPartnerUser,
  deactivatePartnerUser,
  endPartnerUserSessions,
  listPartnerSessions,
  newPartnerSetupLink,
  reactivatePartnerUser,
  resetPartnerUserTwoFactor,
  setPartnerUserRole,
} from "@/lib/partners/users";

/**
 * A partner's team — its ADMIN users only, every one of them, and only ever the signed-in user's own
 * partner: each call passes `me.partner.id`, and src/lib/partners/users.ts refuses a user of any
 * other partner exactly as one that does not exist (it also does the work and writes the activity log).
 *
 *   partnerInviteUser          a new account; its setup link is emailed, and returned once for copying
 *   partnerSetUserRole         another role — never leaving no active admin
 *   partnerDeactivateUser      switched off, signed out everywhere — not oneself, not the last admin
 *   partnerReactivateUser      switched back on as a new starter; a fresh setup link, emailed and returned
 *   partnerNewSetupLink        a fresh setup link (the old one stops working), emailed and returned
 *   partnerResetUserTwoFactor  a lost phone: the authenticator forgotten, signed out everywhere
 *   partnerEndUserSessions     signed out everywhere
 *   partnerUserSessions        somebody's live sessions
 *
 * A setup link is the one thing a team action returns that opens an account: only to an admin of the
 * same partner, only from these, and it is never stored or logged.
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

const id = (value: unknown) => String(value ?? "").slice(0, 40);

export async function partnerInviteUser(input: { email: string; name: string; role: PartnerRole }): Promise<PartnerResult<{ id: string; setupUrl: string; emailed: boolean }>> {
  return asPartner(PARTNER_ADMINS, "write", async ({ user }) => {
    const made = await createPartnerUser(user.partner.id, { email: String(input?.email ?? ""), name: String(input?.name ?? ""), role: input?.role }, partnerActor(user));
    revalidatePortal();
    return made;
  });
}

export async function partnerSetUserRole(userId: string, role: PartnerRole): Promise<PartnerResult<null>> {
  return asPartner(PARTNER_ADMINS, "write", async ({ user }) => {
    await setPartnerUserRole(user.partner.id, id(userId), role, partnerActor(user));
    revalidatePortal();
    return null;
  });
}

export async function partnerDeactivateUser(userId: string): Promise<PartnerResult<null>> {
  return asPartner(PARTNER_ADMINS, "write", async ({ user }) => {
    await deactivatePartnerUser(user.partner.id, id(userId), partnerActor(user));
    revalidatePortal();
    return null;
  });
}

export async function partnerReactivateUser(userId: string): Promise<PartnerResult<{ setupUrl: string; emailed: boolean }>> {
  return asPartner(PARTNER_ADMINS, "write", async ({ user }) => {
    const done = await reactivatePartnerUser(user.partner.id, id(userId), partnerActor(user));
    revalidatePortal();
    return done;
  });
}

export async function partnerNewSetupLink(userId: string): Promise<PartnerResult<{ setupUrl: string; emailed: boolean }>> {
  return asPartner(PARTNER_ADMINS, "write", async ({ user }) => {
    const done = await newPartnerSetupLink(user.partner.id, id(userId), partnerActor(user), true);
    revalidatePortal();
    return { setupUrl: done.setupUrl!, emailed: done.emailed };
  });
}

export async function partnerResetUserTwoFactor(userId: string): Promise<PartnerResult<null>> {
  return asPartner(PARTNER_ADMINS, "write", async ({ user }) => {
    await resetPartnerUserTwoFactor(user.partner.id, id(userId), partnerActor(user));
    revalidatePortal();
    return null;
  });
}

export async function partnerEndUserSessions(userId: string): Promise<PartnerResult<{ ended: number }>> {
  return asPartner(PARTNER_ADMINS, "write", async ({ user }) => {
    const done = await endPartnerUserSessions(user.partner.id, id(userId), partnerActor(user));
    revalidatePortal();
    return done;
  });
}

export async function partnerUserSessions(userId: string): Promise<PartnerResult<PartnerSessionRow[]>> {
  return asPartner(PARTNER_ADMINS, "read", async ({ user, sessionId }) => listPartnerSessions(id(userId), sessionId, { partnerId: user.partner.id }));
}
