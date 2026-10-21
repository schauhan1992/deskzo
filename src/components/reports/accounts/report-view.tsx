import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, totalPages } from "@/lib/pagination";
import { formatQuantity, formatRupees } from "@/lib/accounts/money";
import { formatCalendarDay } from "@/lib/time/zone";
import { cn } from "@/lib/utils";
import type { Cell, ColumnKind, ReportColumn, ReportRow, ReportTable } from "@/components/reports/accounts/table";

/**
 * Draws any Finance → Accounts report (table.ts): amounts and quantities right-aligned in tabular figures, links
 * to whatever a row is about, the totals over the whole filtered set at the foot, the notes on how it was
 * worked out, and the pager. The table scrolls inside its own panel, so a wide report never widens the page.
 */

const numeric = (kind: ColumnKind | undefined) => kind === "qty" || kind === "money" || kind === "cost" || kind === "int" || kind === "days";

function formatValue(value: string | number, kind: ColumnKind | undefined): string {
  if (typeof value === "string") return kind === "date" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatCalendarDay(value) : value;
  switch (kind) {
    case "money":
      return value === 0 ? "—" : formatRupees(value);
    case "cost":
      // A unit cost keeps its paisa fractions (₹12.3456) only when it has them.
      return formatRupees(value, { decimals: Number.isInteger(Math.round(value * 10000) / 100) ? 2 : 4 });
    case "qty":
      return formatQuantity(value);
    case "int":
    case "days":
      return value.toLocaleString("en-IN");
    default:
      return String(value);
  }
}

function CellView({ cell, column }: { cell: Cell | undefined; column: ReportColumn }) {
  if (cell === null || cell === undefined || cell === "") return null;
  if (typeof cell === "object") {
    return (
      <span className="block min-w-0">
        {cell.href ? (
          <Link href={cell.href} className="text-brand hover:underline">
            {cell.text}
          </Link>
        ) : (
          <span className="text-text">{cell.text}</span>
        )}
        {cell.sub && <span className="block text-xs text-subtle">{cell.sub}</span>}
      </span>
    );
  }
  const text = formatValue(cell, column.kind);
  const negative = typeof cell === "number" && cell < 0 && (column.kind === "money" || column.kind === "qty");
  return <span className={cn(numeric(column.kind) && "whitespace-nowrap tabular-nums", negative && "text-danger")}>{text}</span>;
}

const toneClass: Record<NonNullable<ReportRow["tone"]>, string> = {
  muted: "text-subtle",
  strong: "font-semibold",
  warning: "bg-warning-bg/40",
  danger: "bg-danger-bg/40",
};

export function ReportView({ table, emptyText }: { table: ReportTable; emptyText?: string }) {
  const pages = totalPages(table.total, table.pageSize);
  const hasTotals = !!table.totals && Object.keys(table.totals).length > 0;
  return (
    <div className="mt-4">
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="sr-only">
            {table.title}
            {table.subtitle ? ` — ${table.subtitle}` : ""}
          </caption>
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              {table.columns.map((c) => (
                <th key={c.key} scope="col" className={cn("whitespace-nowrap px-3 py-2.5", numeric(c.kind) && "text-right")}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r) => (
              <tr key={r.id} className={cn("border-line align-top hover:bg-surface-sunken", r.continues ? "" : "border-t first:border-t-0", r.tone && toneClass[r.tone])}>
                {table.columns.map((c) => (
                  <td key={c.key} className={cn("px-3 py-1.5", numeric(c.kind) && "text-right")}>
                    {r.continues && c.group ? null : <CellView cell={r.cells[c.key]} column={c} />}
                  </td>
                ))}
              </tr>
            ))}
            {table.rows.length === 0 && (
              <tr>
                <td colSpan={table.columns.length} className="px-4 py-12 text-center text-subtle">
                  {emptyText ?? "Nothing matches these filters."}
                </td>
              </tr>
            )}
          </tbody>
          {hasTotals && table.rows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-line-strong font-semibold">
                {table.columns.map((c, i) => (
                  <td key={c.key} className={cn("px-3 py-2.5", numeric(c.kind) && "text-right")}>
                    {i === 0 && (table.totals![c.key] === undefined || table.totals![c.key] === null) ? (
                      <span className="text-text">Total{table.total > table.rows.length ? ` (all ${table.total.toLocaleString("en-IN")})` : ""}</span>
                    ) : (
                      <CellView cell={table.totals![c.key]} column={c} />
                    )}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </Card>

      {table.notes && table.notes.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-muted">
          {table.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      {table.total > table.pageSize && (
        <Pagination page={table.page} pageSize={table.pageSize} total={table.total} totalPages={pages} pageSizes={PAGE_SIZES} label={table.unit ?? "rows"} />
      )}
    </div>
  );
}
