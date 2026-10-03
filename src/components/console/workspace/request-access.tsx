"use client";

import { useState } from "react";
import { Mail } from "lucide-react";
import { consoleRequestSupportAccess } from "@/actions/platform/console-workspace";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { useClock } from "@/components/time/clock-provider";
import { Button } from "@/components/ui/button";
import type { SupportPanel } from "@/lib/platform/workspace-data";

/**
 * Asking a workspace's owner to let support in, when it has not: an email to its owner with a link
 * to its Security settings, where only its super admin can grant access. It grants nothing itself —
 * the owner chooses the level and how long, and can end it at any time. Once a day per workspace;
 * the last request and when the next one is allowed come from the loader. Times on the console's clock.
 */

export function RequestAccess({ tenantId, lastRequest, canRequestAgainAt }: { tenantId: string; lastRequest: SupportPanel["lastRequest"]; canRequestAgainAt: Date | null }) {
  const clock = useClock();
  const [open, setOpen] = useState(false);
  const { pending, error, run, reset } = useConsoleAction<{ at: string }>();
  const waiting = canRequestAgainAt !== null;

  function close() {
    setOpen(false);
    reset();
  }

  return (
    <div className="space-y-2">
      {lastRequest && (
        <p className="text-xs text-muted">
          {`Requested by ${lastRequest.byMe ? "you" : lastRequest.by} `}
          <RelativeTime at={lastRequest.at} />
          {waiting && canRequestAgainAt ? ` — ask again after ${clock.dayMonth(canRequestAgainAt)}, ${clock.time(canRequestAgainAt)}.` : "."}
        </p>
      )}
      {!waiting && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => {
            reset();
            setOpen(true);
          }}
        >
          <Mail aria-hidden="true" className="h-4 w-4" />
          Ask for access…
        </Button>
      )}
      <ConfirmDialog
        open={open}
        onClose={close}
        title="Ask the owner for access"
        confirmLabel="Send request"
        reason={{
          label: "Why support needs to look (sent to the owner)",
          minLength: 10,
          maxLength: 300,
          placeholder: "e.g. invoices fail to load for them since this morning",
        }}
        pending={pending}
        error={error}
        onConfirm={({ reason }) =>
          run(() => consoleRequestSupportAccess(tenantId, reason), {
            success: "Request sent to the workspace's owner.",
            onDone: () => setOpen(false),
          })
        }
      >
        <p>Emails the workspace&apos;s owner, asking them to grant support access from its Security settings.</p>
        <ImpactList
          items={[
            { label: "Sent to", value: "Its owner's email" },
            { label: "Signed as", value: "You, by your name" },
            { label: "Grants", value: "Nothing by itself" },
            { label: "Again", value: "Not for 24 hours" },
          ]}
        />
        <p className="text-muted">The owner chooses the level and how long, and can end it at any time.</p>
      </ConfirmDialog>
    </div>
  );
}
