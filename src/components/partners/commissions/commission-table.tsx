import Link from "next/link";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { Amount } from "@/components/partners/common/money";
import { CommissionStatusPill } from "@/components/partners/common/pills";
import { formatMoney } from "@/lib/billing/money";
import { COMMISSION_KIND } from "@/lib/console-shared/labels";
import { PARTNER_ROUTES } from "@/lib/partners/nav";
import type { CommissionRow } from "@/lib/partners/portal-data";
import type { RateBy } from "@/lib/partners/rates";
import { bpToPercent, type CommissionKind } from "@/lib/partners/types";
import { indiaClock } from "@/lib/time/zone";
import { cn } from "@/lib/utils";

/**
 * One table of commission entries, as the partner may see them (src/lib/partners/portal-data.ts
 * CommissionRow): the commissions list, a statement's entries, and a distributor's override entries
 * on one reseller's customers.
 *
 * How an entry reads (spec §5):
 *   · Direct — earned on one of your own customers' paid invoices, on the amount before tax.
 *   · Override — a distributor's share of its resellers' customers' invoices, on top of the reseller's own.
 *   · Adjustment — a correction the platform made, with its note; it has no base and no rate.
 *   · Clawback — the negative entry a refund, credit note or cancelled invoice writes against an
 *     earlier Direct or Override entry. Labelled in words, and its amount carries the minus sign.
 *
 * A customer is a link only while it is this partner's customer now (`slug` is null otherwise — a
 * former customer, or a reseller's). A statement number is a link only for an approved or paid
 * statement; the loader never hands over a draft's. Server-safe: no hooks, no directive.
 *
 * The day an entry was earned is India's, whatever zone the console keeps: commission is counted in
 * India's months, as its statements are (src/lib/partners/statements.ts) — an entry dated here sits
 * in the month it reads.
 */

const KIND_LABEL = (kind: CommissionKind) => (Object.prototype.hasOwnProperty.call(COMMISSION_KIND, kind) ? COMMISSION_KIND[kind].label : String(kind));

/** The rule behind an accrual's rate, in words. "phase" is spelled by the entry's own phase. */
function rateRule(by: string, phase: "NEW" | "RENEWAL" | undefined): string | null {
  const words: Record<RateBy, string> = {
    plan: "plan rate",
    country: "country rate",
    phase: phase === "RENEWAL" ? "renewal rate" : phase === "NEW" ? "new-customer rate" : "new or renewal rate",
    default: "default rate",
    territory: "territory rate",
  };
  return Object.prototype.hasOwnProperty.call(words, by) ? words[by as RateBy] : null;
}

function KindCell({ row }: { row: CommissionRow }) {
  const kind = KIND_LABEL(row.kind);
  if (row.reversal) {
    return (
      <div className="min-w-0">
        <span className="flex flex-wrap items-center gap-1.5">
          <span>{kind}</span>
          <StatusPill tone="warning">Clawback</StatusPill>
        </span>
        <span className="mt-0.5 block text-xs text-muted">The invoice was refunded, credited or cancelled</span>
      </div>
    );
  }
  if (row.kind === "ADJUSTMENT") {
    return (
      <div className="min-w-0 max-w-[18rem]">
        <span>{kind}</span>
        <span className="mt-0.5 block text-xs break-words whitespace-normal text-muted">{row.note || "A correction by the platform"}</span>
      </div>
    );
  }
  const sub = row.kind === "OVERRIDE" ? "On your reseller's customer" : row.basis.phase === "RENEWAL" ? "Renewal" : row.basis.phase === "NEW" ? "New customer" : null;
  return (
    <div className="min-w-0">
      <span>{kind}</span>
      {sub && <span className="mt-0.5 block text-xs text-muted">{sub}</span>}
    </div>
  );
}

function RateCell({ row }: { row: CommissionRow }) {
  if (row.kind === "ADJUSTMENT") return <span className="text-muted">—</span>;
  const rules = row.reversal ? [] : (row.basis.by ?? []).map((by) => rateRule(by, row.basis.phase)).filter((w): w is string => !!w);
  return (
    <span className="inline-flex flex-col items-end">
      <span>{bpToPercent(row.rateBp)}</span>
      {rules.length > 0 && <span className="text-[11px] font-normal whitespace-nowrap text-muted">{rules.join(", ")}</span>}
    </span>
  );
}

function CustomerCell({ customer }: { customer: CommissionRow["customer"] }) {
  if (!customer) return <span className="text-muted">—</span>;
  if (!customer.slug) return <span className="block max-w-[16rem] truncate" title={customer.name}>{customer.name}</span>;
  return (
    <Link href={PARTNER_ROUTES.customer(customer.slug)} className="block max-w-[16rem] truncate font-medium text-text hover:text-brand hover:underline" title={customer.name}>
      {customer.name}
    </Link>
  );
}

export function CommissionTable({
  rows,
  caption,
  showStatement = true,
  minWidth = 1080,
}: {
  rows: CommissionRow[];
  caption: string;
  /** Off on a statement's own page: every entry there is on it. */
  showStatement?: boolean;
  minWidth?: number;
}) {
  return (
    <DataTable caption={caption} minWidth={minWidth}>
      <THead>
        <Th>Earned</Th>
        <Th>Customer</Th>
        <Th>Invoice</Th>
        <Th>Kind</Th>
        <Th numeric>Base</Th>
        <Th numeric>Rate</Th>
        <Th numeric>Amount</Th>
        <Th>Status</Th>
        {showStatement && <Th>Statement</Th>}
      </THead>
      <TBody>
        {rows.map((row) => {
          const voided = row.status === "VOID";
          return (
            <Tr key={row.id}>
              <Td muted nowrap className="align-top">
                <time dateTime={row.earnedAt.toISOString()} title={`${indiaClock.dateTime(row.earnedAt)} (India time)`}>
                  {indiaClock.date(row.earnedAt)}
                </time>
              </Td>
              <Td className="align-top">
                <CustomerCell customer={row.customer} />
              </Td>
              <Td mono nowrap className="align-top">
                {row.invoiceNumber ?? <span className="text-muted">—</span>}
              </Td>
              <Td className="align-top">
                <KindCell row={row} />
              </Td>
              <Td numeric muted className="align-top">
                {row.kind === "ADJUSTMENT" ? "—" : formatMoney(row.base, row.currency)}
              </Td>
              <Td numeric className="align-top">
                <RateCell row={row} />
              </Td>
              <Td numeric className="align-top font-medium">
                <Amount minor={row.amount} currency={row.currency} signed className={cn(voided ? "text-muted line-through" : row.amount < 0 && "text-danger")} />
              </Td>
              <Td className="align-top">
                <CommissionStatusPill status={row.status} />
              </Td>
              {showStatement && (
                <Td nowrap className="align-top">
                  {row.statementNumber ? (
                    <Link href={PARTNER_ROUTES.statement(row.statementNumber)} className="font-mono text-xs font-medium text-brand hover:underline">
                      {row.statementNumber}
                    </Link>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Td>
              )}
            </Tr>
          );
        })}
      </TBody>
    </DataTable>
  );
}
