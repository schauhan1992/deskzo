"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ListFilter } from "lucide-react";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import type { FilterField, FilterSetup } from "@/lib/custom-fields/filters";

type Draft = FilterField["current"];
export type Drafts = Record<string, Draft>;

const draftsFrom = (fields: FilterField[]): Drafts => Object.fromEntries(fields.map((f) => [f.key, f.current]));

/**
 * The query the panel's answers make of the URL as it stands: every field filter written afresh — one
 * for a field this person no longer sees goes too — the rest of the URL kept, and the page numbers
 * dropped. Its own function so check:custom-field-filters can read what it writes back with the
 * server's parser (src/lib/custom-fields/filters.ts `parseCustomFilters`).
 */
export function filterQuery(current: string, setup: Pick<FilterSetup, "fields" | "prefix">, drafts: Drafts, resetParams: string[] = ["page"]): string {
  const params = new URLSearchParams(current);
  for (const name of [...params.keys()]) if (name.startsWith(setup.prefix)) params.delete(name);
  for (const field of setup.fields) {
    const draft = drafts[field.key] ?? {};
    const put = (name: string | undefined, value: string | undefined) => {
      const text = value?.trim();
      if (name && text) params.set(name, text);
    };
    put(field.params.value, draft.values ? draft.values.join(",") : draft.value);
    put(field.params.from, draft.from);
    put(field.params.to, draft.to);
    put(field.params.min, draft.min);
    put(field.params.max, draft.max);
  }
  for (const key of resetParams) params.delete(key);
  return params.toString();
}

/**
 * Narrowing a list by the workspace's own fields: a "Fields" button in the list's toolbar, and a panel
 * with a control for each field this person sees — what the page worked out with
 * src/lib/custom-fields/filters.ts `customFilterSetup`, which also names the URL parameters each one is
 * written to. Nothing for a workspace without fields.
 *
 * Unlike the toolbar's own filters, nothing happens until Apply. A panel of several fields is filled
 * in and then applied; a list that reloaded at every tick and keystroke would rearrange itself under
 * the person still filling it in. Like them, the choice lives in the URL, and applying it returns to
 * the first page — a filter that leaves the page number behind shows an empty page 3 of a result that
 * now has one, which reads as "no matches".
 */
export function CustomFieldFilters({ setup, resetParams = ["page"] }: { setup: FilterSetup; resetParams?: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // `useId` for the controls' ids: a field key alone could repeat if a screen ever showed two lists.
  const uid = useId();
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Drafts>(() => draftsFrom(setup.fields));

  /**
   * Into the panel as it opens. It is portalled to the end of the page (AnchoredPopover), so without
   * this a keyboard user would have to tab past everything else on the screen to reach it.
   */
  const attachPanel = useCallback((el: HTMLDivElement | null) => {
    panelRef.current = el;
    if (el && !el.contains(document.activeElement)) el.querySelector<HTMLElement>("input, select")?.focus();
  }, []);

  // Escape closes it, back to the button; so does a click anywhere but the panel and its button. Not
  // a mouse leaving it, as the column picker closes: this one is typed into.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      anchorRef.current?.focus();
    }
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node | null;
      if (target && (panelRef.current?.contains(target) || anchorRef.current?.contains(target))) return;
      setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [open]);

  if (setup.fields.length === 0) return null;

  // Each time it opens, from what the URL asks now — not from a half-filled panel closed earlier.
  function openPanel() {
    setDrafts(draftsFrom(setup.fields));
    setOpen(true);
  }

  function go(next: Drafts) {
    const query = filterQuery(searchParams.toString(), setup, next, resetParams);
    router.push(query ? `${pathname}?${query}` : pathname);
    setOpen(false);
    anchorRef.current?.focus();
  }

  function clear() {
    setDrafts({});
    if (setup.active > 0) go({});
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openPanel())}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line-strong px-2.5 text-sm font-medium text-muted hover:bg-surface-sunken hover:text-text"
      >
        <ListFilter className="h-3.5 w-3.5" />
        Fields
        {setup.active > 0 && (
          <span className="rounded-full bg-brand-subtle px-1.5 text-[11px] font-semibold text-brand">
            {setup.active}
            <span className="sr-only"> in use</span>
          </span>
        )}
      </button>

      {/* End-aligned, as the column picker beside it is: the popover keeps an end-aligned panel on
          screen, and this button sits towards the toolbar's right-hand end. */}
      <AnchoredPopover anchorRef={anchorRef} open={open} width={320} maxHeight={480} align="end">
        <div ref={attachPanel} role="dialog" aria-labelledby={`${uid}-title`}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              go(drafts);
            }}
          >
            <p id={`${uid}-title`} className="px-3 pt-3 text-xs font-semibold uppercase tracking-wide text-subtle">
              Filter by your fields
            </p>
            <div className="space-y-3 p-3">
              {setup.fields.map((field) => (
                <FieldControl
                  key={field.key}
                  field={field}
                  id={`${uid}-${field.key}`}
                  draft={drafts[field.key] ?? {}}
                  people={setup.people}
                  onChange={(draft) => setDrafts((prev) => ({ ...prev, [field.key]: draft }))}
                />
              ))}
            </div>
            {/* Kept in view however long the list of fields: the panel scrolls, these stay put. */}
            <div className="sticky bottom-0 flex justify-end gap-2 border-t border-line bg-surface px-3 py-2">
              <Button type="button" variant="ghost" size="sm" onClick={clear}>
                Clear
              </Button>
              <Button type="submit" size="sm">
                Apply
              </Button>
            </div>
          </form>
        </div>
      </AnchoredPopover>
    </>
  );
}

