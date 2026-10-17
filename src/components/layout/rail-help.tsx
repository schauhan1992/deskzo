"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, ExternalLink, FileText, Mail, Phone, PlayCircle, Search } from "lucide-react";
import { deskzoGuides, deskzoHelpLinks, deskzoUpdates, listHelpLinks, listUpdates, type DeskzoFeed, type DeskzoGuidesView, type DeskzoLinks, type HelpLinkView, type UpdateView } from "@/actions/help";
import { getSupportContact } from "@/actions/support";
import type { SupportContact } from "@/lib/support/types";
import { RecentUpdates } from "@/components/help/recent-updates";
import { Input } from "@/components/ui/input";
import { OutboundLink } from "@/components/ui/outbound-link";

/** One of Deskzo's guides, as the panel is given it. */
type DeskzoGuide = DeskzoGuidesView["guides"][number];

/**
 * The rail's three help panels: What's new, Help, and Videos. Each is fetched when opened rather
 * than shipped with every page, like the rest of the rail.
 *
 * Every panel holds two groups, always apart (owner, 2 Oct 2026): "From Deskzo" first — the help,
 * walkthroughs and release notes Deskzo publishes for every workspace, read-only here — then the
 * company's own guides and news. Each group has its own heading and its own empty state, and only the
 * company's ever offers to add anything, and only to somebody who may (`help.manage`). Deskzo's side
 * failing to load is said in its own group and never hides the company's.
 *
 * The Help panel's Deskzo group also offers the Help Center's guide to the module the page belongs to
 * (src/lib/help/guides.ts moduleForPath), and the guides a search finds — each a link to the guide on
 * the public website, for the modules in the workspace's plan. They are Deskzo's, so they are only
 * ever in Deskzo's group.
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

/** What an action that threw is shown as on Deskzo's side: couldn't be read, like a control plane that is down. */
const DESKZO_LINKS_FAILED: DeskzoLinks = { ok: false, links: [] };
const DESKZO_FEED_FAILED: DeskzoFeed = { ok: false, posts: [] };

export function RailUpdates({ canManage }: { canManage: boolean }) {
  const { data, error } = useLoad<{ deskzo: DeskzoFeed; company: UpdateView[] }>(
    async () => {
      const [deskzo, company] = await Promise.all([deskzoUpdates(20).catch(() => DESKZO_FEED_FAILED), listUpdates(20)]);
      return { deskzo, company };
    },
    "Could not load What's new.",
  );
  if (!data) return <Loading error={error} />;
  return (
    <div className="space-y-4">
      <RecentUpdates deskzo={data.deskzo} company={data.company} canManage={canManage} compact />
      {(data.deskzo.posts.length > 0 || data.company.length > 0) && (
        <Link href="/dashboard?tab=updates" className="block text-center text-xs font-medium text-brand hover:underline">
          Open Recent Updates
        </Link>
      )}
    </div>
  );
}

/**
 * `guides`: Deskzo's guides to its modules — the one for this page, and every one the plan has, for the
 * search — all of them Deskzo's, shown in Deskzo's group only. Left out (as older check suites render
 * the panel), the group shows Deskzo's articles alone.
 */
type HelpPanelData = { desk: SupportContact | null; deskzo: DeskzoLinks; company: HelpLinkView[]; guides?: DeskzoGuidesView | null };

/** Who the company's group is from: its name, when the layout knows it — "your company" otherwise. */
type CompanyNamed = { canManage: boolean; companyName?: string | null };

const DESKZO_GUIDES_FAILED: DeskzoGuidesView = { ok: false, current: null, guides: [], helpCenterUrl: "" };

export function RailHelp({ canManage, companyName }: CompanyNamed) {
  const pathname = usePathname();
  const { data, error } = useLoad<Omit<HelpPanelData, "guides">>(
    async () => {
      const [desk, deskzo, company] = await Promise.all([getSupportContact(), deskzoHelpLinks("ARTICLE").catch(() => DESKZO_LINKS_FAILED), listHelpLinks("ARTICLE")]);
      return { desk, deskzo, company };
    },
    "Could not load help.",
  );
  // The guide for this page follows the page: asked again when the address changes with the panel open.
  const [guides, setGuides] = useState<{ path: string; view: DeskzoGuidesView } | null>(null);
  useEffect(() => {
    let live = true;
    deskzoGuides(pathname)
      .catch(() => DESKZO_GUIDES_FAILED)
      .then((view) => live && setGuides({ path: pathname, view }));
    return () => {
      live = false;
    };
  }, [pathname]);
  if (!data) return <Loading error={error} />;
  return <RailHelpView {...data} guides={guides?.path === pathname ? guides.view : null} canManage={canManage} companyName={companyName} />;
}

