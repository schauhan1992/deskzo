"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, BookOpen, Search } from "lucide-react";

/** One group of the Help Center's index: a product (with its page), the modules every product has, or an add-on. */
export type HelpIndexGroup = {
  key: string;
  title: string;
  tagline: string | null;
  path: string | null;
  guides: { slug: string; path: string; module: string; title: string; summary: string; words: string }[];
};

/**
 * The Help Center's guides, grouped, with a search over their titles, summaries, tasks and questions.
 * While a search is typed the groups give way to one list of what matches — each guide once, however
 * many products include it. Everything is on the page already: nothing is fetched as you type.
 */
export function HelpSearch({ groups, searchLabel, emptyText }: { groups: HelpIndexGroup[]; searchLabel: string; emptyText: string }) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!needle) return [];
    const seen = new Set<string>();
    const words = needle.split(/\s+/).filter(Boolean);
    return groups
      .flatMap((g) => g.guides)
      .filter((g) => {
        if (seen.has(g.slug)) return false;
        seen.add(g.slug);
        const hay = `${g.title} ${g.summary} ${g.words}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => Number(!a.title.toLowerCase().includes(needle)) - Number(!b.title.toLowerCase().includes(needle)) || a.title.localeCompare(b.title));
  }, [groups, needle]);

  if (groups.length === 0) return <p className="mx-auto max-w-2xl rounded-xl border border-line bg-surface-sunken px-5 py-6 text-center text-base text-muted">{emptyText}</p>;

  return (
    <div>
      <div className="relative mx-auto max-w-2xl">
        <Search aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={searchLabel}
          aria-label={searchLabel}
          className="h-12 w-full rounded-xl border border-line-strong bg-surface pl-11 pr-4 text-base text-text placeholder:text-subtle focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
        />
      </div>

      {needle ? (
        <div className="mx-auto mt-8 max-w-3xl" aria-live="polite">
          {matches.length === 0 ? (
            <p className="text-center text-base text-muted">No guide matches “{query.trim()}”.</p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {matches.map((g) => (
                <li key={g.slug}>
                  <GuideLink guide={g} />
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="mt-12 space-y-12">
          {groups.map((group) => (
            <section key={group.key} aria-labelledby={`help-group-${group.key}`}>
              <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1 border-b border-line pb-3">
                <div>
                  <h2 id={`help-group-${group.key}`} className="text-xl font-semibold tracking-tight text-text">
                    {group.title}
                  </h2>
                  {group.tagline && <p className="mt-1 text-sm text-muted">{group.tagline}</p>}
                </div>
                {group.path && (
                  <Link href={group.path} className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">
                    About {group.title}
                    <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
                  </Link>
                )}
              </div>
              <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {group.guides.map((g) => (
                  <li key={g.slug}>
                    <GuideLink guide={g} card />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function GuideLink({ guide, card = false }: { guide: HelpIndexGroup["guides"][number]; card?: boolean }) {
  return (
    <Link href={guide.path} className={card ? "flex h-full gap-3 rounded-xl border border-line p-4 hover:border-brand/40 hover:bg-surface-sunken" : "flex gap-3 px-4 py-3 hover:bg-surface-sunken"}>
      <BookOpen aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-text">{guide.title}</span>
        {guide.summary && <span className="mt-1 block text-sm leading-6 text-muted">{guide.summary}</span>}
      </span>
    </Link>
  );
}
