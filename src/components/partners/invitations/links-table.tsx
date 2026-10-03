"use client";

import { useState } from "react";
import { partnerEndLink } from "@/actions/partners/invitations";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { CopyField } from "@/components/console/kit/copy-field";
import { ImpactList } from "@/components/console/kit/impact";
import { LabelPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { useClock } from "@/components/time/clock-provider";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/console-shared/format";
import { INVITE_STATE } from "@/lib/console-shared/labels";
import type { LinkRow } from "@/lib/partners/portal-data";

/**
 * The partner's referral links: the label, the code, the full link with a copy button, the plan it
 * starts signup on, how many signups carried its code (whoever they were finally credited to), how
 * many of those are the partner's customers now, until when it works, and whether it still does.
 *
 * "End" stops a live link now, after a confirmation that says what it changes. Offered to the roles
 * that sell whatever the partner account's status — ending only ever takes something away. The server
 * checks again.
 */

const nameOf = (row: LinkRow) => row.label?.trim() || `the link ${row.code}`;

export function ReferralLinksTable({ rows, canEnd }: { rows: LinkRow[]; canEnd: boolean }) {
  const clock = useClock();
  const [ending, setEnding] = useState<LinkRow | null>(null);
  return (
    <>
      <DataTable caption="Referral links, newest first" minWidth={canEnd ? 1160 : 1080}>
        <THead>
          <Th>Label</Th>
          <Th>Code</Th>
          <Th>Link</Th>
          <Th>Plan</Th>
          <Th numeric>Signups</Th>
          <Th numeric>Customers</Th>
          <Th>Works until</Th>
          <Th>State</Th>
          {canEnd && <Th srOnly>Actions</Th>}
        </THead>
        <TBody>
          {rows.map((row) => (
            <Tr key={row.id}>
              <Td>
                {row.label ? (
                  <span className="block max-w-[14rem] min-w-28 truncate font-medium" title={row.label}>
                    {row.label}
                  </span>
                ) : (
                  <span className="text-subtle">No label</span>
                )}
                <span className="block text-[11px] text-subtle">{`Made ${clock.date(row.createdAt)}`}</span>
              </Td>
              <Td mono nowrap>
                <span translate="no">{row.code}</span>
              </Td>
              <Td>
                {row.state === "live" ? (
                  <CopyField value={row.url} label={`referral link ${row.code}`} className="max-w-[22rem]" />
                ) : (
                  <span className="font-mono text-xs break-all text-muted">{row.url}</span>
                )}
              </Td>
              <Td nowrap>{row.planName ?? <span className="text-muted">Default plan</span>}</Td>
              <Td numeric>{row.signups.toLocaleString("en-IN")}</Td>
              <Td numeric>{row.customers.toLocaleString("en-IN")}</Td>
              <Td muted nowrap>
                {row.endedAt ? `Ended ${clock.date(row.endedAt)}` : row.expiresAt ? clock.date(row.expiresAt) : "No end date"}
              </Td>
              <Td nowrap>
                <LabelPill map={INVITE_STATE} value={row.state} />
              </Td>
              {canEnd && (
                <RowActionsCell>
                  {row.state === "live" && (
                    <Button type="button" variant="secondary" size="sm" onClick={() => setEnding(row)}>
                      End
                      <span className="sr-only">{` ${nameOf(row)}`}</span>
                    </Button>
                  )}
                </RowActionsCell>
              )}
            </Tr>
          ))}
        </TBody>
      </DataTable>
      {canEnd && <EndLinkDialog row={ending} onClose={() => setEnding(null)} />}
    </>
  );
}

/** End a live link (tier 2): what stops, and what does not. */
function EndLinkDialog({ row, onClose }: { row: LinkRow | null; onClose: () => void }) {
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
      title="End referral link"
      confirmLabel="End link"
      tone="danger"
      pending={action.pending}
      error={action.error}
      onConfirm={() => {
        if (row) action.run(() => partnerEndLink(row.id), { success: "Referral link ended — it no longer credits signups.", onDone: onClose });
      }}
    >
      {row && (
        <>
          <p>
            <strong className="font-medium">{nameOf(row)}</strong> stops crediting signups now, wherever it has been shared. Customers who already came through it stay
            yours.
          </p>
          <ImpactList
            items={[
              { label: "Code", value: row.code },
              { label: "Works until", value: `${row.expiresAt ? clock.date(row.expiresAt) : "No end date"} → now`, tone: "danger" as const },
              { label: "Signups with it so far", value: row.signups.toLocaleString("en-IN") },
              { label: "Customers from it", value: row.customers > 0 ? `${plural(row.customers, "customer")} — not affected` : "None" },
            ]}
          />
        </>
      )}
    </ConfirmDialog>
  );
}
