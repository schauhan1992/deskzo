import { scoreDetail } from "@/lib/cms/seo-scores";
import { CmsRefused, type SeoEntityType, type SeoScoreDetail } from "@/lib/cms/types";

/**
 * What the dashboard's drawer shows for `?open=` — loaded by the server page, never in the browser.
 * A stale or never-calculated entity is calculated afresh (stored only when `store`: a writer's
 * look refreshes the cache, a viewer's changes nothing). A key that names nothing on the site is a
 * message in the drawer, not an error page.
 *
 * Server-only (src/lib/cms/seo-scores.ts reads the control database).
 */
export type OpenDetail = { ref: { type: SeoEntityType; key: string }; detail: SeoScoreDetail | null; error: string | null };

export async function loadOpenDetail(open: { type: SeoEntityType; key: string } | null, options: { store: boolean }): Promise<OpenDetail | null> {
  if (!open) return null;
  try {
    return { ref: open, detail: await scoreDetail(open.type, open.key, { store: options.store }), error: null };
  } catch (err) {
    if (err instanceof CmsRefused) return { ref: open, detail: null, error: err.message };
    console.warn(`[seo] the dashboard's detail for ${open.type}:${open.key} didn't load: ${err instanceof Error ? err.message : String(err)}`);
    return { ref: open, detail: null, error: "Its analysis couldn't be loaded. Try again in a moment." };
  }
}
