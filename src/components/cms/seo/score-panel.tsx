"use client";

import { useId, useState, useTransition, type KeyboardEvent } from "react";
import Link from "next/link";
import { ArrowRight, EyeOff, LoaderCircle, RefreshCw } from "lucide-react";
import { cmsSeoRecalculate } from "@/actions/cms/seo";
import { CategoryScores, CheckItemBody, KeywordPlacementTable, ScoreChip, ScoreFigure } from "@/components/cms/seo/score-ui";
import { PANEL_TABS, panelLists, topProblems, type PanelTab } from "@/components/cms/seo/score-view";
import type { LiveSeo } from "@/components/cms/seo/use-live-score";
import { Button } from "@/components/ui/button";
import type { SeoEntityType, SeoScoreRow } from "@/lib/cms/types";
import { labelFor } from "@/lib/seo/engine";
import type { CheckResult, EntityScore } from "@/lib/seo/types";
import { cn } from "@/lib/utils";

/**
 * The live SEO, AEO and GEO scores of what is being edited, beside its search settings: the overall
 * "Optimization score" and its label, the three scores, where each primary keyword appears, and the
 * engine's findings in four tabs — Issues (failed, critical first), Warnings, Passed, Suggestions —
 * each with what to do about it. A finding about a field is a button that takes you to the field.
 * The dashboard's number for the version on the site is shown when it differs, and writers can have
 * it recalculated. Internal indicators, not any search engine's or AI platform's scores.
 *
 * `compact` (the category and tag dialog): the scores, the three findings that matter most, and a
 * link to the full analysis on the dashboard.
 */

export type SeoPanelEntity = { type: SeoEntityType; key: string };

/** The small "84 · Good" on the editor's SEO tab, so the score shows from the content tab too. */
export function SeoTabBadge({ live }: { live: LiveSeo }) {
  if (!live.score) return null;
  return <ScoreChip score={live.score.overall} label={live.score.label} what="SEO optimization score" />;
}

function Finding({ check, onJump }: { check: CheckResult; onJump?: (field: string) => void }) {
  const jump = onJump && check.field ? () => onJump(check.field!) : undefined;
  const body = (
    <CheckItemBody
      check={check}
      footer={
        jump && (
          <span className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-brand group-hover:underline">
            {/^(blocks|body)\[/.test(check.field ?? "") ? "Open the block" : "Go to the field"}
            <ArrowRight aria-hidden="true" className="h-3 w-3" />
          </span>
        )
      }
    />
  );
  return (
    <li>
      {jump ? (
        <button type="button" onClick={jump} className="group block w-full rounded-lg px-2 py-2 text-left hover:bg-surface-sunken">
          {body}
        </button>
      ) : (
        <div className="px-2 py-2">{body}</div>
      )}
    </li>
  );
}

function Findings({ score, onJump }: { score: EntityScore; onJump?: (field: string) => void }) {
  const base = useId();
  const [tab, setTab] = useState<PanelTab>("issues");
  const lists = panelLists(score);
  const tabId = (key: PanelTab) => `${base}-tab-${key}`;
  const panelId = (key: PanelTab) => `${base}-panel-${key}`;
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const keys = PANEL_TABS.map((t) => t.key);
    const next = e.key === "ArrowRight" ? (index + 1) % keys.length : e.key === "ArrowLeft" ? (index - 1 + keys.length) % keys.length : e.key === "Home" ? 0 : e.key === "End" ? keys.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    setTab(keys[next]);
    document.getElementById(tabId(keys[next]))?.focus();
  };
  return (
    <div>
      <div role="tablist" aria-label="Findings" className="flex max-w-full gap-1 overflow-x-auto shadow-[inset_0_-1px_0_var(--line)]">
        {PANEL_TABS.map((t, i) => {
          const on = t.key === tab;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={tabId(t.key)}
              aria-selected={on}
              aria-controls={panelId(t.key)}
              tabIndex={on ? 0 : -1}
              onClick={() => setTab(t.key)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn("inline-flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2 text-[13px] font-medium whitespace-nowrap", on ? "border-brand text-text" : "border-transparent text-muted hover:border-line-strong hover:text-text")}
            >
              {t.label}
              <span className={cn("rounded-full px-1.5 text-[11px] tabular-nums", on ? "bg-brand-subtle text-brand" : "bg-surface-sunken text-muted")}>{lists[t.key].length}</span>
            </button>
          );
        })}
      </div>
      {PANEL_TABS.map((t) => (
        <div key={t.key} role="tabpanel" id={panelId(t.key)} aria-labelledby={tabId(t.key)} hidden={t.key !== tab} tabIndex={0} className="rounded-base pt-2">
          {lists[t.key].length === 0 ? <p className="px-2 py-3 text-xs text-muted">{t.empty}</p> : <ul className="-mx-2 divide-y divide-line">{lists[t.key].map((c) => <Finding key={c.id} check={c} onJump={onJump} />)}</ul>}
        </div>
      ))}
    </div>
  );
}

