"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { BarChart3, ChartColumn, ChartLine, ChartPie, Download, Layers, Loader2, Printer, SlidersHorizontal, Table2, TriangleAlert, X } from "lucide-react";
import { runAnalyticsReport, exportReportCsv, reportFilterOptions, type ReportRequest, type SourceOption } from "@/actions/analytics";
import type { ReportResult } from "@/lib/analytics/run";
import type { Grain } from "@/lib/analytics/types";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { FilterBuilder } from "@/components/workspace/filter-builder";
import { ReportChart, type ChartType } from "@/components/reports/report-chart";
import type { WorkbookFilters } from "@/lib/workspace/filters";
import { countActiveFilters, describeFilters } from "@/lib/workspace/filters";
import { DimensionFilters } from "@/components/reports/dimension-filters";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { formatCurrency, cn } from "@/lib/utils";

/**
 * Pick a thing, a number, and something to break it down by.
 *
 * Deliberately one screen rather than a menu of named reports. "Revenue by brand", "orders by
 * salesperson by month" and "tickets by priority" are not three features — they are three answers
 * from the same three dropdowns, and a product that ships them as separate pages has to ship a
 * fourth one the first time somebody asks a question nobody anticipated.
 */

const TIME = "time";

/**
 * The most rows the table draws before it starts summarising itself.
 *
 * A breakdown by Customer over a wide window is a thousand rows, and every one becomes a table row
 * with a bar in it. The charts already cap themselves — forty series, seven donut slices — and the
 * table was the only surface with no ceiling at all, so the widest question anybody could ask was
 * also the one that stopped the page responding.
 *
 * The rows are all still in the result, in every total, in the CSV and on the printed sheet. This
 * bounds what is *painted*, and says so underneath rather than trailing off.
 */
const TABLE_ROW_CAP = 200;

const CHART_TYPES: { key: ChartType | "table"; label: string; icon: typeof Table2 }[] = [
  { key: "table", label: "Table", icon: Table2 },
  { key: "column", label: "Columns", icon: ChartColumn },
  { key: "line", label: "Line", icon: ChartLine },
  { key: "bar", label: "Bars", icon: BarChart3 },
  { key: "stacked", label: "Stacked", icon: Layers },
  { key: "donut", label: "Share", icon: ChartPie },
];

