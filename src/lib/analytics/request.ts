import { workspaceClock } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";
import { logActivity } from "@/lib/activity";
import { getSource } from "@/lib/analytics/sources";
import { effectiveSource } from "@/lib/analytics/custom";
import { runReport, type ReportResult } from "@/lib/analytics/run";
import { resolveDateColumn, type FactSource, type Grain } from "@/lib/analytics/types";
import type { WorkbookFilters } from "@/lib/workspace/filters";
import type { ActionResult } from "@/actions/company";

/**
 * A report request, and running one as a person — for the Reports screens (src/actions/analytics.ts)
 * and for Automate's emailed reports (src/lib/automate/actions/report-email.ts), so both refuse, scope
 * and log a report the same way. The scoping itself is each source's own (src/lib/analytics/types.ts).
 *
 * Whether a module is on for the person is asked through `moduleOn`: the signed-in person's own
 * (`isModuleEnabled`) on the screens, `moduleAccessFor` for somebody a workflow emails.
 */

export type ModuleOn = (key: string) => Promise<boolean>;

export type RunOptions = {
  moduleOn: ModuleOn;
  /**
   * For a run with no session — a workflow emailing a report — the person it was run for is named on
   * the activity log rather than the session, and `byline` says who ran it: "by workflow “Weekly”".
   */
  attributeTo?: boolean;
  byline?: string;
};

export type ReportRequest = {
  source: string;
  measure: string;
  dimension: string;
  column?: string;
  grain: Grain;
  dateField: string;
  from: string;
  to: string;
  /** Narrows the query — the same filter set the workspace lists use. */
  companyFilters?: WorkbookFilters;
  /** Narrows what came back, by any dimension of this source. */
  filters?: Record<string, string[]>;
};

/**
 * The source a request names, as this person may report on it: its module on, and the workspace's
 * own fields theirs to see added to it (src/lib/analytics/custom.ts). Every report starts here, so the
 * explorer, the filter panel, the CSV, the printed sheet, the Copilot and an emailed report see one source.
 */
export async function sourceFor(key: string, userId: string, moduleOn: ModuleOn): Promise<{ ok: true; source: FactSource<never> } | { ok: false; error: string }> {
  const source = getSource(key);
  if (!source) return { ok: false, error: "Unknown report." };
  if (source.moduleKey && !(await moduleOn(source.moduleKey))) {
    return { ok: false, error: `The ${source.label} module is switched off.` };
  }
  return { ok: true, source: await effectiveSource(source, userId) };
}

/**
 * The two dates off the form, as the instants the workspace means by them — its days, on its clock.
 *
 * This was `new Date(input.from)` and `to.setHours(23, 59, 59, 999)`, which is wrong twice over:
 *
 *   · A date-only string is parsed as **UTC** midnight, so "2026-09-01" was 05:30 IST on the 1st —
 *     wrong on every machine, Indian laptops included. Orders punched in the first five and a half
 *     hours of the opening day were simply absent, and no total said so.
 *   · `setHours` writes the **host's** clock, so on a UTC server the closing bound landed at 05:29
 *     IST the *following* morning and swept in a chunk of the next month.
 *
 * Both ends now come from the workspace's clock (src/lib/time/zone.ts). `to` is the midnight that
 * *begins* the day after the one asked for, which is why the sources compare with `lt` rather than
 * `lte` — an exclusive bound has no ".999 of a second" edge to fall through.
 */
export function reportWindow(clock: Clock, fromText: string, toText: string): { from: Date; to: Date } | { error: string } {
  const from = clock.startOfDay(fromText);
  const to = clock.endOfDay(toText);
  if (!from || !to) return { error: "That date range isn't valid." };
  if (from >= to) return { error: "The start date is after the end date." };
  return { from, to };
}

/**
 * The first thing in a request that this source doesn't offer this person, as the sentence to refuse
 * it with — or null when everything it names is there.
 *
 * The engine is lenient by design: an unknown measure falls back to the first one, an unknown
 * breakdown puts every row in a single "Total", an unknown filter keeps nothing. None of that
 * depends on the data behind the key, so none of it can leak a field — but each answers a different
 * question under the heading of the one asked. An old print link naming a restricted amount, opened
 * by somebody who may not see it, would print the order value as "cf:order:landed_cost by customer".
 *
 * So it is refused instead, and in the same words whether the thing never existed, was retired, or
 * is a field this person may not see — a refusal that told those apart would be a way of finding out
 * what the restricted fields are called. The key is the request's own, so naming it gives nothing away.
 */
export function unknownKey(source: FactSource<never>, input: ReportRequest): string | null {
  const breakdowns = new Set(["time", ...source.dimensions.map((d) => d.key)]);
  const missing = [
    ...(source.measures.some((m) => m.key === input.measure) ? [] : [input.measure]),
    ...[input.dimension, input.column].filter((key): key is string => !!key && !breakdowns.has(key)),
    // An empty list filters nothing (runReport skips it), so it is not a question about that key.
    ...Object.entries(input.filters ?? {})
      .filter(([key, values]) => values.length > 0 && !breakdowns.has(key))
      .map(([key]) => key),
  ];
  if (missing.length === 0) return null;
  return `“${missing[0]}” isn't something you can report ${source.label.toLowerCase()} by — it may have been removed, or not be open to you.`;
}

/**
 * A report, run as this person, with the source it was run against — the export needs that source's
 * labels, and building it a second time could disagree with the first if a field changed in between.
 */
export async function runReportAs(
  user: { id: string; name: string },
  input: ReportRequest,
  options: RunOptions,
): Promise<ActionResult<{ result: ReportResult; source: FactSource<never> }>> {
  const found = await sourceFor(input.source, user.id, options.moduleOn);
  if (!found.ok) return found;
  const { source } = found;
  const refused = unknownKey(source, input);
  if (refused) return { ok: false, error: refused };

  const clock = await workspaceClock();
  const window = reportWindow(clock, input.from, input.to);
  if ("error" in window) return { ok: false, error: window.error };
  const { from, to } = window;

  const ctx = {
    userId: user.id,
    from,
    to,
    companyFilters: input.companyFilters,
    // The column the "Dated on" control names. Resolved here because this is where the source and
    // the request are both in hand — see resolveDateColumn.
    dateColumn: resolveDateColumn(source, input.dateField),
  };
  const rows = await source.load(ctx);

  const result = runReport({
    source,
    rows,
    measureKey: input.measure,
    dimensionKey: input.dimension,
    columnKey: input.column,
    grain: input.grain,
    // Time buckets are the workspace's days, weeks and months.
    clock,
    dateKey: input.dateField,
    filters: input.filters,
    scopeNote: await source.scopeNote(ctx),
  });

  // A report is the largest read in the application — thousands of rows, deliberately, across every
  // account somebody can see. The DLP layer treats volume as the one signal a scraper cannot hide,
  // so this is recorded like any other bulk read rather than being exempt for being a feature.
  await logActivity({
    ...(options.attributeTo ? { userId: user.id, userName: user.name } : {}),
    kind: "SEARCH",
    severity: "INFO",
    summary: options.byline
      ? `A ${source.label.toLowerCase()} report over ${result.rowCount.toLocaleString("en-IN")} rows was run for ${user.name} ${options.byline}`
      : `${user.name} ran a ${source.label.toLowerCase()} report over ${result.rowCount.toLocaleString("en-IN")} rows`,
    metadata: {
      source: input.source,
      measure: input.measure,
      by: input.dimension,
      across: input.column ?? null,
      rows: result.rowCount,
      truncated: result.truncated,
    },
  });

  return { ok: true, data: { result, source } };
}

