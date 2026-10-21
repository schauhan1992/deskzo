import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { inventoryCapabilities, listUnits } from "@/actions/inventory";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { InventoryNotReady } from "@/components/inventory/not-ready";
import { UnitsManager } from "@/components/inventory/units-manager";
import { Card, CardContent } from "@/components/ui/card";

/** Units of measure (owner, 22 Oct 2026), under Finance → Accounts › Masters. */
export default async function UnitsPage() {
  if (!(await isModuleEnabled("items"))) return <ModuleDisabledNotice moduleKey="items" />;
  const caps = await inventoryCapabilities();
  if (!caps.view) notFound();
  if (!caps.migrated) return <InventoryNotReady title="Units of measure" />;
  const units = await listUnits();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Units of measure</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          The units quantities are kept in — the GST portal&apos;s codes come ready. An item can also be bought or sold in other units (a box of 12),
          set on the item&apos;s own page.
        </p>
      </div>
      <Card>
        <CardContent>
          <UnitsManager units={units} canManage={caps.manage} />
        </CardContent>
      </Card>
    </div>
  );
}
