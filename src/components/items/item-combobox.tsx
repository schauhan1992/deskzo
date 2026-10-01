"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/card";
import { useComboboxKeyboard, useComboboxSearch } from "@/components/ui/use-combobox-keyboard";
import { cn, formatCurrency } from "@/lib/utils";

export type ItemComboOption = {
  id: string;
  name: string;
  sku: string;
  type: string;
  unit: string | null;
  sellingPrice: unknown;
  taxRatePercent?: unknown;
};

/** Rows shown at once — and the most a `search` lookup returns, so a full page means "keep typing". */
const MAX_RESULTS = 20;

function displayLabel(item: ItemComboOption) {
  return `${item.name} (${item.sku})`;
}

/**
 * Type-to-search product picker. Keyboard operation lives in `useComboboxKeyboard`; read the note
 * there before changing anything to do with focus.
 *
 * With `search`, a catalogue too long to send whole is looked up on the server once two characters
 * are typed (`useComboboxSearch`), and `items` is only the first page, filtered for shorter queries
 * as before. Without it nothing here behaves any differently.
 */
export function ItemCombobox({
  items,
  value,
  onSelect,
  showPrice = false,
  placeholder = "Type to search products…",
  ariaLabel,
  id,
  search,
  autoHighlightFirst = false,
  inputRef,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
}: {
  items: ItemComboOption[];
  value: string;
  onSelect: (item: ItemComboOption | null) => void;
  showPrice?: boolean;
  placeholder?: string;
  /** For a list of these — "Product 2" tells one row from the next where the placeholder cannot. */
  ariaLabel?: string;
  /** For a visible `<Label htmlFor>` to point at, which then names the field. */
  id?: string;
  /** Server lookup for two or more typed characters — at most `MAX_RESULTS` rows, ordered by name. */
  search?: (query: string) => Promise<ItemComboOption[]>;
  /** Enter takes the top match instead of submitting the form; see `useComboboxKeyboard`. */
  autoHighlightFirst?: boolean;
  /** The text field itself, for a form that focuses its first invalid field (react-hook-form's `field.ref`). */
  inputRef?: React.Ref<HTMLInputElement>;
  /** A form's error for this field, wired to the text field as on a plain input (the order form's `invalidProps`). */
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  // The product last picked here. A search result is not in `items`, so without this the field
  // would have no name to show the next time `value` is set from outside. Only consulted in search
  // mode, where every other caller never goes.
  const [picked, setPicked] = useState<ItemComboOption | null>(null);
  const optionFor = (itemId: string) =>
    items.find((i) => i.id === itemId) ?? (search && picked?.id === itemId ? picked : undefined);
  const [query, setQuery] = useState(() => {
    const selected = optionFor(value);
    return selected ? displayLabel(selected) : "";
  });
  const [syncedValue, setSyncedValue] = useState(value);
  const [isOpen, setIsOpen] = useState(false);

  // Keep the displayed text in sync when `value` changes from outside (e.g. a form
  // reset after a successful submit) — adjusted during render rather than in an
  // effect, per React's guidance, to avoid an extra render pass.
  if (value !== syncedValue) {
    setSyncedValue(value);
    const selected = optionFor(value);
    setQuery(selected ? displayLabel(selected) : "");
  }

  // A chosen product sits in the field as "Name (SKU)", which no search on name or SKU matches, so
  // tabbing back into a filled field is not worth a round trip to the server.
  const chosen = value ? optionFor(value) : undefined;
  const showingChoice = chosen !== undefined && query === displayLabel(chosen);
  const server = useComboboxSearch({ search, query: showingChoice ? "" : query.trim(), isOpen });
  const trimmed = query.trim().toLowerCase();
  const results = server.active
    ? server.options.slice(0, MAX_RESULTS)
    : trimmed
      ? items
          .filter((i) => i.name.toLowerCase().includes(trimmed) || i.sku.toLowerCase().includes(trimmed))
          .slice(0, MAX_RESULTS)
      : items.slice(0, MAX_RESULTS);
  const capped = server.active
    ? server.options.length >= MAX_RESULTS
    : items.length > MAX_RESULTS && results.length === MAX_RESULTS;

  function handleSelect(item: ItemComboOption) {
    setSyncedValue(item.id);
    setPicked(item);
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
    // Only while nothing is picked, which is the state typing leaves the field in. A chosen product
    // stays in the field as "Name (SKU)", and Enter there should submit rather than re-pick.
    autoHighlightFirst: autoHighlightFirst && !value,
  });

  return (
    <div className="relative">
      <Input
        ref={inputRef}
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
        // A caller that passes an `id` has a visible label pointing at it, and a native label loses
        // to `aria-label` — so the placeholder only steps in when there is no id to pair with. An
        // explicit `ariaLabel` is the caller's own choice and always applies.
        aria-label={ariaLabel ?? (id ? undefined : placeholder)}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        className="aria-[invalid=true]:border-danger"
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
          {server.searching && <div className="px-3 py-2 text-sm text-subtle">Searching…</div>}
          {server.failed && <div className="px-3 py-2 text-sm text-danger">{"Couldn't search — try again"}</div>}
          {results.length === 0 && !server.searching && !server.failed && (
            <div className="px-3 py-2 text-sm text-subtle">No matching products.</div>
          )}
          {capped && (
            <div className="border-t border-line px-3 py-1.5 text-xs text-subtle">
              Showing first {MAX_RESULTS} matches — keep typing to narrow down.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
