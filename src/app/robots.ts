import type { MetadataRoute } from "next";

/**
 * Nothing in here is for a search index or a training corpus.
 *
 * `robots.txt` is a request, not a control — it is obeyed by the crawlers that were never the
 * problem and ignored by the ones that were. It is worth serving anyway for two reasons: the large
 * declared collectors (GPTBot, ClaudeBot, CCBot, Google-Extended) genuinely do honour it, and it
 * is the artefact an auditor asks to see. The control that does not depend on goodwill is the
 * user-agent block in `src/proxy.ts`, and behind that, the fact that every page worth scraping
 * needs a session.
 *
 * Everything is disallowed for everyone, so there is no list to keep up to date and no new page
 * that is accidentally public. The named agents below add nothing technically — `*` already covers
 * them — but naming them means a crawler operator reading this file cannot claim the exclusion was
 * ambiguous, and several of these read their own name in preference to the wildcard.
 */

const AI_AGENTS = [
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "Claude-Web",
  "anthropic-ai",
  "CCBot",
  "Google-Extended",
  "PerplexityBot",
  "Perplexity-User",
  "Bytespider",
  "Amazonbot",
  "Applebot-Extended",
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

const SEO_AGENTS = ["AhrefsBot", "SemrushBot", "MJ12bot", "DotBot", "DataForSeoBot", "BLEXBot", "ZoominfoBot"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", disallow: "/" },
      { userAgent: AI_AGENTS, disallow: "/" },
      { userAgent: SEO_AGENTS, disallow: "/" },
    ],
  };
}
