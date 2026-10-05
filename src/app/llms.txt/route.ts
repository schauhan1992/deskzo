import { headers } from "next/headers";
import { fill } from "@/components/site/links";
import { redirectedPaths } from "@/lib/cms/redirects";
import { searchPolicy } from "@/lib/cms/search-policy";
import { getSiteSettings, listSitePages, listSitePosts, siteStatus } from "@/lib/platform/site-content";
import { buildLlmsTxt } from "@/lib/seo/llms";
import { classifyHost, protocolFor, requestHost } from "@/lib/tenancy/host";

/**
 * The public website's /llms.txt (src/lib/seo/llms.ts) — on the bare domain and www. only, like the
 * sitemap; every other host answers "not found". It lists what the sitemap does (published, not
 * noindex, not taken over by a redirect), less what an editor left out of llms.txt, and is not served
 * at all while the CMS keeps the site out of search or has llms.txt switched off (Settings › Search & AI).
 */
export async function GET(): Promise<Response> {
  const host = requestHost(await headers());
  if (typeof host !== "string" || classifyHost(host).kind !== "root") return notFound();
  const policy = await searchPolicy();
  if (policy.hidden || !policy.llmsTxt) return notFound();

  const [settings, status, pages, posts] = await Promise.all([getSiteSettings(), siteStatus(), listSitePages(), listSitePosts()]);
  const ctx = { settings, trialDays: status.trialDays };
  const listed = [...pages.filter((p) => p.indexable && p.inLlms), ...posts.filter((p) => p.indexable && p.inLlms)];
  const redirected = await redirectedPaths(listed.map((p) => p.path));
  const keep = (p: { path: string }) => !redirected.has(p.path);
  const entry = (p: { path: string; title: string; description: string }) => ({ path: p.path, title: fill(p.title, ctx), description: fill(p.description, ctx) });

  const body = buildLlmsTxt({
    siteName: settings.siteName,
    summary: policy.llmsSummary || fill(settings.seo.description, ctx),
    origin: `${protocolFor(host)}://${host}`,
    nav: settings.nav,
    pages: pages.filter((p) => p.indexable && p.inLlms && keep(p)).map(entry),
    posts: posts.filter((p) => p.indexable && p.inLlms && keep(p)).map(entry),
  });
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
}

function notFound(): Response {
  return new Response("Not found.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
