"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setCreditLimit } from "@/actions/credit";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";

/**
 * Setting a customer's credit limit by hand — or handing them back to the engine's suggestion.
 *
 * Only offered to someone with `credit.override`; the reason is required and kept, because a limit
 * set by hand is exactly the thing somebody asks about a year later.
 */
export function CreditLimitForm({
  companyId,
  manualLimit,
  suggestedLimit,
}: {
  companyId: string;
  manualLimit: number | null;
  suggestedLimit: number;
}) {
  const router = useRouter();
  const [amount, setAmount] = useState(manualLimit !== null ? String(manualLimit) : "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function save(limit: number | null) {
    setError(null);
    setDone(null);
    startTransition(async () => {
      const result = await setCreditLimit({ companyId, limit, reason });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setReason("");
      setDone(limit === null ? "Back to the suggested limit." : "Limit saved.");
      router.refresh();
    });
  }

  const parsed = amount.trim() === "" ? null : Number(amount);
  const valid = parsed === null || (Number.isFinite(parsed) && parsed >= 0);

  return (
    <div className="space-y-2 border-t border-line pt-3">
      <p className="text-xs font-medium text-muted">Set the limit by hand</p>
      <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
        <div className="space-y-1">
          <Label htmlFor="credit-limit" className="text-xs">
            Limit (₹)
          </Label>
          <Input
            id="credit-limit"
            type="number"
            min={0}
            step="1000"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={String(suggestedLimit)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="credit-limit-reason" className="text-xs">
            Why
          </Label>
          <Textarea
            id="credit-limit-reason"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Parent company guarantee on file; reviewed with the MD"
          />
        </div>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      {done && <p className="text-xs text-success">{done}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={isPending || !valid || parsed === null} onClick={() => save(parsed)}>
          Save limit
        </Button>
        {manualLimit !== null && (
          <Button type="button" size="sm" variant="secondary" disabled={isPending} onClick={() => save(null)}>
            Use the suggested limit instead
          </Button>
        )}
      </div>
    </div>
  );
}
