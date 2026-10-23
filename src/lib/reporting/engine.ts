import { bucketOf, NONE, type FactSource, type Grain, type Measure } from "@/lib/analytics/types";
import type { Clock } from "@/lib/time/zone";
import { evaluate, parseExpression, type Expr } from "./expression";
import { calcIdOf, chartNeeds, chartProblem, isCalcRef, type Aggregation, type CalculatedField, type ReportChart, type ReportDefinition, type ReportFilter } from "./definition";
import { OTHER, type BucketsResult, type ChartResult, type MetricMeta, type MetricUnit, type PivotResult, type ScoreResult } from "./result";

/**
 * Turning a source's rows into a chart (Reporting & Analytics, owner 23 Oct 2026).
 *
 * Pure: rows in, figures out. The rows were loaded already — as the person asking, through the source's own
 * access rule (src/lib/reporting/run.ts) — so nothing here can widen what anybody sees; it only counts. The same
 * engine draws a chart in the builder's preview, the viewer, and the CSV, so the three can't disagree.
 *
 * Buckets follow the analytics engine (src/lib/analytics/run.ts): a dimension is a function from a row to its
 * bucket (or buckets — a two-tag account is in both), time is the workspace's own calendar, and an averaged
 * measure counts only the rows that contribute to it.
 */

type Row = never;
type Source = FactSource<Row>;

export type CompiledCalc = { field: CalculatedField; expr: Expr; refs: string[] };

/** A definition's calculated fields, parsed against the source's measures; a field that doesn't parse is left out. */
export function compileCalculated(source: Source, calculated: readonly CalculatedField[]): Map<string, CompiledCalc> {
  const known = new Set(source.measures.map((m) => m.key));
  const out = new Map<string, CompiledCalc>();
  for (const field of calculated) {
    const parsed = parseExpression(field.expression, known);
    if (parsed.ok) out.set(field.id, { field, expr: parsed.expr, refs: parsed.refs });
  }
  return out;
}

const unknownField = (source: Source, key: string) =>
  `“${key}” isn't something you can report ${source.label.toLowerCase()} by — it may have been removed, or not be open to you.`;

function filterProblem(source: Source, f: ReportFilter): string | null {
  return source.dimensions.some((d) => d.key === f.field) || source.measures.some((m) => m.key === f.field) ? null : unknownField(source, f.field);
}

/**
 * The first thing the report as a whole names that this source doesn't offer the person running it — its date
 * field, a report filter, a calculated field — said in the same words whether it never existed or is a field they
 * may not see, so a refusal can't be used to find out what the restricted fields are called (as
 * src/lib/analytics/request.ts unknownKey). Null when everything is there.
 */
export function reportProblem(source: Source, def: Pick<ReportDefinition, "dateField" | "filters" | "calculated">): string | null {
  if (!source.dateFields.some((f) => f.key === def.dateField)) return unknownField(source, def.dateField);
  const measures = new Set(source.measures.map((m) => m.key));
  for (const c of def.calculated) {
    const parsed = parseExpression(c.expression, measures);
    if (!parsed.ok) return `${c.label}: ${parsed.error}`;
  }
  for (const f of def.filters) {
    const p = filterProblem(source, f);
    if (p) return p;
  }
  return null;
}

/** The same for one chart: a field it breaks down by, a metric or a chart filter this person can't use. */
export function chartFieldProblem(source: Source, chart: ReportChart, calculated: readonly CalculatedField[], opts: { snapshot?: boolean } = {}): string | null {
  const dims = new Set(source.dimensions.map((d) => d.key));
  for (const key of [chart.dimension, chart.series]) {
    if (key === "time" && opts.snapshot) return `${source.label} is a snapshot of today — it has no dates to chart over time.`;
    if (key && key !== "time" && !dims.has(key)) return unknownField(source, key);
  }
  const calcIds = new Set(calculated.map((c) => c.id));
  for (const m of chart.metrics) {
    if (isCalcRef(m.ref) ? !calcIds.has(calcIdOf(m.ref)) : !source.measures.some((x) => x.key === m.ref)) return unknownField(source, m.ref);
  }
  for (const f of chart.filters) {
    const p = filterProblem(source, f);
    if (p) return p;
  }
  return null;
}

