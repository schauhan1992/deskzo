import { auth } from "@/lib/auth";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listAccounts } from "@/actions/ledger";
import { ChartManager } from "@/components/accounting/chart-manager";
import { can } from "@/lib/authz/resolve";
import { notFound } from "next/navigation";
import { viewerHas } from "@/actions/permission";

export default async function ChartOfAccountsPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const enabled = await isModuleEnabled("accounting");
  if (!enabled) return <ModuleDisabledNotice moduleKey="accounting" />;
  // The reports' readers and whoever keeps the chart — its link's terms; a 404 for anybody else.
  if (!(await viewerHas("ledger.viewReports")) && !(await viewerHas("ledger.manageAccounts"))) notFound();

  const [session, accounts, params] = await Promise.all([auth(), listAccounts(), searchParams]);
  const canEdit = session ? await can(session.user.id, "ledger.manageAccounts") : false;

  return (
    <div className="animate-fade-rise">
      {/* `?new=1` — BUSY's Alt + F1 and the New master menu (src/lib/shortcuts/busy.ts) — opens with a new account. */}
      <ChartManager accounts={accounts} canEdit={canEdit} startNew={canEdit && params.new === "1"} />
    </div>
  );
}
