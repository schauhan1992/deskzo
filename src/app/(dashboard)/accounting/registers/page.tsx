import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { accountsReportAccess, type AccountsReportKey } from "@/actions/accounts-reports";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getOrganisation } from "@/lib/organisation";
import { ReportHeader } from "@/components/accounting/report-chrome";
import { DateParamInput } from "@/components/accounting/date-param-input";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { TabNav } from "@/components/ui/tab-nav";
import { AccountsReportBody } from "@/components/reports/accounts/accounts-report-body";
import { indiaClock } from "@/lib/time/zone";
import { financialYearBounds } from "@/lib/india-time";

/**
 * The registers (owner, 22 Oct 2026): sales and purchases document by document with their tax, the journal
 * register, expenses month by month, a GST summary, and the audit history of vouchers — a tab each, filters in
 * the address. The books' reader's (`ledger.viewReports`).
 */

type Register = Extract<AccountsReportKey, "sales" | "purchase" | "journal" | "expenses" | "gst" | "audit">;

const TABS: { key: Register; label: string }[] = [
  { key: "sales", label: "Sales register" },
  { key: "purchase", label: "Purchase register" },
  { key: "journal", label: "Journal register" },
  { key: "expenses", label: "Expenses by month" },
  { key: "gst", label: "GST summary" },
  { key: "audit", label: "Audit history" },
];

const ENTITIES = [
  { value: "vouchers", label: "Vouchers" },
  { value: "stock", label: "Stock vouchers" },
];

export default async function RegistersPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!(await isModuleEnabled("accounting"))) return <ModuleDisabledNotice moduleKey="accounting" />;
  const access = await accountsReportAccess();
  if (!access.books) notFound();
  const params = await searchParams;
  const register: Register = TABS.some((t) => t.key === params.register) ? (params.register as Register) : "sales";
  const org = await getOrganisation();
  const today = indiaClock.today();
  const yearly = register === "expenses" || register === "gst";
  const fromFallback = register === "audit" ? undefined : yearly ? financialYearBounds(new Date()).from : `${today.slice(0, 7)}-01`;

  return (
    <div className="animate-fade-rise">
      <ReportHeader title="Registers" subtitle="Sales, purchases, journals, expenses, GST and the voucher trail" organisation={org.legalName}>
        <div className="flex flex-wrap items-center gap-3">
          <DateParamInput paramName="from" label="From" fallback={fromFallback} />
          <DateParamInput paramName="to" label="To" fallback={register === "audit" ? undefined : today} />
        </div>
      </ReportHeader>

      <div className="mt-4 overflow-x-auto">
        <TabNav tabs={TABS} activeKey={register} paramName="register" basePath="/accounting/registers" />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {(register === "sales" || register === "purchase") && <SearchParamInput paramName="q" placeholder={register === "sales" ? "Number or customer…" : "Number or vendor…"} className="w-72" />}
        {register === "journal" && <SearchParamInput paramName="q" placeholder="Entry number or narration…" className="w-72" />}
        {register === "audit" && (
          <>
            <SearchParamInput paramName="q" placeholder="Voucher number or what happened…" className="w-72" />
            <SelectParamFilter paramName="entity" label="Records" allLabel="Vouchers and stock vouchers" options={ENTITIES} />
          </>
        )}
        {register === "gst" && access.gstReturns && (
          <Link href="/accounting/gst" className="text-sm text-brand hover:underline">
            GSTR-1 and GSTR-3B for filing →
          </Link>
        )}
      </div>

      <AccountsReportBody
        report={register}
        params={{ from: params.from, to: params.to, q: params.q, party: params.party, entity: params.entity }}
        page={params.page}
        pageSize={params.pageSize}
        canExport={access.export}
      />
    </div>
  );
}
