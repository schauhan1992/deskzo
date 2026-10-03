import { bucketOf, NONE, ROW_CAP, type FactSource, type Grain } from "./types";
import type { Clock } from "@/lib/time/zone";

/**
 * Turning rows into a table.
 *
 * Kept apart from the sources and from the action so it can be reasoned about on its own: it takes
 * rows and two functions, and returns buckets. No database, no session, no permissions — those were
 * all settled before anything got here.
 */

export type Cell = { key: string; label: string; value: number; rows: number };

export type ReportResult = {
  columns: { key: string; label: string }[];
  rows: {
    key: string;
    label: string;
    cells: Record<string, number>;
    total: number;
  }[];
  columnTotals: Record<string, number>;
  /**
   * The measure over every counted record, **once each** — not the sum of the row totals.
   *
   * The distinction only shows up two ways, and both of them used to be wrong here. A record that
   * falls in several buckets was counted once per bucket, so the one number on the page that is
   * meant to be the undivided whole was the most double-counted number on it. And an averaged
   * measure was averaged twice — the mean of the bucket means — which gave a customer with one
   * ticket the same weight as one with fifty, and made the same question return a different "Total"
   * for every breakdown somebody chose.
   */
  grandTotal: number;
  rowCount: number;
  /** True when the source hit `ROW_CAP` and the numbers are therefore a floor, not a total. */
  truncated: boolean;
  /**
   * True when a record actually landed in more than one cell, so the parts exceed the whole.
   *
   * What happened, not what could have: this was `rowDim?.multi || colDim?.multi`, so every report
   * broken down by tag warned about an inflation that had not occurred — most accounts carry one
   * tag, and a warning that is always on is one nobody reads on the day it is true.
   */
  doubleCounted: boolean;
  /**
   * Every value each dimension took, so the filter panel can offer real options.
   *
   * Derived from the rows rather than queried: the list is then exactly what this person can
   * see in this window, so a filter can never name a value that would return nothing — or,
   * worse, hint at a brand on an account they were not given.
   */
  values: Record<string, string[]>;
  /**
   * How many distinct values each dimension really has.
   *
   * `values` above is capped at `FILTER_VALUE_CAP`, so on a wide dimension it is a slice of the
   * alphabet rather than the list. Anything offering those values has to be able to say so, and it
   * cannot work that out from a list whose length is exactly the cap.
   */
  valueCounts: Record<string, number>;
  /**
   * Rows dropped by the **dimension** filters, so the report can say it is a subset.
   *
   * Those only. The account filters narrow the query itself, so rows they excluded never reached
   * this function and are not in this number — a caption that counts "the filters above" over both
   * panels is claiming something this field cannot support.
   */
  filteredOut: number;
  /**
   * How many column buckets were folded into the single `OTHER_COLUMN`, or 0 when none were.
   *
   * Their numbers are still in that column and in every total; the table simply cannot show a
   * column each. Carried beside `truncated` because it has the same job: the sheet has to say it
   * is showing a slice rather than quietly showing one.
   */
  columnsFolded: number;
  unit: "currency" | "number" | "days";
  scopeNote: string;
};

type RunParams<Row> = {
  source: FactSource<Row>;
  rows: Row[];
  measureKey: string;
  /** What the table's rows are broken down by. */
  dimensionKey: string;
  /** Optional second breakdown, which becomes the columns. Time is the usual one. */
  columnKey?: string;
  grain: Grain;
  /** Whose days, weeks and months the time buckets are: the workspace's (`workspaceClock()`). */
  clock: Clock;
  dateKey: string;
  scopeNote: string;
  /**
   * Dimension -> the values to keep. Applied in memory, after loading.
   *
   * The company-level filters narrow the query itself; these narrow what came back. They have
   * to work this way round because a dimension may be derived — a tag, a bucketed date, the
   * primary location's city — and there is no column to put in a WHERE clause for those.
   */
  filters?: Record<string, string[]>;
};

const ALL = "__all__";

/**
 * Every value each dimension takes across a set of rows.
 *
 * Pulled out of `runReport` because two callers need it and they must not answer differently: the
 * report returns it so the panel can offer options once a report has been run, and the panel asks
 * for it directly so somebody can narrow *before* running — "AutoCAD, in Pune, last quarter" is a
 * question you ask up front, not one you arrive at by running the wrong report first and clicking.
 *
 * Derived from rows rather than queried, which is the point: the list is exactly what this person
 * can see in this window, so a filter can never name a value that returns nothing — or, worse, hint
 * at a brand on an account they were not given.
 *
 * Capped per dimension. A Customer dimension over a wide window is thousands of names, and a
 * select nobody can scroll is not an option list.
 *
 * The cap is returned alongside the lists rather than applied silently. It used to cut the tail off
 * the alphabet with nothing said, and the panel then printed the length of what it had been given —
 * "Search 300 customers…" — which reads as the whole list and is exactly the number that proves it
 * is not. `counts` is the pre-cap total, so the offer can name what it is leaving out.
 */
