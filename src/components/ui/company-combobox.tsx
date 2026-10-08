"use client";

import { useEffect, useRef, useState } from "react";
import type { CompanyRelationshipType } from "@prisma/client";
import { Input } from "@/components/ui/input";
import { AnchoredPopover, insideAnchoredPopover } from "@/components/ui/anchored-popover";
import { useComboboxKeyboard, useComboboxSearch } from "@/components/ui/use-combobox-keyboard";
import { cn } from "@/lib/utils";
import { offersCreate } from "@/lib/company-name";
import { CategoryChip } from "@/components/customers/category-chip";
import type { CategoryWithParent } from "@/lib/customers/categories";

export type CompanyComboOption = {
  id: string;
  name: string;
  relationshipType?: CompanyRelationshipType;
  /** Only the lead and ticket forms read these; every other caller can leave them off. */
  contacts?: { id: string; name: string; designation: string }[];
  /** Extra context shown beside the name in the list — "(reseller)", "(linked to this customer)". */
  hint?: string;
  /**
   * The customer's category, shown beside the name in the list and under the field once chosen — two
   * "Sharma Traders" are told apart before the wrong one is picked. Callers that don't load it lose
   * nothing but the chip.
   */
  customerCategory?: CategoryWithParent | null;
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
 *
 * With `search`, a book too long to send whole is looked up on the server once two characters are
 * typed (`useComboboxSearch`), and `companies` is only the first page, filtered for shorter queries
 * as before. Without it — and without `autoHighlightFirst` or the aria props — nothing here behaves
 * any differently.
 */
const MAX_RESULTS = 8;

/** The most a `search` lookup returns. A full page means there are probably more behind it. */
const SEARCH_LIMIT = 20;

export function CompanyCombobox({
  companies,
  value,
  onSelect,
  onCreateNew,
  placeholder = "Type to search companies…",
  disabled = false,
  id,
  search,
  autoHighlightFirst = false,
  inputRef,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
}: {
  companies: CompanyComboOption[];
  value: string;
  onSelect: (company: CompanyComboOption | null) => void;
  onCreateNew?: (query: string) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  /** Server lookup for two or more typed characters — at most `SEARCH_LIMIT` rows, ordered by name. */
  search?: (query: string) => Promise<CompanyComboOption[]>;
  /**
   * Enter takes the top match instead of submitting the form; see `useComboboxKeyboard`. `"typed"`
   * waits until something is typed — for an optional field inside a form, where Enter on an empty one
   * should still submit rather than fill it with whichever company sorts first.
   */
  autoHighlightFirst?: boolean | "typed";
  /** The text field itself, for a form that focuses its first invalid field (react-hook-form's `field.ref`). */
  inputRef?: React.Ref<HTMLInputElement>;
  /** A form's error for this field, wired to the text field as on a plain input (the order form's `invalidProps`). */
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  // The company last picked here. A search result is not in `companies`, so without this the chip
  // under the field — and the name, the next time `value` is set from outside — would have nothing
  // to come from. Only consulted in search mode, where every other caller never goes.
  const [picked, setPicked] = useState<CompanyComboOption | null>(null);
  const optionFor = (companyId: string) =>
    companies.find((c) => c.id === companyId) ?? (search && picked?.id === companyId ? picked : undefined);
  const [query, setQuery] = useState(() => optionFor(value)?.name ?? "");
  const [syncedValue, setSyncedValue] = useState(value);
  const [isOpen, setIsOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const selectedCategory = value ? (optionFor(value)?.customerCategory ?? null) : null;

  // Keep the displayed text in sync when `value` changes from outside (e.g. after creating a company
  // via the modal) — adjusted during render, per React's guidance, rather than in an effect.
  if (value !== syncedValue) {
    setSyncedValue(value);
    setQuery(optionFor(value)?.name ?? "");
  }

  // The list is portalled, so it isn't a descendant of the input any more — blur can't be relied on
  // to close it, and a click inside the panel must not count as "outside".
  useEffect(() => {
    if (!isOpen) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (anchorRef.current?.contains(target)) return;
      if (target.closest?.("[data-company-combobox-panel]") || insideAnchoredPopover(target)) return;
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
  // A chosen company's name sits in the field, so the list that opens on focus would otherwise send
  // that name off as a fresh search every time somebody clicks or tabs back in — a round trip that
  // can hold up the form's other lookups, since a page runs its server actions one at a time. Until
  // something is typed over it, the list answers from `companies`, with the choice itself at the top
  // when it came from an earlier search and is not in them.
  const chosen = value ? optionFor(value) : undefined;
  const showingChoice = chosen !== undefined && query === chosen.name;
  const server = useComboboxSearch({ search, query: showingChoice ? "" : trimmed, isOpen: isOpen && !disabled });
  const local = trimmed ? companies.filter((c) => c.name.toLowerCase().includes(trimmed.toLowerCase())) : companies;
  const matches = server.active
    ? server.options
    : showingChoice && !local.includes(chosen)
      ? [chosen, ...local]
      : local;
  const results = matches.slice(0, server.active ? SEARCH_LIMIT : MAX_RESULTS);
  const hiddenCount = matches.length - results.length;
  const searchCapped = server.active && server.options.length >= SEARCH_LIMIT;
  // No "create new" for a name already on the list — see `offersCreate`. A name that exists outside
  // this person's accounts is not on the list and still offers it; the dialog behind it says so
  // before anything is saved. In search mode the server's answer — or the remembered choice — is part
  // of "the list", and nothing is offered until it has answered.
  const canCreate =
    Boolean(onCreateNew) && !server.searching && offersCreate(trimmed, [...companies, ...matches].map((c) => c.name));

  function handleSelect(company: CompanyComboOption) {
    setSyncedValue(company.id);
    setPicked(company);
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
    // Only while nothing is picked, which is the state typing leaves the field in. Once a company is
    // chosen its name sits in the field and the list that opens on focus is that name's matches —
    // a highlight there would let Enter swap the chosen company for whichever match sorts first,
    // where a filled field should simply let Enter submit.
    autoHighlightFirst: !value && (autoHighlightFirst === true || (autoHighlightFirst === "typed" && trimmed !== "")),
  });

  return (
    <div ref={anchorRef}>
      <Input
        ref={inputRef}
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
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        className="aria-[invalid=true]:border-danger"
        {...combobox.comboboxProps}
      />

      <AnchoredPopover anchorRef={anchorRef} open={isOpen && !disabled} maxHeight={280}>
        {/*
          The panel itself is the listbox, so the rows keep the order they are drawn in. The status
          lines below are not options and sit between the results and the create row; moving them
          out would reorder what is on screen, which is the one thing this change must not do.
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
              <CategoryChip category={c.customerCategory} className="ml-1.5 align-middle" />
            </button>
          ))}
          {server.searching && <div className="px-3 py-2 text-sm text-subtle">Searching…</div>}
          {server.failed && <div className="px-3 py-2 text-sm text-danger">{"Couldn't search — try again"}</div>}
          {results.length === 0 && !server.searching && !server.failed && (
            <div className="px-3 py-2 text-sm text-subtle">No matching companies.</div>
          )}
          {hiddenCount > 0 && (
            <div className="border-t border-line px-3 py-1.5 text-xs text-subtle">
              {hiddenCount} more — keep typing to narrow it down.
            </div>
          )}
          {searchCapped && (
            <div className="border-t border-line px-3 py-1.5 text-xs text-subtle">
              {`Showing the first ${SEARCH_LIMIT} — keep typing`}
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
      {selectedCategory && (
        <div className="mt-1">
          <CategoryChip category={selectedCategory} />
        </div>
      )}
    </div>
  );
}
