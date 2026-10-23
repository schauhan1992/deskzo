/**
 * check:reporting — Reporting & Analytics (owner, 23 Oct 2026), the parts that are arithmetic.
 *
 *   · A calculated field is arithmetic and nothing else: numbers, {fields}, + − × ÷ and brackets, parsed into a
 *     tree — never evaluated as code — every field one the source has, a ratio of the bucket's sums, nothing for
 *     a division by nothing.
 *   · Filters: include and exclude values, text conditions on a dimension, number conditions on a row's measure.
 *   · Aggregations: sum, average, least, most, count — an averaged measure over the rows that contribute only.
 *   · Charts: time buckets fill the quiet months, a limit keeps the top N (a pie folds the rest into Other), a
 *     total counts each record once, a pivot crosses two breakdowns, a score compares with another period.
 *   · A definition naming a field the source doesn't offer is refused in words that don't depend on it.
 *   · Date ranges: the financial year from April, the last one, months, and the periods a score compares with.
 *   · Every template names only fields its source really has, and validates as a definition.
 *
 * Pure — no database.
 *
 *   npm run check:reporting
 */
import { indiaClock } from "../src/lib/time/zone";
import { NONE, type FactSource } from "../src/lib/analytics/types";
import { evaluate, parseExpression } from "../src/lib/reporting/expression";
import { applyFilters, chartFieldProblem, compileCalculated, definitionProblem, periodsOf, reportProblem, runChart, ChartConfigError } from "../src/lib/reporting/engine";
import { blankChart, chartProblem, definitionSchema, type ReportChart, type ReportFilter } from "../src/lib/reporting/definition";
import { compareDays, rangeDays } from "../src/lib/reporting/window";
import { REPORT_TEMPLATES } from "../src/lib/reporting/templates";
import type { BucketsResult, PivotResult, ScoreResult } from "../src/lib/reporting/result";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const near = (a: number | null | undefined, b: number) => a !== null && a !== undefined && Math.abs(a - b) < 0.001;

// ─── A source small enough to work out by hand ───────────────────────────────

type Inv = { at: Date; customer: string; tags: string[]; status: string; net: number; received: number; days: number };
const d = (s: string) => new Date(`${s}T06:30:00Z`);
const ROWS: Inv[] = [
  { at: d("2026-04-05"), customer: "Aarav Traders", tags: ["Key"], status: "Paid", net: 100, received: 100, days: 0 },
  { at: d("2026-04-20"), customer: "Kaveri Foods", tags: ["Key", "North"], status: "Overdue", net: 300, received: 0, days: 10 },
  { at: d("2026-06-11"), customer: "Aarav Traders", tags: [], status: "Partially paid", net: 200, received: 50, days: 4 },
  { at: d("2026-06-30"), customer: "Sundar Textiles", tags: ["North"], status: "Paid", net: 400, received: 400, days: 0 },
  { at: d("2025-05-10"), customer: "Aarav Traders", tags: [], status: "Paid", net: 1000, received: 1000, days: 0 },
];
const source = {
  key: "invoices",
  label: "Invoices",
  description: "",
  moduleKey: null,
  companyAnchored: true,
  load: async () => ROWS,
  scopeNote: async () => "",
  dateFields: [{ key: "issueDate", label: "Issued on", get: (r: Inv) => r.at }],
  measures: [
    { key: "net", label: "Invoiced", unit: "currency", value: (r: Inv) => r.net },
    { key: "received", label: "Amount received", unit: "currency", value: (r: Inv) => r.received },
    { key: "days", label: "Days late", unit: "days", average: true, value: (r: Inv) => r.days },
    { key: "count", label: "Number of invoices", unit: "number", value: () => 1 },
  ],
  dimensions: [
    { key: "customer", label: "Customer", of: (r: Inv) => r.customer },
    { key: "status", label: "Payment status", of: (r: Inv) => r.status },
    { key: "tag", label: "Tag", multi: true, of: (r: Inv) => (r.tags.length ? r.tags : NONE) },
  ],
} as unknown as FactSource<never>;
const thisYear = ROWS.slice(0, 4) as unknown as never[];
const lastYear = ROWS.slice(4) as unknown as never[];
const window = { from: indiaClock.startOfDay("2026-04-01")!, to: indiaClock.endOfDay("2026-06-30")! };
const base = { source, clock: indiaClock, dateGet: (r: never) => (r as unknown as Inv).at, dateLabel: "Issued on", window };
const calcs = [{ id: "crate", label: "Collection rate", expression: "{received} / {net}", format: "percent" as const }];
const calc = compileCalculated(source, calcs);
const make = (type: ReportChart["type"], metric: string, dimension: string | null, more: Partial<ReportChart> = {}): ReportChart => ({ ...blankChart("x", type, metric, dimension), ...more });