/** Everything a definition names, report and charts — for saving, where every part has to hold. */
export function definitionProblem(source: Source, def: ReportDefinition, opts: { snapshot?: boolean } = {}): string | null {
  const report = reportProblem(source, def);
  if (report) return report;
  for (const page of def.pages) {
    for (const chart of page.charts) {
      const p = chartFieldProblem(source, chart, def.calculated, opts);
      if (p) return `${chart.title || "A chart"}: ${p}`;
    }
  }
  return null;
}

// ─── Filters ─────────────────────────────────────────────────────────────────

const lower = (v: string) => v.toLocaleLowerCase("en-IN");
const asList = (v: string | string[]) => (Array.isArray(v) ? v : [v]);
const isBlank = (v: string) => v === NONE || v.trim() === "";

/** Whether a row passes a filter — on a dimension's value(s), or on a measure's value on that row. */
export function rowPasses(source: Source, row: Row, f: ReportFilter): boolean {
  const dim = source.dimensions.find((d) => d.key === f.field);
  if (dim) {
    const values = asList(dim.of(row));
    const wanted = new Set((f.values ?? []).map(lower));
    const text = lower(f.text ?? "");
    switch (f.op) {
      case "in":
        return wanted.size === 0 || values.some((v) => wanted.has(lower(v)));
      case "notIn":
        return !values.some((v) => wanted.has(lower(v)));
      case "contains":
        return values.some((v) => lower(v).includes(text));
      case "notContains":
        return !values.some((v) => lower(v).includes(text));
      case "startsWith":
        return values.some((v) => lower(v).startsWith(text));
      case "equals":
        return values.some((v) => lower(v) === text);
      case "isEmpty":
        return values.every(isBlank);
      case "isNotEmpty":
        return values.some((v) => !isBlank(v));
      default:
        return true;
    }
  }
  const measure = source.measures.find((m) => m.key === f.field);
  if (!measure) return false;
  const v = measure.value(row);
  const a = f.number ?? 0;
  const b = f.number2 ?? a;
  switch (f.op) {
    case "gt":
      return v > a;
    case "gte":
      return v >= a;
    case "lt":
      return v < a;
    case "lte":
      return v <= a;
    case "eq":
      return Math.abs(v - a) < 0.005;
    case "between":
      return v >= Math.min(a, b) && v <= Math.max(a, b);
    case "isEmpty":
      return v === 0;
    default:
      return true;
  }
}

