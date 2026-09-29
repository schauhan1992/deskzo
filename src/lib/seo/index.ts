/**
 * SEO Intelligence — the pure engine. Scores a page, post, archive or the blog index for SEO, AEO
 * and GEO from its saved (or edited) content; builds the site's metadata and JSON-LD. Internal
 * indicators only: not Google's, nor any AI platform's, scores.
 *
 *   types.ts      the vocabulary: SeoInput, CheckDef, CheckResult, EntityScore…
 *   extract.ts    CMS shapes → SeoInput (inputFromPage, inputFromPost, inputFromArchive, inputFromBlogIndex)
 *   metadata.ts   the site's Next metadata, built purely, and what the HTML carries (effectiveMetadata)
 *   schema.ts     JSON-LD builders (S-D1) and serialiseLd
 *   keywords.ts   the three primary keywords: normalising, refusing repeats, placement analysis
 *   checks/       the registries: SEO_CHECKS, AEO_CHECKS, GEO_CHECKS
 *   engine.ts     scoreCategory, scoreEntity, WEIGHTS, labelFor
 *   site.ts       siteScore: the weighted site score, counts and site-level checks
 *
 * Client-safe throughout: no database, no React, nothing server-only.
 */

export * from "@/lib/seo/types";
export { countWords, hasPhrase, isQuestion, istDay, tokenize } from "@/lib/seo/text";
export * from "@/lib/seo/keywords";
export * from "@/lib/seo/metadata";
export * from "@/lib/seo/schema";
export * from "@/lib/seo/extract";
export { SEO_CHECKS, EXPECTED_LD, inSitemap, sitemapExclusion, robotsBlocked, TITLE_RANGE, DESCRIPTION_RANGE, MIN_WORDS, ARCHIVE_DESCRIPTION_MIN_WORDS, SECTION_WORDS } from "@/lib/seo/checks/seo";
export { AEO_CHECKS, ANSWER_MAX_WORDS, LONG_PARAGRAPH_WORDS, SECTION_MAX_WORDS } from "@/lib/seo/checks/aeo";
export { GEO_CHECKS, STALE_MONTHS, DEPTH, PASSAGE_WORDS, REPEAT } from "@/lib/seo/checks/geo";
export * from "@/lib/seo/engine";
export * from "@/lib/seo/site";
