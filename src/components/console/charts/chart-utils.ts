import { formatMoney } from "@/lib/billing/money";

/**
 * Arithmetic and wording shared by the console's charts.
 *
 * Every chart in this folder is hand-written SVG rendered on the server — no chart library, no
 * `"use client"`, nothing to hydrate — for the reasons `src/components/reports/report-chart.tsx`
 * gives. Colour is always `currentColor` under a token class, so dark mode and the white-label
 * brand colour need no code here at all.
 */

/**
 * A mark's colour. The six `chart-*` tones say which series a mark belongs to; the status tones
 * (`success` … `danger`) say something is good or bad and are kept for exactly that.
 */
export type ChartTone =
  | "chart-1"
  | "chart-2"
  | "chart-3"
  | "chart-4"
  | "chart-5"
  | "chart-6"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "muted"
  | "brand";

/**
 * How a value is written.
 *
 * - `"number"` — a count, grouped the Indian way (12,34,567).
 * - `"percent"` — the value is already a percentage: 42 is "42%", never 0.42.
 * - `"tokens"` — compact: 842, "42k", "1.2M".
 * - `{ currency }` — minor units (paise, cents) of that ONE currency, written by `formatMoney`.
 *   A chart never mixes currencies; the page offers a switcher instead.
 */
export type ChartFormat = "number" | "percent" | "tokens" | { currency: string };

export type ChartPoint = { label: string; value: number };

export const CHART_TONE_CLASS: Record<ChartTone, string> = {
  "chart-1": "text-chart-1",
  "chart-2": "text-chart-2",
  "chart-3": "text-chart-3",
  "chart-4": "text-chart-4",
  "chart-5": "text-chart-5",
  "chart-6": "text-chart-6",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
  muted: "text-subtle",
  brand: "text-brand",
};

/**
 * The series tones in their fixed order. Hand them out by a series' place in a fixed list, never by
 * its rank in today's data: a series that drops out must not repaint the ones that remain.
 */
export const CHART_SERIES = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "chart-6"] as const satisfies readonly ChartTone[];

/** Gridlines and axis text, as every chart draws them. */
export const GRID_CLASS = "stroke-current text-line";
export const AXIS_TEXT_CLASS = "fill-current text-[10px] text-subtle tabular-nums";

const SAME_FIGURES = "The same figures are in the table.";

/** A value safe to draw: NaN and the infinities become 0 rather than a path that breaks the SVG. */
export function finiteValue(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

// Compact counts ("42K") written lower-case, the way people write a token count.
const COMPACT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const COMPACT_IN = new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 });