export function applyFilters(source: Source, rows: Row[], filters: readonly ReportFilter[]): Row[] {
  if (filters.length === 0) return rows;
  return rows.filter((row) => filters.every((f) => rowPasses(source, row, f)));
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

type Acc = { sum: number; n: number; min: number; max: number; rows: number };
const emptyAcc = (): Acc => ({ sum: 0, n: 0, min: Infinity, max: -Infinity, rows: 0 });

function add(acc: Acc, measure: Measure<Row>, row: Row) {
  const v = measure.value(row);
  acc.rows += 1;
  // An averaged measure ignores the rows that don't contribute — an unresolved ticket has no resolution time.
  if (measure.average && !(v > 0)) return;
  acc.sum += v;
  acc.n += 1;
  if (v < acc.min) acc.min = v;
  if (v > acc.max) acc.max = v;
}

function finish(acc: Acc, agg: Aggregation): number | null {
  switch (agg) {
    case "sum":
      return acc.sum;
    case "count":
      return acc.rows;
    case "avg":
      return acc.n ? acc.sum / acc.n : null;
    case "min":
      return acc.n ? acc.min : null;
    case "max":
      return acc.n ? acc.max : null;
  }
}

/** The aggregation a measure means by default: an averaged measure's average, everything else's sum. */
export const defaultAgg = (m: Measure<Row>): Aggregation => (m.average ? "avg" : "sum");

/** Which aggregations a measure offers: a count is only ever added up; an average averaged, at its least or most. */
export function aggregationsFor(m: Pick<Measure<Row>, "key" | "average" | "unit">): Aggregation[] {
  if (m.key === "count") return ["sum"];
  if (m.average) return ["avg", "min", "max"];
  return ["sum", "avg", "min", "max", "count"];
}

/**
 * A chart's metrics as a list of readers: each a function from a set of rows to its figure. Calculated fields
 * read their measures at each one's own default aggregation, then do the arithmetic on the totals.
 */
function metricReaders(source: Source, chart: ReportChart, calc: Map<string, CompiledCalc>) {
  return chart.metrics.map((m) => {
    if (isCalcRef(m.ref)) {
      const c = calc.get(calcIdOf(m.ref));
      if (!c) throw new ChartConfigError("This chart uses a calculated field that isn't there any more.");
      const measures = c.refs.map((ref) => source.measures.find((x) => x.key === ref)!);
      const meta: MetricMeta = { ref: m.ref, label: c.field.label, unit: c.field.format === "percent" ? "percent" : c.field.format === "currency" ? "currency" : "number" };
      return {
        meta,
        read(rows: Row[]): number | null {
          const accs = measures.map(() => emptyAcc());
          for (const row of rows) measures.forEach((x, i) => add(accs[i]!, x, row));
          const values: Record<string, number | null> = {};
          measures.forEach((x, i) => (values[x.key] = finish(accs[i]!, defaultAgg(x))));
          return evaluate(c.expr, values);
        },
      };
    }
    const measure = source.measures.find((x) => x.key === m.ref);
    if (!measure) throw new ChartConfigError("This chart uses a metric that isn't there any more.");
    const agg = aggregationsFor(measure).includes(m.agg) ? m.agg : defaultAgg(measure);
    const unit: MetricUnit = agg === "count" ? "number" : measure.unit;
    const prefix = agg === "count" ? "Count of " : agg === "avg" && !measure.average ? "Average " : agg === "min" ? "Lowest " : agg === "max" ? "Highest " : "";
    const meta: MetricMeta = { ref: m.ref, label: `${prefix}${prefix ? measure.label.charAt(0).toLowerCase() + measure.label.slice(1) : measure.label}`, unit };
    return {
      meta,
      read(rows: Row[]): number | null {
        const acc = emptyAcc();
        for (const row of rows) add(acc, measure, row);
        return finish(acc, agg);
      },
    };
  });
}

export class ChartConfigError extends Error {}

// ─── Buckets ─────────────────────────────────────────────────────────────────

type Bucketer = { key: string; label: string; time: boolean; of: (row: Row) => { key: string; label: string }[] };

function bucketer(source: Source, key: string, grain: Grain, dateGet: (row: Row) => Date | null, clock: Clock, dateLabel: string): Bucketer {
  if (key === "time") {
    return {
      key,
      label: `${dateLabel} (${grain})`,
      time: true,
      of: (row) => {
        const at = dateGet(row);
        return at ? [bucketOf(at, grain, clock)] : [{ key: "~none", label: NONE }];
      },
    };
  }
  const dim = source.dimensions.find((d) => d.key === key);
  if (!dim) throw new ChartConfigError("This chart is broken down by a field that isn't there any more.");
  return { key, label: dim.label, time: false, of: (row) => asList(dim.of(row)).map((v) => ({ key: v, label: v })) };
}

/** Every period a window spans at a grain, so a time chart shows the quiet months as nothing rather than skipping them. */
export function periodsOf(from: Date, to: Date, grain: Grain, clock: Clock): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const seen = new Set<string>();
  // Walk the window a day at a time on the workspace's calendar; at most ~4 years of days.
  const start = clock.dateKey(from);
  const end = clock.dateKey(new Date(to.getTime() - 1));
  let day = start;
  for (let i = 0; i < 1500 && day <= end; i += 1) {
    const at = clock.startOfDay(day);
    if (!at) break;
    const b = bucketOf(at, grain, clock);
    if (!seen.has(b.key)) {
      seen.add(b.key);
      out.push(b);
    }
    day = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }
  return out;
}

function groupRows(rows: Row[], b: Bucketer) {
  const groups = new Map<string, { label: string; rows: Row[] }>();
  let doubleCounted = false;
  for (const row of rows) {
    const keys = b.of(row);
    if (keys.length > 1) doubleCounted = true;
    for (const k of keys) {
      const g = groups.get(k.key) ?? { label: k.label, rows: [] };
      g.rows.push(row);
      groups.set(k.key, g);
    }
  }
  return { groups, doubleCounted };
}

