"use client";

import { useMemo, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { Input, Select } from "@/components/ui/input";

/**
 * Narrowing a report to particular things, before running it.
 *
 * The engine could always do this — `runReport` filters on any dimension and reports what it
 * dropped — but the only way to *set* a filter was to run a report and click a value in the result.
 * That answers "now show me only AutoCAD"; it does not answer "show me AutoCAD", which is the
 * question people actually arrive with. A product, a city, a date range, run.
 *
 * ## Two filter layers, and why they are not merged
 *
 * The panel above this one narrows **which accounts** are in scope, using the same vocabulary the
 * saved lists use. This one narrows **which records came back**, by any dimension of the source.
 * They read similarly and they are not interchangeable: "customers in Pune" and "orders delivered
 * to Pune" are different questions, and a single merged list would imply they were the same.
 *
 * ## Why the values are a fixed list rather than a text box
 *
 * Every option here came out of the rows this person is allowed to see, in this window. A free-text
 * box would let somebody type a brand name and learn from an empty result whether it exists on an
 * account they cannot see. A list cannot leak what it never contains.
 */

/** `custom`: one of the workspace's own fields (src/lib/analytics/custom.ts). */
export type DimensionOption = { key: string; label: string; custom?: boolean };

/**
 * A select's options: the source's own first, then the workspace's own fields under a heading of
 * their own. Listed in one run, a company's "Region" sits among the product's breakdowns as though
 * it were one of them, and a workspace with thirty fields buries "Salesperson" in the middle.
 */
export function GroupedOptions({ items }: { items: { key: string; label: string; custom?: boolean }[] }) {
  const yours = items.filter((i) => i.custom);
  return (
    <>
      {items
        .filter((i) => !i.custom)
        .map((i) => (
          <option key={i.key} value={i.key}>
            {i.label}
          </option>
        ))}
      {yours.length > 0 && (
        <optgroup label="Your fields">
          {yours.map((i) => (
            <option key={i.key} value={i.key}>
              {i.label}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
}

export function DimensionFilters({
  dimensions,
  values,
  counts,
  filters,
  loading,
  capped,
  onChange,
}: {
  dimensions: DimensionOption[];
  /** Dimension key → its values in the current window, capped. Empty until the options load. */
  values: Record<string, string[]>;
  /**
   * How many values each dimension really has, which may exceed what `values` holds.
   *
   * Needed because the list alone cannot say whether it is the whole thing: at the cap its length is
   * exactly the cap, and the picker was printing that length as though it were the total —
   * "Search 300 customers…" is the most confident possible way to say "there are more than 300".
   */
  counts: Record<string, number>;
  filters: Record<string, string[]>;
  loading: boolean;
  /** The window hit the row ceiling, so these options come from a slice of it. */
  capped: boolean;
  onChange: (next: Record<string, string[]>) => void;
}) {
  /**
   * Which dimensions have a row on screen, as distinct from which have a value chosen.
   *
   * Kept separately so picking "Product" and then unticking everything leaves the list open to
   * choose again, rather than making the row vanish under the cursor.
   */
  const [open, setOpen] = useState<string[]>(() => Object.keys(filters));

  const shown = useMemo(
    () => dimensions.filter((d) => open.includes(d.key) || (filters[d.key]?.length ?? 0) > 0),
    [dimensions, open, filters],
  );
  const addable = dimensions.filter((d) => !shown.some((s) => s.key === d.key));

  function toggle(key: string, value: string) {
    const current = filters[key] ?? [];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    const out = { ...filters, [key]: next };
    if (next.length === 0) delete out[key];
    // A dimension can reach `filters` without ever passing through the select below: clicking a
    // value in the result table sets one from the parent, while this panel is already mounted and
    // `open` was seeded long before. Recording it here is what makes the promise above true for
    // those rows too — otherwise unticking their last value deletes the key and the card goes with
    // it, which is the one thing `open` exists to prevent.
    setOpen((prev) => (prev.includes(key) ? prev : [...prev, key]));
    onChange(out);
  }

  function remove(key: string) {
    setOpen((prev) => prev.filter((k) => k !== key));
    const out = { ...filters };
    delete out[key];
    onChange(out);
  }

  return (
    <div className="space-y-3">
      {shown.map((d) => (
        <ValuePicker
          key={d.key}
          dimension={d}
          options={values[d.key] ?? []}
          total={counts[d.key] ?? (values[d.key]?.length ?? 0)}
          chosen={filters[d.key] ?? []}
          loading={loading}
          onToggle={(v) => toggle(d.key, v)}
          onRemove={() => remove(d.key)}
        />
      ))}

      {addable.length > 0 && (
        <div className="flex items-center gap-2">
          <Plus className="h-3.5 w-3.5 shrink-0 text-subtle" />
          <Select
            aria-label="Add a filter"
            value=""
            onChange={(e) => {
              if (e.target.value) setOpen((prev) => [...prev, e.target.value]);
            }}
            className="h-8 w-56 text-xs"
          >
            <option value="">Narrow by…</option>
            <GroupedOptions items={addable} />
          </Select>
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-subtle" />}
        </div>
      )}

      {capped && shown.length > 0 && (
        <p className="text-xs text-warning">
          This window hits the row ceiling, so these lists come from part of it. A value that only
          appears outside that part will not be offered — narrow the dates to see everything.
        </p>
      )}
    </div>
  );
}

/** How many values to render before asking somebody to search instead of scroll. */
const VISIBLE = 80;

function ValuePicker({
  dimension,
  options,
  total,
  chosen,
  loading,
  onToggle,
  onRemove,
}: {
  dimension: DimensionOption;
  options: string[];
  /** How many values the dimension has in this window — `options` is capped, this is not. */
  total: number;
  chosen: string[];
  loading: boolean;
  onToggle: (value: string) => void;
  onRemove: () => void;
}) {
  const [query, setQuery] = useState("");

  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
  }, [options, query]);

  /**
   * Chosen values are pinned to the top, whatever the search says.
   *
   * Without this, typing narrows the list past something already ticked and it looks unticked —
   * so people tick it again, and the filter quietly loses a value they thought they had.
   *
   * Every chosen value, not only the ones the query excluded. With the box empty the query excludes
   * nothing, so that narrower reading pinned nothing at all — and a ticked value sitting past the
   * render cap below was cut by the slice while the header went on counting it.
   */
  const ordered = useMemo(
    () => [...chosen, ...matching.filter((m) => !chosen.includes(m))],
    [chosen, matching],
  );

  /**
   * How long that list is with nothing typed, which is what decides whether a search box is worth
   * offering.
   *
   * Deliberately not `ordered.length`: that shrinks as somebody types, so gating the box on it
   * would pull the box out from under the cursor the moment a query narrowed the list past the cap,
   * leaving no way to clear the query. It is still never smaller than `ordered.length`, so the
   * "search to narrow" note below cannot appear without a box to search in — which it could when
   * this was gated on `options.length` and a chosen value absent from the options pushed the list
   * one past the cap.
   */
  const listLength = useMemo(
    () => chosen.length + options.filter((o) => !chosen.includes(o)).length,
    [chosen, options],
  );

  /**
   * How many values exist that were never sent, and so cannot be found by typing.
   *
   * Clamped at zero because the two numbers are counted in different places: `total` comes from the
   * rows the server saw, `listLength` also counts anything already ticked. A value ticked in a wider
   * window and still ticked in this one sits in the second and not the first, and a negative
   * shortfall would be a worse lie than the one this exists to stop.
   */
  const withheld = Math.max(0, total - listLength);

  return (
    <div className="rounded-base border border-line">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <span className="text-xs font-medium text-text">
          {dimension.label}
          {chosen.length > 0 && <span className="ml-1.5 font-normal text-muted">{chosen.length} chosen</span>}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Stop filtering by ${dimension.label}`}
          className="text-subtle hover:text-text"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-2 p-3">
        {listLength > VISIBLE && (
          <Input
            aria-label={`Search ${dimension.label.toLowerCase()}`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              withheld > 0
                ? `Search ${listLength.toLocaleString("en-IN")} of ${(listLength + withheld).toLocaleString("en-IN")} ${dimension.label.toLowerCase()}…`
                : `Search ${listLength.toLocaleString("en-IN")} ${dimension.label.toLowerCase()}…`
            }
            className="h-8 text-xs"
          />
        )}

        {loading && options.length === 0 && <p className="text-xs text-subtle">Finding the options…</p>}

        {!loading && options.length === 0 && (
          <p className="text-xs text-subtle">Nothing to choose from in this date range.</p>
        )}

        {ordered.length > 0 && (
          <div className="max-h-52 space-y-0.5 overflow-y-auto">
            {ordered.slice(0, VISIBLE).map((value) => (
              <label key={value} className="flex cursor-pointer items-center gap-2 rounded-base px-1 py-0.5 text-xs text-text hover:bg-surface-sunken">
                <input
                  type="checkbox"
                  checked={chosen.includes(value)}
                  onChange={() => onToggle(value)}
                  className="h-3.5 w-3.5 cursor-pointer rounded-sm accent-[var(--brand)]"
                />
                <span className="truncate">{value}</span>
              </label>
            ))}
          </div>
        )}

        {ordered.length > VISIBLE && (
          <p className="text-xs text-subtle">
            {(ordered.length - VISIBLE).toLocaleString("en-IN")} more — search to narrow the list.
          </p>
        )}

        {/* A different shortfall from the one above, and the advice above is exactly wrong for it:
            these values were never sent, so typing cannot reach them. Without this the list is
            indistinguishable from a complete one, and a customer missing from it reads as a customer
            with no sales. */}
        {withheld > 0 && (
          <p className="text-xs text-warning">
            {withheld.toLocaleString("en-IN")} further {dimension.label.toLowerCase()} in this window are not
            listed, and searching will not reach them. Narrow the dates, or filter on something else first.
          </p>
        )}
      </div>
    </div>
  );
}
