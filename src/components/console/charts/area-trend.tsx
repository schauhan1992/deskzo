import { CategoryLabels, ChartEmpty, ValueGrid } from "./chart-frame";
import {
  CHART_TONE_CLASS,
  cartesianBox,
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

/**
 * A measure over time where the shape matters more than any one period — seats used per day
 * against the seat limit, say. A 2px line over a faint wash of its own colour, three round ticks,
 * at most six dates underneath.
 *
 * `limit` draws the ceiling as a dashed danger line: dashed because it is a threshold, not data,
 * and the axis always reaches it, so a limit far above the usage is seen to be far above it.
 *
 * Hovering anywhere in a point's band shows its date and value (a native tooltip from `<title>`,
 * so it works without JavaScript) with a hairline and a dot on the line; the table carries the
 * same figures for anybody who cannot hover.
 */
export function AreaTrend({
  points,
  label,
  format = "number",
  tone = "chart-1",
  limit = null,
  limitLabel = "Limit",
  height = 200,
}: {
  points: { key: string; label: string; value: number }[];
  label: string;
  format?: ChartFormat;
  tone?: ChartTone;
  limit?: number | null;
  limitLabel?: string;
  height?: number;
}) {
  if (points.length === 0) return <ChartEmpty />;

  const f = (v: number) => formatChartValue(v, format);
  const lim = limit !== null && limit !== undefined && Number.isFinite(limit) && limit >= 0 ? limit : null;
  // Drawn from zero up; a negative reading (which a usage count cannot be) sits on the baseline,
  // and its title still says what it was.
  const drawn = points.map((p) => Math.max(0, finiteValue(p.value)));
  const yTicks = ticks(Math.max(0, ...drawn, lim ?? 0), 3);
  const top = yTicks[yTicks.length - 1]!;
  const box = cartesianBox(height, yTicks.map((t) => formatAxisValue(t, format)));
  const n = points.length;
  const x = (i: number) => (n === 1 ? box.pad.left + box.plotW / 2 : box.pad.left + (i * box.plotW) / (n - 1));
  const y = (v: number) => box.pad.top + box.plotH * (1 - v / top);
  const coords = drawn.map((v, i) => [px(x(i)), px(y(v))] as const);
  const line = coords.map(([cx, cy]) => `${cx},${cy}`).join(" ");
  const area = `M${coords[0]![0]},${box.baseY} ${coords.map(([cx, cy]) => `L${cx},${cy}`).join(" ")} L${coords[n - 1]![0]},${box.baseY} Z`;
  const shown = labelIndices(n, 6);
  const maxChars = Math.max(4, Math.floor(box.plotW / shown.size / 6));
  const summary = summarise(label, points, format, lim !== null ? `${limitLabel}: ${f(lim)}.` : undefined);
  // The limit's label sits just above its line, kept inside the drawing when the line is the top of the plot.
  const limitY = lim !== null ? px(y(lim)) : 0;
  const limitLabelY = Math.max(9, limitY - 4);
  const edge = (i: number, side: -1 | 1) => {
    if (side < 0) return i === 0 ? box.pad.left : (x(i - 1) + x(i)) / 2;
    return i === n - 1 ? box.width - box.pad.right : (x(i) + x(i + 1)) / 2;
  };

  return (
    <svg viewBox={`0 0 ${box.width} ${box.height}`} className="h-auto w-full" role="img" aria-label={summary} focusable="false">
      <ValueGrid box={box} values={yTicks} top={top} format={format} />
      <g className={CHART_TONE_CLASS[tone]}>
        <path d={area} fill="currentColor" fillOpacity={0.12} stroke="none" />
        {n === 1 ? (
          <line x1={box.pad.left} x2={box.width - box.pad.right} y1={coords[0]![1]} y2={coords[0]![1]} stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <title>{`${points[0]!.label}: ${f(points[0]!.value)}`}</title>
          </line>
        ) : (
          <polyline points={line} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round">
            <title>{summary}</title>
          </polyline>
        )}
      </g>
      {lim !== null && (
        <g className="text-danger">
          <line
            x1={box.pad.left}
            x2={box.width - box.pad.right}
            y1={limitY}
            y2={limitY}
            stroke="currentColor"
            strokeWidth={1.5}
            strokeDasharray="4 3"
          >
            <title>{`${limitLabel}: ${f(lim)}`}</title>
          </line>
          <text x={box.width - box.pad.right} y={limitLabelY} textAnchor="end" className="fill-current text-[10px] font-medium tabular-nums">
            {`${limitLabel} ${formatAxisValue(lim, format)}`}
          </text>
        </g>
      )}
      <g className={CHART_TONE_CLASS[tone]}>
        {/* The latest reading, marked: it is the one people look for. */}
        <circle cx={coords[n - 1]![0]} cy={coords[n - 1]![1]} r={3.5} fill="currentColor" className="stroke-surface" strokeWidth={2}>
          <title>{`${points[n - 1]!.label}: ${f(points[n - 1]!.value)}`}</title>
        </circle>
        {points.map((p, i) => (
          <g key={p.key} className="group">
            <rect x={px(edge(i, -1))} y={box.pad.top} width={px(edge(i, 1) - edge(i, -1))} height={box.plotH} fill="transparent">
              <title>{`${p.label}: ${f(p.value)}`}</title>
            </rect>
            <line
              x1={coords[i]![0]}
              x2={coords[i]![0]}
              y1={box.pad.top}
              y2={box.baseY}
              className="pointer-events-none stroke-current text-line-strong opacity-0 group-hover:opacity-100"
              strokeWidth={1}
            />
            <circle
              cx={coords[i]![0]}
              cy={coords[i]![1]}
              r={4}
              fill="currentColor"
              className="pointer-events-none stroke-surface opacity-0 group-hover:opacity-100"
              strokeWidth={2}
            />
          </g>
        ))}
      </g>
      <CategoryLabels
        box={box}
        anchorEdges
        items={[...shown].map((i) => ({ key: points[i]!.key, label: truncateLabel(points[i]!.label, maxChars), x: x(i), first: i === 0, last: i === n - 1 }))}
      />
    </svg>
  );
}
