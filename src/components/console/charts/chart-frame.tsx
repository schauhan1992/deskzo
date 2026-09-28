import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AXIS_TEXT_CLASS,
  CHART_TONE_CLASS,
  GRID_CLASS,
  formatAxisValue,
  px,
  type CartesianBox,
  type ChartFormat,
  type ChartTone,
} from "./chart-utils";

/**
 * The card every console chart sits in, and the pieces the charts share.
 *
 * A chart is never the only way to a number: the frame always offers the same figures as a table
 * ("Show as table"), because a picture can be misread, can't be copied from, and says nothing to a
 * screen reader beyond its one-sentence summary. Collapsed by default — it is the fallback, not
 * the page.
 */
export function ChartFrame({
  title,
  description,
  actions,
  children,
  table,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  table?: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-xl border border-line bg-surface shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="px-5 py-4">
        {children}
        {table && (
          <details className="group mt-3">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-base text-xs font-medium text-muted select-none hover:text-text [&::-webkit-details-marker]:hidden">
              <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
              <span className="group-open:hidden">Show as table</span>
              <span className="hidden group-open:inline">Hide table</span>
            </summary>
            <div className="mt-2">{table}</div>
          </details>
        )}
      </div>
    </section>
  );
}

/**
 * The exact figures behind a chart. Columns from `numericFrom` on are numbers: right-aligned,
 * tabular, and — when passed as numbers rather than already-formatted strings — grouped the
 * Indian way. Money arrives as strings from `formatMoney`, so it is never re-read as a count.
 */
export function ChartTable({ columns, rows, numericFrom = 1 }: { columns: string[]; rows: (string | number)[][]; numericFrom?: number }) {
  const numeric = (i: number) => i >= numericFrom;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-line">
            {columns.map((c, i) => (
              <th key={`${i}-${c}`} scope="col" className={cn("px-3 py-2 text-xs font-medium whitespace-nowrap text-muted first:pl-0 last:pr-0", numeric(i) && "text-right")}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row, r) => (
            <tr key={`${r}-${String(row[0] ?? "")}`}>
              {row.map((cell, i) => (
                <td
                  key={`${i}-${columns[i] ?? ""}`}
                  className={cn("px-3 py-1.5 text-text first:pl-0 last:pr-0", numeric(i) ? "text-right whitespace-nowrap tabular-nums" : "break-words")}
                >
                  {typeof cell === "number" ? cell.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * What each colour means. The swatch carries the colour; the words stay in text tokens, because a
 * pale series colour (amber, cyan) is not legible as text on the surface. An item with an `href`
 * links to the list behind it — this is the keyboard's way into a chart whose marks also link.
 */
export function Legend({
  items,
  direction = "row",
}: {
  items: { label: string; tone: ChartTone; value?: string; href?: string }[];
  /** "column" lists one item per line — beside a donut, where a wrapped row reads as a sentence. */
  direction?: "row" | "column";
}) {
  if (items.length === 0) return null;
  return (
    <ul className={direction === "column" ? "space-y-1.5" : "flex flex-wrap gap-x-4 gap-y-1.5"}>
      {items.map((item, i) => {
        const content = (
          <>
            <span className={cn("h-2.5 w-2.5 shrink-0 rounded-sm bg-current", CHART_TONE_CLASS[item.tone])} aria-hidden="true" />
            <span>{item.label}</span>
            {item.value !== undefined && <span className="font-medium text-text tabular-nums">{item.value}</span>}
          </>
        );
        return (
          <li key={`${i}-${item.label}`} className="text-xs text-muted">
            {item.href ? (
              <Link href={item.href} className="inline-flex items-center gap-1.5 rounded-base hover:text-text hover:underline hover:underline-offset-2">
                {content}
              </Link>
            ) : (
              <span className="inline-flex items-center gap-1.5">{content}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Stands in for a chart with nothing to draw, so a card never holds an empty grid and no word. */
export function ChartEmpty({ children }: { children?: ReactNode }) {
  return <p className="py-8 text-center text-sm text-subtle">{children ?? "Nothing to chart yet."}</p>;
}

/** The value axis: a hairline at every tick, its label in the left margin. Solid, never dashed — a dashed line means a limit. */
export function ValueGrid({ box, values, top, format }: { box: CartesianBox; values: number[]; top: number; format: ChartFormat }) {
  return (
    <g>
      {values.map((t) => {
        const y = px(box.pad.top + box.plotH * (1 - t / top));
        return (
          <g key={t}>
            <line x1={box.pad.left} x2={box.width - box.pad.right} y1={y} y2={y} className={GRID_CLASS} strokeWidth={1} shapeRendering="crispEdges" />
            <text x={box.pad.left - 8} y={y} textAnchor="end" dominantBaseline="middle" className={AXIS_TEXT_CLASS}>
              {formatAxisValue(t, format)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/**
 * Category labels under the plot. `anchorEdges` pins the first label's start and the last one's end
 * to the plot edges — for a line, whose first and last points sit exactly on them, so a centred
 * label would hang off the drawing.
 */
export function CategoryLabels({
  box,
  items,
  anchorEdges = false,
}: {
  box: CartesianBox;
  items: { key: string; label: string; x: number; first: boolean; last: boolean }[];
  anchorEdges?: boolean;
}) {
  return (
    <g>
      {items.map((item) => (
        <text
          key={item.key}
          x={px(item.x)}
          y={box.height - 7}
          textAnchor={anchorEdges && item.first && !item.last ? "start" : anchorEdges && item.last && !item.first ? "end" : "middle"}
          className={AXIS_TEXT_CLASS}
        >
          {item.label}
        </text>
      ))}
    </g>
  );
}
