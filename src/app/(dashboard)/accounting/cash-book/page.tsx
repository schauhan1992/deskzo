import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { accountsReportAccess, accountsReportOptions } from "@/actions/accounts-reports";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getOrganisation } from "@/lib/organisation";
import { ReportHeader } from "@/components/accounting/report-chrome";
import { DateParamInput } from "@/components/accounting/date-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { AccountsReportBody } from "@/components/reports/accounts/accounts-report-body";
import { indiaClock } from "@/lib/time/zone";

/**
 * The cash book and the bank books (owner, 22 Oct 2026): one bank or cash account's receipts and payments with
 * the balance after each, from the period's opening. For the books' reader, and for the finance function, who
 * keeps the bank.
 */
export default async function CashBookPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!(await isModuleEnabled("accounting"))) return <ModuleDisabledNotice moduleKey="accounting" />;
  const access = await accountsReportAccess();
  if (!access.cashBook) notFound();
  const params = await searchParams;
  const [org, options] = await Promise.all([getOrganisation(), accountsReportOptions()]);
  const today = indiaClock.today();
  const fallback = options.moneyAccounts.find((a) => a.cash) ?? options.moneyAccounts[0];
  return (
    <div className="animate-fade-rise">
      <ReportHeader title="Cash & bank book" subtitle="Receipts, payments and the running balance" organisation={org.legalName}>
        <div className="flex flex-wrap items-center gap-3">
          <DateParamInput paramName="from" label="From" fallback={`${today.slice(0, 7)}-01`} />
          <DateParamInput paramName="to" label="To" fallback={today} />
        </div>
      </ReportHeader>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {options.moneyAccounts.length > 0 && (
          <SelectParamFilter
            paramName="account"
            label="Account"
            allLabel={fallback ? `${fallback.label} (default)` : "Choose an account"}
            options={options.moneyAccounts.filter((a) => a.value !== fallback?.value).map(({ value, label }) => ({ value, label }))}
          />
        )}
      </div>
      <AccountsReportBody
        report="cash-book"
        params={{ from: params.from, to: params.to, account: params.account }}
        page={params.page}
        pageSize={params.pageSize}
        canExport={access.export}
        emptyText="Nothing went in or out of this account in the period."
      />
    </div>
  );
}
