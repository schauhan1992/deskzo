import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { Braces, Clock, EyeOff, FileText, FileWarning, Gauge, Globe, KeyRound, Newspaper, OctagonAlert, ShieldAlert, TriangleAlert } from "lucide-react";
import { KpiTile } from "@/components/console/charts/kpi-tile";
import { EmptyState } from "@/components/console/kit/empty-state";
import { SearchField, SelectFilter, ToggleFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips, ViewTabs } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill, TONE_DOT } from "@/components/console/kit/status";
import { RecalculateControls, SeoDetailDrawer } from "@/components/cms/seo/dashboard-client";
import { loadOpenDetail } from "@/components/cms/seo/dashboard-data";
import {
  BAND_OPTIONS,
  clearFiltersHref,
  FLAG_FILTERS,
  filterChips,
  INDEX_OPTIONS,
  openParam,
  parseSeoParams,
  SEO_PATH,
  seoViewHref,
  SORT_LABEL,
  STATUS_OPTIONS,
  TYPE_OPTIONS,
  withOpen,
} from "@/components/cms/seo/dashboard-params";
import { SeoDetailView } from "@/components/cms/seo/detail-view";
import { SeoScoresTable } from "@/components/cms/seo/scores-table";
import { CheckItemBody, ScoreLabel } from "@/components/cms/seo/score-ui";
import { LABEL_TONE, SCORE_BANDS, scoreSentence, SEO_DISCLAIMER } from "@/components/cms/seo/score-view";
import { Pagination } from "@/components/ui/pagination";
import { withParams } from "@/lib/console-shared/params";
import { cmsPage } from "@/lib/cms/guard";
import { CMS_PAGE_ROLES, CMS_ROUTES } from "@/lib/cms/nav";
import { listScores, siteSummary } from "@/lib/cms/seo-scores";
import { cmsCapsFor, type SeoSiteSummary } from "@/lib/cms/types";
import { siteOrigin } from "@/lib/platform/site-content";
import { labelFor } from "@/lib/seo/engine";
import type { SeoLabel } from "@/lib/seo/types";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "SEO Intelligence" };

const num = (n: number) => n.toLocaleString("en-IN");

/** A score as a tile's figure: "84 /100", and one sentence for a screen reader. */
function ScoreTileValue({ what, score, label }: { what: string; score: number; label: SeoLabel }) {
  return (
    <>
      <span aria-hidden="true">
        {score}
        <span className="text-sm font-normal text-muted"> /100</span>
      </span>
      <span className="sr-only">{scoreSentence(what, score, label)}</span>
    </>
  );
}

/**
 * SEO Intelligence: how the site's pages, posts, category and tag archives and the blog index score
 * for SEO, AEO and GEO — the weighted site score (noindex and what isn't live left out), the three
 * scores, how many addresses the site offers search engines, the critical issues and warnings; what
 * needs attention (each a link that filters the table), the site-wide checks, the spread across the
 * bands; and the table, filtered, sorted and paged from the address, each row opening its full
 * analysis in a drawer (`?open=`). Everybody in the CMS reads it; writers recalculate — out-of-date
 * scores a batch at a time, everything, or one entity. The scores come from the cache
 * (src/lib/cms/seo-scores.ts); nothing is scored while the page renders, except an opened entity
 * whose saved score is out of date.
 */
