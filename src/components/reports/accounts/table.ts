import { csvRow } from "@/lib/csv";

/**
 * The shape every Finance → Accounts report comes back in (owner, 22 Oct 2026): columns, rows of cells, totals
 * over the whole filtered set (never just the page), and a few notes on how it was worked out. One shape, so one
 * component draws every report (report-view.tsx) and one function writes every report's CSV — a column added to
 * a report is on the screen and in the file at once, and the two can't disagree.
 *
 * Pure, no server imports: the report actions build it, the page draws it.
 */

export type ColumnKind = "text" | "qty" | "money" | "cost" | "date" | "int" | "days";

export type ReportColumn = {
  key: string;
  label: string;
  kind?: ColumnKind;
  /** Left blank on a row that continues the one above (`ReportRow.continues`) — the day book's date and number. */
  group?: boolean;
};

/** A cell that links somewhere, with an optional second line under it. */
export type LinkCell = { text: string; href?: string | null; sub?: string | null };
export type Cell = string | number | null | LinkCell;

export type ReportRow = {
  id: string;
  cells: Record<string, Cell>;
  /** Drawn quietly (an opening balance), loudly (a total), or as a warning (below reorder, expired). */
  tone?: "muted" | "strong" | "warning" | "danger";
  /** Another line of the same entry as the row above. */
  continues?: boolean;
};

export type ReportTable = {
  key: string;
  title: string;
  subtitle?: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Over every row the filters match, not only this page's. */
  totals?: Record<string, Cell> | null;
  /** Rows (or, for the day book, entries) the filters match. */
  total: number;
  page: number;
  pageSize: number;
  notes?: string[];
  /** What to call the rows in the pager — "items", "entries". */
  unit?: string;
};

export type ReportResult = { status: "ok"; table: ReportTable } | { status: "forbidden" } | { status: "not-migrated" } | { status: "invalid"; message: string };

export function cellText(cell: Cell | undefined): string | number {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "object") return cell.sub ? `${cell.text} (${cell.sub})` : cell.text;
  return cell;
}

/**
 * The report as CSV: a few lines saying what it is and how it was filtered, a blank line, the header, the rows,
 * and the totals. Every text cell goes through `csvRow`'s formula guard; numbers go out as numbers.
 */
export function tableToCsv(table: ReportTable, context: [string, string][]): string {
  const head = [["Report", table.title], ...(table.subtitle ? ([["Period", table.subtitle]] as [string, string][]) : []), ...context].map((pair) => csvRow(pair));
  const header = csvRow(table.columns.map((c) => c.label));
  const rows = table.rows.map((r) => csvRow(table.columns.map((c) => cellText(r.cells[c.key]))));
  const totals = table.totals ? [csvRow(table.columns.map((c, i) => (i === 0 && table.totals![c.key] == null ? "Total" : cellText(table.totals![c.key]))))] : [];
  const notes = (table.notes ?? []).map((n) => csvRow(["Note", n]));
  return [...head, ...notes, "", header, ...rows, ...totals].join("\n");
}

/** `yyyy-mm-dd`, or null when it isn't one — what a report's date filters accept. */
export function dateParam(value: string | null | undefined): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : null;
}
