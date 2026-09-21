"use client";

import type { ReportResult } from "@/lib/analytics/run";
import { NONE } from "@/lib/analytics/types";

/**
 * The report, drawn.
 *
 * Hand-written SVG rather than a charting library. Four chart types over a table that is already
 * shaped as rows, columns and totals is a few hundred lines; the smallest capable library is a few
 * hundred kilobytes, brings its own theming that would have to be bent to the app's tokens, and
 * would be the first runtime dependency in the UI. Everything here uses `currentColor` and the CSS
 * variables, so dark mode needs no code at all.
 *
 * Which chart suits which question is not a preference:
 *
 *   - **Column** for a measure over time. The eye reads time left to right and nothing else should.
 *   - **Line** for the same thing when the shape matters more than the quantities.
 *   - **Bar** for a ranking — brands, salespeople, tags. Horizontal, because category labels are
 *     words and words do not fit under a vertical axis.
 *   - **Stacked** for a cross-tab: composition within each period.
 *   - **Donut** for share of a whole, capped at the top slices because a pie with forty slices is a
 *     decorative way of hiding the answer.
 */

export type ChartType = "column" | "line" | "bar" | "stacked" | "donut";

/** Distinct enough to tell apart, and legible on both themes. Cycled when a report has more. */
const SERIES = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];

const W = 960;
const H = 300;
const PAD = { top: 16, right: 16, bottom: 44, left: 8 };

export function ReportChart({
  result,
  type,
  format,
  averaged = false,
}: {
  result: ReportResult;
  type: ChartType;
  format: (n: number) => string;
  /**
   * Whether the measure is averaged rather than summed.
   *
   * Only the donut cares, and it cares absolutely: a share of a whole needs a whole, and the parts
   * of an average do not add up to it. `ReportResult` carries the unit but not this, so it has to
   * come from the caller, which is holding the chosen measure anyway.
   *
   * Optional and false by default so a caller that has not been taught to pass it gets the summed
   * reading — which is right for every measure but the handful marked `average` in the registry.
   */
  averaged?: boolean;
}) {
  const rows = result.rows;
  if (rows.length === 0) return null;

  const crossTab = result.columns.length > 1 || result.columns[0]?.key !== "__all__";

  /**
   * What the chart is, said in one sentence.
   *
   * Each of these SVGs carried `role="img"` and no accessible name, so a screen reader announced
   * "image" and stopped — and `role="img"` makes the subtree presentational, so the per-bar
   * `<title>` tooltips are not an alternative, they are invisible to it.
   *
   * A summary rather than a transcription, because the table underneath is always rendered and
   * already carries every number. Reading four hundred values twice helps nobody; knowing the
   * shape, the size and where the peak is, and that the figures are below, is what the picture was
   * conveying to everybody else.
   */
  const biggest = [...rows].sort((a, b) => b.total - a.total)[0];
  const shape =
    type === "donut" ? "Donut chart" : type === "bar" ? "Bar chart" : type === "line" ? "Line chart" : type === "stacked" ? "Stacked bar chart" : "Column chart";
  const summary =
    `${shape}. ${rows.length} ${rows.length === 1 ? "row" : "rows"}` +
    (crossTab ? `, ${result.columns.length} columns` : "") +
    `, totalling ${format(result.grandTotal)}` +
    (biggest ? `. Largest: ${biggest.label}, ${format(biggest.total)}` : "") +
    ". The same figures are in the table below.";

  if (type === "donut") return <Donut rows={rows} grandTotal={result.grandTotal} averaged={averaged} format={format} summary={summary} />;
  if (type === "bar") return <Bars rows={rows} format={format} summary={summary} />;
  if (type === "stacked" && crossTab) return <Stacked result={result} format={format} summary={summary} />;
  return <Columns rows={rows} format={format} line={type === "line"} summary={summary} />;
}

