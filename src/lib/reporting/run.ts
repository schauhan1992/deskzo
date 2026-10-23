import { workspaceClock } from "@/lib/time/workspace";
import { logActivity } from "@/lib/activity";
import { reportWindow } from "@/lib/analytics/request";
import { resolveDateColumn, ROW_CAP } from "@/lib/analytics/types";
import { notMigratedYet } from "@/lib/not-migrated";
import { applyFilters, ChartConfigError, chartFieldProblem, compileCalculated, reportProblem, runChart } from "./engine";
import { openSource, type ModuleOn, type OpenSource } from "./sources";
import { compareDays, rangeDays, type DayWindow } from "./window";
import type { DateRange, ReportChart, ReportDefinition, ReportFilter } from "./definition";
import type { ChartRun } from "./result";

/**
 * Running a report's charts as one person (Reporting & Analytics, owner 23 Oct 2026).
 *
 * The person is whoever is looking — the builder, the viewer, somebody a report was shared with — and every row
 * comes through their own access to the source (./sources.ts openSource → the source's own rule). A shared report
 * therefore never widens anybody's access: the same definition shows each person the rows their own role allows,
 * and a chart naming a field they can't see refuses, in words that don't name it.
 *
 * One window is loaded once however many charts read it; a score's comparison period is one more load. Logged as
 * a bulk read like every report (src/lib/analytics/request.ts runReportAs). Server only.
 */

export type RunRequest = {
  definition: ReportDefinition;
  /** Which charts to run; all of the definition's when left out. */
  chartIds?: string[];
  /** Clicked in the viewer — a bar, a slice — narrowing every chart, never saved. */
  crossFilters?: ReportFilter[];
  /** The viewer's own range for this look, instead of the report's. */
  dateRange?: DateRange;
  /** Who ran it for the activity log: the report's name. */
  reportName?: string;
};

export type RunOutcome =
  | {
      ok: true;
      charts: Record<string, ChartRun>;
      window: DayWindow | null;
      scopeNote: string;
      /** Every row read, comparison periods included — what the activity log counts. */
      rows: number;
      /** The rows in the report's own window before any filter, when this run read it: "99 rows in range". */
      windowRows: number | null;
      truncated: boolean;
    }
  | { ok: false; error: string; code: "denied" | "field" | "migrate" | "source" };

export async function runDefinition(user: { id: string; name: string }, req: RunRequest, moduleOn: ModuleOn): Promise<RunOutcome> {
  const def = req.definition;
  const found = await openSource(def.source, user.id, moduleOn);
  if (!found.ok) return { ok: false, error: found.error, code: found.locked ? "denied" : "source" };
  return runOpen(user, found.open, req);
}

export async function runOpen(user: { id: string; name: string }, open: OpenSource, req: RunRequest): Promise<RunOutcome> {
  const { source, entry } = open;
  const def = req.definition;
  const extra = req.crossFilters ?? [];
  const refused = reportProblem(source, { ...def, filters: [...def.filters, ...extra] });
  if (refused) return { ok: false, error: refused, code: "field" };

  const clock = await workspaceClock();
  const today = clock.today();
  const snapshot = !!entry.snapshot;
  const dateField = source.dateFields.find((f) => f.key === def.dateField) ?? source.dateFields[0]!;
  const dateColumn = resolveDateColumn(source, dateField.key);
  const calc = compileCalculated(source, def.calculated);
  const reportRange = req.dateRange ?? def.dateRange;
  const mainWindow = rangeDays(reportRange, today);

  const loads = new Map<string, Promise<never[]>>();
  let loaded = 0;
  let truncated = false;
  const rowsFor = (win: { from: string; to: string }): Promise<never[]> => {
    const key = snapshot ? "snapshot" : `${win.from}|${win.to}`;
    if (!loads.has(key)) {
      const bounds = reportWindow(clock, win.from, win.to);
      if ("error" in bounds) throw new ChartConfigError(bounds.error);
      loads.set(
        key,
        source.load({ userId: user.id, from: bounds.from, to: bounds.to, dateColumn }).then((rows) => {
          loaded += rows.length;
          if (rows.length >= ROW_CAP) truncated = true;
          return rows;
        }),
      );
    }
    return loads.get(key)!;
  };
  const instants = (win: { from: string; to: string }) => {
    const b = reportWindow(clock, win.from, win.to);
    if ("error" in b) throw new ChartConfigError(b.error);
    return b;
  };

  const wanted = new Set(req.chartIds ?? []);
  const charts: ReportChart[] = def.pages.flatMap((p) => p.charts).filter((c) => wanted.size === 0 || wanted.has(c.id));
  const out: Record<string, ChartRun> = {};

  try {
    await Promise.all(
      charts.map(async (chart) => {
        const problem = chartFieldProblem(source, chart, def.calculated, { snapshot });
        if (problem) {
          out[chart.id] = { ok: false, error: problem, code: "field" };
          return;
        }
        try {
          const win = chart.dateRange && !snapshot ? rangeDays(chart.dateRange, today) : mainWindow;
          const filters = [...def.filters, ...extra, ...chart.filters];
          const rows = applyFilters(source, await rowsFor(win), filters);
          let compareRows: never[] | null = null;
          let compareLabel: string | null = null;
          if (chart.type === "score" && chart.compare !== "none" && !snapshot) {
            const back = compareDays(win, chart.compare);
            compareRows = applyFilters(source, await rowsFor(back), filters);
            compareLabel = back.against;
          }
          const result = runChart({
            source,
            rows,
            chart,
            calc,
            clock,
            dateGet: dateField.get as (row: never) => Date | null,
            dateLabel: dateField.label,
            window: instants(win),
            compareRows,
            compareLabel,
            snapshot,
          });
          out[chart.id] = { ok: true, result, rowCount: rows.length, truncated, scopeNote: "" };
        } catch (err) {
          if (err instanceof ChartConfigError) out[chart.id] = { ok: false, error: err.message, code: "config" };
          else throw err;
        }
      }),
    );
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: "This report will work once your workspace has the latest update.", code: "migrate" };
    throw err;
  }

  const scopeNote = await source.scopeNote({ userId: user.id, from: new Date(), to: new Date(), dateColumn });
  for (const run of Object.values(out)) if (run.ok) run.scopeNote = scopeNote;

  // A report is the largest read in the application — logged like every other bulk read (src/lib/analytics/request.ts).
  if (loaded > 0) {
    await logActivity({
      kind: "SEARCH",
      severity: "INFO",
      summary: `${user.name} ran ${req.reportName ? `the report “${req.reportName}”` : `a ${entry.label.toLowerCase()} report`} over ${loaded.toLocaleString("en-IN")} rows`,
      metadata: { source: entry.key, charts: charts.length, rows: loaded, truncated },
    });
  }

  const mainLoad = loads.get(snapshot ? "snapshot" : `${mainWindow.from}|${mainWindow.to}`);
  const windowRows = mainLoad ? (await mainLoad).length : null;
  return { ok: true, charts: out, window: snapshot ? null : mainWindow, scopeNote, rows: loaded, windowRows, truncated };
}
