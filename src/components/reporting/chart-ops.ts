import { ChartArea, ChartBar, ChartColumn, ChartLine, ChartNoAxesCombined, ChartPie, CircleDot, Grid3x3, Hash, Table2, type LucideIcon } from "lucide-react";
import {
  blankChart,
  calcIdOf,
  chartNeeds,
  isCalcRef,
  LIMITS,
  type ChartKind,
  type ChartMetric,
  type ChartWidth,
  type ReportChart,
  type ReportDefinition,
} from "@/lib/reporting/definition";
import type { CatalogSource } from "@/lib/reporting/sources";

/**
 * What the builder does to a chart, as plain functions of the chart and the source's catalogue — so undo is just
 * the previous value, and nothing here can make a chart the server wouldn't accept (it checks again anyway).
 */

export type Source = Extract<CatalogSource, { available: true }>;

export const KIND_ICONS: Record<ChartKind, LucideIcon> = {
  score: Hash,
  column: ChartColumn,
  bar: ChartBar,
  line: ChartLine,
  area: ChartArea,
  combo: ChartNoAxesCombined,
  pie: ChartPie,
  donut: CircleDot,
  table: Table2,
  pivot: Grid3x3,
};

/**
 * Twelve columns: a score a quarter of the row, a chart half, a table all of it — and narrower, they stack. Sized
 * by the canvas they sit in (a container query), not the window: the builder's canvas is the window less two
 * panels, the viewer's nearly all of it, a phone's one column.
 */
export const WIDTH_CLASS: Record<ChartWidth, string> = {
  3: "@md:col-span-6 @4xl:col-span-3",
  4: "@md:col-span-6 @4xl:col-span-4",
  5: "@2xl:col-span-6 @4xl:col-span-5",
  6: "@2xl:col-span-6",
  7: "@4xl:col-span-7",
  8: "@4xl:col-span-8",
  12: "",
};

export const WIDTH_CHOICES: { width: ChartWidth; label: string }[] = [
  { width: 3, label: "¼" },
  { width: 4, label: "⅓" },
  { width: 6, label: "½" },
  { width: 8, label: "⅔" },
  { width: 12, label: "Full" },
];

/** A new chart's, page's or filter's id — unique within a report, which is all an id needs to be. */
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function metricLabel(ref: string, source: Source, def: Pick<ReportDefinition, "calculated">): string {
  if (isCalcRef(ref)) return def.calculated.find((c) => c.id === calcIdOf(ref))?.label ?? "Calculated field";
  return source.measures.find((m) => m.key === ref)?.label ?? ref;
}

export function dimensionLabel(key: string | null, source: Source, def: Pick<ReportDefinition, "dateField">): string {
  if (!key) return "";
  if (key === "time") return source.dateFields.find((f) => f.key === def.dateField)?.label ?? "Date";
  return source.dimensions.find((d) => d.key === key)?.label ?? key;
}

/** A chart's own title, or one made from what it shows: "Revenue and Amount received by Branch". */
export function chartTitle(chart: ReportChart, source: Source | null, def: ReportDefinition): string {
  if (chart.title.trim()) return chart.title.trim();
  if (!source) return "Chart";
  const metrics = chart.metrics.map((m) => metricLabel(m.ref, source, def));
  if (metrics.length === 0) return "New chart";
  const what = metrics.length > 2 ? `${metrics.slice(0, -1).join(", ")} and ${metrics.at(-1)}` : metrics.join(" and ");
  if (!chart.dimension) return what;
  const by = chart.dimension === "time" ? `by ${chart.grain}` : `by ${dimensionLabel(chart.dimension, source, def).toLowerCase()}`;
  return chart.series ? `${what} ${by} and ${dimensionLabel(chart.series, source, def).toLowerCase()}` : `${what} ${by}`;
}

/** The first breakdown a new chart of a kind should get. */
function firstDimension(type: ChartKind, source: Source): string | null {
  if (type === "score") return null;
  const overTime = ["line", "area", "column", "combo"].includes(type);
  if (overTime && !source.snapshot && source.dateFields.length) return "time";
  return source.dimensions[0]?.key ?? (source.snapshot ? null : "time");
}