section("Calculated fields: arithmetic and nothing else");
{
  const known = new Set(["net", "received", "count"]);
  const parsed = parseExpression("({received} - 50) / {net} * 100", known);
  ok("brackets, − × ÷ and numbers parse", parsed.ok && near(evaluate(parsed.expr, { received: 150, net: 200 }), 50), parsed);
  ok("× and ÷ typed as symbols work too", (() => { const p = parseExpression("{received} ÷ {net} × 100", known); return p.ok && near(evaluate(p.expr, { received: 1, net: 4 }), 25); })());
  ok("a unary minus", (() => { const p = parseExpression("-{net} + 10", known); return p.ok && near(evaluate(p.expr, { net: 4 }), 6); })());
  ok("a division by nothing is no figure, not infinity", (() => { const p = parseExpression("{received} / {net}", known); return p.ok && evaluate(p.expr, { received: 5, net: 0 }) === null; })());
  ok("a field with no figure makes no figure", (() => { const p = parseExpression("{received} + 1", known); return p.ok && evaluate(p.expr, { received: null }) === null; })());
  for (const [text, why] of [
    ["{cost} / {net}", "a field the source hasn't"],
    ["process.exit()", "code"],
    ["{net} ** 2", "two operators"],
    ["({net} / 2", "an unclosed bracket"],
    ["42", "a constant with no field"],
    ["{net} {received}", "a missing operator"],
    ["{net", "an unclosed reference"],
    ["", "nothing"],
  ] as const) {
    const p = parseExpression(text, known);
    ok(`refused: ${why}`, !p.ok, p.ok ? "parsed" : p.error);
  }
  ok("a very long expression is refused", !parseExpression(Array(80).fill("{net}").join(" + "), known).ok);
}

section("Filters");
{
  const f = (field: string, op: ReportFilter["op"], extra: Partial<ReportFilter> = {}): ReportFilter => ({ id: "f", field, op, ...extra });
  const count = (filters: ReportFilter[]) => applyFilters(source, thisYear, filters).length;
  ok("is any of", count([f("customer", "in", { values: ["Aarav Traders", "Kaveri Foods"] })]) === 3);
  ok("…case doesn't matter", count([f("customer", "in", { values: ["aarav traders"] })]) === 2);
  ok("is none of", count([f("status", "notIn", { values: ["Paid"] })]) === 2);
  ok("contains / starts with / is exactly", count([f("customer", "contains", { text: "food" })]) === 1 && count([f("customer", "startsWith", { text: "Sun" })]) === 1 && count([f("customer", "equals", { text: "Kaveri" })]) === 0);
  ok("a multi-valued field matches on any of its values", count([f("tag", "in", { values: ["North"] })]) === 2);
  ok("is empty: no tag at all", count([f("tag", "isEmpty")]) === 1);
  ok("a number condition is on each row: net > 150", count([f("net", "gt", { number: 150 })]) === 3);
  ok("between, either way round", count([f("net", "between", { number: 350, number2: 150 })]) === 2);
  ok("every filter must hold", count([f("customer", "in", { values: ["Aarav Traders"] }), f("net", "lt", { number: 150 })]) === 1);
}

