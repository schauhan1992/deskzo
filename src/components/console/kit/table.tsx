import { Children, Fragment, isValidElement, type ReactNode } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The console's data table (spec §1.8), as plain server-safe pieces:
 *
 *   <DataTable caption="Workspaces">
 *     <THead><SortTh … /><Th>Status</Th><Th srOnly>Actions</Th></THead>
 *     <TBody>{rows.map((r) => <Tr key={r.id} interactive><Td><RowLink href=…>{r.name}</RowLink></Td>…</Tr>)}</TBody>
 *   </DataTable>
 *
 * Density follows the shell's `data-density` attribute through an arbitrary variant, so switching it
 * needs no prop and no CSS file. An empty list is an `EmptyState`, never an empty table.
 */

/** Compact density, set on the shell root by the viewer's preference. */
const DENSITY = "[[data-density=compact]_&]:py-1.5";
const CELL = cn("px-4 py-2.5 first:pl-5 last:pr-5", DENSITY);
const NUMERIC = "text-right tabular-nums whitespace-nowrap";

/**
 * Stacking inside a table, lowest first: the whole-row link's overlay (auto), anything clickable in a
 * row lifted above it (1), a sticky day heading (2), the sticky column headings (3). All far below the
 * shell's top bar (z-20).
 */
const STICKY_HEAD = cn(
  "[&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-[3] [&_thead_th]:bg-surface",
  // A row's border does not travel with a sticky cell; the line under the headings is drawn on the cells.
  "[&_thead_th]:shadow-[inset_0_-1px_0_var(--line)]",
);

export function DataTable({
  children,
  stickyHeader,
  minWidth = 720,
  caption,
  className,
}: {
  children: ReactNode;
  stickyHeader?: boolean;
  minWidth?: number;
  caption?: string;
  className?: string;
}) {
  return (
    <div
      data-sticky-header={stickyHeader ? "" : undefined}
      className={cn(stickyHeader ? cn("max-h-[calc(100vh-14rem)] overflow-auto", STICKY_HEAD) : "overflow-x-auto", className)}
    >
      <table className="w-full text-left text-sm" style={{ minWidth }}>
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

/**
 * Whether children are loose cells rather than rows. THead and TFoot accept either — header cells
 * are wrapped in one row for you — because a cell straight inside `<thead>` and a row nested in a row
 * are both invalid markup that React only complains about at hydration.
 */
function areCells(children: ReactNode): boolean {
  return Children.toArray(children).some((child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return false;
    if (child.type === Fragment) return areCells(child.props.children);
    return CELL_TYPES.has(child.type);
  });
}

const CELL_TYPES = new Set<unknown>([Th, SortTh, Td, RowActionsCell, "th", "td"]);

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="[&>tr]:border-b [&>tr]:border-line">{areCells(children) ? <tr>{children}</tr> : children}</thead>
  );
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-line">{children}</tbody>;
}

/** Totals — one row per currency, never a sum across them. */
export function TFoot({ children }: { children: ReactNode }) {
  return <tfoot className="border-t border-line-strong font-medium">{areCells(children) ? <tr>{children}</tr> : children}</tfoot>;
}

export function Th({ children, numeric, srOnly, className }: { children?: ReactNode; numeric?: boolean; srOnly?: boolean; className?: string }) {
  return (
    <th scope="col" className={cn(CELL, "text-xs font-medium whitespace-nowrap text-muted", numeric && "text-right", className)}>
      {srOnly ? <span className="sr-only">{children}</span> : children}
    </th>
  );
}

/** A sortable heading: a link that flips `?sort=` (the page builds `href`), with `aria-sort` on the cell. */
export function SortTh({ label, active, href, numeric }: { label: string; active: "asc" | "desc" | null; href: string; numeric?: boolean }) {
  const Icon = active === "asc" ? ArrowUp : active === "desc" ? ArrowDown : ArrowUpDown;
  return (
    <th
      scope="col"
      aria-sort={active === "asc" ? "ascending" : active === "desc" ? "descending" : undefined}
      className={cn(CELL, "text-xs font-medium whitespace-nowrap text-muted", numeric && "text-right")}
    >
      <Link
        href={href}
        scroll={false}
        className={cn("inline-flex items-center gap-1 rounded-base hover:text-text", numeric && "flex-row-reverse", active && "text-text")}
      >
        {label}
        <Icon aria-hidden="true" className={cn("h-3.5 w-3.5 shrink-0", !active && "text-subtle")} />
      </Link>
    </th>
  );
}

/**
 * Anything clickable in an interactive row — a selection checkbox, a slug link, an action — is lifted
 * above the row link's overlay; otherwise the overlay would swallow its clicks and a checkbox would
 * open the workspace instead of selecting it.
 */
const LIFT = "[&_:is(a:not([data-row-link]),button,input,select,textarea,label,summary)]:relative [&_:is(a:not([data-row-link]),button,input,select,textarea,label,summary)]:z-[1]";

export function Tr({ children, interactive, selected, className }: { children: ReactNode; interactive?: boolean; selected?: boolean; className?: string }) {
  const classes = cn(interactive && cn("relative", LIFT, !selected && "hover:bg-surface-sunken"), selected && "bg-brand-subtle", className);
  return <tr className={classes || undefined}>{children}</tr>;
}

export function Td({
  children,
  numeric,
  muted,
  mono,
  nowrap,
  colSpan,
  className,
}: {
  children?: ReactNode;
  numeric?: boolean;
  muted?: boolean;
  mono?: boolean;
  nowrap?: boolean;
  colSpan?: number;
  className?: string;
}) {
  return (
    <td
      colSpan={colSpan}
      className={cn(CELL, muted ? "text-muted" : "text-text", mono && "font-mono text-xs", numeric && NUMERIC, nowrap && "whitespace-nowrap", className)}
    >
      {children}
    </td>
  );
}

/**
 * The row's one link and its one tab stop: its `::after` covers the whole row (the `Tr` is
 * `relative`), so a click anywhere on the row follows it.
 */
export function RowLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link href={href} data-row-link="" className={cn("font-medium text-text after:absolute after:inset-0 after:content-[''] hover:text-brand", className)}>
      {children}
    </Link>
  );
}

/** Trailing row actions, above the row link's overlay and as narrow as their buttons. */
export function RowActionsCell({ children }: { children: ReactNode }) {
  return (
    <td className={cn(CELL, "relative z-[1] w-px text-right whitespace-nowrap")}>
      <div className="flex items-center justify-end gap-0.5">{children}</div>
    </td>
  );
}

/**
 * A day heading inside a grouped table ("Today", "Thu 24 Sep"). In a `stickyHeader` table it sticks
 * just under the column headings — whose height depends on the density.
 */
export function DayHeaderRow({ label, colSpan }: { label: string; colSpan: number }) {
  return (
    <tr>
      <th
        scope="rowgroup"
        colSpan={colSpan}
        className={cn(
          "sticky top-0 z-[2] border-b border-line bg-surface-sunken px-5 py-1.5 text-left text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase",
          "[[data-sticky-header]_&]:top-9 [[data-density=compact]_[data-sticky-header]_&]:top-7",
        )}
      >
        {label}
      </th>
    </tr>
  );
}
