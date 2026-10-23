"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { fieldValues } from "@/actions/reporting";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { FILTER_OP_LABELS, NUMBER_OPS, type DateRange, type FilterOp, type ReportFilter } from "@/lib/reporting/definition";
import type { CatalogSource } from "@/lib/reporting/sources";
import { formatMetric } from "./format";

type Source = Extract<CatalogSource, { available: true }>;

/** A filter in words, for its chip: "Branch: Mumbai, Pune +1", "Revenue > ₹25,000". */
export function filterWords(f: ReportFilter, source: Source): string {
  const dim = source.dimensions.find((d) => d.key === f.field);
  const measure = source.measures.find((m) => m.key === f.field);
  const label = dim?.label ?? measure?.label ?? f.field;
  if (dim) {
    const values = f.values ?? [];
    const list = values.length <= 2 ? values.join(", ") : `${values.slice(0, 2).join(", ")} +${values.length - 2}`;
    switch (f.op) {
      case "in":
        return `${label}: ${list || "All"}`;
      case "notIn":
        return `${label}: not ${list}`;
      case "isEmpty":
      case "isNotEmpty":
        return `${label} ${FILTER_OP_LABELS[f.op]}`;
      default:
        return `${label} ${FILTER_OP_LABELS[f.op]} “${f.text ?? ""}”`;
    }
  }
  const unit = measure?.type === "currency" ? "currency" : "number";
  const n = (v: number | undefined) => formatMetric(v ?? 0, unit, { short: false });
  const sym: Partial<Record<FilterOp, string>> = { gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=" };
  if (f.op === "between") return `${label} ${n(f.number)}–${n(f.number2)}`;
  if (f.op === "isEmpty") return `${label} is empty`;
  return `${label} ${sym[f.op] ?? FILTER_OP_LABELS[f.op]} ${n(f.number)}`;
}

let seq = 0;
export const newFilterId = () => `f${Date.now().toString(36)}${(seq += 1)}`;

export function FilterEditor({
  source,
  filter,
  scope,
  allowScope,
  dateRange,
  dateField,
  onApply,
  onRemove,
  onClose,
}: {
  source: Source;
  filter: ReportFilter | null;
  scope: "report" | "chart";
  /** Offer moving it between the whole report and the selected chart. */
  allowScope: boolean;
  dateRange: DateRange;
  dateField: string;
  onApply: (filter: ReportFilter, scope: "report" | "chart") => void;
  onRemove?: () => void;
  onClose: () => void;
}) {
  const [where, setWhere] = useState(scope);
  const [field, setField] = useState(filter?.field ?? source.dimensions[0]?.key ?? source.measures[0]?.key ?? "");
  const dim = source.dimensions.find((d) => d.key === field);
  const measure = source.measures.find((m) => m.key === field);
  const [mode, setMode] = useState<"pick" | "text">(filter && dim && !["in", "notIn"].includes(filter.op) ? "text" : "pick");
  const [exclude, setExclude] = useState(filter?.op === "notIn");
  const [picked, setPicked] = useState<Set<string>>(new Set(filter?.values ?? []));
  const [textOp, setTextOp] = useState<FilterOp>(filter && dim && !["in", "notIn"].includes(filter.op) ? filter.op : "contains");
  const [text, setText] = useState(filter?.text ?? "");
  const [numOp, setNumOp] = useState<FilterOp>(filter && measure ? filter.op : "gt");
  const [n1, setN1] = useState(filter?.number !== undefined ? String(filter.number) : "");
  const [n2, setN2] = useState(filter?.number2 !== undefined ? String(filter.number2) : "");
  const [search, setSearch] = useState("");
  const [values, setValues] = useState<{ value: string; rows: number }[] | null>(null);
  const [distinct, setDistinct] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // The field's values, from this person's own rows in the report's range.
  useEffect(() => {
    if (!dim) return;
    let live = true;
    const t = setTimeout(() => {
      fieldValues({ source: source.key, field: dim.key, dateRange, dateField, search })
        .then((res) => {
          if (!live) return;
          if (res.ok) {
            setValues(res.data.values);
            setDistinct(res.data.distinct);
          } else setError(res.error);
        })
        .catch(() => live && setError("Couldn't load the values. Try again."));
    }, search ? 250 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [dim, source.key, dateRange, dateField, search]);

  const list = useMemo(() => values ?? [], [values]);

  function apply() {
    setError(null);
    const id = filter?.id ?? newFilterId();
    if (dim) {
      if (mode === "pick") {
        if (picked.size === 0) return setError("Pick at least one value, or remove the filter.");
        return onApply({ id, field, op: exclude ? "notIn" : "in", values: [...picked] }, where);
      }
      if (!["isEmpty", "isNotEmpty"].includes(textOp) && !text.trim()) return setError("Type the text to match.");
      return onApply({ id, field, op: textOp, text: text.trim() }, where);
    }
    if (measure) {
      const a = Number(n1);
      const b = Number(n2);
      if (numOp !== "isEmpty" && (n1.trim() === "" || !Number.isFinite(a))) return setError("Type a number.");
      if (numOp === "between" && (n2.trim() === "" || !Number.isFinite(b))) return setError("Type both ends of the range.");
      return onApply({ id, field, op: numOp, ...(numOp !== "isEmpty" ? { number: a } : {}), ...(numOp === "between" ? { number2: b } : {}) }, where);
    }
  }

  const fieldOptions = (
    <select
      aria-label="Field"
      value={field}
      onChange={(e) => {
        setField(e.target.value);
        setPicked(new Set());
        setValues(null);
        setSearch("");
      }}
      className="h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-[13px] text-text"
    >
      <optgroup label="Dimensions">
        {source.dimensions.map((d) => (
          <option key={d.key} value={d.key}>
            {d.label}
          </option>
        ))}
      </optgroup>
      <optgroup label="Metrics — each record's own figure">
        {source.measures.map((m) => (
          <option key={m.key} value={m.key}>
            {m.label}
          </option>
        ))}
      </optgroup>
    </select>
  );

  const seg = (on: boolean) => cn("h-8 flex-1 rounded-md text-[13px] font-medium", on ? "bg-surface text-text shadow-sm" : "text-muted");

  return (
    <Dialog open onClose={onClose} title={filter ? "Edit filter" : "Add filter"}>
      <div className="space-y-3">
        {allowScope && (
          <div className="flex gap-0.5 rounded-lg bg-surface-sunken p-[3px]" role="radiogroup" aria-label="Applies to">
            <button type="button" className={seg(where === "report")} aria-pressed={where === "report"} onClick={() => setWhere("report")}>
              Whole report
            </button>
            <button type="button" className={seg(where === "chart")} aria-pressed={where === "chart"} onClick={() => setWhere("chart")}>
              This chart only
            </button>
          </div>
        )}
        {fieldOptions}

        {dim && (
          <>
            <div className="flex gap-0.5 rounded-lg bg-surface-sunken p-[3px]">
              <button type="button" className={seg(mode === "pick")} onClick={() => setMode("pick")}>
                Pick values
              </button>
              <button type="button" className={seg(mode === "text")} onClick={() => setMode("text")}>
                Text condition
              </button>
            </div>
            {mode === "pick" ? (
              <>
                <div className="flex gap-0.5 rounded-lg bg-surface-sunken p-[3px]">
                  <button type="button" className={seg(!exclude)} aria-pressed={!exclude} onClick={() => setExclude(false)}>
                    Include
                  </button>
                  <button type="button" className={seg(exclude)} aria-pressed={exclude} onClick={() => setExclude(true)}>
                    Exclude
                  </button>
                </div>
                <label className="relative block">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-subtle" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={values ? `Search ${distinct.toLocaleString("en-IN")} ${dim.label.toLowerCase()} values…` : "Loading values…"}
                    className="h-9 w-full rounded-lg border border-brand/60 bg-surface pl-8 pr-2.5 text-[13px] text-text outline-none focus:border-brand"
                  />
                </label>
                <div className="max-h-64 space-y-0.5 overflow-y-auto pr-1">
                  {values === null && !error && <p className="py-4 text-center text-[13px] text-subtle">Loading the values you can see…</p>}
                  {values !== null && list.length === 0 && <p className="py-4 text-center text-[13px] text-subtle">No values match.</p>}
                  {list.map((v) => {
                    const on = picked.has(v.value);
                    return (
                      <label key={v.value} className="flex cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-surface-sunken">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => {
                            const next = new Set(picked);
                            if (on) next.delete(v.value);
                            else next.add(v.value);
                            setPicked(next);
                          }}
                          className="h-4 w-4 accent-[var(--brand)]"
                        />
                        <span className="min-w-0 flex-1 truncate text-[13px] text-text">{v.value}</span>
                        <span className="text-[12px] tabular-nums text-subtle">{v.rows.toLocaleString("en-IN")}</span>
                      </label>
                    );
                  })}
                </div>
                <p className="text-[12px] text-subtle">
                  {picked.size} of {distinct.toLocaleString("en-IN")} selected
                </p>
              </>
            ) : (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {(["contains", "startsWith", "equals", "notContains", "isEmpty", "isNotEmpty"] as const).map((op) => (
                    <button
                      key={op}
                      type="button"
                      onClick={() => setTextOp(op)}
                      aria-pressed={textOp === op}
                      className={cn("h-8 rounded-full border px-3 text-[12.5px]", textOp === op ? "border-brand bg-brand-subtle text-brand" : "border-line text-text hover:bg-surface-sunken")}
                    >
                      {FILTER_OP_LABELS[op]}
                    </button>
                  ))}
                </div>
                {!["isEmpty", "isNotEmpty"].includes(textOp) && (
                  <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Text to match" className="h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-[13px] text-text" />
                )}
              </div>
            )}
          </>
        )}

        {measure && (
          <div className="space-y-2">
            <p className="text-[12px] text-muted">Each record&apos;s own {measure.label.toLowerCase()} — before anything is added up.</p>
            <div className="overflow-hidden rounded-lg border border-line">
              {NUMBER_OPS.map((op) => (
                <button key={op} type="button" onClick={() => setNumOp(op)} className={cn("block w-full px-3 py-2 text-left text-[13px]", numOp === op ? "bg-brand-subtle text-brand" : "text-text hover:bg-surface-sunken")}>
                  {FILTER_OP_LABELS[op]}
                </button>
              ))}
            </div>
            {numOp !== "isEmpty" && (
              <div className="flex items-center gap-2">
                <NumberBox value={n1} onChange={setN1} money={measure.type === "currency"} label="Value" />
                {numOp === "between" && (
                  <>
                    <span className="text-[13px] text-muted">and</span>
                    <NumberBox value={n2} onChange={setN2} money={measure.type === "currency"} label="Up to" />
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between gap-2 pt-1">
          {onRemove ? (
            <button type="button" onClick={onRemove} className="text-[13px] font-medium text-danger hover:underline">
              Remove filter
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={apply}>
              Apply
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function NumberBox({ value, onChange, money, label }: { value: string; onChange: (v: string) => void; money: boolean; label: string }) {
  return (
    <label className="relative block flex-1">
      {money && <span className="pointer-events-none absolute left-2.5 top-2 text-[13px] text-subtle">₹</span>}
      <input aria-label={label} type="number" value={value} onChange={(e) => onChange(e.target.value)} className={cn("h-9 w-full rounded-lg border border-line bg-surface pr-2.5 text-[13px] text-text", money ? "pl-6" : "pl-2.5")} />
    </label>
  );
}
