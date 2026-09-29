"use client";

import { useId } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Select } from "@/components/ui/input";

/**
 * A month kept in the URL — "Sep 2026" on screen, `2026-09` in the address — so a roll-forward or a
 * filtered list is a link somebody can send. Changing it returns any list to its first page.
 *
 * A picker of months rather than a date input: revenue is recognised a month at a time, and a
 * browser's month input is missing or awkward on half the browsers people use.
 */
export function MonthParamSelect({
  paramName,
  label,
  options,
  value,
  emptyLabel,
  resetParams = ["page"],
}: {
  paramName: string;
  label: string;
  options: { value: string; label: string }[];
  /** What is chosen now (the page's default when the URL says nothing). */
  value: string;
  /** Offered as the first choice when the filter may be left open ("Any"). */
  emptyLabel?: string;
  resetParams?: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectId = useId();

  function set(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set(paramName, next);
    else params.delete(paramName);
    for (const key of resetParams) params.delete(key);
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <div className="flex items-center gap-2 text-sm">
      <label htmlFor={selectId} className="whitespace-nowrap text-muted">
        {label}
      </label>
      <Select id={selectId} value={value} onChange={(e) => set(e.target.value)} className="h-9 w-32">
        {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
