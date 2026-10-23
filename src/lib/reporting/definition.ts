import { z } from "zod";

/**
 * A saved report, as the Report Builder keeps it (Reporting & Analytics, owner 23 Oct 2026).
 *
 * The definition is the question, never the answer: which source, which window, which filters, and the pages
 * of charts over it. No figure is stored. Opening a report runs it again as whoever opens it, through their
 * own access to the source (src/lib/reporting/run.ts) — which is how a shared report never widens access.
 *
 * Shared by the browser (the builder edits one) and the server (which checks every one it is sent, field by
 * field, before keeping or running it). Nothing here may import a server module.
 */

export const CHART_KINDS = ["score", "column", "bar", "line", "area", "combo", "pie", "donut", "table", "pivot"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

export const CHART_KIND_LABELS: Record<ChartKind, string> = {
  score: "Score",
  column: "Column",
  bar: "Bar",
  line: "Line",
  area: "Area",
  combo: "Combo",
  pie: "Pie",
  donut: "Donut",
  table: "Table",
  pivot: "Pivot",
};

export const AGGREGATIONS = ["sum", "avg", "min", "max", "count"] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];
export const AGGREGATION_LABELS: Record<Aggregation, string> = { sum: "SUM", avg: "AVG", min: "MIN", max: "MAX", count: "COUNT" };

export const GRAINS = ["day", "week", "month", "quarter", "year"] as const;

export const DATE_PRESETS = ["thisFy", "lastFy", "thisQuarter", "thisMonth", "lastMonth", "last30", "last90", "last12m", "ytd", "custom"] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];
export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  thisFy: "This financial year",
  lastFy: "Last financial year",
  thisQuarter: "This quarter",
  thisMonth: "This month",
  lastMonth: "Last month",
  last30: "Last 30 days",
  last90: "Last 3 months",
  last12m: "Last 12 months",
  ytd: "Year to date",
  custom: "Custom range",
};

/** What a filter can ask: of a text field (the dimensions), or of a number on each row (the metrics). */
export const TEXT_OPS = ["in", "notIn", "contains", "notContains", "startsWith", "equals", "isEmpty", "isNotEmpty"] as const;
export const NUMBER_OPS = ["gt", "gte", "lt", "lte", "eq", "between", "isEmpty"] as const;
export const FILTER_OPS = [...new Set([...TEXT_OPS, ...NUMBER_OPS])] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export const FILTER_OP_LABELS: Record<FilterOp, string> = {
  in: "is any of",
  notIn: "is none of",
  contains: "contains",
  notContains: "does not contain",
  startsWith: "starts with",
  equals: "is exactly",
  isEmpty: "is empty",
  isNotEmpty: "is not empty",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  eq: "is equal to",
  between: "is between",
};

export const CALC_FORMATS = ["currency", "number", "percent"] as const;
export type CalcFormat = (typeof CALC_FORMATS)[number];

/** Widths on the canvas's twelve columns — a score a quarter, a chart half, a table the whole row. */
export const CHART_WIDTHS = [3, 4, 5, 6, 7, 8, 12] as const;
export type ChartWidth = (typeof CHART_WIDTHS)[number];

/** How much one report may hold — enough for any real report, small enough that one can't be made to hurt. */
export const LIMITS = { pages: 10, chartsPerPage: 24, filters: 20, filterValues: 200, calculated: 12, metrics: 4, expression: 300, name: 120, description: 400, limit: 500 } as const;

const key = z.string().trim().min(1).max(120);
const id = z.string().regex(/^[\w-]{1,40}$/, "That isn't a valid id.");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a day.");

export const dateRangeSchema = z
  .object({ preset: z.enum(DATE_PRESETS), from: day.optional(), to: day.optional() })
  .refine((r) => r.preset !== "custom" || (!!r.from && !!r.to && r.from <= r.to), "A custom range needs a start and an end, in order.");
export type DateRange = z.infer<typeof dateRangeSchema>;

export const filterSchema = z.object({
  id,
  /** A dimension's key (text), or a measure's key (a number on each row). */
  field: key,
  op: z.enum(FILTER_OPS),
  values: z.array(z.string().max(200)).max(LIMITS.filterValues).optional(),
  text: z.string().max(200).optional(),
  number: z.number().finite().optional(),
  number2: z.number().finite().optional(),
});
export type ReportFilter = z.infer<typeof filterSchema>;

export const calculatedSchema = z.object({
  id: z.string().regex(/^c[\w]{1,20}$/, "That isn't a valid calculated field id."),
  label: z.string().trim().min(1, "Name the calculated field.").max(60),
  /** Metric references in braces, numbers, + − × ÷ and brackets: `{received} / {net}` (src/lib/reporting/expression.ts). */
  expression: z.string().trim().min(1, "Write the calculation.").max(LIMITS.expression),
  format: z.enum(CALC_FORMATS),
});
export type CalculatedField = z.infer<typeof calculatedSchema>;

export const chartMetricSchema = z.object({
  /** A measure's key, or `calc:<id>` for a calculated field. */
  ref: key,
  agg: z.enum(AGGREGATIONS),
});
export type ChartMetric = z.infer<typeof chartMetricSchema>;

