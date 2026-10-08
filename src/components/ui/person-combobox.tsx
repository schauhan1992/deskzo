"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { AnchoredPopover, insideAnchoredPopover } from "@/components/ui/anchored-popover";
import { useComboboxKeyboard } from "@/components/ui/use-combobox-keyboard";
import { cn } from "@/lib/utils";

export type PersonOption = {
  id: string;
  name: string;
  /** Matched on as well as shown. Two people called Priya Sharma are told apart by this, not by the name. */
  email?: string | null;
  photoUpdatedAt?: Date | string | null;
  /** A team rather than a person. Drawn without an avatar, because it is not one face. */
  isGroup?: boolean;
  hint?: string;
};

/**
 * Type-to-search picker for people, and for the teams that sit beside them in the same list.
 *
 * A native dropdown of a hundred colleagues is a scroll for a name you already know, and worse on a
 * phone. This is the same shape as `CompanyCombobox` — including the portalled panel, which exists
 * because these get used inside dialogs and scrollable panels where an absolutely-positioned list
 * is clipped by the nearest scrolling ancestor, and including the keyboard handling, which comes
 * from the shared `useComboboxKeyboard`.
 *
 * Matching runs over the address as well as the name. Somebody looking for a colleague usually has
 * their email to hand and not the exact spelling of their name, and two people who share a name are
 * only distinguishable by it.
 */
const MAX_RESULTS = 8;

export function PersonCombobox({
  people,
  value,
  onSelect,
  placeholder = "Search by name or email…",
  emptyText = "Nobody matches that.",
  disabled = false,
  id,
  autoHighlightFirst = false,
}: {
  people: PersonOption[];
  value: string;
  onSelect: (person: PersonOption | null) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  id?: string;
  /**
   * For a picker inside a form: Enter takes the top match instead of submitting the form, which would
   * otherwise go with the name typed and nobody picked; see `useComboboxKeyboard`. `"typed"` waits
   * until something is typed, so Enter on an empty field still submits rather than picking whoever
   * sorts first. Off by default, where Enter keeps its old meaning.
   */
  autoHighlightFirst?: boolean | "typed";
}) {
  const [query, setQuery] = useState(() => people.find((p) => p.id === value)?.name ?? "");
  const [syncedValue, setSyncedValue] = useState(value);
  const [isOpen, setIsOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  // Kept in step when `value` is changed from outside — adjusted during render, per React's
  // guidance, rather than in an effect.
  if (value !== syncedValue) {
    setSyncedValue(value);
    setQuery(people.find((p) => p.id === value)?.name ?? "");
  }

  useEffect(() => {
    if (!isOpen) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (anchorRef.current?.contains(target)) return;
      if (target.closest?.("[data-person-combobox-panel]") || insideAnchoredPopover(target)) return;
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

  const trimmed = query.trim().toLowerCase();
  const matches = trimmed
    ? people.filter(
        (p) => p.name.toLowerCase().includes(trimmed) || (p.email ?? "").toLowerCase().includes(trimmed),
      )
    : people;
  const results = matches.slice(0, MAX_RESULTS);
  const hidden = matches.length - results.length;

  function choose(person: PersonOption) {
    setSyncedValue(person.id);
    onSelect(person);
    setQuery(person.name);
    setIsOpen(false);
  }

  const combobox = useComboboxKeyboard({
    label: "People",
    optionCount: results.length,
    isOpen,
    setOpen: setIsOpen,
    onChoose: (index) => {
      const person = results[index];
      if (person) choose(person);
    },
    // Keyed on the rows rather than the query: `people` can change under a steady query.
    resetKey: results.map((p) => p.id).join(","),
    // Only while nobody is picked: a chosen name in the field should let Enter submit, not re-pick.
    autoHighlightFirst: !value && (autoHighlightFirst === true || (autoHighlightFirst === "typed" && trimmed !== "")),
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
          // Typing over a chosen name un-chooses it. Leaving the id set while the text no longer
          // matches it is how somebody shares a password with the wrong person.
          if (value) {
            setSyncedValue("");
            onSelect(null);
          }
        }}
        onFocus={() => setIsOpen(true)}
        placeholder={placeholder}
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        // Only when there is no `id` for a visible label to point at — an `aria-label` would win
        // over that label and replace a better name with a worse one. See `CompanyCombobox`.
        aria-label={id ? undefined : placeholder}
        {...combobox.comboboxProps}
      />

      <AnchoredPopover anchorRef={anchorRef} open={isOpen && !disabled} maxHeight={300}>
        {/* The panel is the listbox; the two status lines under the results are not options. */}
        <div data-person-combobox-panel className="py-1" {...combobox.listboxProps}>
          {results.map((p, index) => (
            <button
              key={p.id}
              type="button"
              onClick={() => choose(p)}
              {...combobox.optionProps(index)}
              className={cn(
                "flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-sunken",
                // Same tint the mouse gets, so there is one highlight rather than two.
                combobox.activeIndex === index && "bg-surface-sunken",
              )}
            >
              {p.isGroup ? (
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-sunken text-[11px] font-semibold text-muted">
                  {p.name.slice(0, 2).toUpperCase()}
                </span>
              ) : (
                <Avatar size="sm" user={{ id: p.id, name: p.name, photoUpdatedAt: p.photoUpdatedAt }} />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-text">
                  {p.name}
                  {p.hint && <span className="ml-1.5 text-xs text-subtle">{p.hint}</span>}
                </span>
                {p.email && <span className="block truncate text-xs text-subtle">{p.email}</span>}
              </span>
            </button>
          ))}
          {results.length === 0 && <div className="px-3 py-2 text-sm text-subtle">{emptyText}</div>}
          {hidden > 0 && (
            <div className="border-t border-line px-3 py-1.5 text-xs text-subtle">
              {hidden} more — keep typing to narrow it down.
            </div>
          )}
        </div>
      </AnchoredPopover>
    </div>
  );
}
