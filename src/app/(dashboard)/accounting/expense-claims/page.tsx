import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { listExpenseClaimsForAccounts, unpostedExpenses, type ExpenseClaimsView } from "@/actions/expense";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Card } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tab-nav";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Pagination } from "@/components/ui/pagination";
import { UnpostedBanner } from "@/components/accounting/unposted-banner";
import { ExpenseClaimsTable } from "@/components/accounting/expense-claims-table";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { formatCurrency } from "@/lib/utils";

const VIEWS: { key: ExpenseClaimsView; label: string }[] = [
  { key: "to-pay", label: "To pay" },
  { key: "paid", label: "Paid" },
  { key: "company-paid", label: "Company paid" },
];

/**
 * Accounts' side of expense claims (owner, 19 Oct 2026: once HR approves a claim, it shows in Accounts).
 * A claim arrives here when it is approved — the moment it is booked as owed to the claimant — and is
 * paid back from here, which books the payment. For whoever pays claims (`expenses.reimburse`), or reads
 * every claim (`expenses.viewAll`).
 */
export default async function ExpenseClaimsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; q?: string; from?: string; to?: string; page?: string; pageSize?: string }>;
}) {
  if (!(await isModuleEnabled("accounting"))) return <ModuleDisabledNotice moduleKey="accounting" />;
  if (!(await isModuleEnabled("expenses"))) return <ModuleDisabledNotice moduleKey="expenses" />;

  const params = await searchParams;
  const view: ExpenseClaimsView = VIEWS.some((v) => v.key === params.view) ? (params.view as ExpenseClaimsView) : "to-pay";
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);

  const [result, unposted] = await Promise.all([
    listExpenseClaimsForAccounts({ view, search: params.q, from: params.from, to: params.to, page, pageSize }),
    unpostedExpenses(),
  ]);
  if (!result) notFound();

  return (
    <div className="animate-fade-rise">
      <h1 className="text-xl font-semibold text-text">Expense claims</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Official expenses people claimed, once they are approved. Approving a claim booked it to the ledger as owed to
        the claimant; marking it paid books the payment and tells them.
      </p>

      <UnpostedBanner expenses={unposted} payrollRuns={[]} />

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">To pay</div>
          <div className={`mt-1 text-lg font-semibold ${result.toPay.amount > 0 ? "text-danger" : "text-text"}`}>
            {formatCurrency(result.toPay.amount)}
          </div>
          <div className="mt-0.5 text-xs text-muted">{result.toPay.count} approved claim(s)</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">{VIEWS.find((v) => v.key === view)!.label}, as filtered</div>
          <div className="mt-1 text-lg font-semibold text-text">{formatCurrency(result.totalAmount)}</div>
          <div className="mt-0.5 text-xs text-muted">{result.total} claim(s)</div>
        </Card>
      </div>

      <div className="mt-5">
        <TabNav
          basePath="/accounting/expense-claims"
          paramName="view"
          activeKey={view}
          defaultKey="to-pay"
          tabs={VIEWS.map((v) => (v.key === "to-pay" ? { ...v, count: result.toPay.count } : v))}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search claimant, description or payment reference…" />
        <DateRangePicker fromParam="from" toParam="to" label="Spent on" />
      </div>

      <div className="mt-4">
        <ExpenseClaimsTable rows={result.rows} view={view} mayPay={result.mayPay} />
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
