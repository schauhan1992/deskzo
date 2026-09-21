import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { assetsHeldBy } from "@/actions/it-asset";
import { currentUser } from "@/lib/session";
import { Card } from "@/components/ui/card";
import { MyAssets } from "@/components/assets/my-assets";

export default async function MyAssetsPage() {
  const enabled = await isModuleEnabled("it_assets");
  if (!enabled) return <ModuleDisabledNotice moduleKey="it_assets" />;

  const user = await currentUser();
  if (!user) return null;
  const assets = await assetsHeldBy(user.id);

  return (
    <div className="animate-fade-rise">
      <h1 className="text-xl font-semibold text-text">What I&apos;m holding</h1>
      <p className="mt-1 text-sm text-muted">
        Company equipment on your name. It stays here until it&apos;s handed back — which is also what the
        offboarding checklist reads when somebody leaves.
      </p>

      <div className="mt-5">
        {assets.length === 0 ? (
          <Card className="px-6 py-10 text-center text-sm text-subtle">
            Nothing is assigned to you.
          </Card>
        ) : (
          <MyAssets assets={assets} />
        )}
      </div>
    </div>
  );
}
