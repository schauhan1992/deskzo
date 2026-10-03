import Link from "next/link";
import { LabelPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { formatMoney } from "@/lib/billing/money";
import { monthLabel } from "@/lib/console-shared/format";
import { STATEMENT_STATUS } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import type { ConsoleStatementRow } from "@/lib/partners/commission-data";
import { indiaClock, type Clock } from "@/lib/time/zone";
import { partnerHref, statementHref } from "./format";
import { ApproveStatementButton, MarkPaidButton, VoidStatementButton, type StatementTarget } from "./statement-actions";

/**
 * Statements as staff list them — the Statements tab of /commissions and a partner's Statements tab.
 * Server-safe. "View" opens the statement's drawer on /commissions; PAYERS (OWNER, BILLING) also get
 * the next step for each row — Approve a draft, Mark paid an approved one — and Void. Nobody else is
 * drawn those controls at all, and the server refuses them anyway.
 *
 * The day it was paid is India's, as its month is (src/lib/partners/statements.ts), whatever zone the
 * console keeps; when it was generated, approved or voided is on the console's clock, handed in.
 */

/** Whoever approved a statement cannot also record its payment while the two-person rule is on (owner decision O4). */
export function twoPersonBlock(row: Pick<ConsoleStatementRow, "approvedById">, twoPersonPayout: boolean, viewerId: string | null | undefined): string | null {
  if (!twoPersonPayout || !viewerId || !row.approvedById || row.approvedById !== viewerId) return null;
  return "You approved it. With the two-person rule on, another payer records the payment.";
}

export function statementTarget(row: ConsoleStatementRow): StatementTarget {
  return { id: row.id, number: row.number, partner: row.partner.displayName, currency: row.currency, total: row.total, netPayable: row.netPayable };
}

/**
 * The payer's controls for one statement: Approve (DRAFT), Mark paid (APPROVED), Void (either).
 * Null for everybody who is not a payer. Shared by the tables and the drawer.
 */
export function StatementRowActions({
  row,
  caps,
  viewerId,
  twoPersonPayout,
  todayKey,
}: {
  row: ConsoleStatementRow;
  caps: Caps;
  viewerId?: string | null;
  twoPersonPayout: boolean;
  /** India's today, from the loader's `asOf`: the latest "paid on" day. */
  todayKey: string;
}) {
  if (!caps.payPartners || (row.status !== "DRAFT" && row.status !== "APPROVED")) return null;
  const target = statementTarget(row);
  return (
    <>
      {row.status === "DRAFT" && <ApproveStatementButton statement={target} blockedReason={row.payoutOnFile ? null : "No payout details on file for this partner."} />}
      {row.status === "APPROVED" && (
        <MarkPaidButton
          statement={target}
          // The earliest "paid on" day: the India day it was approved, as the server checks it.
          approvedDayKey={row.approvedAt ? indiaClock.dateKey(row.approvedAt) : null}
          todayKey={todayKey}
          blockedReason={twoPersonBlock(row, twoPersonPayout, viewerId)}
        />
      )}
      <VoidStatementButton statement={target} approved={row.status === "APPROVED"} />
    </>
  );
}

function HistoryCell({ row, clock }: { row: ConsoleStatementRow; clock: Clock }) {
  const line = "block text-[11px] leading-4 whitespace-nowrap";
  return (
    <span className="block">
      <span className={`${line} text-muted`} title={`${clock.dateTime(row.generatedAt)} · ${row.generatedByName}`}>{`Generated ${clock.dayMonth(row.generatedAt)}`}</span>
      {row.approvedAt && (
        <span className={`${line} text-muted`} title={clock.dateTime(row.approvedAt)}>
          {`Approved ${clock.dayMonth(row.approvedAt)}${row.approvedByName ? ` · ${row.approvedByName}` : ""}`}
        </span>
      )}
      {row.paidAt && (
        <span className={`${line} text-success`} title={row.paymentReference ? `Reference ${row.paymentReference}` : undefined}>
          {`Paid ${indiaClock.dayMonth(row.paidAt)}${row.paidByName ? ` · ${row.paidByName}` : ""}`}
        </span>
      )}
      {row.voidedAt && (
        <span className={`${line} text-muted`} title={row.voidReason ?? undefined}>
          {`Voided ${clock.dayMonth(row.voidedAt)}${row.voidedByName ? ` · ${row.voidedByName}` : ""}`}
        </span>
      )}
    </span>
  );
}

export function StatementsTable({
  rows,
  caps,
  viewerId,
  twoPersonPayout,
  todayKey,
  showPartner,
  listParams = {},
  clock,
}: {
  rows: ConsoleStatementRow[];
  caps: Caps;
  viewerId?: string | null;
  twoPersonPayout: boolean;
  /** India's today, from the loader's `asOf`: the latest "paid on" day. */
  todayKey: string;
  showPartner: boolean;
  /** The Statements list's filters, kept under a statement's drawer. */
  listParams?: Record<string, string>;
  /** The console's clock, for when it was generated, approved or voided. */
  clock: Clock;
}) {
  return (
    <DataTable caption="Statements" stickyHeader minWidth={showPartner ? 1220 : 1080}>
      <THead>
        <Th>Number</Th>
        {showPartner && <Th>Partner</Th>}
        <Th>Period</Th>
        <Th>Currency</Th>
        <Th>Status</Th>
        <Th numeric>Total</Th>
        <Th numeric>Net payable</Th>
        <Th>Partner invoice</Th>
        <Th>Generated · approved · paid</Th>
        <Th srOnly>Actions</Th>
      </THead>
      <TBody>
        {rows.map((row) => (
          <Tr key={row.id}>
            <Td mono nowrap>
              <Link href={statementHref(row.id, listParams)} scroll={false} className="font-medium text-text hover:text-brand hover:underline">
                {row.number}
              </Link>
              <span className="block font-sans text-[11px] text-subtle">{`${row.entryCount} ${row.entryCount === 1 ? "entry" : "entries"}`}</span>
            </Td>
            {showPartner && (
              <Td>
                <Link href={partnerHref(row.partner.slug)} className="font-medium text-text hover:text-brand hover:underline">
                  {row.partner.displayName}
                </Link>
              </Td>
            )}
            <Td nowrap>{monthLabel(row.period)}</Td>
            <Td mono muted>
              {row.currency}
            </Td>
            <Td>
              <LabelPill map={STATEMENT_STATUS} value={row.status} />
            </Td>
            <Td numeric>{formatMoney(row.total, row.currency)}</Td>
            <Td numeric className="font-medium">
              {formatMoney(row.netPayable, row.currency)}
            </Td>
            <Td mono muted nowrap>
              {row.partnerInvoiceNumber ?? "—"}
            </Td>
            <Td>
              <HistoryCell row={row} clock={clock} />
            </Td>
            <RowActionsCell>
              <span className="flex flex-wrap items-center justify-end gap-1.5">
                <Link
                  href={statementHref(row.id, listParams)}
                  scroll={false}
                  className="inline-flex h-8 items-center rounded-base px-2 text-[13px] font-medium text-brand hover:bg-surface-sunken"
                >
                  View<span className="sr-only">{` statement ${row.number}`}</span>
                </Link>
                <StatementRowActions row={row} caps={caps} viewerId={viewerId} twoPersonPayout={twoPersonPayout} todayKey={todayKey} />
              </span>
            </RowActionsCell>
          </Tr>
        ))}
      </TBody>
    </DataTable>
  );
}