/** The Help panel once loaded: the support contact, Deskzo's guides and articles, then the company's. Pure, so check suites render it. */
export function RailHelpView({ desk, deskzo, company, guides, canManage, companyName }: HelpPanelData & CompanyNamed) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const matches = (a: HelpLinkView) => !needle || `${a.title} ${a.description ?? ""}`.toLowerCase().includes(needle);
  const current = guides?.current ?? null;
  // While a search is typed, Deskzo's guides that match it join Deskzo's group — never the company's.
  const foundGuides = needle ? (guides?.guides ?? []).filter((g) => `${g.title} ${g.summary} ${g.words}`.toLowerCase().includes(needle)) : [];

  return (
    <div className="space-y-4">
      {desk && (
        <div className="rounded-lg border border-line bg-surface-sunken p-3 text-xs text-muted">
          <p className="font-medium text-text">{desk.label ?? "Need a hand?"}</p>
          {desk.phone && (
            <a href={`tel:${desk.phone.replace(/[^\d+]/g, "")}`} className="mt-1.5 flex items-center gap-1.5 text-sm font-semibold text-text hover:underline">
              <Phone className="h-3.5 w-3.5 text-brand" aria-hidden="true" />
              {desk.phone}
            </a>
          )}
          {desk.hours && <p className="mt-1">{desk.hours}</p>}
          {desk.languages && <p>{desk.languages}</p>}
          {desk.email && (
            <a href={`mailto:${desk.email}`} className="mt-1.5 flex items-center gap-1.5 hover:text-text hover:underline">
              <Mail className="h-3.5 w-3.5" aria-hidden="true" />
              {desk.email}
            </a>
          )}
        </div>
      )}

      {/* One box finds in both groups; each group still answers for itself. */}
      {deskzo.links.length + (guides?.guides.length ?? 0) + company.length > 5 && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" aria-hidden="true" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a guide or article" aria-label="Find a guide or article" className="pl-8" />
        </div>
      )}

      <Group source="deskzo">
        {current && !needle && <PageGuide guide={current} />}
        {needle && (foundGuides.length > 0 || deskzo.links.length > 0) ? (
          <>
            {foundGuides.length > 0 && <GuideList guides={foundGuides} />}
            {(foundGuides.length === 0 || deskzo.links.some(matches)) && <ArticleList articles={deskzo.links.filter(matches)} filter={filter} />}
          </>
        ) : !deskzo.ok && deskzo.links.length === 0 && !current ? (
          <Quiet>Deskzo&apos;s help couldn&apos;t be reached just now — try again in a minute.</Quiet>
        ) : deskzo.links.length === 0 ? (
          !current && <Quiet>{needle ? <>Nothing matches “{filter.trim()}”.</> : "Nothing from Deskzo here yet."}</Quiet>
        ) : (
          <ArticleList articles={deskzo.links.filter(matches)} filter={filter} />
        )}
        {guides?.helpCenterUrl && (guides.guides.length > 0 || current) && (
          <OutboundLink href={guides.helpCenterUrl} className="mt-2 inline-flex items-center gap-1 px-2 text-xs font-medium text-brand hover:underline">
            Every guide, in the Help Center
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
            <span className="sr-only"> (opens in a new tab)</span>
          </OutboundLink>
        )}
      </Group>

      <Group source="company" companyName={companyName}>
        {company.length === 0 ? (
          <CompanyEmpty canManage={canManage}>Your company hasn&apos;t added guides of its own.</CompanyEmpty>
        ) : (
          <ArticleList articles={company.filter(matches)} filter={filter} />
        )}
      </Group>

      <p className="text-xs text-subtle">
        Press <kbd className="rounded border border-line bg-surface-sunken px-1 font-mono text-[11px]">/</kbd> on any page to search.
      </p>
    </div>
  );
}

function ArticleList({ articles, filter }: { articles: HelpLinkView[]; filter: string }) {
  if (articles.length === 0) return <Quiet>Nothing matches “{filter.trim()}”.</Quiet>;
  return (
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
  );
}

/** The guide to the module this page belongs to, at the top of Deskzo's group: it opens on the Help Center, in a new tab. */
function PageGuide({ guide }: { guide: DeskzoGuide }) {
  return (
    <OutboundLink href={guide.url} className="mb-3 flex items-start gap-2.5 rounded-lg border border-brand/30 bg-brand-subtle px-3 py-2.5 hover:border-brand/60" data-guide={guide.module}>
      <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-[11px] font-semibold tracking-wide text-brand uppercase">The guide for this page</span>
        <span className="mt-0.5 block text-sm font-medium text-text">
          {guide.title}
          <ExternalLink className="ml-1 inline h-3 w-3 align-[-1px] text-subtle" aria-hidden="true" />
        </span>
        {guide.summary && <span className="mt-0.5 block text-xs text-muted">{guide.summary}</span>}
      </span>
      <span className="sr-only"> (opens in a new tab)</span>
    </OutboundLink>
  );
}

