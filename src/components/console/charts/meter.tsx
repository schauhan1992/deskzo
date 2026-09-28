import { cn } from "@/lib/utils";
import { CHART_TONE_CLASS, finiteValue, formatChartValue, type ChartFormat, type ChartTone } from "./chart-utils";

/**
 * How full something is against its limit — seats, copilot tokens, schema versions, the warm pool.
 *
 * `tone="auto"` (the default) colours by how close the value is to the limit: brand below 90%,
 * warning from 90%, danger at 100% and over. An over-limit value fills the bar and says "over the
 * limit" to assistive technology; the fill never overflows the track.
 *
 * `max === null` means there is no limit: the track stays empty and the words "no limit" say so.
 * That case is not a meter at all (a meter needs a range), so it carries no meter role.
 *
 * Built from spans throughout so it can sit anywhere text can — a table cell, a sentence, a tile.
 * `size="sm"` is the inline mini meter for tables (a 64px bar with "8 / 10" beside it); `"md"`
 * fills its container, with the figures underneath when `showText`.
 */
export function Meter({
  value,
  max,
  label,
  tone = "auto",
  size = "md",
  showText = false,
  format = "number",
}: {
  value: number;
  max: number | null;
  label: string;
  tone?: ChartTone | "auto";
  size?: "sm" | "md";
  showText?: boolean;
  format?: ChartFormat;
}) {
  const f = (v: number) => formatChartValue(v, format);
  const v = Math.max(0, finiteValue(value));
  const track = cn("block h-1.5 overflow-hidden rounded-full bg-surface-sunken", size === "sm" ? "w-16 shrink-0" : "w-full");
  const wrap = size === "sm" ? "inline-flex items-center gap-2 align-middle" : "block";
  const text = "text-xs whitespace-nowrap text-muted tabular-nums";

  if (max === null) {
    return (
      <span className={wrap}>
        <span className={track} aria-hidden="true" />
        <span className={cn(text, size === "md" && "mt-1.5 block")}>
          <span className="sr-only">{`${label}: `}</span>
          {showText ? `${f(v)} · no limit` : "no limit"}
        </span>
      </span>
    );
  }

  const m = Math.max(0, finiteValue(max));
  // A limit of zero with anything used is over it; with nothing used it is simply empty.
  const ratio = m > 0 ? v / m : v > 0 ? Number.POSITIVE_INFINITY : 0;
  const percent = Math.round(Math.min(ratio, 1) * 100);
  // Anything above zero gets a sliver, so "one seat of five hundred" is not drawn as none.
  const width = v > 0 ? Math.max(percent, 1.5) : 0;
  const resolved: ChartTone = tone === "auto" ? (ratio >= 1 ? "danger" : ratio >= 0.9 ? "warning" : "brand") : tone;
  const over = ratio > 1;
  const valueText = `${f(v)} of ${f(m)}${over ? ", over the limit" : ` (${percent}%)`}`;

  return (
    <span className={wrap}>
      <span
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={m}
        aria-valuenow={v}
        aria-valuetext={valueText}
        className={track}
      >
        <span className={cn("block h-full rounded-full bg-current", CHART_TONE_CLASS[resolved])} style={{ width: `${width}%` }} />
      </span>
      {showText &&
        (size === "sm" ? (
          <span className={text}>{`${f(v)} / ${f(m)}`}</span>
        ) : (
          <span className={cn(text, "mt-1.5 flex items-baseline justify-between gap-2")}>
            <span>{`${f(v)} / ${f(m)}`}</span>
            {over ? <span className="font-medium text-danger">Over the limit</span> : <span>{`${percent}%`}</span>}
          </span>
        ))}
    </span>
  );
}
