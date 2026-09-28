import { ChartEmpty } from "./chart-frame";
import {
  CHART_TONE_CLASS,
  barPath,
  finiteValue,
  formatChartValue,
  internalHref,
  px,
  summariseParts,
  truncateLabel,
  type ChartFormat,
  type ChartTone,
} from "./chart-utils";

const W = 600;
const ROW = 28;
const BAR = 14;
const PAD_Y = 4;
/** Room inside the row highlight before the label starts. */
const INSET = 6;

/** Roughly how wide a run of 11px text is, for sizing the label and value columns to fit their words. */
const textWidth = (s: string) => Math.ceil(s.length * 6.4);

/**
 * A ranking or a breakdown — workspaces by status, plan or country — and the signup funnel, whose
 * `note` carries each step's conversion ("62%").
 *
 * Horizontal because category labels are words, and words do not fit under a vertical axis. The
 * label and value columns are sized to the longest text rather than fixed, so a chart of two-letter
 * country codes is not mostly margin. The scale is the largest value unless `max` says otherwise
 * (a funnel scaled to its first step, two charts on one scale).
 *
 * A bar with an `href` is a link to the list behind it (root-relative only). When any bar links the
 * drawing is a group rather than an image — an image's contents are hidden from assistive
 * technology, and a link nobody can reach is worse than no link — and each link is named for its
 * bar, with a visible highlight when it has focus.
 */
export function HBarChart({
  bars,
  label,
  format = "number",
  max,
}: {
  bars: { key: string; label: string; value: number; href?: string; tone?: ChartTone; note?: string }[];
  label: string;
  format?: ChartFormat;
  max?: number;
}) {
  if (bars.length === 0) return <ChartEmpty />;

  const f = (v: number) => formatChartValue(v, format);
  const drawn = bars.map((b) => Math.max(0, finiteValue(b.value)));
  const scaleMax = max !== undefined && Number.isFinite(max) && max > 0 ? max : Math.max(1, ...drawn);
  const labels = bars.map((b) => truncateLabel(b.label, 28));
  const values = bars.map((b) => f(b.value));
  const valueTexts = bars.map((b, i) => (b.note ? `${values[i]} · ${b.note}` : values[i]!));
  const labelW = Math.min(200, Math.max(28, labels.reduce((m, l) => Math.max(m, textWidth(l)), 0) + 12));
  const valueW = Math.min(220, Math.max(40, valueTexts.reduce((m, t) => Math.max(m, textWidth(t)), 0) + 12));
  const x0 = INSET + labelW;
  const trackW = W - x0 - valueW;
  const height = PAD_Y * 2 + bars.length * ROW;
  const linked = bars.some((b) => internalHref(b.href) !== undefined);
  const summary = summariseParts(
    label,
    bars.map((b) => ({ label: b.label, value: b.value })),
    format,
  );

  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      className="h-auto w-full"
      role={linked ? "group" : "img"}
      aria-label={summary}
      focusable="false"
    >
      {bars.map((b, i) => {
        const top = PAD_Y + i * ROW;
        const len = (Math.min(drawn[i]!, scaleMax) / scaleMax) * trackW;
        const title = `${b.label}: ${valueTexts[i]}`;
        const href = internalHref(b.href);
        const content = (
          <>
            <text x={INSET} y={top + ROW / 2} dominantBaseline="middle" className="fill-current text-[11px] text-muted">
              {labels[i]}
            </text>
            <g className={CHART_TONE_CLASS[b.tone ?? "chart-1"]}>
              {len > 0 ? (
                <path d={barPath(x0, top + (ROW - BAR) / 2, Math.max(2, len), BAR)} fill="currentColor">
                  <title>{title}</title>
                </path>
              ) : (
                // Zero is drawn as a 1px stub on the axis: nothing, recorded — not a missing row.
                <rect x={x0} y={px(top + (ROW - BAR) / 2)} width={1} height={BAR} fill="currentColor">
                  <title>{title}</title>
                </rect>
              )}
            </g>
            <text x={px(x0 + Math.max(2, len) + 6)} y={top + ROW / 2} dominantBaseline="middle" className="fill-current text-[11px] font-medium text-text tabular-nums">
              {values[i]}
              {b.note && (
                <tspan dx={5} className="fill-current font-normal text-subtle">
                  {`· ${b.note}`}
                </tspan>
              )}
            </text>
          </>
        );
        if (!href) return <g key={b.key}>{content}</g>;
        return (
          <a key={b.key} href={href} aria-label={title} className="group">
            <rect
              x={0}
              y={top + 1}
              width={W}
              height={ROW - 2}
              rx={4}
              className="fill-current text-surface-sunken opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
            >
              <title>{title}</title>
            </rect>
            <g aria-hidden="true">{content}</g>
          </a>
        );
      })}
    </svg>
  );
}
