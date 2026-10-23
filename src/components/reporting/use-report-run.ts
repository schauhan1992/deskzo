"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { runReport } from "@/actions/reporting";
import { chartProblem, type DateRange, type ReportChart, type ReportDefinition, type ReportFilter } from "@/lib/reporting/definition";
import type { ChartRun } from "@/lib/reporting/result";
import type { DayWindow } from "@/lib/reporting/window";

/**
 * A report's charts, run on the server as the person looking (src/actions/reporting.ts runReport).
 *
 * Each chart's figures are kept against what decides them — the report's source, window and filters, and the
 * chart's own fields — so renaming a chart, resizing it or undoing back to where it was costs no request, and
 * adding a chart runs that chart alone. A chart that isn't set up yet is never sent.
 *
 * From the builder the unsaved definition is sent (`sendDefinition`); the viewer sends only the report's id, so
 * whoever opens a shared report gets the one its owner saved, run through their own access.
 */

type Meta = { window: DayWindow | null; scopeNote: string; windowRows: number | null; truncated: boolean; at: number };

/** The parts of a chart that change its figures; not its title, width or legend. */
function chartKey(c: ReportChart) {
  return JSON.stringify([c.type, c.dimension, c.grain, c.series, c.metrics, c.sort, c.limit, c.dateRange, c.filters, c.compare]);
}

const KEEP = 160;

export function useReportRun({
  reportId,
  definition,
  charts,
  sendDefinition,
  crossFilters,
  dateRange,
}: {
  reportId?: string;
  definition: ReportDefinition;
  charts: ReportChart[];
  sendDefinition: boolean;
  crossFilters?: ReportFilter[];
  dateRange?: DateRange;
}) {
  const [cache, setCache] = useState<Record<string, ChartRun>>({});
  const [meta, setMeta] = useState<Meta | null>(null);
  const [busy, setBusy] = useState(false);

  const reportKey = JSON.stringify([definition.source, definition.dateField, definition.dateRange, definition.filters, definition.calculated, crossFilters ?? [], dateRange ?? null]);
  const keyed = useMemo(() => charts.map((c) => ({ chart: c, key: `${reportKey}|${c.id}|${chartKey(c)}`, problem: chartProblem(c) })), [charts, reportKey]);
  const missing = keyed.filter((k) => !k.problem && !(k.key in cache));
  const missingKey = missing.map((m) => m.key).join("\n");

  useEffect(() => {
    if (!missingKey) return;
    let live = true;
    const wanted = missing;
    const timer = setTimeout(() => {
      setBusy(true);
      runReport({ reportId, definition: sendDefinition ? definition : undefined, chartIds: wanted.map((w) => w.chart.id), crossFilters, dateRange })
        .then((res) => {
          const fill: Record<string, ChartRun> = {};
          if (res.ok) {
            for (const w of wanted) fill[w.key] = res.charts[w.chart.id] ?? { ok: false, error: "This chart couldn't be run.", code: "source" };
            setMeta((prev) => ({ window: res.window, scopeNote: res.scopeNote, windowRows: res.windowRows ?? (prev && prev.window?.label === res.window?.label ? prev.windowRows : null), truncated: res.truncated, at: Date.now() }));
          } else {
            for (const w of wanted) fill[w.key] = { ok: false, error: res.error, code: res.code === "migrate" ? "migrate" : res.code === "denied" ? "denied" : res.code === "field" ? "field" : "source" };
          }
          setCache((prev) => Object.fromEntries([...Object.entries(prev), ...Object.entries(fill)].slice(-KEEP)));
        })
        .catch(() => {
          const fill: Record<string, ChartRun> = {};
          for (const w of wanted) fill[w.key] = { ok: false, error: "The data couldn't be loaded. Check your connection and retry.", code: "source" };
          if (live) setCache((prev) => ({ ...prev, ...fill }));
        })
        .finally(() => live && setBusy(false));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `missingKey` carries everything the request depends on; the objects themselves change identity every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingKey]);

  const runs: Record<string, ChartRun | "loading"> = {};
  for (const k of keyed) runs[k.chart.id] = k.problem ? { ok: false, error: k.problem, code: "config" } : (cache[k.key] ?? "loading");

  /** Run again whatever failed for a reason other than its setup — a source that was down, a lost connection. */
  const retry = useCallback(() => {
    setCache((prev) => Object.fromEntries(Object.entries(prev).filter(([, r]) => r.ok || r.code === "config" || r.code === "field")));
  }, []);
  /** Forget everything and run again — the viewer's refresh. */
  const refresh = useCallback(() => setCache({}), []);

  return { runs, meta, busy: busy || missing.length > 0, retry, refresh };
}
