/**
 * Telling a browser from everything else, by user agent.
 *
 * Pure and dependency-free so `proxy.ts` can call it on every request without a database round
 * trip, and so `scripts/check-security.ts` can exercise it directly.
 *
 * ## What this is worth
 *
 * A user agent is a string the client chooses. Anything here is defeated by one header, and a
 * scraper that wants in will send `Mozilla/5.0` like everybody else. So this is not the control
 * that stops a determined party — that is the login, the export limit and the bulk-read threshold.
 *
 * What it *does* do is real, though:
 *
 *   - The declared crawlers — Google, Bing, GPTBot, ClaudeBot, CCBot — identify themselves
 *     honestly and obey what they are told. Naming them is how you are not in the training set.
 *   - The public edges of this app (the feedback form, the preference centre, an inbound form)
 *     carry a customer's data behind a token in a URL, reachable with no login at all. Those are
 *     the pages a crawler could actually reach, and the ones this protects.
 *   - Everything it turns away is recorded, which is how you find out what has been knocking.
 */

export type BotCategory =
  /** Declares itself as gathering text for a model. The list that matters most here. */
  | "AI_CRAWLER"
  /** Ordinary search indexing. Turned away too — nothing in an internal ERP belongs in an index. */
  | "SEARCH_CRAWLER"
  /** A script, not a browser: curl, requests, a headless driver. */
  | "AUTOMATION"
  /** Backlink and marketing crawlers. No legitimate business with this app whatsoever. */
  | "SEO_CRAWLER"
  /** Uptime checks. Categorised separately because an admin may well want these allowed. */
  | "MONITOR"
  /** Says "bot" somewhere but matches nothing specific. */
  | "GENERIC_BOT";

export type BotVerdict = { category: BotCategory; agent: string } | null;

/**
 * Matched case-insensitively as substrings, longest-specific first within each group.
 *
 * Kept as plain substrings rather than one big regex: this list is meant to be edited by whoever
 * is on call when something new starts hammering the site, and a regex is how that edit goes wrong.
 */
const SIGNATURES: { category: BotCategory; needles: string[] }[] = [
  {
    category: "AI_CRAWLER",
    needles: [
      "gptbot",
      "chatgpt-user",
      "oai-searchbot",
      "claudebot",
      "claude-web",
      "anthropic-ai",
      "ccbot",
      "google-extended",
      "perplexitybot",
      "perplexity-user",
      "bytespider",
      "amazonbot",
      "applebot-extended",
      "cohere-ai",
      "cohere-training-data-crawler",
      "diffbot",
      "imagesiftbot",
      "omgilibot",
      "omgili",
      "meta-externalagent",
      "meta-externalfetcher",
      "facebookbot",
      "youbot",
      "timpibot",
      "webzio-extended",
      "petalbot",
      "ai2bot",
      "firecrawl",
      "brightbot",
    ],
  },
  {
    category: "SEARCH_CRAWLER",
    needles: [
      "googlebot",
      "storebot-google",
      "bingbot",
      "msnbot",
      "duckduckbot",
      "duckduckgo",
      "baiduspider",
      "yandexbot",
      "slurp",
      "sogou",
      "exabot",
      "seznambot",
      "naver",
    ],
  },
  {
    category: "SEO_CRAWLER",
    needles: [
      "ahrefsbot",
      "semrushbot",
      "mj12bot",
      "dotbot",
      "dataforseobot",
      "blexbot",
      "rogerbot",
      "screaming frog",
      "serpstatbot",
      "zoominfobot",
      "linkdexbot",
      "seokicks",
    ],
  },
  {
    category: "MONITOR",
    needles: ["uptimerobot", "pingdom", "statuscake", "site24x7", "betteruptime", "newrelicpinger"],
  },
  {
    category: "AUTOMATION",
    needles: [
      "curl/",
      "wget",
      "python-requests",
      "python-urllib",
      "aiohttp",
      "httpx",
      "scrapy",
      "go-http-client",
      "java/",
      "okhttp",
      "apache-httpclient",
      "libwww-perl",
      "guzzlehttp",
      "node-fetch",
      "axios/",
      "got (https",
      "phantomjs",
      "headlesschrome",
      "puppeteer",
      "playwright",
      "selenium",
      "webdriver",
      "cypress",
      "postmanruntime",
      "insomnia",
      "http_request2",
      "winhttp",
      "restsharp",
    ],
  },
  {
    category: "GENERIC_BOT",
    needles: ["bot/", "bot;", "bot)", "+bot", "crawler", "spider", "scraper", "scrape", "harvest", "fetcher"],
  },
];

/**
 * What this user agent looks like, or null if it looks like somebody's browser.
 *
 * An absent or empty agent counts as automation. Every real browser sends one; the things that
 * don't are scripts, and saying so is more useful than a separate "unknown" case nobody handles.
 */
export function classifyUserAgent(userAgent: string | null | undefined): BotVerdict {
  const agent = (userAgent ?? "").trim();
  if (agent === "") return { category: "AUTOMATION", agent: "(no user agent)" };

  const lower = agent.toLowerCase();
  for (const { category, needles } of SIGNATURES) {
    // `some` over substrings, in list order, so the specific categories win over GENERIC_BOT —
    // "googlebot" contains "bot/" in some of its variants and must not be filed as generic.
    if (needles.some((needle) => lower.includes(needle))) return { category, agent };
  }
  return null;
}

/**
 * Whether a verdict should be turned away, given what the admin has switched on.
 *
 * Monitors are let through whenever bot blocking is on but AI blocking is the stricter of the two
 * settings — an uptime check that starts returning 403 pages the day DLP is enabled produces a
 * false alarm at 3am, and teaches everyone to ignore the alerting.
 */
export function shouldBlockBot(
  verdict: BotVerdict,
  policy: { blockBots: boolean; blockAiCrawlers: boolean },
): boolean {
  if (!verdict) return false;
  if (verdict.category === "AI_CRAWLER") return policy.blockAiCrawlers || policy.blockBots;
  if (verdict.category === "MONITOR") return false;
  return policy.blockBots;
}

/**
 * The paths the bot check must never touch.
 *
 * `/api` and `/iclock` are machine endpoints by design: the marketing cron, the provider webhooks
 * and — the one that would break loudly — the eSSL biometric terminals, whose firmware sends a
 * user agent that looks nothing like a browser. Blocking those would stop attendance uploads and
 * the firmware would retry forever. They authenticate by shared secret and registered serial
 * instead; see src/app/api/marketing/tick/route.ts and the iclock route.
 */
export function isMachineEndpoint(pathname: string): boolean {
  return pathname.startsWith("/api") || pathname.startsWith("/iclock");
}

/**
 * Sent on every response.
 *
 * `noai` and `noimageai` are not a standard anybody is obliged to honour, but the crawlers that do
 * read them are exactly the ones this is addressed to, and a header costs nothing.
 */
export const ROBOTS_HEADER = "noindex, nofollow, noarchive, nosnippet, noimageindex, noai, noimageai";