/**
 * The shape of a time bucket's key — `2026`, `2026-Q1`, `2026-03`, `2026-03-09`.
 *
 * Deliberately the *key* and not the label: `runReport` builds these and sorts the rows on them,
 * while the label is a human reading of the same thing ("Mar 26") that sorts alphabetically and so
 * cannot be trusted to say anything about order.
 */
const TIME_KEY = /^\d{4}(?:-(?:Q[1-4]|\d{2}(?:-\d{2})?))?$/;

/**
 * How many rows to draw, which end to take them from, and what to say about the rest.
 *
 * The end is the part that matters. A ranking arrives biggest-first, so the head is the answer and
 * the tail is the long thin bit nobody asked about. A time series arrives oldest-first, so the head
 * is ancient history: 233 days of orders drawn from the front is eleven per cent of itself ending
 * nine months ago, which does not read as a chart that ran out of room — it reads as a business
 * that stopped trading. Either way the cap itself stays, because fifty columns in 960px is a
 * texture rather than a chart.
 *
 * Chronological is read off the keys rather than passed in as a prop, because `runReport` mints
 * time keys to `TIME_KEY`'s shape and nothing else to it — every other dimension buckets on a name,
 * an enum, an SKU or a place code — and sorts precisely those rows ascending. Requiring both the
 * shape and the ordering is what makes this safe: a dimension whose every value looked like an ISO
 * date *and* which arrived in ascending order would be a date.
 */
function cap<T extends { key: string }>(rows: T[], limit: number): { shown: T[]; caption: string | null } {
  if (rows.length <= limit) return { shown: rows, caption: null };
  // The undated bucket passes the shape test and sits out the ordering one. It is a time row with
  // nothing to bucket on, one of them must not flip a 233-month report into being read as a
  // ranking, and where it lands among the dates is down to `localeCompare` on an em dash — which
  // is to say, down to the locale.
  const dated = rows.filter((r) => r.key !== NONE);
  const chronological =
    rows.every((r) => r.key === NONE || TIME_KEY.test(r.key)) &&
    dated.every((r, i) => i === 0 || dated[i - 1]!.key <= r.key);
  return {
    shown: chronological ? rows.slice(-limit) : rows.slice(0, limit),
    caption: chronological
      ? `Showing the most recent ${limit} of ${rows.length} periods. The table below has every one.`
      : `Showing the largest ${limit} of ${rows.length} rows. The table below has every one.`,
  };
}

// ─── Column and line ────────────────────────────────────────────────────────────────────────────

function Columns({
  rows,
  format,
  line,
  summary,
}: {
  rows: ReportResult["rows"];
  format: (n: number) => string;
  line: boolean;
  summary: string;
}) {
  const { shown, caption } = cap(rows, 40);
  const max = Math.max(...shown.map((r) => Math.abs(r.total)), 1);
  const plotH = H - PAD.top - PAD.bottom;
  const step = (W - PAD.left - PAD.right) / shown.length;
  const x = (i: number) => PAD.left + step * i + step / 2;
  const y = (v: number) => PAD.top + plotH - (Math.abs(v) / max) * plotH;

  return (
    <Frame max={max} format={format} summary={summary} caption={caption}>
      {line ? (
        <>
          <polyline
            fill="none"
            stroke={SERIES[0]}
            strokeWidth={2}
            strokeLinejoin="round"
            points={shown.map((r, i) => `${x(i)},${y(r.total)}`).join(" ")}
          />
          {shown.map((r, i) => (
            <circle key={r.key} cx={x(i)} cy={y(r.total)} r={3} fill={SERIES[0]}>
              <title>{`${r.label}: ${format(r.total)}`}</title>
            </circle>
          ))}
        </>
      ) : (
        shown.map((r, i) => {
          const barW = Math.max(2, step * 0.62);
          const top = y(r.total);
          return (
            <rect
              key={r.key}
              x={x(i) - barW / 2}
              y={top}
              width={barW}
              height={Math.max(1, PAD.top + plotH - top)}
              rx={2}
              fill={r.total < 0 ? "#ef4444" : SERIES[0]}
            >
              <title>{`${r.label}: ${format(r.total)}`}</title>
            </rect>
          );
        })
      )}
      {shown.map((r, i) => (
        // Every label when they fit, otherwise every nth — overlapping text reads as a smudge and
        // tells you less than no labels would.
        <text
          key={r.key}
          x={x(i)}
          y={H - PAD.bottom + 16}
          textAnchor="middle"
          className="fill-current text-[10px] text-subtle"
          opacity={shown.length <= 16 || i % Math.ceil(shown.length / 16) === 0 ? 1 : 0}
        >
          {r.label}
        </text>
      ))}
    </Frame>
  );
}

