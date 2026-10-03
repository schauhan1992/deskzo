import { indiaClock } from "@/lib/time/zone";

/**
 * Text measures the checks share: words, phrases, sentences, questions. Every comparison runs on the
 * same tokens — lower-case runs of letters and digits in any script — so "GST-ready", "gst ready"
 * and "GST ready" are one phrase, and a keyword matches on word boundaries only ("art" is not in
 * "start"). Pure; no state.
 */

/** Lower-case words: runs of letters and digits, in any script. */
export function tokenize(text: string | null | undefined): string[] {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

export const countWords = (text: string | null | undefined): number => tokenize(text).length;

/** Collapses runs of whitespace and trims. */
export const squash = (text: string | null | undefined): string => String(text ?? "").replace(/\s+/g, " ").trim();

/** Where `needle` (a phrase's tokens) starts in `hay`, every time. */
export function phrasePositions(hay: readonly string[], needle: readonly string[]): number[] {
  const out: number[] = [];
  if (!needle.length || needle.length > hay.length) return out;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) out.push(i);
  }
  return out;
}

export const countPhrase = (hay: readonly string[], needle: readonly string[]): number => phrasePositions(hay, needle).length;

/** Whether the phrase is in the text, on word boundaries, whatever the case. */
export const hasPhrase = (text: string | null | undefined, phrase: string): boolean => {
  const needle = tokenize(phrase);
  return needle.length > 0 && countPhrase(tokenize(text), needle) > 0;
};

/** Words that carry no topic of their own. */
export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    "a an and are as at be been being but by can could did do does for from had has have he her his how i if in into is it its " +
    "me more most my no not of on or our ours out over own s so some such t than that the their them then there these they this " +
    "those through to too up us very was we were what when where which while who why will with would you your yours about after " +
    "all also any because before between both each few just like may might much must new now off once only other same should " +
    "since still under until upon via way well whether yet get got every one two per"
  ).split(" "),
);

/** A word's plural folded to its singular, roughly: "companies" → "company", "invoices" → "invoice". For comparing topics, never keywords. */
export function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** A text's topic words, plurals folded: not stopwords, at least three letters (or a number). */
export function significantWords(text: string | null | undefined): Set<string> {
  return new Set(
    tokenize(text)
      .filter((w) => !STOPWORDS.has(w) && (w.length >= 3 || /^\p{N}+$/u.test(w)))
      .map(stem),
  );
}

/** How many topic words two texts share. */
export function sharedWords(a: string | null | undefined, b: string | null | undefined): number {
  const left = significantWords(a);
  let n = 0;
  for (const w of significantWords(b)) if (left.has(w)) n += 1;
  return n;
}

/** A text's sentences — split after ".", "!" or "?" followed by a space or the end. A heuristic: "e.g." splits too. */
export function sentences(text: string | null | undefined): string[] {
  return String(text ?? "")
    .split(/[.!?]+(?:\s+|$)/)
    .map((s) => s.trim())
    .filter((s) => countWords(s) > 0);
}

/** A heading shaped as a question: it ends in "?", or opens with how, what, why, when, where, which or who. */
export function isQuestion(text: string | null | undefined): boolean {
  const t = squash(text);
  if (!t) return false;
  if (t.endsWith("?")) return true;
  return /^(how|what|why|when|where|which|who)\b/i.test(t);
}

/** “Quoted”, cut to `max` characters with an ellipsis. */
export function quote(text: string | null | undefined, max = 70): string {
  const t = squash(text);
  const cut = t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
  return `“${cut}”`;
}

/** "1 word", "12 words" and the like. */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * A date as India's calendar has it, "2026-09-29" — independent of the host's time zone. India's, as
 * the public site dates its posts (src/lib/seo/schema.ts `shownUpdatedAt`).
 */
export function istDay(date: Date): string {
  return indiaClock.dateKey(date);
}

/** Whole months from `from` to `to` (30.44-day months), never negative. */
export function monthsBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / (30.44 * 24 * 3600 * 1000)));
}

/** Rounds to two decimals. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A share of `weight`, rounded down to a half point and kept within 0…weight. */
export function share(weight: number, fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  const f = Math.min(1, Math.max(0, fraction));
  return Math.floor(weight * f * 2) / 2;
}