export const chartSchema = z.object({
  id,
  type: z.enum(CHART_KINDS),
  title: z.string().trim().max(100),
  /** What it is broken down by: a dimension's key, `time`, or null for a single figure (a score). */
  dimension: key.nullable(),
  grain: z.enum(GRAINS),
  /** A second breakdown: a pivot's columns. */
  series: key.nullable(),
  metrics: z.array(chartMetricSchema).max(LIMITS.metrics),
  sort: z.object({ by: z.enum(["dimension", "value"]), dir: z.enum(["asc", "desc"]) }),
  /** The first N buckets after sorting, or all. */
  limit: z.number().int().min(1).max(LIMITS.limit).nullable(),
  /** Its own window instead of the report's. */
  dateRange: dateRangeSchema.nullable(),
  /** Applied on top of the report's filters, to this chart only. */
  filters: z.array(filterSchema).max(LIMITS.filters),
  width: z.union([z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7), z.literal(8), z.literal(12)]),
  /** A score against the period before, or the same period a year back. */
  compare: z.enum(["none", "previousPeriod", "previousYear"]),
  showLegend: z.boolean(),
  showValues: z.boolean(),
});
export type ReportChart = z.infer<typeof chartSchema>;

export const pageSchema = z.object({
  id,
  name: z.string().trim().min(1, "Name the page.").max(40),
  charts: z.array(chartSchema).max(LIMITS.chartsPerPage),
});
export type ReportPage = z.infer<typeof pageSchema>;

export const definitionSchema = z.object({
  v: z.literal(1),
  source: key,
  /** Which of the source's dates the window is on ("Issued on", "Due on"…). */
  dateField: key,
  dateRange: dateRangeSchema,
  filters: z.array(filterSchema).max(LIMITS.filters),
  calculated: z.array(calculatedSchema).max(LIMITS.calculated),
  pages: z.array(pageSchema).min(1, "A report needs a page.").max(LIMITS.pages),
});
export type ReportDefinition = z.infer<typeof definitionSchema>;

export const reportMetaSchema = z.object({
  name: z.string().trim().min(1, "Name the report.").max(LIMITS.name),
  description: z.string().trim().max(LIMITS.description).optional().default(""),
});

/** A blank chart of a kind, for the builder's "Add chart". */
export function blankChart(chartId: string, type: ChartKind, measure: string | null, dimension: string | null): ReportChart {
  const score = type === "score";
  return {
    id: chartId,
    type,
    title: "",
    dimension: score ? null : dimension,
    grain: "month",
    series: null,
    metrics: measure ? [{ ref: measure, agg: "sum" }] : [],
    sort: { by: dimension === "time" ? "dimension" : "value", dir: dimension === "time" ? "asc" : "desc" },
    limit: score || dimension === "time" ? null : 10,
    dateRange: null,
    filters: [],
    width: score ? 3 : type === "table" || type === "pivot" ? 12 : 6,
    compare: score ? "previousYear" : "none",
    showLegend: true,
    showValues: false,
  };
}

/** An empty report over a source: one page, no charts yet. */
export function blankDefinition(source: string, dateField: string, dateRange: DateRange = { preset: "thisFy" }): ReportDefinition {
  return { v: 1, source, dateField, dateRange, filters: [], calculated: [], pages: [{ id: "p1", name: "Summary", charts: [] }] };
}

export const isCalcRef = (ref: string) => ref.startsWith("calc:");
export const calcIdOf = (ref: string) => ref.slice(5);

/** Which kinds take a breakdown, and how many metrics each draws. */
export function chartNeeds(type: ChartKind): { dimension: boolean; series: boolean; minMetrics: number; maxMetrics: number } {
  switch (type) {
    case "score":
      return { dimension: false, series: false, minMetrics: 1, maxMetrics: 1 };
    case "combo":
      return { dimension: true, series: false, minMetrics: 2, maxMetrics: 2 };
    case "pie":
    case "donut":
      return { dimension: true, series: false, minMetrics: 1, maxMetrics: 1 };
    case "pivot":
      return { dimension: true, series: true, minMetrics: 1, maxMetrics: 1 };
    case "table":
      return { dimension: true, series: false, minMetrics: 1, maxMetrics: LIMITS.metrics };
    default:
      return { dimension: true, series: false, minMetrics: 1, maxMetrics: 3 };
  }
}

/**
 * Why a chart can't be drawn yet, in the builder's words — or null when it can. Checked in the browser (the
 * "This chart isn't set up yet" state) and again on the server before it runs.
 */
export function chartProblem(chart: ReportChart): string | null {
  const need = chartNeeds(chart.type);
  if (chart.metrics.length < need.minMetrics) return need.minMetrics === 2 ? "Combo charts need two metrics: columns and a line." : "Add a metric to show.";
  if (chart.metrics.length > need.maxMetrics) return `${CHART_KIND_LABELS[chart.type]} charts show up to ${need.maxMetrics} metric${need.maxMetrics === 1 ? "" : "s"}.`;
  if (need.dimension && !chart.dimension) return chart.type === "pie" || chart.type === "donut" ? "Pie charts need a dimension to split by." : "Add a dimension to break it down by.";
  if (need.series && !chart.series) return "A pivot needs a second dimension for its columns.";
  if (need.series && chart.series === chart.dimension) return "A pivot's rows and columns need different dimensions.";
  return null;
}