export type RunInput = {
  source: Source;
  rows: Row[];
  chart: ReportChart;
  calc: Map<string, CompiledCalc>;
  clock: Clock;
  /** The report's date field, for time buckets and the sparkline. */
  dateGet: (row: Row) => Date | null;
  dateLabel: string;
  window: { from: Date; to: Date };
  /** A score's comparison rows, already loaded over the period compared against. */
  compareRows?: Row[] | null;
  compareLabel?: string | null;
  /** A snapshot of today (stock on hand): its rows' dates aren't a history, so a score draws no trend line. */
  snapshot?: boolean;
};

export function runChart(input: RunInput): ChartResult {
  const { source, rows, chart, calc, clock } = input;
  const problem = chartProblem(chart);
  if (problem) throw new ChartConfigError(problem);
  const readers = metricReaders(source, chart, calc);

  if (chart.type === "score") return score(input, readers[0]!);
  if (chart.type === "pivot") return pivot(input, readers[0]!);

  const b = bucketer(source, chart.dimension!, chart.grain, input.dateGet, clock, input.dateLabel);
  const { groups, doubleCounted } = groupRows(rows, b);
  let entries = [...groups.entries()].map(([key, g]) => ({ key, label: g.label, rows: g.rows }));
  if (b.time) {
    // Every period in the window, the empty ones as nothing — then whatever had no date, at the end.
    const known = new Map(entries.map((e) => [e.key, e]));
    const filled = periodsOf(input.window.from, input.window.to, chart.grain, clock).map((p) => known.get(p.key) ?? { key: p.key, label: p.label, rows: [] as Row[] });
    const extra = entries.filter((e) => !filled.some((f) => f.key === e.key));
    entries = [...filled, ...extra];
  }
  let buckets = entries.map((e) => ({ key: e.key, label: e.label, rows: e.rows, values: readers.map((r) => r.read(e.rows)) }));

  const dir = chart.sort.dir === "asc" ? 1 : -1;
  if (chart.sort.by === "value") {
    buckets.sort((x, y) => {
      const a = x.values[0];
      const c = y.values[0];
      if (a === null || a === undefined) return 1;
      if (c === null || c === undefined) return -1;
      // A tie is broken by name, so the same figures always draw in the same order.
      return (a - c) * dir || x.label.localeCompare(y.label, "en-IN", { numeric: true });
    });
  } else if (b.time) {
    buckets.sort((x, y) => x.key.localeCompare(y.key) * dir);
  } else {
    buckets.sort((x, y) => x.label.localeCompare(y.label, "en-IN", { numeric: true }) * dir);
  }

  let hidden = 0;
  if (chart.limit && buckets.length > chart.limit) {
    hidden = buckets.length - chart.limit;
    const kept = buckets.slice(0, chart.limit);
    if (chart.type === "pie" || chart.type === "donut") {
      // A pie keeps its whole: the rest as one slice.
      const restRows = [...new Set(buckets.slice(chart.limit).flatMap((x) => x.rows))];
      kept.push({ key: "~other", label: OTHER, rows: restRows, values: readers.map((r) => r.read(restRows)) });
    }
    buckets = kept;
  }

  const result: BucketsResult = {
    kind: "buckets",
    dimension: { key: b.key, label: b.label, time: b.time },
    metrics: readers.map((r) => r.meta),
    buckets: buckets.map((x) => ({ key: x.key, label: x.label, values: x.values })),
    totals: readers.map((r) => r.read(rows)),
    hidden,
    doubleCounted,
  };
  return result;
}

function score(input: RunInput, reader: ReturnType<typeof metricReaders>[number]): ScoreResult {
  const { rows, clock, window } = input;
  const days = (window.to.getTime() - window.from.getTime()) / 86_400_000;
  const grain: Grain = days > 62 ? "month" : days > 14 ? "week" : "day";
  const periods = periodsOf(window.from, window.to, grain, clock);
  const byPeriod = new Map<string, Row[]>(periods.map((p) => [p.key, []]));
  for (const row of rows) {
    const at = input.dateGet(row);
    if (!at) continue;
    byPeriod.get(bucketOf(at, grain, clock).key)?.push(row);
  }
  const spark = input.snapshot ? [] : periods.map((p) => reader.read(byPeriod.get(p.key) ?? []) ?? 0);
  return {
    kind: "score",
    metric: reader.meta,
    value: reader.read(rows),
    previous: input.compareRows ? reader.read(input.compareRows) : null,
    compareLabel: input.compareRows ? (input.compareLabel ?? null) : null,
    spark: spark.length > 24 ? spark.slice(-24) : spark,
  };
}