/** The exact reading of a value — for titles, legends and summaries. */
export function formatChartValue(value: number, format: ChartFormat): string {
  const v = finiteValue(value);
  if (typeof format === "object") return formatMoney(Math.round(v), format.currency);
  if (format === "percent") return `${Math.round(v).toLocaleString("en-IN")}%`;
  if (format === "tokens") return COMPACT.format(v).replace("K", "k");
  return v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

/**
 * The short reading of a value, for an axis tick: "₹1.5L", "$150K", "25k".
 *
 * Ticks are round numbers that label a position, not figures anybody copies out — those are in the
 * titles and the table, written exactly. Compact money keeps a tick from being wider than the
 * plot's margin ("₹1,50,000.00" is twelve characters of axis for one gridline).
 */
export function formatAxisValue(value: number, format: ChartFormat): string {
  const v = finiteValue(value);
  if (typeof format === "object") {
    const code = format.currency.toUpperCase();
    const locale = code === "INR" ? "en-IN" : "en";
    try {
      // Divided by the currency's own minor-unit count, exactly as formatMoney does: ¥ has none.
      const digits = new Intl.NumberFormat(locale, { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: code,
        notation: "compact",
        minimumFractionDigits: 0,
        maximumFractionDigits: 1,
      }).format(v / 10 ** digits);
    } catch {
      return formatChartValue(v, format);
    }
  }
  if (format === "number" && Math.abs(v) >= 10_000) return COMPACT_IN.format(v);
  return formatChartValue(v, format);
}

/**
 * A round step near `raw`: 1, 2 or 5 × 10ⁿ, and 2.5 × 10ⁿ from 25 up (a step of 2.5 or 0.25 puts
 * fractions on an axis of whole things).
 */
function niceStep(raw: number): number {
  const exp = Math.floor(Math.log10(raw));
  const base = 10 ** exp;
  for (const m of exp >= 1 ? [1, 2, 2.5, 5] : [1, 2, 5]) {
    if (m * base >= raw * (1 - 1e-9)) return m * base;
  }
  return 10 * base;
}

/**
 * Gridline values from 0 up to a round top that is at least `max`: about `count` intervals, each a
 * round step, so ticks read 0 · 50 · 100 · 150 rather than 0 · 47.3 · 94.7 · 142.
 *
 * A top of one or more never gets a fractional step — counts are whole things, and "2.5
 * workspaces" is a gridline that can only mislead. Nothing (or nothing positive) to plot still
 * gets an axis, 0 to 1, so an all-zero chart draws its baseline instead of dividing by zero.
 */
export function ticks(max: number, count = 4): number[] {
  const top = finiteValue(max) > 0 ? max : 1;
  const parts = Math.max(1, Math.round(finiteValue(count)) || 1);
  let step = niceStep(top / parts);
  if (top >= 1) step = Math.max(step, 1);
  const intervals = Math.max(1, Math.ceil(top / step - 1e-9));
  return Array.from({ length: intervals + 1 }, (_, i) => Number((i * step).toPrecision(12)));
}

/** The round top `ticks` would give an axis for `n` — for two charts that must share one scale. */
export function niceMax(n: number): number {
  const all = ticks(n);
  return all[all.length - 1]!;
}

/**
 * The one-sentence reading of a series, for its `aria-label`: what it is, how many points and
 * over what span, the highest, the latest — and where the exact numbers are. Points are in order,
 * oldest first, so "latest" is the last one.
 *
 * A summary rather than a transcription (see ReportChart): the table carries every value, and a
 * screen reader reading ninety of them out is not an alternative to a picture. `note` is one more
 * sentence the picture shows — a limit line, say — placed before the pointer to the table.
 */
export function summarise(label: string, points: ChartPoint[], format: ChartFormat, note?: string): string {
  const clean = points.map((p) => ({ label: p.label, value: finiteValue(p.value) }));
  if (clean.length === 0) return `${label}: nothing recorded yet.`;
  const first = clean[0]!;
  const last = clean[clean.length - 1]!;
  const f = (v: number) => formatChartValue(v, format);
  const extra = note ? `${note} ` : "";
  if (clean.length === 1) return `${label}: 1 point, ${first.label}, ${f(first.value)}. ${extra}${SAME_FIGURES}`;
  // The first of equal highs, so a flat run names where it started.
  const peak = clean.reduce((best, p) => (p.value > best.value ? p : best), first);
  return (
    `${label}: ${clean.length} points, ${first.label} to ${last.label}. ` +
    `Highest ${f(peak.value)} (${peak.label}); latest ${f(last.value)} (${last.label}). ${extra}${SAME_FIGURES}`
  );
}

/**
 * The same for a breakdown, where there is no "latest": how many categories, the largest and —
 * when the parts make a whole (`total`) — its share of it. A funnel's steps do not add up to
 * anything, so its caller leaves `total` off.
 */
export function summariseParts(label: string, parts: ChartPoint[], format: ChartFormat, opts: { total?: boolean } = {}): string {
  const clean = parts.map((p) => ({ label: p.label, value: Math.max(0, finiteValue(p.value)) }));
  if (clean.length === 0) return `${label}: nothing recorded yet.`;
  const f = (v: number) => formatChartValue(v, format);
  const whole = clean.reduce((sum, p) => sum + p.value, 0);
  const largest = clean.reduce((best, p) => (p.value > best.value ? p : best), clean[0]!);
  const count = `${clean.length} ${clean.length === 1 ? "category" : "categories"}`;
  const total = opts.total ? `, ${f(whole)} in all` : "";
  const share = opts.total && whole > 0 ? ` (${Math.round((largest.value / whole) * 100)}%)` : "";
  return `${label}: ${count}${total}. Largest: ${largest.label}, ${f(largest.value)}${share}. ${SAME_FIGURES}`;
}

/**
 * A root-relative path, or nothing. Chart marks link only within the console: an off-site URL
 * would open without OutboundLink's referrer stripping, and `//host` is off-site too — as is
 * `/\host`, which browsers read the same way.
 */
export function internalHref(href: string | null | undefined): string | undefined {
  return href && href.startsWith("/") && !/^\/[/\\]/.test(href) ? href : undefined;
}

/** A value's share of a whole, as a whole percentage; 0 when there is no whole. */
export function shareOf(value: number, whole: number): number {
  return whole > 0 ? Math.round((Math.max(0, finiteValue(value)) / whole) * 100) : 0;
}

/**
 * Which of `count` x positions get a label: all of them when they fit, otherwise `max` spread
 * evenly, always including the first and the last. Overlapping text reads as a smudge and says
 * less than no label would.
 */
export function labelIndices(count: number, max: number): Set<number> {
  if (count <= max) return new Set(Array.from({ length: count }, (_, i) => i));
  const slots = Math.max(2, max);
  return new Set(Array.from({ length: slots }, (_, k) => Math.round((k * (count - 1)) / (slots - 1))));
}

/** A label cut to `max` characters with an ellipsis — the untruncated text stays in the title. */
export function truncateLabel(label: string, max: number): string {
  return label.length > max ? `${label.slice(0, Math.max(1, max - 1))}…` : label;
}

/** Two decimals is sub-pixel at any size these charts render at, and keeps the markup short. */
export function px(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * A column standing on `baseY`: the data end (top) rounded, the baseline square — the rounding
 * says which end is the value.
 */
export function columnPath(x: number, top: number, width: number, baseY: number, radius = 4): string {
  const h = Math.max(0, baseY - top);
  const r = Math.max(0, Math.min(radius, width / 2, h));
  // A square block (a stacked segment below the top one) is just a rectangle.
  if (r === 0) return `M${px(x)},${px(baseY)} V${px(top)} H${px(x + width)} V${px(baseY)} Z`;
  return [
    `M${px(x)},${px(baseY)}`,
    `V${px(top + r)}`,
    `A${px(r)},${px(r)} 0 0 1 ${px(x + r)},${px(top)}`,
    `H${px(x + width - r)}`,
    `A${px(r)},${px(r)} 0 0 1 ${px(x + width)},${px(top + r)}`,
    `V${px(baseY)}`,
    "Z",
  ].join(" ");
}

/** A bar growing right from `x`, its data end (right) rounded and its start square. */
export function barPath(x: number, y: number, length: number, thickness: number, radius = 4): string {
  const len = Math.max(0, length);
  const r = Math.max(0, Math.min(radius, thickness / 2, len));
  if (r === 0) return `M${px(x)},${px(y)} H${px(x + len)} V${px(y + thickness)} H${px(x)} Z`;
  return [
    `M${px(x)},${px(y)}`,
    `H${px(x + len - r)}`,
    `A${px(r)},${px(r)} 0 0 1 ${px(x + len)},${px(y + r)}`,
    `V${px(y + thickness - r)}`,
    `A${px(r)},${px(r)} 0 0 1 ${px(x + len - r)},${px(y + thickness)}`,
    `H${px(x)}`,
    "Z",
  ].join(" ");
}

/**
 * The plot box of a chart with a value axis on the left and category labels underneath.
 *
 * One drawing width for every such chart, so two charts side by side scale alike and their text
 * comes out the same size. The left margin fits the widest tick label rather than a guess, so
 * "₹1.5L" and "150" both sit snugly against their gridlines.
 */
export type CartesianBox = ReturnType<typeof cartesianBox>;

export function cartesianBox(height: number, tickLabels: string[]) {
  const width = 600;
  const h = Math.max(96, Math.round(finiteValue(height)) || 200);
  const widest = tickLabels.reduce((m, t) => Math.max(m, t.length), 1);
  const left = Math.min(80, Math.max(28, Math.ceil(widest * 6.2) + 10));
  const pad = { top: 12, right: 12, bottom: 24, left };
  return {
    width,
    height: h,
    pad,
    plotW: width - pad.left - pad.right,
    plotH: h - pad.top - pad.bottom,
    baseY: h - pad.bottom,
  };
}
