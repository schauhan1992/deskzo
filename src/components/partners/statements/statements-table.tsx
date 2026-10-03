import { DataTable, RowLink, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { Amount } from "@/components/partners/common/money";
import { StatementStatusPill } from "@/components/partners/common/pills";
import { monthLabel } from "@/lib/console-shared/format";
import { PARTNER_ROUTES } from "@/lib/partners/nav";
import type { StatementRow } from "@/lib/partners/portal-data";
import { indiaClock } from "@/lib/time/zone";

/**
 * The statements list: one row per statement — a month's entries for this partner in one currency,
 * approved or paid (a draft is the platform's work in progress and never reaches the partner). Each
 * figure is in the statement's own currency. Server-safe. The day it was paid is India's, as its month
 * is (src/lib/partners/statements.ts).
 */
export function StatementsTable({ rows }: { rows: StatementRow[] }) {
  return (
    <DataTable caption="Statements, latest month first" minWidth={960}>
      <THead>
        <Th>Statement</Th>
        <Th>Month</Th>
        <Th>Currency</Th>
        <Th>Status</Th>
        <Th numeric>Total</Th>
        <Th numeric>Net payable</Th>
        <Th>Your invoice number</Th>
        <Th>Paid on</Th>
      </THead>
      <TBody>
        {rows.map((row) => (
          <Tr key={row.number} interactive>
            <Td nowrap>
              <RowLink href={PARTNER_ROUTES.statement(row.number)} className="font-mono text-xs">
                {row.number}
              </RowLink>
            </Td>
            <Td nowrap>{monthLabel(row.period)}</Td>
            <Td muted>{row.currency}</Td>
            <Td>
              <StatementStatusPill status={row.status} />
            </Td>
            <Td numeric>
              <Amount minor={row.total} currency={row.currency} />
            </Td>
            <Td numeric className="font-medium">
              <Amount minor={row.netPayable} currency={row.currency} />
            </Td>
            <Td mono>{row.partnerInvoiceNumber ?? <span className="font-sans text-muted">{row.status === "APPROVED" ? "Not given yet" : "—"}</span>}</Td>
            <Td>
              {row.paidAt ? (
                <span className="inline-flex flex-col">
                  <time dateTime={row.paidAt.toISOString()} title={indiaClock.dateTime(row.paidAt)} className="whitespace-nowrap">
                    {indiaClock.date(row.paidAt)}
                  </time>
                  {row.paymentReference && <span className="font-mono text-[11px] break-all text-muted">{`Ref. ${row.paymentReference}`}</span>}
                </span>
              ) : (
                <span className="text-muted">Not yet</span>
              )}
            </Td>
          </Tr>
        ))}
      </TBody>
    </DataTable>
  );
}
