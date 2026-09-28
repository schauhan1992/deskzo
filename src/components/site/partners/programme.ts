import type { SiteRenderContext } from "@/components/site/blocks/types";
import { applicationsOpen, directoryOpen } from "@/lib/partners/settings";
import { controlConfigured } from "@/lib/platform/control-db";
import { getSiteSettings, siteStatus } from "@/lib/platform/site-content";

/**
 * What the partner programme's public pages (src/app/platform-site/partners) share: the site's words
 * for `fill` — read as SitePageView reads them, so {siteName} is whatever the CMS has published — and
 * the programme's two public switches (spec §11), read fail-safe.
 */

/** The site's settings and trial length, for `fill` (src/components/site/links.ts). */
export async function siteCopy(): Promise<Pick<SiteRenderContext, "settings" | "trialDays">> {
  const [settings, status] = await Promise.all([getSiteSettings(), siteStatus()]);
  return { settings, trialDays: status.trialDays };
}

/**
 * A switch as the control plane has it — off when there is no control plane or it can't answer:
 * the site never offers what it couldn't keep (an application with nowhere to go) or show.
 */
async function programmeSwitch(read: () => Promise<boolean>, what: string): Promise<boolean> {
  if (!controlConfigured()) return false;
  try {
    return await read();
  } catch (err) {
    console.warn(`[site] partner ${what} setting unavailable, treated as off: ${(err as { code?: string } | null)?.code ?? (err instanceof Error ? err.name : "error")}`);
    return false;
  }
}

/** "Become a partner" takes applications (partners.applications; on unless an owner closes them). */
export const applicationsShown = () => programmeSwitch(applicationsOpen, "applications");

/** "Find a partner" is shown (partners.directory; off unless an owner turns it on). */
export const directoryShown = () => programmeSwitch(directoryOpen, "directory");