export default async function CmsSeoPage({ searchParams }: PageProps<"/platform-cms/seo">) {
  const session = await cmsPage(CMS_PAGE_ROLES.seo);
  const caps = cmsCapsFor(session.user.role);
  const sp = await searchParams;
  const p = parseSeoParams(sp);
  // The open entity first: a writer's look may store a fresh score, which the table then shows.
  const open = await loadOpenDetail(p.open, { store: caps.write });
  const [summary, list] = await Promise.all([siteSummary(), listScores(p.filters)]);
  const origin = siteOrigin();
  const totalPages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const chips = filterChips(p, sp);
  const filtered = chips.length > 0;
  const clearHref = clearFiltersHref(sp);
  const scored = summary.scored > 0;

  return (
    <>
      <PageHeader
        title="SEO Intelligence"
        chips={
          summary.lastCalculatedAt ? (
            <StatusPill tone="neutral" icon={<Clock className="h-3 w-3" />}>
              <span>
                Last calculated <RelativeTime at={summary.lastCalculatedAt} />
              </span>
            </StatusPill>
          ) : undefined
        }
        subtitle={<p className="max-w-3xl text-xs text-muted">{SEO_DISCLAIMER}</p>}
      />

      <div className="space-y-6">
        <section aria-label="Summary" className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4">
          <div className="col-span-2 md:col-span-1 [&>*]:h-full">
            <KpiTile
              label="Site optimization score"
              icon={<Gauge className="h-4 w-4" />}
              tone={scored ? LABEL_TONE[summary.label] : "neutral"}
              value={scored ? <ScoreTileValue what="Site optimization score" score={summary.overall} label={summary.label} /> : "—"}
              secondary={scored ? <ScoreLabel label={summary.label} decorative /> : "Not calculated yet"}
            />
          </div>
          {(
            [
              ["SEO", summary.seo],
              ["AEO", summary.aeo],
              ["GEO", summary.geo],
            ] as const
          ).map(([name, value]) => (
            <KpiTile
              key={name}
              label={name}
              tone={scored ? LABEL_TONE[labelFor(value)] : "neutral"}
              value={scored ? <ScoreTileValue what={`${name} score`} score={value} label={labelFor(value)} /> : "—"}
              secondary={scored ? <ScoreLabel label={labelFor(value)} decorative /> : "Not calculated yet"}
            />
          ))}
          <KpiTile label="Total indexable URLs" icon={<Globe className="h-4 w-4" />} value={num(summary.indexableUrls)} secondary="Live, not noindex, not blocked or redirected" />
          <KpiTile
            label="Critical issues"
            icon={<OctagonAlert className="h-4 w-4" />}
            tone={summary.counts.critical > 0 ? "danger" : "neutral"}
            value={num(summary.counts.critical)}
            href={seoViewHref({ critical: "1", index: "indexable" })}
            secondary={`Across ${num(summary.scored)} scored`}
          />
          <KpiTile
            label="Warnings"
            icon={<TriangleAlert className="h-4 w-4" />}
            tone={summary.counts.warnings > 0 ? "warning" : "neutral"}
            value={num(summary.counts.warnings)}
            secondary={`Across ${num(summary.scored)} scored`}
          />
        </section>

        <Freshness summary={summary} canWrite={caps.write} />

        <div className="grid items-start gap-6 lg:grid-cols-3">
          <NeedsAttention summary={summary} />
          <SiteChecks summary={summary} canOpenSettings={caps.publish} />
          <Distribution summary={summary} />
        </div>

        <section id="seo-table" aria-labelledby="seo-table-heading" className="scroll-mt-20">
          <h2 id="seo-table-heading" className="mb-3 text-sm font-semibold text-text">
            Pages, posts and archives
          </h2>
          <FilterBar trailing={<SearchField label="Search by title or address" placeholder="Search title or address" resetParams={["page", "open"]} />}>
            <ViewTabs
              label="Content type"
              items={[
                { key: "all", label: "All", href: withParams(SEO_PATH, sp, { type: null, open: null }), active: !p.type },
                ...TYPE_OPTIONS.map((t) => ({ key: t.value, label: t.label, href: withParams(SEO_PATH, sp, { type: t.value, open: null }), active: p.type === t.value })),
              ]}
            />
            <SelectFilter param="status" label="Status" allLabel="Any" options={STATUS_OPTIONS} resetParams={["page", "open"]} />
            <SelectFilter param="band" label="Score" allLabel="Any" options={BAND_OPTIONS.map((b) => ({ value: b.value, label: b.label }))} resetParams={["page", "open"]} />
            <SelectFilter param="index" label="Indexing" allLabel="Any" options={INDEX_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} resetParams={["page", "open"]} />
            {FLAG_FILTERS.map((f) => (
              <ToggleFilter key={f.param} param={f.param} label={f.label} resetParams={["page", "open"]} />
            ))}
            <SelectFilter
              param="sort"
              label="Order"
              allLabel={SORT_LABEL.lowest}
              options={(["highest", "issues", "recent"] as const).map((s) => ({ value: s, label: SORT_LABEL[s] }))}
              resetParams={["page", "open"]}
            />
          </FilterBar>
          <FilterChips chips={chips} clearHref={filtered ? clearHref : undefined} />

          <Panel padded={list.rows.length === 0}>
            {list.rows.length === 0 ? (
              filtered || p.type ? (
                <EmptyState variant="filtered" title="Nothing matches" body="Try another search or filter." clearHref={clearHref} />
              ) : (
                <EmptyState
                  icon={<Gauge className="h-5 w-5" />}
                  title="Nothing has been scored yet"
                  body={caps.write ? "Use “Recalculate all” above: every page, post and archive is scored a batch at a time." : "An author, editor or admin can have the site scored from here."}
                />
              )
            ) : (
              <SeoScoresTable rows={list.rows} sp={sp} openKey={p.open ? openParam(p.open.type, p.open.key) : null} />
            )}
          </Panel>
          {totalPages > 1 && <Pagination page={list.page} pageSize={list.pageSize} total={list.total} totalPages={totalPages} pageSizes={[list.pageSize]} label="pages, posts and archives" />}
        </section>
      </div>

      {open && (
        <SeoDetailDrawer title={open.detail ? open.detail.row.title || open.detail.row.path : "SEO analysis"} closeHref={withOpen(sp, null)}>
          {open.detail ? <SeoDetailView detail={open.detail} canWrite={caps.write} siteOrigin={origin} /> : <p className="text-sm text-danger">{open.error}</p>}
        </SeoDetailDrawer>
      )}
    </>
  );
}

