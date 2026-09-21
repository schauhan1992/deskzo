"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateLeadStatus } from "@/actions/lead";
import { leadStatusValues } from "@/lib/validation/lead";
import { Select } from "@/components/ui/input";
import type { LeadStatus } from "@prisma/client";

const NEEDS_REASON: LeadStatus[] = ["LOST", "DISQUALIFIED"];

export function LeadStatusControl({ leadId, status }: { leadId: string; status: LeadStatus }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleChange(next: LeadStatus) {
    setError(null);
    let lostReason: string | undefined;
    if (NEEDS_REASON.includes(next)) {
      const input = window.prompt(`Reason for marking this lead "${next}":`);
      if (!input) return;
      lostReason = input;
    }

    startTransition(async () => {
      const result = await updateLeadStatus({ leadId, status: next, lostReason });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div>
      <Select
        value={status}
        disabled={isPending}
        onChange={(e) => handleChange(e.target.value as LeadStatus)}
        aria-label="Lead status"
        className="w-48"
      >
        {leadStatusValues.map((s) => (
          <option key={s} value={s}>
            {s.replaceAll("_", " ")}
          </option>
        ))}
      </Select>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
