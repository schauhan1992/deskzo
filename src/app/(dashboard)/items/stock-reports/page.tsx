import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { stockReport, stockReportAccess, stockReportOptions, type StockReportKey, type StockReportParams } from "@/actions/stock-reports";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Card } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tab-nav";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateParamInput } from "@/components/accounting/date-param-input";
import { ReportView } from "@/components/reports/accounts/report-view";
import { ReportExportButton } from "@/components/reports/accounts/export-button";
import { indiaClock } from "@/lib/time/zone";
import { financialYearBounds } from "@/lib/india-time";

/**
 * Finance → Accounts → Reports: the stock reports (owner, 22 Oct 2026) — one page, a tab per report, its
 * filters in the address so a report is a link somebody can send. Everything is worked out on the server
 * (src/actions/stock-reports.ts), a page at a time, with totals over every row the filters match.
 */

type Params = Record<string, string | undefined>;

const TABS: { key: StockReportKey; label: string }[] = [
  { key: "summary", label: "Summary" },
  { key: "warehouses", label: "By warehouse" },
  { key: "ledger", label: "Item ledger" },
  { key: "movements", label: "Movements" },
  { key: "transfers", label: "Transfers" },
  { key: "batches", label: "Batches & expiry" },
  { key: "serials", label: "Serials" },
  { key: "reorder", label: "Reorder" },
  { key: "variance", label: "Count variance" },
  { key: "valuation", label: "Valuation" },
  { key: "aging", label: "Aging" },
  { key: "slow", label: "Slow & dead" },
  { key: "profitability", label: "Profitability" },
];

const MOVEMENT_TYPES = [
  ["OPENING", "Opening"], ["RECEIVED", "Received"], ["SOLD", "Sold"], ["RETURNED", "Returned"], ["ADJUSTMENT", "Adjustment"],
  ["DAMAGED", "Damaged / written off"], ["TRANSFER_IN", "Transfer in"], ["TRANSFER_OUT", "Transfer out"], ["PURCHASE_RETURN", "Returned to vendor"],
].map(([value, label]) => ({ value: value!, label: label! }));
const SOURCES = [
  ["OPENING", "Opening stock"], ["SALES_INVOICE", "Sales invoice"], ["CREDIT_NOTE", "Credit note"], ["PURCHASE_BILL", "Vendor bill"], ["GRN", "Goods receipt"],
  ["TRANSFER", "Transfer"], ["ADJUSTMENT", "Adjustment"], ["PHYSICAL_COUNT", "Physical count"], ["PURCHASE_RETURN", "Purchase return"], ["MANUAL", "Manual"], ["MIGRATION", "Brought forward"],
].map(([value, label]) => ({ value: value!, label: label! }));
const TRANSFER_STATUSES = [
  { value: "IN_TRANSIT", label: "In transit" },
  { value: "POSTED", label: "Received" },
  { value: "DRAFT", label: "Draft" },
  { value: "CANCELLED", label: "Cancelled" },
];
const SERIAL_STATUSES = [
  { value: "IN_STOCK", label: "In stock" },
  { value: "ISSUED", label: "Sold / issued" },
  { value: "RETURNED_TO_VENDOR", label: "Returned to vendor" },
  { value: "SCRAPPED", label: "Written off" },
];
const EXPIRY = [
  { value: "expired", label: "Expired" },
  { value: "30", label: "Expiring in 30 days" },
  { value: "60", label: "Expiring in 60 days" },
  { value: "90", label: "Expiring in 90 days" },
  { value: "180", label: "Expiring in 180 days" },
];
const IDLE = [30, 60, 90, 180, 365].map((d) => ({ value: String(d), label: `${d} days` }));