/** How many scores are out of date or never calculated — and, for writers, the way to bring them up to date. */
function Freshness({ summary, canWrite }: { summary: SeoSiteSummary; canWrite: boolean }) {
  const behind = summary.stale + summary.uncalculated;
  const words =
    behind === 0
      ? `All ${num(summary.entities)} scores are up to date.`
      : [summary.stale > 0 ? `${num(summary.stale)} ${summary.stale === 1 ? "score is" : "scores are"} out of date` : "", summary.uncalculated > 0 ? `${num(summary.uncalculated)} never calculated` : ""].filter(Boolean).join(" · ");
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          {behind > 0 && <Clock aria-hidden="true" className="h-4 w-4 text-warning" />}
          {words}
        </span>
      }
      description={behind > 0 ? "Content, settings or the scoring changed since they were calculated. The table shows the old numbers, marked stale, until they are recalculated." : "Recalculate everything after a change the scores can't notice by themselves — an image's alt text, a redirect, the trial length."}
      className={cn(behind > 0 && "border-warning/40")}
    >
      {canWrite ? <RecalculateControls stale={summary.stale} uncalculated={summary.uncalculated} entities={summary.entities} /> : <p className="text-xs text-muted">An author, editor or admin can recalculate them.</p>}
    </Panel>
  );
}

function AttentionLink({ href, icon, label, count, tone }: { href: string; icon: ReactNode; label: string; count: number; tone: "danger" | "warning" | "neutral" }) {
  return (
    <li>
      <Link href={href} className="flex items-center gap-2.5 rounded-base px-2 py-1.5 text-sm text-text hover:bg-surface-sunken">
        <span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-surface-sunken text-muted">
          {icon}
        </span>
        <span className="min-w-0 flex-1">{label}</span>
        <span className={cn("shrink-0 font-medium tabular-nums", count > 0 && tone === "danger" ? "text-danger" : count > 0 && tone === "warning" ? "text-warning" : "text-muted")}>{num(count)}</span>
      </Link>
    </li>
  );
}

