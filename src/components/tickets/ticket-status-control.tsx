"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TicketStatus } from "@prisma/client";
import { updateTicketStatus } from "@/actions/ticket";
import { ticketStatusValues } from "@/lib/validation/ticket";
import { Select } from "@/components/ui/input";

export function TicketStatusControl({ ticketId, status }: { ticketId: string; status: TicketStatus }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleChange(next: TicketStatus) {
    setError(null);
    startTransition(async () => {
      const result = await updateTicketStatus({ ticketId, status: next });
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
        aria-label="Status"
        value={status}
        disabled={isPending}
        onChange={(e) => handleChange(e.target.value as TicketStatus)}
        className="w-40"
      >
        {ticketStatusValues.map((s) => (
          <option key={s} value={s}>
            {s.replaceAll("_", " ")}
          </option>
        ))}
      </Select>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
