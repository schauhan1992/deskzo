/**
 * Who robots.txt (src/app/robots.ts) lets in: owner decision S-D2, "allow AI search, block training".
 *
 * On the public site (the bare domain and www.), an AI assistant's search crawler and the fetcher
 * that reads a page because somebody asked about it may read every page robots.txt opens to search
 * engines: they are how the site is found, quoted and linked to in AI answers. Crawlers gathering
 * text to train models may not, nor the SEO tools' crawlers. Every other host (workspaces, the
 * console, the CMS, the partner portal) refuses everybody, these included, as before.
 *
 * The SEO engine reads the same rules (`aiSearchCrawlersAllowed`), so its score says what the live
 * robots.txt says. Pure and client-safe.
 */

/** AI search crawlers and user-requested fetchers: they read a page to answer with it, and link back. Allowed on the public site. */
export const AI_SEARCH_AGENTS: readonly string[] = ["OAI-SearchBot", "ChatGPT-User", "Claude-SearchBot", "Claude-User", "PerplexityBot", "Perplexity-User"];

/** Collectors for model training, and AI crawlers that do not keep search apart from training. Refused on every host. */
export const AI_TRAINING_AGENTS: readonly string[] = [
  "GPTBot",
  "ClaudeBot",
  "Claude-Web",
  "anthropic-ai",
  "CCBot",
  "Google-Extended",
  "Applebot-Extended",
  "Bytespider",
  "Amazonbot",
  "cohere-ai",
  "Diffbot",
  "ImagesiftBot",
  "Omgilibot",
  "Meta-ExternalAgent",
  "FacebookBot",
  "YouBot",
  "Timpibot",
  "AI2Bot",
  "PetalBot",
];

/** Every AI crawler this file names. */
export const AI_AGENTS: readonly string[] = [...AI_SEARCH_AGENTS, ...AI_TRAINING_AGENTS];

/** Backlink and marketing crawlers. Refused on every host. */
export const SEO_AGENTS: readonly string[] = ["AhrefsBot", "SemrushBot", "MJ12bot", "DotBot", "DataForSeoBot", "BLEXBot", "ZoominfoBot"];

/** What the public site asks every crawler it lets in to leave alone: signing up. */
export const PUBLIC_SITE_DISALLOW: readonly string[] = ["/signup"];

/** One robots.txt group, in the shape Next's `MetadataRoute.Robots` takes. */
export type RobotsRule = { userAgent: string | string[]; allow?: string | string[]; disallow?: string | string[] };

/**
 * The public site's rules: search engines and the AI search crawlers may read everything but signing
 * up; AI training and SEO crawlers nothing. The search crawlers are named in a group of their own,
 * though `*` already lets them in, so the policy is explicit to anyone reading the file.
 */
export function publicSiteRobotsRules(): RobotsRule[] {
  return [
    { userAgent: "*", allow: "/", disallow: [...PUBLIC_SITE_DISALLOW] },
    { userAgent: [...AI_SEARCH_AGENTS], allow: "/", disallow: [...PUBLIC_SITE_DISALLOW] },
    { userAgent: [...AI_TRAINING_AGENTS], disallow: "/" },
    { userAgent: [...SEO_AGENTS], disallow: "/" },
  ];
}

/** Every other host's rules: nothing for anyone. The named agents add nothing to `*`, but leave no room to claim ambiguity. */
export function closedRobotsRules(): RobotsRule[] {
  return [
    { userAgent: "*", disallow: "/" },
    { userAgent: [...AI_AGENTS], disallow: "/" },
    { userAgent: [...SEO_AGENTS], disallow: "/" },
  ];
}

const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/**
 * Whether these rules (the public site's, by default) let every AI search crawler read the site's
 * pages: each one's own group, else `*`, must not disallow "/". The engine's `aiSearchCrawlersAllowed`.
 */
export function aiSearchCrawlersAllowed(rules: readonly RobotsRule[] = publicSiteRobotsRules()): boolean {
  const named = (rule: RobotsRule, agent: string) => list(rule.userAgent).some((a) => a.toLowerCase() === agent.toLowerCase());
  return AI_SEARCH_AGENTS.every((agent) => {
    const group = rules.find((r) => named(r, agent)) ?? rules.find((r) => named(r, "*"));
    return !!group && !list(group.disallow).includes("/");
  });
}
