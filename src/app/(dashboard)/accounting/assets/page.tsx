import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listAssetAccounts, listAssets, previewDepreciation } from "@/actions/asset";
import { listDepartmentOptions, listManagerOptions } from "@/actions/department";
import { getOrganisation } from "@/lib/organisation";
import { Card } from "@/components/ui/card";
import { ReportHeader } from "@/components/accounting/report-chrome";
import { MonthPicker } from "@/components/accounting/month-picker";
import { AssetsManager } from "@/components/accounting/assets-manager";

export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; year?: string; status?: string }>;
}) {
  const enabled = await isModuleEnabled("accounting");
  if (!enabled) return <ModuleDisabledNotice moduleKey="accounting" />;

  const params = await searchParams;
  const now = new Date();
  // Last month by default: this month isn't over, and depreciation is charged at a month end.
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const month = Number(params.month) || previous.getMonth() + 1;
  const year = Number(params.year) || previous.getFullYear();

  const [assets, preview, accounts, departments, people, org] = await Promise.all([
    listAssets({ status: (params.status as "ACTIVE" | "DISPOSED" | "ALL") ?? "ALL" }),
    previewDepreciation({ month, year }),
    listAssetAccounts(),
    listDepartmentOptions(),
    listManagerOptions(),
    getOrganisation(),
  ]);

  if (accounts.length === 0) {
    return (
      <Card className="px-6 py-10 text-center text-sm text-muted">
        The chart of accounts hasn&apos;t been set up yet. Open Accounting → Chart of Accounts first.
      </Card>
    );
  }

  return (
    <div className="animate-fade-rise">
      <ReportHeader
        title="Fixed assets"
        subtitle="What the company owns, what it's worth now, and the depreciation charged against it"
        organisation={org.legalName}
      >
        <MonthPicker month={month} year={year} />
      </ReportHeader>
      <div className="mt-5">
        <AssetsManager
          assets={assets}
          preview={preview}
          accounts={accounts}
          departments={departments}
          people={people}
          month={month}
          year={year}
        />
      </div>
    </div>
  );
}
