"use client";

import { useId } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PersonCombobox, type PersonOption } from "@/components/ui/person-combobox";

/**
 * Filter a list by a person, chosen by typing their name or address.
 *
 * A dropdown would do for five colleagues and not for a hundred, which is the case this exists
 * for. Like the other filters, the choice lives in the URL so a filtered list survives a reload,
 * and choosing one returns to the first page — a filter that leaves the page number behind shows an
 * empty page of a result that now has one, which reads as "no matches".
 */
export function PersonParamFilter({
  paramName,
  people,
  placeholder = "Any owner",
  label,
  resetParams = ["page"],
  className,
}: {
  paramName: string;
  people: PersonOption[];
  placeholder?: string;
  /**
   * What the box is called, read before every interaction. Defaults to the placeholder, which is
   * the wording each screen already chose for this filter.
   */
  label?: string;
  resetParams?: string[];
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get(paramName) ?? "";
  // `useId` rather than the param name: two of these can sit on one screen, and a shared id would
  // point both labels at whichever field rendered first.
  const inputId = useId();

  function choose(id: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (id) params.set(paramName, id);
    else params.delete(paramName);
    for (const key of resetParams) params.delete(key);
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <div className={className ?? "w-56"}>
      {/* Named through a label element rather than `aria-label` because `PersonCombobox` takes an
          `id` and not an aria attribute — the id lands on the field it renders, so this pairs with
          the real control. `sr-only` keeps the toolbar looking exactly as it did; the placeholder
          it repeats is gone from the screen as soon as somebody types. */}
      <label htmlFor={inputId} className="sr-only">
        {label ?? placeholder}
      </label>
      <PersonCombobox
        id={inputId}
        people={people}
        value={current}
        onSelect={(person) => choose(person?.id ?? "")}
        placeholder={placeholder}
        emptyText="Nobody matches that."
      />
    </div>
  );
}
