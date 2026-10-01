"use server";

import { redirect } from "next/navigation";
import type { PartnerRole } from "@deskzo/control-client";
import { partnerActor, partnerRefusal, requirePartner, revalidatePortal, type PartnerMode } from "@/lib/partners/guard";
import { finishPartnerEnrolment, removeOwnPartnerTwoFactor, signInPartner, signOutPartner, type PartnerSessionState } from "@/lib/partners/session";
import { PARTNER_EVERYONE, PartnerRefused, type PartnerResult } from "@/lib/partners/types";
import { completePartnerPasswordSetup, emailOwnPartnerPasswordLink, endOtherPartnerSessions, endPartnerSessionByHandle, renamePartnerUser } from "@/lib/partners/users";

/**
 * Signing in to the partner portal, and each person's own account.
 *
 *   partnerSignIn               nobody yet   email + password (+ code when they have an authenticator)
 *   partnerFinishEnrolment      signed in    the first code from a new authenticator
 *   partnerSetPassword          nobody yet   a password from a one-time setup link
 *   partnerSignOut              anybody      ends this session; to /login
 *   partnerRemoveMyTwoFactor    anybody      removes their own authenticator, proven with a current code
 *   partnerEmailMyPasswordLink  anybody      a link to change their password, emailed to themselves only
 *   partnerRenameMe             anybody      their own name
 *   partnerEndMySession         anybody      ends one of their own sessions, by its handle
 *   partnerEndMyOtherSessions   anybody      ends every session of theirs but this one
 *
 * The first four have no session to check by definition (or none yet through two-factor); each does
 * one narrow thing, and src/lib/partners/session.ts checks the host, the lockouts and the codes. The
 * rest go through `asPartner` like every portal action, and the library writes the activity log.
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

export type PartnerSignInAnswer = { ok: true; data: { next: "/" | "/enrol" } } | { ok: false; error: string; needsCode?: boolean };

export async function partnerSignIn(input: { email: string; password: string; code?: string }): Promise<PartnerSignInAnswer> {
  const result = await signInPartner({ email: String(input?.email ?? ""), password: String(input?.password ?? ""), code: input?.code ? String(input.code) : undefined });
  return result.ok ? { ok: true, data: { next: result.next } } : result;
}

export async function partnerFinishEnrolment(code: string): Promise<PartnerResult<null>> {
  const result = await finishPartnerEnrolment(String(code ?? ""));
  return result.ok ? { ok: true, data: null } : result;
}

export async function partnerSetPassword(token: string, password: string): Promise<PartnerResult<null>> {
  const result = await completePartnerPasswordSetup(String(token ?? ""), String(password ?? ""));
  return result.ok ? { ok: true, data: null } : result;
}

export async function partnerSignOut(): Promise<void> {
  await signOutPartner();
  redirect("/login");
}

export async function partnerRemoveMyTwoFactor(code: string): Promise<PartnerResult<null>> {
  return asPartner(PARTNER_EVERYONE, "write", async () => {
    const result = await removeOwnPartnerTwoFactor(String(code ?? ""));
    if (!result.ok) throw new PartnerRefused(result.error);
    revalidatePortal();
    return null;
  });
}

export async function partnerEmailMyPasswordLink(): Promise<PartnerResult<null>> {
  return asPartner(PARTNER_EVERYONE, "write", async ({ user }) => {
    await emailOwnPartnerPasswordLink(user.partner.id, user.id, partnerActor(user));
    revalidatePortal();
    return null;
  });
}

export async function partnerRenameMe(name: string): Promise<PartnerResult<null>> {
  return asPartner(PARTNER_EVERYONE, "write", async ({ user }) => {
    await renamePartnerUser(user.partner.id, user.id, String(name ?? ""), partnerActor(user));
    revalidatePortal();
    return null;
  });
}

export async function partnerEndMySession(handle: string): Promise<PartnerResult<null>> {
  return asPartner(PARTNER_EVERYONE, "write", async ({ user }) => {
    await endPartnerSessionByHandle(user.partner.id, user.id, String(handle ?? ""), partnerActor(user));
    revalidatePortal();
    return null;
  });
}

export async function partnerEndMyOtherSessions(): Promise<PartnerResult<{ ended: number }>> {
  return asPartner(PARTNER_EVERYONE, "write", async ({ user, sessionId }) => {
    const ended = await endOtherPartnerSessions(user.partner.id, user.id, sessionId, partnerActor(user));
    revalidatePortal();
    return { ended };
  });
}
