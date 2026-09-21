import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { trialBalance } from "@/actions/ledger-reports";
import { getOrganisation } from "@/lib/organisation";
import { Card } from "@/components/ui/card";
import { Amount, BalanceCheck, ReportHeader, asAtLabel } from "@/components/accounting/report-chrome";
import { DateParamInput } from "@/components/accounting/date-param-input";

export default async function TrialBalancePage({
  searchParams,
}: {
  searchParams: Promise<{ to?: string }>;
}) {
  const enabled = await isModuleEnabled("accounting");
  if (!enabled) return <ModuleDisabledNotice moduleKey="accounting" />;

  /**
   * The books are not a module-level read.
   *
   * Every statement on these pages is built from the same ledger, and the actions behind them
   * answered any signed-in session until this key existed. Refused in place rather than hidden, so
   * somebody who followed a link is told why.
   */
  const viewer = await currentUser();
  if (!viewer || !(await can(viewer.id, "ledger.viewReports"))) {
    return (
      <Card className="px-6 py-10 text-center text-sm text-muted">
        You don&rsquo;t have permission to see the books.
      </Card>
    );
  }

  const params = await searchParams;
  const [report, org] = await Promise.all([trialBalance({ to: params.to }), getOrganisation()]);

  return (
    <div className="animate-fade-rise">
      <ReportHeader title="Trial balance" subtitle={asAtLabel(report.asAt)} organisation={org.legalName}>
        <DateParamInput paramName="to" label="As at" />
      </ReportHeader>

      <BalanceCheck
        balanced={report.balanced}
        difference={report.difference}
        balancedLabel="Debits equal credits. The books balance."
      />

      <Card className="mt-4 overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Account</th>
              <th className="px-4 py-2.5 text-right">Debit</th>
              <th className="px-4 py-2.5 text-right">Credit</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <tr key={row.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                <td className="px-4 py-1.5">
                  <Link href={`/accounting/ledger/${row.id}`} className="text-text hover:underline">
                    <span className="mr-2 font-mono text-xs text-subtle">{row.code}</span>
                    {row.name}
                  </Link>
                </td>
                <td className="px-4 py-1.5 text-right"><Amount value={row.debit} /></td>
                <td className="px-4 py-1.5 text-right"><Amount value={row.credit} /></td>
              </tr>
            ))}
            {report.rows.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-12 text-center text-subtle">
                  Nothing posted yet. Issue an invoice or write a journal entry and it will appear here.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line-strong">
              <td className="px-4 py-2.5 font-semibold text-text">Total</td>
              <td className="px-4 py-2.5 text-right"><Amount value={report.totals.debit} bold /></td>
              <td className="px-4 py-2.5 text-right"><Amount value={report.totals.credit} bold /></td>
            </tr>
          </tfoot>
        </table>
      </Card>
    </div>
  );
}
