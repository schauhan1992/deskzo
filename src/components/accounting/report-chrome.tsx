import Link from "next/link";
import type { AccountType } from "@prisma/client";
import { Card } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { indiaClock } from "@/lib/time/zone";
import type { AccountBalance } from "@/actions/ledger-reports";

/**
 * A financial statement's heading: what it is, and the date or period it covers.
 *
 * The period matters more than it looks — a P&L for the wrong dates is not a wrong-looking report,
 * it's a plausible one, so it says so at the top where it will be read.
 */
export function ReportHeader({
  title,
  subtitle,
  organisation,
  children,
}: {
  title: string;
  subtitle: string;
  organisation: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-text">{title}</h1>
        <p className="mt-0.5 text-sm text-muted">{organisation}</p>
        <p className="text-sm text-subtle">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

/** Amounts are read by scanning a column, so they're tabular and never wrap. */
export function Amount({ value, bold, muted }: { value: number; bold?: boolean; muted?: boolean }) {
  return (
    <span
      className={`whitespace-nowrap tabular-nums ${bold ? "font-semibold text-text" : muted ? "text-subtle" : "text-text"}`}
    >
      {value === 0 ? "—" : formatCurrency(value)}
    </span>
  );
}

/**
 * One line of a statement, indented by how deep it sits in the chart.
 *
 * Indentation is the only thing that makes a grouped statement readable — without it "Current
 * Assets" and "Bank Accounts" look like peers.
 */
export function StatementRow({
  row,
  depth,
  href,
}: {
  row: Pick<AccountBalance, "code" | "name" | "balance" | "isGroup">;
  depth: number;
  href?: string;
}) {
  return (
    <tr className={row.isGroup ? "bg-surface-sunken/60" : "hover:bg-surface-sunken"}>
      <td className="px-4 py-1.5" style={{ paddingLeft: `${16 + depth * 18}px` }}>
        {href && !row.isGroup ? (
          <Link href={href} className="text-text hover:underline">
            <span className="mr-2 font-mono text-xs text-subtle">{row.code}</span>
            {row.name}
          </Link>
        ) : (
          <span className={row.isGroup ? "font-medium text-text" : "text-text"}>
            <span className="mr-2 font-mono text-xs text-subtle">{row.code}</span>
            {row.name}
          </span>
        )}
      </td>
      <td className="px-4 py-1.5 text-right">
        <Amount value={row.balance} bold={row.isGroup} />
      </td>
    </tr>
  );
}

/**
 * Builds the display order: each root followed by its descendants, depth-first.
 *
 * Sorting by code alone would interleave a child of one group with the next group whenever the
 * numbering isn't strictly nested — which it stops being the moment someone adds an account.
 */
export function asTree(rows: AccountBalance[]): { row: AccountBalance; depth: number }[] {
  const byParent = new Map<string | null, AccountBalance[]>();
  const ids = new Set(rows.map((r) => r.id));
  for (const row of rows) {
    // A row whose parent was filtered out of this statement is treated as a root, so it still shows.
    const key = row.parentId && ids.has(row.parentId) ? row.parentId : null;
    byParent.set(key, [...(byParent.get(key) ?? []), row]);
  }
  const out: { row: AccountBalance; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const row of (byParent.get(parentId) ?? []).sort((a, b) => a.code.localeCompare(b.code))) {
      out.push({ row, depth });
      walk(row.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Drops branches where nothing was posted, so a statement isn't mostly empty rows. */
export function withMovement(rows: AccountBalance[]) {
  return rows.filter((r) => r.balance !== 0 || r.debit !== 0 || r.credit !== 0);
}

export function TotalRow({ label, value }: { label: string; value: number }) {
  return (
    <tr className="border-t-2 border-line-strong">
      <td className="px-4 py-2 font-semibold text-text">{label}</td>
      <td className="px-4 py-2 text-right">
        <Amount value={value} bold />
      </td>
    </tr>
  );
}

/**
 * The reconciliation line every statement needs.
 *
 * A balance sheet that doesn't balance is the single most important thing the page can tell you, so
 * it's stated plainly rather than left for the reader to work out by adding up columns.
 */
export function BalanceCheck({
  balanced,
  difference,
  balancedLabel,
}: {
  balanced: boolean;
  difference: number;
  balancedLabel: string;
}) {
  if (balanced) {
    return (
      <Card className="mt-4 border-success/40 bg-success-bg px-4 py-2.5 text-sm text-success">{balancedLabel}</Card>
    );
  }
  return (
    <Card className="mt-4 border-danger/40 bg-danger-bg px-4 py-2.5 text-sm text-danger">
      <span className="font-medium">Out by {formatCurrency(Math.abs(difference))}.</span> Something has been posted
      that doesn&apos;t balance — every report built on these figures is unreliable until it&apos;s explained.
    </Card>
  );
}

export const accountTypeTone: Record<AccountType, "default" | "green" | "blue" | "red" | "amber"> = {
  ASSET: "blue",
  LIABILITY: "amber",
  EQUITY: "default",
  INCOME: "green",
  EXPENSE: "red",
};

/** The day a statement runs to — India's, in every workspace: the books keep India's calendar. */
export function asAtLabel(date: Date) {
  return `As at ${indiaClock.date(date)}`;
}
