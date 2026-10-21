import Link from "next/link";
import { ArrowLeft, Printer } from "lucide-react";
import { Card } from "@/components/ui/card";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateParamInput } from "@/components/accounting/date-param-input";
import { AgingExportButton } from "@/components/receivables/aging-export-button";
import { formatCurrency } from "@/lib/utils";
import { formatMoney } from "@/lib/currency";
import { formatCalendarDay } from "@/lib/time/zone";
import { companyPath } from "@/lib/record-links";
import { AGING_INTERVALS, DEFAULT_INTERVAL, intervalLabel, type AgingReport, type AgingSettings } from "@/lib/receivables/aging";

export const AGING_WORDS = {
  AR: { party: "Customer", parties: "customers", doc: "invoice", docs: "invoices", Doc: "Invoice", date: "invoice date", owed: "Total outstanding", none: "Nothing was outstanding on an invoice" },
  AP: { party: "Vendor", parties: "vendors", doc: "bill", docs: "bills", Doc: "Bill", date: "bill date", owed: "Total owed", none: "Nothing was owed on a bill" },
} as const;

/** The settings as the address carries them, defaults left out — what every link on the report keeps. */
export function agingQuery(s: AgingSettings, extra: Record<string, string | number | undefined> = {}): Record<string, string> {
  const q: Record<string, string | number | undefined> = {
    view: "aging",
    asOf: s.asOf,
    by: s.basis === "date" ? "date" : undefined,
    iv: s.interval === DEFAULT_INTERVAL ? undefined : s.interval,
    show: s.show === "count" ? "count" : undefined,
    q: s.search ?? undefined,
    ...extra,
  };
  return Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
}

/** "As of 21 Oct 2026 · by due date · 4 × 30 days" — what the report is, in a line. */
export function agingDescription(report: AgingReport) {
  const words = AGING_WORDS[report.side];
  const s = report.settings;
  return `As of ${formatCalendarDay(s.asOf)} · aged by ${s.basis === "due" ? "due date" : words.date} · ${intervalLabel(s.interval)}`;
}

/**
 * The aging report on Receivables and Payables (`?view=aging`, src/lib/receivables/aging.ts): the summary,
 * a row a party and a column an interval, every figure opening the documents behind it (`docs=1`, with the
 * party and the column), and the controls — as of, aged by, intervals, amounts or counts — in the address,
 * so a report at a day is a link somebody can send.
 */
