import { cn } from "@/lib/utils";
import { CategoryLabels, ChartEmpty, ValueGrid } from "./chart-frame";
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

/**
 * One measure per period, as columns — new workspaces per week, money collected per month.
 *
 * Columns are at most 24px wide however few there are (the rest of the slot is air), rounded at the
 * value end and square on the baseline. A column of zero is still drawn, as a 1px line on the
 * baseline, so "nothing that week" reads as a fact rather than as a gap in the data; any value
 * above zero gets at least 2px so it is never mistaken for one.
 *
 * Each column's whole slot is its hover target — the title shows the period and the exact figure.
 */
export function ColumnChart({
  columns,
  label,
  format = "number",
  tone = "chart-1",
  height = 200,
}: {
  columns: { key: string; label: string; value: number; tone?: ChartTone }[];
  label: string;
  format?: ChartFormat;
  tone?: ChartTone;
  height?: number;
}) {
  if (columns.length === 0) return <ChartEmpty />;

  const f = (v: number) => formatChartValue(v, format);
  // Drawn from zero up: a negative (a refund month, say) sits on the baseline and its title says so.
  const drawn = columns.map((c) => Math.max(0, finiteValue(c.value)));
  const yTicks = ticks(Math.max(0, ...drawn), 3);
  const top = yTicks[yTicks.length - 1]!;
  const box = cartesianBox(height, yTicks.map((t) => formatAxisValue(t, format)));
  const n = columns.length;
  const slot = box.plotW / n;
  const barW = Math.max(2, Math.min(24, slot * 0.64));
  const mid = (i: number) => box.pad.left + slot * i + slot / 2;
  const y = (v: number) => box.pad.top + box.plotH * (1 - v / top);
  // Twelve short period labels fit under twelve columns; beyond that, six spread evenly.
  const shown = labelIndices(n, n <= 12 ? 12 : 6);
  const maxChars = Math.max(3, Math.floor(box.plotW / shown.size / 5.6));
  const summary = summarise(label, columns, format);

  return (
    <svg viewBox={`0 0 ${box.width} ${box.height}`} className="h-auto w-full" role="img" aria-label={summary} focusable="false">
      <ValueGrid box={box} values={yTicks} top={top} format={format} />
      {columns.map((c, i) => {
        const v = drawn[i]!;
        const left = mid(i) - barW / 2;
        const title = `${c.label}: ${f(c.value)}`;
        return (
          <g key={c.key} className={cn("group", CHART_TONE_CLASS[c.tone ?? tone])}>
            <rect x={px(mid(i) - slot / 2)} y={box.pad.top} width={px(slot)} height={box.plotH} fill="transparent">
              <title>{title}</title>
            </rect>
            {v > 0 ? (
              <path d={columnPath(left, Math.min(y(v), box.baseY - 2), barW, box.baseY)} fill="currentColor" className="group-hover:opacity-80">
                <title>{title}</title>
              </path>
            ) : (
              <rect x={px(left)} y={box.baseY - 1} width={px(barW)} height={1} fill="currentColor">
                <title>{title}</title>
              </rect>
            )}
          </g>
        );
      })}
      <CategoryLabels
        box={box}
        items={[...shown].map((i) => ({ key: columns[i]!.key, label: truncateLabel(columns[i]!.label, maxChars), x: mid(i), first: i === 0, last: i === n - 1 }))}
      />
    </svg>
  );
}
