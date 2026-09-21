"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { VendorStatus } from "@prisma/client";
import { setVendorStatus } from "@/actions/company";
import { vendorStatusValues, vendorStatusLabels } from "@/lib/validation/company";
import { Select } from "@/components/ui/input";

export function VendorStatusControl({ companyId, status }: { companyId: string; status: VendorStatus }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleChange(next: VendorStatus) {
    setError(null);
    startTransition(async () => {
      const result = await setVendorStatus(companyId, next);
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
        aria-label="Vendor status"
        value={status}
        disabled={isPending}
        onChange={(e) => handleChange(e.target.value as VendorStatus)}
        className="h-7 w-36 text-xs"
      >
        {vendorStatusValues.map((s) => (
          <option key={s} value={s}>
            {vendorStatusLabels[s]}
          </option>
        ))}
      </Select>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
