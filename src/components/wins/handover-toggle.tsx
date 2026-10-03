"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, PackageCheck } from "lucide-react";
import { setPrizeHandedOver } from "@/actions/prizes";
import { Button } from "@/components/ui/button";
import { useClock } from "@/components/time/clock-provider";

/** Whether a prize has been given yet — ticked by whoever runs the prizes. */
export function HandoverToggle({ id, handedOverAt }: { id: string; handedOverAt: Date | string | null }) {
  const router = useRouter();
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const flip = (handedOver: boolean) =>
    startTransition(async () => {
      const result = await setPrizeHandedOver(id, handedOver);
      setError(result.ok ? null : result.error);
      if (result.ok) router.refresh();
    });

  return (
    <div className="flex flex-col items-end gap-1">
      {handedOverAt ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => flip(false)}
          title="Undo — not handed over yet"
          className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 text-[11px] font-medium text-success hover:brightness-95"
        >
          <Check className="h-3 w-3" aria-hidden /> Handed over {clock.dayMonth(handedOverAt)}
        </button>
      ) : (
        <Button variant="secondary" size="sm" disabled={pending} onClick={() => flip(true)}>
          <PackageCheck className="h-3.5 w-3.5" /> Mark handed over
        </Button>
      )}
      {error && <span className="text-[11px] text-danger">{error}</span>}
    </div>
  );
}
