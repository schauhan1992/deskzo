import Link from "next/link";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { Amount } from "@/components/partners/common/money";
import { CommissionStatusPill } from "@/components/partners/common/pills";
import { COMMISSION_KIND } from "@/lib/console-shared/labels";
import { PARTNER_ROUTES } from "@/lib/partners/nav";
import type { CommissionRow } from "@/lib/partners/portal-data";
import { bpToPercent } from "@/lib/partners/types";
import { indiaClock } from "@/lib/time/zone";

const PHASE: Record<"NEW" | "RENEWAL", string> = { NEW: "New-customer rate", RENEWAL: "Renewal rate" };

/**
 * The commission entries for one customer (money roles only): when each was earned, on which
 * invoice (its number — never a link to it), what kind, the base it was worked out on, the rate, the
 * amount — a clawback carries its minus sign and says so — its status, and the statement it is on
 * once that statement is approved. The day it was earned is India's, as the statements' months are
 * (src/lib/partners/statements.ts), whatever zone the console keeps.
 *
 * Server-safe: no hooks, no directive.
 */
export function CommissionEntriesTable({ entries, canOpenStatements }: { entries: CommissionRow[]; canOpenStatements: boolean }) {
  return (
    <DataTable caption="Commission entries for this customer, newest first" minWidth={920}>
      <THead>
        <Th>Earned</Th>
        <Th>Invoice</Th>
        <Th>Kind</Th>
        <Th numeric>Base</Th>
        <Th numeric>Rate</Th>
        <Th numeric>Amount</Th>
        <Th>Status</Th>
        <Th>Statement</Th>
      </THead>
      <TBody>
        {entries.map((entry) => {
          const kind = COMMISSION_KIND[entry.kind]?.label ?? String(entry.kind);
          return (
            <Tr key={entry.id}>
              <Td muted nowrap>
                {indiaClock.date(entry.earnedAt)}
              </Td>
              <Td mono nowrap>
                {entry.invoiceNumber ?? <span className="font-sans text-sm text-muted">—</span>}
              </Td>
              <Td>
                <span className="flex flex-wrap items-center gap-1">
                  <span>{kind}</span>
                  {entry.reversal && <StatusPill tone="warning">Clawback</StatusPill>}
                </span>
                {entry.basis.phase && <span className="block text-[11px] text-subtle">{PHASE[entry.basis.phase]}</span>}
                {entry.note && (
                  <span className="block max-w-[18rem] text-xs break-words text-muted" title={entry.note}>
                    {entry.note}
                  </span>
                )}
              </Td>
              <Td numeric>
                <Amount minor={entry.base} currency={entry.currency} />
              </Td>
              <Td numeric>{entry.kind === "ADJUSTMENT" ? <span className="text-muted">—</span> : bpToPercent(entry.rateBp)}</Td>
              <Td numeric>
                <Amount minor={entry.amount} currency={entry.currency} signed className={entry.amount < 0 ? "text-danger" : undefined} />
              </Td>
              <Td nowrap>
                <CommissionStatusPill status={entry.status} />
              </Td>
              <Td nowrap>
                {entry.statementNumber ? (
                  canOpenStatements ? (
                    <Link href={PARTNER_ROUTES.statement(entry.statementNumber)} className="rounded-base font-mono text-xs text-brand hover:underline">
                      {entry.statementNumber}
                    </Link>
                  ) : (
                    <span className="font-mono text-xs">{entry.statementNumber}</span>
                  )
                ) : (
                  <span className="text-muted">—</span>
                )}
              </Td>
            </Tr>
          );
        })}
      </TBody>
    </DataTable>
  );
}
