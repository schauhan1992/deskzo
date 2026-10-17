"use server";

import { workspaceClock } from "@/lib/time/workspace";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { isModuleEnabled } from "@/actions/module";
import { logActivity } from "@/lib/activity";
import { FACT_SOURCES } from "@/lib/analytics/sources";
import { effectiveSource } from "@/lib/analytics/custom";
import { dimensionOptions, type ReportResult } from "@/lib/analytics/run";
import { GRAINS, ROW_CAP, resolveDateColumn } from "@/lib/analytics/types";
import { csvRow } from "@/lib/csv";
import type { WorkbookFilters } from "@/lib/workspace/filters";
import type { ActionResult } from "@/actions/company";
import { reportWindow, runReportAs, sourceFor, type ReportRequest } from "@/lib/analytics/request";

export type { ReportRequest } from "@/lib/analytics/request";

/**
 * Running a report.
 *
 * The scoping is not here. Each source owns it — see the note at the top of lib/analytics/types.ts
 * — and this file's job is to check the module is on, hand the source a window, and log that a
 * large read happened. Putting a `where` clause in this file would be the beginning of a second
 * scoping rule, which is the thing the design is built to avoid.
 */

export type SourceOption = {
  key: string;
  label: string;
  description: string;
  companyAnchored: boolean;
  measures: { key: string; label: string; description?: string; average?: boolean; custom?: boolean }[];
  dimensions: { key: string; label: string; multi?: boolean; custom?: boolean }[];
  dateFields: { key: string; label: string }[];
};

/** Every source this person can actually run, with everything it can be sliced by. */
export async function reportOptions(): Promise<{ sources: SourceOption[]; grains: typeof GRAINS }> {
  const user = await requireModuleUser("reports");
  const enabled = await Promise.all(
    FACT_SOURCES.map(async (s) => (s.moduleKey === null ? true : isModuleEnabled(s.moduleKey))),
  );
  // Each with the workspace's own fields this person may report by — src/lib/analytics/custom.ts.
  const effective = await Promise.all(FACT_SOURCES.filter((_, i) => enabled[i]).map((s) => effectiveSource(s, user.id)));
  const sources = effective.map((s) => ({
    key: s.key,
    label: s.label,
    description: s.description,
    companyAnchored: s.companyAnchored,
    // `average` travels with the measure because two things downstream need it and neither can
    // work it out: the Share chart is undefined for an average, and the header that labels the
    // figure "Total" is saying the wrong word for one.
    measures: s.measures.map((m) => ({
      key: m.key,
      label: m.label,
      description: m.description,
      average: m.average === true,
      custom: m.custom,
    })),
    // `custom` so the explorer can put the workspace's own fields under a heading of their own.
    dimensions: s.dimensions.map((d) => ({ key: d.key, label: d.label, multi: d.multi, custom: d.custom })),
    dateFields: s.dateFields.map((d) => ({ key: d.key, label: d.label })),
  }));
  return { sources, grains: GRAINS };
}

/**
 * What you can narrow a report to, before you run it.
 *
 * The engine has always been able to filter on any dimension — `runReport` applies them and reports
 * what they dropped — but the only way to *set* one was to run a report and click a value in the
 * result. That answers "now show me only AutoCAD" and not "show me AutoCAD", which is the question
 * people actually arrive with: a product, a city, a date range, run.
 *
 * So the values are offered up front. Same load, same scope, same bucketing as the report itself —
 * which matters, because a panel built from a separate query could offer a brand the report would
 * then show nothing for, or name an account this person is not allowed to see.
 *
 * It is a full load of the window, so it is not free. Called when the panel opens and when the
 * source or the dates change, not on every keystroke.
 */
export async function reportFilterOptions(input: {
  source: string;
  from: string;
  to: string;
  /** The "Dated on" field, so the panel loads the window the report would. */
  dateField?: string;
  companyFilters?: WorkbookFilters;
}): Promise<
  ActionResult<{
    values: Record<string, string[]>;
    /** How many values each dimension really has — `values` is capped, this is not. */
    counts: Record<string, number>;
    rowCount: number;
    capped: boolean;
  }>
> {
  const user = await requireModuleUser("reports");
  const found = await sourceFor(input.source, user.id, isModuleEnabled);
  if (!found.ok) return found;
  const { source } = found;

  const window = reportWindow(await workspaceClock(), input.from, input.to);
  if ("error" in window) return { ok: false, error: window.error };

  const rows = await source.load({
    userId: user.id,
    from: window.from,
    to: window.to,
    companyFilters: input.companyFilters,
    // The panel offers values from the same rows the report would count, so it has to load the
    // same window on the same column — otherwise a filter could name a value the report never sees.
    dateColumn: resolveDateColumn(source, input.dateField),
  });

  return {
    ok: true,
    data: {
      ...dimensionOptions(source, rows),
      rowCount: rows.length,
      // At the ceiling the option lists are drawn from a slice of the window, so a value that
      // exists outside it will not be offered. Said rather than hidden.
      capped: rows.length >= ROW_CAP,
    },
  };
}

export async function runAnalyticsReport(input: ReportRequest): Promise<ActionResult<ReportResult>> {
  const user = await requireModuleUser("reports");
  const ran = await runReportAs(user, input, { moduleOn: isModuleEnabled });
  return ran.ok ? { ok: true, data: ran.data.result } : ran;
}

/** The table as it stands, for somebody who wants it in a spreadsheet. */
/**
 * Which export permission a report's data falls under.
 *
 * Money is a separate decision from customers, which is why the registry has two keys rather than
 * one — see `src/lib/portability/areas.ts`, where every CRM area maps to `data.exportCrm` and the
 * ledger areas to `data.exportFinance`.
 */
