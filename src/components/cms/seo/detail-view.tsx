import Link from "next/link";
import { ArrowUpRight, EyeOff, PenLine } from "lucide-react";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { RecalculateOneButton } from "@/components/cms/seo/dashboard-client";
import { STATUS_LABEL, TYPE_LABEL } from "@/components/cms/seo/dashboard-params";
import { CategoryScores, CheckItemBody, KeywordPlacementTable, ScoreFigure } from "@/components/cms/seo/score-ui";
import { detailSections } from "@/components/cms/seo/score-view";
import { OutboundLink } from "@/components/ui/outbound-link";
import type { SeoScoreDetail } from "@/lib/cms/types";
import { labelFor } from "@/lib/seo/engine";
import type { CheckResult } from "@/lib/seo/types";

/**
 * One entity's whole analysis, for the dashboard's drawer: where it is and what it is, its scores,
 * its primary keywords with where each appears, then every check by section — Metadata, Content,
 * Technical SEO, Structured data (what the site emits, and what its kind should carry), AEO, GEO,
 * Social metadata, Images, Links, Indexability — each with its status, the engine's explanation and
 * its recommendation. The checks that don't apply are folded away under each section.
 */

function CheckList({ checks }: { checks: CheckResult[] }) {
  return (
    <ul className="divide-y divide-line">
      {checks.map((c) => (
        <li key={c.id} className="py-2">
          <CheckItemBody check={c} />
        </li>
      ))}
    </ul>
  );
}

export function SeoDetailView({ detail, canWrite, siteOrigin }: { detail: SeoScoreDetail; canWrite: boolean; siteOrigin: string }) {
  const { row, score } = detail;
  const sections = detailSections(score);
  const missingLd = detail.jsonLd.expected.filter((t) => !detail.jsonLd.emitted.includes(t));
  const trio = [
    { key: "seo", name: "SEO", score: score.seo.score, label: labelFor(score.seo.score) },
    { key: "aeo", name: "AEO", score: score.aeo.score, label: labelFor(score.aeo.score) },
    { key: "geo", name: "GEO", score: score.geo.score, label: labelFor(score.geo.score) },
  ];
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="space-y-1.5">
          {row.live ? (
            <OutboundLink href={`${siteOrigin}${row.path}`} className="inline-flex items-start gap-1 font-mono text-xs break-all text-brand hover:underline">
              {row.path}
              <ArrowUpRight aria-hidden="true" className="mt-px h-3 w-3 shrink-0" />
              <span className="sr-only"> (on the site, opens in a new tab)</span>
            </OutboundLink>
          ) : (
            <p className="font-mono text-xs break-all text-muted">{row.path}</p>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusPill tone="neutral">{TYPE_LABEL[row.type]}</StatusPill>
            <StatusPill tone={row.status === "published" ? "success" : "neutral"}>{STATUS_LABEL[row.status]}</StatusPill>
            {!row.live && <StatusPill tone="neutral">Not on the site</StatusPill>}
            {row.excluded && (
              <StatusPill tone="info" icon={<EyeOff className="h-3 w-3" />}>
                Excluded (noindex)
              </StatusPill>
            )}
          </div>
        </div>
        <ScoreFigure score={score.overall} label={score.label} />
        <CategoryScores scores={trio} />
        <p className="text-xs text-muted">
          {detail.fresh ? "Calculated just now — the saved score was out of date." : <>Calculated <RelativeTime at={row.calculatedAt} />.</>}
        </p>
        {(row.editHref || canWrite) && (
          <div className="flex flex-wrap items-start gap-2">
            {row.editHref && (
              <Link href={row.editHref} className="inline-flex h-8 items-center gap-1.5 rounded-base border border-line-strong bg-surface px-3 text-[13px] font-medium text-text shadow-sm hover:bg-surface-sunken">
                <PenLine aria-hidden="true" className="h-4 w-4" />
                {row.type === "CATEGORY" ? "Open in Categories" : row.type === "TAG" ? "Open in Tags" : "Open in editor"}
              </Link>
            )}
            {canWrite && <RecalculateOneButton type={row.type} entityKey={row.key} />}
          </div>
        )}
      </div>

      {score.excluded && (
        <p className="flex items-start gap-2 rounded-lg border border-info/30 bg-info-bg px-3 py-2 text-xs text-info">
          <EyeOff aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            <span className="font-medium">Intentionally excluded from search engines (noindex).</span> The checks that only matter for indexed pages don&apos;t apply, and it is left out of the site&apos;s score.
          </span>
        </p>
      )}

      {sections.map((s) => (
        <section key={s.key} aria-labelledby={`seo-detail-${s.key}`} className="space-y-2 border-t border-line pt-4">
          <h3 id={`seo-detail-${s.key}`} className="text-sm font-semibold text-text">
            {s.title}
          </h3>
          {s.key === "keywords" &&
            (score.keywords.length > 0 ? (
              <KeywordPlacementTable keywords={score.keywords} full caption="Where each primary keyword appears, how often, and its share of the words" />
            ) : (
              <p className="text-xs text-muted">{row.type === "BLOG_INDEX" ? "The blog index has no primary keywords of its own." : "No primary keywords yet. Add up to three in its editor."}</p>
            ))}
          {s.key === "structured" && (
            <dl className="grid gap-1 text-xs sm:grid-cols-2">
              <div>
                <dt className="text-muted">The site emits</dt>
                <dd className="text-text">{detail.jsonLd.emitted.length ? detail.jsonLd.emitted.join(", ") : "None"}</dd>
              </div>
              <div>
                <dt className="text-muted">Missing for its kind</dt>
                <dd className={missingLd.length ? "text-warning" : "text-text"}>{missingLd.length ? missingLd.join(", ") : detail.jsonLd.expected.length ? "None" : "None expected"}</dd>
              </div>
            </dl>
          )}
          {s.checks.length > 0 ? <CheckList checks={s.checks} /> : <p className="text-xs text-muted">Nothing here is scored for it.</p>}
          {s.notApplicable.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted hover:text-text">{`${s.notApplicable.length} ${s.notApplicable.length === 1 ? "check doesn't" : "checks don't"} apply`}</summary>
              <CheckList checks={s.notApplicable} />
            </details>
          )}
        </section>
      ))}
    </div>
  );
}