section("Aggregations");
{
  const run = (agg: "sum" | "avg" | "min" | "max" | "count", metric = "net") =>
    (runChart({ ...base, rows: thisYear, chart: make("table", metric, "customer", { metrics: [{ ref: metric, agg }], limit: null }), calc }) as BucketsResult).totals[0];
  ok("sum", near(run("sum"), 1000));
  ok("average", near(run("avg"), 250));
  ok("least and most", near(run("min"), 100) && near(run("max"), 400));
  ok("count of rows", run("count") === 4);
  ok("an averaged measure counts only the rows it applies to: (10 + 4) / 2", near(run("avg", "days"), 7));
  const ratio = (runChart({ ...base, rows: thisYear, chart: make("table", "net", "customer", { metrics: [{ ref: "calc:crate", agg: "sum" }], limit: null }), calc }) as BucketsResult);
  ok("a calculated field is a ratio of the sums: 550 / 1000", near(ratio.totals[0], 0.55), ratio.totals);
  const aarav = ratio.buckets.find((b) => b.label === "Aarav Traders")!;
  ok("…in each bucket too: Aarav 150 / 300", near(aarav.values[0], 0.5), aarav);
}

section("Charts");
{
  const byMonth = runChart({ ...base, rows: thisYear, chart: make("column", "net", "time", { limit: null }), calc }) as BucketsResult;
  ok("time fills the quiet month: Apr, May, Jun", byMonth.buckets.map((b) => `${b.label}:${b.values[0]}`).join(" ") === "Apr 26:400 May 26:0 Jun 26:600", byMonth.buckets);
  ok("the periods of a window", periodsOf(window.from, window.to, "quarter", indiaClock).map((p) => p.key).join(",") === "2026-Q2");
  const top = runChart({ ...base, rows: thisYear, chart: make("bar", "net", "customer", { limit: 2 }), calc }) as BucketsResult;
  ok("a limit keeps the top two by value — a tie broken by name", top.buckets.map((b) => b.label).join(",") === "Sundar Textiles,Aarav Traders" && top.hidden === 1, top.buckets);
  const pie = runChart({ ...base, rows: thisYear, chart: make("donut", "net", "customer", { limit: 2 }), calc }) as BucketsResult;
  ok("a pie folds the rest into Other, so it keeps its whole", pie.buckets.at(-1)?.label === "Other" && near(pie.buckets.at(-1)?.values[0] ?? null, 300), pie.buckets);
  const tags = runChart({ ...base, rows: thisYear, chart: make("bar", "net", "tag", { limit: null }), calc }) as BucketsResult;
  ok("a record in two tags is in both bars — and counted once in the total", tags.doubleCounted && near(tags.totals[0], 1000) && near(tags.buckets.find((b) => b.label === "Key")?.values[0] ?? null, 400), tags);
  const piv = runChart({ ...base, rows: thisYear, chart: make("pivot", "net", "customer", { series: "status", limit: null }), calc }) as PivotResult;
  const aarav = piv.rows.find((r) => r.label === "Aarav Traders")!;
  ok("a pivot crosses customer and status", piv.columns.length === 3 && near(aarav.total, 300) && near(piv.grand, 1000), piv);
  const sc = runChart({ ...base, rows: thisYear, chart: make("score", "net", null), calc, compareRows: lastYear, compareLabel: "vs last year" }) as ScoreResult;
  ok("a score, against last year", near(sc.value, 1000) && near(sc.previous, 1000) && sc.compareLabel === "vs last year" && sc.spark.length >= 3, sc);
  let refused = "";
  try {
    runChart({ ...base, rows: thisYear, chart: make("donut", "net", null), calc });
  } catch (e) {
    refused = e instanceof ChartConfigError ? e.message : "other";
  }
  ok("a pie with nothing to split by isn't drawn, and says why", refused === "Pie charts need a dimension to split by.", refused);
  ok("a combo needs two metrics", chartProblem(make("combo", "net", "time")) === "Combo charts need two metrics: columns and a line.");
}

