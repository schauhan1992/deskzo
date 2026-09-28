import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { applicationsShown, directoryShown } from "@/components/site/partners/programme";
import { redirectedPaths } from "@/lib/cms/redirects";
import { taxonomySitemapEntries } from "@/lib/cms/taxonomy";
import { listSitePages, listSitePosts } from "@/lib/platform/site-content";
import { classifyHost, protocolFor, requestHost } from "@/lib/tenancy/host";

/**
 * The public website's pages, for search engines — on the bare domain and www. only, at the address
 * the request came in on. Every other host (a workspace, the console) has nothing to list: its
 * robots.txt disallows everything, and this answers an empty list.
 *
 * The proxy lets /sitemap.xml through on the public site's hosts rather than into its folder
 * (src/proxy.ts); pages and posts come from the site's one content loader
 * (src/lib/platform/site-content.ts): every indexable page, and — once anything is published — the
 * blog and each post on it. The partner programme's two fixed pages follow its settings (spec §10):
 * "Become a partner" while applications are open, "Find a partner" while the directory is on. The
 * blog's category and tag archives are listed while they have a post on the site
 * (src/lib/cms/taxonomy.ts). A redirect's source never is: not an old address, nor a live page's or
 * post's that an enabled redirect now sends elsewhere (src/lib/cms/redirects.ts `redirectedPaths`).
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const host = requestHost(await headers());
  if (typeof host !== "string" || classifyHost(host).kind !== "root") return [];
  const origin = `${protocolFor(host)}://${host}`;
  const [pages, posts, applying, directory, archives] = await Promise.all([listSitePages(), listSitePosts(), applicationsShown(), directoryShown(), taxonomySitemapEntries()]);
  const pageEntries = pages
    .filter((page) => page.indexable)
    .map((page) => ({
      url: `${origin}${page.path}`,
      ...(page.updatedAt ? { lastModified: page.updatedAt } : {}),
      changeFrequency: page.path === "/" ? ("weekly" as const) : ("monthly" as const),
      priority: page.path === "/" ? 1 : 0.7,
    }));
  const programmeEntries = [...(applying ? ["/partners"] : []), ...(directory ? ["/partners/find"] : [])].map((path) => ({ url: `${origin}${path}`, changeFrequency: "monthly" as const, priority: 0.5 }));
  const blog = posts.length ? [{ url: `${origin}/blog`, lastModified: posts[0].updatedAt, changeFrequency: "weekly" as const, priority: 0.6 }] : [];
  const postEntries = posts.filter((post) => post.indexable).map((post) => ({ url: `${origin}${post.path}`, lastModified: post.updatedAt, changeFrequency: "monthly" as const, priority: 0.5 }));
  const archiveEntries = posts.length ? archives.map((archive) => ({ url: `${origin}${archive.path}`, lastModified: archive.updatedAt, changeFrequency: "weekly" as const, priority: 0.4 })) : [];
  const entries: MetadataRoute.Sitemap = [...pageEntries, ...programmeEntries, ...blog, ...postEntries, ...archiveEntries];
  // A page or post whose address an editor has redirected by hand is still live, but its address now goes elsewhere.
  const redirected = await redirectedPaths(entries.map((e) => new URL(e.url).pathname));
  return redirected.size ? entries.filter((e) => !redirected.has(new URL(e.url).pathname)) : entries;
}
