"use client";

import { useState } from "react";
import { Ban } from "lucide-react";
import { consoleVoidCommission } from "@/actions/platform/console-commissions";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { IconButton } from "@/components/ui/icon-button";
import { plural } from "@/lib/console-shared/format";

/** What the void dialog says about the entry, worked out by the table that draws the button. */
export type VoidEntryTarget = {
  id: string;
  /** "₹1,200.00 for Acme Pvt Ltd" — names the button and the dialog. */
  label: string;
  partner: string;
  amount: string;
  customer: string | null;
  /** The DRAFT statement it is on, which is worked out again without it. */
  draftStatement: string | null;
  /** An accrual (not a reversal or an adjustment): its pending reversals go with it. */
  accrual: boolean;
};

function voidedNotice(data: { reversalsVoided: number; statementsVoided: string[] }): string {
  const parts = ["Commission voided."];
  if (data.reversalsVoided > 0) parts.push(`${plural(data.reversalsVoided, "pending reversal")} voided with it.`);
  if (data.statementsVoided.length > 0) {
    parts.push(`${data.statementsVoided.length === 1 ? "Statement" : "Statements"} ${data.statementsVoided.join(", ")} voided too — nothing was left to pay.`);
  }
  return parts.join(" ");
}

/**
 * "Void" on a PENDING entry (SELLERS; spec §5.9): with a reason, which stays in the platform's log —
 * the partner sees that the entry was voided, not why. A tier-2 confirmation: what it takes away,
 * and the draft statement it changes. The server refuses anything that is no longer PENDING.
 */
export function VoidEntryButton({ entry }: { entry: VoidEntryTarget }) {
  const [open, setOpen] = useState(false);
  const action = useConsoleAction<{ reversalsVoided: number; statementsVoided: string[] }>();

  function close() {
    setOpen(false);
    action.reset();
  }

  return (
    <>
      <IconButton
        icon={Ban}
        label={`Void commission ${entry.label}`}
        tone="danger"
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      />
      <ConfirmDialog
        open={open}
        onClose={close}
        title="Void commission"
        confirmLabel="Void commission"
        tone="danger"
        reason={{ label: "Reason (kept in the platform's log, not shown to the partner)", minLength: 3, maxLength: 500, placeholder: "Duplicate of an earlier entry" }}
        pending={action.pending}
        error={action.error}
        onConfirm={({ reason }) => action.run(() => consoleVoidCommission(entry.id, reason), { success: voidedNotice, onDone: () => setOpen(false) })}
      >
        <p>The partner is no longer owed this entry. It stays on the list, marked void, and the partner sees that it was voided.</p>
        <ImpactList
          items={[
            { label: "Partner", value: entry.partner },
            ...(entry.customer ? [{ label: "Customer", value: entry.customer }] : []),
            { label: "Commission", value: entry.amount, tone: "danger" as const },
            ...(entry.draftStatement ? [{ label: "Draft statement", value: `${entry.draftStatement} — worked out again`, tone: "warning" as const }] : []),
            ...(entry.accrual ? [{ label: "Pending reversals of it", value: "Voided with it" }] : []),
          ]}
        />
      </ConfirmDialog>
    </>
  );
}
