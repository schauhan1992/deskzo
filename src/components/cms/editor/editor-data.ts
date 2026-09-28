import type { SiteRenderContext } from "@/components/site/blocks/types";
import { listPages } from "@/lib/cms/content";
import { getMediaRows } from "@/lib/cms/media";
import type { MediaRow } from "@/lib/cms/types";
import { mediaIdsIn } from "@/lib/cms/validate";
import { istDateParts } from "@/lib/india-time";
import { getSiteSettings, siteOrigin, siteStatus, workspaceSuffix } from "@/lib/platform/site-content";

/**
 * What the page and post editors' server pages hand the editor besides the document — read on the
 * server, after the page's guard. Server only: it reads the control plane.
 *
 *   · the render context the live preview draws blocks with: the site's published settings (so
 *     {siteName} and the header read as the site does), whether signup is open, the trial length;
 *   · the year for the preview's footer, in India's calendar — never the browser's clock;
 *   · the site's own addresses, offered in link fields;
 *   · the library rows of the images the document uses (filename, alt text).
 */
export async function editorEnvironment(): Promise<{ ctx: SiteRenderContext; year: number; siteOrigin: string; sitePaths: string[] }> {
  const [settings, status, pages] = await Promise.all([getSiteSettings(), siteStatus(), listPages()]);
  const sitePaths = [...new Set([...pages.map((p) => p.path), "/blog", "/contact?topic=demo", "/contact?topic=sales"])];
  return {
    ctx: { settings, signupOpen: status.signupOpen, trialDays: status.trialDays, searchParams: {}, workspaceSuffix: workspaceSuffix() },
    year: istDateParts(new Date()).year,
    siteOrigin: siteOrigin(),
    sitePaths,
  };
}

/** The library rows for every "/media/<id>" in `value` (and any extra ids, like a post's cover). */
export async function mediaRowsFor(value: unknown, extra: (string | null | undefined)[] = []): Promise<MediaRow[]> {
  const ids = mediaIdsIn(value);
  for (const id of extra) if (id) ids.add(id);
  return ids.size ? getMediaRows([...ids]) : [];
}
