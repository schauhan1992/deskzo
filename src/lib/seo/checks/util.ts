import type { CheckOutcome, CheckSeverity, SeoEntityKind, SeoInput } from "@/lib/seo/types";
import { isQuestion } from "@/lib/seo/text";

/**
 * What the three check registries share: the kinds, the outcome shapes, and the questions several
 * checks ask of an input (is it a form, is it informational, which headings are questions, where an
 * editor changes a field). Pure; no state.
 */

export const ALL_KINDS: readonly SeoEntityKind[] = ["page", "home", "post", "category", "tag", "blog-index"];
export const PAGE_KINDS: readonly SeoEntityKind[] = ["page", "home"];
/** Pages and posts: the entities whose content an editor writes block by block. */
export const CONTENT_KINDS: readonly SeoEntityKind[] = ["page", "home", "post"];
export const ARCHIVE_KINDS: readonly SeoEntityKind[] = ["category", "tag"];

type Extra = { field?: string; severity?: CheckSeverity };

const withField = (extra: Extra): Extra => {
  const out: Extra = {};
  if (extra.field) out.field = extra.field;
  if (extra.severity) out.severity = extra.severity;
  return out;
};

/** Full marks. */
export const pass = (weight: number, message: string, extra: Extra = {}): CheckOutcome => ({ status: "PASS", pointsEarned: weight, message, recommendation: "", ...withField(extra) });

/** Something to improve, with the points still earned. */
export const warn = (earned: number, message: string, recommendation: string, extra: Extra = {}): CheckOutcome => ({
  status: "WARNING",
  pointsEarned: earned,
  message,
  recommendation,
  ...withField({ severity: "improvement", ...extra }),
});

/** Wrong: no points. */
export const fail = (message: string, recommendation: string, extra: Extra = {}): CheckOutcome => ({
  status: "FAIL",
  pointsEarned: 0,
  message,
  recommendation,
  ...withField({ severity: "improvement", ...extra }),
});

/** Worth knowing, not scored: a suggestion, or a fact such as "intentionally excluded". */
export const info = (message: string, recommendation = "", extra: Extra = {}): CheckOutcome => ({ status: "INFO", pointsEarned: 0, message, recommendation, ...withField(extra) });

/** Does not apply here, and says why. */
export const notApplicable = (message: string): CheckOutcome => ({ status: "NOT_APPLICABLE", pointsEarned: 0, message, recommendation: "" });

// ─── Questions about an input ────────────────────────────────────────────────────────────────────

/** Intentionally kept out of search engines. */
export const isExcluded = (input: SeoInput): boolean => !input.meta.robots.index;

export const isForm = (input: SeoInput): boolean => input.pageType === "form";
export const isLegal = (input: SeoInput): boolean => input.pageType === "legal";
export const isArchive = (input: SeoInput): boolean => input.kind === "category" || input.kind === "tag";

/** Content that answers something: a post, or a page of more than 400 words that is not a form or a legal page. */
export function isInformational(input: SeoInput): boolean {
  if (input.kind === "post") return true;
  if (input.kind !== "page" && input.kind !== "home") return false;
  return !isForm(input) && !isLegal(input) && input.content.wordCount > 400;
}

/** H2–H6 headings shaped as questions, with their index in `headings`. */
export function questionHeadings(input: SeoInput): { index: number; text: string; field: string | null; level: number }[] {
  return input.content.headings.map((h, index) => ({ index, text: h.text, field: h.field, level: h.level })).filter((h) => h.level > 1 && isQuestion(h.text));
}

/** The first paragraph right under a heading, or null when something else (or nothing) comes first. */
export function answerUnder(input: SeoInput, headingIndex: number) {
  return input.content.paragraphs.find((p) => p.heading === headingIndex && p.leading) ?? null;
}

/** An enabled redirect sends this address elsewhere. */
export const isRedirected = (input: SeoInput): boolean => input.site.redirectedPaths.includes(input.path);

/** Keyword 1: the one the page is about. */
export const primaryKeyword = (input: SeoInput): string | null => input.keywords[0] ?? null;

/**
 * What a suggested question or definition should be about: keyword 1, else the site's name on the
 * home page, else the H1 when it is a short name (four words at most). Null when none reads well —
 * the recommendation then gives a generic example.
 */
