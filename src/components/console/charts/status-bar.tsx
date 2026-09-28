import { cn } from "@/lib/utils";
import { Legend } from "./chart-frame";
import { CHART_TONE_CLASS, finiteValue, formatChartValue, internalHref, px, shareOf, summariseParts, type ChartFormat, type ChartTone } from "./chart-utils";

/** Drawing units across; the bar is stretched to its box, so this only sets the precision. */
const W = 1000;
const H = 12;

/**
 * A whole split into its parts, as one full-width bar — workspaces by status, invited against open
 * signups.
 *
 * The bar is stretched to whatever width it is given (`preserveAspectRatio="none"`), so the 2px
 * gaps between segments are drawn as non-scaling surface-coloured lines: two pixels at any width.
 * The legend underneath carries every part's name and count — including parts at zero, which
 * have no segment — and, where a part has an `href`, the link to its list. That is the keyboard's
 * way in; the segments link too, for the mouse, but stay out of the tab order so each list is one
 * tab stop rather than two.
 */
export function StatusBar({
  segments,
  label,
  format = "number",
}: {
  segments: { key: string; label: string; value: number; tone: ChartTone; href?: string }[];
  label: string;
  format?: ChartFormat;
}) {
  const f = (v: number) => formatChartValue(v, format);
  const drawn = segments.map((s) => Math.max(0, finiteValue(s.value)));
  const whole = drawn.reduce((sum, v) => sum + v, 0);
  // Positions resolved up front (see StackedColumns) rather than accumulated inside the render map.
  const spans = segments.reduce<{ key: string; x: number; w: number; index: number }[]>((acc, s, i) => {
    const x = acc.length === 0 ? 0 : acc[acc.length - 1]!.x + acc[acc.length - 1]!.w;
    return [...acc, { key: s.key, x, w: whole > 0 ? (drawn[i]! / whole) * W : 0, index: i }];
  }, []);
  const visible = spans.filter((s) => s.w > 0);
  const summary = summariseParts(
    label,
    segments.map((s) => ({ label: s.label, value: s.value })),
    format,
    { total: true },
  );

  return (
    <div className="space-y-2.5">
      <div className="overflow-hidden rounded-full bg-surface-sunken">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-3 w-full" role="img" aria-label={summary} focusable="false">
          {visible.map((span) => {
            const s = segments[span.index]!;
            const href = internalHref(s.href);
            const rect = (
              <rect x={px(span.x)} y={0} width={px(span.w)} height={H} fill="currentColor" className={cn(CHART_TONE_CLASS[s.tone], "hover:opacity-80")}>
                <title>{`${s.label}: ${f(s.value)} (${shareOf(s.value, whole)}%)`}</title>
              </rect>
            );
            return href ? (
              <a key={span.key} href={href} tabIndex={-1}>
                {rect}
              </a>
            ) : (
              <g key={span.key}>{rect}</g>
            );
          })}
          {visible.slice(1).map((span) => (
            <line
              key={`gap-${span.key}`}
              x1={px(span.x)}
              x2={px(span.x)}
              y1={0}
              y2={H}
              className="pointer-events-none stroke-surface"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      </div>
      <Legend
        items={segments.map((s) => ({
          label: s.label,
          tone: s.tone,
          value: f(s.value),
          href: internalHref(s.href),
        }))}
      />
    </div>
  );
}
