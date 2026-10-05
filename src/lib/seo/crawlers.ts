/**
 * Who robots.txt (src/app/robots.ts) lets in: owner decision S-D2, "allow AI search, block training" —
 * the defaults since 5 Oct 2026, when the owner made both switchable in the CMS (Settings › Search & AI,
 * src/lib/cms/search-policy.ts), with a third that keeps the whole public site out of search.
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

/** What the CMS decides about crawlers on the public site (the effective search policy carries more; this is all the rules read). */
export type CrawlerPolicy = {
  /** The whole site is kept out of search: every page says noindex, and no AI crawler is let in. */
  hidden: boolean;
  /** AI search crawlers and user-requested fetchers may read the site. */
  aiSearch: boolean;
  /** Crawlers gathering text for model training may read the site. */
  aiTraining: boolean;
};

/** S-D2: search engines and AI search in, training out. */
export const DEFAULT_CRAWLER_POLICY: CrawlerPolicy = { hidden: false, aiSearch: true, aiTraining: false };

/**
 * The public site's rules: search engines may read everything but signing up; AI search crawlers too
 * unless the CMS says not; AI training crawlers only when it says so; SEO crawlers never. The AI groups
 * are named even when `*` would already decide for them, so the policy is explicit to anyone reading
 * the file.
 *
 * Hidden, `*` still may crawl: a search engine has to fetch a page to read its noindex and drop it
 * (a page it may not fetch can stay listed by its address alone). Every AI crawler is refused then —
 * a hidden site is not quoted either.
 */
export function publicSiteRobotsRules(policy: CrawlerPolicy = DEFAULT_CRAWLER_POLICY): RobotsRule[] {
  const open = (agents: readonly string[]): RobotsRule => ({ userAgent: [...agents], allow: "/", disallow: [...PUBLIC_SITE_DISALLOW] });
  const shut = (agents: readonly string[]): RobotsRule => ({ userAgent: [...agents], disallow: "/" });
  return [
    { userAgent: "*", allow: "/", disallow: [...PUBLIC_SITE_DISALLOW] },
    !policy.hidden && policy.aiSearch ? open(AI_SEARCH_AGENTS) : shut(AI_SEARCH_AGENTS),
    !policy.hidden && policy.aiTraining ? open(AI_TRAINING_AGENTS) : shut(AI_TRAINING_AGENTS),
    shut(SEO_AGENTS),
  ];
}

/** Whether these rules let every AI training crawler read the site — the counterpart of `aiSearchCrawlersAllowed`. */
export function aiTrainingCrawlersAllowed(rules: readonly RobotsRule[] = publicSiteRobotsRules()): boolean {
  return allowedFor(rules, AI_TRAINING_AGENTS);
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
  return allowedFor(rules, AI_SEARCH_AGENTS);
}

function allowedFor(rules: readonly RobotsRule[], agents: readonly string[]): boolean {
  const named = (rule: RobotsRule, agent: string) => list(rule.userAgent).some((a) => a.toLowerCase() === agent.toLowerCase());
  return agents.every((agent) => {
    const group = rules.find((r) => named(r, agent)) ?? rules.find((r) => named(r, "*"));
    return !!group && !list(group.disallow).includes("/");
  });
}
