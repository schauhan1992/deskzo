import { notFound } from "next/navigation";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { balanceSheet } from "@/actions/ledger-reports";
import { getOrganisation } from "@/lib/organisation";
import { Card } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import {
  Amount,
  BalanceCheck,
  ReportHeader,
  StatementRow,
  TotalRow,
  asAtLabel,
  asTree,
  withMovement,
} from "@/components/accounting/report-chrome";
import { DateParamInput } from "@/components/accounting/date-param-input";

export default async function BalanceSheetPage({ searchParams }: { searchParams: Promise<{ to?: string }> }) {
  const enabled = await isModuleEnabled("accounting");
  if (!enabled) return <ModuleDisabledNotice moduleKey="accounting" />;

  /**
   * The books are not a module-level read.
   *
   * Every statement on these pages is built from the same ledger, and the actions behind them
   * answered any signed-in session until this key existed. Without it the page is not found, like
   * any address the viewer shouldn't have.
   */
  const viewer = await currentUser();
  if (!viewer || !(await can(viewer.id, "ledger.viewReports"))) notFound();

  const params = await searchParams;
  const [report, org] = await Promise.all([balanceSheet({ to: params.to }), getOrganisation()]);
  const assets = asTree(withMovement(report.assets));
  const liabilities = asTree(withMovement(report.liabilities));
  const equity = asTree(withMovement(report.equity));

  return (
    <div className="@container animate-fade-rise">
      <ReportHeader title="Balance sheet" subtitle={asAtLabel(report.asAt)} organisation={org.legalName}>
        <DateParamInput paramName="to" label="As at" />
      </ReportHeader>

      <BalanceCheck
        balanced={report.balanced}
        difference={report.difference}
        balancedLabel="Assets equal liabilities plus equity. The balance sheet balances."
      />

      <div className="mt-4 grid grid-cols-1 gap-4 @4xl:grid-cols-2">
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b border-line bg-surface-sunken">
                <th colSpan={2} className="px-4 py-2 text-left text-xs uppercase tracking-wide text-muted">Assets</th>
              </tr>
              {assets.map(({ row, depth }) => (
                <StatementRow key={row.id} row={row} depth={depth} href={`/accounting/ledger/${row.id}`} />
              ))}
              <TotalRow label="Total assets" value={report.totalAssets} />
            </tbody>
          </table>
        </Card>

        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b border-line bg-surface-sunken">
                <th colSpan={2} className="px-4 py-2 text-left text-xs uppercase tracking-wide text-muted">
                  Liabilities
                </th>
              </tr>
              {liabilities.map(({ row, depth }) => (
                <StatementRow key={row.id} row={row} depth={depth} href={`/accounting/ledger/${row.id}`} />
              ))}
              <TotalRow label="Total liabilities" value={report.totalLiabilities} />

              <tr className="border-b border-t border-line bg-surface-sunken">
                <th colSpan={2} className="px-4 py-2 text-left text-xs uppercase tracking-wide text-muted">Equity</th>
              </tr>
              {equity.map(({ row, depth }) => (
                <StatementRow key={row.id} row={row} depth={depth} href={`/accounting/ledger/${row.id}`} />
              ))}
              {/* Computed, not posted — profit to date is simply income less expenses for all time,
                  and a stored closing entry would be a second figure that can drift from this one. */}
              <tr className="hover:bg-surface-sunken">
                <td className="px-4 py-1.5 pl-4 text-text">
                  Retained earnings
                  <span className="ml-2 text-xs text-subtle">profit to date</span>
                </td>
                <td className="px-4 py-1.5 text-right"><Amount value={report.retainedEarnings} /></td>
              </tr>
              <TotalRow label="Total equity" value={report.totalEquity} />

              <tr className="border-t-2 border-line-strong bg-surface-sunken">
                <td className="px-4 py-3 text-base font-semibold text-text">Liabilities &amp; equity</td>
                <td className="px-4 py-3 text-right text-base font-semibold text-text">
                  {formatCurrency(report.totalLiabilities + report.totalEquity)}
                </td>
              </tr>
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}
