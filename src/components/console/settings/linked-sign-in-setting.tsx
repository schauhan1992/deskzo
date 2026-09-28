"use client";

import { useId, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { consoleSetLinkedSignIn } from "@/actions/platform/console-linked";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { DefinitionList } from "@/components/console/kit/panel";
import { StatusPill } from "@/components/console/kit/status";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ChangedBy, SettingSwitch, type SettingChange } from "@/components/console/settings/signup-settings";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import type { Tone } from "@/lib/console-shared/types";

/**
 * Settings › Linked sign-in (owner decision #8): one switch for every workspace — whether people who
 * linked their accounts in several workspaces switch between them from the header without signing in
 * again. It is `linkedSignIn.enabled`, which `npm run linked-sign-in -- on|off` also sets from the
 * server; the page says who changed it last, a staff member or that script.
 *
 * An owner flips it here: switching it off is confirmed first, switching it back on saves straight
 * away. The switch shows what is saved, and moves once the save has gone through. `readOnly` (admins
 * and billing staff) shows the state in words, with no control at all.
 */

const ON_SENTENCE =
  "People who linked their accounts in several workspaces switch between them from the workspace header, without signing in again. Each workspace's administrators can still turn switching in off for their own.";
const OFF_SENTENCE = "Paused: no workspace shows its switcher, and nobody can link accounts or switch. Existing links are kept for when it is switched back on.";
const NEVER = "Never changed — on by default";

export function LinkedSignInSwitch({
  enabled,
  change,
  readOnly = false,
}: {
  /** As saved: on unless it has been switched off. */
  enabled: boolean;
  /** Who last switched it, and when — null when nobody ever has. */
  change: SettingChange | null;
  /** Everybody but an owner: the state in words, no control. */
  readOnly?: boolean;
}) {
  const id = useId();
  const action = useConsoleAction<null>();
  const [confirming, setConfirming] = useState(false);

  if (readOnly) {
    return (
      <div className="space-y-4">
        <DefinitionList
          columns={1}
          items={[
            {
              term: "Linked sign-in",
              value: enabled ? (
                <Stated tone="success" label="On">
                  {ON_SENTENCE}
                </Stated>
              ) : (
                <Stated tone="warning" label="Off">
                  {OFF_SENTENCE}
                </Stated>
              ),
            },
          ]}
        />
        <ChangedBy change={change} never={NEVER} className="border-t border-line pt-3" />
      </div>
    );
  }

  function save(next: boolean) {
    action.run(() => consoleSetLinkedSignIn(next), {
      success: next ? "Linked sign-in switched on." : "Linked sign-in switched off — every workspace switcher is paused.",
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
            Linked sign-in
          </span>
          <div id={helpId} className="mt-0.5 space-y-1">
            <p className={enabled ? "text-xs text-muted" : "text-xs text-warning"}>{enabled ? ON_SENTENCE : OFF_SENTENCE}</p>
            <p className="text-xs text-muted">
              {"Takes effect within 30 seconds. The same switch as "}
              <code className="font-mono text-[11px] break-all text-text">npm run linked-sign-in -- on|off</code>
              {" on the server."}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          {action.pending && !confirming && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin text-subtle" />}
          <SettingSwitch checked={enabled} onChange={toggle} labelledBy={labelId} describedBy={helpId} disabled={action.pending} />
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
        title="Switch linked sign-in off"
        confirmLabel="Switch it off"
        tone="danger"
        pending={action.pending}
        error={action.error}
        onConfirm={() => save(false)}
      >
        <ImpactList items={[{ label: "Linked sign-in, every workspace", value: "On → Off", tone: "danger" }]} />
        <p>
          <span className="font-medium">Every workspace switcher stops working; existing links are kept.</span> Nobody can switch between linked workspaces
          or link new ones until it is switched back on — everybody signs in to each workspace directly meanwhile.
        </p>
      </ConfirmDialog>
    </>
  );
}

/** A value as a pill, then what it means — as the rest of the Settings page shows its read-only values. */
function Stated({ tone, label, children }: { tone: Tone; label: string; children: ReactNode }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatusPill tone={tone}>{label}</StatusPill>
      <span className="text-muted">{children}</span>
    </span>
  );
}
