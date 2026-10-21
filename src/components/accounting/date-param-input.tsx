"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Input, Label } from "@/components/ui/input";

/**
 * A date that lives in the URL, so a report at a particular date is a link somebody can send. `fallback`:
 * the day the report shows when the URL names none, so the box says it rather than standing empty.
 */
export function DateParamInput({ paramName, label, fallback }: { paramName: string; label: string; fallback?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function set(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(paramName, value);
    else params.delete(paramName);
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={paramName} className="whitespace-nowrap text-sm text-muted">
        {label}
      </Label>
      <Input
        id={paramName}
        type="date"
        className="h-9 w-auto"
        defaultValue={searchParams.get(paramName) ?? fallback ?? ""}
        onChange={(e) => set(e.target.value)}
      />
    </div>
  );
}
