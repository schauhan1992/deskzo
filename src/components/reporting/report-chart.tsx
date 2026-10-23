"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, CircleAlert, CircleDashed } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReportChart } from "@/lib/reporting/definition";
import type { BucketsResult, ChartRun, MetricMeta, PivotResult, ScoreResult } from "@/lib/reporting/result";
import { changeOf, formatMetric, formatTick, niceMax } from "./format";

/**
 * A report chart drawn from its figures (Reporting & Analytics, owner 23 Oct 2026) — the builder's canvas, the
 * viewer, a favourite's thumbnail. Plain elements and inline SVG, every colour a token, so the brand colour and dark
 * mode reach the charts as they reach everything else. Clicking a bar, slice or row of a chart broken down by
 * something other than time hands it up (`onPick`) for the viewer to filter the page by.
 */

export const PALETTE = ["var(--brand)", "var(--success)", "var(--warning)", "var(--danger)", "var(--info)", "color-mix(in srgb, var(--brand) 45%, var(--surface))", "var(--text-subtle)"];
export const CHART_BODY = 248;

type Props = {
  chart: ReportChart;
  run: ChartRun | "loading" | undefined;
  height?: number;
  /** A bucket clicked: the dimension and its value. Only for charts broken down by a field. */
  onPick?: (dimension: string, value: string) => void;
  /** The value picked on this chart, drawn highlighted. */
  picked?: string | null;
  /** A small preview: no axes' words, no legend. */
  compact?: boolean;
};

export function ReportChartBody({ chart, run, height = CHART_BODY, onPick, picked, compact }: Props) {
  if (run === undefined || run === "loading") return <Skeleton height={height} type={chart.type} />;
  if (!run.ok) return <ChartMessage height={height} tone={run.code === "config" ? "setup" : "error"} title={run.code === "config" ? "This chart isn't set up yet" : "This chart can't be shown"} text={run.error} />;
  const r = run.result;
  if (r.kind === "score") return <ScoreBody result={r} title={chart.title} compact={compact} />;
  if (r.kind === "pivot") return <PivotTable result={r} height={height} />;
  if (r.buckets.length === 0 || r.buckets.every((b) => b.values.every((v) => !v))) {
    return <ChartMessage height={height} tone="empty" title="Nothing matches" text="No records in this range for these filters. Try a wider date range or remove a filter." />;
  }
  const pick = onPick && !r.dimension.time ? (label: string) => onPick(r.dimension.key, label) : undefined;
  switch (chart.type) {
    case "pie":
    case "donut":
      return <Donut result={r} height={height} hole={chart.type === "donut"} onPick={pick} picked={picked} compact={compact} />;
    case "bar":
      return <HBars result={r} height={height} onPick={pick} picked={picked} showLegend={chart.showLegend && !compact} />;
    case "table":
      return <BucketTable result={r} height={height} onPick={pick} picked={picked} />;
    default:
      return <Cartesian result={r} type={chart.type} height={height} onPick={pick} picked={picked} showLegend={chart.showLegend && !compact} showValues={chart.showValues} compact={compact} />;
  }
}

// ─── States ──────────────────────────────────────────────────────────────────

