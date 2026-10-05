"use server";

import type { SiteSettings } from "@/components/site/blocks/types";
import { getSettingsForEdit, publishSettings, saveSettingsDraft } from "@/lib/cms/content";
import { cmsAction, cmsActor, revalidateCms } from "@/lib/cms/guard";
import { saveSearchPolicy } from "@/lib/cms/search-policy";
import { cmsTwoFactorPolicy } from "@/lib/cms/session";
import { CMS_ADMINS, CMS_EVERYONE, CMS_PUBLISHERS, type CmsResult, type CmsTwoFactorMode, type SearchPolicyDetail, type SettingsDetail } from "@/lib/cms/types";
import { setCmsTwoFactorPolicy } from "@/lib/cms/users";

/**
 * The site's settings and navigation (one SiteSettings document with a draft and a published copy),
 * and the CMS's own security.
 *
 *   cmsGetSettings          everybody    draft, published, changed, version
 *   cmsSaveSettingsDraft    publishers   `settings` holds just the fields being changed — identity,
 *                                        emails, social, SEO, nav/signinLink/signupCta/footer, notFound
 *   cmsPublishSettings      publishers   the draft (with `settings` laid over it first, when given) goes live
 *   cmsTwoFactorPolicy      admins       "optional" | "required", and whether an admin has chosen
 *   cmsSetTwoFactorPolicy   admins
 *   cmsSaveSearchPolicy     admins       what crawlers may do on the public site, and llms.txt — live at once
 */

export async function cmsGetSettings(): Promise<CmsResult<SettingsDetail>> {
  return cmsAction(CMS_EVERYONE, async () => getSettingsForEdit());
}

export async function cmsSaveSettingsDraft(input: { settings: Partial<SiteSettings>; version: string; force?: boolean }): Promise<CmsResult<SettingsDetail>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    const saved = await saveSettingsDraft({ settings: input?.settings ?? {}, version: String(input?.version ?? ""), force: input?.force === true }, user);
    revalidateCms();
    return saved;
  });
}

export async function cmsPublishSettings(input: { settings?: Partial<SiteSettings>; version?: string; force?: boolean } = {}): Promise<CmsResult<SettingsDetail>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    const saved = await publishSettings({ settings: input?.settings, version: input?.version ? String(input.version) : undefined, force: input?.force === true }, user);
    revalidateCms();
    return saved;
  });
}

export async function cmsTwoFactorPolicyState(): Promise<CmsResult<{ mode: CmsTwoFactorMode; chosen: boolean }>> {
  return cmsAction(CMS_ADMINS, async () => cmsTwoFactorPolicy());
}

export async function cmsSetTwoFactorPolicy(mode: CmsTwoFactorMode): Promise<CmsResult<{ mode: CmsTwoFactorMode }>> {
  return cmsAction(CMS_ADMINS, async ({ user }) => {
    await setCmsTwoFactorPolicy(mode, cmsActor(user));
    revalidateCms();
    return { mode };
  });
}

export async function cmsSaveSearchPolicy(input: unknown): Promise<CmsResult<SearchPolicyDetail>> {
  return cmsAction(CMS_ADMINS, async ({ user }) => {
    const saved = await saveSearchPolicy(input, cmsActor(user));
    revalidateCms();
    return saved;
  });
}