export const FILTER_VALUE_CAP = 300;

export type DimensionOptions = {
  /** At most `FILTER_VALUE_CAP` values per dimension, alphabetically. */
  values: Record<string, string[]>;
  /** How many distinct values each dimension has, before the cap. */
  counts: Record<string, number>;
};

export function dimensionOptions<Row>(source: FactSource<Row>, rows: Row[]): DimensionOptions {
  const values: Record<string, string[]> = {};
  const counts: Record<string, number> = {};
  for (const d of source.dimensions) {
    const seen = new Set<string>();
    for (const row of rows) {
      const v = d.of(row);
      const list = Array.isArray(v) ? v : [v];
      /**
       * An empty list is the "—" bucket, exactly as `asBuckets` treats it.
       *
       * Spelled out rather than left to each dimension to handle: a dimension returning a bare
       * empty array would otherwise be bucketed as "—" by the report and offered by nothing, so the
       * panel would have no way to ask for the rows that have none — which is usually the most
       * interesting question on that column.
       */
      if (list.length === 0) seen.add(NONE);
      else for (const b of list) seen.add(b);
    }
    const sorted = [...seen].sort((a, b) => a.localeCompare(b));
    counts[d.key] = sorted.length;
    values[d.key] = sorted.slice(0, FILTER_VALUE_CAP);
  }
  return { values, counts };
}

/** Just the lists, for the callers that have no way to say what was cut. */
export function dimensionValues<Row>(source: FactSource<Row>, rows: Row[]): Record<string, string[]> {
  return dimensionOptions(source, rows).values;
}

/**
 * The most columns a cross-tab will show, and the bucket the rest are folded into.
 *
 * `runReport` fills every column for every row, so a sparse cross-tab comes back dense: two
 * dropdowns produced a 96 × 233 table — twenty-odd thousand cells over the wire and the same number
 * of DOM nodes — while every chart drawn from the same result capped itself at forty series or
 * fewer. The table, the CSV and the payload were the only three things with no ceiling at all.
 *
 * Folded rather than dropped, so nothing leaves the totals, and counted in `columnsFolded` so the
 * sheet can say how many columns it is standing in for.
 */
export const COLUMN_CAP = 40;
export const OTHER_COLUMN = "__other__";