function Skeleton({ height, type }: { height: number; type: ReportChart["type"] }) {
  if (type === "score") {
    return (
      <div className="space-y-3 py-1">
        <div className="h-3 w-24 animate-pulse rounded bg-surface-sunken" />
        <div className="h-7 w-32 animate-pulse rounded bg-surface-sunken" />
        <div className="h-3 w-20 animate-pulse rounded bg-surface-sunken" />
      </div>
    );
  }
  return (
    <div className="flex items-end gap-3 px-2" style={{ height }} aria-label="Loading">
      {[45, 70, 55, 85, 62, 74].map((h, i) => (
        <div key={i} className="flex-1 animate-pulse rounded-t bg-surface-sunken" style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}

export function ChartMessage({ height, title, text, tone, action }: { height: number; title: string; text: string; tone: "setup" | "error" | "empty"; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 px-4 text-center" style={{ minHeight: height }}>
      <span className={cn("grid h-9 w-9 place-items-center rounded-full", tone === "setup" ? "bg-warning-bg text-warning" : tone === "error" ? "bg-danger-bg text-danger" : "bg-surface-sunken text-subtle")}>
        {tone === "empty" ? <CircleDashed className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />}
      </span>
      <div className="text-sm font-medium text-text">{title}</div>
      <div className="max-w-sm text-[13px] text-muted">{text}</div>
      {action}
    </div>
  );
}

// ─── Score ───────────────────────────────────────────────────────────────────

function ScoreBody({ result, title, compact }: { result: ScoreResult; title: string; compact?: boolean }) {
  const change = changeOf(result.value, result.previous, result.metric.unit);
  // For an amount owed or time taken, up is the worse way; a rate or an amount earned, the better.
  const upIsBad = /outstanding|overdue|days|expense|claim|open/i.test(`${result.metric.label} ${title}`);
  const good = change ? change.up !== upIsBad : true;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-start justify-between gap-3">
        <span className="truncate text-[13px] font-medium text-muted">{title || result.metric.label}</span>
        {!compact && <Sparkline values={result.spark} />}
      </div>
      <span className="text-[26px] font-semibold leading-tight tracking-[-0.02em] tabular-nums text-text" title={result.metric.unit === "currency" && result.value !== null ? formatMetric(result.value, "currency", { short: false }) : undefined}>
        {formatMetric(result.value, result.metric.unit)}
      </span>
      <span className="flex min-h-[18px] items-center gap-1 text-[12.5px]">
        {change ? (
          <>
            <span className={cn("inline-flex items-center gap-0.5 font-medium", good ? "text-success" : "text-danger")}>
              {change.up ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
              {change.text}
            </span>
            <span className="text-subtle">{result.compareLabel}</span>
          </>
        ) : result.compareLabel ? (
          <span className="text-subtle">Nothing to compare {result.compareLabel}</span>
        ) : null}
      </span>
    </div>
  );
}

export function Sparkline({ values, width = 64, height = 26 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * 100, 36 - ((v - min) / (max - min || 1)) * 30] as const);
  const d = "M" + pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" L");
  return (
    <svg width={width} height={height} viewBox="0 0 100 40" preserveAspectRatio="none" className="shrink-0 overflow-visible text-brand" aria-hidden="true">
      <path d={`${d} L100 40 L0 40 Z`} fill="currentColor" fillOpacity={0.1} />
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.75} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Columns, lines, areas, combo ────────────────────────────────────────────

/** The width an element is drawn at, followed as it changes — a chart's card resized, a panel opened beside it. */
function useWidth<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width] as const;
}

function Legend({ metrics, colours }: { metrics: MetricMeta[]; colours: string[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
      {metrics.map((m, i) => (
        <span key={m.ref + i} className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm" style={{ background: colours[i] }} />
          {m.label}
        </span>
      ))}
    </div>
  );
}

function Cartesian({
  result,
  type,
  height,
  onPick,
  picked,
  showLegend,
  showValues,
  compact,
}: {
  result: BucketsResult;
  type: ReportChart["type"];
  height: number;
  onPick?: (label: string) => void;
  picked?: string | null;
  showLegend: boolean;
  showValues: boolean;
  compact?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [measure, width] = useWidth<HTMLDivElement>();
  const combo = type === "combo" && result.metrics.length >= 2;
  const barMetrics = combo ? [0] : type === "column" ? result.metrics.map((_, i) => i) : [];
  const lineMetrics = combo ? [1] : type === "line" || type === "area" ? result.metrics.map((_, i) => i) : [];
  const n = result.buckets.length;
  const valuesOf = (i: number) => result.buckets.map((b) => b.values[i] ?? 0);
  const leftIdx = combo ? [0] : result.metrics.map((_, i) => i);
  const leftUnit = result.metrics[0]!.unit;
  const leftMax = niceMax(Math.max(0, ...leftIdx.flatMap(valuesOf)) * 1.05);
  const rightUnit = combo ? result.metrics[1]!.unit : leftUnit;
  const rightMax = combo ? (rightUnit === "percent" ? Math.max(1, niceMax(Math.max(0, ...valuesOf(1)))) : niceMax(Math.max(0, ...valuesOf(1)) * 1.05)) : leftMax;
  const L = compact ? 4 : 48;
  const R = combo && !compact ? 40 : 4;
  const B = compact ? 4 : 22;
  const T = 6;
  const yPct = (v: number, max: number) => Math.max(0, Math.min(100, (v / max) * 100));
  const xAt = (i: number) => ((i + 0.5) / n) * 100;
  // As many axis labels as fit the width the chart has — a month label wants about 58px.
  const fit = width ? Math.max(2, Math.floor((width - L - R) / 58)) : 8;
  const step = Math.max(1, Math.ceil(n / fit));
  const colours = result.metrics.map((_, i) => PALETTE[i % PALETTE.length]!);

  return (
    <div className="flex flex-col gap-2" style={{ height }}>
      {showLegend && result.metrics.length > 1 && <Legend metrics={result.metrics} colours={colours} />}
      <div ref={measure} className="relative min-h-0 flex-1">
        {!compact &&
          [0, 1, 2, 3, 4].map((t) => {
            const top = `calc(${T}px + ${(100 - t * 25) / 100} * (100% - ${T + B}px))`;
            return (
              <div key={t}>
                <div className={cn("absolute border-t", t === 0 ? "border-line" : "border-line/60")} style={{ left: L, right: R, top }} />
                <div className="absolute -translate-y-1/2 pr-2 text-right text-[11px] tabular-nums text-subtle" style={{ left: 0, width: L, top }}>
                  {formatTick((leftMax * t) / 4, leftUnit)}
                </div>
                {combo && (
                  <div className="absolute -translate-y-1/2 pl-2 text-[11px] tabular-nums text-subtle" style={{ right: 0, width: R, top }}>
                    {formatTick((rightMax * t) / 4, rightUnit)}
                  </div>
                )}
              </div>
            );
          })}
        <div className="absolute flex" style={{ left: L, right: R, top: T, bottom: B }}>
          {result.buckets.map((b, i) => (
            <div
              key={b.key}
              className={cn("flex h-full flex-1 items-end justify-center gap-[3px]", onPick && "cursor-pointer")}
              style={{ opacity: (picked && picked !== b.label) || (hover !== null && hover !== i) ? 0.45 : 1 }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onPick?.(b.label)}
            >
              {barMetrics.map((mi) => (
                <div key={mi} className="relative w-full max-w-[34px] rounded-t-[3px]" style={{ height: `${yPct(b.values[mi] ?? 0, leftMax)}%`, background: colours[mi] }}>
                  {showValues && !compact && (b.values[mi] ?? 0) > 0 && (
                    <span className="absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] text-muted">{formatTick(b.values[mi] ?? 0, result.metrics[mi]!.unit)}</span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
        {lineMetrics.length > 0 && (
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute overflow-visible" style={{ left: L, top: T, width: `calc(100% - ${L + R}px)`, height: `calc(100% - ${T + B}px)` }} aria-hidden="true">
            {lineMetrics.map((mi) => {
              const max = combo && mi === 1 ? rightMax : leftMax;
              const pts = valuesOf(mi).map((v, i) => [xAt(i), 100 - yPct(v, max)] as const);
              const d = "M" + pts.map((p) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(" L");
              return (
                <g key={mi}>
                  {type === "area" && <path d={`${d} L${pts[n - 1]![0]} 100 L${pts[0]![0]} 100 Z`} fill={colours[mi]} fillOpacity={0.12} />}
                  <path d={d} fill="none" stroke={colours[mi]} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
                </g>
              );
            })}
          </svg>
        )}
        {lineMetrics.length > 0 &&
          !compact &&
          n <= 40 &&
          lineMetrics.flatMap((mi) => {
            const max = combo && mi === 1 ? rightMax : leftMax;
            return valuesOf(mi).map((v, i) => (
              <span
                key={`${mi}-${i}`}
                className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-surface"
                style={{ left: `calc(${L}px + ${xAt(i) / 100} * (100% - ${L + R}px))`, top: `calc(${T}px + ${(100 - yPct(v, max)) / 100} * (100% - ${T + B}px))`, borderColor: colours[mi] }}
              />
            ));
          })}
        {!compact &&
          result.buckets.map((b, i) =>
            (n - 1 - i) % step === 0 ? (
              <div key={b.key} className="absolute bottom-0 max-w-[90px] -translate-x-1/2 truncate whitespace-nowrap text-[11px] text-subtle" style={{ left: `calc(${L}px + ${xAt(i) / 100} * (100% - ${L + R}px))` }}>
                {b.label}
              </div>
            ) : null,
          )}
        {hover !== null && !compact && (
          <div
            className="pointer-events-none absolute z-10 whitespace-nowrap rounded-lg border border-line bg-surface-raised px-2.5 py-1.5 text-xs shadow-md"
            style={{ top: T, left: `calc(${L}px + ${xAt(hover) / 100} * (100% - ${L + R}px))`, transform: hover >= n / 2 ? "translateX(calc(-100% - 8px))" : "translateX(8px)" }}
          >
            <div className="mb-0.5 font-medium text-text">{result.buckets[hover]!.label}</div>
            {result.metrics.map((m, mi) => (
              <div key={m.ref + mi} className="flex items-center gap-1.5 text-muted">
                <span className="h-[7px] w-[7px] rounded-full" style={{ background: colours[mi] }} />
                {m.label}
                <span className="ml-auto pl-3 font-medium tabular-nums text-text">{formatMetric(result.buckets[hover]!.values[mi] ?? null, m.unit)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Bars across ─────────────────────────────────────────────────────────────

function HBars({ result, height, onPick, picked, showLegend }: { result: BucketsResult; height: number; onPick?: (label: string) => void; picked?: string | null; showLegend: boolean }) {
  const colours = result.metrics.map((_, i) => PALETTE[i % PALETTE.length]!);
  const max = niceMax(Math.max(0, ...result.buckets.flatMap((b) => b.values.map((v) => v ?? 0))));
  return (
    <div className="flex flex-col gap-2 overflow-y-auto" style={{ maxHeight: height, minHeight: Math.min(height, 120) }}>
      {showLegend && result.metrics.length > 1 && <Legend metrics={result.metrics} colours={colours} />}
      <div className="grid items-center gap-x-3 gap-y-2" style={{ gridTemplateColumns: "minmax(70px,auto) minmax(0,1fr)" }}>
        {result.buckets.map((b) => (
          <div key={b.key} className="contents">
            <button
              type="button"
              disabled={!onPick}
              onClick={() => onPick?.(b.label)}
              className={cn("max-w-[160px] truncate text-right text-[13px] disabled:cursor-default", picked && picked !== b.label ? "text-subtle" : "text-text")}
              title={b.label}
            >
              {b.label}
            </button>
            <div className="flex flex-col gap-1">
              {b.values.map((v, mi) => (
                <div key={mi} className="flex items-center gap-2">
                  <div
                    className={cn("h-3.5 rounded-[3px]", onPick && "cursor-pointer")}
                    onClick={() => onPick?.(b.label)}
                    style={{ width: `${Math.max(0.5, ((v ?? 0) / max) * 85)}%`, background: colours[mi], opacity: picked && picked !== b.label ? 0.35 : 1 }}
                  />
                  <span className="whitespace-nowrap text-[12px] tabular-nums text-muted">{formatMetric(v, result.metrics[mi]!.unit)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {result.hidden > 0 && <p className="text-[12px] text-subtle">{result.hidden} more not shown — raise the limit to see them.</p>}
    </div>
  );
}

// ─── Pie and donut ───────────────────────────────────────────────────────────

function Donut({ result, height, hole, onPick, picked, compact }: { result: BucketsResult; height: number; hole: boolean; onPick?: (label: string) => void; picked?: string | null; compact?: boolean }) {
  const items = result.buckets.map((b) => ({ label: b.label, value: Math.max(0, b.values[0] ?? 0) }));
  const total = items.reduce((a, b) => a + b.value, 0);
  const unit = result.metrics[0]!.unit;
  const S = compact ? 96 : Math.min(180, height - 20);
  const c = S / 2;
  const R = hole ? S * 0.38 : S * 0.25;
  const SW = hole ? S * 0.15 : S * 0.5;
  const CIRC = 2 * Math.PI * R;
  const lengths = items.map((it) => (total ? (it.value / total) * CIRC : 0));
  const starts = lengths.map((_, i) => lengths.slice(0, i).reduce((a, b) => a + b, 0));
  return (
    <div className={cn("flex items-center gap-6", compact ? "justify-center" : "flex-wrap justify-center")} style={{ minHeight: compact ? undefined : height }}>
      <div className="relative shrink-0" style={{ width: S, height: S }}>
        <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} className="-rotate-90" aria-hidden="true">
          {items.map((it, i) => (
            <circle
              key={it.label}
              cx={c}
              cy={c}
              r={R}
              fill="none"
              stroke={PALETTE[i % PALETTE.length]}
              strokeWidth={SW}
              strokeDasharray={`${Math.max(0.1, lengths[i]! - (items.length > 1 ? 1.2 : 0))} ${CIRC}`}
              strokeDashoffset={-starts[i]!}
              opacity={picked && picked !== it.label ? 0.35 : 1}
              className={cn(onPick && "cursor-pointer")}
              onClick={() => onPick?.(it.label)}
            />
          ))}
        </svg>
        {hole && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className={cn("font-semibold tabular-nums text-text", compact ? "text-xs" : "text-lg")}>{formatMetric(total, unit)}</span>
            {!compact && <span className="text-[11px] text-muted">Total</span>}
          </div>
        )}
      </div>
      {!compact && (
        <div className="grid min-w-[180px] max-w-[360px] flex-1 items-center gap-x-2.5 gap-y-2" style={{ gridTemplateColumns: "8px minmax(64px,1fr) auto" }}>
          {items.map((it, i) => (
            <button key={it.label} type="button" disabled={!onPick} onClick={() => onPick?.(it.label)} className="contents text-left disabled:cursor-default">
              <span className="h-2 w-2 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} />
              <span title={it.label} className={cn("truncate text-[13px]", picked && picked !== it.label ? "text-subtle" : "text-text")}>{it.label}</span>
              <span className="whitespace-nowrap pl-2 text-right text-[13px] font-medium tabular-nums text-text">
                {formatMetric(it.value, unit)}
                <span className="font-normal text-subtle"> ({total ? Math.round((it.value / total) * 100) : 0}%)</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Tables ──────────────────────────────────────────────────────────────────

const TH = "sticky top-0 z-[1] border-b border-line bg-surface-sunken px-3 py-2 text-left text-[12px] font-medium text-muted whitespace-nowrap";

function BucketTable({ result, height, onPick, picked }: { result: BucketsResult; height: number; onPick?: (label: string) => void; picked?: string | null }) {
  return (
    <div className="overflow-auto rounded-lg border border-line" style={{ maxHeight: height + 40 }}>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className={TH}>{result.dimension.label}</th>
            {result.metrics.map((m, i) => (
              <th key={m.ref + i} className={cn(TH, "text-right")}>
                {m.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.buckets.map((b) => (
            <tr key={b.key} className={cn("border-b border-line/70 last:border-0", onPick && "cursor-pointer hover:bg-surface-sunken", picked === b.label && "bg-brand-subtle")} onClick={() => onPick?.(b.label)}>
              <td className="max-w-[240px] truncate px-3 py-2 text-text">{b.label}</td>
              {b.values.map((v, i) => (
                <td key={i} className="px-3 py-2 text-right tabular-nums text-text">
                  {formatMetric(v, result.metrics[i]!.unit)}
                </td>
              ))}
            </tr>
          ))}
          <tr className="bg-surface-sunken/60 font-semibold">
            <td className="px-3 py-2 text-text">Total</td>
            {result.totals.map((v, i) => (
              <td key={i} className="px-3 py-2 text-right tabular-nums text-text">
                {formatMetric(v, result.metrics[i]!.unit)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      {(result.hidden > 0 || result.doubleCounted) && (
        <p className="border-t border-line px-3 py-1.5 text-[12px] text-subtle">
          {result.hidden > 0 ? `${result.hidden} more rows not shown. ` : ""}
          {result.doubleCounted ? "A record can fall in more than one row, so the rows add up to more than the total." : ""}
        </p>
      )}
    </div>
  );
}

function PivotTable({ result, height }: { result: PivotResult; height: number }) {
  if (result.rows.length === 0) return <ChartMessage height={height} tone="empty" title="Nothing matches" text="No records in this range for these filters." />;
  const unit = result.metric.unit;
  return (
    <div className="overflow-auto rounded-lg border border-line" style={{ maxHeight: height + 60 }}>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className={TH}>
              {result.rowDimension.label} · {result.columnDimension.label}
            </th>
            {result.columns.map((c) => (
              <th key={c.key} className={cn(TH, "text-right")}>
                {c.label}
              </th>
            ))}
            <th className={cn(TH, "text-right")}>Total</th>
          </tr>
        </thead>
        <tbody>
          {result.rows.map((r) => (
            <tr key={r.key} className="border-b border-line/70 last:border-0">
              <td className="max-w-[220px] truncate px-3 py-2 text-text">{r.label}</td>
              {r.cells.map((v, i) => (
                <td key={i} className="px-3 py-2 text-right tabular-nums text-text">
                  {v ? formatMetric(v, unit) : <span className="text-subtle">—</span>}
                </td>
              ))}
              <td className="px-3 py-2 text-right font-medium tabular-nums text-text">{formatMetric(r.total, unit)}</td>
            </tr>
          ))}
          <tr className="bg-surface-sunken/60 font-semibold">
            <td className="px-3 py-2 text-text">Total</td>
            {result.columnTotals.map((v, i) => (
              <td key={i} className="px-3 py-2 text-right tabular-nums text-text">
                {formatMetric(v, unit)}
              </td>
            ))}
            <td className="px-3 py-2 text-right tabular-nums text-text">{formatMetric(result.grand, unit)}</td>
          </tr>
        </tbody>
      </table>
      {(result.hiddenRows > 0 || result.hiddenColumns > 0) && (
        <p className="border-t border-line px-3 py-1.5 text-[12px] text-subtle">
          {result.hiddenRows > 0 ? `${result.hiddenRows} more rows not shown. ` : ""}
          {result.hiddenColumns > 0 ? `${result.hiddenColumns} smaller columns folded into Other.` : ""}
        </p>
      )}
    </div>
  );
}
