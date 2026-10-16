"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, RotateCcw } from "lucide-react";
import { resetPersonToRole } from "@/actions/person-access";
import { startViewingAs } from "@/actions/impersonation";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ActionNotice } from "@/components/ui/action-notice";

/**
 * "Reset to role defaults" and "View as user", at the top of one person's access.
 *
 * Resetting removes every exception they have — permissions, record levels, field access, their daily
 * limit — and nothing else: their role, and everybody else's access, stay as they are. Viewing as them
 * is the app's own view-as, with its rules and its log.
 */
export function PersonHeaderActions({ userId, name, exceptions, canReset, canViewAs }: { userId: string; name: string; exceptions: number; canReset: boolean; canViewAs: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const reset = () =>
    start(async () => {
      const r = await resetPersonToRole(userId);
      setConfirming(false);
      setNotice(r.ok ? { tone: "success", text: r.data.removed ? `Removed ${r.data.removed} exception${r.data.removed === 1 ? "" : "s"}. ${name} now holds what their role gives.` : "Nothing to reset — they already follow their role." } : { tone: "error", text: r.error });
      router.refresh();
    });

  const viewAs = () =>
    start(async () => {
      const r = await startViewingAs(userId);
      if (!r.ok) {
        setNotice({ tone: "error", text: r.error });
        return;
      }
      router.push("/dashboard");
      router.refresh();
    });

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap gap-2">
        {canReset && (
          <Button variant="secondary" size="sm" onClick={() => setConfirming(true)} disabled={pending}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Reset to role defaults
          </Button>
        )}
        {canViewAs && (
          <Button variant="secondary" size="sm" onClick={viewAs} disabled={pending}>
            <Eye className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            View as user
          </Button>
        )}
      </div>
      {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
      {confirming && (
        <Dialog open onClose={() => setConfirming(false)} title={`Reset ${name} to their role?`}>
          <p className="text-sm text-muted">
            {exceptions
              ? `Their ${exceptions} exception${exceptions === 1 ? "" : "s"} — permissions, record access, field access and their daily limit — will be removed. Their role, and everybody else, stay as they are.`
              : "They have no exceptions; nothing will change."}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={reset} disabled={pending}>
              {pending ? "Resetting…" : "Reset to role defaults"}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
