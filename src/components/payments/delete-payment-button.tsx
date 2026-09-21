"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deletePayment } from "@/actions/payment";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/utils";

export function DeletePaymentButton({ paymentId, amount, companyName }: { paymentId: string; amount: number; companyName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function confirmDelete() {
    startTransition(async () => {
      await deletePayment(paymentId);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-danger hover:bg-danger-bg hover:text-danger"
        onClick={() => setOpen(true)}
      >
        Delete
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Delete payment">
        <p className="text-sm text-muted">
          Delete the {formatCurrency(String(amount))} payment from <span className="font-medium text-text">{companyName}</span>?
          Any amounts already applied to orders will be un-applied too. This can&apos;t be undone.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button type="button" variant="danger" size="sm" onClick={confirmDelete} disabled={isPending}>
            {isPending ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
