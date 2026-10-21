import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { inventoryCapabilities, listWarehouses } from "@/actions/inventory";
import { listBranchOptions } from "@/actions/branch";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { InventoryNotReady } from "@/components/inventory/not-ready";
import { WarehousesManager } from "@/components/inventory/warehouses-manager";
import { Card, CardContent } from "@/components/ui/card";

/** Warehouses (owner, 22 Oct 2026), under Finance → Accounts › Masters: read with “View stock”, set up with “Set up inventory”. */
export default async function WarehousesPage() {
  if (!(await isModuleEnabled("items"))) return <ModuleDisabledNotice moduleKey="items" />;
  const caps = await inventoryCapabilities();
  if (!caps.view) notFound();
  if (!caps.migrated) return <InventoryNotReady title="Warehouses" />;
  const [warehouses, branches] = await Promise.all([listWarehouses({ includeClosed: true }), caps.manage ? listBranchOptions() : Promise.resolve([])]);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Warehouses</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Where stock is kept. Every receipt, sale and transfer moves stock in one of these; the default takes whatever names none.
          {caps.manage ? "" : " Adding or changing one needs “Set up inventory”."}
        </p>
      </div>
      <Card>
        <CardContent>
          <WarehousesManager warehouses={warehouses} branches={branches.filter((b) => b.active).map((b) => ({ id: b.id, name: b.name }))} canManage={caps.manage} />
        </CardContent>
      </Card>
    </div>
  );
}