// ─── Horizontal bars ────────────────────────────────────────────────────────────────────────────

function Bars({ rows, format, summary }: { rows: ReportResult["rows"]; format: (n: number) => string; summary: string }) {
  const { shown, caption } = cap(rows, 20);
  const max = Math.max(...shown.map((r) => Math.abs(r.total)), 1);
  const rowH = 26;

  return (
    <>
    <svg viewBox={`0 0 ${W} ${shown.length * rowH + 12}`} className="w-full" role="img" aria-label={summary}>
      {shown.map((r, i) => {
        const width = (Math.abs(r.total) / max) * (W - 340);
        return (
          <g key={r.key} transform={`translate(0 ${i * rowH + 6})`}>
            <text x={0} y={13} className="fill-current text-[11px] text-muted">
              {r.label.length > 34 ? `${r.label.slice(0, 33)}…` : r.label}
            </text>
            <rect x={220} y={4} width={Math.max(2, width)} height={12} rx={3} fill={r.total < 0 ? "#ef4444" : SERIES[0]}>
              <title>{`${r.label}: ${format(r.total)}`}</title>
            </rect>
            <text x={230 + width} y={14} className="fill-current text-[11px] text-text">
              {format(r.total)}
            </text>
          </g>
        );
      })}
    </svg>
    {caption && <Caption>{caption}</Caption>}
    </>
  );
}

// ─── Stacked ────────────────────────────────────────────────────────────────────────────────────

function Stacked({ result, format, summary }: { result: ReportResult; format: (n: number) => string; summary: string }) {
  const { shown, caption } = cap(result.rows, 30);
  const cols = result.columns.slice(0, SERIES.length * 2);
  const totals = shown.map((r) => cols.reduce((acc, c) => acc + Math.max(0, r.cells[c.key] ?? 0), 0));
  const max = Math.max(...totals, 1);
  const plotH = H - PAD.top - PAD.bottom;
  const step = (W - PAD.left - PAD.right) / shown.length;

  return (
    <>
      <Frame max={max} format={format} summary={summary} caption={caption}>
        {shown.map((r, i) => {
          const barW = Math.max(2, step * 0.62);
          const left = PAD.left + step * i + step / 2 - barW / 2;
          // Each segment's offset resolved before the map, for the same reason as the donut's
          // angles: a stack that depends on mutation during render is a stack that can come out
          // in the wrong order.
          const segments = cols.reduce<{ col: (typeof cols)[number]; y: number; h: number; v: number }[]>((acc, c) => {
            const v = Math.max(0, r.cells[c.key] ?? 0);
            const h = (v / max) * plotH;
            const bottom = acc.length === 0 ? PAD.top + plotH : acc[acc.length - 1]!.y;
            return [...acc, { col: c, y: bottom - h, h, v }];
          }, []);
          return (
            <g key={r.key}>
              {segments.map(({ col, y, h, v }, ci) =>
                h < 0.5 ? null : (
                  <rect key={col.key} x={left} y={y} width={barW} height={h} fill={SERIES[ci % SERIES.length]}>
                    <title>{`${r.label} · ${col.label}: ${format(v)}`}</title>
                  </rect>
                ),
              )}
              <text
                x={left + barW / 2}
                y={H - PAD.bottom + 16}
                textAnchor="middle"
                className="fill-current text-[10px] text-subtle"
                opacity={shown.length <= 16 || i % Math.ceil(shown.length / 16) === 0 ? 1 : 0}
              >
                {r.label}
              </text>
            </g>
          );
        })}
      </Frame>
      <Legend items={cols.map((c, i) => ({ label: c.label, colour: SERIES[i % SERIES.length]! }))} />
    </>
  );
}

