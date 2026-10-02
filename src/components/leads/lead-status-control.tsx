"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LeadStatus } from "@prisma/client";
import { updateLeadStatus } from "@/actions/lead";
import { Select } from "@/components/ui/input";

const NEEDS_REASON: LeadStatus[] = ["LOST", "DISQUALIFIED"];

/** A stage as the control offers it (src/lib/pipeline). */
export type StageChoice = { id: string; label: string; status: LeadStatus };

/**
 * The lead's stage, and the workspace's stages to move it to (Settings → Pipeline). A stage that counts
 * as lost or disqualified asks for the reason first.
 */
export function LeadStatusControl({ leadId, current, stages }: { leadId: string; current: StageChoice; stages: StageChoice[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // The stage it is at stays choosable even if it has since been retired, so the control shows the truth.
  const choices = stages.some((s) => s.id === current.id) ? stages : [current, ...stages];

  function handleChange(stageId: string) {
    const next = choices.find((s) => s.id === stageId);
    if (!next || next.id === current.id) return;
    setError(null);
    let lostReason: string | undefined;
    if (NEEDS_REASON.includes(next.status)) {
      const input = window.prompt(`Reason for moving this lead to "${next.label}":`);
      if (!input) return;
      lostReason = input;
    }

    startTransition(async () => {
      const result = await updateLeadStatus({ leadId, stageId: next.id, lostReason });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div>
      <Select value={current.id} disabled={isPending} onChange={(e) => handleChange(e.target.value)} aria-label="Lead stage" className="w-48">
        {choices.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </Select>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