const metricOf = (key: string, source: Source): ChartMetric => ({ ref: key, agg: source.measures.find((m) => m.key === key)?.defaultAgg ?? "sum" });

/** A new chart of a kind over this source, set up enough to draw something at once. */
export function newChart(type: ChartKind, source: Source): ReportChart {
  const measure = source.measures.find((m) => m.key !== "count") ?? source.measures[0];
  const dimension = firstDimension(type, source);
  const chart = blankChart(newId("ch"), type, measure?.key ?? null, dimension);
  chart.metrics = measure ? [metricOf(measure.key, source)] : [];
  if (source.snapshot && type === "score") chart.compare = "none";
  return fitToKind(chart, source);
}

/**
 * A chart turned into another kind, keeping what it can: its metrics up to what the kind draws, a breakdown where
 * one is needed, a second metric for a combo and a second breakdown for a pivot.
 */
export function retype(chart: ReportChart, type: ChartKind, source: Source): ReportChart {
  if (chart.type === type) return chart;
  const next: ReportChart = { ...chart, type };
  if (type === "score") {
    next.dimension = null;
    next.series = null;
    next.limit = null;
    next.width = 3;
    next.compare = source.snapshot ? "none" : chart.compare === "none" ? "previousYear" : chart.compare;
  } else {
    if (chart.type === "score") {
      next.dimension = firstDimension(type, source);
      next.compare = "none";
      next.width = 6;
      next.limit = next.dimension === "time" ? null : 10;
      next.sort = next.dimension === "time" ? { by: "dimension", dir: "asc" } : { by: "value", dir: "desc" };
    }
    if (type === "table" || type === "pivot") next.width = 12;
    else if (chart.type === "table" || chart.type === "pivot") next.width = 6;
  }
  return fitToKind(next, source);
}

function fitToKind(chart: ReportChart, source: Source): ReportChart {
  const need = chartNeeds(chart.type);
  let metrics = chart.metrics.slice(0, need.maxMetrics);
  if (metrics.length < need.minMetrics) {
    const used = new Set(metrics.map((m) => m.ref));
    for (const m of source.measures) {
      if (metrics.length >= need.minMetrics) break;
      if (!used.has(m.key)) metrics = [...metrics, metricOf(m.key, source)];
    }
  }
  let series = need.series ? chart.series : null;
  if (need.series && (!series || series === chart.dimension)) series = source.dimensions.find((d) => d.key !== chart.dimension)?.key ?? null;
  // A pivot's rows can't be time with a snapshot, and pie slices over time read badly but are allowed.
  return { ...chart, metrics, series };
}

/** A field clicked in the data panel, applied to the selected chart. */
export function applyField(chart: ReportChart, field: { kind: "dimension"; key: string } | { kind: "metric"; ref: string }, source: Source): ReportChart {
  if (field.kind === "dimension") {
    const base = chart.type === "score" ? retype(chart, "column", source) : chart;
    const time = field.key === "time";
    return fitToKind(
      { ...base, dimension: field.key, sort: time ? { by: "dimension", dir: "asc" } : base.sort.by === "dimension" && base.dimension === "time" ? { by: "value", dir: "desc" } : base.sort, limit: time ? null : base.limit ?? 10 },
      source,
    );
  }
  if (chart.metrics.some((m) => m.ref === field.ref)) return chart;
  const metric: ChartMetric = isCalcRef(field.ref) ? { ref: field.ref, agg: "sum" } : metricOf(field.ref, source);
  const max = chartNeeds(chart.type).maxMetrics;
  const metrics = chart.metrics.length < max ? [...chart.metrics, metric] : [...chart.metrics.slice(0, max - 1), metric];
  return { ...chart, metrics };
}

/** A copy of a chart, new id, placed after it. */
export function copyChart(chart: ReportChart): ReportChart {
  return { ...structuredClone(chart), id: newId("ch"), title: chart.title ? `${chart.title} (copy)`.slice(0, 100) : "" };
}

export const canAddChart = (def: ReportDefinition, pageId: string) => (def.pages.find((p) => p.id === pageId)?.charts.length ?? 0) < LIMITS.chartsPerPage;
