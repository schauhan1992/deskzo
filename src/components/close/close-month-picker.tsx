"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Label, Select } from "@/components/ui/input";

/**
 * The month a close page is looking at, kept in the URL (`?month=2026-09`) so a notification's link
 * and the back button land on the same month. Other parameters (the tab) are kept.
 */
export function CloseMonthPicker({
  value,
  options,
  id = "close-month",
  label = "Month",
}: {
  value: string;
  options: { key: string; label: string }[];
  id?: string;
  label?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function pick(key: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("month", key);
    params.delete("task");
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select id={id} value={value} onChange={(e) => pick(e.target.value)} className="w-full sm:w-56">
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