/** One field's control, as its type asks: choices to tick, yes or no, a person, words, or a range. */
function FieldControl({
  field,
  id,
  draft,
  people,
  onChange,
}: {
  field: FilterField;
  id: string;
  draft: Draft;
  people: FilterSetup["people"];
  onChange: (draft: Draft) => void;
}) {
  const legend = "text-[13px] font-medium text-muted";

  switch (field.type) {
    case "SELECT":
    case "MULTI_SELECT": {
      const chosen = draft.values ?? [];
      return (
        <fieldset className="space-y-1">
          <legend className={legend}>
            {field.label} <span className="font-normal text-subtle">· any of</span>
          </legend>
          <div className="max-h-36 space-y-1 overflow-y-auto">
            {field.options.map((o) => (
              <label key={o.value} className="flex items-center gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={chosen.includes(o.value)}
                  onChange={(e) => onChange({ values: e.target.checked ? [...chosen, o.value] : chosen.filter((v) => v !== o.value) })}
                />
                {o.label}
                {o.archived && <span className="text-xs text-subtle">(retired)</span>}
              </label>
            ))}
          </div>
        </fieldset>
      );
    }
    case "CHECKBOX":
      return (
        <div className="space-y-1">
          <Label htmlFor={id}>{field.label}</Label>
          <Select id={id} value={draft.value ?? ""} onChange={(e) => onChange({ value: e.target.value })} className="h-8">
            <option value="">Any</option>
            <option value="yes">Yes</option>
            {/* Never answered counts as no: the record's form shows it as a box nobody ticked. */}
            <option value="no">No</option>
          </Select>
        </div>
      );
    case "USER": {
      const current = draft.value ?? "";
      const known = people.some((p) => p.id === current);
      return (
        <div className="space-y-1">
          <Label htmlFor={id}>{field.label}</Label>
          <Select id={id} value={current} onChange={(e) => onChange({ value: e.target.value })} className="h-8">
            <option value="">Anyone</option>
            {current && !known && <option value={current}>Someone no longer here</option>}
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
      );
    }
    case "DATE":
    case "NUMBER":
    case "MONEY": {
      const dates = field.type === "DATE";
      const lowId = `${id}-low`;
      const highId = `${id}-high`;
      const low = (dates ? draft.from : draft.min) ?? "";
      const high = (dates ? draft.to : draft.max) ?? "";
      const set = (side: "low" | "high", value: string) =>
        onChange(
          dates
            ? { from: side === "low" ? value : draft.from, to: side === "high" ? value : draft.to }
            : { min: side === "low" ? value : draft.min, max: side === "high" ? value : draft.max },
        );
      const type = dates ? "date" : "number";
      const inputMode = dates ? undefined : "decimal";
      const step = dates ? undefined : field.type === "MONEY" ? "0.01" : "any";
      return (
        <fieldset className="space-y-1">
          <legend className={legend}>{field.label}</legend>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor={lowId} className="text-xs text-subtle">
                <span className="sr-only">{field.label}, </span>
                {dates ? "From" : "At least"}
              </label>
              <Input
                id={lowId}
                type={type}
                inputMode={inputMode}
                step={step}
                value={low}
                max={dates ? high || undefined : undefined}
                onChange={(e) => set("low", e.target.value)}
                className="h-8"
              />
            </div>
            <div>
              <label htmlFor={highId} className="text-xs text-subtle">
                <span className="sr-only">{field.label}, </span>
                {dates ? "To" : "At most"}
              </label>
              <Input
                id={highId}
                type={type}
                inputMode={inputMode}
                step={step}
                value={high}
                min={dates ? low || undefined : undefined}
                onChange={(e) => set("high", e.target.value)}
                className="h-8"
              />
            </div>
          </div>
        </fieldset>
      );
    }
    default:
      // Named, and kept out of the browser's autofill, for the reason set out in SearchParamInput.
      return (
        <div className="space-y-1">
          <Label htmlFor={id}>{field.label}</Label>
          <Input
            id={id}
            name={`filter-${field.key}`}
            value={draft.value ?? ""}
            placeholder="Contains…"
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            onChange={(e) => onChange({ value: e.target.value })}
            className="h-8"
          />
        </div>
      );
  }
}