export default async function StockReportsPage({ searchParams }: { searchParams: Promise<Params> }) {
  if (!(await isModuleEnabled("items"))) return <ModuleDisabledNotice moduleKey="items" />;
  const access = await stockReportAccess();
  if (!access.view) notFound();

  const params = await searchParams;
  const tabs = TABS.filter((t) => t.key !== "profitability" || access.profitability);
  const report: StockReportKey = tabs.some((t) => t.key === params.report) ? (params.report as StockReportKey) : "summary";

  if (!access.migrated) {
    return (
      <div>
        <h1 className="text-xl font-semibold text-text">Stock reports</h1>
        <Card className="mt-4 p-5 text-sm text-muted">
          This workspace&apos;s database hasn&apos;t been brought up to date for inventory yet. The stock reports appear once it has.
        </Card>
      </div>
    );
  }

  const filters: StockReportParams = {
    q: params.q, warehouse: params.warehouse, category: params.category, brand: params.brand, item: params.item,
    from: params.from, to: params.to, asOf: params.asOf, type: params.type, source: params.source, status: params.status,
    expiry: params.expiry, days: params.days,
  };
  const [result, options] = await Promise.all([stockReport(report, { ...filters, page: params.page, pageSize: params.pageSize }), stockReportOptions()]);
  if (result.status === "forbidden") notFound();

  const today = indiaClock.today();
  const has = (...keys: string[]) => keys.includes(report);
  const warehouseFilter = options.warehouses.length > 1 && <SelectParamFilter paramName="warehouse" label="Warehouse" allLabel="Every warehouse" options={options.warehouses} />;
  const categoryFilter = options.categories.length > 0 && <SelectParamFilter paramName="category" label="Category" allLabel="Every category" options={options.categories} />;
  const brandFilter = options.brands.length > 0 && <SelectParamFilter paramName="brand" label="Brand" allLabel="Every brand" options={options.brands} />;

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Stock reports</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            What&apos;s on hand and what it&apos;s worth, where it is, how it moved, and what needs attention — from the stock
            engine&apos;s own balances and movement log.
          </p>
        </div>
        {access.export && result.status === "ok" && result.table.rows.length > 0 && <ReportExportButton kind="stock" report={report} params={filters} />}
      </div>

      <div className="mt-4 overflow-x-auto">
        <TabNav tabs={tabs} activeKey={report} paramName="report" basePath="/items/stock-reports" />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {has("summary", "warehouses", "movements", "batches", "serials", "reorder", "variance", "valuation", "aging", "slow", "profitability") && (
          <SearchParamInput paramName="q" placeholder={report === "serials" ? "Serial or item…" : report === "batches" ? "Batch or item…" : "Item name or SKU…"} className="w-64" />
        )}
        {report === "ledger" && !params.item && <SearchParamInput paramName="q" placeholder="Find the item…" className="w-64" />}
        {report === "ledger" && params.item && (
          <Link href="/items/stock-reports?report=ledger" className="text-sm text-brand hover:underline">
            Choose another item
          </Link>
        )}
        {has("summary", "warehouses", "reorder", "valuation", "aging", "slow", "profitability") && categoryFilter}
        {has("summary", "warehouses", "reorder") && brandFilter}
        {has("summary", "warehouses", "ledger", "movements", "transfers", "batches", "serials", "reorder", "variance", "valuation", "aging", "slow") && warehouseFilter}
        {report === "movements" && (
          <>
            <SelectParamFilter paramName="type" label="Movement" allLabel="Every movement" options={MOVEMENT_TYPES} />
            <SelectParamFilter paramName="source" label="From" allLabel="Every source" options={SOURCES} />
          </>
        )}
        {report === "transfers" && <SelectParamFilter paramName="status" label="Status" allLabel="Every status" options={TRANSFER_STATUSES} />}
        {report === "serials" && <SelectParamFilter paramName="status" label="Status" allLabel="Every status" options={SERIAL_STATUSES} />}
        {report === "batches" && <SelectParamFilter paramName="expiry" label="Expiry" allLabel="Every batch" options={EXPIRY} />}
        {report === "slow" && <SelectParamFilter paramName="days" label="Nothing out in" allLabel="90 days" options={IDLE.filter((d) => d.value !== "90")} />}
        {has("ledger", "movements", "transfers", "variance") && (
          <>
            <DateParamInput paramName="from" label="From" />
            <DateParamInput paramName="to" label="To" />
          </>
        )}
        {report === "profitability" && (
          <>
            <DateParamInput paramName="from" label="From" fallback={financialYearBounds(new Date()).from} />
            <DateParamInput paramName="to" label="To" fallback={today} />
          </>
        )}
        {report === "valuation" && <DateParamInput paramName="asOf" label="As of" fallback={today} />}
      </div>

      {result.status === "not-migrated" && (
        <Card className="mt-4 p-5 text-sm text-muted">This workspace&apos;s database hasn&apos;t been brought up to date for inventory yet.</Card>
      )}
      {result.status === "invalid" && <Card className="mt-4 p-5 text-sm text-danger">{result.message}</Card>}
      {result.status === "ok" && (
        <>
          <div className="mt-4">
            <h2 className="text-base font-semibold text-text">{result.table.title}</h2>
            {result.table.subtitle && <p className="text-sm text-subtle">{result.table.subtitle}</p>}
          </div>
          <ReportView table={result.table} />
        </>
      )}
    </div>
  );
}
