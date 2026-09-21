"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Landmark } from "lucide-react";
import { setPayoutDetails } from "@/actions/company";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";

type PayoutDetails = {
  panNumber: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankName: string | null;
};

export function PayoutDetailsButton({ companyId, details }: { companyId: string; details: PayoutDetails }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({
    panNumber: details.panNumber ?? "",
    bankAccountName: details.bankAccountName ?? "",
    bankAccountNumber: details.bankAccountNumber ?? "",
    bankIfsc: details.bankIfsc ?? "",
    bankName: details.bankName ?? "",
  });
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function openDialog() {
    setError(null);
    setValues({
      panNumber: details.panNumber ?? "",
      bankAccountName: details.bankAccountName ?? "",
      bankAccountNumber: details.bankAccountNumber ?? "",
      bankIfsc: details.bankIfsc ?? "",
      bankName: details.bankName ?? "",
    });
    setOpen(true);
  }

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const result = await setPayoutDetails(companyId, values);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  const hasDetails = Object.values(details).some(Boolean);

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="inline-flex items-center gap-1.5 rounded-full bg-surface-sunken px-2.5 py-0.5 text-xs font-medium text-text transition-colors hover:bg-line"
      >
        <Landmark className="h-3 w-3" />
        {hasDetails ? "Payout details set" : "Set payout details"}
      </button>

      <Dialog open={open} onClose={() => setOpen(false)} title="Payout details">
        <div className="space-y-3">
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="space-y-1.5">
            <Label htmlFor="panNumber">PAN</Label>
            <Input
              id="panNumber"
              placeholder="ABCDE1234F"
              value={values.panNumber}
              onChange={(e) => setValues((v) => ({ ...v, panNumber: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bankAccountName">Bank account holder name</Label>
            <Input
              id="bankAccountName"
              value={values.bankAccountName}
              onChange={(e) => setValues((v) => ({ ...v, bankAccountName: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bankAccountNumber">Bank account number</Label>
            <Input
              id="bankAccountNumber"
              value={values.bankAccountNumber}
              onChange={(e) => setValues((v) => ({ ...v, bankAccountNumber: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bankIfsc">IFSC</Label>
            <Input
              id="bankIfsc"
              placeholder="HDFC0001234"
              value={values.bankIfsc}
              onChange={(e) => setValues((v) => ({ ...v, bankIfsc: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bankName">Bank name</Label>
            <Input
              id="bankName"
              value={values.bankName}
              onChange={(e) => setValues((v) => ({ ...v, bankName: e.target.value }))}
            />
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
