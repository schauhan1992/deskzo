/**
 * Slicing the business by anything, without writing a page per question.
 *
 * ## The shape
 *
 * Four things make a report, and they are independent:
 *
 *   - a **source** — the kind of record being counted: orders, leads, tickets, invoices, payments,
 *     visits. Each is a fact table with its own scoping rule.
 *   - a **measure** — the number: value, margin, quantity, how many.
 *   - a **dimension** — what to break it down by: month, salesperson, brand, tag, lead source.
 *   - **filters** — a date window, and optionally a value on any dimension.
 *
 * Declared this way, "order value by brand this quarter" and "tickets by priority by month" are the
 * same code with different arguments. Adding "by product family" is one entry in a registry, not a
 * page, a query and a chart.
 *
 * ## Why this aggregates in memory rather than in SQL
 *
 * A deliberate trade, and worth stating because it is the kind of decision that looks lazy.
 *
 * Prisma's `groupBy` only groups by scalar columns on the model being queried. Half the dimensions
 * here are two or three hops away — an order's brand is `order → item → brand`, its industry is
 * `order → company → industry` — so anything genuinely flexible would have to be hand-written SQL,
 * with the account-scoping predicate interpolated into it by hand, in every combination. That is
 * precisely the shape of mistake that silently returns other people's rows rather than failing.
 *
 * Instead each source loads the rows the viewer is allowed to see — once, through one scoping rule
 * — and every dimension is an ordinary function from a row to a bucket. A dimension cannot get the
 * scoping wrong because it never sees the query. The cost is holding the rows in memory, which for
 * a business of this size is nothing; `ROW_CAP` bounds it, and a report that hits the cap says so
 * rather than quietly reporting a fraction of the truth.
 */

import type { Clock } from "@/lib/time/zone";
import type { CustomFieldEntityKey } from "@/lib/custom-fields/rules";
import type { WorkbookFilters } from "@/lib/workspace/filters";

export type Grain = "day" | "week" | "month" | "quarter" | "year";

export const GRAINS: { key: Grain; label: string }[] = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "quarter", label: "Quarter" },
  { key: "year", label: "Year" },
];

/**
 * The most rows one report will load.
 *
 * High enough that no real question hits it, low enough that a mistake cannot exhaust the server.
 * When it is hit the report says so — a truncated total presented as a total is worse than no
 * total, because somebody will act on it.
 */
export const ROW_CAP = 50_000;

export type Unit = "currency" | "number" | "days";

export type Measure<Row> = {
  key: string;
  label: string;
  unit: Unit;
  /**
   * This row's contribution, summed across the bucket. Rows that should not count return 0 — a
   * lead that was never won contributes nothing to "won value" but is still one row.
   */
  value: (row: Row) => number;
  /** Averaged over the rows that contributed rather than summed — resolution time, say. */
  average?: boolean;
  description?: string;
  /** One of the workspace's own fields (src/lib/analytics/custom.ts), offered under "Your fields". */
  custom?: boolean;
};

export type Dimension<Row> = {
  key: string;
  label: string;
  /**
   * Which bucket this row falls in.
   *
   * Returning an array puts the row in several — a company carries any number of tags, and asking
   * for revenue by tag means a two-tag account is genuinely part of both answers. The report says
   * when a dimension does this, because the columns then sum to more than the total and somebody
   * comparing them to the grand total deserves to know why rather than to find out.
   */
  of: (row: Row) => string | string[];
  multi?: boolean;
  /** One of the workspace's own fields (src/lib/analytics/custom.ts), offered under "Your fields". */
  custom?: boolean;
};

/**
 * A record a source's rows reach whose own fields (src/lib/custom-fields) a report can use — the
 * order itself, its customer, its product.
 *
 * Declared on the source beside the load that fetches them, because the two have to agree: a reach
 * listed here whose column the load never asks for is a dimension that is always empty, and an
 * always-empty dimension reads as a business with no regions rather than as a broken report.
 * src/lib/analytics/custom.ts turns the fields one person may see on each record into dimensions,
 * and the number fields on the rows' own records into measures.
 */
export type CustomFieldReach<Row> = {
  entity: CustomFieldEntityKey;
  /** What the record is called in this source's labels: "Customer" makes "Customer · Region". */
  noun: string;
  /**
   * The rows *are* these records, so a number field on them can be added up. Only then: a
   * customer's credit limit repeats on every order of theirs, and totalled over the orders it would
   * be counted once per order — a confident number nobody could use.
   */
  own?: boolean;
  /** The record's stored values off a loaded row. Absent when the load was not asked for them. */
  values: (row: Row) => unknown;
};

/** A date column a report can be placed on. An order has several and they mean different things. */
/**
 * A date column a report can be placed on. An order has several and they mean different things.
 *
 * `get` reads it off a loaded row, for bucketing. `column` is the same field's name in the
 * database, for the `where` — and both are needed, because the window has to be applied to the
 * column the person actually chose.
 *
 * They were not both needed until recently, because the window was applied to a hard-coded column
 * and only the bucketing followed the choice. Picking "Expires on" therefore loaded the orders
 * *punched* in the window and then grouped them by expiry: a renewals report — the commonest
 * question this business asks — returned entirely the wrong rows, and looked plausible because
 * the columns were labelled with expiry dates.
 */
export type DateField<Row> = {
  key: string;
  label: string;
  get: (row: Row) => Date | null;
  /** The Prisma field to bound the query on. Defaults to `key`, which is usually the same. */
  column?: string;
};

