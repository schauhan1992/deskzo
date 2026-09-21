"use client";

import { useId } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * A filter that narrows a list, kept in the URL.
 *
 * Changing it returns to the first page. Without that, narrowing a list while standing on page 3
 * leaves the page number behind and shows an empty page 3 of a result that now has one page —
 * which reads as "no matches" and is how a working filter gets reported as broken.
 */
export function SelectParamFilter({
  paramName,
  label,
  allLabel = "All",
  options,
  resetParams = ["page"],
}: {
  paramName: string;
  label?: string;
  allLabel?: string;
  options: { value: string; label: string }[];
  /**
   * The page numbers this filter invalidates. Named rather than guessed, because a screen showing
   * two paginated lists has two of them and resetting only one is worse than resetting neither.
   */
  resetParams?: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // `useId` rather than the param name: a screen can show two filters on the same param (one per
  // list), and a shared id would point both labels at whichever select rendered first.
  const selectId = useId();

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
      {/* Tied to the select, not merely sitting beside it: a caption looks identical and names
          nothing, and the pairing also makes the word itself a click target for the dropdown. */}
      {label && (
        <label htmlFor={selectId} className="text-muted">
          {label}
        </label>
      )}
      <select
        id={selectId}
        /* Four screens render this filter with no label at all, where the "All …" option is the
           only wording it has. Left off when there is a label, so the visible word stays the name
           rather than being shadowed by a second one. */
        aria-label={label ? undefined : allLabel}
        value={searchParams.get(paramName) ?? ""}
        onChange={(e) => handleChange(e.target.value)}
        className="h-8 rounded-md border border-line-strong px-2 text-sm"
      >
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
