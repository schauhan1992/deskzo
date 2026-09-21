import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { accountLedger } from "@/actions/ledger-reports";
import { Badge, Card } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";
import { accountTypeLabels } from "@/lib/ledger/chart";
import { Amount, ReportHeader, accountTypeTone } from "@/components/accounting/report-chrome";
import { DateParamInput } from "@/components/accounting/date-param-input";

export default async function AccountLedgerPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const enabled = await isModuleEnabled("accounting");
  if (!enabled) return <ModuleDisabledNotice moduleKey="accounting" />;

  const [{ accountId }, query] = await Promise.all([params, searchParams]);
  const report = await accountLedger({ accountId, from: query.from, to: query.to });
  if (!report) notFound();

  return (
    <div className="animate-fade-rise">
      <Link href="/accounting/trial-balance" className="text-sm text-muted hover:text-text">
        ← Trial balance
      </Link>

      <div className="mt-2">
        <ReportHeader
          title={report.account.name}
          subtitle={report.account.description ?? "Every transaction against this account, oldest first."}
          organisation={`${report.account.code} · ${accountTypeLabels[report.account.type]}`}
        >
          <div className="flex flex-wrap items-center gap-3">
            <DateParamInput paramName="from" label="From" />
            <DateParamInput paramName="to" label="To" />
          </div>
        </ReportHeader>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Opening</div>
          <div className="mt-1 text-lg font-semibold text-text"><Amount value={report.openingBalance} /></div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Debits</div>
          <div className="mt-1 text-lg font-semibold text-text"><Amount value={report.totals.debit} /></div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Credits</div>
          <div className="mt-1 text-lg font-semibold text-text"><Amount value={report.totals.credit} /></div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Closing</div>
          <div className="mt-1 text-lg font-semibold text-text"><Amount value={report.closingBalance} /></div>
        </Card>
      </div>

      <Card className="mt-4 overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Date</th>
              <th className="px-4 py-2.5">Entry</th>
              <th className="px-4 py-2.5">Narration</th>
              <th className="px-4 py-2.5">Party</th>
              <th className="px-4 py-2.5 text-right">Debit</th>
              <th className="px-4 py-2.5 text-right">Credit</th>
              <th className="px-4 py-2.5 text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            {report.openingBalance !== 0 && (
              <tr className="border-b border-line bg-surface-sunken/60">
                <td colSpan={6} className="px-4 py-1.5 text-muted">Opening balance</td>
                <td className="px-4 py-1.5 text-right"><Amount value={report.openingBalance} bold /></td>
              </tr>
            )}
            {report.rows.map((row) => (
              <tr key={row.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                <td className="whitespace-nowrap px-4 py-1.5 text-muted">{formatDate(row.date)}</td>
                <td className="px-4 py-1.5">
                  <Link href={`/accounting/journal?q=${row.entryNumber}`} className="font-mono text-xs text-brand hover:underline">
                    {row.entryNumber}
                  </Link>
                </td>
                <td className="px-4 py-1.5 text-text">
                  {row.documentId ? (
                    <Link href={`/documents/${row.documentId}`} className="hover:underline">{row.narration}</Link>
                  ) : (
                    row.narration
                  )}
                </td>
                <td className="px-4 py-1.5 text-muted">
                  {row.party ? (
                    <Link href={`/companies/${row.party.id}`} className="hover:underline">{row.party.name}</Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-1.5 text-right"><Amount value={row.debit} muted /></td>
                <td className="px-4 py-1.5 text-right"><Amount value={row.credit} muted /></td>
                <td className="px-4 py-1.5 text-right"><Amount value={row.balance} /></td>
              </tr>
            ))}
            {report.rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-subtle">
                  Nothing posted to this account in this period.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line-strong">
              <td colSpan={4} className="px-4 py-2.5 font-semibold text-text">
                Closing balance
                <Badge tone={accountTypeTone[report.account.type]} className="ml-2">
                  {accountTypeLabels[report.account.type]}
                </Badge>
              </td>
              <td className="px-4 py-2.5 text-right"><Amount value={report.totals.debit} bold /></td>
              <td className="px-4 py-2.5 text-right"><Amount value={report.totals.credit} bold /></td>
              <td className="px-4 py-2.5 text-right"><Amount value={report.closingBalance} bold /></td>
            </tr>
          </tfoot>
        </table>
      </Card>
    </div>
  );
}
