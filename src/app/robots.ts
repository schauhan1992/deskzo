import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { closedRobotsRules, publicSiteRobotsRules } from "@/lib/seo/crawlers";
import { classifyHost, protocolFor, requestHost } from "@/lib/tenancy/host";

/**
 * Nothing in here is for a search index or a training corpus — except the public website (below).
 *
 * `robots.txt` is a request, not a control — it is obeyed by the crawlers that were never the
 * problem and ignored by the ones that were. It is worth serving anyway for two reasons: the large
 * declared collectors (GPTBot, ClaudeBot, CCBot, Google-Extended) genuinely do honour it, and it
 * is the artefact an auditor asks to see. The control that does not depend on goodwill is the
 * user-agent block in `src/proxy.ts`, and behind that, the fact that every page worth scraping
 * needs a session.
 *
 * Everything is disallowed for everyone, so there is no list to keep up to date and no new page
 * that is accidentally public. The named agents add nothing technically — `*` already covers
 * them — but naming them means a crawler operator reading this file cannot claim the exclusion was
 * ambiguous, and several of these read their own name in preference to the wildcard. The lists and
 * the rules are in src/lib/seo/crawlers.ts, where the SEO engine reads them too.
 */

/**
 * Every host but one: everything disallowed, as above. The exception is the platform's public website
 * — the bare domain and www. (src/app/platform-site) — which exists to be found: search engines may
 * crawl it, except signing up, and are pointed at its sitemap. AI search crawlers may read it on the
 * same terms (owner decision S-D2: an AI answer that quotes the site links to it); AI training
 * crawlers and the SEO tools' crawlers stay shut out there too.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const host = requestHost(await headers());
  if (typeof host === "string" && classifyHost(host).kind === "root") {
    return { rules: publicSiteRobotsRules(), sitemap: `${protocolFor(host)}://${host}/sitemap.xml` };
  }
  return { rules: closedRobotsRules() };
}