export type SourceContext = {
  userId: string;
  from: Date;
  to: Date;
  /**
   * The workspace filter set, applied to the company each row hangs off.
   *
   * Reused rather than reinvented: `buildWhere` in src/lib/workspace/filters.ts already encodes
   * forty ways to describe a set of companies, and it is the vocabulary people here already
   * think in. A second filter language for reports would be a second set of bugs and a second
   * thing to learn.
   */
  companyFilters?: WorkbookFilters;
  /**
   * The database column to bound the query on — the "Dated on" control, already resolved.
   *
   * Resolved by the caller rather than the source, because the caller has the source in hand and
   * the source's `load` is declared above its own `dateFields`. `resolveDateColumn` below is the
   * one place that does it.
   */
  dateColumn: string;
  /**
   * Which records' own fields the rows should carry, as `customFields` — the record's, its company's,
   * its product's. Set by src/lib/analytics/custom.ts for the fields this person can report by; absent,
   * a load names none of those columns, exactly as it did before there were any.
   */
  customFields?: ReadonlySet<CustomFieldEntityKey>;
};

/**
 * Which column a report's chosen "Dated on" field means.
 *
 * Falls back to the source's first field, which is what every `load` used to hard-code — so a
 * request that names nothing behaves exactly as it did.
 */
export function resolveDateColumn<Row>(source: { dateFields: DateField<Row>[] }, dateKey: string | undefined): string {
  const field = source.dateFields.find((f) => f.key === dateKey) ?? source.dateFields[0]!;
  return field.column ?? field.key;
}

export type FactSource<Row = never> = {
  key: string;
  label: string;
  description: string;
  /** Null for sources built on always-on data. */
  moduleKey: string | null;
  /**
   * Whether every row reaches a company, and so whether the workspace filters can apply.
   *
   * Leads hang off a company; so do orders, invoices, payments, tickets and visits. If a source
   * is ever added that does not, the filter panel has to hide rather than silently ignore what
   * somebody set — a filter that appears to apply and does not is worse than no filter.
   */
  companyAnchored: boolean;
  /**
   * The rows this person may see, already scoped. The single place scoping is decided for this
   * source — see the note at the top of the file.
   */
  load: (ctx: SourceContext) => Promise<Row[]>;
  /** What the account scoping did, so the report can say whose numbers these are. */
  scopeNote: (ctx: SourceContext) => Promise<string>;
  measures: Measure<Row>[];
  dimensions: Dimension<Row>[];
  dateFields: DateField<Row>[];
  /** The records whose own fields this source can be broken down by — see `CustomFieldReach`. */
  customFields?: CustomFieldReach<Row>[];
};

// ─── Time buckets ───────────────────────────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The bucket a date falls in, and a key that sorts correctly as a string.
 *
 * Sorting matters more than it looks: "Apr 2026" before "Jan 2026" is what you get from sorting the
 * labels, and a chart in alphabetical month order is not a chart. So the key is ISO-ish and the
 * label is for reading — they are not the same string.
 */
/**
 * Which bucket an instant falls in, on the calendar of the clock passed in — the workspace's, for a
 * report; India's, for the books.
 *
 * This read `getFullYear()`, `getMonth()` and `getDate()` — the *host's* calendar. Correct on a
 * laptop in Pune and wrong in the container this deploys to, where the clock is UTC: an order
 * punched at 01:30 IST on 1 October is 20:00 UTC on 30 September, so a monthly report put October's
 * revenue in September. Nothing about that looks wrong on screen; the month totals are simply off,
 * and they are off by the orders placed in the hours after midnight, which for a business that
 * punches renewals late is not a rounding error.
 *
 * Everything below works from `clock.parts`, so no `Date` is ever asked what day it is.
 */
export function bucketOf(date: Date, grain: Grain, clock: Clock): { key: string; label: string } {
  const { year: y, month: m, day: dayOfMonth, weekday } = clock.parts(date);

  switch (grain) {
    case "day": {
      const key = `${y}-${String(m + 1).padStart(2, "0")}-${String(dayOfMonth).padStart(2, "0")}`;
      return { key, label: `${dayOfMonth} ${MONTHS[m]} ${String(y).slice(2)}` };
    }
    case "week": {
      // Monday-based, and keyed on that Monday's date so weeks sort and never collide across years
      // — an ISO week number alone puts week 1 of next January before week 52 of this December.
      // Counted back on the calendar alone — day arithmetic on the clock's date, held as UTC — so
      // the week never shifts a day because the host is in another zone.
      const at = new Date(Date.UTC(y, m, dayOfMonth - ((weekday + 6) % 7)));
      const monday = { year: at.getUTCFullYear(), month: at.getUTCMonth(), day: at.getUTCDate() };
      const key = `${monday.year}-${String(monday.month + 1).padStart(2, "0")}-${String(monday.day).padStart(2, "0")}`;
      return { key, label: `w/c ${monday.day} ${MONTHS[monday.month]}` };
    }
    case "month":
      return { key: `${y}-${String(m + 1).padStart(2, "0")}`, label: `${MONTHS[m]} ${String(y).slice(2)}` };
    case "quarter": {
      const q = Math.floor(m / 3) + 1;
      return { key: `${y}-Q${q}`, label: `Q${q} ${String(y).slice(2)}` };
    }
    case "year":
      return { key: String(y), label: String(y) };
  }
}

/** Shown wherever a row has no value for the dimension, so an empty bucket is never a blank row. */
export const NONE = "—";
