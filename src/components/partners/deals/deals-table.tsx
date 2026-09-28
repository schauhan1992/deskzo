"use client";

import { useState } from "react";
import { partnerWithdrawDeal } from "@/actions/partners/deals";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { DealStatusPill } from "@/components/partners/common/pills";
import { CustomerName } from "@/components/partners/customers/customer-name";
import { Button } from "@/components/ui/button";
import { dayMonthYear, istDaysBetween, plural } from "@/lib/console-shared/format";
import type { DealRow } from "@/lib/partners/portal-data";

/**
 * The partner's deal registrations: the company, its email domain and country, where the
 * registration stands, until when an approved one is protected (days counted from the loader's
 * `asOf`), staff's note on their decision, and — once it signed up — the customer it became, a link
 * while it is the partner's.
 *
 * "Withdraw" gives up a pending or approved registration, after a confirmation. It is offered to the
 * roles that sell whatever the partner account's status (withdrawing only gives something up); the
 * server checks again, and refuses one whose protection has already run out.
 */

const withdrawable = (row: DealRow) => row.status === "PENDING" || row.status === "APPROVED";

/** "12 Dec 2026 · 40 days left", counted in India's days from the loader's clock. */
function protection(row: DealRow, asOf: Date): { date: string; left: string | null } | null {
  if (!row.expiresAt) return null;
  const date = dayMonthYear(row.expiresAt);
  if (row.status !== "APPROVED") return { date, left: null };
  const days = istDaysBetween(asOf, row.expiresAt);
  return { date, left: days <= 0 ? "ends today" : days === 1 ? "1 day left" : `${plural(days, "day")} left` };
}

export function DealsTable({ rows, asOf, canWithdraw, countryNames }: { rows: DealRow[]; asOf: Date; canWithdraw: boolean; countryNames: Record<string, string> }) {
  const [withdrawing, setWithdrawing] = useState<DealRow | null>(null);
  const actions = canWithdraw && rows.some(withdrawable);
  return (
    <>
      <DataTable caption="Deal registrations, newest first" minWidth={actions ? 1120 : 1040}>
        <THead>
          <Th>Company</Th>
          <Th>Domain</Th>
          <Th>Country</Th>
          <Th>Status</Th>
          <Th>Protected until</Th>
          <Th>Decision note</Th>
          <Th>Customer</Th>
          {actions && <Th srOnly>Actions</Th>}
        </THead>
        <TBody>
          {rows.map((row) => {
            const until = protection(row, asOf);
            return (
              <Tr key={row.id}>
                <Td>
                  <span className="block max-w-[16rem] min-w-32 truncate font-medium" title={row.companyName}>
                    {row.companyName}
                  </span>
                  <span className="block text-[11px] text-subtle">{`Registered ${dayMonthYear(row.createdAt)}`}</span>
                </Td>
                <Td mono nowrap>
                  <span translate="no">{row.domain}</span>
                </Td>
                <Td nowrap>
                  <span title={countryNames[row.country] ?? row.country}>{row.country}</span>
                </Td>
                <Td nowrap>
                  <DealStatusPill status={row.status} />
                </Td>
                <Td muted nowrap>
                  {until ? (
                    <>
                      <span className="block">{until.date}</span>
                      {until.left && <span className="block text-[11px] text-subtle">{until.left}</span>}
                    </>
                  ) : (
                    "—"
                  )}
                </Td>
                <Td>
                  {row.decisionNote ? (
                    <span className="block max-w-[18rem] text-xs break-words text-muted">{row.decisionNote}</span>
                  ) : (
                    <span className="text-subtle">—</span>
                  )}
                </Td>
                <Td>{row.customer ? <CustomerName slug={row.customer.slug} name={row.customer.name} className="block max-w-[12rem] truncate" /> : <span className="text-subtle">—</span>}</Td>
                {actions && (
                  <RowActionsCell>
                    {withdrawable(row) && (
                      <Button type="button" variant="secondary" size="sm" onClick={() => setWithdrawing(row)}>
                        Withdraw
                        <span className="sr-only">{` the registration for ${row.companyName}`}</span>
                      </Button>
                    )}
                  </RowActionsCell>
                )}
              </Tr>
            );
          })}
        </TBody>
      </DataTable>
      {actions && <WithdrawDialog row={withdrawing} asOf={asOf} onClose={() => setWithdrawing(null)} />}
    </>
  );
}

/** Withdraw a pending or approved registration: the company is no longer held for this partner. */
function WithdrawDialog({ row, asOf, onClose }: { row: DealRow | null; asOf: Date; onClose: () => void }) {
  const action = useConsoleAction<null>();

  function close() {
    if (action.pending) return;
    action.reset();
    onClose();
  }

  const until = row ? protection(row, asOf) : null;
  return (
    <ConfirmDialog
      open={row !== null}
      onClose={close}
      title="Withdraw registration"
      confirmLabel="Withdraw"
      tone="danger"
      pending={action.pending}
      error={action.error}
      onConfirm={() => {
        if (row) action.run(() => partnerWithdrawDeal(row.id), { success: `Registration for ${row.companyName} withdrawn.`, onDone: onClose });
      }}
    >
      {row && (
        <>
          <p>
            <strong className="font-medium">{row.companyName}</strong> is no longer held for you, and another partner could register it. A signup from{" "}
            <span className="font-mono text-xs">{row.domain}</span> would no longer be credited to you through this registration.
          </p>
          <ImpactList
            items={[
              { label: "Status", value: `${row.status === "APPROVED" ? "Approved" : "Pending"} → Withdrawn`, tone: "danger" as const },
              ...(until && row.status === "APPROVED" ? [{ label: "Protected until", value: `${until.date} → now`, tone: "danger" as const }] : []),
            ]}
          />
        </>
      )}
    </ConfirmDialog>
  );
}
