"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";
import { consoleSendAdminReset } from "@/actions/platform/console-workspace";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { Button } from "@/components/ui/button";

/**
 * A password reset link for a workspace's super admin (src/lib/platform/admin-reset.ts): to their own
 * address in the workspace, once, for 24 hours. Staff never see the link — only who it went to, the
 * address partly hidden — and the workspace's own audit log records that support sent it.
 */
export function AdminReset({ tenantId, workspace }: { tenantId: string; workspace: string }) {
  const [open, setOpen] = useState(false);
  const { pending, error, run, reset } = useConsoleAction<{ name: string; to: string }>();
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        <KeyRound aria-hidden="true" className="h-4 w-4" />
        Send a password reset…
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => {
          if (!pending) setOpen(false);
        }}
        title="Send its super admin a password reset"
        confirmLabel="Send the link"
        pending={pending}
        error={error}
        onConfirm={() =>
          run(() => consoleSendAdminReset(tenantId), {
            success: (r) => `A reset link went to ${r.name} at ${r.to}.`,
            onDone: () => setOpen(false),
          })
        }
      >
        <ImpactList
          items={[
            { label: "Sent to", value: `${workspace}'s super admin, at their own address in the workspace` },
            { label: "The link", value: "Works once, for 24 hours" },
            { label: "Their password", value: "Keeps working until they use it" },
          ]}
        />
        <p>Nobody here sees the link. It says it came from support, by your name, and the workspace&apos;s audit log records it.</p>
      </ConfirmDialog>
    </>
  );
}
