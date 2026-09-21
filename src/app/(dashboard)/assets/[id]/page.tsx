import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { assetFormOptions, getAsset } from "@/actions/it-asset";
import { hasEffectivePermission } from "@/actions/permission";
import { currentUser } from "@/lib/session";
import { AssetRecord } from "@/components/assets/asset-record";

export default async function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  const enabled = await isModuleEnabled("it_assets");
  if (!enabled) return <ModuleDisabledNotice moduleKey="it_assets" />;

  const { id } = await params;
  const user = await currentUser();
  const [asset, options, canManage] = await Promise.all([
    getAsset(id),
    assetFormOptions(),
    user ? hasEffectivePermission(user.id, "assets.manage") : Promise.resolve(false),
  ]);
  if (!asset) notFound();

  return (
    <div className="animate-fade-rise">
      <AssetRecord asset={asset} canManage={canManage} people={options.people} companies={options.companies} />
    </div>
  );
}
