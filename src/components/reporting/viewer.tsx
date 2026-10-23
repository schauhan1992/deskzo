"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { ChevronRight, Download, Ellipsis, Pencil, RefreshCw, Share2, SlidersHorizontal, Star, X } from "lucide-react";
import { exportReportChart, setReportFavourite, type OpenedReport } from "@/actions/reporting";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel } from "@/components/ui/menu";
import { cn } from "@/lib/utils";
import { DATE_PRESET_LABELS, type DateRange, type ReportChart, type ReportFilter } from "@/lib/reporting/definition";
import { OTHER } from "@/lib/reporting/result";
import { rangeDays } from "@/lib/reporting/window";
import { ChartCard, chartNote } from "./chart-card";
import { chartTitle, dimensionLabel, newId, type Source } from "./chart-ops";
import { FilterChip } from "./builder-panels";
import { DateRangeMenu, Toast, downloadCsv, useToast } from "./controls";
import { FilterEditor, filterWords } from "./filter-editor";
import { ShareDialog, type ShareEntry } from "./share-dialog";
import { useReportRun } from "./use-report-run";

/**
 * A saved report, read (Reporting & Analytics, the approved design's 1d; on a phone 1t–1u).
 *
 * The report as its owner saved it, run as whoever is looking. What a reader changes here is theirs for this look
 * and is never saved: another date range, a filter of their own, or a bar clicked to narrow every chart on the page
 * to it (a cross-filter). The server runs the stored definition, not anything this page sends, so a reader can
 * narrow a report but never widen it.
 */

const subscribeNothing = () => () => {};
/** A reader's own filters, with room for one clicked bar — the server takes ten at once (runReport). */
const MAX_OWN_FILTERS = 9;
const timeOf = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

