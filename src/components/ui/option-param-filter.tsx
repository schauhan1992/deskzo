"use client";

import { useId } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { OptionCombobox, type ComboOption } from "@/components/ui/option-combobox";

/**
 * `SelectParamFilter` for a list too long to scroll — a thousand brands — kept in the URL the same
 * way, and returning to the first page on every change for the same reason.
 */
export function OptionParamFilter({
  paramName,
  label,
  listLabel,
  options,
  placeholder,
  resetParams = ["page"],
}: {
  paramName: string;
  label: string;
  listLabel: string;
  options: ComboOption[];
  placeholder?: string;
  resetParams?: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const inputId = useId();

  function handleChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(paramName, value);
    else params.delete(paramName);
    for (const key of resetParams) params.delete(key);
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <div className="flex items-center gap-2 text-sm">
      <label htmlFor={inputId} className="text-muted">
        {label}
      </label>
      <div className="w-60">
        <OptionCombobox
          id={inputId}
          listLabel={listLabel}
          options={options}
          value={searchParams.get(paramName) ?? ""}
          onSelect={(o) => handleChange(o?.id ?? "")}
          placeholder={placeholder ?? `All — type to search`}
        />
      </div>
    </div>
  );
}
