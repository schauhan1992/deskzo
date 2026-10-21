import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { accountsReportAccess } from "@/actions/accounts-reports";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getOrganisation } from "@/lib/organisation";
import { ReportHeader } from "@/components/accounting/report-chrome";
import { DateParamInput } from "@/components/accounting/date-param-input";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { AccountsReportBody } from "@/components/reports/accounts/accounts-report-body";
import { indiaClock } from "@/lib/time/zone";

const SOURCES = [
  ["INVOICE", "Invoice"], ["CREDIT_NOTE", "Credit note"], ["BILL", "Bill"], ["PAYMENT", "Payment"], ["VOUCHER", "Voucher"], ["MANUAL", "Manual journal"],
  ["INVENTORY", "Inventory"], ["EXPENSE", "Expense"], ["PAYROLL", "Payroll"], ["DEPRECIATION", "Depreciation"], ["VENDOR_CREDIT", "Vendor credit"],
  ["REVENUE", "Revenue"], ["SCHEDULE", "Schedule"], ["FX", "Exchange"], ["OPENING", "Opening"], ["CLOSING", "Year end"],
].map(([value, label]) => ({ value: value!, label: label! }));

/**
 * The day book (owner, 22 Oct 2026): every posted entry in a period, line by line, in date order — this month
 * unless asked otherwise. The books' reader's (`ledger.viewReports`).
 */
export default async function DayBookPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!(await isModuleEnabled("accounting"))) return <ModuleDisabledNotice moduleKey="accounting" />;
  const access = await accountsReportAccess();
  if (!access.books) notFound();
  const params = await searchParams;
  const org = await getOrganisation();
  const today = indiaClock.today();
  return (
    <div className="animate-fade-rise">
      <ReportHeader title="Day book" subtitle="Every entry posted, line by line" organisation={org.legalName}>
        <div className="flex flex-wrap items-center gap-3">
          <DateParamInput paramName="from" label="From" fallback={`${today.slice(0, 7)}-01`} />
          <DateParamInput paramName="to" label="To" fallback={today} />
        </div>
      </ReportHeader>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Entry number or narration…" className="w-72" />
        <SelectParamFilter paramName="source" label="From" allLabel="Everything" options={SOURCES} />
      </div>
      <AccountsReportBody
        report="day-book"
        params={{ from: params.from, to: params.to, q: params.q, source: params.source }}
        page={params.page}
        pageSize={params.pageSize}
        canExport={access.export}
        emptyText="Nothing posted in this period."
      />
    </div>
  );
}
