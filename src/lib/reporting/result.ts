/**
 * What a report chart comes back as (src/lib/reporting/engine.ts), for the builder and the viewer to draw.
 * Plain data — no rows, nothing a chart doesn't show.
 */

export type MetricUnit = "currency" | "number" | "days" | "percent";

export type MetricMeta = { ref: string; label: string; unit: MetricUnit };

export type ScoreResult = {
  kind: "score";
  metric: MetricMeta;
  value: number | null;
  /** The same figure over the period compared against, when the chart compares. */
  previous: number | null;
  compareLabel: string | null;
  /** The figure month by month (week by week over a short window) across the window, for the sparkline. */
  spark: number[];
};

export type BucketsResult = {
  kind: "buckets";
  dimension: { key: string; label: string; time: boolean };
  metrics: MetricMeta[];
  buckets: { key: string; label: string; values: (number | null)[] }[];
  /** Each metric over every row counted — once each, not the sum of the buckets. */
  totals: (number | null)[];
  /** Buckets left off by the chart's limit (folded into "Other" for a pie). */
  hidden: number;
  /** A record fell in more than one bucket (a two-tag account), so the parts exceed the whole. */
  doubleCounted: boolean;
};

export type PivotResult = {
  kind: "pivot";
  metric: MetricMeta;
  rowDimension: { key: string; label: string };
  columnDimension: { key: string; label: string };
  columns: { key: string; label: string }[];
  rows: { key: string; label: string; cells: (number | null)[]; total: number | null }[];
  columnTotals: (number | null)[];
  grand: number | null;
  hiddenRows: number;
  hiddenColumns: number;
};

export type ChartResult = ScoreResult | BucketsResult | PivotResult;

export type ChartRun =
  | { ok: true; result: ChartResult; rowCount: number; truncated: boolean; scopeNote: string }
  | { ok: false; error: string; code: "config" | "field" | "source" | "migrate" | "denied" };

export const OTHER = "Other";