/** "Live version on the site: 72" — the dashboard's number, when it is not what the draft scores. */
function SiteVersionLine({ cached, current }: { cached: SeoScoreRow | null; current: number }) {
  if (!cached) return <p className="text-xs text-muted">The dashboard hasn&apos;t scored the saved version yet.</p>;
  if (cached.overall === current && !cached.stale) return null;
  const what = cached.live ? "Live version on the site" : "Saved version, on the dashboard";
  return (
    <p className="text-xs text-muted">
      {`${what}: `}
      <ScoreChip score={cached.overall} label={cached.label} what={what} />
      {cached.stale ? " — calculated before the latest changes." : ""}
    </p>
  );
}

export function SeoScorePanel({
  live,
  entity,
  canRecalculate = false,
  onJump,
  compact = false,
  fullAnalysisHref,
  fullAnalysisNewTab = false,
  className,
}: {
  live: LiveSeo;
  /** What the dashboard knows it as, for "Recalculate score"; null when it isn't saved yet. */
  entity: SeoPanelEntity | null;
  /** A writer: may have the dashboard's number recalculated. */
  canRecalculate?: boolean;
  /** Takes the editor to a finding's field ("seo.description", "blocks[<id>]"). */
  onJump?: (field: string) => void;
  compact?: boolean;
  /** The dashboard with this entity's detail open. */
  fullAnalysisHref?: string;
  /** Opens it in a new tab — from a dialog, whose unsaved changes would otherwise be lost. */
  fullAnalysisNewTab?: boolean;
  className?: string;
}) {
  const headingId = useId();
  const [recalculated, setRecalculated] = useState<{ row: SeoScoreRow } | null>(null);
  const [recalcError, setRecalcError] = useState<string | null>(null);
  const [recalculating, startRecalc] = useTransition();
  // The newer of what "Recalculate score" answered and what the context (fetched again after a publish) says.
  const fromContext = live.context?.cached ?? null;
  const cached = recalculated && (!fromContext || new Date(recalculated.row.calculatedAt).getTime() >= new Date(fromContext.calculatedAt).getTime()) ? recalculated.row : fromContext;
  const score = live.score;

  const recalculate = () => {
    if (!entity) return;
    setRecalcError(null);
    startRecalc(async () => {
      try {
        const result = await cmsSeoRecalculate(entity.type, entity.key);
        if (result.ok) setRecalculated({ row: result.data });
        else setRecalcError(result.error);
      } catch {
        setRecalcError("The score wasn't recalculated. Try again.");
      }
    });
  };

  const frame = cn("min-w-0 space-y-4 rounded-xl border border-line bg-surface p-4", className);
  const heading = (
    <div className="min-w-0">
      <h2 id={headingId} className="text-sm font-semibold text-text">
        Optimization score
      </h2>
      <p className="mt-0.5 text-xs text-muted">
        Scores update as you edit.
        {live.pending && score ? <span className="text-subtle"> Updating…</span> : null}
      </p>
    </div>
  );

  if (!score) {
    return (
      <section aria-labelledby={headingId} aria-busy={live.loading || undefined} className={frame}>
        {heading}
        {live.loading ? (
          <p className="flex items-center gap-2 text-xs text-muted">
            <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
            Loading the scores…
          </p>
        ) : (
          <p className="text-xs text-muted">{live.error ?? "Scores appear once it is saved."}</p>
        )}
      </section>
    );
  }

  const trio = [
    { key: "seo", name: "SEO", score: score.seo.score, label: labelFor(score.seo.score) },
    { key: "aeo", name: "AEO", score: score.aeo.score, label: labelFor(score.aeo.score) },
    { key: "geo", name: "GEO", score: score.geo.score, label: labelFor(score.geo.score) },
  ];

  const excluded = score.excluded && (
    <p className="flex items-start gap-2 rounded-lg border border-info/30 bg-info-bg px-3 py-2 text-xs text-info">
      <EyeOff aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
      <span>
        <span className="font-medium">Intentionally excluded from search engines (noindex).</span> It isn&apos;t scored against search, and it is left out of the site&apos;s score.
      </span>
    </p>
  );

  if (compact) {
    const top = topProblems(score, 3);
    return (
      <section aria-labelledby={headingId} className={frame}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          {heading}
          <ScoreFigure score={score.overall} label={score.label} size="md" />
        </div>
        {excluded}
        <CategoryScores scores={trio} />
        <div>
          <h3 className="text-[13px] font-medium text-text">{top.length ? "What matters most" : "Nothing to fix"}</h3>
          {top.length > 0 ? (
            <ul className="-mx-2 mt-1 divide-y divide-line">
              {top.map((c) => (
                <Finding key={c.id} check={c} onJump={onJump} />
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-muted">No failures and no warnings.</p>
          )}
        </div>
        {fullAnalysisHref && (
          <Link
            href={fullAnalysisHref}
            target={fullAnalysisNewTab ? "_blank" : undefined}
            rel={fullAnalysisNewTab ? "noopener noreferrer" : undefined}
            className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline"
          >
            Full analysis
            {fullAnalysisNewTab && <span className="sr-only"> (opens in a new tab)</span>}
            <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
          </Link>
        )}
      </section>
    );
  }

  return (
    <section aria-labelledby={headingId} className={frame}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        {heading}
        {canRecalculate && entity && (
          <Button type="button" variant="secondary" size="sm" onClick={recalculate} disabled={recalculating}>
            {recalculating ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <RefreshCw aria-hidden="true" className="h-4 w-4" />}
            Recalculate score
          </Button>
        )}
      </div>
      <div className="space-y-1.5">
        <ScoreFigure score={score.overall} label={score.label} />
        <div aria-live="polite">
          <SiteVersionLine cached={cached} current={score.overall} />
          {recalcError && <p className="text-xs text-danger">{recalcError}</p>}
          {recalculated && !recalcError && <p className="text-xs text-success">Recalculated — the dashboard shows this number now.</p>}
        </div>
      </div>
      {excluded}
      <CategoryScores scores={trio} />
      <div className="space-y-1.5">
        <h3 className="text-[13px] font-medium text-text">Primary keywords</h3>
        {score.keywords.length > 0 ? (
          <KeywordPlacementTable keywords={score.keywords} caption="Where each primary keyword appears" />
        ) : (
          <p className="text-xs text-muted">
            None yet.{" "}
            {onJump && (
              <button type="button" onClick={() => onJump("seo.keywords")} className="font-medium text-brand hover:underline">
                Add up to three
              </button>
            )}
          </p>
        )}
      </div>
      <Findings score={score} onJump={onJump} />
      {fullAnalysisHref && (
        <Link href={fullAnalysisHref} className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
          Open it in SEO Intelligence
          <ArrowRight aria-hidden="true" className="h-3 w-3" />
        </Link>
      )}
    </section>
  );
}
