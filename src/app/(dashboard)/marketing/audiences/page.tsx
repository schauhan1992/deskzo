import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listAudiences } from "@/actions/marketing";
import { hasEffectivePermission } from "@/actions/permission";
import { currentUser } from "@/lib/session";
import { AudienceList } from "@/components/marketing/audience-list";
import { AudienceEditor } from "@/components/marketing/audience-editor";
import { workbookFilterOptions } from "@/actions/workspace";

export default async function AudiencesPage() {
  const enabled = await isModuleEnabled("marketing");
  if (!enabled) return <ModuleDisabledNotice moduleKey="marketing" />;

  const user = await currentUser();
  const [audiences, canManage, filterOptions] = await Promise.all([
    listAudiences(),
    user ? hasEffectivePermission(user.id, "marketing.manage") : Promise.resolve(false),
    workbookFilterOptions(),
  ]);

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
      <h1 className="text-xl font-semibold text-text">Audiences</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        A saved set of filters, plus rules about which people at each company to write to. The company half is the
        same filter set the calling workspace uses, so the two can never disagree about who may be reached — and a
        reseller&apos;s end customers are excluded from both.
      </p>
        </div>
        {canManage && <AudienceEditor options={filterOptions} />}
      </div>

      <div className="mt-5">
        <AudienceList audiences={audiences} canManage={canManage} options={filterOptions} />
      </div>
    </div>
  );
}
