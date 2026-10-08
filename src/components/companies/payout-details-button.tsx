"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Landmark } from "lucide-react";
import { setPayoutDetails } from "@/actions/company";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";

/**
 * The PAN of a company we pay — what TDS is deducted against. Its bank accounts are a list of their
 * own on the record since 8 Oct 2026 (src/components/banking/bank-accounts-manager.tsx). Shown only to
 * whoever may change it (`payments.manage`).
 */
export function PayoutDetailsButton({ companyId, panNumber }: { companyId: string; panNumber: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(panNumber ?? "");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function openDialog() {
    setError(null);
    setValue(panNumber ?? "");
    setOpen(true);
  }

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const result = await setPayoutDetails(companyId, { panNumber: value });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="inline-flex items-center gap-1.5 rounded-full bg-surface-sunken px-2.5 py-0.5 text-xs font-medium text-text transition-colors hover:bg-line"
      >
        <Landmark className="h-3 w-3" />
        {panNumber ? "PAN set" : "Set PAN"}
      </button>

      <Dialog open={open} onClose={() => setOpen(false)} title="PAN">
        <div className="space-y-3">
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="panNumber">PAN</Label>
            <Input
              id="panNumber"
              placeholder="ABCDE1234F"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="font-mono uppercase"
            />
            <p className="text-xs text-subtle">Bank accounts are kept in their own list on this page.</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={handleSave} disabled={isPending}>
              {isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
