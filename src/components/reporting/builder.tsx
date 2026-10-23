"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, Copy, Download, Ellipsis, Eye, EyeOff, PanelLeft, Plus, Redo2, Settings2, Share2, Trash2, Undo2 } from "lucide-react";
import { exportReportChart, saveReport, type OpenedReport } from "@/actions/reporting";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/menu";
import { cn } from "@/lib/utils";
import { CHART_KIND_LABELS, CHART_KINDS, LIMITS, calcIdOf, chartNeeds, isCalcRef, type CalculatedField, type ChartKind, type ReportChart, type ReportDefinition, type ReportFilter } from "@/lib/reporting/definition";
import { CalcDialog } from "./calc-dialog";
import { ChartCard, chartNote } from "./chart-card";
import { KIND_ICONS, applyField, canAddChart, chartTitle, copyChart, newChart, newId, retype, type Source } from "./chart-ops";
import { ChartPanel, DataPanel, FilterChip, ReportPanel, type FieldPick } from "./builder-panels";
import { DateRangeMenu, Toast, downloadCsv, useToast } from "./controls";
import { FilterEditor, filterWords } from "./filter-editor";
import { ShareDialog, type ShareEntry } from "./share-dialog";
import { useReportRun } from "./use-report-run";

/**
 * The Report Builder (Reporting & Analytics, owner 23 Oct 2026; the approved design's 1c).
 *
 * Left, the source's fields; middle, the page's charts drawn from live figures as they are set up; right, the
 * selected chart's setup and style (or the report's own settings). Everything edited is one value — name,
 * description and definition — so undo and redo are the values before and after, and "unsaved" is that value
 * differing from the one last saved. Saving sends the definition to the server, which checks every field against
 * what this person may use before keeping it, and refuses a save over somebody else's later one.
 */

type Doc = { name: string; description: string; definition: ReportDefinition };
type History = { past: Doc[]; present: Doc; future: Doc[] };

const HISTORY = 100;

const subscribeNothing = () => () => {};
/** Times are drawn in the browser's zone, so only once it is the browser drawing them. */
function useIsClient() {
  return useSyncExternalStore(subscribeNothing, () => true, () => false);
}
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });

export function ReportBuilder({ report, source, today }: { report: OpenedReport; source: Source; today: string }) {
  const router = useRouter();
  const isClient = useIsClient();
  const initial = useMemo<Doc>(() => ({ name: report.name, description: report.description, definition: report.definition }), [report]);
  const [hist, setHist] = useState<History>({ past: [], present: initial, future: [] });
  const doc = hist.present;
  const def = doc.definition;
  const lastEdit = useRef<string | null>(null);

  const [pageId, setPageId] = useState(def.pages[0]!.id);
  const page = def.pages.find((p) => p.id === pageId) ?? def.pages[0]!;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = page.charts.find((c) => c.id === selectedId) ?? null;
  const [preview, setPreview] = useState(false);
  const [showFields, setShowFields] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const [saved, setSaved] = useState({ json: JSON.stringify(initial), updatedAt: report.updatedAt });
  const [saving, setSaving] = useState<{ status: "idle" | "saving" | "failed"; error?: string }>({ status: "idle" });
  const dirty = JSON.stringify(doc) !== saved.json;

  const [filterDialog, setFilterDialog] = useState<{ scope: "report" | "chart"; filter: ReportFilter | null } | null>(null);
  const [calcDialog, setCalcDialog] = useState<{ field: CalculatedField | null } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shares, setShares] = useState<ShareEntry[]>(report.shares.map((s) => ({ userId: s.userId, departmentId: s.departmentId, name: s.name, canEdit: s.canEdit })));
  const [sharedWith, setSharedWith] = useState(report.sharedWith);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const { toast, show, clear } = useToast();

  const { runs, meta, busy, retry } = useReportRun({ reportId: report.id, definition: def, charts: page.charts, sendDefinition: true });

  // ─── Editing ───────────────────────────────────────────────────────────────

  /** One change. Typing on in the same box is one step of undo, not one per letter, until something else changes. */
  function commit(fn: (d: Doc) => Doc, coalesce?: string) {
    const merge = !!coalesce && lastEdit.current === coalesce;
    lastEdit.current = coalesce ?? null;
    setHist((h) => {
      const next = fn(h.present);
      if (next === h.present) return h;
      return merge ? { ...h, present: next, future: [] } : { past: [...h.past, h.present].slice(-HISTORY), present: next, future: [] };
    });
  }
  const setDef = (fn: (d: ReportDefinition) => ReportDefinition, coalesce?: string) => commit((d) => ({ ...d, definition: fn(d.definition) }), coalesce);
  const setPage = (fn: (charts: ReportChart[]) => ReportChart[]) => setDef((d) => ({ ...d, pages: d.pages.map((p) => (p.id === page.id ? { ...p, charts: fn(p.charts) } : p)) }));
  const setChart = (next: ReportChart, coalesce?: string) =>
    setDef((d) => ({ ...d, pages: d.pages.map((p) => (p.id === page.id ? { ...p, charts: p.charts.map((c) => (c.id === next.id ? next : c)) } : p)) }), coalesce);

  function undo() {
    lastEdit.current = null;
    setHist((h) => (h.past.length ? { past: h.past.slice(0, -1), present: h.past.at(-1)!, future: [h.present, ...h.future] } : h));
  }
  function redo() {
    lastEdit.current = null;
    setHist((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1) } : h));
  }

  function addChart(kind: ChartKind) {
    if (!canAddChart(def, page.id)) return show(`A page holds up to ${LIMITS.chartsPerPage} charts. Add a page for more.`, { failed: true });
    const chart = newChart(kind, source);
    setPage((charts) => [...charts, chart]);
    setSelectedId(chart.id);
    setPreview(false);
  }

  function removeChart(id: string) {
    const was = page.charts.find((c) => c.id === id);
    setPage((charts) => charts.filter((c) => c.id !== id));
    if (selectedId === id) setSelectedId(null);
    show(`Removed “${was ? chartTitle(was, source, def) : "chart"}”`, { action: { label: "Undo", run: () => (undo(), clear()) } });
  }

  function moveChart(id: string, by: -1 | 1) {
    setPage((charts) => {
      const i = charts.findIndex((c) => c.id === id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= charts.length) return charts;
      const next = [...charts];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  function moveToPage(id: string, toPage: string) {
    const chart = page.charts.find((c) => c.id === id);
    if (!chart) return;
    if ((def.pages.find((p) => p.id === toPage)?.charts.length ?? 0) >= LIMITS.chartsPerPage) return show("That page is full.", { failed: true });
    setDef((d) => ({ ...d, pages: d.pages.map((p) => (p.id === page.id ? { ...p, charts: p.charts.filter((c) => c.id !== id) } : p.id === toPage ? { ...p, charts: [...p.charts, chart] } : p)) }));
    setSelectedId(null);
  }

  function pickField(f: FieldPick) {
    if (selected) setChart(applyField(selected, f, source));
    else {
      const kind: ChartKind = f.kind === "metric" ? "score" : f.key === "time" ? "line" : "bar";
      if (!canAddChart(def, page.id)) return;
      let chart = newChart(kind, source);
      chart = applyField(f.kind === "metric" ? { ...chart, metrics: [] } : chart, f, source);
      setPage((charts) => [...charts, chart]);
      setSelectedId(chart.id);
    }
    setShowFields(false);
  }

  function addPage() {
    if (def.pages.length >= LIMITS.pages) return show(`A report holds up to ${LIMITS.pages} pages.`, { failed: true });
    const id = newId("p");
    setDef((d) => ({ ...d, pages: [...d.pages, { id, name: `Page ${d.pages.length + 1}`, charts: [] }] }));
    setPageId(id);
    setSelectedId(null);
  }

  function removePage(id: string) {
    if (def.pages.length <= 1) return;
    const idx = def.pages.findIndex((p) => p.id === id);
    setDef((d) => ({ ...d, pages: d.pages.filter((p) => p.id !== id) }));
    setPageId(def.pages[idx === 0 ? 1 : idx - 1]!.id);
    setSelectedId(null);
    show("Page removed", { action: { label: "Undo", run: () => (undo(), clear()) } });
  }

  function applyFilter(f: ReportFilter, scope: "report" | "chart") {
    setFilterDialog(null);
    setDef((d) => {
      // Moved between the report and the chart: out of where it was, into where it now goes.
      const strip = (list: ReportFilter[]) => list.filter((x) => x.id !== f.id);
      const upsert = (list: ReportFilter[]) => (list.some((x) => x.id === f.id) ? list.map((x) => (x.id === f.id ? f : x)) : [...list, f]);
      const filters = scope === "report" ? upsert(d.filters) : strip(d.filters);
      const pages = d.pages.map((p) => ({
        ...p,
        charts: p.charts.map((c) => (c.id === selected?.id ? { ...c, filters: (scope === "chart" ? upsert(c.filters) : strip(c.filters)).slice(0, LIMITS.filters) } : c)),
      }));
      return { ...d, filters: filters.slice(0, LIMITS.filters), pages };
    });
  }

  function removeReportFilter(id: string) {
    setDef((d) => ({ ...d, filters: d.filters.filter((f) => f.id !== id) }));
  }

  function saveCalc(field: CalculatedField) {
    setCalcDialog(null);
    setDef((d) => ({ ...d, calculated: d.calculated.some((c) => c.id === field.id) ? d.calculated.map((c) => (c.id === field.id ? field : c)) : [...d.calculated, field].slice(0, LIMITS.calculated) }));
    if (selected && !calcDialog?.field && selected.metrics.length < chartNeeds(selected.type).maxMetrics) setChart(applyField(selected, { kind: "metric", ref: `calc:${field.id}` }, source));
  }

  function deleteCalc(id: string) {
    setCalcDialog(null);
    const users = def.pages.flatMap((p) => p.charts).filter((c) => c.metrics.some((m) => isCalcRef(m.ref) && calcIdOf(m.ref) === id));
    setDef((d) => ({
      ...d,
      calculated: d.calculated.filter((c) => c.id !== id),
      pages: d.pages.map((p) => ({ ...p, charts: p.charts.map((c) => ({ ...c, metrics: c.metrics.filter((m) => !(isCalcRef(m.ref) && calcIdOf(m.ref) === id)) })) })),
    }));
    if (users.length) show(`Removed from ${users.length} chart${users.length === 1 ? "" : "s"}`, { action: { label: "Undo", run: () => (undo(), clear()) } });
  }

  // ─── Saving ────────────────────────────────────────────────────────────────

  async function save(): Promise<boolean> {
    if (saving.status === "saving") return false;
    if (!doc.name.trim()) {
      setSaving({ status: "failed", error: "Name the report." });
      return false;
    }
    setSaving({ status: "saving" });
    const sending = doc;
    try {
      const res = await saveReport({ id: report.id, name: sending.name, description: sending.description, definition: sending.definition, baseUpdatedAt: saved.updatedAt });
      if (!res.ok) {
        setSaving({ status: "failed", error: res.error });
        show(res.error, { failed: true });
        return false;
      }
      setSaved({ json: JSON.stringify(sending), updatedAt: res.data.updatedAt });
      setSaving({ status: "idle" });
      show("Report saved");
      router.refresh();
      return true;
    } catch {
      setSaving({ status: "failed", error: "Couldn't reach the server. Your changes are still here." });
      return false;
    }
  }

  async function exportChart(chart: ReportChart) {
    if (!report.canExport) return show("Downloading this data needs the export permission.", { failed: true });
    setExporting(chart.id);
    try {
      const res = await exportReportChart({ reportId: report.id, definition: def, chartId: chart.id });
      if (!res.ok) return show(res.error, { failed: true });
      downloadCsv(res.data.filename, res.data.csv);
      show(`Downloaded “${chartTitle(chart, source, def)}”`);
    } catch {
      show("The download failed. Try again.", { failed: true });
    } finally {
      setExporting(null);
    }
  }

  function go(href: string) {
    if (dirty) setLeaving(href);
    else router.push(href);
  }

  // Leaving with unsaved changes asks first — a closed tab or a reload here, a link through `go`.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const keys = useRef({ undo, redo, save, removeChart, selectedId });
  useEffect(() => {
    keys.current = { undo, redo, save, removeChart, selectedId };
  });
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const typing = (e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable='true']");
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.code === "KeyS") {
        e.preventDefault();
        void keys.current.save();
      } else if (mod && !typing && e.code === "KeyZ") {
        e.preventDefault();
        if (e.shiftKey) keys.current.redo();
        else keys.current.undo();
      } else if (mod && !typing && e.code === "KeyY") {
        e.preventDefault();
        keys.current.redo();
      } else if (!typing && !mod && (e.key === "Delete" || e.key === "Backspace") && keys.current.selectedId && !document.querySelector("[role=dialog]")) {
        e.preventDefault();
        keys.current.removeChart(keys.current.selectedId);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ─── Drawing ───────────────────────────────────────────────────────────────

  const status =
    saving.status === "saving" ? (
      <span className="text-muted">Saving…</span>
    ) : saving.status === "failed" ? (
      <span className="text-danger">
        Save failed{saving.error ? ` — ${saving.error}` : ""} ·{" "}
        <button type="button" onClick={() => void save()} className="font-medium underline">
          Retry
        </button>
      </span>
    ) : dirty ? (
      <span className="text-warning">Unsaved changes</span>
    ) : (
      <span>Saved{isClient ? ` at ${timeOf(saved.updatedAt)}` : ""}</span>
    );

  const panelOpen = !preview && (!!selected || showSettings);
  const chartFilterTarget = filterDialog?.scope === "chart" ? selected : null;

  return (
    <div className="flex h-[calc(100dvh-9rem)] min-h-[600px] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Link
            href="/reports"
            onClick={(e) => {
              if (dirty) {
                e.preventDefault();
                setLeaving("/reports");
              }
            }}
            className="hidden text-[13px] text-muted hover:text-text sm:inline"
          >
            Reports
          </Link>
          <ChevronRight className="hidden h-3.5 w-3.5 text-subtle sm:block" />
          <div className="min-w-0">
            <input
              aria-label="Report name"
              value={doc.name}
              maxLength={120}
              onChange={(e) => commit((d) => ({ ...d, name: e.target.value }), "name")}
              className="w-full min-w-0 truncate rounded bg-transparent text-[15px] font-semibold text-text outline-none focus:bg-surface-sunken"
            />
            <p className="truncate text-[12px] text-subtle">
              {source.group} · {source.label} · {status}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={undo} disabled={!hist.past.length} aria-label="Undo" title="Undo (Ctrl+Z)" className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-surface-sunken disabled:opacity-35">
            <Undo2 className="h-4 w-4" />
          </button>
          <button type="button" onClick={redo} disabled={!hist.future.length} aria-label="Redo" title="Redo (Ctrl+Shift+Z)" className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-surface-sunken disabled:opacity-35">
            <Redo2 className="h-4 w-4" />
          </button>
          <Button type="button" variant="secondary" size="sm" onClick={() => (setPreview((v) => !v), setSelectedId(null))}>
            {preview ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            {preview ? "Back to editing" : "Preview"}
          </Button>
          {report.access === "owner" && (
            <Button type="button" variant="secondary" size="sm" onClick={() => setShareOpen(true)} title={sharedWith}>
              <Share2 className="h-4 w-4" />
              Share
            </Button>
          )}
          <Menu label="Export" width={280}>
            {(close) => (
              <>
                <MenuLabel>Download a chart as CSV</MenuLabel>
                {!report.canExport && <p className="px-3 pb-2 text-[12.5px] text-muted">You can build and read this report, but downloading its data needs the export permission.</p>}
                {page.charts.length === 0 && <p className="px-3 pb-2 text-[12.5px] text-muted">This page has no charts yet.</p>}
                {page.charts.map((c) => (
                  <MenuItem
                    key={c.id}
                    disabled={!report.canExport || exporting === c.id}
                    onClick={() => {
                      close();
                      void exportChart(c);
                    }}
                  >
                    {chartTitle(c, source, def)}
                  </MenuItem>
                ))}
                {dirty && <p className="border-t border-line px-3 py-2 text-[12px] text-subtle">Downloads what is on screen, saved or not.</p>}
              </>
            )}
          </Menu>
          <Button type="button" size="sm" onClick={() => void save()} disabled={!dirty || saving.status === "saving"}>
            {saving.status === "saving" ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 sm:px-4">
        <button type="button" onClick={() => setShowFields((v) => !v)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] text-text hover:bg-surface-sunken lg:hidden">
          <PanelLeft className="h-4 w-4" />
          Fields
        </button>
        <Menu label="Add chart" width={220} align="start">
          {(close) =>
            CHART_KINDS.map((k) => {
              const Icon = KIND_ICONS[k];
              return (
                <MenuItem
                  key={k}
                  onClick={() => {
                    close();
                    addChart(k);
                  }}
                >
                  <span className="inline-flex items-center gap-2">
                    <Icon className="h-4 w-4 text-subtle" />
                    {CHART_KIND_LABELS[k]}
                  </span>
                </MenuItem>
              );
            })
          }
        </Menu>
        <Button type="button" variant="ghost" size="sm" onClick={() => setFilterDialog({ scope: "report", filter: null })}>
          Add filter
        </Button>
        <span className="mx-1 hidden h-6 w-px bg-line sm:block" />
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" role="tablist" aria-label="Pages">
          {def.pages.map((p) => (
            <button
              key={p.id}
              role="tab"
              type="button"
              aria-selected={p.id === page.id}
              onClick={() => (setPageId(p.id), setSelectedId(null))}
              className={cn("h-9 shrink-0 border-b-2 px-3 text-[13px] font-medium", p.id === page.id ? "border-brand text-text" : "border-transparent text-muted hover:text-text")}
            >
              {p.name || "Untitled page"} <span className="ml-0.5 text-[11.5px] text-subtle">{p.charts.length}</span>
            </button>
          ))}
          <Menu label={`Page options for ${page.name}`} icon={Ellipsis} width={220} align="start">
            {(close) => (
              <>
                <MenuItem onClick={() => (close(), setSelectedId(null), setShowSettings(true))}>Rename page</MenuItem>
                <MenuItem
                  disabled={def.pages.length >= LIMITS.pages}
                  onClick={() => {
                    close();
                    const id = newId("p");
                    setDef((d) => {
                      const at = d.pages.findIndex((p) => p.id === page.id);
                      const copy = { id, name: `${page.name} (copy)`.slice(0, 40), charts: page.charts.map(copyChart) };
                      return { ...d, pages: [...d.pages.slice(0, at + 1), copy, ...d.pages.slice(at + 1)] };
                    });
                    setPageId(id);
                  }}
                >
                  Duplicate page
                </MenuItem>
                <MenuSeparator />
                <MenuItem danger disabled={def.pages.length <= 1} onClick={() => (close(), removePage(page.id))}>
                  Delete page
                </MenuItem>
              </>
            )}
          </Menu>
          <button type="button" onClick={addPage} aria-label="Add page" title="Add page" className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-subtle hover:bg-surface-sunken hover:text-text">
            <Plus className="h-4 w-4" />
          </button>
        </div>
        {!source.snapshot && <DateRangeMenu value={def.dateRange} today={today} onChange={(r) => setDef((d) => ({ ...d, dateRange: r }))} />}
        <button type="button" onClick={() => (setSelectedId(null), setShowSettings((v) => !v))} aria-label="Report settings" title="Report settings" className="grid h-9 w-9 place-items-center rounded-lg border border-line text-muted hover:bg-surface-sunken lg:hidden">
          <Settings2 className="h-4 w-4" />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1">
        {/* Fields */}
        {!preview && (
          <aside
            className={cn(
              "w-60 shrink-0 border-r border-line bg-surface",
              showFields ? "absolute inset-y-0 left-0 z-30 flex shadow-xl" : "hidden",
              "lg:static lg:z-auto lg:flex lg:shadow-none",
            )}
          >
            <div className="w-full">
              <DataPanel
                source={source}
                def={def}
                selected={selected}
                rows={meta?.windowRows ?? null}
                onPick={pickField}
                onNewCalc={() => setCalcDialog({ field: null })}
                onEditCalc={(c) => setCalcDialog({ field: c })}
              />
            </div>
          </aside>
        )}

        {/* Canvas */}
        <div className="min-w-0 flex-1 overflow-y-auto bg-surface-sunken/60 [background-image:radial-gradient(var(--line)_1px,transparent_1px)] [background-size:18px_18px]" onClick={(e) => e.target === e.currentTarget && setSelectedId(null)}>
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2">
            <span className="text-[12.5px] text-muted">Report filters</span>
            {def.filters.map((f) => (
              <FilterChip key={f.id} text={filterWords(f, source)} onEdit={preview ? undefined : () => setFilterDialog({ scope: "report", filter: f })} onRemove={preview ? undefined : () => removeReportFilter(f.id)} />
            ))}
            {!preview && (
              <button type="button" onClick={() => setFilterDialog({ scope: "report", filter: null })} className="inline-flex h-8 items-center rounded-full border border-dashed border-line-strong px-3 text-[12.5px] text-muted hover:border-brand hover:text-brand">
                Add filter
              </button>
            )}
            {!preview && def.filters.length > 0 && (
              <button type="button" onClick={() => setDef((d) => ({ ...d, filters: [] }))} className="text-[12.5px] text-muted underline hover:text-text">
                Clear all
              </button>
            )}
            <span className="ml-auto hidden text-[12px] text-subtle md:inline">Applies to every chart on every page</span>
          </div>

          <div className="@container p-4 sm:p-6" onClick={(e) => e.target === e.currentTarget && setSelectedId(null)}>
            <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
              <div className="min-w-0">
                <h2 className="text-[20px] font-semibold text-text">{doc.name || "Untitled report"}</h2>
                {doc.description && <p className="mt-0.5 text-[13px] text-muted">{doc.description}</p>}
              </div>
              <p className="text-[12px] text-subtle">
                {busy ? "Updating…" : meta && isClient ? `Updated ${timeOf(new Date(meta.at).toISOString())}` : ""}
                {meta?.window ? ` · ${meta.window.label}` : source.snapshot ? " · As of today" : ""}
                {meta?.scopeNote ? ` · ${meta.scopeNote}` : ""}
              </p>
            </div>

            {page.charts.length === 0 ? (
              <EmptyPage onAdd={addChart} />
            ) : (
              <div className="grid grid-cols-12 gap-4" onClick={(e) => e.target === e.currentTarget && setSelectedId(null)}>
                {page.charts.map((c, i) => {
                  const run = runs[c.id];
                  const failed = run && run !== "loading" && !run.ok && (run.code === "source" || run.code === "migrate");
                  return (
                    <ChartCard
                      key={c.id}
                      chart={c}
                      title={chartTitle(c, source, def)}
                      run={run}
                      selected={!preview && selectedId === c.id}
                      onSelect={preview ? undefined : () => setSelectedId(c.id)}
                      note={failed ? null : chartNote(run)}
                      menu={
                        preview ? undefined : (
                          <Menu label={`Options for ${chartTitle(c, source, def)}`} icon={Ellipsis} width={220}>
                            {(close) => (
                              <>
                                <MenuItem onClick={() => (close(), setPage((charts) => [...charts.slice(0, i + 1), copyChart(c), ...charts.slice(i + 1)]))}>
                                  <span className="inline-flex items-center gap-2">
                                    <Copy className="h-4 w-4 text-subtle" />
                                    Duplicate
                                  </span>
                                </MenuItem>
                                <MenuItem disabled={i === 0} onClick={() => (close(), moveChart(c.id, -1))}>
                                  Move earlier
                                </MenuItem>
                                <MenuItem disabled={i === page.charts.length - 1} onClick={() => (close(), moveChart(c.id, 1))}>
                                  Move later
                                </MenuItem>
                                {def.pages
                                  .filter((p) => p.id !== page.id)
                                  .map((p) => (
                                    <MenuItem key={p.id} onClick={() => (close(), moveToPage(c.id, p.id))}>
                                      Move to “{p.name}”
                                    </MenuItem>
                                  ))}
                                <MenuItem disabled={!report.canExport} onClick={() => (close(), void exportChart(c))}>
                                  <span className="inline-flex items-center gap-2">
                                    <Download className="h-4 w-4 text-subtle" />
                                    Download CSV
                                  </span>
                                </MenuItem>
                                <MenuSeparator />
                                <MenuItem danger onClick={() => (close(), removeChart(c.id))}>
                                  <span className="inline-flex items-center gap-2">
                                    <Trash2 className="h-4 w-4" />
                                    Remove chart
                                  </span>
                                </MenuItem>
                              </>
                            )}
                          </Menu>
                        )
                      }
                    />
                  );
                })}
              </div>
            )}
            {page.charts.some((c) => {
              const r = runs[c.id];
              return r && r !== "loading" && !r.ok && (r.code === "source" || r.code === "migrate");
            }) && (
              <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger-bg px-4 py-2.5 text-[13px] text-danger">
                Some charts couldn&apos;t load their data.
                <Button type="button" size="sm" variant="secondary" onClick={retry}>
                  Retry
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Setup */}
        {!preview && (
          <aside
            className={cn(
              "w-[19rem] max-w-[92vw] shrink-0 border-l border-line bg-surface",
              panelOpen ? "absolute inset-y-0 right-0 z-30 flex shadow-xl" : "hidden",
              "lg:static lg:z-auto lg:flex lg:shadow-none",
            )}
          >
            <div className="w-full">
              {selected ? (
                <ChartPanel
                  key={selected.id}
                  chart={selected}
                  source={source}
                  def={def}
                  today={today}
                  onChange={setChart}
                  onRetype={(k) => setChart(retype(selected, k, source))}
                  onAddFilter={() => setFilterDialog({ scope: "chart", filter: null })}
                  onEditFilter={(f) => setFilterDialog({ scope: "chart", filter: f })}
                  onRemoveFilter={(id) => setChart({ ...selected, filters: selected.filters.filter((f) => f.id !== id) })}
                  onClose={() => setSelectedId(null)}
                />
              ) : (
                <ReportPanel
                  source={source}
                  def={def}
                  name={doc.name}
                  description={doc.description}
                  pageName={page.name}
                  onMeta={(patch, key) => commit((d) => ({ ...d, ...patch }), key)}
                  onDef={(next) => setDef(() => next)}
                  onPageName={(name) => setDef((d) => ({ ...d, pages: d.pages.map((p) => (p.id === page.id ? { ...p, name: name.slice(0, 40) } : p)) }), `page:${page.id}`)}
                  onEditCalc={(c) => setCalcDialog({ field: c })}
                  onNewCalc={() => setCalcDialog({ field: null })}
                />
              )}
            </div>
          </aside>
        )}
      </div>

      {filterDialog && (
        <FilterEditor
          source={source}
          filter={filterDialog.filter}
          scope={filterDialog.scope}
          allowScope={!!selected}
          dateRange={(chartFilterTarget?.dateRange ?? def.dateRange)}
          dateField={def.dateField}
          onApply={applyFilter}
          onRemove={
            filterDialog.filter
              ? () => {
                  const id = filterDialog.filter!.id;
                  setFilterDialog(null);
                  if (filterDialog.scope === "report") removeReportFilter(id);
                  else if (selected) setChart({ ...selected, filters: selected.filters.filter((f) => f.id !== id) });
                }
              : undefined
          }
          onClose={() => setFilterDialog(null)}
        />
      )}
      {calcDialog && (
        <CalcDialog measures={source.measures} field={calcDialog.field} onSave={saveCalc} onDelete={calcDialog.field ? () => deleteCalc(calcDialog.field!.id) : undefined} onClose={() => setCalcDialog(null)} />
      )}
      {shareOpen && (
        <ShareDialog
          reportId={report.id}
          reportName={doc.name}
          shares={shares}
          onClose={() => setShareOpen(false)}
          onShared={(words, list) => {
            setShareOpen(false);
            setShares(list);
            setSharedWith(words);
            show(`Sharing saved — ${words.toLowerCase()}`);
          }}
        />
      )}
      {leaving && (
        <Dialog open onClose={() => setLeaving(null)} title="Leave without saving?">
          <p className="text-[13.5px] text-muted">You have changes to “{doc.name}” that aren&apos;t saved. Leaving now loses them.</p>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setLeaving(null)}>
              Keep editing
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                const href = leaving;
                setLeaving(null);
                router.push(href);
              }}
            >
              Discard changes
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={async () => {
                const href = leaving;
                if (await save()) {
                  setLeaving(null);
                  router.push(href);
                } else setLeaving(null);
              }}
            >
              Save and leave
            </Button>
          </div>
        </Dialog>
      )}
      <Toast toast={toast} onClose={clear} />
      {preview && (
        <div className="border-t border-line px-4 py-2 text-[12.5px] text-muted">
          Previewing as it will look to viewers. Clicking a bar or slice filters the page in the{" "}
          <button type="button" onClick={() => go(`/reports/${report.id}`)} className="font-medium text-brand hover:underline">
            report viewer
          </button>
          .
        </div>
      )}
    </div>
  );
}

function EmptyPage({ onAdd }: { onAdd: (k: ChartKind) => void }) {
  return (
    <div className="grid place-items-center rounded-xl border border-dashed border-line-strong bg-surface px-6 py-16 text-center">
      <p className="text-[15px] font-semibold text-text">This page has no charts yet</p>
      <p className="mt-1 max-w-md text-[13px] text-muted">Pick a kind of chart to start, or click a field on the left — a metric starts a score, a dimension a chart broken down by it.</p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {(["score", "column", "line", "bar", "donut", "table"] as const).map((k) => {
          const Icon = KIND_ICONS[k];
          return (
            <Button key={k} type="button" variant="secondary" size="sm" onClick={() => onAdd(k)}>
              <Icon className="h-4 w-4" />
              {CHART_KIND_LABELS[k]}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