export function ReportExplorer({
  sources,
  grains,
  today,
  monthStart,
  filterOptions,
}: {
  sources: SourceOption[];
  grains: { key: Grain; label: string }[];
  /** Industries, owners, brands and the rest, for the workspace filter panel. */
  filterOptions: React.ComponentProps<typeof FilterBuilder>["options"];
  /** Passed in from the server: reading the clock while rendering is not allowed here. */
  today: string;
  monthStart: string;
}) {
  const [sourceKey, setSourceKey] = useState(sources[0]?.key ?? "");
  const source = sources.find((s) => s.key === sourceKey) ?? sources[0];

  const [measure, setMeasure] = useState(source?.measures[0]?.key ?? "");
  const [dimension, setDimension] = useState(source?.dimensions[0]?.key ?? TIME);
  const [column, setColumn] = useState<string>("");
  const [grain, setGrain] = useState<Grain>("month");
  const [dateField, setDateField] = useState(source?.dateFields[0]?.key ?? "");
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);

  const [chart, setChart] = useState<ChartType | "table">("table");
  const [companyFilters, setCompanyFilters] = useState<WorkbookFilters>({});
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const [panelOpen, setPanelOpen] = useState(false);
  /**
   * The values each dimension takes in the current window, for the filter panel.
   *
   * Fetched rather than derived from the last result, because the point is to narrow *before*
   * running — there is no result yet the first time somebody opens the panel.
   */
  const [options, setOptions] = useState<{
    values: Record<string, string[]>;
    /** The pre-cap distinct count per dimension — see `FILTER_VALUE_CAP`. */
    counts: Record<string, number>;
    capped: boolean;
  }>({ values: {}, counts: {}, capped: false });
  /**
   * What the options on hand describe — source, dates and account filters, as one key.
   *
   * Loading is derived from this rather than tracked separately: "we are fetching" is exactly "the
   * panel is open and what we hold does not describe what is asked for", and a second boolean
   * saying the same thing is a second thing that can be wrong. It is also set on failure, so a
   * refused fetch reports itself once rather than retrying forever.
   */
  const [optionsFor, setOptionsFor] = useState<string | null>(null);
  const [result, setResult] = useState<ReportResult | null>(null);
  /**
   * The request the result on screen answers — not the one the controls currently describe.
   *
   * The two are the same only until somebody changes a dropdown without pressing Run, and the table
   * used to read the live state: switching "Break down by" to City put a City heading over a column
   * of brand names, and clicking one of those rows filed "Microsoft" under City — a filter for a
   * value that dimension never takes, which comes back empty with nothing on screen to say where it
   * came from. Every label and every row click below reads this instead, so the table can only ever
   * describe the report it is actually showing.
   */
  const [shownAs, setShownAs] = useState<ReportRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /** Switching source invalidates every choice made against the old one. */
  function chooseSource(key: string) {
    const next = sources.find((s) => s.key === key);
    if (!next) return;
    setSourceKey(key);
    setMeasure(next.measures[0]?.key ?? "");
    setDimension(next.dimensions[0]?.key ?? TIME);
    setColumn("");
    setDateField(next.dateFields[0]?.key ?? "");
    // Dimension filters name values of the old source's dimensions, so they cannot survive the
    // switch. The company filters can — they describe accounts, not orders or tickets.
    setFilters({});
    setOptions({ values: {}, counts: {}, capped: false });
    setOptionsFor(null);
    setResult(null);
    setShownAs(null);
    setError(null);
  }

  /**
   * Picking what the rows are can invalidate what the columns are.
   *
   * The "Across" list already excludes whatever the rows are broken down by, so the two were never
   * meant to name the same dimension — but the value behind that control survived the change. The
   * select then held a value matching none of its own options, so it displayed "—" while still
   * carrying a dimension (and re-picking "—" fired no change event, leaving no way to clear it from
   * there), and Run came back with a diagonal matrix: twenty-two rows, twenty-two columns, one
   * number on the leading diagonal and "—" everywhere else.
   *
   * Cleared rather than labelled, because there is no honest label for it. "Brand across brand" is
   * not a question with an answer — the cross-tab of a dimension with itself is the same breakdown
   * twice — so the state is put back to the rule the options list already states rather than being
   * explained to somebody who cannot act on the explanation.
   */
  function chooseDimension(key: string) {
    setDimension(key);
    if (key === column) setColumn("");
  }

  const request = () => ({
    source: sourceKey,
    measure,
    dimension,
    column: column || undefined,
    grain,
    dateField,
    from,
    to,
    companyFilters: Object.keys(companyFilters).length ? companyFilters : undefined,
    filters: Object.keys(filters).length ? filters : undefined,
  });

  function run() {
    setError(null);
    const req = request();
    startTransition(async () => {
      const r = await runAnalyticsReport(req);
      if (!r.ok) {
        // The last good report stays. A rejected run — a mistyped date, a module switched off
        // mid-session — used to throw away a finished table along with its CSV and print buttons,
        // making the largest read in the application the price of a typo. The banner above says why
        // the new one did not run, and the card below still says what it is a report of, so there is
        // nothing left for the blank screen to protect anybody from.
        setError(r.error);
        return;
      }
      setResult(r.data);
      setShownAs(req);
      // Picked for the question rather than remembered: a ranking that was a donut is a column
      // chart the moment somebody switches the breakdown to months, and making them notice and
      // change it is making them do the tool's job.
      setChart(dimension === TIME ? (column ? "stacked" : "column") : "bar");
    });
  }

  /**
   * Both exports describe the report on screen, not the dropdowns above it.
   *
   * They built from `request()` — the live controls — while everything inside the result card reads
   * the `shownAs` snapshot. So changing the breakdown and pressing CSV without pressing Run gave a
   * file of a report nobody had looked at, under a filename naming the new breakdown, while the
   * table still showed the old one. The snapshot is the whole point of `shownAs`; these two were
   * the only readers left out of it.
   *
   * `shown` falls back to `request()` before the first run, so the buttons behave unchanged when
   * there is nothing on screen yet — and both are hidden until `result` exists anyway.
   */
  function download() {
    startTransition(async () => {
      const r = await exportReportCsv(shown);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      const url = URL.createObjectURL(new Blob([r.data.csv], { type: "text/csv" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = r.data.filename;
      link.click();
      URL.revokeObjectURL(url);
    });
  }

  /**
   * A full load of the window, so it is fetched on opening the panel and when the thing it
   * describes changes — not on every keystroke, and not on every render.
   */
  const optionsKey = `${sourceKey}|${dateField}|${from}|${to}|${JSON.stringify(companyFilters)}`;

  const optionsLoading = panelOpen && optionsFor !== optionsKey;

  useEffect(() => {
    if (!panelOpen || optionsFor === optionsKey) return;
    let cancelled = false;
    void reportFilterOptions({
      source: sourceKey,
      from,
      to,
      dateField,
      companyFilters: Object.keys(companyFilters).length ? companyFilters : undefined,
    }).then((r) => {
      if (cancelled) return;
      if (!r.ok) {
        setError(r.error);
        // Marked anyway: without this the effect re-fires on every render and hammers a load that
        // is already failing.
        setOptionsFor(optionsKey);
        return;
      }
      setOptions({ values: r.data.values, counts: r.data.counts, capped: r.data.capped });
      setOptionsFor(optionsKey);
    }).catch(() => {
      // A thrown action — a dropped connection, an expired session — is not a rejected report, so
      // it never reaches the branch above. Without this the panel says "Finding the options…" for
      // as long as anybody leaves it open, which reads as a slow query rather than a failure.
      if (cancelled) return;
      setError("Could not load the filter options. Check the connection and try again.");
      setOptionsFor(optionsKey);
    });
    return () => {
      cancelled = true;
    };
  }, [panelOpen, optionsKey, optionsFor, sourceKey, dateField, from, to, companyFilters]);

  const activeCompanyFilters = countActiveFilters(companyFilters);
  /**
   * The account filters in words, for the chips below.
   *
   * They had no chips at all: closing the panel left "Filters (3)" on a button and nothing on the
   * page saying what the three were, so a report narrowed to one city and a report of everywhere
   * looked identical until it was run. The dimension filters have had chips throughout, which made
   * the asymmetry worse — the visible chips read as the complete list of what was applied.
   *
   * `filterOptions` resolves the six id-valued keys, so a chip says "Account manager: Priya" rather
   * than a uuid.
   */
  const companyChips = useMemo(
    () => describeFilters(companyFilters, filterOptions),
    [companyFilters, filterOptions],
  );
  const chosenValues = Object.fromEntries(Object.entries(filters).filter(([, v]) => v.length > 0));
  // Both layers counted together, because the button is one button and somebody reading "(3)"
  // wants to know how narrow the report is, not which panel the narrowing lives in.
  const activeFilterCount =
    activeCompanyFilters + Object.values(chosenValues).reduce((t, v) => t + v.length, 0);

  function toggleFilter(key: string, value: string) {
    setFilters((prev) => {
      const current = prev[key] ?? [];
      const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
      const out = { ...prev, [key]: next };
      if (next.length === 0) delete out[key];
      return out;
    });
  }

  /**
   * The report as a printable page.
   *
   * The whole request goes in the URL rather than being re-entered, so the printed sheet is the
   * report that was on screen — and so the link can be sent to somebody who will then see the
   * same thing, narrowed to what *they* are allowed to see rather than to what the sender was.
   */
  function print() {
    const params = new URLSearchParams({ r: JSON.stringify(shown) });
    window.open(`/reports/print?${params.toString()}`, "_blank", "noopener");
  }

  if (!source) {
    return (
      <Card className="mt-6">
        <CardContent className="py-8 text-center text-sm text-muted">
          No reportable modules are switched on.
        </CardContent>
      </Card>
    );
  }

  const fmt = (n: number) =>
    result?.unit === "currency" ? formatCurrency(n) : result?.unit === "days" ? `${n.toFixed(1)} d` : n.toLocaleString("en-IN");

  // What is on screen, described by the request that produced it — see `shownAs`. Before anything
  // has been run it is the live request, which nothing below reads.
  const shown = shownAs ?? request();
  /**
   * Whether the figure on screen is an average rather than a sum.
   *
   * Read off the *shown* request rather than the live `measure`, for the same reason the table
   * labels come from `shown`: changing the dropdown without running must not relabel what is
   * already there. The Share chart is undefined for an average — a mean has no whole to take shares
   * of — and this is the only path by which it can find that out.
   */
  const shownIsAveraged =
    source?.measures.find((m) => m.key === shown.measure)?.average === true;

  // A plain breakdown gets bars; a cross-tab gets a grid, where bars would be meaningless.
  const crossTab = Boolean(shown.column);
  const peak = result ? Math.max(...result.rows.map((r) => Math.abs(r.total)), 1) : 1;

  // The source cannot drift from the result the way the dimension can — switching it clears both —
  // so its registry is safe to read live for these labels.
  const dimensionLabel =
    shown.dimension === TIME ? "Period" : source.dimensions.find((d) => d.key === shown.dimension)?.label ?? "Group";
  const measureLabel = source.measures.find((m) => m.key === shown.measure)?.label ?? shown.measure;
  /** The same phrasing the printed sheet uses, so the screen and the paper name the report alike. */
  const reportTitle = `${measureLabel} by ${dimensionLabel.toLowerCase()}`;

  /**
   * The outcome of the run, as a sentence, for the live region below.
   *
   * It carries the caveats as well as the total: a number that is really a floor, or one whose rows
   * deliberately exceed it, is exactly what somebody who cannot see the warning strip would
   * otherwise carry away as a total.
   */
  const outcome = !result
    ? ""
    : [
        result.rows.length === 0
          ? `${reportTitle}: nothing in that window.`
          : `${reportTitle}: ${result.rows.length} row(s), total ${fmt(result.grandTotal)}.`,
        result.truncated
          ? `Hit the ${result.rowCount.toLocaleString("en-IN")}-row ceiling, so these are floors rather than totals.`
          : "",
        result.filteredOut > 0
          ? `${result.filteredOut.toLocaleString("en-IN")} row(s) excluded by the record filters.`
          : "",
        result.doubleCounted ? "A record can fall in more than one row, so the rows and the column totals add up to more than the total." : "",
      ]
        .filter(Boolean)
        .join(" ");

  return (
    <div className="mt-6 space-y-4">
      <Card>
        <CardContent className="grid grid-cols-2 gap-3 py-4 md:grid-cols-4 xl:grid-cols-7">
          <Field label="Report on">
            <Select aria-label="Report on" value={sourceKey} onChange={(e) => chooseSource(e.target.value)}>
              {sources.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </Select>
          </Field>

          <Field label="Measure">
            <Select aria-label="Measure" value={measure} onChange={(e) => setMeasure(e.target.value)}>
              {source.measures.map((m) => (
                <option key={m.key} value={m.key}>{m.label}</option>
              ))}
            </Select>
          </Field>

          <Field label="Break down by">
            <Select aria-label="Break down by" value={dimension} onChange={(e) => chooseDimension(e.target.value)}>
              <option value={TIME}>Time</option>
              {source.dimensions.map((d) => (
                <option key={d.key} value={d.key}>{d.label}</option>
              ))}
            </Select>
          </Field>

          <Field label="Across (optional)">
            <Select aria-label="Across (optional)" value={column} onChange={(e) => setColumn(e.target.value)}>
              <option value="">—</option>
              {dimension !== TIME && <option value={TIME}>Time</option>}
              {source.dimensions
                .filter((d) => d.key !== dimension)
                .map((d) => (
                  <option key={d.key} value={d.key}>{d.label}</option>
                ))}
            </Select>
          </Field>

{/* Grain only means something when one axis is time, so it is absent rather than present and
            greyed. A disabled control captioned "(unused)" reads as a broken feature — which is how
            it was reported — and it takes up the same room either way. */}
          {(dimension === TIME || column === TIME) && (
            <Field label="Grain">
              <Select aria-label="Grain" value={grain} onChange={(e) => setGrain(e.target.value as Grain)}>
                {grains.map((g) => (
                  <option key={g.key} value={g.key}>{g.label}</option>
                ))}
              </Select>
            </Field>
          )}

          <Field label="Dated on">
            <Select aria-label="Dated on" value={dateField} onChange={(e) => setDateField(e.target.value)}>
              {source.dateFields.map((d) => (
                <option key={d.key} value={d.key}>{d.label}</option>
              ))}
            </Select>
          </Field>

          <div className="col-span-2 grid grid-cols-2 gap-2 xl:col-span-1">
            <Field label="From">
              <Input aria-label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To">
              <Input aria-label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={run} disabled={pending}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BarChart3 className="h-3.5 w-3.5" />}
          {pending ? "Running…" : "Run report"}
        </Button>
        {/* Offered for every source. It used to appear only for company-anchored ones, because
            the only thing behind it was the account filter — so a report you could narrow by
            product looked as though it could not be narrowed at all. */}
        <Button size="sm" variant={activeFilterCount > 0 ? "secondary" : "ghost"} onClick={() => setPanelOpen((v) => !v)}>
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
        </Button>
        {result && (
          <>
            <Button size="sm" variant="ghost" onClick={download} disabled={pending}>
              <Download className="h-3.5 w-3.5" />
              CSV
            </Button>
            <Button size="sm" variant="ghost" onClick={print} disabled={pending}>
              <Printer className="h-3.5 w-3.5" />
              Generate report
            </Button>
          </>
        )}
        {source.measures.find((m) => m.key === measure)?.description && (
          <span className="text-xs text-subtle">{source.measures.find((m) => m.key === measure)?.description}</span>
        )}
      </div>

      {/* Two filter layers, kept visibly apart because they do different things. The workspace
          filters narrow which accounts are in scope at all; the dimension filters narrow what
          came back. Presenting them as one list would suggest they are interchangeable. */}
      {panelOpen && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text">Which {source.label.toLowerCase()}</h2>
              <span className="text-xs text-subtle">Narrows what is counted</span>
            </CardHeader>
            <CardContent>
              <DimensionFilters
                dimensions={source.dimensions.map((d) => ({ key: d.key, label: d.label }))}
                values={options.values}
                counts={options.counts}
                filters={filters}
                loading={optionsLoading}
                capped={options.capped}
                onChange={setFilters}
              />
            </CardContent>
          </Card>

          {source.companyAnchored && (
            <Card>
              <CardHeader className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-text">Which accounts</h2>
                <span className="text-xs text-subtle">Narrows the query itself</span>
              </CardHeader>
              <CardContent>
                <FilterBuilder filters={companyFilters} onChange={(update) => setCompanyFilters(update)} options={filterOptions} />
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Not gated on a result any more. A filter set before running is exactly the case that
          most needs showing, and hiding it left the Run button looking unconditional. */}
      {activeFilterCount > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Account chips first and in a quieter colour, because they are the wider of the two
              layers: they decide which accounts exist for this report at all, and the brand-coloured
              chips beside them then narrow what came back. Same shape, deliberately different
              weight — reading them as one list is the mistake the two panels exist to prevent. */}
          {companyChips.map((f) => (
            <button
              key={`company:${f.key}`}
              type="button"
              onClick={() =>
                setCompanyFilters((prev) => {
                  const next = { ...prev };
                  delete next[f.key];
                  return next;
                })
              }
              aria-label={`Remove account filter ${f.label}${f.value ? `: ${f.value}` : ""}`}
              className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-sunken px-2 py-0.5 text-xs text-muted hover:text-text"
            >
              {f.label}
              {f.value ? `: ${f.value}` : ""}
              <X className="h-3 w-3" />
            </button>
          ))}
          {Object.entries(filters).flatMap(([key, values]) =>
            values.map((v) => (
              // The X is decorative, so the chip's name was "Brand: AutoCAD" — a statement of what is
              // filtered, with nothing saying that pressing it undoes that.
              <button
                key={`${key}:${v}`}
                type="button"
                onClick={() => toggleFilter(key, v)}
                aria-label={`Remove filter ${source.dimensions.find((d) => d.key === key)?.label ?? key}: ${v}`}
                className="inline-flex items-center gap-1 rounded-full bg-brand-subtle px-2 py-0.5 text-xs text-brand hover:opacity-80"
              >
                {source.dimensions.find((d) => d.key === key)?.label}: {v}
                <X className="h-3 w-3" />
              </button>
            )),
          )}
          {/* Clears both layers, because it sits under both sets of chips and clearing one of them
              while leaving the other is the reading nobody has. */}
          <button
            type="button"
            onClick={() => {
              setFilters({});
              setCompanyFilters({});
            }}
            className="text-xs text-muted hover:text-text hover:underline"
          >
            Clear
          </button>
        </div>
      )}

      {/* Both regions are mounted whether or not there is anything in them, which is the whole
          point: a live region announces a *change* to something the reader is already watching, so
          one that appears together with its first message is one many readers never read out. The
          error used to be a bare <p> that mounted with its text — so pressing Run announced nothing
          at all, not the failure, not the total, not an empty window. */}
      <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
      {/* The result in words. Visually hidden rather than shown, because the card below already says
          every one of these things to anybody who can see it. */}
      <p aria-live="polite" className="sr-only">{outcome}</p>

      {result && (
        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-2">
            {/* Named, not just totalled. The heading was the bare currency figure, so navigating by
                heading gave "Reports" and then "₹10,00,000.00 across 4 rows" — a number with nothing
                saying what it measures or what it is broken down by. The figure is still here; it is
                simply no longer the only thing here. */}
            <h2 className="text-sm font-semibold text-text">
              {reportTitle}{" "}
              <span className="font-normal text-muted">
                · {fmt(result.grandTotal)} across {result.rows.length} rows
              </span>
            </h2>
            {/* Said every time, not just when narrowed. Two people comparing reports need to know
                which of them was looking at the whole company. */}
            <span className="text-xs text-subtle">{result.scopeNote}</span>
          </CardHeader>

          {(result.truncated || result.doubleCounted || result.filteredOut > 0 || result.columnsFolded > 0) && (
            <div className="space-y-1 border-b border-line px-5 py-2.5">
              {result.truncated && (
                <p className="flex items-start gap-1.5 text-xs text-warning">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  This hit the {result.rowCount.toLocaleString("en-IN")}-row ceiling, so these are floors rather than
                  totals. Narrow the dates.
                </p>
              )}
              {result.filteredOut > 0 && (
                <p className="text-xs text-muted">
                  {/* "the filters above" named both panels while this number counts one of them: rows the
                      account filters removed never reached the engine, so they are not in it. */}
                  {result.filteredOut.toLocaleString("en-IN")} row(s) excluded by the {source.label.toLowerCase()} filters
                  — the totals are
                  for what is left, not for everything.
                </p>
              )}
              {result.columnsFolded > 0 && (
                <p className="text-xs text-muted">
                  {/* The engine folds a wide cross-tab rather than shipping every column. Nothing is
                      lost from the totals, but a table that silently showed 40 of 233 columns would
                      be read as a table of 40. */}
                  Too many columns to show, so {result.columnsFolded.toLocaleString("en-IN")} of them are gathered into a
                  single column. Their figures are still in every total.
                </p>
              )}
              {result.doubleCounted && (
                <p className="flex items-start gap-1.5 text-xs text-muted">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  A record can fall in more than one row, so it counts in each — the rows and the column totals add up
                  to more than the total,
                  on purpose.
                </p>
              )}
            </div>
          )}

          {/* One choice, so it is announced as one: without the group these are six loose buttons
              with no statement of what they are six of. */}
          <div role="group" aria-label="Show as" className="flex flex-wrap items-center gap-1 border-b border-line px-5 py-2">
            {CHART_TYPES.filter((c) => c.key !== "stacked" || crossTab).map((c) => (
              // No `title` here. It repeated the button's own visible text, and a tooltip that
              // matches the label is announced after the name as a description — the same word
              // twice, for nothing a sighted user did not already have.
              <button
                key={c.key}
                type="button"
                onClick={() => setChart(c.key)}
                aria-pressed={chart === c.key}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-base px-2 py-1 text-xs transition-colors",
                  chart === c.key ? "bg-brand-subtle text-brand" : "text-muted hover:bg-surface-sunken hover:text-text",
                )}
              >
                <c.icon className="h-3.5 w-3.5" />
                {c.label}
              </button>
            ))}
          </div>

          {chart !== "table" && result.rows.length > 0 && (
            <div className="border-b border-line px-5 py-4">
              <ReportChart result={result} type={chart} format={fmt} averaged={shownIsAveraged} />
            </div>
          )}

          <CardContent className="p-0">
            {result.rows.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-subtle">Nothing in that window.</p>
            ) : (
              <>
                <div className="max-h-[560px] overflow-auto">
                  <table className="w-full text-sm">
                    {/* The table's own name, carrying the window the heading does not. A table
                        reached by jumping between tables announces its caption and nothing else. */}
                    <caption className="sr-only">
                      {reportTitle}, {shown.from} to {shown.to}
                    </caption>
                    <thead className="sticky top-0 border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                      <tr>
                        <th className="px-4 py-2">{dimensionLabel}</th>
                        {crossTab &&
                          result.columns.map((c) => (
                            <th key={c.key} className="px-4 py-2 text-right">{c.label}</th>
                          ))}
                        <th className="px-4 py-2 text-right">{crossTab ? "Total" : ""}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.slice(0, TABLE_ROW_CAP).map((r) => (
                        <tr key={r.key} className="border-b border-line last:border-0">
                          <td className="px-4 py-2">
                            {shown.dimension === TIME ? (
                              <span className="text-text">{r.label}</span>
                            ) : (
                              // Clicking a row filters to it. Breaking a number down and then
                              // wanting one of its parts is the next question almost every time.
                              //
                              // Whether this value is already chosen was said in colour and weight
                              // alone, forty lines below a sibling toggle that carries aria-pressed
                              // correctly. It filters on the dimension the rows were computed for, not
                              // the one the dropdown currently shows — see `shownAs`.
                              <button
                                type="button"
                                onClick={() => toggleFilter(shown.dimension, r.key)}
                                aria-pressed={filters[shown.dimension]?.includes(r.key) ?? false}
                                className={cn(
                                  "text-left hover:underline",
                                  filters[shown.dimension]?.includes(r.key) ? "font-medium text-brand" : "text-text",
                                )}
                              >
                                {r.label}
                              </button>
                            )}
                          </td>
                          {crossTab &&
                            result.columns.map((c) => (
                              <td key={c.key} className="px-4 py-2 text-right tabular-nums text-muted">
                                {r.cells[c.key] ? fmt(r.cells[c.key]!) : "—"}
                              </td>
                            ))}
                          <td className="px-4 py-2 text-right">
                            {crossTab ? (
                              <span className="font-medium tabular-nums text-text">{fmt(r.total)}</span>
                            ) : (
                              // The bar is the comparison. A column of numbers makes you do the
                              // ranking yourself, which is the one thing a chart is for.
                              <span className="flex items-center justify-end gap-2">
                                <span className="hidden h-1.5 w-32 overflow-hidden rounded-full bg-surface-sunken sm:block">
                                  <span
                                    className={cn("block h-full rounded-full", r.total < 0 ? "bg-danger" : "bg-brand")}
                                    style={{ width: `${Math.min(100, (Math.abs(r.total) / peak) * 100)}%` }}
                                  />
                                </span>
                                <span className="w-28 text-right font-medium tabular-nums text-text">{fmt(r.total)}</span>
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    {crossTab && (
                      <tfoot className="border-t border-line-strong bg-surface-sunken text-xs">
                        <tr>
                          <td className="px-4 py-2 font-semibold text-text">Total</td>
                          {result.columns.map((c) => (
                            <td key={c.key} className="px-4 py-2 text-right font-semibold tabular-nums text-text">
                              {fmt(result.columnTotals[c.key] ?? 0)}
                            </td>
                          ))}
                          <td className="px-4 py-2 text-right font-semibold tabular-nums text-text">{fmt(result.grandTotal)}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
                {/* The rows are all still in the totals, in the CSV and on the printed sheet —
                    this bounds what is painted. Outside the scroll box on purpose: a notice you
                    have to scroll two hundred rows to find is not a notice. */}
                {result.rows.length > TABLE_ROW_CAP && (
                  <p className="border-t border-line px-4 py-2 text-xs text-muted">
                    Showing the first {TABLE_ROW_CAP.toLocaleString("en-IN")} of{" "}
                    {result.rows.length.toLocaleString("en-IN")} rows. The totals above, the CSV and the printed
                    sheet all cover every row.
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * The caption sits in this wrapper rather than beside each control, so there is no `htmlFor` to
 * pair an id with at the call site — every control above carries an `aria-label` repeating these
 * exact words instead. Change one and change the other; they are the same name said twice.
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}
