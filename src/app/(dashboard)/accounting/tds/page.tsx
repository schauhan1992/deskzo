import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { tdsSummary } from "@/actions/tax-reports";
import { getOrganisation } from "@/lib/organisation";
import { Card } from "@/components/ui/card";
import { Amount, ReportHeader } from "@/components/accounting/report-chrome";
import { MonthPicker } from "@/components/accounting/month-picker";
import { monthName } from "@/lib/ledger/period";
import { formatCurrency, formatDate } from "@/lib/utils";

/**
 * What was withheld, both ways.
 *
 * The date is the point. TDS deducted in a month is payable by the 7th of the next, and interest
 * runs at 1.5% a month from the day after — so this page leads with the deadline rather than with
 * a total.
 */
export default async function TdsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; year?: string }>;
}) {
  const enabled = await isModuleEnabled("accounting");
  if (!enabled) return <ModuleDisabledNotice moduleKey="accounting" />;

  const params = await searchParams;
  const now = new Date();
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const month = Number(params.month) || previous.getMonth() + 1;
  const year = Number(params.year) || previous.getFullYear();

  const [tds, org] = await Promise.all([tdsSummary({ month, year }), getOrganisation()]);
  if (!tds) {
    return (
      <Card className="px-6 py-10 text-center text-sm text-muted">
        TDS sits behind the same permission as payments and the ledger.
      </Card>
    );
  }

  const dueDate = new Date(`${tds.dueOn}T00:00:00.000Z`);
  // One reading of the clock for the whole render, so "overdue" and "days left" can't disagree.
  const renderedAt = now.getTime();
  const overdue = tds.totals.payable > 0 && dueDate.getTime() < renderedAt;
  const daysLeft = Math.ceil((dueDate.getTime() - renderedAt) / 86400000);

  return (
    <div className="animate-fade-rise">
      <ReportHeader
        title="TDS"
        subtitle={`${monthName(month)} ${year}`}
        organisation={`${org.legalName}${org.pan ? ` · PAN ${org.pan}` : ""}`}
      >
        <MonthPicker month={month} year={year} />
      </ReportHeader>

      {tds.totals.payable > 0 && (
        <Card
          className={`mt-4 px-4 py-3 text-sm ${overdue ? "border-danger/40 bg-danger-bg text-danger" : "border-warning/40 bg-warning-bg text-warning"}`}
        >
          <span className="font-medium">{formatCurrency(tds.totals.payable)}</span> was deducted and is payable
          {overdue ? (
            <> by {formatDate(dueDate)} — that date has passed, and interest runs at 1.5% a month from the day after.</>
          ) : (
            <> by {formatDate(dueDate)}{daysLeft >= 0 && ` — ${daysLeft} day(s) left`}.</>
          )}
        </Card>
      )}

      {tds.problems.length > 0 && (
        <Card className="mt-4 border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-3.5 w-3.5" />
            {tds.problems.length} thing(s) to fix before filing
          </p>
          <ul className="mt-2 space-y-1">
            {tds.problems.slice(0, 8).map((p, i) => (
              <li key={`${p.docNumber}-${i}`}>
                <span className="font-mono text-xs">{p.docNumber}</span> — {p.issue}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">We deducted, and owe</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-text">{formatCurrency(tds.totals.payable)}</div>
          <div className="mt-0.5 text-xs text-muted">A liability until it&apos;s paid to the government.</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Customers withheld from us</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-text">
            {formatCurrency(tds.totals.receivable)}
          </div>
          <div className="mt-0.5 text-xs text-muted">
            An asset — claim it against the year&apos;s tax, and check it appears in 26AS.
          </div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Due on</div>
          <div className="mt-1 text-2xl font-semibold text-text">{formatDate(dueDate)}</div>
          <div className="mt-0.5 text-xs text-muted">The 7th of the following month.</div>
        </Card>
      </div>

      <TdsTable
        title="Deducted from vendors"
        hint="Withheld from what we paid them, and owed onwards. The 26Q return reports these."
        rows={tds.payable}
        total={tds.totals.payable}
      />
      <TdsTable
        title="Withheld by customers"
        hint="They paid us less and paid the difference to the government on our behalf. Verify each against Form 26AS before claiming it."
        rows={tds.receivable}
        total={tds.totals.receivable}
      />
    </div>
  );
}

function TdsTable({
  title,
  hint,
  rows,
  total,
}: {
  title: string;
  hint: string;
  rows: { docNumber: string; issueDate: string | Date; partyName: string; partyPan: string | null; taxableValue: number; amount: number }[];
  total: number;
}) {
  return (
    <Card className="mt-4 overflow-hidden p-0">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium text-text">{title}</h2>
        <p className="mt-0.5 text-xs text-muted">{hint}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Document</th>
              <th className="px-4 py-2.5">Date</th>
              <th className="px-4 py-2.5">Party</th>
              <th className="px-4 py-2.5">PAN</th>
              <th className="px-4 py-2.5 text-right">Taxable value</th>
              <th className="px-4 py-2.5 text-right">Withheld</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.docNumber} className="border-b border-line last:border-0">
                <td className="px-4 py-2 font-mono text-xs text-muted">{row.docNumber}</td>
                <td className="px-4 py-2 text-muted">{formatDate(row.issueDate)}</td>
                <td className="px-4 py-2 text-text">{row.partyName}</td>
                <td className="px-4 py-2 font-mono text-xs">
                  {row.partyPan ?? <span className="text-danger">missing</span>}
                </td>
                <td className="px-4 py-2 text-right">
                  <Amount value={row.taxableValue} muted />
                </td>
                <td className="px-4 py-2 text-right">
                  <Amount value={row.amount} bold />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-subtle">
                  Nothing withheld this month.{" "}
                  <Link href="/documents" className="text-brand hover:underline">
                    Documents
                  </Link>
                </td>
              </tr>
            )}
            {rows.length > 0 && (
              <tr className="border-t-2 border-line-strong bg-surface-sunken">
                <td colSpan={5} className="px-4 py-2.5 font-semibold text-text">
                  Total
                </td>
                <td className="px-4 py-2.5 text-right">
                  <Amount value={total} bold />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
