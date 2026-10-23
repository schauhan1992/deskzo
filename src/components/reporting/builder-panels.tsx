"use client";

import { useState } from "react";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Pencil, Plus, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AGGREGATION_LABELS,
  CHART_KIND_LABELS,
  CHART_KINDS,
  DATE_PRESET_LABELS,
  GRAINS,
  chartNeeds,
  isCalcRef,
  type Aggregation,
  type CalculatedField,
  type ChartKind,
  type DateRange,
  type ReportChart,
  type ReportDefinition,
  type ReportFilter,
} from "@/lib/reporting/definition";
import { DateRangeMenu, FieldMark } from "./controls";
import { KIND_ICONS, WIDTH_CHOICES, chartTitle, dimensionLabel, metricLabel, type Source } from "./chart-ops";
import { filterWords } from "./filter-editor";

const label = "text-[12.5px] font-medium text-text";
const selectCls = "h-9 w-full min-w-0 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-text";
const GRAIN_LABELS: Record<(typeof GRAINS)[number], string> = { day: "Day", week: "Week", month: "Month", quarter: "Quarter", year: "Year" };

// ─── Data ────────────────────────────────────────────────────────────────────

export type FieldPick = { kind: "dimension"; key: string } | { kind: "metric"; ref: string };

/** The source's fields — click one to put it in the selected chart (or start a chart with it). */
export function DataPanel({
  source,
  def,
  selected,
  rows,
  onPick,
  onNewCalc,
  onEditCalc,
}: {
  source: Source;
  def: ReportDefinition;
  selected: ReportChart | null;
  rows: number | null;
  onPick: (f: FieldPick) => void;
  onNewCalc: () => void;
  onEditCalc: (c: CalculatedField) => void;
}) {
  const [q, setQ] = useState("");
  const match = (s: string) => !q.trim() || s.toLowerCase().includes(q.trim().toLowerCase());
  const inChart = (f: FieldPick) =>
    !!selected && (f.kind === "dimension" ? selected.dimension === f.key || selected.series === f.key : selected.metrics.some((m) => m.ref === f.ref));
  const dateLabel = source.dateFields.find((f) => f.key === def.dateField)?.label ?? "Date";
  const dims = [...(source.snapshot ? [] : [{ key: "time", label: dateLabel, type: "date" as const }]), ...source.dimensions].filter((d) => match(d.label));
  const metrics = source.measures.filter((m) => match(m.label));
  const calcs = def.calculated.filter((c) => match(c.label));

  const row = (key: string, f: FieldPick, text: string, mark: React.ReactNode, hint?: string, edit?: () => void) => (
    <div key={key} className="group flex items-center">
      <button
        type="button"
        onClick={() => onPick(f)}
        title={selected ? `Add to “${chartTitle(selected, source, def)}”` : "Start a chart with this"}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-[5px] text-left text-[13px] text-text hover:bg-surface-sunken"
      >
        {mark}
        <span className="min-w-0 flex-1 truncate">{text}</span>
        {inChart(f) ? <span className="text-[11.5px] text-brand">In chart</span> : hint ? <span className="font-mono text-[10.5px] text-subtle">{hint}</span> : null}
      </button>
      {edit && (
        <button type="button" onClick={edit} aria-label={`Edit ${text}`} className="grid h-6 w-6 place-items-center rounded text-subtle opacity-0 hover:text-brand group-hover:opacity-100 focus:opacity-100">
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <h2 className="text-[15px] font-semibold text-text">Data</h2>
      <div className="rounded-lg border border-line px-3 py-2.5">
        <p className="text-[13.5px] font-medium text-text">{source.label}</p>
        <p className="text-[12px] text-subtle">
          {source.group}
          {rows !== null && ` · ${rows.toLocaleString("en-IN")} rows in range`}
          {source.snapshot && " · as of today"}
        </p>
      </div>
      <label className="relative block">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-subtle" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search fields…" className="h-9 w-full rounded-lg border border-line bg-surface-sunken pl-8 pr-2.5 text-[13px] text-text outline-none focus:border-brand" />
      </label>

      <Group title="Dimensions" count={dims.length}>
        {dims.map((d) => row(`d:${d.key}`, { kind: "dimension", key: d.key }, d.key === "time" ? `${d.label} (over time)` : d.label, <FieldMark type={d.key === "time" ? "date" : "text"} />))}
      </Group>
      <Group title="Metrics" count={metrics.length}>
        {metrics.map((m) => row(`m:${m.key}`, { kind: "metric", ref: m.key }, m.label, <FieldMark type={m.type} />, AGGREGATION_LABELS[m.defaultAgg]))}
      </Group>
      <Group title="Calculated" count={calcs.length}>
        {calcs.map((c) => row(`c:${c.id}`, { kind: "metric", ref: `calc:${c.id}` }, c.label, <FieldMark type="calc" />, undefined, () => onEditCalc(c)))}
        <button type="button" onClick={onNewCalc} className="mt-1 inline-flex items-center gap-1.5 px-1.5 text-[13px] font-medium text-brand hover:underline">
          <Plus className="h-3.5 w-3.5" />
          New calculated field
        </button>
      </Group>
      <p className="mt-auto text-[11.5px] leading-relaxed text-subtle">Only the fields your role can see are listed. Figures come from your own records&apos; access — a colleague may see fewer rows.</p>
    </div>
  );
}

function Group({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 flex items-center justify-between px-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-subtle">
        {title}
        <span className="font-normal">{count}</span>
      </p>
      <div className="space-y-px">{children}</div>
    </div>
  );
}

// ─── The selected chart ──────────────────────────────────────────────────────

export function ChartPanel({
  chart,
  source,
  def,
  today,
  onChange,
  onRetype,
  onAddFilter,
  onEditFilter,
  onRemoveFilter,
  onClose,
}: {
  chart: ReportChart;
  source: Source;
  def: ReportDefinition;
  today: string;
  onChange: (next: ReportChart, coalesce?: string) => void;
  onRetype: (type: ChartKind) => void;
  onAddFilter: () => void;
  onEditFilter: (f: ReportFilter) => void;
  onRemoveFilter: (id: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"setup" | "style">("setup");
  const need = chartNeeds(chart.type);
  const Icon = KIND_ICONS[chart.type];
  const dims = [...(source.snapshot ? [] : [{ key: "time", label: `${dimensionLabel("time", source, def)} (over time)` }]), ...source.dimensions.map((d) => ({ key: d.key, label: d.label }))];
  const metricOptions = [...source.measures.map((m) => ({ ref: m.key, label: m.label })), ...def.calculated.map((c) => ({ ref: `calc:${c.id}`, label: `${c.label} (calculated)` }))];
  const set = (patch: Partial<ReportChart>, coalesce?: string) => onChange({ ...chart, ...patch }, coalesce);
  const aggsOf = (ref: string): Aggregation[] => (isCalcRef(ref) ? [] : (source.measures.find((m) => m.key === ref)?.aggs ?? ["sum"]));
  const overTime = chart.dimension === "time";

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start gap-3 border-b border-line px-4 pb-3 pt-4">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-subtle text-brand">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-text">{CHART_KIND_LABELS[chart.type]}</p>
          <p className="truncate text-[12px] text-muted">{chartTitle(chart, source, def)}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close chart settings" className="grid h-7 w-7 place-items-center rounded-md text-subtle hover:bg-surface-sunken">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex border-b border-line px-2" role="tablist">
        {(["setup", "style"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)} className={cn("h-10 flex-1 border-b-2 text-[12.5px] font-semibold uppercase tracking-[0.06em]", tab === t ? "border-brand text-brand" : "border-transparent text-subtle hover:text-text")}>
            {t}
          </button>
        ))}
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {tab === "setup" ? (
          <>
            <div>
              <p className={label}>Chart type</p>
              <div className="mt-1.5 grid grid-cols-5 gap-1.5">
                {CHART_KINDS.map((k) => {
                  const KIcon = KIND_ICONS[k];
                  const on = chart.type === k;
                  return (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={on}
                      onClick={() => onRetype(k)}
                      className={cn("flex flex-col items-center gap-1 rounded-lg border py-2 text-[11px]", on ? "border-brand bg-brand-subtle text-brand" : "border-line text-muted hover:border-line-strong hover:text-text")}
                    >
                      <KIcon className="h-[18px] w-[18px]" />
                      {CHART_KIND_LABELS[k]}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <p className={label}>Data source</p>
              <div className="mt-1.5 flex items-center justify-between rounded-lg bg-surface-sunken px-3 py-2 text-[13px]">
                <span className="text-text">{source.label}</span>
                <span className="text-[12px] text-subtle">{source.group}</span>
              </div>
            </div>

            {need.dimension && (
              <div>
                <p className={label}>{chart.type === "pivot" ? "Rows" : "Dimension"}</p>
                <select aria-label="Dimension" className={cn(selectCls, "mt-1.5")} value={chart.dimension ?? ""} onChange={(e) => {
                  const key = e.target.value;
                  const time = key === "time";
                  set({ dimension: key, limit: time ? null : chart.limit ?? 10, sort: time ? { by: "dimension", dir: "asc" } : chart.dimension === "time" ? { by: "value", dir: "desc" } : chart.sort });
                }}>
                  {!chart.dimension && <option value="">Choose…</option>}
                  {dims.map((d) => (
                    <option key={d.key} value={d.key}>
                      {d.label}
                    </option>
                  ))}
                </select>
                {overTime && (
                  <div className="mt-1.5 flex gap-0.5 rounded-lg bg-surface-sunken p-[3px]">
                    {GRAINS.map((g) => (
                      <button key={g} type="button" aria-pressed={chart.grain === g} onClick={() => set({ grain: g })} className={cn("h-7 flex-1 rounded-md text-[12px] font-medium", chart.grain === g ? "bg-surface text-text shadow-sm" : "text-muted")}>
                        {GRAIN_LABELS[g]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {need.series && (
              <div>
                <p className={label}>Columns</p>
                <select aria-label="Columns" className={cn(selectCls, "mt-1.5")} value={chart.series ?? ""} onChange={(e) => set({ series: e.target.value || null })}>
                  <option value="">Choose…</option>
                  {dims.filter((d) => d.key !== chart.dimension).map((d) => (
                    <option key={d.key} value={d.key}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <p className={label}>{need.maxMetrics === 1 ? "Metric" : "Metrics"}</p>
              <div className="mt-1.5 space-y-1.5">
                {chart.metrics.map((m, i) => {
                  const aggs = aggsOf(m.ref);
                  return (
                    <div key={`${m.ref}-${i}`} className="flex items-center gap-1.5 rounded-lg border border-line p-1.5">
                      <FieldMark type={isCalcRef(m.ref) ? "calc" : (source.measures.find((x) => x.key === m.ref)?.type ?? "number")} />
                      <select
                        aria-label={`Metric ${i + 1}`}
                        className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-1 text-[13px] text-text"
                        value={m.ref}
                        onChange={(e) => {
                          const ref = e.target.value;
                          const agg = isCalcRef(ref) ? "sum" : (source.measures.find((x) => x.key === ref)?.defaultAgg ?? "sum");
                          set({ metrics: chart.metrics.map((x, j) => (j === i ? { ref, agg } : x)) });
                        }}
                      >
                        {metricOptions.map((o) => (
                          <option key={o.ref} value={o.ref}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      {aggs.length > 0 ? (
                        <select aria-label="Aggregation" className="h-8 rounded-md border border-line bg-surface px-1.5 font-mono text-[11px] text-text" value={m.agg} onChange={(e) => set({ metrics: chart.metrics.map((x, j) => (j === i ? { ...x, agg: e.target.value as Aggregation } : x)) })}>
                          {aggs.map((a) => (
                            <option key={a} value={a}>
                              {AGGREGATION_LABELS[a]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="px-1.5 font-mono text-[10.5px] text-subtle">CALC</span>
                      )}
                      {chart.metrics.length > need.minMetrics && (
                        <button type="button" aria-label={`Remove ${metricLabel(m.ref, source, def)}`} onClick={() => set({ metrics: chart.metrics.filter((_, j) => j !== i) })} className="grid h-7 w-7 place-items-center rounded text-subtle hover:text-danger">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
                {chart.metrics.length < need.maxMetrics && (
                  <select
                    aria-label="Add metric"
                    className={cn(selectCls, "border-dashed text-muted")}
                    value=""
                    onChange={(e) => {
                      const ref = e.target.value;
                      if (!ref) return;
                      const agg = isCalcRef(ref) ? "sum" : (source.measures.find((x) => x.key === ref)?.defaultAgg ?? "sum");
                      set({ metrics: [...chart.metrics, { ref, agg }] });
                    }}
                  >
                    <option value="">+ Add metric…</option>
                    {metricOptions.filter((o) => !chart.metrics.some((m) => m.ref === o.ref)).map((o) => (
                      <option key={o.ref} value={o.ref}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                )}
                {chart.type === "combo" && <p className="text-[12px] text-subtle">The first metric draws as columns; the second as a line on the right-hand axis.</p>}
              </div>
            </div>

            {need.dimension && chart.type !== "pivot" && (
              <div>
                <p className={label}>Sort</p>
                <div className="mt-1.5 flex gap-1.5">
                  <select aria-label="Sort by" className={selectCls} value={chart.sort.by} onChange={(e) => set({ sort: { ...chart.sort, by: e.target.value as "dimension" | "value" } })}>
                    <option value="dimension">{chart.dimension ? dimensionLabel(chart.dimension, source, def) : "Dimension"}</option>
                    <option value="value">{chart.metrics[0] ? metricLabel(chart.metrics[0].ref, source, def) : "Value"}</option>
                  </select>
                  <button
                    type="button"
                    aria-label={chart.sort.dir === "asc" ? "Ascending — click for descending" : "Descending — click for ascending"}
                    title={chart.sort.dir === "asc" ? "Ascending" : "Descending"}
                    onClick={() => set({ sort: { ...chart.sort, dir: chart.sort.dir === "asc" ? "desc" : "asc" } })}
                    className="grid h-9 w-10 shrink-0 place-items-center rounded-lg border border-line text-text hover:bg-surface-sunken"
                  >
                    {chart.sort.dir === "asc" ? <ArrowUpNarrowWide className="h-4 w-4" /> : <ArrowDownWideNarrow className="h-4 w-4" />}
                  </button>
                </div>
                {!overTime && (
                  <select aria-label="Show" className={cn(selectCls, "mt-1.5")} value={chart.limit ?? 0} onChange={(e) => set({ limit: Number(e.target.value) || null })}>
                    <option value={0}>Show all</option>
                    {[5, 10, 15, 20, 50, 100].map((n) => (
                      <option key={n} value={n}>
                        Top {n}
                        {chart.type === "pie" || chart.type === "donut" ? ", the rest as Other" : ""}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}

            {chart.type === "score" && !source.snapshot && (
              <div>
                <p className={label}>Compare with</p>
                <select aria-label="Compare with" className={cn(selectCls, "mt-1.5")} value={chart.compare} onChange={(e) => set({ compare: e.target.value as ReportChart["compare"] })}>
                  <option value="none">Nothing</option>
                  <option value="previousYear">The same period last year</option>
                  <option value="previousPeriod">The period just before</option>
                </select>
              </div>
            )}

            {!source.snapshot && (
              <div>
                <p className={label}>Date range</p>
                <div className="mt-1.5 flex gap-0.5 rounded-lg bg-surface-sunken p-[3px]">
                  <button type="button" aria-pressed={!chart.dateRange} onClick={() => set({ dateRange: null })} className={cn("h-8 flex-1 rounded-md text-[13px] font-medium", !chart.dateRange ? "bg-surface text-text shadow-sm" : "text-muted")}>
                    Report default
                  </button>
                  <button type="button" aria-pressed={!!chart.dateRange} onClick={() => !chart.dateRange && set({ dateRange: def.dateRange.preset === "lastFy" ? { preset: "thisFy" } : { preset: "lastFy" } })} className={cn("h-8 flex-1 rounded-md text-[13px] font-medium", chart.dateRange ? "bg-surface text-text shadow-sm" : "text-muted")}>
                    Custom
                  </button>
                </div>
                {chart.dateRange ? (
                  <div className="mt-1.5">
                    <DateRangeMenu value={chart.dateRange} today={today} onChange={(r: DateRange) => set({ dateRange: r })} align="end" />
                  </div>
                ) : (
                  <p className="mt-1 text-[12px] text-subtle">Follows the report: {DATE_PRESET_LABELS[def.dateRange.preset]}</p>
                )}
              </div>
            )}

            <div>
              <p className="flex items-center justify-between">
                <span className={label}>Chart filters</span>
                <span className="text-[12px] text-subtle">This chart only</span>
              </p>
              <p className="text-[12px] text-subtle">Applied on top of the report filters.</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {chart.filters.map((f) => (
                  <FilterChip key={f.id} text={filterWords(f, source)} onEdit={() => onEditFilter(f)} onRemove={() => onRemoveFilter(f.id)} tone="chart" />
                ))}
              </div>
              <button type="button" onClick={onAddFilter} className="mt-1.5 h-9 w-full rounded-lg border border-dashed border-line-strong text-[13px] text-muted hover:border-brand hover:text-brand">
                Add chart filter
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="block">
              <span className={label}>Title</span>
              <input value={chart.title} maxLength={100} onChange={(e) => set({ title: e.target.value }, `title:${chart.id}`)} placeholder={chartTitle({ ...chart, title: "" }, source, def)} className={cn(selectCls, "mt-1.5")} />
            </label>
            <div>
              <p className={label}>Width</p>
              <div className="mt-1.5 flex gap-0.5 rounded-lg bg-surface-sunken p-[3px]">
                {WIDTH_CHOICES.map((w) => (
                  <button key={w.width} type="button" aria-pressed={chart.width === w.width} onClick={() => set({ width: w.width })} className={cn("h-8 flex-1 rounded-md text-[13px] font-medium", chart.width === w.width ? "bg-surface text-text shadow-sm" : "text-muted")}>
                    {w.label}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[12px] text-subtle">Of the page&apos;s width on a wide screen. Charts stack on a phone.</p>
            </div>
            {chart.type !== "score" && chart.type !== "table" && chart.type !== "pivot" && (
              <>
                <Toggle label="Show legend" on={chart.showLegend} onChange={(v) => set({ showLegend: v })} />
                <Toggle label="Show values on the chart" on={chart.showValues} onChange={(v) => set({ showValues: v })} />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Toggle({ label: text, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-[13px] text-text">
      {text}
      <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className={cn("relative h-5 w-9 rounded-full transition-colors", on ? "bg-brand" : "bg-line-strong")}>
        <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left]", on ? "left-[18px]" : "left-0.5")} />
      </button>
    </label>
  );
}

export function FilterChip({ text, onEdit, onRemove, tone = "report" }: { text: string; onEdit?: () => void; onRemove?: () => void; tone?: "report" | "chart" | "cross" }) {
  return (
    <span className={cn("inline-flex h-8 max-w-full items-center rounded-full border pl-3 text-[12.5px]", tone === "cross" ? "border-brand bg-brand-subtle text-brand" : tone === "chart" ? "border-warning/40 bg-warning-bg text-text" : "border-line bg-surface text-text", !onRemove && "pr-3")}>
      {onEdit ? (
        <button type="button" onClick={onEdit} className="min-w-0 truncate hover:underline">
          {text}
        </button>
      ) : (
        <span className="min-w-0 truncate">{text}</span>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove filter ${text}`} className="ml-1 grid h-7 w-7 place-items-center rounded-full text-subtle hover:text-danger">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </span>
  );
}

// ─── The report itself (nothing selected) ────────────────────────────────────

export function ReportPanel({
  source,
  def,
  name,
  description,
  pageName,
  onMeta,
  onDef,
  onPageName,
  onEditCalc,
  onNewCalc,
}: {
  source: Source;
  def: ReportDefinition;
  name: string;
  description: string;
  pageName: string;
  onMeta: (patch: { name?: string; description?: string }, coalesce: string) => void;
  onDef: (next: ReportDefinition) => void;
  onPageName: (name: string) => void;
  onEditCalc: (c: CalculatedField) => void;
  onNewCalc: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-4 pb-3 pt-4">
        <p className="text-[14px] font-semibold text-text">Report settings</p>
        <p className="text-[12px] text-muted">Select a chart on the canvas to set it up.</p>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <label className="block">
          <span className={label}>Name</span>
          <input value={name} maxLength={120} onChange={(e) => onMeta({ name: e.target.value }, "name")} className={cn(selectCls, "mt-1.5")} />
        </label>
        <label className="block">
          <span className={label}>Description</span>
          <textarea value={description} maxLength={400} rows={3} onChange={(e) => onMeta({ description: e.target.value }, "description")} className="mt-1.5 w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-[13px] text-text" />
        </label>
        <label className="block">
          <span className={label}>This page&apos;s name</span>
          <input value={pageName} maxLength={40} onChange={(e) => onPageName(e.target.value)} className={cn(selectCls, "mt-1.5")} />
        </label>
        {!source.snapshot && source.dateFields.length > 1 && (
          <label className="block">
            <span className={label}>The date range is on</span>
            <select className={cn(selectCls, "mt-1.5")} value={def.dateField} onChange={(e) => onDef({ ...def, dateField: e.target.value })}>
              {source.dateFields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[12px] text-subtle">Which of the record&apos;s dates decides whether it falls in the range, and its month on a chart over time.</span>
          </label>
        )}
        {source.snapshot && <p className="rounded-lg bg-surface-sunken px-3 py-2 text-[12.5px] text-muted">{source.label} is a snapshot of today: no date range applies.</p>}
        <div>
          <p className={label}>Calculated fields</p>
          <div className="mt-1.5 space-y-1">
            {def.calculated.length === 0 && <p className="text-[12.5px] text-subtle">None yet — a ratio or a difference of two metrics, worked out per group.</p>}
            {def.calculated.map((c) => (
              <button key={c.id} type="button" onClick={() => onEditCalc(c)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-[13px] text-text hover:bg-surface-sunken">
                <FieldMark type="calc" />
                <span className="flex-1 truncate">{c.label}</span>
                <Pencil className="h-3.5 w-3.5 text-subtle" />
              </button>
            ))}
            <button type="button" onClick={onNewCalc} className="inline-flex items-center gap-1.5 px-1.5 text-[13px] font-medium text-brand hover:underline">
              <Plus className="h-3.5 w-3.5" />
              New calculated field
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
