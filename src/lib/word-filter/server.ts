import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { compileWordFilter, type WordFilter } from "@/lib/word-filter/match";
import { PRESET_WORDS } from "@/lib/word-filter/preset";

/**
 * The workspace's word filters (owner, 15 Oct 2026): what chat and tickets each keep out, and the one
 * check every place that takes their text asks. Server only.
 *
 *   · Chat — a message (sent or edited) or a group's name with a filtered word isn't sent; only the
 *     sender is told, which words, and nothing is recorded.
 *   · Tickets — the same for what the workspace's own people write: a new ticket, a comment, an email
 *     reply. A customer's email is let in with the words turned into stars.
 */

export type FilterArea = "CHAT" | "TICKETS";
export const FILTER_AREAS: readonly FilterArea[] = ["CHAT", "TICKETS"];

export type WordFilterSettings = { enabled: boolean; usePreset: boolean; words: string[]; allowed: string[] };
export const WORD_FILTER_DEFAULTS: WordFilterSettings = { enabled: false, usePreset: true, words: [], allowed: [] };

/** An area's settings — the defaults (off) where none are saved, or the table isn't there yet. */
export async function wordFilterSettings(area: FilterArea): Promise<WordFilterSettings> {
  try {
    const row = await db.wordFilter.findUnique({ where: { area } });
    return row ? { enabled: row.enabled, usePreset: row.usePreset, words: row.words, allowed: row.allowed } : { ...WORD_FILTER_DEFAULTS };
  } catch (err) {
    if (notMigratedYet(err)) return { ...WORD_FILTER_DEFAULTS };
    throw err;
  }
}

/** The filter these settings describe — the preset, when on, and the workspace's own words. */
export function filterFor(settings: WordFilterSettings): WordFilter {
  return compileWordFilter([...(settings.usePreset ? PRESET_WORDS : []), ...settings.words], settings.allowed);
}

/** An area's filter, or null while it is off. */
export async function activeWordFilter(area: FilterArea): Promise<WordFilter | null> {
  const settings = await wordFilterSettings(area);
  return settings.enabled ? filterFor(settings) : null;
}

/** Why this text can't be sent — the words it has that `area` keeps out — or null when it may go. */
export async function filteredWordsRefusal(area: FilterArea, texts: readonly (string | null | undefined)[]): Promise<string | null> {
  const filter = await activeWordFilter(area);
  if (!filter) return null;
  const found = [...new Set(texts.flatMap((t) => (t ? filter.find(t) : [])))];
  if (found.length === 0) return null;
  const listed = found.slice(0, 5).map((w) => `"${w}"`).join(", ");
  const where = area === "CHAT" ? "in chat" : "in tickets";
  return `Your company doesn't allow ${found.length === 1 ? "this word" : "these words"} ${where}: ${listed}${found.length > 5 ? "…" : ""}. Change ${found.length === 1 ? "it" : "them"} and send it again.`;
}
