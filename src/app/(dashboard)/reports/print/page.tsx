import { notFound } from "next/navigation";

/** The same sentence the screen shows — see the note on `ReportResult.grandTotal`. */
const NEW_DOUBLE_SENTENCE =
  "A record can fall in more than one row, so the rows and the column totals add up to more than the total.";
import { runAnalyticsReport, type ReportRequest } from "@/actions/analytics";
import { getSource } from "@/lib/analytics/sources";
import { effectiveSource } from "@/lib/analytics/custom";
import { countActiveFilters, describeFilters, type WorkbookFilters } from "@/lib/workspace/filters";
import { workbookFilterOptions } from "@/actions/workspace";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { currentUser } from "@/lib/session";
import { PrintButton } from "@/components/reports/print-button";

/**
 * The report as a sheet of paper.
 *
 * Rendered on the server from the request in the URL rather than from anything the sender captured,
 * which is the point: open this link as somebody else and it runs again **as them**, narrowed to
 * what they may see. A printed report that carried the sender's rows would be a way to hand
 * somebody a list of accounts they were never given, and it would look like sharing.
 *
 * It lives under the dashboard rather than in the (print) group because it is still a page of the
 * application — somebody reads it on screen as often as they print it — and the print styles do the
 * rest when they do.
 */
export default async function ReportPrintPage({
  searchParams,
}: {
  searchParams: Promise<{ r?: string }>;
}) {
  const { r } = await searchParams;
  if (!r) notFound();

  let request: ReportRequest;
  try {
    request = JSON.parse(r) as ReportRequest;
  } catch {
    notFound();
  }

  const [result, viewer] = await Promise.all([runAnalyticsReport(request!), currentUser()]);
  if (!result.ok) {
    return <p className="p-8 text-sm text-danger">{result.error}</p>;
  }

  // Labelled from the source as this reader reports on it: the workspace's own fields included, and
  // only the ones they may see — the report itself has already refused a link naming any other.
  const base = getSource(request!.source);
  const source = base && viewer ? await effectiveSource(base, viewer.id) : base;
  const data = result.data;
  const crossTab = data.columns.length > 1 || data.columns[0]?.key !== "__all__";
  const dimensionLabel =
    request!.dimension === "time" ? "Period" : source?.dimensions.find((d) => d.key === request!.dimension)?.label ?? "Group";
  const measureLabel = source?.measures.find((m) => m.key === request!.measure)?.label ?? request!.measure;

  const fmt = (n: number) =>
    data.unit === "currency" ? formatCurrency(n) : data.unit === "days" ? `${n.toFixed(1)} d` : n.toLocaleString("en-IN");

  /**
   * The dimension filters, written out.
   *
   * The sheet said "376 row(s) excluded by filters" and never said which — so a printed report for
   * AutoCAD in Kochi was indistinguishable from the whole book minus some rows, and the note about
   * exclusions made it look *less* trustworthy rather than more. A printed page outlives the
   * conversation that produced it; whoever reads it next quarter cannot ask what was excluded.
   */
  const appliedDimensions = Object.entries(request!.filters ?? {})
    .filter(([, values]) => values.length > 0)
    .map(([key, values]) => {
      const label = source?.dimensions.find((d) => d.key === key)?.label ?? key;
      return `${label}: ${values.join(", ")}`;
    });

  const companyFilters = (request!.companyFilters ?? {}) as WorkbookFilters;
  /**
   * Fetched only to turn six id-valued filters back into names.
   *
   * Worth a query on a page that is about to be printed: "Account manager: 0f3a…" on a sheet handed
   * to somebody who did not run the report is a line they cannot read and cannot ask about. Skipped
   * entirely when the account panel was empty, which is most of the time.
   */
  const companyFilterCount = countActiveFilters(companyFilters);
  const appliedCompany = companyFilterCount > 0 ? describeFilters(companyFilters, await workbookFilterOptions()) : [];

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-start justify-between gap-4 print:hidden">
        <p className="text-xs text-muted">
          This runs again for whoever opens it, against what they are allowed to see — so the link is safe to send.
        </p>
        <PrintButton />
      </div>

      <div className="mt-4 rounded-lg border border-line bg-surface p-8 print:border-0 print:p-0">
        <h1 className="text-lg font-semibold text-text">
          {measureLabel} by {dimensionLabel.toLowerCase()}
        </h1>
        <p className="mt-0.5 text-sm text-muted">
          {source?.label} · {request!.from} to {request!.to}
          {crossTab && ` · across ${source?.dimensions.find((d) => d.key === request!.column)?.label ?? "time"}`}
        </p>

        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 border-y border-line py-3 text-xs sm:grid-cols-3">
          <Row label="Total" value={fmt(data.grandTotal)} />
          <Row label="Rows counted" value={data.rowCount.toLocaleString("en-IN")} />
          <Row label="Scope" value={data.scopeNote} />
          <Row label="Run by" value={viewer?.name ?? "—"} />
          <Row label="Run at" value={formatDateTime(new Date())} />
          {appliedDimensions.length > 0 && <Row label="Filtered to" value={appliedDimensions.join(" · ")} />}
          {appliedCompany.length > 0 && (
            <Row
              label="Account filters"
              value={appliedCompany.map((f) => (f.value ? `${f.label}: ${f.value}` : f.label)).join(" · ")}
            />
          )}
        </dl>

        {/* Stated on the sheet, not just on screen. A printed page outlives the conversation that
            produced it, and somebody reading it next quarter has no way to ask what was excluded. */}
        {(data.truncated || data.doubleCounted || data.filteredOut > 0 || data.columnsFolded > 0) && (
          <ul className="mt-3 space-y-0.5 text-xs text-muted">
            {data.truncated && <li>Hit the row ceiling — these are floors, not totals.</li>}
            {data.doubleCounted && <li>{NEW_DOUBLE_SENTENCE}</li>}
            {data.columnsFolded > 0 && (
              <li>
                {data.columnsFolded.toLocaleString("en-IN")} column(s) are gathered into one, which is the column named
                for how many it stands for. Their figures are still in every total.
              </li>
            )}
            {data.filteredOut > 0 && <li>{data.filteredOut.toLocaleString("en-IN")} row(s) excluded by filters.</li>}
          </ul>
        )}

        <table className="mt-5 w-full text-sm">
          <thead className="border-b border-line-strong text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="py-1.5">{dimensionLabel}</th>
              {crossTab && data.columns.map((c) => <th key={c.key} className="py-1.5 text-right">{c.label}</th>)}
              <th className="py-1.5 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.key} className="border-b border-line last:border-0">
                <td className="py-1.5 text-text">{row.label}</td>
                {crossTab &&
                  data.columns.map((c) => (
                    <td key={c.key} className="py-1.5 text-right tabular-nums text-muted">
                      {row.cells[c.key] ? fmt(row.cells[c.key]!) : "—"}
                    </td>
                  ))}
                <td className="py-1.5 text-right font-medium tabular-nums text-text">{fmt(row.total)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-line-strong">
            <tr>
              <td className="py-1.5 font-semibold text-text">Total</td>
              {crossTab &&
                data.columns.map((c) => (
                  <td key={c.key} className="py-1.5 text-right font-semibold tabular-nums text-text">
                    {fmt(data.columnTotals[c.key] ?? 0)}
                  </td>
                ))}
              <td className="py-1.5 text-right font-semibold tabular-nums text-text">{fmt(data.grandTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-subtle">{label}</dt>
      <dd className="text-text">{value}</dd>
    </div>
  );
}