export function ReportViewer({ report, source, today, openShare = false }: { report: OpenedReport; source: Source; today: string; openShare?: boolean }) {
  const isClient = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const def = report.definition;
  const [pageId, setPageId] = useState(def.pages[0]!.id);
  const page = def.pages.find((p) => p.id === pageId) ?? def.pages[0]!;
  const [range, setRange] = useState<DateRange | null>(null);
  /** The reader's own narrowing, never saved: filters they added and a bar or slice they clicked. */
  const [mine, setMine] = useState<ReportFilter[]>([]);
  const [picked, setPicked] = useState<{ chartId: string; filter: ReportFilter; label: string } | null>(null);
  const [adding, setAdding] = useState<ReportFilter | "new" | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [favourite, setFavourite] = useState(report.favourite);
  const [shareOpen, setShareOpen] = useState(openShare);
  const [shares, setShares] = useState<ShareEntry[]>(report.shares.map((s) => ({ userId: s.userId, departmentId: s.departmentId, name: s.name, canEdit: s.canEdit })));
  const [sharedWith, setSharedWith] = useState(report.sharedWith);
  const { toast, show, clear } = useToast();

  const crossFilters = [...mine, ...(picked ? [picked.filter] : [])];
  const { runs, meta, busy, retry, refresh } = useReportRun({ reportId: report.id, definition: def, charts: page.charts, sendDefinition: false, crossFilters, dateRange: range ?? undefined });
  const shownRange = range ?? def.dateRange;
  const canEdit = report.access !== "view";
  const narrowed = mine.length + (picked ? 1 : 0) + (range ? 1 : 0);

  function pick(chart: ReportChart, dimension: string, value: string) {
    if (value === OTHER) return;
    if (picked?.chartId === chart.id && picked.filter.values?.[0] === value) return setPicked(null);
    setPicked({ chartId: chart.id, label: `${dimensionLabel(dimension, source, def)}: ${value}`, filter: { id: newId("x"), field: dimension, op: "in", values: [value] } });
  }

  async function exportChart(chart: ReportChart) {
    try {
      const res = await exportReportChart({ reportId: report.id, chartId: chart.id, crossFilters: crossFilters.length ? crossFilters : undefined, dateRange: range ?? undefined });
      if (!res.ok) return show(res.error, { failed: true });
      downloadCsv(res.data.filename, res.data.csv);
      show(`Downloaded “${chartTitle(chart, source, def)}”`);
    } catch {
      show("The download failed. Try again.", { failed: true });
    }
  }

  async function toggleFavourite() {
    const next = !favourite;
    setFavourite(next);
    const res = await setReportFavourite(report.id, next).catch(() => null);
    if (!res?.ok) {
      setFavourite(!next);
      show(res?.error ?? "Couldn't update favourites.", { failed: true });
    } else show(next ? "Added to favourites" : "Removed from favourites");
  }

  const filterBar = (
    <>
      {def.filters.map((f) => (
        <FilterChip key={f.id} text={filterWords(f, source)} />
      ))}
      {mine.map((f) => (
        <FilterChip key={f.id} text={filterWords(f, source)} onEdit={() => setAdding(f)} onRemove={() => setMine(mine.filter((x) => x.id !== f.id))} />
      ))}
      {picked && <FilterChip tone="cross" text={picked.label} onRemove={() => setPicked(null)} />}
      {mine.length < MAX_OWN_FILTERS && (
        <button type="button" onClick={() => setAdding("new")} className="inline-flex h-8 items-center rounded-full border border-dashed border-line-strong px-3 text-[12.5px] text-muted hover:border-brand hover:text-brand">
          Add filter
        </button>
      )}
      {narrowed > 0 && (
        <button type="button" onClick={() => (setMine([]), setPicked(null), setRange(null))} className="text-[12.5px] text-muted underline hover:text-text">
          Reset
        </button>
      )}
    </>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-[12.5px] text-muted">
            <Link href="/reports" className="hover:text-text hover:underline">
              Reports
            </Link>
            <ChevronRight className="h-3 w-3 text-subtle" />
            <Link href={report.access === "owner" ? "/reports/library" : "/reports/shared"} className="hover:text-text hover:underline">
              {report.access === "owner" ? "My reports" : "Shared with me"}
            </Link>
          </nav>
          <h1 className="mt-1 flex items-center gap-2 text-[22px] font-semibold text-text">
            <span className="truncate">{report.name}</span>
            <button type="button" onClick={toggleFavourite} aria-pressed={favourite} aria-label={favourite ? "Remove from favourites" : "Add to favourites"} className="grid h-8 w-8 shrink-0 place-items-center rounded-md hover:bg-surface-sunken">
              <Star className={cn("h-[18px] w-[18px]", favourite ? "fill-warning text-warning" : "text-subtle")} />
            </button>
          </h1>
          {report.description && <p className="mt-0.5 max-w-3xl text-[13.5px] text-muted">{report.description}</p>}
          <p className="mt-1 text-[12px] text-subtle">
            {source.group} · {source.label} · {report.access === "owner" ? sharedWith : `Shared by ${report.owner.name}`}
            {isClient && ` · Edited ${timeOf(report.updatedAt)}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Menu label="Export" width={280}>
            {(close) => (
              <>
                <MenuLabel>Download a chart as CSV</MenuLabel>
                {!report.canExport ? (
                  <p className="px-3 pb-2 text-[12.5px] text-muted">You can read this report but not download it. Downloading this data needs the export permission.</p>
                ) : (
                  page.charts.map((c) => (
                    <MenuItem key={c.id} onClick={() => (close(), void exportChart(c))}>
                      {chartTitle(c, source, def)}
                    </MenuItem>
                  ))
                )}
                {report.canExport && narrowed > 0 && <p className="border-t border-line px-3 py-2 text-[12px] text-subtle">Downloads the figures as narrowed on screen.</p>}
              </>
            )}
          </Menu>
          {report.access === "owner" && (
            <Button type="button" variant="secondary" onClick={() => setShareOpen(true)}>
              <Share2 className="h-4 w-4" />
              Share
            </Button>
          )}
          {canEdit && (
            <Link href={`/reports/${report.id}/edit`} className="inline-flex h-9 items-center gap-1.5 rounded-base bg-brand px-3.5 text-sm font-medium text-brand-contrast shadow-sm hover:brightness-110">
              <Pencil className="h-4 w-4" />
              Edit report
            </Link>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-line">
        <div className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto" role="tablist" aria-label="Pages">
          {def.pages.map((p) => (
            <button
              key={p.id}
              role="tab"
              type="button"
              aria-selected={p.id === page.id}
              onClick={() => (setPageId(p.id), setPicked(null))}
              className={cn("h-10 shrink-0 border-b-2 px-3 text-[13.5px] font-medium", p.id === page.id ? "border-brand text-text" : "border-transparent text-muted hover:text-text")}
            >
              {p.name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 pb-1.5">
          {!source.snapshot && (
            <div className="hidden sm:block">
              <DateRangeMenu value={shownRange} today={today} onChange={(r) => setRange(r)} />
            </div>
          )}
          <button type="button" onClick={() => setDrawer(true)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] text-text hover:bg-surface-sunken sm:hidden">
            <SlidersHorizontal className="h-4 w-4" />
            Filters{narrowed + def.filters.length ? ` (${narrowed + def.filters.length})` : ""}
          </button>
          <button type="button" onClick={refresh} aria-label="Refresh figures" title="Refresh figures" className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-surface-sunken">
            <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} />
          </button>
        </div>
      </div>

      <div className="hidden flex-wrap items-center gap-2 sm:flex">
        <span className="text-[12.5px] text-muted">Filters</span>
        {filterBar}
      </div>
      {picked && (
        <p className="flex items-center gap-2 text-[12.5px] text-brand sm:hidden">
          Showing {picked.label}
          <button type="button" onClick={() => setPicked(null)} className="underline">
            Reset
          </button>
        </p>
      )}

      <p className="text-[12px] text-subtle">
        {meta?.window ? meta.window.label : source.snapshot ? "As of today" : rangeDays(shownRange, today).label}
        {meta?.scopeNote ? ` · ${meta.scopeNote}` : ""}
        {range ? ` · Your range for this look (the report's own is ${DATE_PRESET_LABELS[def.dateRange.preset].toLowerCase()})` : ""}
      </p>

      <div className="@container">
        {page.charts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line-strong px-6 py-14 text-center">
            <p className="text-[15px] font-semibold text-text">This page has no charts</p>
            <p className="mt-1 text-[13px] text-muted">{canEdit ? "Add some in the builder." : "Its owner hasn't added any yet."}</p>
          </div>
        ) : (
          <div className="grid grid-cols-12 gap-4">
            {page.charts.map((c) => (
              <ChartCard
                key={c.id}
                chart={c}
                title={chartTitle(c, source, def)}
                run={runs[c.id]}
                note={chartNote(runs[c.id])}
                onPick={(dim, value) => pick(c, dim, value)}
                picked={picked?.chartId === c.id ? (picked.filter.values?.[0] ?? null) : null}
                menu={
                  <Menu label={`Options for ${chartTitle(c, source, def)}`} icon={Ellipsis} width={200}>
                    {(close) => (
                      <MenuItem disabled={!report.canExport} onClick={() => (close(), void exportChart(c))}>
                        <span className="inline-flex items-center gap-2">
                          <Download className="h-4 w-4 text-subtle" />
                          {report.canExport ? "Download CSV" : "Download needs permission"}
                        </span>
                      </MenuItem>
                    )}
                  </Menu>
                }
              />
            ))}
          </div>
        )}
      </div>
      {page.charts.some((c) => {
        const r = runs[c.id];
        return r && r !== "loading" && !r.ok && (r.code === "source" || r.code === "migrate");
      }) && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger-bg px-4 py-2.5 text-[13px] text-danger">
          Some charts couldn&apos;t load their data.
          <Button type="button" size="sm" variant="secondary" onClick={retry}>
            Retry
          </Button>
        </div>
      )}
      {page.charts.some((c) => c.filters.length > 0) && <p className="text-[12px] text-subtle">A chart marked “chart filter” has filters of its own, on top of the report&apos;s.</p>}

      {drawer && (
        <div className="fixed inset-0 z-50 sm:hidden" role="dialog" aria-modal="true" aria-label="Filters">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
          <div className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-2xl bg-surface p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[15px] font-semibold text-text">Filters</p>
              <button type="button" aria-label="Close filters" onClick={() => setDrawer(false)} className="grid h-8 w-8 place-items-center rounded-md text-subtle">
                <X className="h-4 w-4" />
              </button>
            </div>
            {!source.snapshot && (
              <div className="mb-3">
                <p className="mb-1 text-[12.5px] font-medium text-text">Date range</p>
                <DateRangeMenu value={shownRange} today={today} onChange={(r) => setRange(r)} align="start" />
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">{filterBar}</div>
            <Button type="button" className="mt-4 w-full" onClick={() => setDrawer(false)}>
              Show results
            </Button>
          </div>
        </div>
      )}

      {adding && (
        <FilterEditor
          source={source}
          filter={adding === "new" ? null : adding}
          scope="report"
          allowScope={false}
          dateRange={shownRange}
          dateField={def.dateField}
          onApply={(f) => {
            setMine((list) => (list.some((x) => x.id === f.id) ? list.map((x) => (x.id === f.id ? f : x)) : [...list, f]));
            setAdding(null);
          }}
          onRemove={adding !== "new" ? () => (setMine(mine.filter((x) => x.id !== adding.id)), setAdding(null)) : undefined}
          onClose={() => setAdding(null)}
        />
      )}
      {/* Opened by `?share=1` from the library: drawn once in the browser — a dialog portals into the page's body. */}
      {shareOpen && isClient && (
        <ShareDialog
          reportId={report.id}
          reportName={report.name}
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
      <Toast toast={toast} onClose={clear} />
    </div>
  );
}