// ─── Donut ──────────────────────────────────────────────────────────────────────────────────────

function Donut({
  rows,
  grandTotal,
  averaged,
  format,
  summary,
}: {
  rows: ReportResult["rows"];
  /** The report's own total, as the card header states it — see the centre text below. */
  grandTotal: number;
  averaged: boolean;
  format: (n: number) => string;
  summary: string;
}) {
  /**
   * An average has no whole, so it has no shares.
   *
   * Drawn anyway, this ring put the *sum of the averages* in its middle — 8.25 d under a header
   * saying 2.06 d — and then made every slice a percentage of that sum, so "URGENT · 30%" read as
   * urgent tickets consuming thirty per cent of resolution time. They consume none of it: the
   * quantity is days-per-ticket and adding four of them together produces a number that measures
   * nothing. The explorer withholds the Share button for these measures, but it keeps whichever
   * chart was last chosen when the measure changes underneath it, so the refusal has to live here
   * too rather than only in the control.
   */
  if (averaged) {
    return (
      <Empty>
        This measure is an average, so its parts do not add up to a whole and there is no share to
        take of it. Bars compare them.
      </Empty>
    );
  }

  // Negative slices have no meaning in a share-of-whole, so they are excluded rather than drawn
  // as a wedge pointing the wrong way. Counted, though — see the note under the ring.
  const positive = rows.filter((r) => r.total > 0);
  const negatives = rows.filter((r) => r.total < 0).length;
  const top = positive.slice(0, 7);
  const rest = positive.slice(7).reduce((acc, r) => acc + r.total, 0);
  const slices = rest > 0 ? [...top, { key: "__rest__", label: `Other (${positive.length - 7})`, total: rest, cells: {} }] : top;
  const total = slices.reduce((acc, s) => acc + s.total, 0);
  /**
   * Said rather than drawn as nothing.
   *
   * This returned null, and the explorer has already committed to a bordered band around the chart
   * on `rows.length > 0` alone — so a report whose every row is zero, which is what "leads won, by
   * owner, filtered to lost" is, rendered as an empty ruled strip with no account of itself. The
   * container is on screen either way; the only question is whether it explains itself.
   */
  if (total <= 0) {
    return (
      <Empty>
        Nothing here has a positive value, so there is no whole to take a share of. The figures are
        in the table below.
      </Empty>
    );
  }

  const R = 92;
  const THICK = 30;

  // Angles computed up front rather than accumulated inside the map. Reassigning a variable across
  // a render is something React is free to reorder or memoise around, and the compiler refuses it
  // outright — correctly: a chart whose slices depend on the order the map happened to run in is
  // one that will eventually draw itself wrong and give no clue why.
  const wedges = slices.reduce<{ slice: (typeof slices)[number]; start: number; end: number }[]>((acc, slice) => {
    const start = acc.length === 0 ? -Math.PI / 2 : acc[acc.length - 1]!.end;
    return [...acc, { slice, start, end: start + (slice.total / total) * Math.PI * 2 }];
  }, []);

  return (
    <>
    <div className="flex flex-wrap items-center gap-6">
      <svg viewBox="0 0 220 220" className="h-56 w-56 shrink-0" role="img" aria-label={summary}>
        {wedges.map(({ slice, start, end }, i) => (
          <path key={slice.key} d={arc(110, 110, R, R - THICK, start, end)} fill={SERIES[i % SERIES.length]}>
            <title>{`${slice.label}: ${format(slice.total)} (${Math.round((slice.total / total) * 100)}%)`}</title>
          </path>
        ))}
        {/* The report's total, not the ring's. A donut centre is read against the header six
            inches above it, and those two numbers disagreeing is a discrepancy somebody has to
            chase; the ring falling short of its own middle is the ordinary business of a
            share-of-whole, and the note below accounts for the difference. */}
        <text x={110} y={114} textAnchor="middle" className="fill-current text-sm font-semibold text-text">
          {format(grandTotal)}
        </text>
      </svg>
      <Legend
        items={slices.map((s, i) => ({
          label: `${s.label} · ${Math.round((s.total / total) * 100)}%`,
          colour: SERIES[i % SERIES.length]!,
        }))}
        stacked
      />
    </div>
    {/**
      * Triggered by the discrepancy, not by one of its causes.
      *
      * This fired on `negatives > 0` and told the reader the negatives were *why* the slices do not
      * sum to the header — which is one reason among several. A multi-valued dimension puts a record
      * in two slices, so they exceed the total; the "Other" fold is dropped entirely when its tail
      * sums to nothing. On either of those the caption stayed silent while the numbers disagreed,
      * and where negatives merely happened to be present as well it named the wrong cause.
      *
      * So the condition is the thing worth saying — these are shares of X, not of the Y above — and
      * the negatives are mentioned only as a contributing fact when there are any.
      */}
    {Math.abs(total - grandTotal) > 0.005 && (
      <Caption>
        The slices are shares of {format(total)} rather than of the {format(grandTotal)} above
        {negatives > 0 &&
          (negatives === 1 ? ", because one row is negative and is not drawn" : `, because ${negatives} rows are negative and are not drawn`)}
        .
      </Caption>
    )}
    </>
  );
}

