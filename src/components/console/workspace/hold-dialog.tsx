"use client";

import { useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { CirclePause } from "lucide-react";
import { consoleSuspend } from "@/actions/platform/console";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { Button } from "@/components/ui/button";

/**
 * Holding a workspace (T2): its staff and users are locked out until staff reopen it, and a
 * billing hold already on it becomes a staff hold that paying does not lift. A reason is required
 * and kept in the audit log. A workspace that pays at a gateway also needs its address typed — the
 * server checks that word as well, so a forged call cannot skip it — because holding it here does
 * not pause what the gateway charges.
 *
 * Rendered for managers only: nothing in this file is drawn for anyone else.
 */

type HoldTenant = { id: string; slug: string; name: string };

export function HoldDialog({ open, onClose, tenant, gatewayPaying }: { open: boolean; onClose: () => void; tenant: HoldTenant; gatewayPaying: boolean }) {
  const { pending, error, run, reset } = useConsoleAction<{ replacedBillingHold: boolean }>();

  function close() {
    reset();
    onClose();
  }

  return (
    <ConfirmDialog
      open={open}
      onClose={close}
      title="Hold workspace"
      confirmLabel="Hold workspace"
      tone="danger"
      reason={{ label: "Reason (kept in the audit log)", minLength: 3, maxLength: 300, placeholder: "e.g. chargeback under investigation" }}
      typed={gatewayPaying ? tenant.slug : undefined}
      pending={pending}
      error={error}
      onConfirm={({ typed, reason }) =>
        run(() => consoleSuspend(tenant.id, reason, typed), {
          success: (d) => (d.replacedBillingHold ? "Workspace held — its billing hold is now a staff hold." : "Workspace held."),
          onDone: close,
        })
      }
    >
      <p>{`Everyone in ${tenant.name} — its staff and its users — is locked out until it is reopened.`}</p>
      <ImpactList
        items={[
          { label: "Signing in", value: "Refused for everyone", tone: "danger" },
          { label: "Lifted by", value: "Staff reopening it — never by billing" },
          ...(gatewayPaying ? [{ label: "Its gateway subscription", value: "Keeps charging — not paused", tone: "warning" as const }] : []),
        ]}
      />
      {gatewayPaying && <p className="text-muted">It pays at a gateway, and a hold here does not pause that subscription — so its address is asked for too.</p>}
    </ConfirmDialog>
  );
}

const subscribeNothing = () => () => {};

/**
 * The Danger zone's hold button — the one instance that opens by itself when the page is reached
 * with `?do=hold` (the directory's row menu and the palette link here that way). The dialog draws
 * through a portal, which the server cannot render, so the address is only acted on once in the
 * browser; closing it drops `do=hold` from the address, so a reload does not ask again.
 */
export function HoldButton({ tenant, gatewayPaying }: { tenant: HoldTenant; gatewayPaying: boolean }) {
  const params = useSearchParams();
  const inBrowser = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
  const [clicked, setClicked] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = clicked || (inBrowser && !dismissed && params.get("do") === "hold");

  function close() {
    setClicked(false);
    setDismissed(true);
    const url = new URL(window.location.href);
    if (url.searchParams.get("do") === "hold") {
      url.searchParams.delete("do");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }

  return (
    <>
      <Button type="button" size="sm" variant="secondary" onClick={() => setClicked(true)} className="border-danger/40 text-danger hover:bg-danger-bg">
        <CirclePause aria-hidden="true" className="h-4 w-4" />
        Hold workspace
      </Button>
      <HoldDialog open={open} onClose={close} tenant={tenant} gatewayPaying={gatewayPaying} />
    </>
  );
}
