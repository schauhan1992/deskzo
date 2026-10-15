/**
 * Finding the words a workspace keeps out of chat and tickets (owner, 15 Oct 2026) — pure, so the
 * settings page can show what a sample message would do as the admin types, and the checks need no
 * database.
 *
 * An entry is a word or a phrase, matched as a whole word, whatever the case:
 *
 *   · "fuck" catches FUCK, f*ck, f**k, fuuuck, f.u.c.k and f u c k: its own letters, each repeatable,
 *     the usual stand-ins (@ or 4 for a, 3 for e, 1 or ! for i, 0 for o, $ or 5 for s), and a * for
 *     any letter but the first and last. Another spelling is another entry.
 *   · It never catches part of another word: "ass" leaves class, assess and passage alone.
 *   · "fuck*" — a trailing star — catches its endings too: fucking, fucker.
 *   · Hindi in Devanagari is matched as written, nukta and chandrabindu aside (ड़ is ड, ँ is ं).
 */

/** What a letter may be typed as. */
const STAND_INS: Record<string, string> = { a: "@4", b: "8", e: "3", g: "9", i: "1!|", l: "1|", o: "0", s: "$5", t: "7+", z: "2" };

/** A word's own characters: letters, their marks, digits. Anything else ends a word. */
const WORD_CHAR = "[\\p{L}\\p{M}\\p{N}]";
/** What may sit between two letters of a disguised word: up to two dots, dashes, underscores or spaces. */
const BETWEEN = "[\\s._\\-]{0,2}";
/** Between the words of a phrase. */
const PHRASE_GAP = "[\\s._*\\-]+";

/** One character as matching compares it — the same for an entry and for the text it is looked for in. */
function fold(char: string): string {
  return char
    .normalize("NFD")
    .replace(/[̀-़ͯ‌‍]/g, "")
    .replace(/ँ/g, "ं")
    .toLowerCase();
}

/** A text as matching compares it, with where each of its characters came from in the original. */
function folded(text: string): { text: string; from: number[] } {
  let out = "";
  const from: number[] = [];
  for (let i = 0; i < text.length; ) {
    const char = String.fromCodePoint(text.codePointAt(i)!);
    const piece = fold(char);
    for (let k = 0; k < piece.length; k++) from.push(i);
    out += piece;
    i += char.length;
  }
  from.push(text.length);
  return { text: out, from };
}

/** An entry as it is compared — folded, its spaces single — for de-duplicating and the allow list. */
export function entryKey(entry: string): string {
  return folded(entry.trim().replace(/\s+/g, " ")).text;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
const escapeClass = (s: string) => s.replace(/[\\\]^-]/g, "\\$&");
const isLatin = (c: string) => c >= "a" && c <= "z";

/** One entry as a pattern, or null for one with nothing to match. */
function entryPattern(entry: string): string | null {
  const stem = /\*\s*$/.test(entry);
  const word = entryKey(entry.replace(/\*+\s*$/, ""));
  if (!word || word.replace(/\s/g, "").length === 0) return null;
  const chars = Array.from(word);
  const parts: string[] = [];
  chars.forEach((c, i) => {
    if (/\s/.test(c)) {
      parts.push(PHRASE_GAP);
      return;
    }
    if (!isLatin(c)) {
      parts.push(escapeRegex(c));
      return;
    }
    const inner = i > 0 && i < chars.length - 1 && isLatin(chars[i - 1]!) && isLatin(chars[i + 1]!);
    parts.push(`[${escapeClass(c + (STAND_INS[c] ?? "") + (inner ? "*" : ""))}]+`);
    if (i < chars.length - 1 && isLatin(chars[i + 1]!)) parts.push(BETWEEN);
  });
  return `(?<!${WORD_CHAR})(?:${parts.join("")})${stem ? "[\\p{L}\\p{M}]*" : ""}(?!${WORD_CHAR})`;
}

export type WordFilter = {
  /** The words of `text` the filter catches, as they were typed, each once. */
  find(text: string): string[];
  /** `text` with every word the filter catches turned into stars. */
  mask(text: string): string;
};

const NOTHING: WordFilter = { find: () => [], mask: (text) => text };

/** A filter for these entries, leaving out any in `allowed` (compared as typed, folded). */
export function compileWordFilter(entries: readonly string[], allowed: readonly string[] = []): WordFilter {
  const skip = new Set(allowed.map(entryKey).filter(Boolean));
  const seen = new Set<string>();
  const patterns: string[] = [];
  for (const entry of entries) {
    const key = entryKey(entry);
    if (!key || skip.has(key) || skip.has(entryKey(entry.replace(/\*+\s*$/, ""))) || seen.has(key)) continue;
    seen.add(key);
    const pattern = entryPattern(entry);
    if (pattern) patterns.push(pattern);
  }
  if (patterns.length === 0) return NOTHING;
  const source = patterns.join("|");

  const matches = (text: string) => {
    const { text: plain, from } = folded(text);
    const found: { start: number; end: number }[] = [];
    for (const m of plain.matchAll(new RegExp(source, "gu"))) {
      if (!m[0]) continue;
      const start = from[m.index!]!;
      // The original character after the last one matched — a folded character can stand for part of one.
      let endAt = m.index! + m[0].length;
      while (endAt < from.length - 1 && from[endAt] === from[endAt - 1]) endAt++;
      found.push({ start, end: from[endAt]! });
    }
    return found;
  };

  return {
    find(text) {
      return [...new Set(matches(text).map((m) => text.slice(m.start, m.end).trim()))];
    },
    mask(text) {
      let out = "";
      let at = 0;
      for (const m of matches(text)) {
        out += text.slice(at, m.start) + "*".repeat(Array.from(text.slice(m.start, m.end)).length);
        at = m.end;
      }
      return out + text.slice(at);
    },
  };
}

/** The most entries a list keeps, and the longest an entry may be. */
export const WORD_LIST_MAX = 500;
export const WORD_MAX_LENGTH = 60;

/** A typed list cleaned up: one entry a line (or comma), trimmed, de-duplicated — or why it can't be kept. */
export function cleanWordList(raw: readonly string[]): { ok: true; words: string[] } | { ok: false; error: string } {
  const words: string[] = [];
  const keys = new Set<string>();
  for (const line of raw.flatMap((r) => r.split(/[\n,]/))) {
    const word = line.trim().replace(/\s+/g, " ");
    if (!word) continue;
    if (Array.from(word).length > WORD_MAX_LENGTH) return { ok: false, error: `"${word.slice(0, 20)}…" is longer than ${WORD_MAX_LENGTH} characters — a filter word is a word or a short phrase.` };
    if (!/[\p{L}]/u.test(word)) return { ok: false, error: `"${word}" has no letters in it.` };
    const key = entryKey(word);
    if (keys.has(key)) continue;
    keys.add(key);
    words.push(word);
  }
  if (words.length > WORD_LIST_MAX) return { ok: false, error: `A list can hold up to ${WORD_LIST_MAX} words — this one has ${words.length}.` };
  return { ok: true, words };
}
