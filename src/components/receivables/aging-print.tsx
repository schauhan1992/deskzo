import { PrintButton } from "@/components/documents/print-button";
import { AGING_WORDS, agingDescription } from "@/components/receivables/aging-report";
import { formatCurrency } from "@/lib/utils";
import { formatMoney } from "@/lib/currency";
import type { AgingReport } from "@/lib/receivables/aging";

/**
 * The aging report on paper — A4 across, as Zoho prints it: the company, the report and its settings, a row
 * a party and a column an interval, the totals. Saved as a PDF from the browser's print dialog.
 */
export function AgingPrint({ report, company, printedAt }: { report: AgingReport; company: string; printedAt: string }) {
  const words = AGING_WORDS[report.side];
  const counting = report.settings.show === "count";
  const figure = (amount: number, count: number) => (count === 0 ? "—" : counting ? String(count) : formatCurrency(amount));

  return (
    <div className="mx-auto max-w-[297mm] bg-white p-10 text-[11px] leading-snug text-neutral-900 shadow-sm print:p-0 print:shadow-none">
      <style>{"@page { size: A4 landscape; }"}</style>
      <div className="mb-6 flex justify-end print:hidden">
        <PrintButton />
      </div>
      <header className="mb-5 text-center">
        <p className="text-neutral-600">{company}</p>
        <h1 className="mt-1 text-lg font-semibold">
          {report.side === "AR" ? "AR" : "AP"} Aging Summary by {report.settings.basis === "due" ? "due date" : words.date}
        </h1>
        <p className="text-neutral-700">{agingDescription(report)}</p>
        {report.settings.search && <p className="text-neutral-600">{words.parties} matching “{report.settings.search}”</p>}
      </header>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-y border-neutral-400 text-[10px] uppercase tracking-wide text-neutral-600">
            <th className="py-1.5 pr-2 text-left">{words.party}</th>
            {report.columns.map((c) => (
              <th key={c.label} className="whitespace-nowrap px-2 py-1.5 text-right">
                {c.label}
              </th>
            ))}
            <th className="px-2 py-1.5 text-right">Total</th>
            {!counting && <th className="whitespace-nowrap py-1.5 pl-2 text-right">Total (FCY)</th>}
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row) => (
            <tr key={row.id} className="border-b border-neutral-200 align-top">
              <td className="py-1 pr-2">{row.name}</td>
              {report.columns.map((c, i) => (
                <td key={c.label} className="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                  {figure(row.cells[i]!, row.counts[i]!)}
                </td>
              ))}
              <td className="whitespace-nowrap px-2 py-1 text-right font-semibold tabular-nums">{figure(row.total, row.count)}</td>
              {!counting && <td className="whitespace-nowrap py-1 pl-2 text-right">{row.foreign.map((f) => formatMoney(f.amount, f.currency)).join(", ") || "—"}</td>}
            </tr>
          ))}
          {report.rows.length === 0 && (
            <tr>
              <td colSpan={report.columns.length + 3} className="py-6 text-center text-neutral-500">
                {words.none}.
              </td>
            </tr>
          )}
        </tbody>
        {report.rows.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-neutral-400 font-semibold">
              <td className="py-1.5 pr-2">Total</td>
              {report.columns.map((c, i) => (
                <td key={c.label} className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">
                  {figure(report.totals.cells[i]!, report.totals.counts[i]!)}
                </td>
              ))}
              <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{figure(report.totals.total, report.totals.count)}</td>
              {!counting && <td />}
            </tr>
          </tfoot>
        )}
      </table>
      <p className="mt-4 text-[10px] text-neutral-500">
        {report.settings.basis === "due" ? "Current: not yet due. " : ""}In rupees, each {words.doc} at the rate it was raised at. Printed {printedAt}.
      </p>
    </div>
  );
}