export function AgingReportView({ report, base, statementTab }: { report: AgingReport; base: "/receivables" | "/payables"; statementTab?: string }) {
  const words = AGING_WORDS[report.side];
  const s = report.settings;
  const counting = s.show === "count";
  const docsHref = (extra: Record<string, string | number | undefined>) => ({ pathname: base, query: agingQuery(s, { docs: 1, ...extra }) });
  const overdue = s.basis === "due" ? report.totals.total - (report.totals.cells[0] ?? 0) : null;
  const last = report.columns.length - 1;

  const cell = (amount: number, count: number, href: ReturnType<typeof docsHref>, strong = false) => {
    if (count === 0) return <span className="text-subtle">—</span>;
    return (
      <Link href={href} className={`tabular-nums hover:underline ${strong ? "font-semibold text-text" : "text-brand"}`}>
        {counting ? count : formatCurrency(amount)}
      </Link>
    );
  };

  return (
    <div>
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">{words.owed}</div>
          <div className="mt-1 text-lg font-semibold text-text">{formatCurrency(report.totals.total)}</div>
          <div className="mt-0.5 text-xs text-muted">
            {report.rows.length} {words.parties} · {report.totals.count} {report.totals.count === 1 ? words.doc : words.docs}
          </div>
        </Card>
        {overdue !== null && (
          <Card className="px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-subtle">Overdue</div>
            <div className={`mt-1 text-lg font-semibold ${overdue > 0 ? "text-danger" : "text-text"}`}>{formatCurrency(overdue)}</div>
            <div className="mt-0.5 text-xs text-muted">past the due date at {formatCalendarDay(s.asOf)}</div>
          </Card>
        )}
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">{report.columns[last]!.label}</div>
          <div className={`mt-1 text-lg font-semibold ${(report.totals.cells[last] ?? 0) > 0 ? "text-danger" : "text-text"}`}>{formatCurrency(report.totals.cells[last] ?? 0)}</div>
          <div className="mt-0.5 text-xs text-muted">the oldest column</div>
        </Card>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3">
        <SearchParamInput paramName="q" placeholder={`Search ${words.party.toLowerCase()} name…`} />
        <DateParamInput paramName="asOf" label="As of" fallback={s.asOf} />
        <SelectParamFilter paramName="by" label="Aging by" allLabel="Due date" options={[{ value: "date", label: words.Doc + " date" }]} resetParams={[]} />
        <SelectParamFilter
          paramName="iv"
          label="Intervals"
          allLabel={intervalLabel(DEFAULT_INTERVAL)}
          options={AGING_INTERVALS.filter((i) => i.key !== DEFAULT_INTERVAL).map((i) => ({ value: i.key, label: intervalLabel(i.key) }))}
          resetParams={[]}
        />
        <SelectParamFilter paramName="show" label="Show" allLabel="Amount" options={[{ value: "count", label: `Number of ${words.docs}` }]} resetParams={[]} />
        <div className="ml-auto flex items-center gap-2">
          <Link
            href={{ pathname: `${base}/aging/print`, query: agingQuery(s, { view: undefined }) }}
            target="_blank"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-sm text-text hover:bg-surface-sunken"
          >
            <Printer aria-hidden="true" className="h-4 w-4" />
            Print / PDF
          </Link>
          <AgingExportButton side={report.side} params={agingQuery(s, { view: undefined })} />
        </div>
      </div>

      <Card className="mt-4 overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">{words.party}</th>
              {report.columns.map((c) => (
                <th key={c.label} className="whitespace-nowrap px-4 py-2.5 text-right" title={c.from === null ? "Not yet due" : undefined}>
                  {c.label}
                </th>
              ))}
              <th className="px-4 py-2.5 text-right">Total</th>
              {!counting && <th className="whitespace-nowrap px-4 py-2.5 text-right">Total (FCY)</th>}
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <tr key={row.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                <td className="px-4 py-2.5">
                  <Link href={`${companyPath(row.companySeq)}${statementTab ? `?tab=${statementTab}` : ""}`} className="font-medium text-text hover:underline">
                    {row.name}
                  </Link>
                </td>
                {report.columns.map((c, i) => (
                  <td key={c.label} className="px-4 py-2.5 text-right">
                    {cell(row.cells[i]!, row.counts[i]!, docsHref({ party: row.companySeq, col: i }))}
                  </td>
                ))}
                <td className="px-4 py-2.5 text-right">{cell(row.total, row.count, docsHref({ party: row.companySeq }), true)}</td>
                {!counting && (
                  <td className="px-4 py-2.5 text-right text-muted">
                    {row.foreign.length === 0 ? (
                      <span className="text-subtle">—</span>
                    ) : (
                      row.foreign.map((f) => (
                        <div key={f.currency} className="whitespace-nowrap">
                          {formatMoney(f.amount, f.currency)}
                        </div>
                      ))
                    )}
                  </td>
                )}
              </tr>
            ))}
            {report.rows.length === 0 && (
              <tr>
                <td colSpan={report.columns.length + 3} className="px-4 py-10 text-center text-subtle">
                  {words.none} at {formatCalendarDay(s.asOf)}
                  {s.search ? ` for a ${words.party.toLowerCase()} matching “${s.search}”` : ""}.
                </td>
              </tr>
            )}
          </tbody>
          {report.rows.length > 0 && (
            <tfoot className="border-t border-line bg-surface-sunken text-sm font-semibold text-text">
              <tr>
                <td className="px-4 py-2.5">Total</td>
                {report.columns.map((c, i) => (
                  <td key={c.label} className="px-4 py-2.5 text-right">
                    {cell(report.totals.cells[i]!, report.totals.counts[i]!, docsHref({ col: i }), true)}
                  </td>
                ))}
                <td className="px-4 py-2.5 text-right">{cell(report.totals.total, report.totals.count, docsHref({}), true)}</td>
                {!counting && <td />}
              </tr>
            </tfoot>
          )}
        </table>
      </Card>
      <p className="mt-3 text-xs text-subtle">
        {agingDescription(report)}.{s.basis === "due" ? " Current: not yet due." : ""} In rupees, each {words.doc} at the rate it was raised at; Total (FCY) is
        what is left in each other currency, as written. A payment dated after the day, or a credit note applied after it, doesn&apos;t count yet.
        Unused payments and credit notes are on the Balance summary.
      </p>
    </div>
  );
}

