import { CmsShell } from "@/components/cms/shell/cms-shell";
import type { CmsNavBadges } from "@/components/cms/shell/sidebar";
import { cmsPage } from "@/lib/cms/guard";
import { listLeads } from "@/lib/cms/leads";
import { cmsPagesFor } from "@/lib/cms/nav";
import { cmsCapsFor } from "@/lib/cms/types";
import { platformEnv } from "@/lib/platform/console-page";
import { getSiteSettings, siteOrigin } from "@/lib/platform/site-content";

/** New leads for the sidebar's badge. A count that cannot be read is left off, never a broken CMS. */
async function newLeads(): Promise<number> {
  try {
    return (await listLeads({ status: "NEW" })).counts.NEW;
  } catch {
    return 0;
  }
}

/**
 * The website CMS's frame, on cms. only (src/proxy.ts rewrites there into this folder and refuses the
 * folder anywhere else). Signed out, it sends the visitor to /login; through sign-in but not two-factor,
 * to /enrol (src/lib/cms/guard.ts cmsPage). Each page below checks the session itself too: the App
 * Router keeps this layout across navigations without running it again.
 *
 * Everything the shell shows is worked out here, as plain props — never the session's id: who is
 * signed in, the pages their role may open (the registry the page gates read), what they may do, the
 * count of new leads, which installation this is, and where the public site lives.
 */
export default async function CmsLayout({ children }: LayoutProps<"/platform-cms">) {
  const { user } = await cmsPage();
  const caps = cmsCapsFor(user.role);
  const visibleKeys = cmsPagesFor(user.role).map((page) => page.key);
  const url = siteOrigin();
  const [settings, leads] = await Promise.all([getSiteSettings(), visibleKeys.includes("leads") ? newLeads() : Promise.resolve(0)]);
  const badges: CmsNavBadges = leads > 0 ? { leads: { count: leads, label: `${leads.toLocaleString("en-IN")} new` } } : {};

  return (
    <CmsShell
      me={{ id: user.id, name: user.name, email: user.email, role: user.role }}
      env={platformEnv()}
      caps={caps}
      visibleKeys={visibleKeys}
      badges={badges}
      site={{ url, host: new URL(url).host, name: settings.siteName }}
    >
      {children}
    </CmsShell>
  );
}
