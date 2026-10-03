import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { profitAndLoss } from "@/actions/ledger-reports";
import { getOrganisation } from "@/lib/organisation";
import { Card } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { indiaClock } from "@/lib/time/zone";
import { ReportHeader, StatementRow, TotalRow, asTree, withMovement } from "@/components/accounting/report-chrome";
import { DateParamInput } from "@/components/accounting/date-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { financialYearBounds } from "@/lib/ledger/period";
import { isMultiBranch, listBranchChoices } from "@/lib/branches/identity";
import { branchLabel, type BranchChoice } from "@/lib/branches/format";

/** The `branch` value for the lines no branch owns — payroll, depreciation, the year-end close (spec §8.2). */
const UNASSIGNED = "unassigned";

export default async function ProfitLossPage({
  searchParams,
}: {
  /** `branch` is a branch id, or `unassigned`. */
  searchParams: Promise<{ from?: string; to?: string; branch?: string }>;
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
  // Defaults to the current Indian financial year, which is the period this is almost always run for.
  const fy = financialYearBounds(new Date());
  const from = params.from ?? fy.from;
  const to = params.to ?? fy.to;
  const branchId = params.branch || undefined;

  const [report, org, multiBranch] = await Promise.all([
    profitAndLoss({ from, to, branchId }),
    getOrganisation(),
    isMultiBranch(),
  ]);
  // The active branches, plus the one a link names even if it has since closed — its history is still
  // worth reading, and the select should show what the figures are for.
  const branches: BranchChoice[] = multiBranch
    ? await listBranchChoices({ include: branchId && branchId !== UNASSIGNED ? [branchId] : [] })
    : [];
  const income = asTree(withMovement(report.income));
  const expense = asTree(withMovement(report.expense));
  const profitable = report.netProfit >= 0;

  // The result says which branch the figures are for; an id that names none comes back company-wide.
  const filtered = report.branch;
  const filteredChoice = filtered && filtered !== UNASSIGNED ? branches.find((b) => b.id === filtered.id) : undefined;
  const shownBranch =
    filtered === UNASSIGNED
      ? "not attributed to a branch"
      : filtered
        ? filteredChoice
          ? branchLabel(filteredChoice)
          : filtered.name
        : null;

  return (
    <div className="animate-fade-rise">
      <ReportHeader
        title="Profit &amp; loss"
        // The period's first and last moments, India's days: the books keep India's calendar.
        subtitle={`${indiaClock.date(report.from)} to ${indiaClock.date(report.to)}${shownBranch ? ` · ${shownBranch}` : ""}`}
        organisation={org.legalName}
      >
        <div className="flex flex-wrap items-center gap-3">
          {/* One set of books, so only the P&L splits by branch; the balance sheet stays whole (spec §8.5). */}
          {multiBranch && (
            <SelectParamFilter
              paramName="branch"
              label="Branch"
              allLabel="All branches"
              options={[
                ...branches.map((b) => ({ value: b.id, label: `${branchLabel(b)}${b.active ? "" : " (inactive)"}` })),
                { value: UNASSIGNED, label: "Not attributed to a branch" },
              ]}
            />
          )}
          <DateParamInput paramName="from" label="From" />
          <DateParamInput paramName="to" label="To" />
        </div>
      </ReportHeader>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Income</div>
          <div className="mt-1 text-lg font-semibold text-text">{formatCurrency(report.totalIncome)}</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Expenses</div>
          <div className="mt-1 text-lg font-semibold text-text">{formatCurrency(report.totalExpense)}</div>
        </Card>
        <Card className={`px-4 py-3 ${profitable ? "border-success/40" : "border-danger/40"}`}>
          <div className="text-xs uppercase tracking-wide text-subtle">{profitable ? "Net profit" : "Net loss"}</div>
          <div className={`mt-1 text-lg font-semibold ${profitable ? "text-success" : "text-danger"}`}>
            {formatCurrency(Math.abs(report.netProfit))}
          </div>
        </Card>
      </div>

      <Card className="mt-4 overflow-x-auto p-0">
        <table className="w-full text-sm">
          <tbody>
            <tr className="border-b border-line bg-surface-sunken">
              <th colSpan={2} className="px-4 py-2 text-left text-xs uppercase tracking-wide text-muted">Income</th>
            </tr>
            {income.map(({ row, depth }) => (
              <StatementRow key={row.id} row={row} depth={depth} href={`/accounting/ledger/${row.id}`} />
            ))}
            {income.length === 0 && (
              <tr><td colSpan={2} className="px-4 py-4 text-center text-subtle">No income in this period.</td></tr>
            )}
            <TotalRow label="Total income" value={report.totalIncome} />

            <tr className="border-b border-t border-line bg-surface-sunken">
              <th colSpan={2} className="px-4 py-2 text-left text-xs uppercase tracking-wide text-muted">Expenses</th>
            </tr>
            {expense.map(({ row, depth }) => (
              <StatementRow key={row.id} row={row} depth={depth} href={`/accounting/ledger/${row.id}`} />
            ))}
            {expense.length === 0 && (
              <tr><td colSpan={2} className="px-4 py-4 text-center text-subtle">No expenses in this period.</td></tr>
            )}
            <TotalRow label="Total expenses" value={report.totalExpense} />

            <tr className="border-t-2 border-line-strong bg-surface-sunken">
              <td className="px-4 py-3 text-base font-semibold text-text">{profitable ? "Net profit" : "Net loss"}</td>
              <td className="px-4 py-3 text-right text-base">
                <span className={profitable ? "font-semibold text-success" : "font-semibold text-danger"}>
                  {formatCurrency(Math.abs(report.netProfit))}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </Card>
    </div>
  );
}
