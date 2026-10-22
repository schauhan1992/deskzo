import { notFound } from "next/navigation";
import { accountsReport, type AccountsReportKey, type AccountsReportParams } from "@/actions/accounts-reports";
import { Card } from "@/components/ui/card";
import { ReportView } from "@/components/reports/accounts/report-view";
import { ReportExportButton } from "@/components/reports/accounts/export-button";

/**
 * One accounting report under its filters: its title and period, the CSV download for whoever may take it, and
 * the table. The page around it has already asked whether the module is on; the action asks the permission.
 */
export async function AccountsReportBody({
  report,
  params,
  page,
  pageSize,
  canExport,
  emptyText,
}: {
  report: AccountsReportKey;
  params: AccountsReportParams;
  page?: string;
  pageSize?: string;
  canExport: boolean;
  emptyText?: string;
}) {
  const result = await accountsReport(report, { ...params, page, pageSize });
  if (result.status === "forbidden") notFound();
  if (result.status === "not-migrated") {
    return <Card className="mt-4 p-5 text-sm text-muted">This workspace&apos;s database hasn&apos;t been brought up to date for this report yet.</Card>;
  }
  if (result.status === "invalid") return <Card className="mt-4 p-5 text-sm text-danger">{result.message}</Card>;
  const { table } = result;
  return (
    <>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-text">{table.title}</h2>
          {table.subtitle && <p className="text-sm text-subtle">{table.subtitle}</p>}
        </div>
        {canExport && table.rows.length > 0 && <ReportExportButton kind="accounts" report={report} params={params} />}
      </div>
      <ReportView table={table} emptyText={emptyText} />
    </>
  );
}
