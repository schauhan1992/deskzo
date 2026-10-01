"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelVendorCredit, removeVendorCreditSettlement } from "@/actions/vendor-credit";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";

/** Takes one part of a vendor credit off what it was set against — a rebate, or a bill. */
export function RemoveSettlementButton({ kind, id }: { kind: "allocation" | "application"; id: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-xs text-danger">{error}</span>}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            const result = await removeVendorCreditSettlement({ kind, id });
            if (!result.ok) setError(result.error);
            else router.refresh();
          })
        }
      >
        Take off
      </Button>
    </span>
  );
}

/** Cancels a credit recorded in error — its posting reversed, what it was set against undone. */
export function CancelVendorCreditButton({ id }: { id: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <>
      <Button type="button" variant="ghost" size="sm" className="text-danger" onClick={() => setOpen(true)}>
        Cancel this credit
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Cancel the credit">
        <div className="space-y-2">
          {error && <p className="text-sm text-danger">{error}</p>}
          <p className="text-sm text-muted">
            Its posting is reversed today. The rebates it was set against are due again, and the bills owe again.
          </p>
          <Label htmlFor={`cancel-${id}`} className="text-xs">Why</Label>
          <Textarea id={`cancel-${id}`} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={isPending}>
            Keep it
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={isPending || reason.trim().length < 5}
            onClick={() =>
              startTransition(async () => {
                const result = await cancelVendorCredit({ vendorCreditId: id, reason });
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                setOpen(false);
                router.refresh();
              })
            }
          >
            {isPending ? "Cancelling…" : "Cancel it"}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
