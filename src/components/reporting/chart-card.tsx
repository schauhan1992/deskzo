"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { ReportChart } from "@/lib/reporting/definition";
import type { ChartRun } from "@/lib/reporting/result";
import { WIDTH_CLASS } from "./chart-ops";
import { ReportChartBody } from "./report-chart";

/**
 * One chart on a report page — the builder's canvas and the viewer draw the same card, so what is built is what is
 * seen. A chart with its own filters says so ("1 chart filter"), since the report's filter bar doesn't show them.
 */
export function ChartCard({
  chart,
  title,
  run,
  selected,
  onSelect,
  menu,
  onPick,
  picked,
  note,
  height,
}: {
  chart: ReportChart;
  title: string;
  run: ChartRun | "loading" | undefined;
  selected?: boolean;
  onSelect?: () => void;
  menu?: ReactNode;
  onPick?: (dimension: string, value: string) => void;
  picked?: string | null;
  /** Under the chart: "Top 10 of 34", a double-count warning. */
  note?: string | null;
  height?: number;
}) {
  const filters = chart.filters.length;
  const badge = filters > 0 && (
    <span className="shrink-0 rounded-full bg-warning-bg px-2 py-0.5 text-[11.5px] font-medium text-warning" title="Filters on this chart only, on top of the report's">
      {filters} chart filter{filters === 1 ? "" : "s"}
    </span>
  );
  const score = chart.type === "score";
  return (
    <section
      aria-label={title}
      onClick={onSelect}
      className={cn(
        "group relative col-span-12 min-w-0 rounded-xl border bg-surface shadow-sm transition-shadow",
        WIDTH_CLASS[chart.width],
        selected ? "border-brand ring-2 ring-brand/25" : "border-line",
        onSelect && !selected && "cursor-pointer hover:border-line-strong",
        score ? "p-4" : "p-4 sm:p-5",
      )}
    >
      {score ? (
        <>
          {(menu || badge) && (
            <div className="absolute right-2 top-2 z-10 flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
              {menu}
            </div>
          )}
          <ReportChartBody chart={{ ...chart, title }} run={run} />
          {badge && <div className="mt-2">{badge}</div>}
        </>
      ) : (
        <>
          <header className="mb-3 flex min-h-7 items-start gap-2">
            <h3 className="min-w-0 flex-1 truncate text-[14.5px] font-semibold text-text">{title}</h3>
            {badge}
            {menu}
          </header>
          <ReportChartBody chart={chart} run={run} onPick={onPick} picked={picked} height={height} />
          {note && <p className="mt-2 text-[12px] text-subtle">{note}</p>}
        </>
      )}
    </section>
  );
}

/** What a chart leaves out, said under it. */
export function chartNote(run: ChartRun | "loading" | undefined): string | null {
  if (!run || run === "loading" || !run.ok) return null;
  const parts: string[] = [];
  const r = run.result;
  if (r.kind === "buckets" && r.hidden > 0) parts.push(`${r.hidden} more not shown`);
  if (r.kind === "buckets" && r.doubleCounted) parts.push("a record can fall in more than one group, so the parts add up to more than the total");
  if (r.kind === "pivot" && (r.hiddenRows || r.hiddenColumns)) parts.push("only the largest rows and columns are shown");
  if (run.truncated) parts.push("hit the row ceiling — figures are floors, not totals");
  return parts.length ? `${parts[0]![0]!.toUpperCase()}${parts.join("; ").slice(1)}.` : null;
}
