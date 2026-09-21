"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { useComboboxKeyboard } from "@/components/ui/use-combobox-keyboard";
import { cn } from "@/lib/utils";

/**
 * Pick a transporter by typing, not by scrolling.
 *
 * The plain dropdown this replaces was fine with five couriers and useless with fifty, and a
 * despatch clerk knows the name before they know where it sits in an alphabetical list. Same shape
 * as `ItemCombobox` deliberately — a second pattern for the same job is how two of them end up
 * behaving differently — and the same shared `useComboboxKeyboard` for the keys.
 */

export type TransporterOption = {
  id: string;
  name: string;
  gstin: string | null;
  defaultMode?: string;
};

const MAX_RESULTS = 20;

export function TransporterCombobox({
  transporters,
  value,
  onSelect,
  placeholder = "Type to search transporters…",
  id,
}: {
  transporters: TransporterOption[];
  value: string;
  onSelect: (transporter: TransporterOption | null) => void;
  placeholder?: string;
  id?: string;
}) {
  const [query, setQuery] = useState(() => transporters.find((t) => t.id === value)?.name ?? "");
  const [syncedValue, setSyncedValue] = useState(value);
  const [isOpen, setIsOpen] = useState(false);

  // Kept in step when `value` is changed from outside — during render rather than in an effect,
  // per React's guidance, to avoid an extra pass.
  if (value !== syncedValue) {
    setSyncedValue(value);
    setQuery(transporters.find((t) => t.id === value)?.name ?? "");
  }

  const trimmed = query.trim().toLowerCase();
  const results = (
    trimmed
      ? transporters.filter(
          (t) => t.name.toLowerCase().includes(trimmed) || (t.gstin ?? "").toLowerCase().includes(trimmed),
        )
      : transporters
  ).slice(0, MAX_RESULTS);

  // Lifted out of the row's `onClick` so the mouse and the keyboard go through the same path —
  // two copies of "what choosing means" is how they drift apart.
  function choose(transporter: TransporterOption) {
    setSyncedValue(transporter.id);
    onSelect(transporter);
    setQuery(transporter.name);
    setIsOpen(false);
  }

  const combobox = useComboboxKeyboard({
    label: "Transporters",
    optionCount: results.length,
    isOpen,
    setOpen: setIsOpen,
    onChoose: (index) => {
      const transporter = results[index];
      if (transporter) choose(transporter);
    },
    // Keyed on the rows rather than the query: `transporters` can change under a steady query.
    resetKey: results.map((t) => t.id).join(","),
  });

  return (
    <div className="relative">
      <Input
        id={id}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIsOpen(true);
          if (value) {
            setSyncedValue("");
            onSelect(null);
          }
        }}
        onFocus={() => setIsOpen(true)}
        onBlur={() => setTimeout(() => setIsOpen(false), 150)}
        placeholder={placeholder}
        autoComplete="off"
        // Only when there is no `id` for a visible label to point at — an `aria-label` beats a
        // native label, so supplying one unconditionally would throw away the better name.
        aria-label={id ? undefined : placeholder}
        {...combobox.comboboxProps}
      />
      {isOpen && (
        <div
          // Keeping mousedown off the document stops the field blurring before a click on a row
          // registers — which is also why focus never has to leave the field for the keyboard.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-line bg-surface py-1 shadow-lg"
          {...combobox.listboxProps}
        >
          {results.map((t, index) => (
            <button
              key={t.id}
              type="button"
              onClick={() => choose(t)}
              {...combobox.optionProps(index)}
              className={cn(
                "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-sunken",
                // Same tint the mouse gets, so there is one highlight rather than two.
                combobox.activeIndex === index && "bg-surface-sunken",
              )}
            >
              <span className="font-medium text-text">{t.name}</span>
              {/*
                The GSTIN is shown because it is the thing that decides whether a bill can be raised
                before the lorry is known — picking the carrier without one is a choice, and it
                should be a visible one.
              */}
              <span className="shrink-0 font-mono text-xs text-subtle">{t.gstin ?? "no GSTIN"}</span>
            </button>
          ))}
          {results.length === 0 && (
            <div className="px-3 py-2 text-sm text-subtle">
              No matching transporter. Add them under IT Assets → Transporters.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
