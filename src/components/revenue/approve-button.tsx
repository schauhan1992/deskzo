"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { approveSchedule } from "@/actions/revenue";
import { Button } from "@/components/ui/button";

/**
 * Approves a schedule made or changed by hand (D2). Shown only to somebody the rule lets approve it
 * (`mayApproveSchedule`), and the action asks again. The super admin approving their own is allowed,
 * and said so before the click as well as in the audit log.
 */
export function ApproveButton({ id, own, size = "sm" }: { id: string; own?: boolean; size?: "sm" | "md" }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function approve() {
    setError(null);
    startTransition(async () => {
      const result = await approveSchedule(id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button type="button" size={size} disabled={pending} onClick={approve}>
        {pending ? "Approving…" : own ? "Approve your own" : "Approve"}
      </Button>
      {own && <span className="text-xs text-warning">You made this. As super admin you may approve it; the audit log records that.</span>}
      {error && (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
    </div>
  );
}
