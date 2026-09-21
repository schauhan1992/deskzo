import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { dispatchableAssets, listConsignments } from "@/actions/consignment";
import { transporterOptions } from "@/actions/transporter";
import { assetFormOptions } from "@/actions/it-asset";
import { hasEffectivePermission } from "@/actions/permission";
import { currentUser } from "@/lib/session";
import { Card } from "@/components/ui/card";
import { ConsignmentBoard } from "@/components/assets/consignment-board";
import { intraStateThreshold } from "@/lib/eway/settings";

export default async function LogisticsPage() {
  const enabled = await isModuleEnabled("it_assets");
  if (!enabled) return <ModuleDisabledNotice moduleKey="it_assets" />;

  const user = await currentUser();
  const canManage = user ? await hasEffectivePermission(user.id, "assets.manage") : false;
  if (!canManage) {
    return (
      <Card className="px-6 py-10 text-center text-sm text-muted">
        Dispatching kit sits behind the asset-management permission.
      </Card>
    );
  }

  const [consignments, assets, options, transporters, threshold] = await Promise.all([
    listConsignments(),
    dispatchableAssets(),
    assetFormOptions(),
    transporterOptions(),
    intraStateThreshold(),
  ]);

  return (
    <div className="animate-fade-rise">
      <div>
        <h1 className="text-xl font-semibold text-text">Consignments</h1>
        <p className="mt-1 text-sm text-muted">
          Getting kit about: what&apos;s in transit, what paperwork travels with it, and whether it needs an e-way
          bill. Only a sale moves on an invoice — everything else moves on a delivery challan, because nothing is
          being sold.
        </p>
      </div>
      <div className="mt-5">
        <ConsignmentBoard
          consignments={consignments}
          assets={assets}
          companies={options.companies}
          transporters={transporters.ok ? transporters.data : []}
          intraStateThreshold={threshold}
        />
      </div>
    </div>
  );
}
