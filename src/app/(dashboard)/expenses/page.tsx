import Link from "next/link";
import type { ExpenseCategory, ExpenseStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { listExpensesPaged, expenseSummary, expenseByCategory, listExpenseUsers } from "@/actions/expense";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { TabNav } from "@/components/ui/tab-nav";
import { ExpensesTable } from "@/components/expenses/expenses-table";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { formatCurrency } from "@/lib/utils";
import {
  expenseCategoryValues,
  expenseCategoryLabels,
  expenseStatusValues,
  expenseStatusLabels,
} from "@/lib/expenses";

const asStatus = (v?: string) => (expenseStatusValues.includes(v as ExpenseStatus) ? (v as ExpenseStatus) : undefined);
const asCategory = (v?: string) =>
  expenseCategoryValues.includes(v as ExpenseCategory) ? (v as ExpenseCategory) : undefined;

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    category?: string;
    user?: string;
    reimbursable?: string;
    mine?: string;
    view?: string;
    q?: string;
    from?: string;
    to?: string;
    page?: string;
    pageSize?: string;
  }>;
}) {
  const enabled = await isModuleEnabled("expenses");
  if (!enabled) return <ModuleDisabledNotice moduleKey="expenses" />;

  const [params, session] = await Promise.all([searchParams, auth()]);
  const userId = session!.user.id;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);

  const [holdsHrApproval, holdsAnyClaimApproval] = await Promise.all([
    hasEffectivePermission(userId, "hr.approveExpenses"),
    hasEffectivePermission(userId, "expenses.approve"),
  ]);
  /**
   * Three views (owner, 19 Oct 2026 — everybody lists their official expenses, HR approves): your own
   * claims, the ones waiting on you, and every claim you may see. `mine=approvals` is the old address of
   * the second, still followed.
   */
  const view = params.view === "approve" || params.mine === "approvals" ? "approve" : params.view === "all" ? "all" : "mine";

  const filters = {
    status: asStatus(params.status),
    category: asCategory(params.category),
    userId: view === "mine" ? userId : params.user,
    reimbursable: params.reimbursable === "yes" ? true : params.reimbursable === "no" ? false : undefined,
    awaitingMyDecision: view === "approve",
    search: params.q,
    from: params.from,
    to: params.to,
  };

  const [result, summary, byCategory, users, canReimburse, waiting] = await Promise.all([
    listExpensesPaged({ ...filters, page, pageSize }),
    expenseSummary(filters),
    expenseByCategory(filters),
    listExpenseUsers(),
    hasEffectivePermission(userId, "expenses.reimburse"),
    // The count on the To approve tab, whatever the view.
    view === "approve" ? null : expenseSummary({ awaitingMyDecision: true }),
  ]);
  const awaitingCount = (waiting ?? summary).awaitingMyDecision;
  // The tab is for anybody who approves: HR, whoever may decide any claim, and a manager with claims waiting.
  const approves = holdsHrApproval || holdsAnyClaimApproval || awaitingCount > 0;

  const topCategories = byCategory.slice(0, 6);
  const maxCategory = topCategories[0]?.amount ?? 0;

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Expenses</h1>
          <p className="mt-1 text-sm text-muted">
            Your official expenses, claimed and paid back: add each one with its receipt and submit it. Once it is
            approved it goes to the books, and Accounts pays it back.
          </p>
        </div>
        <Link href="/expenses/new">
          <Button>New expense</Button>
        </Link>
      </div>

      <div className="mt-4">
        <TabNav
          basePath="/expenses"
          paramName="view"
          activeKey={view}
          defaultKey="mine"
          tabs={[
            { key: "mine", label: "My expenses" },
            ...(approves ? [{ key: "approve", label: holdsHrApproval ? "To approve (HR)" : "To approve", count: awaitingCount }] : []),
            { key: "all", label: "All expenses" },
          ]}
        />
      </div>

      {view !== "approve" && awaitingCount > 0 && (
        <Link href="/expenses?view=approve" className="mt-4 block">
          <Card className="border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning transition-shadow hover:shadow-md">
            <span className="font-medium">
              {awaitingCount} claim{awaitingCount === 1 ? "" : "s"} waiting on your approval
            </span>{" "}
            — review them.
          </Card>
        </Link>
      )}

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total" value={formatCurrency(summary.total)} hint={`${summary.count} claim(s)`} />
        <Stat
          label="Awaiting approval"
          value={formatCurrency(summary.byStatus.find((s) => s.status === "SUBMITTED")?.amount ?? 0)}
          hint={`${summary.byStatus.find((s) => s.status === "SUBMITTED")?.count ?? 0} claim(s)`}
          tone="warning"
        />
        <Stat
          label="Payable now"
          value={formatCurrency(summary.payable)}
          hint={`${summary.payableCount} approved & reimbursable`}
          tone={summary.payable > 0 ? "danger" : undefined}
        />
        <Stat
          label="Reimbursed"
          value={formatCurrency(summary.byStatus.find((s) => s.status === "REIMBURSED")?.amount ?? 0)}
          hint={`${summary.byStatus.find((s) => s.status === "REIMBURSED")?.count ?? 0} claim(s)`}
          tone="success"
        />
      </div>

      {topCategories.length > 0 && (
        <Card className="mt-4 px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Where it goes</div>
          <div className="mt-2 space-y-1.5">
            {topCategories.map((c) => (
              <div key={c.category} className="flex items-center gap-3 text-sm">
                <span className="w-44 shrink-0 truncate text-muted">{expenseCategoryLabels[c.category]}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                  <span
                    className="block h-full rounded-full bg-brand"
                    style={{ width: maxCategory > 0 ? `${Math.max((c.amount / maxCategory) * 100, 2)}%` : "0%" }}
                  />
                </span>
                <span className="w-28 shrink-0 text-right font-medium text-text">{formatCurrency(c.amount)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search description, company or claimant…" />
        <SelectParamFilter
          paramName="status"
          label="Status"
          options={expenseStatusValues.map((s) => ({ value: s, label: expenseStatusLabels[s] }))}
        />
        <SelectParamFilter
          paramName="category"
          label="Category"
          options={expenseCategoryValues.map((c) => ({ value: c, label: expenseCategoryLabels[c] }))}
        />
        {view === "all" && (
          <SelectParamFilter
            paramName="user"
            label="Claimant"
            allLabel="Everyone visible"
            options={users.map((u) => ({ value: u.id, label: u.name }))}
          />
        )}
        <SelectParamFilter
          paramName="reimbursable"
          label="Reimbursable"
          options={[
            { value: "yes", label: "Reimbursable" },
            { value: "no", label: "Company paid" },
          ]}
        />
        <DateRangePicker fromParam="from" toParam="to" label="Spent on" />
      </div>

      <div className="mt-5">
        <ExpensesTable
          expenses={result.rows}
          currentUserId={userId}
          canReimburse={canReimburse}
          holdsHrApproval={holdsHrApproval}
          emptyText={
            view === "mine"
              ? "You haven't claimed any expenses yet — select New expense to add one."
              : view === "approve"
                ? "Nothing is waiting on your approval."
                : undefined
          }
        />
      </div>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={result.total}
        totalPages={totalPages(result.total, pageSize)}
        pageSizes={PAGE_SIZES}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "danger" | "success" | "warning";
}) {
  const toneClass =
    tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : "text-text";
  return (
    <Card className="px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-0.5 text-xs text-muted">{hint}</div>
    </Card>
  );
}
