"use client";

import { useState } from "react";
import { partnerEndInvite } from "@/actions/partners/invitations";
import { Meter } from "@/components/console/charts/meter";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { LabelPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { CustomerName } from "@/components/partners/customers/customer-name";
import { useClock } from "@/components/time/clock-provider";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/console-shared/format";
import { INVITE_STATE } from "@/lib/console-shared/labels";
import type { InviteRow } from "@/lib/partners/portal-data";
import type { Clock } from "@/lib/time/zone";

/**
 * The partner's invitation codes: who each is for, the plan it starts a workspace on, its last four
 * characters (the code itself was shown once, when it was made), how much of it is used, until when
 * it works, whether it still does, and the customers it made that are the partner's now — each a
 * link to its page.
 *
 * "End" stops a live code now, after a confirmation that says what it changes. It is offered to the
 * roles that sell whatever the partner account's status — ending only ever takes something away, so a
 * leaked code can be stopped while the account is being set up or suspended. The server checks again.
 */

const CUSTOMERS_SHOWN = 3;

/** How a code is named in labels and confirmations: its note, or its last four. */
const nameOf = (row: InviteRow, clock: Clock) => row.note?.trim() || (row.codeHint ? `the code ending ${row.codeHint}` : `the code made ${clock.date(row.createdAt)}`);

export function InviteCodesTable({ rows, canEnd }: { rows: InviteRow[]; canEnd: boolean }) {
  const clock = useClock();
  const [ending, setEnding] = useState<InviteRow | null>(null);
  return (
    <>
      <DataTable caption="Invitation codes, newest first" minWidth={canEnd ? 1060 : 980}>
        <THead>
          <Th>For</Th>
          <Th>Plan</Th>
          <Th>Code</Th>
          <Th>Uses</Th>
          <Th>Works until</Th>
          <Th>State</Th>
          <Th>Customers made</Th>
          {canEnd && <Th srOnly>Actions</Th>}
        </THead>
        <TBody>
          {rows.map((row) => (
            <Tr key={row.codeHash}>
              <Td>
                {row.note ? (
                  <span className="block max-w-[16rem] min-w-32 truncate font-medium" title={row.note}>
                    {row.note}
                  </span>
                ) : (
                  <span className="text-subtle">No note</span>
                )}
                <span className="block text-[11px] text-subtle">{`Made ${clock.date(row.createdAt)}`}</span>
              </Td>
              <Td nowrap>{row.planName ?? <span className="text-muted">Default plan</span>}</Td>
              <Td mono nowrap>
                {row.codeHint ? <span translate="no">{`…${row.codeHint}`}</span> : <span className="font-sans text-sm text-muted">—</span>}
              </Td>
              <Td nowrap>
                <span className="inline-flex items-center gap-2">
                  <span className="tabular-nums">{`${row.uses} of ${row.maxUses}`}</span>
                  <Meter value={row.uses} max={row.maxUses} label={`Uses of ${nameOf(row, clock)}`} size="sm" tone={row.uses >= row.maxUses ? "muted" : "brand"} />
                </span>
              </Td>
              <Td muted nowrap>
                {row.expiresAt ? clock.date(row.expiresAt) : "No end date"}
              </Td>
              <Td nowrap>
                <LabelPill map={INVITE_STATE} value={row.state} />
              </Td>
              <Td>
                <MadeWith customers={row.customers} />
              </Td>
              {canEnd && (
                <RowActionsCell>
                  {row.state === "live" && (
                    <Button type="button" variant="secondary" size="sm" onClick={() => setEnding(row)}>
                      End
                      <span className="sr-only">{` ${nameOf(row, clock)}`}</span>
                    </Button>
                  )}
                </RowActionsCell>
              )}
            </Tr>
          ))}
        </TBody>
      </DataTable>
      {canEnd && <EndCodeDialog row={ending} onClose={() => setEnding(null)} />}
    </>
  );
}

/** How many customers a code made, and the first few by name — each a link while it is the partner's. */
function MadeWith({ customers }: { customers: InviteRow["customers"] }) {
  if (customers.length === 0) return <span className="text-subtle">—</span>;
  const shown = customers.slice(0, CUSTOMERS_SHOWN);
  const more = customers.length - shown.length;
  return (
    <div className="flex max-w-[18rem] flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="tabular-nums">{customers.length}</span>
      <ul aria-label="Customers made with it" className="contents">
        {shown.map((c) => (
          <li key={c.slug} className="inline-flex min-w-0">
            <CustomerName slug={c.slug} name={c.name} className="max-w-[10rem] truncate text-xs" />
          </li>
        ))}
      </ul>
      {more > 0 && (
        <span className="text-[11px] text-subtle tabular-nums" title={customers.slice(CUSTOMERS_SHOWN).map((c) => c.name).join(", ")}>
          {`+${more}`}
        </span>
      )}
    </div>
  );
}

/** End a live code (tier 2): what stops, and what does not. */
function EndCodeDialog({ row, onClose }: { row: InviteRow | null; onClose: () => void }) {
  const clock = useClock();
  const action = useConsoleAction<null>();

  function close() {
    if (action.pending) return;
    action.reset();
    onClose();
  }

  return (
    <ConfirmDialog
      open={row !== null}
      onClose={close}
      title="End invitation code"
      confirmLabel="End code"
      tone="danger"
      pending={action.pending}
      error={action.error}
      onConfirm={() => {
        if (row) action.run(() => partnerEndInvite(row.codeHash), { success: "Invitation code ended — it no longer works.", onDone: onClose });
      }}
    >
      {row && (
        <>
          <p>
            The code for <strong className="font-medium">{nameOf(row, clock)}</strong> stops working now; nobody can sign up with it again. Customers already made with it stay yours.
          </p>
          <ImpactList
            items={[
              ...(row.codeHint ? [{ label: "Code", value: `…${row.codeHint}` }] : []),
              { label: "Uses left", value: `${Math.max(0, row.maxUses - row.uses)} → 0`, tone: "danger" as const },
              { label: "Works until", value: `${row.expiresAt ? clock.date(row.expiresAt) : "No end date"} → now`, tone: "danger" as const },
              { label: "Customers made with it", value: row.customers.length > 0 ? `${plural(row.customers.length, "customer")} — not affected` : "None" },
            ]}
          />
        </>
      )}
    </ConfirmDialog>
  );
}
