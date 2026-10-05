import type { Metadata } from "next";
import { PageHeader } from "@/components/console/kit/page-header";
import { fill } from "@/components/site/links";
import { cmsPage } from "@/lib/cms/guard";
import { getSearchPolicyDetail } from "@/lib/cms/search-policy";
import { CMS_ADMINS } from "@/lib/cms/types";
import { getSiteSettings, siteStatus } from "@/lib/platform/site-content";
import { SettingsTabs } from "../settings-tabs";
import { SearchSettingsForm } from "./search-form";

export const metadata: Metadata = { title: "Search & AI" };

/**
 * Settings › Search & AI, for admins only (anybody else gets "not found"): the whole public site in or
 * out of search, which AI crawlers robots.txt lets in, and the site's llms.txt
 * (src/lib/cms/search-policy.ts; saved by src/actions/cms/settings.ts cmsSaveSearchPolicy, which
 * writes the activity log). Not a draft: a save is live at once.
 */
export default async function CmsSearchSettingsPage() {
  await cmsPage(CMS_ADMINS);
  const [detail, settings, status] = await Promise.all([getSearchPolicyDetail(), getSiteSettings(), siteStatus()]);

  return (
    <>
      <PageHeader title="Search & AI" subtitle="What search engines and AI crawlers may do with the public website, and its llms.txt. A saved change is live at once." />
      <SettingsTabs active="search" admin />
      <SearchSettingsForm detail={detail} fallbackSummary={fill(settings.seo.description, { settings, trialDays: status.trialDays })} />
    </>
  );
}