/** What needs looking at, each a link that filters the table to it. */
function NeedsAttention({ summary }: { summary: SeoSiteSummary }) {
  const c = summary.counts;
  const indexable = { index: "indexable" };
  return (
    <Panel title="Needs attention" description="Among the pages, posts and archives search engines may index.">
      <ul className="-mx-2 space-y-0.5">
        <AttentionLink href={seoViewHref({ critical: "1", ...indexable })} icon={<OctagonAlert className="h-3.5 w-3.5" />} label="Critical issues" count={c.critical} tone="danger" />
        <AttentionLink href={seoViewHref({ type: "page", band: "attention", ...indexable })} icon={<FileText className="h-3.5 w-3.5" />} label="Pages needing attention" count={c.pagesNeedingAttention} tone="warning" />
        <AttentionLink href={seoViewHref({ type: "post", band: "attention", ...indexable })} icon={<Newspaper className="h-3.5 w-3.5" />} label="Posts needing attention" count={c.postsNeedingAttention} tone="warning" />
        <AttentionLink href={seoViewHref({ meta: "1", ...indexable })} icon={<FileWarning className="h-3.5 w-3.5" />} label="Missing metadata" count={c.missingMetadata} tone="warning" />
        <AttentionLink href={seoViewHref({ schema: "1", ...indexable })} icon={<Braces className="h-3.5 w-3.5" />} label="Missing structured data" count={c.missingStructuredData} tone="warning" />
        <AttentionLink href={seoViewHref({ keywords: "1", ...indexable })} icon={<KeyRound className="h-3.5 w-3.5" />} label="No primary keywords" count={c.noPrimaryKeywords} tone="warning" />
        <AttentionLink href={seoViewHref({ conflict: "1", ...indexable })} icon={<ShieldAlert className="h-3.5 w-3.5" />} label="Indexing conflicts" count={c.indexingConflicts} tone="danger" />
        <AttentionLink href={seoViewHref({ index: "noindex" })} icon={<EyeOff className="h-3.5 w-3.5" />} label="Excluded (noindex)" count={c.excluded} tone="neutral" />
      </ul>
    </Panel>
  );
}

/** The checks about the whole site, each with its status and what to do. */
function SiteChecks({ summary, canOpenSettings }: { summary: SeoSiteSummary; canOpenSettings: boolean }) {
  return (
    <Panel title="Site checks" description="True of the whole site, reported beside the score.">
      <ul className="-my-1 divide-y divide-line">
        {summary.siteChecks.map((check) => (
          <li key={check.id} className="py-2">
            <CheckItemBody
              check={check}
              footer={
                check.status !== "PASS" && canOpenSettings && check.field?.startsWith("settings.") ? (
                  <Link href={CMS_ROUTES.settings} className="mt-1 inline-block text-[11px] font-medium text-brand hover:underline">
                    Open settings
                  </Link>
                ) : undefined
              }
            />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** How the scored entities spread over the four bands: a count and a labelled bar for each. */
function Distribution({ summary }: { summary: SeoSiteSummary }) {
  return (
    <Panel title="Score distribution" description={`Of the ${num(summary.scored)} scored pages, posts and archives.`}>
      <ul className="-mx-2 space-y-1">
        {SCORE_BANDS.map((band) => {
          const n = summary.distribution[band.label] ?? 0;
          const percent = summary.scored > 0 ? Math.round((n / summary.scored) * 100) : 0;
          return (
            <li key={band.param}>
              <Link href={seoViewHref({ band: band.param, index: "indexable" })} className="block rounded-base px-2 py-1.5 hover:bg-surface-sunken">
                <span className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-text">
                    {band.label}
                    <span className="ml-1.5 text-xs text-subtle">{`${band.min}–${band.max}`}</span>
                  </span>
                  <span className="shrink-0 font-medium text-text tabular-nums">
                    {num(n)}
                    <span className="ml-1 text-xs font-normal text-muted">{`(${percent}%)`}</span>
                  </span>
                </span>
                <span aria-hidden="true" className="mt-1.5 block h-2 overflow-hidden rounded-full bg-surface-sunken">
                  <span className={cn("block h-full rounded-full", TONE_DOT[LABEL_TONE[band.label]])} style={{ width: `${n > 0 ? Math.max(percent, 2) : 0}%` }} />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