export function runReport<Row>(params: RunParams<Row>): ReportResult {
  const { source, rows, grain, clock } = params;

  const measure = source.measures.find((m) => m.key === params.measureKey) ?? source.measures[0]!;
  const dateField = source.dateFields.find((d) => d.key === params.dateKey) ?? source.dateFields[0]!;

  // "time" is not in the dimension registry — it is the date field the report is already placed on,
  // bucketed at the chosen grain. Treating it as just another dimension would mean declaring five
  // near-identical entries per source.
  const asBuckets = (key: string | undefined, row: Row): string[] => {
    if (!key) return [ALL];
    if (key === "time") {
      const at = dateField.get(row);
      return at ? [bucketOf(at, grain, clock).key] : [NONE];
    }
    const dim = source.dimensions.find((d) => d.key === key);
    if (!dim) return [ALL];
    const v = dim.of(row);
    const list = Array.isArray(v) ? v : [v];
    return list.length === 0 ? [NONE] : list;
  };

  const labelFor = (key: string | undefined, bucket: string): string => {
    if (!key || bucket === ALL) return "Total";
    if (key === "time") {
      // The key is ISO-ish so it sorts; the label is for reading. Recovering one from the other
      // beats carrying a parallel map around.
      if (bucket === NONE) return NONE;
      if (grain === "year") return bucket;
      if (grain === "quarter") return bucket.replace("-", " ");
      const [y, m, d] = bucket.split("-");
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const mon = months[Number(m) - 1] ?? m;
      const short = String(y).slice(2);
      if (grain === "month") return `${mon} ${short}`;
      return grain === "week" ? `w/c ${Number(d)} ${mon}` : `${Number(d)} ${mon} ${short}`;
    }
    return bucket;
  };

  // Narrow before anything is counted. A row excluded here is excluded from the totals too,
  // which is the only reading of a filter anybody expects.
  const active = Object.entries(params.filters ?? {}).filter(([, v]) => v.length > 0);
  const kept = active.length === 0
    ? rows
    : rows.filter((row) =>
        active.every(([key, allowed]) => asBuckets(key, row).some((b) => allowed.includes(b))),
      );
  const filteredOut = rows.length - kept.length;

  /**
   * The buckets a kept row lands in on one axis, intersected with that axis's own filter.
   *
   * `kept` above deliberately keeps a record that matches on *any* of its values — "show me the
   * Enterprise accounts, by salesperson" has to keep the whole record. But when the filtered
   * dimension *is* the breakdown axis, bucketing it under its other values too put rows in the
   * table that nobody asked for: filter to Enterprise, break down by tag, and a record tagged both
   * came back as an Enterprise row *and* a Renewal row, its money counted under each.
   */
  const allowedOn = new Map(active);
  const bucketsFor = (key: string | undefined, row: Row): string[] => {
    const buckets = asBuckets(key, row);
    const allowed = key === undefined ? undefined : allowedOn.get(key);
    return allowed ? buckets.filter((b) => allowed.includes(b)) : buckets;
  };

  // Offered from the unfiltered set, so removing a filter is always possible — a panel that
  // only lists what survives the current filters is one you can paint yourself into.
  const { values, counts: valueCounts } = dimensionOptions(source, rows);

  // bucket -> column -> { sum, n }. Counts are kept alongside the sum because an averaged measure
  // cannot be derived from a total afterwards.
  const table = new Map<string, Map<string, { sum: number; n: number }>>();
  const columns = new Set<string>();

  /**
   * The headline, accumulated off the records rather than off the finished table.
   *
   * One record, one contribution, whatever it is broken down by. Summing the row totals instead
   * meant a multi-tagged record inflated the headline by exactly as much as it inflated the rows,
   * while the caption underneath told the reader the rows exceeded the total — and for an averaged
   * measure it meant averaging the bucket means, so the answer moved when the breakdown did.
   */
  const grand = { sum: 0, n: 0 };
  let doubleCounted = false;

  for (const row of kept) {
    const value = measure.value(row);
    // An averaged measure ignores rows that did not contribute — an unresolved ticket has no
    // resolution time, and counting it as zero would drag the average towards a flattering lie.
    const contributes = !measure.average || value > 0;

    grand.sum += value;
    if (contributes) grand.n += 1;

    const rowBuckets = bucketsFor(params.dimensionKey, row);
    const colBuckets = bucketsFor(params.columnKey, row);
    // Set from what this record did, not from what its dimension is allowed to do.
    if (rowBuckets.length * colBuckets.length > 1) doubleCounted = true;

    for (const r of rowBuckets) {
      for (const c of colBuckets) {
        columns.add(c);
        const line = table.get(r) ?? new Map();
        const cell = line.get(c) ?? { sum: 0, n: 0 };
        cell.sum += value;
        if (contributes) cell.n += 1;
        line.set(c, cell);
        table.set(r, line);
      }
    }
  }

  const finish = (cell: { sum: number; n: number } | undefined) => {
    if (!cell) return 0;
    if (!measure.average) return cell.sum;
    return cell.n === 0 ? 0 : cell.sum / cell.n;
  };

  // In the order they read: chronological when the columns are time, alphabetical otherwise.
  const allColumns = [...columns].sort((a, b) => a.localeCompare(b));

  /**
   * What a column is worth, for deciding which survive `COLUMN_CAP`.
   *
   * For a summed measure that is the money in it. For an averaged one it is how many records it
   * averages rather than how big the average is — ranking by the mean would keep the column holding
   * one slow ticket and fold away the one holding five hundred.
   */
  const weightOf = (c: string) => {
    let w = 0;
    for (const line of table.values()) {
      const cell = line.get(c);
      if (cell) w += measure.average ? cell.n : Math.abs(cell.sum);
    }
    return w;
  };

  /**
   * Which columns are kept depends on what the axis is.
   *
   * A time axis keeps the most recent periods and folds the older ones into a leading bucket, so
   * the header stays in date order; anything else keeps the heaviest and appends one at the end.
   * Folding the middle of a chronology into a column at the right-hand end would read as a period
   * of its own, which is a worse lie than the width it fixes.
   *
   * "No date" is held out of that fold, because it is not a period either.
   *
   * `NONE` is "—", which sorts ahead of every `yyyy-…` key, and a capped time axis keeps the *last*
   * `COLUMN_CAP` columns — so the undated bucket was always the first thing folded away, and then
   * labelled "Earlier". A record with no date is not a record from before the window; that is a
   * different claim, and a confident one. It keeps its own column at the front instead.
   *
   * Only on a time axis. Everywhere else "—" is an ordinary value competing on weight like the rest,
   * and "Other" is an honest home for it.
   */
  const timeAxis = params.columnKey === "time";
  const undated = timeAxis && allColumns.includes(NONE);
  const periodColumns = undated ? allColumns.filter((c) => c !== NONE) : allColumns;

  const overCap = periodColumns.length > COLUMN_CAP;
  const survivors = !overCap
    ? allColumns
    : timeAxis
      ? [...(undated ? [NONE] : []), ...periodColumns.slice(-COLUMN_CAP)]
      : (() => {
          const top = new Set([...allColumns].sort((a, b) => weightOf(b) - weightOf(a)).slice(0, COLUMN_CAP));
          // Back into reading order: the cap decides which columns, not what order they come in.
          return allColumns.filter((c) => top.has(c));
        })();

  const surviving = new Set(survivors);
  const foldedKeys = allColumns.filter((c) => !surviving.has(c));

  // Folded at { sum, n } rather than on the finished numbers, so an averaged "Other" is the mean
  // over the records it stands for and not the mean of a handful of means.
  for (const line of table.values()) {
    const rest = { sum: 0, n: 0 };
    let any = false;
    for (const c of foldedKeys) {
      const cell = line.get(c);
      if (!cell) continue;
      rest.sum += cell.sum;
      rest.n += cell.n;
      line.delete(c);
      any = true;
    }
    if (any) line.set(OTHER_COLUMN, rest);
  }

  const columnKeys =
    foldedKeys.length === 0
      ? survivors
      : timeAxis
        ? // Undated first, then the column standing in for the oldest periods, then the periods
          // themselves — so the header still reads left to right in time, with the one column that
          // is not a period sitting outside the sequence rather than at the head of it.
          [...survivors.filter((c) => c === NONE), OTHER_COLUMN, ...survivors.filter((c) => c !== NONE)]
        : [...survivors, OTHER_COLUMN];

  const out = [...table.entries()].map(([key, line]) => {
    const cells: Record<string, number> = {};
    for (const c of columnKeys) cells[c] = round(finish(line.get(c)));
    const all = [...line.values()];
    const total = measure.average
      ? (() => {
          const n = all.reduce((acc, c) => acc + c.n, 0);
          return n === 0 ? 0 : round(all.reduce((acc, c) => acc + c.sum, 0) / n);
        })()
      : round(all.reduce((acc, c) => acc + c.sum, 0));
    return { key, label: labelFor(params.dimensionKey, key), cells, total };
  });

  // Biggest first for a plain breakdown, but chronological when the rows are time — a list of
  // months ordered by revenue is not something anybody reads.
  out.sort((a, b) => (params.dimensionKey === "time" ? a.key.localeCompare(b.key) : b.total - a.total));

  /**
   * Down the column from the cells' own { sum, n }, exactly as each row's total is built across it.
   *
   * This averaged the rounded numbers in `out` and dropped the zeroes first, which is two mistakes
   * in one line: a column's total came out as the mean of its bucket means — one ticket weighing as
   * much as fifty — and the `!== 0` was a guess at which cells were empty, when an empty cell says
   * so itself by contributing n = 0.
   */
  const columnTotals: Record<string, number> = {};
  for (const c of columnKeys) {
    const down = { sum: 0, n: 0 };
    for (const line of table.values()) {
      const cell = line.get(c);
      if (!cell) continue;
      down.sum += cell.sum;
      down.n += cell.n;
    }
    columnTotals[c] = round(finish(down));
  }

  const foldedLabel = timeAxis ? `Earlier (${foldedKeys.length} more)` : `Other (${foldedKeys.length} more)`;

  return {
    columns: columnKeys.map((c) => ({
      key: c,
      label: c === OTHER_COLUMN ? foldedLabel : labelFor(params.columnKey, c),
    })),
    rows: out,
    columnTotals,
    grandTotal: round(finish(grand)),
    rowCount: kept.length,
    truncated: rows.length >= ROW_CAP,
    doubleCounted,
    unit: measure.unit,
    scopeNote: params.scopeNote,
    values,
    valueCounts,
    filteredOut,
    columnsFolded: foldedKeys.length,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
