import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listSuppressions } from "@/actions/marketing";
import { hasEffectivePermission } from "@/actions/permission";
import { currentUser } from "@/lib/session";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SuppressionList } from "@/components/marketing/suppression-list";

export default async function SuppressionsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>;
}) {
  const enabled = await isModuleEnabled("marketing");
  if (!enabled) return <ModuleDisabledNotice moduleKey="marketing" />;

  const { search } = await searchParams;
  const user = await currentUser();
  const [rows, canManage] = await Promise.all([
    listSuppressions(search),
    user ? hasEffectivePermission(user.id, "marketing.manage") : Promise.resolve(false),
  ]);

  return (
    <div className="animate-fade-rise">
      <h1 className="text-xl font-semibold text-text">Suppression list</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Only what somebody told us: an unsubscribe, a bounce, a spam complaint, or a decision made here. Everything
        else that stops a send — a reseller&apos;s customer, an unanswered complaint, an unverified address — is worked
        out fresh each time, so fixing the problem is enough on its own.
      </p>

      <div className="mt-5">
        <SearchParamInput paramName="search" placeholder="Address or domain" className="w-72" />
      </div>

      <div className="mt-4">
        <SuppressionList rows={rows} canManage={canManage} />
      </div>
    </div>
  );
}
