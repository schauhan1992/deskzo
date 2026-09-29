import type { SeoInput } from "@/lib/seo/types";
import { sentences, squash, STOPWORDS } from "@/lib/seo/text";
import { textUnits } from "@/lib/seo/checks/util";

/**
 * Figures and claims in an entity's text, for the checks that ask whether a page says specific,
 * sourced things (GEO) and whether a post that cites statistics links to them (SEO). Heuristics,
 * stated as such in every message: a number with a unit, a year or a source is "in context"; a
 * percentage, a money amount or a million/lakh/crore figure is a statistic that wants a source.
 */

export type Figure = {
  /** The figure as written: "40%", "₹1,200", "18". */
  text: string;
  sentence: string;
  field: string | null;
  /** Has a unit, a year or a source with it. */
  context: boolean;
  /** A statistic a reader would want the source of. */
  citeWorthy: boolean;
  /** A source goes with it: a link to another site in the same block, or "according to". */
  cited: boolean;
};

const SOURCE_WORDS = /\b(according to|source[sd]?|survey|study|studies|report|research|census|data from|published by)\b/i;
const MAGNITUDE = /^(million|billion|trillion|lakh|lakhs|crore|crores|thousand)\b/i;
const MONEY_WORDS = /^(rupees?|dollars?|euros?|pounds?|usd|inr|eur|gbp|aed|rs)\b/i;
/** Words before a number that say how much, not what: "over 500", "nearly 40". */
const VAGUE_QUANTIFIERS: ReadonlySet<string> = new Set(["around", "nearly", "almost", "approximately", "roughly", "over", "under", "about", "than", "least", "most", "top", "upto", "plus"]);

/** The block (or field) links to another site. */
const linksOut = (input: SeoInput, field: string | null) => !!field && input.content.links.some((l) => l.field === field && /^https?:/i.test(l.href));

/** Every figure in the content's paragraphs, list items and headings. Years on their own are dates, not figures. */
export function figures(input: SeoInput): Figure[] {
  const out: Figure[] = [];
  for (const unit of textUnits(input)) {
    const outbound = linksOut(input, unit.field);
    for (const sentence of sentences(unit.text)) {
      const hasYear = /\b(19|20)\d{2}\b/.test(sentence);
      const sourced = SOURCE_WORDS.test(sentence);
      for (const m of sentence.matchAll(/([₹$€£]\s?)?(\d[\d,]*(?:\.\d+)?)(\s*(?:%|per ?cent\b))?/gi)) {
        const currency = !!m[1];
        const percent = !!m[3];
        const digits = m[2].replace(/,/g, "");
        const after = squash(sentence.slice((m.index ?? 0) + m[0].length));
        const before = sentence.slice(0, m.index ?? 0);
        // "14-day", "3 days": the word after says what it counts. "Microsoft 365", "clause 9": the word before names it.
        const nextWord = (after.match(/^-?([\p{L}]+)/u)?.[1] ?? "").toLowerCase();
        const prevWord = (before.match(/([\p{L}]+)[\s-]*$/u)?.[1] ?? "").toLowerCase();
        const isYear = !currency && !percent && /^(19|20)\d{2}$/.test(digits);
        if (isYear) continue;
        const magnitude = MAGNITUDE.test(after);
        const money = currency || MONEY_WORDS.test(after);
        const unitWord = !!nextWord && !STOPWORDS.has(nextWord);
        const named = !!prevWord && !STOPWORDS.has(prevWord) && !VAGUE_QUANTIFIERS.has(prevWord);
        const context = percent || money || magnitude || unitWord || named || hasYear || sourced || outbound;
        const citeWorthy = percent || magnitude || /\b(survey|study|studies|research|report)\b/i.test(sentence);
        out.push({ text: squash(m[0]), sentence, field: unit.field, context, citeWorthy, cited: outbound || /\baccording to\b|\bsource:/i.test(sentence) });
      }
    }
  }
  return out;
}

/** Superlatives that claim without proof. "Best practice" and "at best" are not claims. */
const SUPERLATIVE =
  /\b(best|world[- ]class|revolutionary|industry[- ]leading|market[- ]leading|(?:the|a|an) (?:world'?s |industry'?s |market'?s )?leading|unmatched|unparalleled|unrivall?ed|cutting[- ]edge|state[- ]of[- ]the[- ]art|best[- ]in[- ]class|game[- ]chang(?:ing|er)|ultimate|most advanced|top[- ]rated|number one|no\. ?1)\b|(^|\s)#1\b/i;

export type Claim = { term: string; sentence: string; field: string | null };

/** Sentences with a superlative and nothing — no figure, no source, no link out — to back it. */
export function unsupportedClaims(input: SeoInput): Claim[] {
  const out: Claim[] = [];
  for (const unit of textUnits(input)) {
    const outbound = linksOut(input, unit.field);
    for (const sentence of sentences(unit.text)) {
      const cleaned = sentence.replace(/\bbest[- ]practices?\b|\bat best\b/gi, "");
      const m = cleaned.match(SUPERLATIVE);
      if (!m) continue;
      if (/\d/.test(sentence) || SOURCE_WORDS.test(sentence) || outbound) continue;
      out.push({ term: squash(m[0]), sentence, field: unit.field });
    }
  }
  return out;
}