section("A definition naming a field the source doesn't offer");
{
  const def = { v: 1 as const, source: "invoices", dateField: "issueDate", dateRange: { preset: "thisFy" as const }, filters: [], calculated: calcs, pages: [{ id: "p1", name: "Summary", charts: [make("bar", "net", "customer")] }] };
  ok("a good one passes", definitionProblem(source, def) === null);
  ok("an unknown breakdown is refused", !!chartFieldProblem(source, make("bar", "net", "cf:company:secret"), calcs)?.includes("isn't something you can report"));
  ok("an unknown metric is refused in the same words", !!chartFieldProblem(source, make("bar", "landed_cost", "customer"), calcs)?.includes("may have been removed, or not be open to you"));
  ok("an unknown report filter is refused", !!reportProblem(source, { ...def, filters: [{ id: "f", field: "margin", op: "gt", number: 1 }] }));
  ok("a calculated field over an unknown metric is refused", !!reportProblem(source, { ...def, calculated: [{ id: "cx", label: "X", expression: "{cost} / {net}", format: "number" }] }));
  ok("a snapshot source can't be charted over time", !!chartFieldProblem(source, make("column", "net", "time"), calcs, { snapshot: true })?.includes("snapshot"));
}

section("Date ranges");
{
  ok("this financial year runs from 1 April", JSON.stringify(rangeDays({ preset: "thisFy" }, "2026-10-23")) === JSON.stringify({ from: "2026-04-01", to: "2026-10-23", label: "1 Apr – 23 Oct 2026" }));
  ok("…in February, from the April before", rangeDays({ preset: "thisFy" }, "2027-02-10").from === "2026-04-01");
  const last = rangeDays({ preset: "lastFy" }, "2026-10-23");
  ok("last financial year, whole", last.from === "2025-04-01" && last.to === "2026-03-31", last);
  const lm = rangeDays({ preset: "lastMonth" }, "2026-03-15");
  ok("last month, whole — February", lm.from === "2026-02-01" && lm.to === "2026-02-28", lm);
  ok("last 30 days ends today", JSON.stringify(rangeDays({ preset: "last30" }, "2026-10-23")).includes('"from":"2026-09-24"'));
  const ly = compareDays({ from: "2026-04-01", to: "2026-10-23" }, "previousYear");
  ok("compared with the same days last year", ly.from === "2025-04-01" && ly.to === "2025-10-23" && ly.against === "vs last year", ly);
  const pp = compareDays({ from: "2026-10-01", to: "2026-10-10" }, "previousPeriod");
  ok("compared with the ten days before", pp.from === "2026-09-21" && pp.to === "2026-09-30", pp);
}

section("Templates name only what their sources have");
{
  // The real sources' field lists, read without a database: the registry's own entries.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { FACT_SOURCES } = require("../src/lib/analytics/sources") as typeof import("../src/lib/analytics/sources");
  const { stockSource, expensesSource } = require("../src/lib/reporting/extra-sources") as typeof import("../src/lib/reporting/extra-sources");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const all = [...FACT_SOURCES, stockSource, expensesSource] as unknown as FactSource<never>[];
  for (const t of REPORT_TEMPLATES) {
    const src = all.find((s) => s.key === t.definition.source)!;
    const parsed = definitionSchema.safeParse(t.definition);
    const problem = src ? definitionProblem(src, t.definition, { snapshot: t.definition.source === "stock" }) : "no such source";
    const unready = t.definition.pages.flatMap((p) => p.charts).map(chartProblem).filter(Boolean);
    ok(`${t.name} (${t.definition.source})`, parsed.success && problem === null && unready.length === 0, parsed.success ? (problem ?? unready.join("; ")) : parsed.error.issues[0]?.message);
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
