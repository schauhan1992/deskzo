"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/card";
import { useComboboxKeyboard } from "@/components/ui/use-combobox-keyboard";
import { cn, formatCurrency } from "@/lib/utils";

export type ItemComboOption = {
  id: string;
  name: string;
  sku: string;
  type: string;
  unit: string | null;
  sellingPrice: unknown;
};

const MAX_RESULTS = 20;

function displayLabel(item: ItemComboOption) {
  return `${item.name} (${item.sku})`;
}

export function ItemCombobox({
  items,
  value,
  onSelect,
  showPrice = false,
  placeholder = "Type to search products…",
}: {
  items: ItemComboOption[];
  value: string;
  onSelect: (item: ItemComboOption | null) => void;
  showPrice?: boolean;
  placeholder?: string;
}) {
  const [query, setQuery] = useState(() => {
    const selected = items.find((i) => i.id === value);
    return selected ? displayLabel(selected) : "";
  });
  const [syncedValue, setSyncedValue] = useState(value);
  const [isOpen, setIsOpen] = useState(false);

  // Keep the displayed text in sync when `value` changes from outside (e.g. a form
  // reset after a successful submit) — adjusted during render rather than in an
  // effect, per React's guidance, to avoid an extra render pass.
  if (value !== syncedValue) {
    setSyncedValue(value);
    const selected = items.find((i) => i.id === value);
    setQuery(selected ? displayLabel(selected) : "");
  }

  const trimmed = query.trim().toLowerCase();
  const results = trimmed
    ? items
        .filter((i) => i.name.toLowerCase().includes(trimmed) || i.sku.toLowerCase().includes(trimmed))
        .slice(0, MAX_RESULTS)
    : items.slice(0, MAX_RESULTS);

  function handleSelect(item: ItemComboOption) {
    setSyncedValue(item.id);
    onSelect(item);
    setQuery(displayLabel(item));
    setIsOpen(false);
  }

  const combobox = useComboboxKeyboard({
    label: "Products",
    optionCount: results.length,
    isOpen,
    setOpen: setIsOpen,
    onChoose: (index) => {
      const item = results[index];
      if (item) handleSelect(item);
    },
    // Keyed on the rows rather than the query: `items` can change under a steady query.
    resetKey: results.map((i) => i.id).join(","),
  });

  return (
    <div className="relative">
      <Input
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
        // This one takes no `id`, so there is no visible label for it to be paired with and no
        // better name to lose to. The placeholder is what the field says it is.
        aria-label={placeholder}
        {...combobox.comboboxProps}
      />
      {isOpen && (
        <div
          // Keeping mousedown off the document stops the field blurring before a click on a row
          // registers — which is also why focus never has to leave the field for the keyboard.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-line bg-surface py-1 shadow-lg"
          {...combobox.listboxProps}
        >
          {results.map((item, index) => (
            <button
              key={item.id}
              type="button"
              onClick={() => handleSelect(item)}
              {...combobox.optionProps(index)}
              className={cn(
                "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-sunken",
                // Same tint the mouse gets, so there is one highlight rather than two.
                combobox.activeIndex === index && "bg-surface-sunken",
              )}
            >
              <span className="min-w-0">
                <span className="font-medium text-text">{item.name}</span>{" "}
                <span className="text-subtle">{item.sku}</span>
                <Badge className="ml-2">{item.type}</Badge>
              </span>
              {showPrice && (
                <span className="shrink-0 text-muted">{formatCurrency(String(item.sellingPrice))}</span>
              )}
            </button>
          ))}
          {results.length === 0 && <div className="px-3 py-2 text-sm text-subtle">No matching products.</div>}
          {items.length > MAX_RESULTS && results.length === MAX_RESULTS && (
            <div className="border-t border-line px-3 py-1.5 text-xs text-subtle">
              Showing first {MAX_RESULTS} matches — keep typing to narrow down.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
