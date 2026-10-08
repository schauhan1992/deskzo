import { auth } from "@/lib/auth";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listAccounts } from "@/actions/ledger";
import { ChartManager } from "@/components/accounting/chart-manager";
import { can } from "@/lib/authz/resolve";
import { notFound } from "next/navigation";
import { viewerHas } from "@/actions/permission";

export default async function ChartOfAccountsPage() {
  const enabled = await isModuleEnabled("accounting");
  if (!enabled) return <ModuleDisabledNotice moduleKey="accounting" />;
  // The reports' readers and whoever keeps the chart — its link's terms; a 404 for anybody else.
  if (!(await viewerHas("ledger.viewReports")) && !(await viewerHas("ledger.manageAccounts"))) notFound();

  const [session, accounts] = await Promise.all([auth(), listAccounts()]);

  return (
    <div className="animate-fade-rise">
      <ChartManager accounts={accounts} canEdit={session ? await can(session.user.id, "ledger.manageAccounts") : false} />
    </div>
  );
}