/** The documents behind a figure on the report: one party, one column, or every one — oldest first. */
export function AgingDocumentsView({ report, base }: { report: AgingReport; base: "/receivables" | "/payables" }) {
  const words = AGING_WORDS[report.side];
  const s = report.settings;
  const party = s.party !== null ? report.rows.find((r) => r.companySeq === s.party) ?? null : null;
  const column = s.column !== null ? report.columns[s.column] ?? null : null;
  const total = report.documents.reduce((t, d) => t + d.balance, 0);

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={{ pathname: base, query: agingQuery(s) }} className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          Back to the summary
        </Link>
        <h2 className="text-base font-semibold text-text">
          {party ? party.name : `Every ${words.party.toLowerCase()}`} · {column ? column.label + (column.from === null ? " (not yet due)" : "") : "every column"}
        </h2>
      </div>
      <p className="mt-1 text-xs text-muted">
        {agingDescription(report)} · {report.documents.length} {report.documents.length === 1 ? words.doc : words.docs}, {formatCurrency(total)}
      </p>

      <Card className="mt-4 overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">{words.Doc}</th>
              {!party && <th className="px-4 py-2.5">{words.party}</th>}
              <th className="px-4 py-2.5">Date</th>
              <th className="px-4 py-2.5">Due date</th>
              <th className="px-4 py-2.5 text-right">Age</th>
              <th className="px-4 py-2.5 text-right">Balance</th>
              <th className="whitespace-nowrap px-4 py-2.5 text-right">Balance (FCY)</th>
            </tr>
          </thead>
          <tbody>
            {report.documents.map((d) => (
              <tr key={d.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                <td className="px-4 py-2.5">
                  <Link href={`/documents/${d.id}`} className="font-medium text-brand hover:underline">
                    {d.docNumber}
                  </Link>
                </td>
                {!party && (
                  <td className="px-4 py-2.5">
                    <Link href={companyPath(d.companySeq)} className="text-text hover:underline">
                      {d.party}
                    </Link>
                  </td>
                )}
                <td className="whitespace-nowrap px-4 py-2.5 text-muted">{formatCalendarDay(d.issueDate)}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted">{d.dueDate ? formatCalendarDay(d.dueDate) : "—"}</td>
                <td className={`whitespace-nowrap px-4 py-2.5 text-right tabular-nums ${s.basis === "due" && d.age > 0 ? "text-danger" : "text-muted"}`}>
                  {s.basis === "due" ? (d.age > 0 ? `${d.age} days overdue` : d.age === 0 ? "due today" : `due in ${-d.age} days`) : `${d.age} days`}
                </td>
                <td className="px-4 py-2.5 text-right font-medium tabular-nums text-text">{formatCurrency(d.balance)}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right text-muted">{d.currency.toUpperCase() === "INR" ? <span className="text-subtle">—</span> : formatMoney(d.left, d.currency)}</td>
              </tr>
            ))}
            {report.documents.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-subtle">
                  No open {words.docs} here at {formatCalendarDay(s.asOf)}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
