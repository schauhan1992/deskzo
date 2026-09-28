import type { Metadata } from "next";
import { PageHeader } from "@/components/console/kit/page-header";
import { DEFAULT_SITE_SETTINGS } from "@/components/site/defaults";
import { getSettingsForEdit } from "@/lib/cms/content";
import { cmsPage } from "@/lib/cms/guard";
import { getMedia } from "@/lib/cms/media";
import { CMS_PAGE_ROLES } from "@/lib/cms/nav";
import { cmsCapsFor } from "@/lib/cms/types";
import { mediaIdOf } from "@/lib/cms/validate";
import { GeneralSettingsForm } from "./general-form";
import { SettingsTabs } from "./settings-tabs";

export const metadata: Metadata = { title: "Settings" };

/**
 * Settings › General — the site's identity, contact email, social links, search defaults and
 * not-found page, as a draft that is published on purpose (src/actions/cms/settings.ts). Everybody
 * may read it; editors and admins change and publish it (`caps.publish`), and the actions check that
 * again. The draft, what is live, who saved it and when all come from `getSettingsForEdit()`.
 */
export default async function CmsSettingsPage() {
  const { user } = await cmsPage(CMS_PAGE_ROLES.settings);
  const caps = cmsCapsFor(user.role);
  const detail = await getSettingsForEdit();
  const ogId = mediaIdOf(detail.draft.seo?.ogImage);
  const ogMedia = ogId ? await getMedia(ogId) : null;

  return (
    <>
      <PageHeader title="Settings" subtitle="The site's name, contact email, social links and what search engines see — saved as a draft, live when published." />
      <SettingsTabs active="general" admin={caps.admin} />
      <GeneralSettingsForm detail={detail} defaults={DEFAULT_SITE_SETTINGS} canEdit={caps.publish} ogMedia={ogMedia} />
    </>
  );
}
