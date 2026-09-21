"use client";

import { useEffect, useRef, useState } from "react";
import type { CompanyRelationshipType } from "@prisma/client";
import { Input } from "@/components/ui/input";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { useComboboxKeyboard } from "@/components/ui/use-combobox-keyboard";
import { cn } from "@/lib/utils";

export type CompanyComboOption = {
  id: string;
  name: string;
  relationshipType?: CompanyRelationshipType;
  /** Only the lead and ticket forms read these; every other caller can leave them off. */
  contacts?: { id: string; name: string; designation: string }[];
  /** Extra context shown beside the name in the list — "(reseller)", "(linked to this customer)". */
  hint?: string;
};

/**
 * Type-to-search company picker. Used everywhere a company is chosen rather than a native dropdown,
 * because the lists are hundreds of records long — a plain select makes you scroll for a name you
 * already know, and on a phone it's worse.
 *
 * Keyboard operation lives in `useComboboxKeyboard`, shared with the other three pickers. Read the
 * note there before changing anything to do with focus: the highlight is `aria-activedescendant`
 * and focus stays in the field on purpose.
 *
 * The list renders through `AnchoredPopover` rather than as an absolutely-positioned child: this
 * gets used inside table rows and scrollable panels, and an absolute panel is clipped by the
 * nearest scrolling ancestor.
 *
 * Results are capped at `MAX_RESULTS`; the cap is stated in the list when it bites, so a missing
 * name reads as "keep typing" rather than "not in the system".
 */
const MAX_RESULTS = 8;

export function CompanyCombobox({
  companies,
  value,
  onSelect,
  onCreateNew,
  placeholder = "Type to search companies…",
  disabled = false,
  id,
}: {
  companies: CompanyComboOption[];
  value: string;
  onSelect: (company: CompanyComboOption | null) => void;
  onCreateNew?: (query: string) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
}) {
  const [query, setQuery] = useState(() => companies.find((c) => c.id === value)?.name ?? "");
  const [syncedValue, setSyncedValue] = useState(value);
  const [isOpen, setIsOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  // Keep the displayed text in sync when `value` changes from outside (e.g. after creating a company
  // via the modal) — adjusted during render, per React's guidance, rather than in an effect.
  if (value !== syncedValue) {
    setSyncedValue(value);
    setQuery(companies.find((c) => c.id === value)?.name ?? "");
  }

  // The list is portalled, so it isn't a descendant of the input any more — blur can't be relied on
  // to close it, and a click inside the panel must not count as "outside".
  useEffect(() => {
    if (!isOpen) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (anchorRef.current?.contains(target)) return;
      if (target.closest?.("[data-company-combobox-panel]")) return;
      setIsOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setIsOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen]);

  const trimmed = query.trim();
  const matches = trimmed
    ? companies.filter((c) => c.name.toLowerCase().includes(trimmed.toLowerCase()))
    : companies;
  const results = matches.slice(0, MAX_RESULTS);
  const hiddenCount = matches.length - results.length;
  const canCreate = Boolean(trimmed && onCreateNew);

  function handleSelect(company: CompanyComboOption) {
    setSyncedValue(company.id);
    onSelect(company);
    setQuery(company.name);
    setIsOpen(false);
  }

  // The "create new" row is the last thing in the list, so it counts as the last option and the
  // arrows reach it like any other. It is the only way to add a company from inside a form; leaving
  // it mouse-only would fix the list and keep the dead end.
  const combobox = useComboboxKeyboard({
    label: "Companies",
    optionCount: results.length + (canCreate ? 1 : 0),
    isOpen,
    setOpen: setIsOpen,
    onChoose: (index) => {
      const company = results[index];
      if (company) {
        handleSelect(company);
        return;
      }
      onCreateNew?.(trimmed);
      setIsOpen(false);
    },
    // The rows themselves, not just the query: `companies` can change under a steady query, and a
    // highlight on row 2 has to mean the row 2 that is on screen now.
    resetKey: results.map((c) => c.id).join(","),
  });

  return (
    <div ref={anchorRef}>
      <Input
        id={id}
        value={query}
        disabled={disabled}
        onChange={(e) => {
          setQuery(e.target.value);
          setIsOpen(true);
          if (value) {
            setSyncedValue("");
            onSelect(null);
          }
        }}
        onFocus={() => setIsOpen(true)}
        placeholder={placeholder}
        autoComplete="off"
        // Callers that pass an `id` have a visible label pointing at it, and that label is the more
        // useful name ("Bill to", "Vendor"). A native label loses to `aria-label`, so this only
        // steps in when there is no id to pair with and the field would otherwise be announced as
        // an unnamed combo box.
        aria-label={id ? undefined : placeholder}
        {...combobox.comboboxProps}
      />

      <AnchoredPopover anchorRef={anchorRef} open={isOpen && !disabled} maxHeight={280}>
        {/*
          The panel itself is the listbox, so the rows keep the order they are drawn in. The two
          status lines below are not options and sit between the results and the create row; moving
          them out would reorder what is on screen, which is the one thing this change must not do.
        */}
        <div data-company-combobox-panel className="py-1" {...combobox.listboxProps}>
          {results.map((c, index) => (
            <button
              key={c.id}
              type="button"
              onClick={() => handleSelect(c)}
              {...combobox.optionProps(index)}
              className={cn(
                "block w-full px-3 py-2 text-left text-sm text-text hover:bg-surface-sunken",
                // The keyboard highlight borrows the hover tint rather than inventing a second one.
                combobox.activeIndex === index && "bg-surface-sunken",
              )}
            >
              {c.name}
              {c.hint && <span className="ml-1.5 text-xs text-subtle">{c.hint}</span>}
            </button>
          ))}
          {results.length === 0 && <div className="px-3 py-2 text-sm text-subtle">No matching companies.</div>}
          {hiddenCount > 0 && (
            <div className="border-t border-line px-3 py-1.5 text-xs text-subtle">
              {hiddenCount} more — keep typing to narrow it down.
            </div>
          )}
          {canCreate && onCreateNew && (
            <button
              type="button"
              onClick={() => {
                onCreateNew(trimmed);
                setIsOpen(false);
              }}
              {...combobox.optionProps(results.length)}
              className={cn(
                "block w-full border-t border-line px-3 py-2 text-left text-sm font-medium text-text hover:bg-surface-sunken",
                combobox.activeIndex === results.length && "bg-surface-sunken",
              )}
            >
              + Create new company &ldquo;{trimmed}&rdquo;
            </button>
          )}
        </div>
      </AnchoredPopover>
    </div>
  );
}
