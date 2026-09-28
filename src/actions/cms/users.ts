"use server";

import type { CmsRole } from "@wroffy/control-client";
import { cmsAction, cmsActor, revalidateCms } from "@/lib/cms/guard";
import { CMS_ADMINS, type CmsResult, type CmsSessionRow } from "@/lib/cms/types";
import {
  createCmsUser,
  deactivateCmsUser,
  endCmsSessionByHandle,
  endCmsUserSessions,
  listCmsSessions,
  newCmsSetupLink,
  reactivateCmsUser,
  resetCmsUserTwoFactor,
  setCmsUserRole,
} from "@/lib/cms/users";

/**
 * CMS accounts — ADMIN only, every one of them (src/lib/cms/users.ts does the work and writes the
 * activity log):
 *
 *   cmsInviteUser          a new account; its setup link is emailed, and returned once for copying
 *   cmsSetUserRole         another role — never leaving no active admin
 *   cmsDeactivateUser      switched off, signed out everywhere — not oneself, not the last admin
 *   cmsReactivateUser      switched back on as a new starter; a fresh setup link, emailed and returned
 *   cmsNewSetupLink        a fresh setup link (the old one stops working), emailed and returned
 *   cmsResetUserTwoFactor  a lost phone: the authenticator forgotten, signed out everywhere
 *   cmsEndUserSessions     signed out everywhere
 *   cmsUserSessions        somebody's live sessions
 *   cmsEndUserSession      one of somebody's sessions, by its handle
 *
 * A setup link is the one thing any CMS action returns that opens an account: only to an admin, only
 * from these, and it is never stored or logged.
 */

const id = (value: unknown) => String(value ?? "").slice(0, 40);

export async function cmsInviteUser(input: { email: string; name: string; role: CmsRole }): Promise<CmsResult<{ id: string; setupUrl: string; emailed: boolean }>> {
  return cmsAction(CMS_ADMINS, async ({ user }) => {
    const made = await createCmsUser({ email: String(input?.email ?? ""), name: String(input?.name ?? ""), role: input?.role }, cmsActor(user));
    revalidateCms();
    return made;
  });
}

export async function cmsSetUserRole(userId: string, role: CmsRole): Promise<CmsResult<null>> {
  return cmsAction(CMS_ADMINS, async ({ user }) => {
    await setCmsUserRole(id(userId), role, cmsActor(user));
    revalidateCms();
    return null;
  });
}

export async function cmsDeactivateUser(userId: string): Promise<CmsResult<null>> {
  return cmsAction(CMS_ADMINS, async ({ user }) => {
    await deactivateCmsUser(id(userId), cmsActor(user));
    revalidateCms();
    return null;
  });
}

export async function cmsReactivateUser(userId: string): Promise<CmsResult<{ setupUrl: string; emailed: boolean }>> {
  return cmsAction(CMS_ADMINS, async ({ user }) => {
    const done = await reactivateCmsUser(id(userId), cmsActor(user));
    revalidateCms();
    return done;
  });
}

export async function cmsNewSetupLink(userId: string): Promise<CmsResult<{ setupUrl: string; emailed: boolean }>> {
  return cmsAction(CMS_ADMINS, async ({ user }) => {
    const done = await newCmsSetupLink(id(userId), cmsActor(user), true);
    revalidateCms();
    return { setupUrl: done.setupUrl!, emailed: done.emailed };
  });
}

export async function cmsResetUserTwoFactor(userId: string): Promise<CmsResult<null>> {
  return cmsAction(CMS_ADMINS, async ({ user }) => {
    await resetCmsUserTwoFactor(id(userId), cmsActor(user));
    revalidateCms();
    return null;
  });
}

export async function cmsEndUserSessions(userId: string): Promise<CmsResult<{ ended: number }>> {
  return cmsAction(CMS_ADMINS, async ({ user }) => {
    const ended = await endCmsUserSessions(id(userId), cmsActor(user));
    revalidateCms();
    return { ended };
  });
}

export async function cmsUserSessions(userId: string): Promise<CmsResult<CmsSessionRow[]>> {
  return cmsAction(CMS_ADMINS, async ({ sessionId }) => listCmsSessions(id(userId), sessionId));
}

export async function cmsEndUserSession(userId: string, handle: string): Promise<CmsResult<null>> {
  return cmsAction(CMS_ADMINS, async ({ user }) => {
    await endCmsSessionByHandle(id(userId), String(handle ?? ""), cmsActor(user));
    revalidateCms();
    return null;
  });
}
