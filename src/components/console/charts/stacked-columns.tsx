import { CategoryLabels, ChartEmpty, Legend, ValueGrid } from "./chart-frame";
import {
  CHART_TONE_CLASS,
  cartesianBox,
  columnPath,
  finiteValue,
  formatAxisValue,
  formatChartValue,
  labelIndices,
  px,
  summarise,
  ticks,
  truncateLabel,
  type ChartFormat,
  type ChartTone,
} from "./chart-utils";

/** The surface-coloured space between two stacked segments: it separates them without a border. */
const GAP = 2;

/**
 * Composition within each period — trial outcomes by month, setups by outcome per day.
 *
 * Segments stack in the order `series` lists them, bottom up, and keep that order in every column
 * and in the legend, so a colour means the same series everywhere. A series missing from a column's
 * `segments` counts as zero. Only the column's top segment is rounded: that end is the total.
 *
 * Every segment carries its own title (period, series, figure); the rest of the column's slot
 * carries the whole breakdown, so hovering anywhere over a period reads it.
 */
export function StackedColumns({
  columns,
  series,
  label,
  format = "number",
  height = 200,
}: {
  columns: { key: string; label: string; segments: Record<string, number> }[];
  series: { key: string; label: string; tone: ChartTone }[];
  label: string;
  format?: ChartFormat;
  height?: number;
}) {
  if (columns.length === 0 || series.length === 0) return <ChartEmpty />;

  const f = (v: number) => formatChartValue(v, format);
  const values = columns.map((c) => series.map((s) => Math.max(0, finiteValue(c.segments[s.key] ?? 0))));
  const totals = values.map((vs) => vs.reduce((sum, v) => sum + v, 0));
  const yTicks = ticks(Math.max(0, ...totals), 3);
  const top = yTicks[yTicks.length - 1]!;
  const box = cartesianBox(height, yTicks.map((t) => formatAxisValue(t, format)));
  const n = columns.length;
  const slot = box.plotW / n;
  const barW = Math.max(2, Math.min(24, slot * 0.64));
  const mid = (i: number) => box.pad.left + slot * i + slot / 2;
  const scale = (v: number) => (v / top) * box.plotH;
  const shown = labelIndices(n, n <= 12 ? 12 : 6);
  const maxChars = Math.max(3, Math.floor(box.plotW / shown.size / 5.6));
  const names = new Intl.ListFormat("en-GB", { style: "long", type: "conjunction" }).format(series.map((s) => s.label));
  const summary = summarise(
    label,
    columns.map((c, i) => ({ label: c.label, value: totals[i]! })),
    format,
    `Each column stacks ${names}; highest and latest are column totals.`,
  );

  return (
    <div className="space-y-3">
      <svg viewBox={`0 0 ${box.width} ${box.height}`} className="h-auto w-full" role="img" aria-label={summary} focusable="false">
        <ValueGrid box={box} values={yTicks} top={top} format={format} />
        {columns.map((c, i) => {
          const left = mid(i) - barW / 2;
          // Each segment's span resolved up front rather than accumulated across the map: a stack
          // that depends on the order a loop happened to run in is one that can draw itself wrong.
          const stack = series.reduce<{ key: string; label: string; tone: ChartTone; value: number; top: number; bottom: number }[]>((acc, s, si) => {
            const value = values[i]![si]!;
            const bottom = acc.length === 0 ? box.baseY : acc[acc.length - 1]!.top;
            return [...acc, { key: s.key, label: s.label, tone: s.tone, value, bottom, top: bottom - scale(value) }];
          }, []);
          const drawn = stack.filter((seg) => seg.value > 0);
          const breakdown = series.map((s, si) => `${s.label} ${f(values[i]![si]!)}`).join(", ");
          return (
            <g key={c.key}>
              <rect x={px(mid(i) - slot / 2)} y={box.pad.top} width={px(slot)} height={box.plotH} fill="transparent">
                <title>{`${c.label}: ${f(totals[i]!)} in all — ${breakdown}`}</title>
              </rect>
              {drawn.length === 0 ? (
                <rect x={px(left)} y={box.baseY - 1} width={px(barW)} height={1} className="fill-current text-subtle">
                  <title>{`${c.label}: ${f(0)}`}</title>
                </rect>
              ) : (
                drawn.map((seg, di) => {
                  const isTop = di === drawn.length - 1;
                  // The gap comes out of the segment above it, never the one below, and a sliver too
                  // thin to lose two pixels keeps one so it is still there to hover.
                  const bottom = di === 0 ? seg.bottom : seg.bottom - Math.min(GAP, Math.max(0, seg.bottom - seg.top - 1));
                  const segTop = Math.min(seg.top, bottom - 1);
                  return (
                    <path
                      key={seg.key}
                      d={columnPath(left, segTop, barW, bottom, isTop ? 4 : 0)}
                      fill="currentColor"
                      className={`${CHART_TONE_CLASS[seg.tone]} hover:opacity-80`}
                    >
                      <title>{`${c.label} · ${seg.label}: ${f(seg.value)}`}</title>
                    </path>
                  );
                })
              )}
            </g>
          );
        })}
        <CategoryLabels
          box={box}
          items={[...shown].map((i) => ({ key: columns[i]!.key, label: truncateLabel(columns[i]!.label, maxChars), x: mid(i), first: i === 0, last: i === n - 1 }))}
        />
      </svg>
      <Legend items={series.map((s) => ({ label: s.label, tone: s.tone }))} />
    </div>
  );
}
