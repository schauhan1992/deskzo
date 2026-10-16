import type { SettingsItem, SettingsSection } from "@/lib/settings/catalogue";

/**
 * Finding a setting by typing (owner, 16 Oct 2026) — the settings menu and the All settings page ask
 * the same question. Pure, so both can.
 *
 * Every word typed must appear somewhere in the setting: its name, its one-line description, or the
 * group and section it sits under — so "mail" finds Mail & messaging, Support email and Document emails,
 * and "gstin" finds Branches & GST registrations. Case, accents and word endings don't matter ("invoice"
 * finds e-Invoicing). Sections and groups left with nothing are dropped; the order is the catalogue's.
 */

const fold = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();

/** A word's ending left off, so "invoice" finds "invoicing" and "roles" finds "role". Short words are kept whole. */
const stem = (word: string) => (word.length > 4 ? word.replace(/(ing|es|s|e)$/, "") : word);

/** The words of a search, folded and stemmed. Empty when there is nothing to search for. */
export function searchWords(term: string): string[] {
  return fold(term)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(stem);
}

/** Whether a setting answers every word, given what it sits under. */
export function settingMatches(item: SettingsItem, words: string[], under: string[] = []): boolean {
  if (words.length === 0) return true;
  const text = fold([item.label, item.description, ...under].join(" "));
  return words.every((w) => text.includes(w));
}

/** The settings that answer a search, in their sections and groups. Everything, for an empty one. */
export function searchSettings(sections: SettingsSection[], term: string): SettingsSection[] {
  const words = searchWords(term);
  if (words.length === 0) return sections;
  return sections
    .map((section) => ({
      ...section,
      groups: section.groups
        .map((group) => ({ ...group, items: group.items.filter((item) => settingMatches(item, words, [group.label, section.label])) }))
        .filter((group) => group.items.length > 0),
    }))
    .filter((section) => section.groups.length > 0);
}

/** The first setting a search finds — where Enter goes. */
export function firstMatch(sections: SettingsSection[]): SettingsItem | null {
  return sections[0]?.groups[0]?.items[0] ?? null;
}
