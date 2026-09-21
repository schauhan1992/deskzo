import { auth } from "@/lib/auth";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listAccounts } from "@/actions/ledger";
import { ChartManager } from "@/components/accounting/chart-manager";
import { can } from "@/lib/authz/resolve";

export default async function ChartOfAccountsPage() {
  const enabled = await isModuleEnabled("accounting");
  if (!enabled) return <ModuleDisabledNotice moduleKey="accounting" />;

  const [session, accounts] = await Promise.all([auth(), listAccounts()]);

  return (
    <div className="animate-fade-rise">
      <ChartManager accounts={accounts} canEdit={session ? await can(session.user.id, "ledger.manageAccounts") : false} />
    </div>
  );
}