const PIVOT_COLUMNS = 12;
const PIVOT_ROWS = 50;

function pivot(input: RunInput, reader: ReturnType<typeof metricReaders>[number]): PivotResult {
  const { source, rows, chart, clock } = input;
  const rb = bucketer(source, chart.dimension!, chart.grain, input.dateGet, clock, input.dateLabel);
  const cb = bucketer(source, chart.series!, chart.grain, input.dateGet, clock, input.dateLabel);
  const rowGroups = groupRows(rows, rb).groups;
  const colGroups = groupRows(rows, cb).groups;
  // Columns: the biggest by the metric (time in order), folding the rest into Other.
  let columns = [...colGroups.entries()].map(([key, g]) => ({ key, label: g.label, rows: g.rows, total: reader.read(g.rows) }));
  if (cb.time) columns.sort((a, b) => a.key.localeCompare(b.key));
  else columns.sort((a, b) => (b.total ?? -Infinity) - (a.total ?? -Infinity));
  let hiddenColumns = 0;
  if (columns.length > PIVOT_COLUMNS) {
    hiddenColumns = columns.length - (PIVOT_COLUMNS - 1);
    const rest = columns.slice(PIVOT_COLUMNS - 1);
    const restRows = [...new Set(rest.flatMap((c) => c.rows))];
    columns = [...columns.slice(0, PIVOT_COLUMNS - 1), { key: "~other", label: OTHER, rows: restRows, total: reader.read(restRows) }];
  }
  const colOf = new Map<Row, Set<string>>();
  for (const c of columns) for (const row of c.rows) (colOf.get(row) ?? colOf.set(row, new Set()).get(row)!).add(c.key);

  let pivotRows = [...rowGroups.entries()].map(([key, g]) => ({
    key,
    label: g.label,
    cells: columns.map((c) => reader.read(g.rows.filter((row) => colOf.get(row)?.has(c.key)))),
    total: reader.read(g.rows),
  }));
  const dir = chart.sort.dir === "asc" ? 1 : -1;
  if (chart.sort.by === "value") pivotRows.sort((a, b) => ((a.total ?? -Infinity) - (b.total ?? -Infinity)) * dir);
  else if (rb.time) pivotRows.sort((a, b) => a.key.localeCompare(b.key) * dir);
  else pivotRows.sort((a, b) => a.label.localeCompare(b.label, "en-IN", { numeric: true }) * dir);
  const cap = Math.min(chart.limit ?? PIVOT_ROWS, PIVOT_ROWS);
  const hiddenRows = Math.max(0, pivotRows.length - cap);
  pivotRows = pivotRows.slice(0, cap);

  return {
    kind: "pivot",
    metric: reader.meta,
    rowDimension: { key: rb.key, label: rb.label },
    columnDimension: { key: cb.key, label: cb.label },
    columns: columns.map((c) => ({ key: c.key, label: c.label })),
    rows: pivotRows,
    columnTotals: columns.map((c) => c.total),
    grand: reader.read(rows),
    hiddenRows,
    hiddenColumns,
  };
}

/** A chart's figures as rows of text, for the CSV — the same numbers the chart draws. */
export function resultTable(result: ChartResult): string[][] {
  const n = (v: number | null) => (v === null ? "" : String(Math.round(v * 100) / 100));
  if (result.kind === "score") return [[result.metric.label, ...(result.compareLabel ? [`Previous (${result.compareLabel})`] : [])], [n(result.value), ...(result.compareLabel ? [n(result.previous)] : [])]];
  if (result.kind === "pivot") {
    return [
      [result.rowDimension.label, ...result.columns.map((c) => c.label), "Total"],
      ...result.rows.map((r) => [r.label, ...r.cells.map(n), n(r.total)]),
      ["Total", ...result.columnTotals.map(n), n(result.grand)],
    ];
  }
  return [
    [result.dimension.label, ...result.metrics.map((m) => m.label)],
    ...result.buckets.map((b) => [b.label, ...b.values.map(n)]),
    ["Total", ...result.totals.map(n)],
  ];
}

export { chartNeeds };
