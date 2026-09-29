import type { ReactNode } from "react";
import { Check, CircleCheck, CircleMinus, CircleX, Info, Minus, TriangleAlert } from "lucide-react";
import { TONE_PILL, TONE_TEXT } from "@/components/console/kit/status";
import { LABEL_TONE, PLACEMENTS, scoreSentence, STATUS_WORDS } from "@/components/cms/seo/score-view";
import type { CheckResult, CheckStatus, KeywordAnalysis, SeoLabel } from "@/lib/seo/types";
import { cn } from "@/lib/utils";

/**
 * The pieces every SEO Intelligence screen draws a score with: the number and its label side by side
 * (never a colour on its own), what a screen reader hears for it, a check's status as an icon and a
 * word, and where each primary keyword appears. No hooks and no directive, so the dashboard's server
 * page and the editors' client panels share them.
 */

/** "84 / 100" with its label beside it, and one sentence for a screen reader. */
export function ScoreFigure({ score, label, what = "Overall score", size = "lg" }: { score: number; label: SeoLabel; what?: string; size?: "lg" | "md" }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span aria-hidden="true" className={cn("font-semibold tracking-tight text-text tabular-nums", size === "lg" ? "text-3xl" : "text-2xl")}>
        {score}
        <span className="text-sm font-normal text-muted"> / 100</span>
      </span>
      <ScoreLabel label={label} decorative />
      <span className="sr-only">{scoreSentence(what, score, label)}</span>
    </span>
  );
}

/** The band's name as a pill in its tone. `decorative` when a sentence beside it already says it. */
export function ScoreLabel({ label, decorative = false, className }: { label: SeoLabel; decorative?: boolean; className?: string }) {
  return (
    <span aria-hidden={decorative || undefined} className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap", TONE_PILL[LABEL_TONE[label]], className)}>
      {label}
    </span>
  );
}

/** A small "84 · Good" chip — a tab's badge, a table cell. */
export function ScoreChip({ score, label, what = "Score", className }: { score: number; label: SeoLabel; what?: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 text-[11px] leading-4 font-medium whitespace-nowrap tabular-nums", TONE_PILL[LABEL_TONE[label]], className)}>
      <span aria-hidden="true">{`${score} · ${label}`}</span>
      <span className="sr-only">{scoreSentence(what, score, label)}</span>
    </span>
  );
}

/** SEO, AEO and GEO side by side, each its number and its label. */
export function CategoryScores({ scores, className }: { scores: { key: string; name: string; score: number; label: SeoLabel }[]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-3 gap-2", className)}>
      {scores.map((s) => (
        <div key={s.key} className="min-w-0 rounded-lg border border-line bg-surface-sunken/60 px-2.5 py-2">
          <dt className="text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">{s.name}</dt>
          <dd className="mt-0.5">
            <span aria-hidden="true" className="block text-lg font-semibold text-text tabular-nums">
              {s.score}
            </span>
            <span aria-hidden="true" className={cn("block text-[11px] leading-4 font-medium", TONE_TEXT[LABEL_TONE[s.label]])}>
              {s.label}
            </span>
            <span className="sr-only">{scoreSentence(`${s.name} score`, s.score, s.label)}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

const STATUS_ICON: Record<CheckStatus, typeof Check> = { FAIL: CircleX, WARNING: TriangleAlert, PASS: CircleCheck, INFO: Info, NOT_APPLICABLE: CircleMinus };

/** A check's status: its icon and its word, in its tone. */
export function CheckStatusMark({ status, className }: { status: CheckStatus; className?: string }) {
  const Icon = STATUS_ICON[status];
  const words = STATUS_WORDS[status];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 text-[11px] leading-4 font-medium whitespace-nowrap", TONE_TEXT[words.tone], className)}>
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      {words.label}
    </span>
  );
}

const CATEGORY_NAME = { seo: "SEO", aeo: "AEO", geo: "GEO" } as const;

/**
 * One finding: its status (icon and word), its name, SEO/AEO/GEO, "Critical" when it is, the engine's
 * explanation and its recommendation. Spans only, so it can sit inside a button.
 */
export function CheckItemBody({ check, footer }: { check: CheckResult; footer?: ReactNode }) {
  return (
    <span className="flex items-start gap-2.5">
      <CheckStatusMark status={check.status} className="mt-0.5 w-[5.75rem]" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="text-[13px] font-medium text-text">{check.label}</span>
          <span className="text-[10px] font-semibold tracking-[0.06em] text-subtle uppercase">{CATEGORY_NAME[check.category]}</span>
          {check.severity === "critical" && <span className="rounded-full border border-danger/40 bg-danger-bg px-1.5 text-[10px] leading-4 font-medium text-danger">Critical</span>}
        </span>
        <span className="mt-0.5 block text-xs text-muted">{check.message}</span>
        {check.recommendation && <span className="mt-1 block text-xs text-text">{check.recommendation}</span>}
        {footer}
      </span>
    </span>
  );
}

function Mark({ yes }: { yes: boolean }) {
  return yes ? (
    <span className="inline-flex items-center justify-center text-success">
      <Check aria-hidden="true" className="h-3.5 w-3.5" />
      <span className="sr-only">Yes</span>
    </span>
  ) : (
    <span className="inline-flex items-center justify-center text-subtle">
      <Minus aria-hidden="true" className="h-3.5 w-3.5" />
      <span className="sr-only">No</span>
    </span>
  );
}

/**
 * Where each primary keyword appears: one row per place, one column per keyword (at most three), ✓ or
 * –. `full` adds the other headings, how often it is used and its share of the words.
 */
export function KeywordPlacementTable({ keywords, full = false, caption }: { keywords: KeywordAnalysis[]; full?: boolean; caption: string }) {
  const rows = PLACEMENTS.filter((p) => full || !p.full);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[16rem] text-left text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className="py-1.5 pr-2 font-medium text-muted">
              <span className="sr-only">Where</span>
            </th>
            {keywords.map((k, i) => (
              <th key={`${i}-${k.keyword}`} scope="col" className="max-w-[9rem] px-1.5 py-1.5 text-center font-medium text-text">
                <span className="block text-[10px] font-normal text-subtle">{`Keyword ${i + 1}`}</span>
                <span className="block truncate" title={k.keyword}>
                  {k.keyword}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((p) => (
            <tr key={p.key}>
              <th scope="row" className="py-1 pr-2 font-normal whitespace-nowrap text-muted">
                {p.label}
              </th>
              {keywords.map((k, i) => (
                <td key={`${i}-${k.keyword}`} className="px-1.5 py-1 text-center">
                  <Mark yes={k[p.key] === true} />
                </td>
              ))}
            </tr>
          ))}
          {full && (
            <>
              <tr>
                <th scope="row" className="py-1 pr-2 font-normal whitespace-nowrap text-muted">
                  Times used
                </th>
                {keywords.map((k, i) => (
                  <td key={`${i}-${k.keyword}`} className="px-1.5 py-1 text-center text-text tabular-nums">
                    {k.occurrences.toLocaleString("en-IN")}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row" className="py-1 pr-2 font-normal whitespace-nowrap text-muted">
                  Share of the words
                </th>
                {keywords.map((k, i) => (
                  <td key={`${i}-${k.keyword}`} className="px-1.5 py-1 text-center text-text tabular-nums">
                    {`${k.density}%`}
                  </td>
                ))}
              </tr>
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}
