"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { chargeMsmeInterest } from "@/actions/payment-collection";
import { Button } from "@/components/ui/button";

/** Drafts a debit note for a late invoice's MSMED Act interest (src/lib/collect/charge.ts) and opens it to check. */
export function ChargeInterestButton({ invoiceId }: { invoiceId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await chargeMsmeInterest(invoiceId);
            if (!result.ok) return setError(result.error);
            router.push(`/documents/${result.data.id}`);
          });
        }}
      >
        {pending ? "Drafting…" : "Charge"}
      </Button>
      {error && <span role="alert" className="max-w-56 text-right text-xs text-danger">{error}</span>}
    </span>
  );
}