export function topicOf(input: SeoInput): string | null {
  const kw = primaryKeyword(input);
  if (kw) return kw;
  if (input.kind === "home" && input.site.siteName) return input.site.siteName;
  const h1 = input.content.h1s[0];
  return h1 && h1.split(/\s+/).length <= 4 && !isQuestion(h1) ? h1 : null;
}

/** The editor field for a piece of an entity's SEO, by kind; undefined where the CMS has none (the blog index). */
export function seoField(input: SeoInput, what: "title" | "description" | "ogImage" | "ogTitle" | "ogDescription" | "noindex" | "keywords" | "slug"): string | undefined {
  if (input.kind === "blog-index") return undefined;
  if (what === "slug") return input.isBuiltin ? undefined : "slug";
  if (isArchive(input)) {
    if (what === "ogImage") return "seo.imageMediaId";
    if (what === "ogTitle" || what === "ogDescription") return undefined;
  }
  if (input.kind === "post" && (what === "ogTitle" || what === "ogDescription")) return undefined;
  return `seo.${what}`;
}

/** Where an editor finds an entity's search settings, in words. */
export function seoPlace(input: SeoInput): string {
  switch (input.kind) {
    case "page":
    case "home":
      return "Page settings & SEO";
    case "post":
      return "Address, SEO & author";
    case "category":
      return "the category's Search and sharing settings";
    case "tag":
      return "the tag's Search and sharing settings";
    default:
      return "code (the blog index is not editable in the CMS)";
  }
}

/** The name of the title field in the entity's editor. */
export function titleFieldName(input: SeoInput): string {
  if (input.kind === "page" || input.kind === "home") return "“Title in search results and the browser tab”";
  if (input.kind === "post") return "“Title in search results”";
  return "“Search title”";
}

/** The name of the description field in the entity's editor. */
export function descriptionFieldName(input: SeoInput): string {
  return isArchive(input) ? "“Search description”" : "“Description”";
}

/** The content field for a check about the whole body: the first block, else the document. */
export function bodyField(input: SeoInput): string | undefined {
  const first = input.content.headings.find((h) => h.field?.startsWith("blocks[") || h.field?.startsWith("body["))?.field;
  if (first) return first;
  if (input.kind === "post") return "body";
  if (input.kind === "page" || input.kind === "home") return "blocks";
  if (isArchive(input)) return "description";
  return undefined;
}

/** Every paragraph (FAQ answers included), list item and heading, with the field each came from. */
export function textUnits(input: SeoInput): { text: string; field: string | null }[] {
  const c = input.content;
  return [...c.paragraphs.map((p) => ({ text: p.text, field: p.field })), ...c.lists.flatMap((l) => l.items.map((text) => ({ text, field: l.field }))), ...c.headings.map((h) => ({ text: h.text, field: h.field }))];
}

/** Where the headings break the ladder: an H3 before any H2, or a level skipped (H2 → H4). */
export function headingProblems(input: SeoInput): { field: string | null; message: string }[] {
  const out: { field: string | null; message: string }[] = [];
  let seenH2 = false;
  let previous = 0;
  for (const h of input.content.headings) {
    if (h.level === 2) seenH2 = true;
    if (h.level >= 3 && !seenH2) out.push({ field: h.field, message: `The H${h.level} “${h.text}” comes before any H2.` });
    else if (previous && h.level > previous + 1) out.push({ field: h.field, message: `The H${h.level} “${h.text}” follows an H${previous}, skipping a level.` });
    previous = h.level;
  }
  return out;
}

/** Headings that name no subject: "Overview", "More", "Section 2". */
const VAGUE_HEADINGS: ReadonlySet<string> = new Set([
  "overview",
  "more",
  "introduction",
  "intro",
  "details",
  "info",
  "information",
  "other",
  "others",
  "misc",
  "miscellaneous",
  "summary",
  "conclusion",
  "general",
  "background",
  "notes",
  "content",
  "contents",
  "untitled",
  "more info",
  "more information",
  "read more",
  "learn more",
  "see more",
  "click here",
  "heading",
]);

export function isVagueHeading(text: string): boolean {
  const t = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return VAGUE_HEADINGS.has(t) || /^(section|part|chapter|heading)\s*\d*$/.test(t);
}
