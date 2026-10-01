"use client";

import { useId, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { consoleSetDomainsOffered } from "@/actions/platform/console-domains";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { DefinitionList } from "@/components/console/kit/panel";
import { StatusPill } from "@/components/console/kit/status";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ChangedBy, SettingSwitch, type SettingChange } from "@/components/console/settings/signup-settings";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import type { Tone } from "@/lib/console-shared/types";

/**
 * Settings › Custom domains: `domains.offered`, whether workspace owners may add addresses of their own
 * from Settings › Domain (src/lib/platform/domains.ts). Off until HTTPS certificates for them are
 * automated. Switching it on is confirmed first — every workspace whose plan allows one can then add
 * one; switching it off saves straight away and removes nothing. Staff add and check addresses from a
 * workspace's page whatever it says. `readOnly` (admins and billing staff) shows the state in words.
 */

const ON_SENTENCE = "Workspace owners whose plan allows a custom domain can add one under Settings › Domain, prove it with a DNS record and use it.";
const OFF_SENTENCE =
  "Owners see that custom domains aren't offered yet, and nothing can be added there. Addresses already added keep working; staff can still add and check them from a workspace's page.";
const NEVER = "Never changed — off by default";

export function DomainsOfferedSwitch({ offered, change, readOnly = false }: { offered: boolean; change: SettingChange | null; readOnly?: boolean }) {
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
              term: "Custom domains for workspaces",
              value: offered ? (
                <Stated tone="success" label="Offered">
                  {ON_SENTENCE}
                </Stated>
              ) : (
                <Stated tone="neutral" label="Not offered">
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
    action.run(() => consoleSetDomainsOffered(next), {
      success: next ? "Custom domains are offered to workspaces." : "Custom domains are no longer offered — addresses already added keep working.",
      onDone: () => setConfirming(false),
    });
  }

  function toggle(next: boolean) {
    if (action.pending) return;
    action.reset();
    if (next) {
      setConfirming(true);
      return;
    }
    save(false);
  }

  const labelId = `${id}-label`;
  const helpId = `${id}-help`;

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <span id={labelId} className="text-sm font-medium text-text">
            Offer custom domains to workspaces
          </span>
          <p id={helpId} className="mt-0.5 text-xs text-muted">
            {offered ? ON_SENTENCE : OFF_SENTENCE}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          {action.pending && !confirming && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin text-subtle" />}
          <SettingSwitch checked={offered} onChange={toggle} labelledBy={labelId} describedBy={helpId} disabled={action.pending} />
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
        title="Offer custom domains"
        confirmLabel="Offer them"
        checks={["The HTTPS certificates for workspaces' own addresses are issued automatically on this installation."]}
        pending={action.pending}
        error={action.error}
        onConfirm={() => save(true)}
      >
        <ImpactList items={[{ label: "Custom domains, every workspace", value: "Not offered → Offered", tone: "warning" }]} />
        <p>Every workspace whose plan allows a custom domain can add one at once. An address is served as soon as its DNS records check out.</p>
      </ConfirmDialog>
    </>
  );
}

function Stated({ tone, label, children }: { tone: Tone; label: string; children: ReactNode }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatusPill tone={tone}>{label}</StatusPill>
      <span className="text-muted">{children}</span>
    </span>
  );
}
