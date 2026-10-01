import { controlConfigured, controlDb } from "@/lib/platform/control-db";

/**
 * What the platform calls itself to its customers — "I agree to allow Deskzo One to collect…", the
 * signature on support mail.
 *
 * For now it is the public website's name as the CMS last published it (SiteSettings.siteName), and
 * "Deskzo One" — the site's own default — whenever that can't be read: no control plane, nothing
 * published, the database down. A brand setting of its own will replace this later; callers keep
 * calling this.
 *
 * Read straight from the published row rather than through the site's content cache
 * (src/lib/platform/site-content.ts), which would bring every default page of the website into each
 * workspace page that asks. Callers that run on every page cache the answer themselves
 * (src/lib/support/settings.ts).
 */

export { DEFAULT_BRAND_NAME } from "@/lib/brand-names";
import { DEFAULT_BRAND_NAME } from "@/lib/brand-names";

export async function platformBrandName(): Promise<string> {
  if (!controlConfigured()) return DEFAULT_BRAND_NAME;
  try {
    const row = await controlDb().siteSettings.findUnique({ where: { key: "site" }, select: { published: true } });
    const published = row?.published;
    const name = published && typeof published === "object" && !Array.isArray(published) ? (published as Record<string, unknown>).siteName : null;
    const clean = typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    return clean || DEFAULT_BRAND_NAME;
  } catch {
    return DEFAULT_BRAND_NAME;
  }
}
