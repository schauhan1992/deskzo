import type { Metadata } from "next";
import { PageHeader } from "@/components/console/kit/page-header";
import { DEFAULT_SITE_SETTINGS } from "@/components/site/defaults";
import { getSettingsForEdit } from "@/lib/cms/content";
import { cmsPage } from "@/lib/cms/guard";
import { CMS_PAGE_ROLES } from "@/lib/cms/nav";
import { cmsCapsFor } from "@/lib/cms/types";
import { istDateParts } from "@/lib/india-time";
import { siteOrigin, siteStatus } from "@/lib/platform/site-content";
import { SettingsTabs } from "../settings-tabs";
import { NavigationForm } from "./navigation-form";

export const metadata: Metadata = { title: "Navigation" };

/** What the page needs: the settings, whether sign-up is open, the trial's length, and India's year for the preview. */
async function loadNavigation() {
  const [detail, status] = await Promise.all([getSettingsForEdit(), siteStatus()]);
  return { detail, status, year: istDateParts(new Date()).year };
}

/**
 * Settings › Navigation — the header menu, its buttons and the footer's columns: the same settings
 * draft as General (src/actions/cms/settings.ts), of which this form sends only its own part. Everybody
 * may read it; editors and admins change and publish it.
 */
export default async function CmsNavigationPage() {
  const { user } = await cmsPage(CMS_PAGE_ROLES.navigation);
  const caps = cmsCapsFor(user.role);
  const { detail, status, year } = await loadNavigation();

  return (
    <>
      <PageHeader title="Navigation" subtitle="The menus on every page of the site — the header's links and buttons, and the footer's columns." />
      <SettingsTabs active="navigation" admin={caps.admin} />
      <NavigationForm
        detail={detail}
        defaults={DEFAULT_SITE_SETTINGS}
        canEdit={caps.publish}
        signupOpen={status.signupOpen}
        trialDays={status.trialDays}
        year={year}
        siteHost={new URL(siteOrigin()).host}
      />
    </>
  );
}
