"use server";

import { redirect } from "next/navigation";
import { cmsAction, cmsActor, revalidateCms } from "@/lib/cms/guard";
import { finishCmsEnrolment, removeOwnCmsTwoFactor, signInCms, signOutCms } from "@/lib/cms/session";
import { CMS_EVERYONE, CmsRefused, type CmsResult } from "@/lib/cms/types";
import { completeCmsPasswordSetup, emailOwnPasswordLink, endCmsSessionByHandle, endOtherCmsSessions, renameCmsUser } from "@/lib/cms/users";

/**
 * Signing in to the CMS, and each person's own account.
 *
 *   cmsSignIn               nobody yet   email + password (+ code when they have an authenticator)
 *   cmsFinishEnrolment      signed in    the first code from a new authenticator
 *   cmsSetPassword          nobody yet   a password from a one-time setup link
 *   cmsSignOut              anybody      ends this session; to /login
 *   cmsRemoveMyTwoFactor    anybody      removes their own authenticator, proven with a current code
 *   cmsEmailMyPasswordLink  anybody      a link to change their password, emailed to themselves only
 *   cmsRenameMe             anybody      their own name
 *   cmsEndMySession         anybody      ends one of their own sessions, by its handle
 *   cmsEndMyOtherSessions   anybody      ends every session of theirs but this one
 *
 * The first three have no session to check by definition; each does one narrow thing. The rest check
 * the session like every CMS action (src/lib/cms/guard.ts) and write the activity log.
 */

export type CmsSignInAnswer = { ok: true; data: { next: "/" | "/enrol" } } | { ok: false; error: string; needsCode?: boolean };

export async function cmsSignIn(input: { email: string; password: string; code?: string }): Promise<CmsSignInAnswer> {
  const result = await signInCms({ email: String(input?.email ?? ""), password: String(input?.password ?? ""), code: input?.code ? String(input.code) : undefined });
  return result.ok ? { ok: true, data: { next: result.next } } : result;
}

export async function cmsFinishEnrolment(code: string): Promise<CmsResult<null>> {
  const result = await finishCmsEnrolment(String(code ?? ""));
  return result.ok ? { ok: true, data: null } : result;
}

export async function cmsSetPassword(token: string, password: string): Promise<CmsResult<null>> {
  const result = await completeCmsPasswordSetup(String(token ?? ""), String(password ?? ""));
  return result.ok ? { ok: true, data: null } : result;
}

export async function cmsSignOut(): Promise<void> {
  await signOutCms();
  redirect("/login");
}

export async function cmsRemoveMyTwoFactor(code: string): Promise<CmsResult<null>> {
  return cmsAction(CMS_EVERYONE, async () => {
    const result = await removeOwnCmsTwoFactor(String(code ?? ""));
    if (!result.ok) throw new CmsRefused(result.error);
    revalidateCms();
    return null;
  });
}

export async function cmsEmailMyPasswordLink(): Promise<CmsResult<null>> {
  return cmsAction(CMS_EVERYONE, async ({ user }) => {
    await emailOwnPasswordLink(user.id, cmsActor(user));
    return null;
  });
}

export async function cmsRenameMe(name: string): Promise<CmsResult<null>> {
  return cmsAction(CMS_EVERYONE, async ({ user }) => {
    await renameCmsUser(user.id, String(name ?? ""), cmsActor(user));
    revalidateCms();
    return null;
  });
}

export async function cmsEndMySession(handle: string): Promise<CmsResult<null>> {
  return cmsAction(CMS_EVERYONE, async ({ user }) => {
    await endCmsSessionByHandle(user.id, String(handle ?? ""), cmsActor(user));
    revalidateCms();
    return null;
  });
}

export async function cmsEndMyOtherSessions(): Promise<CmsResult<{ ended: number }>> {
  return cmsAction(CMS_EVERYONE, async ({ user, sessionId }) => {
    const ended = await endOtherCmsSessions(user.id, sessionId, cmsActor(user));
    revalidateCms();
    return { ended };
  });
}
