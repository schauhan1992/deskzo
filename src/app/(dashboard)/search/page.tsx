import Link from "next/link";
import { ArrowRight, BookOpen, ExternalLink, FileText, LayoutGrid, PlayCircle, Search } from "lucide-react";
import { requireUser } from "@/lib/session";
import { accessContextFor } from "@/lib/modules-access";
import { buildNavigation } from "@/lib/navigation";
import { getWording } from "@/lib/terms/server";
import { searchEverything } from "@/actions/search";
import { searchableHelp } from "@/actions/help";
import { Card, CardHeader } from "@/components/ui/card";
import {
  SEARCH_MAX_LENGTH,
  SEARCH_MIN_LENGTH,
  SEARCH_PAGE_LIMIT,
  searchListHref,
  searchScope,
} from "@/lib/search/scopes";
import { findHelp, findPages, menuPages } from "@/lib/search/everything";

/**
 * Every result for a search, on one page (owner, 23 Oct 2026) — where the header's box goes on Enter, searching
 * everything. The pages of the menu, a bigger share of every list this person may open (each list searched by its
 * own page's action, src/actions/search.ts), and the help. A list's "See all" opens that list filtered by the text.
 */
export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const { q } = await searchParams;
  const query = typeof q === "string" ? q.trim().slice(0, SEARCH_MAX_LENGTH) : "";
  const searchable = query.length >= SEARCH_MIN_LENGTH;

  const [access, wording, records, help] = await Promise.all([
    accessContextFor(user.id),
    getWording(),
    searchable ? searchEverything(query, SEARCH_PAGE_LIMIT) : Promise.resolve(null),
    searchable ? searchableHelp().catch(() => []) : Promise.resolve([]),
  ]);
  const pages = searchable ? findPages(menuPages(buildNavigation(access), wording), query, 20) : [];
  const groups = records?.ok ? records.groups : [];
  const foundHelp = searchable ? findHelp(help, query, 20) : [];
  const nothing = searchable && pages.length === 0 && groups.length === 0 && foundHelp.length === 0;

  return (
    <div className="animate-fade-rise">
      <h1 className="text-xl font-semibold text-text">Search</h1>
      <p className="mt-1 text-sm text-muted">
        Your lists, the pages of your menu and the help — whatever you are allowed to see.
      </p>

      <form action="/search" className="mt-5 flex max-w-xl items-center gap-2" role="search">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-subtle"
            aria-hidden="true"
          />
          <input
            type="search"
            name="q"
            defaultValue={query}
            maxLength={SEARCH_MAX_LENGTH}
            placeholder="Search everything"
            aria-label="Search everything"
            autoComplete="off"
            className="h-10 w-full rounded-base border border-line bg-surface pr-3 pl-9 text-sm text-text placeholder:text-subtle focus-visible:border-brand"
          />
        </div>
        <button
          type="submit"
          className="h-10 rounded-base bg-brand px-4 text-sm font-medium text-brand-contrast hover:opacity-90"
        >
          Search
        </button>
      </form>

      {!searchable && <p className="mt-6 text-sm text-subtle">Type at least {SEARCH_MIN_LENGTH} letters.</p>}
      {records && !records.ok && <p className="mt-6 text-sm text-danger">{records.error}</p>}
      {nothing && <p className="mt-6 text-sm text-muted">Nothing you can see matches “{query}”.</p>}

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        {pages.length > 0 && (
          <Card>
            <CardHeader className="text-sm font-medium text-text">Pages</CardHeader>
            <ul className="divide-y divide-line">
              {pages.map((p) => (
                <li key={p.href}>
                  <Link href={p.href} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-sunken">
                    <LayoutGrid className="h-4 w-4 shrink-0 text-subtle" aria-hidden="true" />
                    <span className="min-w-0 truncate text-sm text-text">
                      {p.label}
                      <span className="text-subtle"> · {p.group}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {groups.map((g) => (
          <Card key={g.key}>
            <CardHeader className="flex items-center justify-between gap-2 text-sm font-medium text-text">
              <span>{g.label}</span>
              <Link
                href={searchListHref(searchScope(g.key)!, query)}
                className="flex items-center gap-1 text-xs font-medium text-brand hover:underline"
              >
                {g.more ? "See all" : "Open the list"}
                <ArrowRight className="h-3 w-3" aria-hidden="true" />
              </Link>
            </CardHeader>
            <ul className="divide-y divide-line">
              {g.hits.map((h) => (
                <li key={h.id}>
                  <Link href={h.href} className="block px-4 py-2.5 hover:bg-surface-sunken">
                    <span className="block truncate text-sm text-text">{h.title}</span>
                    {h.subtitle && <span className="block truncate text-xs text-subtle">{h.subtitle}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ))}

        {foundHelp.length > 0 && (
          <Card>
            <CardHeader className="text-sm font-medium text-text">Help</CardHeader>
            <ul className="divide-y divide-line">
              {foundHelp.map((h) => {
                const Icon = h.kind === "guide" ? BookOpen : h.kind === "video" ? PlayCircle : FileText;
                return (
                  <li key={h.id}>
                    <a
                      href={h.url}
                      target={h.external ? "_blank" : undefined}
                      rel={h.external ? "noopener noreferrer" : undefined}
                      className="flex items-start gap-3 px-4 py-2.5 hover:bg-surface-sunken"
                    >
                      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block text-sm text-text">
                          {h.title}
                          {h.external && (
                            <ExternalLink className="ml-1 inline h-3 w-3 align-[-1px] text-subtle" aria-hidden="true" />
                          )}
                        </span>
                        {h.summary && <span className="block text-xs text-muted">{h.summary}</span>}
                        <span className="block text-[11px] text-subtle">
                          {h.source === "deskzo" ? "Deskzo" : "Your company"}
                        </span>
                      </span>
                      {h.external && <span className="sr-only"> (opens in a new tab)</span>}
                    </a>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
