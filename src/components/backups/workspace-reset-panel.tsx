"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Clock } from "lucide-react";
import { cancelScheduledReset, scheduleWorkspaceReset } from "@/actions/workspace-reset";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { IdentityFields } from "@/components/security/identity-fields";
import { RestoreRowButton } from "@/components/backups/restore-row-button";
import { useClock } from "@/components/time/clock-provider";
import type { workspaceResetState } from "@/lib/workspace-reset";

export type WorkspaceResetView = NonNullable<Awaited<ReturnType<typeof workspaceResetState>>>;

/**
 * "Reset the workspace" on Settings › Backups (owner, 22 Oct 2026 — src/lib/workspace-reset.ts). The super
 * admin schedules it a day out, typing the workspace's address and confirming it's them; every admin who
 * looks after backups sees it waiting and can cancel it. Once done, the copy taken before is offered here
 * for 30 days as the undo.
 */
export function WorkspaceResetPanel({ state, canRestore }: { state: WorkspaceResetView; canRestore: boolean }) {
  const clock = useClock();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [askCode, setAskCode] = useState(false);
  const [mode, setMode] = useState<"KEEP_SETUP" | "EVERYTHING">("KEEP_SETUP");
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  function schedule() {
    setResult(null);
    startTransition(async () => {
      const r = await scheduleWorkspaceReset({ confirm, password, code, mode });
      if (r.needsCode) setAskCode(true);
      if (!r.ok) {
        setResult({ tone: "error", text: r.error });
        return;
      }
      setConfirm("");
      setPassword("");
      setCode("");
      router.refresh();
    });
  }

  function cancel() {
    setResult(null);
    startTransition(async () => {
      const r = await cancelScheduledReset();
      if (!r.ok) setResult({ tone: "error", text: r.error });
      else router.refresh();
    });
  }

  const last = state.last;
  return (
    <Card className="border-danger/40">
      <CardHeader className="flex items-center gap-2 text-sm font-semibold text-danger">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        Reset the workspace
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {state.scheduled ? (
          <div className="rounded-base border border-danger/40 bg-danger-bg px-3 py-2.5 text-danger">
            <p className="flex items-center gap-1.5 font-medium">
              <Clock className="h-4 w-4" aria-hidden="true" />
              {state.scheduled.status === "RUNNING" ? "The reset is running now." : `A reset is scheduled for ${clock.dateTime(state.scheduled.runAfter)}.`}
            </p>
            <p className="mt-1">
              {state.scheduled.requestedByName} asked for it on {clock.dateTime(state.scheduled.requestedAt)}.{" "}
              {state.scheduled.mode === "KEEP_SETUP"
                ? "Customers, leads, orders, documents, payments, tickets, tasks, stock, the ledger's entries and HR history will be removed; people, settings and the catalogue stay."
                : "Every record, setting and account except the super admin's will be removed."}{" "}
              A copy of the workspace is taken first and kept 30 days.
            </p>
            {state.scheduled.status === "SCHEDULED" && state.canCancel && (
              <Button variant="secondary" size="sm" className="mt-2" disabled={pending} onClick={cancel}>
                {pending ? "Cancelling…" : "Cancel the reset"}
              </Button>
            )}
          </div>
        ) : state.isSuperAdmin && state.overview ? (
          <>
            <p className="text-text">
              The workspace holds {state.overview.counts.users} people, {state.overview.counts.companies} companies, {state.overview.counts.contacts} contacts,{" "}
              {state.overview.counts.leads} leads, {state.overview.counts.orders} orders, {state.overview.counts.documents} quotes and invoices,{" "}
              {state.overview.counts.payments} payments and {state.overview.counts.tickets} tickets. Choose what goes:
            </p>
            <div role="radiogroup" aria-label="What the reset removes" className="space-y-2">
              {(
                [
                  {
                    value: "KEEP_SETUP",
                    title: "Clear my data, keep my setup",
                    text: "Customers, contacts, leads, orders, quotes and invoices, payments, tickets, tasks, stock, the ledger's entries, chat, and HR history (attendance, leave taken, payslips, expense claims, letters) go. Everybody's account, roles and permissions, the organisation's details, the catalogue, pipelines, templates, automations, employee profiles and salary structures stay. Numbering starts again from 1.",
                  },
                  {
                    value: "EVERYTHING",
                    title: "Start completely fresh",
                    text: "Everything goes — every record, every setting, every other person's account. Only your account stays, and the workspace itself: its address, plan and billing.",
                  },
                ] as const
              ).map((o) => (
                <label key={o.value} className={`flex cursor-pointer items-start gap-2 rounded-base border px-3 py-2 ${mode === o.value ? "border-danger/60 bg-danger-bg" : "border-line"}`}>
                  <input type="radio" name="reset-mode" className="mt-1" checked={mode === o.value} onChange={() => setMode(o.value)} disabled={pending} />
                  <span>
                    <span className="font-medium text-text">{o.title}</span>
                    <span className="mt-0.5 block text-xs text-muted">{o.text}</span>
                  </span>
                </label>
              ))}
            </div>
            <ul className="list-disc space-y-0.5 pl-5 text-muted">
              <li>It runs a day after you ask, and every admin who looks after backups is told at once — any of them can cancel it until then.</li>
              <li>A copy of the workspace is taken just before and kept 30 days. Restoring it from this page undoes the reset.</li>
              <li>Not once e-invoices or e-way bills have been generated: those records must be kept by law.</li>
            </ul>
            {state.blockers.length > 0 ? (
              <ActionNotice tone="error">{state.blockers.map((b) => b.message).join(" ")}</ActionNotice>
            ) : (
              <div className="max-w-sm space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="reset-confirm">
                    Type the workspace&apos;s address, <span className="font-mono">{state.slug}</span>
                  </Label>
                  <Input id="reset-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" disabled={pending} className="font-mono" />
                </div>
                <IdentityFields idPrefix="reset" password={password} onPassword={setPassword} code={code} onCode={setCode} showCode={askCode} />
                <Button variant="danger" disabled={pending || confirm.trim().toLowerCase() !== state.slug.toLowerCase() || password.length === 0} onClick={schedule}>
                  {pending ? "Scheduling…" : "Schedule the reset"}
                </Button>
              </div>
            )}
          </>
        ) : (
          <p className="text-muted">Only the workspace&apos;s super admin can reset it. You&apos;ll see it here if they schedule one, and can cancel it.</p>
        )}

        {result && <ActionNotice tone={result.tone}>{result.text}</ActionNotice>}

        {last && !state.scheduled && (
          <div className="border-t border-line pt-3 text-xs text-muted">
            {last.status === "DONE" && (
              <>
                <p>
                  The workspace was reset on {clock.dateTime(last.finishedAt)} at {last.requestedByName}&apos;s request.
                  {state.undo ? " To undo it, restore the copy taken just before:" : last.backupFilename ? ` The copy taken before was ${last.backupFilename}.` : ""}
                </p>
                {state.undo && canRestore && (
                  <div className="mt-2 flex items-center gap-2 text-text">
                    <span className="font-mono">{state.undo.filename}</span>
                    <RestoreRowButton backup={state.undo} />
                  </div>
                )}
              </>
            )}
            {last.status === "CANCELLED" && <p>The last reset asked for was cancelled by {last.cancelledByName} on {clock.dateTime(last.finishedAt)}.</p>}
            {last.status === "FAILED" && <p className="text-danger">The last reset failed and nothing was removed: {last.error}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
