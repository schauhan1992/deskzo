"use client";

import { useState } from "react";
import { FileStack, Play } from "lucide-react";
import { consoleGenerateStatements, consoleRunCommissions } from "@/actions/platform/console-commissions";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { Button } from "@/components/ui/button";
import { monthLabel, plural } from "@/lib/console-shared/format";
import type { AccrualRun } from "@/lib/partners/commission";

/**
 * The two runs staff may start by hand (SELLERS), each what the platform tick does on its own:
 * working out commission on paid invoices, and drafting last month's statements. Both are tier-2
 * confirmations that say what they touch, and both report their counts in the page notice.
 */

function ranNotice(run: AccrualRun): string {
  if (run.invoices === 0) return "Commissions worked out: no invoice was waiting.";
  const parts = [`${plural(run.accrued, "entry", "entries")} added`, `${plural(run.reversed, "reversal")} written`];
  if (run.failed > 0) parts.push(`${plural(run.failed, "invoice")} failed — see the server log`);
  return `Commissions worked out for ${plural(run.invoices, "invoice")}: ${parts.join(", ")}.`;
}

export function RunCommissionsButton() {
  const [open, setOpen] = useState(false);
  const action = useConsoleAction<AccrualRun>();
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        <Play aria-hidden="true" className="h-4 w-4" />
        Run commissions now
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => {
          setOpen(false);
          action.reset();
        }}
        title="Run commissions now"
        confirmLabel="Run now"
        pending={action.pending}
        error={action.error}
        onConfirm={() => action.run(() => consoleRunCommissions(), { success: ranNotice, onDone: () => setOpen(false) })}
      >
        <p>Does now what the platform tick does every few minutes: works out commission on paid invoices it hasn&apos;t seen, and takes back refunds and credit notes.</p>
        <ImpactList
          items={[
            { label: "Invoices", value: "Paid ones not worked out yet, and ones refunded since" },
            { label: "New entries", value: "Pending, until a statement takes them" },
            { label: "Statements", value: "Unchanged" },
          ]}
        />
      </ConfirmDialog>
    </>
  );
}

type Generated = { period: string; made: number; partners: number; numbers: string[]; failed: number };

function generatedNotice(run: Generated): string {
  const month = monthLabel(run.period);
  const failed = run.failed > 0 ? ` ${plural(run.failed, "statement")} failed — see the server log.` : "";
  if (run.made === 0) return `No new statements for ${month}: nothing was waiting, or they are drafted already.${failed}`;
  return `Generated ${plural(run.made, "draft statement")} for ${month}, for ${plural(run.partners, "partner")}.${failed}`;
}

/**
 * "Generate statements": last IST month's drafts, for every partner or one (`partner`). Drafts are
 * staff's work in progress — the partner sees a statement only once it is approved.
 */
export function GenerateStatementsButton({ nextPeriod, partner = null }: { nextPeriod: string; partner?: { slug: string; displayName: string } | null }) {
  const [open, setOpen] = useState(false);
  const action = useConsoleAction<Generated>();
  const month = monthLabel(nextPeriod);
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        <FileStack aria-hidden="true" className="h-4 w-4" />
        Generate statements
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => {
          setOpen(false);
          action.reset();
        }}
        title={partner ? `Generate statements for ${partner.displayName}` : "Generate statements"}
        confirmLabel="Generate"
        pending={action.pending}
        error={action.error}
        onConfirm={() => action.run(() => consoleGenerateStatements(partner?.slug ?? null), { success: generatedNotice, onDone: () => setOpen(false) })}
      >
        <p>
          {`Drafts a statement for ${month}, per currency, from the pending entries earned before the month ended. `}
          The partner sees a statement only once it is approved.
        </p>
        <ImpactList
          items={[
            { label: "Month", value: month },
            { label: "Partners", value: partner ? partner.displayName : "Every partner with commission waiting" },
            { label: "Already drafted, or nothing owed", value: "Skipped" },
          ]}
        />
      </ConfirmDialog>
    </>
  );
}
