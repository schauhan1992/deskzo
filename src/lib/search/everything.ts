import { DASHBOARD_HREF, type VisibleNavSection } from "@/lib/navigation";
import { slot, type Wording } from "@/lib/terms/dictionary";

/**
 * Searching everything — the pages of a person's menu and the help — matched as text, the same in the header's box
 * and on the full results page. Pure: the records are searched on the server, each list by its own action
 * (src/actions/search.ts searchEverything).
 */

/** A page of the menu, as the search offers it: "Attendance" in People (HR). */
export type SearchPage = { href: string; label: string; group: string };

/** How many pages, and how many pieces of help, the box shows. */
export const SEARCH_PAGES_LIMIT = 5;
export const SEARCH_HELP_LIMIT = 4;

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Every word of the query starts a word somewhere in the text — "att" finds Attendance, "my hr" finds My HR. */
export function matchesQuery(text: string, query: string): boolean {
  const wanted = words(query);
  if (wanted.length === 0) return false;
  const have = words(text);
  return wanted.every((w) => have.some((h) => h.startsWith(w)));
}

/** The menu's pages, in the workspace's own words (Settings → Wording), with the dashboard. */
export function menuPages(navigation: readonly VisibleNavSection[], wording: Wording): SearchPage[] {
  return [
    { href: DASHBOARD_HREF, label: "Dashboard", group: "Home" },
    ...navigation.flatMap(({ group, items }) =>
      items.map((i) => ({
        href: i.href,
        label: i.term ? slot(wording, i.label, i.term.key, i.term.template) : i.label,
        group,
      })),
    ),
  ];
}

/** The pages a query finds: by name first, then by section ("people" finds every People page). */
export function findPages(pages: readonly SearchPage[], query: string, limit = SEARCH_PAGES_LIMIT): SearchPage[] {
  const byName = pages.filter((p) => matchesQuery(p.label, query));
  const bySection = pages.filter((p) => !byName.includes(p) && matchesQuery(`${p.group} ${p.label}`, query));
  return [...byName, ...bySection].slice(0, limit);
}

/** The help a query finds: by title first, then by summary and the guide's own words. */
export function findHelp<T extends { title: string; summary: string | null; words: string }>(
  help: readonly T[],
  query: string,
  limit = SEARCH_HELP_LIMIT,
): T[] {
  const byTitle = help.filter((h) => matchesQuery(h.title, query));
  const byText = help.filter(
    (h) => !byTitle.includes(h) && matchesQuery(`${h.title} ${h.summary ?? ""} ${h.words}`, query),
  );
  return [...byTitle, ...byText].slice(0, limit);
}
