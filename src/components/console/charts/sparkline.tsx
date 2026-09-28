import { cn } from "@/lib/utils";
import { CHART_TONE_CLASS, finiteValue, formatChartValue, px, type ChartFormat, type ChartTone } from "./chart-utils";

/**
 * A trend in 96 × 28 — for a KPI tile or a table cell.
 *
 * Scaled to its own low and high rather than from zero: a sparkline answers "which way, and how
 * steadily", and 138 → 142 drawn from zero is a flat line that answers nothing. The figure beside
 * it gives the magnitude; a trend that has to be read for quantities is an `AreaTrend`.
 *
 * `decorative` hides it from assistive technology where the tile already states the number — a
 * second, vaguer reading of the same figure is noise. Otherwise it is an image with a summary.
 */
export function Sparkline({
  values,
  label,
  tone = "chart-1",
  width = 96,
  height = 28,
  area = false,
  decorative = false,
  format = "number",
}: {
  values: number[];
  label: string;
  tone?: ChartTone;
  width?: number;
  height?: number;
  area?: boolean;
  decorative?: boolean;
  /** How the titles write a value; the line itself has no axis. */
  format?: ChartFormat;
}) {
  const clean = values.map(finiteValue);
  if (clean.length === 0) return null;

  const w = Math.max(16, finiteValue(width));
  const h = Math.max(8, finiteValue(height));
  // Room for the end dot and its ring, so neither is cut by the edge of the drawing.
  const pad = 3;
  const lo = Math.min(...clean);
  const hi = Math.max(...clean);
  const y = (v: number) => (hi === lo ? (hi === 0 ? h - pad : h / 2) : pad + (1 - (v - lo) / (hi - lo)) * (h - pad * 2));
  // One value is still a level, drawn across the whole width rather than as a lone dot.
  const coords: [number, number][] =
    clean.length === 1
      ? [
          [pad, y(clean[0]!)],
          [w - pad, y(clean[0]!)],
        ]
      : clean.map((v, i) => [pad + (i * (w - pad * 2)) / (clean.length - 1), y(v)]);
  const line = coords.map(([cx, cy]) => `${px(cx)},${px(cy)}`).join(" ");
  const [endX, endY] = coords[coords.length - 1]!;
  const first = clean[0]!;
  const last = clean[clean.length - 1]!;
  const f = (v: number) => formatChartValue(v, format);
  const summary =
    clean.length === 1 ? `${label}: ${f(last)}.` : `${label}: ${clean.length} points, from ${f(first)} to ${f(last)}; highest ${f(hi)}, lowest ${f(lo)}.`;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      className={cn("block h-auto max-w-full shrink-0 overflow-visible", CHART_TONE_CLASS[tone])}
      focusable="false"
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : summary}
      aria-hidden={decorative ? true : undefined}
    >
      {area && (
        <path
          d={`M${px(coords[0]![0])},${h} ${coords.map(([cx, cy]) => `L${px(cx)},${px(cy)}`).join(" ")} L${px(endX)},${h} Z`}
          fill="currentColor"
          fillOpacity={0.12}
          stroke="none"
        />
      )}
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round">
        <title>{summary}</title>
      </polyline>
      <circle cx={px(endX)} cy={px(endY)} r={2.5} fill="currentColor" className="stroke-surface" strokeWidth={1.5}>
        <title>{`Latest: ${f(last)}`}</title>
      </circle>
    </svg>
  );
}
