import type { KeywordAnalysis, SeoInput } from "@/lib/seo/types";
import { countPhrase, round2, squash, tokenize } from "@/lib/seo/text";

/**
 * Primary keywords: up to three per page, post and archive, kept in the entity's own SEO object
 * (`seo.keywords`). Keyword 1 is the one the page is about; 2 and 3 support it. They drive placement
 * analysis only — the `<meta name="keywords">` tag they also produce is worth no points anywhere.
 *
 * Matching is on whole words, whatever the case: "GST invoice" is found in "a gst invoice" and in
 * "GST-invoice", not in "GST invoices" (no stemming). Two keywords are the same keyword when their
 * words are.
 */

export const MAX_KEYWORDS = 3;
/** The longest keyword the CMS should accept. */
export const KEYWORD_MAX_LENGTH = 80;
/** A keyword taking more than this share of the words (percent), at least `STUFFING_MIN_OCCURRENCES` times, is stuffed. */
export const STUFFING_DENSITY = 3;
export const STUFFING_MIN_OCCURRENCES = 4;

/** Keywords as stored: strings trimmed, inner whitespace collapsed, blanks dropped, at most three. A string is read as a comma-separated list. */
export function normaliseKeywords(raw: unknown): string[] {
  const list: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const keyword = squash(item);
    if (!keyword) continue;
    out.push(keyword);
    if (out.length === MAX_KEYWORDS) break;
  }
  return out;
}

/** What two keywords are compared by: their words, lower-case. */
export const keywordKey = (keyword: string): string => tokenize(keyword).join(" ");

/** The keywords with repeats dropped (the first kept), compared case-insensitively on their words. */
export function uniqueKeywords(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of list) {
    const key = keywordKey(k);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

/**
 * What is wrong with a list of keywords as an editor holds it (blank slots are fine): a repeat of an
 * earlier one (compared case-insensitively, on its words), more than three, too long, or no word at
 * all. `index` is the slot, from 0 — for a field-level message.
 */
export function keywordProblems(list: readonly unknown[]): { index: number; message: string }[] {
  const out: { index: number; message: string }[] = [];
  const seen = new Map<string, number>();
  let filled = 0;
  list.forEach((raw, index) => {
    const keyword = typeof raw === "string" ? squash(raw) : "";
    if (!keyword) return;
    filled += 1;
    if (filled > MAX_KEYWORDS) {
      out.push({ index, message: `At most ${MAX_KEYWORDS} primary keywords.` });
      return;
    }
    if (keyword.length > KEYWORD_MAX_LENGTH) {
      out.push({ index, message: `Keep a keyword to ${KEYWORD_MAX_LENGTH} characters.` });
      return;
    }
    // The keywords meta joins them with commas, so a comma inside one would read as two keywords.
    if (keyword.includes(",")) {
      out.push({ index, message: "A keyword can't contain a comma — put each keyword in its own box." });
      return;
    }
    const key = keywordKey(keyword);
    if (!key) {
      out.push({ index, message: "A keyword needs a letter or a digit." });
      return;
    }
    const first = seen.get(key);
    if (first !== undefined) out.push({ index, message: `“${keyword}” repeats keyword ${first + 1}.` });
    else seen.set(key, index);
  });
  return out;
}

/** The content under the headings: paragraphs, list items, table cells, FAQ questions and answers. */
function bodyTokens(input: SeoInput): string[] {
  const c = input.content;
  return tokenize([...c.paragraphs.map((p) => p.text), ...c.lists.flatMap((l) => l.items), ...c.tables.map((t) => t.text), ...c.faqs.flatMap((f) => [f.question, f.answer])].join("\n"));
}

/** Where one keyword appears, how often, and what share of the words it takes. */
export function analyseKeyword(input: SeoInput, keyword: string): KeywordAnalysis {
  const needle = tokenize(keyword);
  const c = input.content;
  const inText = (text: string) => needle.length > 0 && countPhrase(tokenize(text), needle) > 0;
  const occurrences = needle.length ? countPhrase(tokenize(c.text), needle) : 0;
  return {
    keyword,
    inTitle: inText(input.meta.title),
    inDescription: inText(input.meta.description),
    inUrl: needle.length > 0 && countPhrase(tokenize(input.slug), needle) > 0,
    inH1: c.h1s.some(inText),
    inFirstSection: inText(c.firstSection),
    inBody: needle.length > 0 && countPhrase(bodyTokens(input), needle) > 0,
    inImageAlt: c.images.some((img) => inText(img.alt)),
    inHeadings: c.headings.some((h) => h.level > 1 && inText(h.text)),
    occurrences,
    density: c.wordCount > 0 ? round2(((occurrences * needle.length) / c.wordCount) * 100) : 0,
  };
}

/** Every distinct keyword's analysis, keyword 1 first. */
export function analyseKeywords(input: SeoInput): KeywordAnalysis[] {
  return uniqueKeywords(input.keywords).map((k) => analyseKeyword(input, k));
}

/** A keyword repeated past a natural rate: its density, or said twice in the title. */
export function stuffedKeywords(input: SeoInput): { keyword: string; reason: string }[] {
  const out: { keyword: string; reason: string }[] = [];
  for (const a of analyseKeywords(input)) {
    const inTitle = countPhrase(tokenize(input.meta.rawTitle), tokenize(a.keyword));
    if (inTitle >= 2) out.push({ keyword: a.keyword, reason: `it is in the title ${inTitle} times` });
    else if (a.density > STUFFING_DENSITY && a.occurrences >= STUFFING_MIN_OCCURRENCES) out.push({ keyword: a.keyword, reason: `it appears ${a.occurrences} times, ${a.density}% of the words` });
  }
  return out;
}
