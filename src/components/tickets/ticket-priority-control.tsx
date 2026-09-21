"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TicketPriority } from "@prisma/client";
import { updateTicketPriority } from "@/actions/ticket";
import { ticketPriorityValues } from "@/lib/validation/ticket";
import { Select } from "@/components/ui/input";

export function TicketPriorityControl({ ticketId, priority }: { ticketId: string; priority: TicketPriority }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleChange(next: TicketPriority) {
    setError(null);
    startTransition(async () => {
      const result = await updateTicketPriority({ ticketId, priority: next });
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
        aria-label="Priority"
        value={priority}
        disabled={isPending}
        onChange={(e) => handleChange(e.target.value as TicketPriority)}
        className="w-32"
      >
        {ticketPriorityValues.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </Select>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