/** A donut segment. Two arcs and two radial lines — the standard construction. */
function arc(cx: number, cy: number, rOuter: number, rInner: number, start: number, end: number) {
  const large = end - start > Math.PI ? 1 : 0;
  const p = (r: number, a: number) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
  return [
    `M ${p(rOuter, start)}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${p(rOuter, end)}`,
    `L ${p(rInner, end)}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${p(rInner, start)}`,
    "Z",
  ].join(" ");
}

// ─── Shared ─────────────────────────────────────────────────────────────────────────────────────

function Frame({
  max,
  format,
  summary,
  caption,
  children,
}: {
  max: number;
  format: (n: number) => string;
  summary: string;
  /** What `cap` left out, said under the plot. Null when everything is drawn. */
  caption?: string | null;
  children: React.ReactNode;
}) {
  const plotH = H - PAD.top - PAD.bottom;
  const lines = [0, 0.25, 0.5, 0.75, 1];
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={summary}>
        {lines.map((f) => {
          const y = PAD.top + plotH - f * plotH;
          return (
            <g key={f}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} className="stroke-current text-line" strokeWidth={1} />
              <text x={W - PAD.right} y={y - 3} textAnchor="end" className="fill-current text-[10px] text-subtle">
                {f === 0 ? "" : format(max * f)}
              </text>
            </g>
          );
        })}
        {children}
      </svg>
      {caption && <Caption>{caption}</Caption>}
    </>
  );
}

/**
 * A line of small print under a chart, for what the picture is not showing.
 *
 * Deliberately not inside the SVG: it is prose about the chart rather than part of it, it has to
 * wrap on a narrow screen, and `role="img"` would hide it from a screen reader — which is the one
 * reader most in need of being told that forty of two hundred and thirty-three rows are drawn.
 */
function Caption({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-xs text-subtle">{children}</p>;
}

/**
 * What stands in for a chart that would be a lie.
 *
 * Sized and worded like the explorer's empty table, so the two read as one voice — and given the
 * same vertical weight as a chart, because the band it sits in is already ruled off and a single
 * thin line of text in it looks like something failed to load.
 */
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="mx-auto max-w-prose py-10 text-center text-sm text-subtle">{children}</p>;
}

function Legend({ items, stacked }: { items: { label: string; colour: string }[]; stacked?: boolean }) {
  return (
    <ul className={stacked ? "space-y-1.5" : "mt-2 flex flex-wrap gap-x-4 gap-y-1.5"}>
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5 text-xs text-muted">
          <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: i.colour }} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}