const EXPORT_PERMISSION: Record<string, "data.exportCrm" | "data.exportFinance"> = {
  orders: "data.exportCrm",
  leads: "data.exportCrm",
  tickets: "data.exportCrm",
  visits: "data.exportCrm",
  invoices: "data.exportFinance",
  payments: "data.exportFinance",
};

/**
 * A report as a file.
 *
 * Gated, and separately from viewing it. `data.exportCrm`'s own description states the rule this
 * implements: "export never widens visibility, it decides whether what you can see may leave the
 * building." This path did not ask. Anybody who could open the Reports page could take the whole
 * of what they could see out as a spreadsheet, while the Data screen next door refused the same
 * person the same rows — so the permission was real everywhere except the one place that produced
 * the largest file.
 *
 * Recorded as an EXPORT too. The security log treats volume as the one signal a scraper cannot
 * hide, and a download that logs only as a SEARCH is a download nobody reviewing that log can see.
 */
/**
 * Whether this person may take this report's rows out as a file — the CSV's rule, asked by the printed
 * sheet too, which shows every row only to somebody who may (src/lib/analytics/rows-shown.ts).
 */
export async function reportExportAllowed(source: string): Promise<boolean> {
  const user = await requireModuleUser("reports");
  const permission = EXPORT_PERMISSION[String(source ?? "")];
  return !!permission && (await can(user.id, permission));
}

export async function exportReportCsv(input: ReportRequest): Promise<ActionResult<{ filename: string; csv: string }>> {
  const user = await requireModuleUser("reports");
  const permission = EXPORT_PERMISSION[input.source];
  if (!permission) return { ok: false, error: "That report cannot be exported." };
  if (!(await can(user.id, permission))) {
    return {
      ok: false,
      error:
        permission === "data.exportFinance"
          ? "You can read this report but not download it. Downloading financial data needs the export permission."
          : "You can read this report but not download it. Downloading customer data needs the export permission.",
    };
  }

  const ran = await runReportAs(user, input, { moduleOn: isModuleEnabled });
  if (!ran.ok) return ran;
  // Labelled from the source the report ran against, the workspace's own fields included — so a
  // breakdown by one is headed "Customer · Region", not with its key.
  const { result, source } = ran.data;
  const labelOf = (key: string) => (key === "time" ? "Period" : (source.dimensions.find((d) => d.key === key)?.label ?? key));

  const { columns, rows } = result;
  const header = [labelOf(input.dimension)];
  if (columns.length > 1 || columns[0]?.key !== "__all__") header.push(...columns.map((c) => c.label));
  header.push("Total");

  // Why only the text cells are sanitised, and why it is not written here: see `csvRow`.
  const line = csvRow;

  const body = rows.map((r) => {
    const cells: (string | number)[] = [r.label];
    if (columns.length > 1 || columns[0]?.key !== "__all__") cells.push(...columns.map((c) => r.cells[c.key] ?? 0));
    cells.push(r.total);
    return line(cells);
  });

  /**
   * A few lines of context above the data.
   *
   * The file was the header and the rows and nothing else — so a spreadsheet of "AutoCAD, Kochi,
   * September" was indistinguishable from one of everything, and a total narrowed by four filters
   * looked like a total. A CSV is the artefact most likely to be forwarded and least likely to be
   * re-derived, which makes it the worst place to omit what it is a report *of*.
   *
   * Above the header rather than below the rows, and separated by a blank line: the data stays one
   * contiguous block starting at a header row, which is what anything parsing it needs, and anybody
   * opening it in Excel reads the provenance first.
   */
  const applied = Object.entries(input.filters ?? {})
    .filter(([, values]) => values.length > 0)
    .map(([key, values]) => `${labelOf(key)}: ${values.join(", ")}`);

  const context = [
    line(["Report", `${source.measures.find((m) => m.key === input.measure)?.label ?? input.measure} by ${labelOf(input.dimension)}`]),
    line(["Records", source.label]),
    line(["Dated on", source.dateFields.find((d) => d.key === input.dateField)?.label ?? input.dateField]),
    line(["Window", `${input.from} to ${input.to}`]),
    line(["Scope", result.scopeNote]),
    line(["Run by", user.name]),
    ...(applied.length > 0 ? [line(["Filtered to", applied.join(" · ")])] : []),
    ...(result.filteredOut > 0 ? [line(["Rows excluded by filters", result.filteredOut])] : []),
    // The two caveats that change what the numbers mean. Omitting them from the file while showing
    // them on screen is how a floor gets forwarded as a total.
    ...(result.truncated ? [line(["Warning", "Hit the row ceiling — these are floors, not totals."])] : []),
    ...(result.doubleCounted
      ? [line(["Warning", "A record can fall in more than one row, so the rows and the column totals add up to more than the total."])]
      : []),
    "",
  ];

  await logActivity({
    kind: "EXPORT",
    severity: "WARNING",
    summary: `${user.name} downloaded a ${input.source} report — ${rows.length} row(s) over ${result.rowCount.toLocaleString("en-IN")} records`,
    metadata: {
      source: input.source,
      measure: input.measure,
      by: input.dimension,
      rows: rows.length,
      records: result.rowCount,
      from: input.from,
      to: input.to,
    },
  });

  return {
    ok: true,
    data: {
      // A field's key carries colons ("cf:company:region"), which no file name on Windows may.
      filename: `${input.source}-by-${input.dimension.replace(/[^a-z0-9_-]+/gi, "-")}-${input.from}-to-${input.to}.csv`,
      csv: [...context, line(header), ...body].join("\n"),
    },
  };
}