/** Deskzo's guides that match the panel's search. */
function GuideList({ guides }: { guides: DeskzoGuide[] }) {
  return (
    <ul className="mb-2 space-y-1" aria-label="Guides">
      {guides.map((g) => (
        <li key={g.module}>
          <OutboundLink href={g.url} className="flex items-start gap-2 rounded-base px-2 py-1.5 hover:bg-surface-sunken" data-guide={g.module}>
            <BookOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" aria-hidden="true" />
            <span className="min-w-0">
              <span className="block text-sm text-text">
                {g.title}
                <ExternalLink className="ml-1 inline h-3 w-3 align-[-1px] text-subtle" aria-hidden="true" />
              </span>
              {g.summary && <span className="block text-xs text-muted">{g.summary}</span>}
            </span>
            <span className="sr-only"> (opens in a new tab)</span>
          </OutboundLink>
        </li>
      ))}
    </ul>
  );
}

type VideosPanelData = { deskzo: DeskzoLinks; company: HelpLinkView[] };

export function RailVideos({ canManage, companyName }: CompanyNamed) {
  const { data, error } = useLoad<VideosPanelData>(
    async () => {
      const [deskzo, company] = await Promise.all([deskzoHelpLinks("VIDEO").catch(() => DESKZO_LINKS_FAILED), listHelpLinks("VIDEO")]);
      return { deskzo, company };
    },
    "Could not load the videos.",
  );
  if (!data) return <Loading error={error} />;
  return <RailVideosView {...data} canManage={canManage} companyName={companyName} />;
}

/** The Videos panel once loaded: Deskzo's walkthroughs, then the company's own. Pure, so check suites render it. */
export function RailVideosView({ deskzo, company, canManage, companyName }: VideosPanelData & CompanyNamed) {
  return (
    <div className="space-y-5">
      <Group source="deskzo">
        {!deskzo.ok && deskzo.links.length === 0 ? (
          <Quiet>Deskzo&apos;s videos couldn&apos;t be reached just now — try again in a minute.</Quiet>
        ) : deskzo.links.length === 0 ? (
          <Quiet>No walkthroughs from Deskzo here yet.</Quiet>
        ) : (
          <VideoList videos={deskzo.links} />
        )}
      </Group>
      <Group source="company" companyName={companyName}>
        {company.length === 0 ? (
          <CompanyEmpty canManage={canManage}>Your company hasn&apos;t added videos of its own.</CompanyEmpty>
        ) : (
          <VideoList videos={company} />
        )}
      </Group>
    </div>
  );
}

function VideoList({ videos }: { videos: HelpLinkView[] }) {
  return (
    <ul className="space-y-3">
      {videos.map((v) => (
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

const GROUP_HEADING = { deskzo: "From Deskzo", company: "From your company" } as const;

/**
 * One source's group in a panel, under its own heading — the company's by its name when known, so
 * somebody in several workspaces can tell whose guides these are. A name that starts "Deskzo" (our
 * own workspace's) keeps "From your company", so the company's group never reads as Deskzo's.
 * `data-source` lets a check tell the two apart.
 */
function Group({ source, companyName, children }: { source: keyof typeof GROUP_HEADING; companyName?: string | null; children: React.ReactNode }) {
  const id = useId();
  const given = source === "company" ? (companyName?.trim() ?? "") : "";
  const name = /^deskzo\b/i.test(given) ? "" : given;
  return (
    <section aria-labelledby={id} data-source={source}>
      <h3 id={id} className="mb-2 text-xs font-semibold uppercase tracking-wide break-words text-subtle">
        {name ? `From ${name}` : GROUP_HEADING[source]}
      </h3>
      {children}
    </section>
  );
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted">{children}</p>;
}

/**
 * The company's group with nothing in it. To somebody who may add guides, a quiet link to do so — the
 * company's own, never worded as if Deskzo's help were theirs to write; to everybody else, just that.
 */
function CompanyEmpty({ canManage, children }: { canManage: boolean; children: React.ReactNode }) {
  return (
    <p className="text-xs text-muted">
      {children}
      {canManage && (
        <>
          {" "}
          <Link href="/settings/help" className="font-medium text-brand hover:underline">
            Add your company&apos;s own guide
          </Link>
        </>
      )}
    </p>
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
    <OutboundLink href={link.url} className={className}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </OutboundLink>
  );
}
