"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { useComboboxKeyboard } from "@/components/ui/use-combobox-keyboard";
import { cn } from "@/lib/utils";

export type ComboOption = { id: string; name: string; hint?: string };

const MAX_RESULTS = 8;

/**
 * Type-to-search picker for a plain named list — a brand out of a thousand, say.
 *
 * The same shape as `PersonCombobox` and `CompanyCombobox` (portalled panel, shared keyboard
 * handling, typing over a choice un-chooses it) without the avatars and addresses that belong to
 * people. A native `<select>` of a thousand options is a scroll through the alphabet for a name
 * somebody already knows how to spell.
 */
export function OptionCombobox({
  options,
  value,
  onSelect,
  listLabel,
  placeholder = "Search…",
  emptyText = "Nothing matches that.",
  disabled = false,
  id,
}: {
  options: ComboOption[];
  value: string;
  onSelect: (option: ComboOption | null) => void;
  /** Names the listbox, e.g. "Brands". */
  listLabel: string;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  id?: string;
}) {
  const [query, setQuery] = useState(() => options.find((o) => o.id === value)?.name ?? "");
  const [syncedValue, setSyncedValue] = useState(value);
  const [isOpen, setIsOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  // Kept in step when `value` is changed from outside — adjusted during render, as the other pickers do.
  if (value !== syncedValue) {
    setSyncedValue(value);
    setQuery(options.find((o) => o.id === value)?.name ?? "");
  }

  useEffect(() => {
    if (!isOpen) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (anchorRef.current?.contains(target)) return;
      if (target.closest?.("[data-option-combobox-panel]")) return;
      setIsOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [isOpen]);

  const trimmed = query.trim().toLowerCase();
  // Names that start with what was typed first — "dell" should offer Dell before Wendell Audio.
  const matches = trimmed
    ? options
        .filter((o) => o.name.toLowerCase().includes(trimmed))
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(trimmed)) - Number(!b.name.toLowerCase().startsWith(trimmed)))
    : options;
  const results = matches.slice(0, MAX_RESULTS);
  const hidden = matches.length - results.length;

  function choose(option: ComboOption) {
    setSyncedValue(option.id);
    onSelect(option);
    setQuery(option.name);
    setIsOpen(false);
  }

  const combobox = useComboboxKeyboard({
    label: listLabel,
    optionCount: results.length,
    isOpen,
    setOpen: setIsOpen,
    onChoose: (index) => {
      const option = results[index];
      if (option) choose(option);
    },
    resetKey: results.map((o) => o.id).join(","),
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
          // Typing over a chosen name un-chooses it, so the text and the value never disagree.
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
        aria-label={id ? undefined : placeholder}
        {...combobox.comboboxProps}
      />

      <AnchoredPopover anchorRef={anchorRef} open={isOpen && !disabled} maxHeight={300}>
        <div data-option-combobox-panel className="py-1" {...combobox.listboxProps}>
          {results.map((o, index) => (
            <button
              key={o.id}
              type="button"
              onClick={() => choose(o)}
              {...combobox.optionProps(index)}
              className={cn(
                "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-sunken",
                combobox.activeIndex === index && "bg-surface-sunken",
              )}
            >
              <span className="truncate text-text">{o.name}</span>
              {o.hint && <span className="shrink-0 text-xs text-subtle">{o.hint}</span>}
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
