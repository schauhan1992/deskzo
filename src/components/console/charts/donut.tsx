import type { ReactNode } from "react";
import { Legend } from "./chart-frame";
import { CHART_TONE_CLASS, finiteValue, formatChartValue, px, shareOf, summariseParts, type ChartFormat, type ChartTone } from "./chart-utils";

/**
 * Share of a whole, as a ring — for a handful of parts (six at most reads at a glance; compare
 * close values with `HBarChart` instead). The centre is a slot for the whole ("142 workspaces"),
 * laid over the ring in HTML so it can be any markup and wraps like text.
 *
 * Each segment is a dash along one circle rather than a pie-wedge path, so a single part is simply
 * a full ring and there is no arc arithmetic to get wrong. Segments are parted by a 2px gap in the
 * surface colour; the legend beside the ring names each with its figure and share.
 */
export function Donut({
  segments,
  label,
  size = 120,
  center,
  format = "number",
}: {
  segments: { key: string; label: string; value: number; tone: ChartTone }[];
  label: string;
  size?: number;
  center?: ReactNode;
  /** How the legend and titles write a value. */
  format?: ChartFormat;
}) {
  const f = (v: number) => formatChartValue(v, format);
  const s = Math.max(48, finiteValue(size));
  const thick = Math.max(8, Math.round(s * 0.14));
  // A pixel in from the edge, so the ring's outer edge is never shaved by the drawing's bounds.
  const r = (s - thick) / 2 - 1;
  const c = s / 2;
  const circumference = 2 * Math.PI * r;
  const drawn = segments.map((seg) => Math.max(0, finiteValue(seg.value)));
  const whole = drawn.reduce((sum, v) => sum + v, 0);
  const gap = drawn.filter((v) => v > 0).length > 1 ? 2 : 0;
  // Offsets along the ring resolved up front (see StackedColumns), clockwise from twelve o'clock.
  const arcs = segments.reduce<{ index: number; start: number; length: number }[]>((acc, _seg, i) => {
    const start = acc.length === 0 ? 0 : acc[acc.length - 1]!.start + acc[acc.length - 1]!.length;
    return [...acc, { index: i, start, length: whole > 0 ? (drawn[i]! / whole) * circumference : 0 }];
  }, []);
  const summary = summariseParts(
    label,
    segments.map((seg) => ({ label: seg.label, value: seg.value })),
    format,
    { total: true },
  );

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <div className="relative shrink-0" style={{ width: s, height: s }}>
        <svg viewBox={`0 0 ${s} ${s}`} width={s} height={s} className="block" role="img" aria-label={summary} focusable="false">
          <circle cx={c} cy={c} r={px(r)} fill="none" stroke="currentColor" strokeWidth={thick} className="text-surface-sunken" />
          <g transform={`rotate(-90 ${c} ${c})`}>
            {arcs
              .filter((arc) => arc.length > 0)
              .map((arc) => {
                const seg = segments[arc.index]!;
                // A sliver narrower than the gap keeps a pixel, so a small part is still there to hover.
                const dash = Math.max(1, arc.length - gap);
                return (
                  <circle
                    key={seg.key}
                    cx={c}
                    cy={c}
                    r={px(r)}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={thick}
                    strokeDasharray={`${px(dash)} ${px(circumference - dash)}`}
                    strokeDashoffset={px(-arc.start)}
                    className={`${CHART_TONE_CLASS[seg.tone]} hover:opacity-80`}
                  >
                    <title>{`${seg.label}: ${f(seg.value)} (${shareOf(seg.value, whole)}%)`}</title>
                  </circle>
                );
              })}
          </g>
        </svg>
        {center !== undefined && center !== null && (
          <div className="absolute inset-0 grid place-items-center text-center" style={{ padding: thick + 4 }}>
            <div className="min-w-0">{center}</div>
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <Legend
          direction="column"
          items={segments.map((seg) => ({ label: seg.label, tone: seg.tone, value: `${f(seg.value)} · ${shareOf(seg.value, whole)}%` }))}
        />
      </div>
    </div>
  );
}
