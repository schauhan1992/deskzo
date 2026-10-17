"use client";

import { useId, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { consoleSetAutomateRunning } from "@/actions/platform/console-automate";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { StatusPill } from "@/components/console/kit/status";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ChangedBy, SettingSwitch, type SettingChange } from "@/components/console/settings/signup-settings";
import { ActionNoticeRegion } from "@/components/ui/action-notice";

/**
 * Settings › Automate: Deskzo Automate's kill switch for every workspace at once. Switching it off is
 * confirmed first; on saves straight away. `readOnly` (everybody but an owner) shows it in words.
 */

const ON_SENTENCE = "Workflows run in every workspace whose own switch is on.";
const OFF_SENTENCE = "Paused everywhere: no workflow starts or moves on. Runs keep their place and carry on when it is switched back on.";
const NEVER = "Never changed — on by default";

export function AutomateSwitch({ running, change, readOnly = false }: { running: boolean; change: SettingChange | null; readOnly?: boolean }) {
  const id = useId();
  const action = useConsoleAction<null>();
  const [confirming, setConfirming] = useState(false);

  if (readOnly) {
    return (
      <div className="space-y-3">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <StatusPill tone={running ? "success" : "warning"}>{running ? "On" : "Paused"}</StatusPill>
          <span className="text-muted">{running ? ON_SENTENCE : OFF_SENTENCE}</span>
        </p>
        <ChangedBy change={change} never={NEVER} className="border-t border-line pt-3" />
      </div>
    );
  }

  function save(next: boolean) {
    action.run(() => consoleSetAutomateRunning(next), {
      success: next ? "Workflows are running again." : "Every workflow is paused.",
      onDone: () => setConfirming(false),
    });
  }

  function toggle(next: boolean) {
    if (action.pending) return;
    action.reset();
    if (!next) {
      setConfirming(true);
      return;
    }
    save(true);
  }

  const labelId = `${id}-label`;
  const helpId = `${id}-help`;
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <span id={labelId} className="text-sm font-medium text-text">
            Workflows
          </span>
          <p id={helpId} className={running ? "mt-0.5 text-xs text-muted" : "mt-0.5 text-xs text-warning"}>
            {running ? ON_SENTENCE : OFF_SENTENCE} Takes effect at the worker&apos;s next pass, within seconds.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          {action.pending && !confirming && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin text-subtle" />}
          <SettingSwitch checked={running} onChange={toggle} labelledBy={labelId} describedBy={helpId} disabled={action.pending} />
        </div>
      </div>
      <ChangedBy change={change} never={NEVER} className="mt-3 border-t border-line pt-3" />
      <ActionNoticeRegion notice={!confirming && action.error ? { tone: "error", message: action.error } : null} className="mt-3 empty:mt-0" />
      <ConfirmDialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
          action.reset();
        }}
        title="Pause every workflow"
        confirmLabel="Pause them"
        tone="danger"
        pending={action.pending}
        error={action.error}
        onConfirm={() => save(false)}
      >
        <ImpactList items={[{ label: "Deskzo Automate, every workspace", value: "On → Paused", tone: "danger" }]} />
        <p>
          <span className="font-medium">No workflow starts or moves on anywhere until it is switched back on.</span> Runs keep their place; schedules missed
          meanwhile run once when it is lifted.
        </p>
      </ConfirmDialog>
    </>
  );
}
