"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, FileText, Mail, Phone, PlayCircle, Search } from "lucide-react";
import { listHelpLinks, listUpdates, type HelpLinkView, type UpdateView } from "@/actions/help";
import { getSupportContact } from "@/actions/support";
import type { SupportContact } from "@/lib/support/types";
import { RecentUpdates } from "@/components/help/recent-updates";
import { Input } from "@/components/ui/input";

/**
 * The rail's three help panels: What's new, Help, and Videos. Each is fetched when opened rather
 * than shipped with every page, like the rest of the rail.
 */

function useLoad<T>(load: () => Promise<T>, failure: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    load()
      .then((result) => live && setData(result))
      .catch(() => live && setError(failure));
    return () => {
      live = false;
    };
    // Loaded once per opening of the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { data, error };
}

function Loading({ error }: { error: string | null }) {
  return <p className="py-6 text-center text-xs text-muted">{error ?? "Loading…"}</p>;
}

export function RailUpdates({ canManage }: { canManage: boolean }) {
  const { data, error } = useLoad<UpdateView[]>(() => listUpdates(20), "Could not load What's new.");
  if (!data) return <Loading error={error} />;
  return (
    <div className="space-y-3">
      <RecentUpdates posts={data} canManage={canManage} compact />
      {data.length > 0 && (
        <Link href="/dashboard?tab=updates" className="block text-center text-xs font-medium text-brand hover:underline">
          Open Recent Updates
        </Link>
      )}
    </div>
  );
}

export function RailHelp({ canManage }: { canManage: boolean }) {
  const { data, error } = useLoad<{ desk: SupportContact | null; articles: HelpLinkView[] }>(
    async () => {
      const [desk, articles] = await Promise.all([getSupportContact(), listHelpLinks("ARTICLE")]);
      return { desk, articles };
    },
    "Could not load help.",
  );
  const [filter, setFilter] = useState("");
  if (!data) return <Loading error={error} />;

  const needle = filter.trim().toLowerCase();
  const articles = needle
    ? data.articles.filter((a) => `${a.title} ${a.description ?? ""}`.toLowerCase().includes(needle))
    : data.articles;

  return (
    <div className="space-y-4">
      {data.desk && (
        <div className="rounded-lg border border-line bg-surface-sunken p-3 text-xs text-muted">
          <p className="font-medium text-text">{data.desk.label ?? "Need a hand?"}</p>
          {data.desk.phone && (
            <a href={`tel:${data.desk.phone.replace(/[^\d+]/g, "")}`} className="mt-1.5 flex items-center gap-1.5 text-sm font-semibold text-text hover:underline">
              <Phone className="h-3.5 w-3.5 text-brand" aria-hidden="true" />
              {data.desk.phone}
            </a>
          )}
          {data.desk.hours && <p className="mt-1">{data.desk.hours}</p>}
          {data.desk.languages && <p>{data.desk.languages}</p>}
          {data.desk.email && (
            <a href={`mailto:${data.desk.email}`} className="mt-1.5 flex items-center gap-1.5 hover:text-text hover:underline">
              <Mail className="h-3.5 w-3.5" aria-hidden="true" />
              {data.desk.email}
            </a>
          )}
        </div>
      )}

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">Help articles</h3>
        {data.articles.length > 5 && (
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" aria-hidden="true" />
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find an article" aria-label="Find an article" className="pl-8" />
          </div>
        )}
        {data.articles.length === 0 ? (
          <p className="text-xs text-muted">
            No help articles yet.
            {canManage && (
              <>
                {" "}
                <Link href="/settings/help" className="font-medium text-brand hover:underline">
                  Add some
                </Link>
              </>
            )}
          </p>
        ) : articles.length === 0 ? (
          <p className="text-xs text-muted">Nothing matches “{filter.trim()}”.</p>
        ) : (
          <ul className="space-y-1">
            {articles.map((a) => (
              <li key={a.id}>
                <HelpAnchor link={a} className="flex items-start gap-2 rounded-base px-2 py-1.5 hover:bg-surface-sunken">
                  <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block text-sm text-text">
                      {a.title}
                      {a.external && <ExternalLink className="ml-1 inline h-3 w-3 align-[-1px] text-subtle" aria-hidden="true" />}
                    </span>
                    {a.description && <span className="block text-xs text-muted">{a.description}</span>}
                  </span>
                </HelpAnchor>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-xs text-subtle">
        Press <kbd className="rounded border border-line bg-surface-sunken px-1 font-mono text-[11px]">/</kbd> on any page to search.
      </p>
    </div>
  );
}

export function RailVideos({ canManage }: { canManage: boolean }) {
  const { data, error } = useLoad<HelpLinkView[]>(() => listHelpLinks("VIDEO"), "Could not load the videos.");
  if (!data) return <Loading error={error} />;
  if (data.length === 0) {
    return (
      <p className="py-6 text-center text-xs text-muted">
        No walkthrough videos yet.
        {canManage && (
          <>
            {" "}
            <Link href="/settings/help" className="font-medium text-brand hover:underline">
              Add one
            </Link>
          </>
        )}
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {data.map((v) => (
        <li key={v.id}>
          <HelpAnchor link={v} className="group block">
            <span className="relative block aspect-video overflow-hidden rounded-lg border border-line bg-surface-sunken">
              {v.youtubeId ? (
                // YouTube's own still, fetched without saying which page asked for it. Videos always
                // open on YouTube: an embedded player would load its tracking on every rail opening.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`https://i.ytimg.com/vi/${v.youtubeId}/mqdefault.jpg`}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]"
                />
              ) : null}
              <span className="absolute inset-0 grid place-items-center bg-black/10 group-hover:bg-black/20">
                <PlayCircle className="h-9 w-9 text-white drop-shadow" aria-hidden="true" />
              </span>
            </span>
            <span className="mt-1.5 block text-sm font-medium text-text group-hover:underline">{v.title}</span>
            {v.description && <span className="block text-xs text-muted">{v.description}</span>}
          </HelpAnchor>
        </li>
      ))}
    </ul>
  );
}

/** An in-app path opens here; anything else opens in a new tab, with no referrer and no opener. */
function HelpAnchor({ link, className, children }: { link: HelpLinkView; className: string; children: React.ReactNode }) {
  if (!link.external) {
    return (
      <Link href={link.url} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <a href={link.url} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
