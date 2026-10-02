import { isModuleEnabled } from "@/actions/module";
import { listBrands } from "@/actions/brand";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { NewItemForm } from "@/components/items/new-item-form";
import { requireUser } from "@/lib/session";
import { formSetup } from "@/lib/custom-fields/server";

export default async function NewItemPage() {
  const enabled = await isModuleEnabled("items");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="items" />;
  }

  // How revenue is recognised is asked only where Revenue & Close is available.
  const user = await requireUser();
  const [brands, revenueCapture, customFields] = await Promise.all([listBrands(), isModuleEnabled("revenue_close"), formSetup("ITEM", user.id)]);

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">New item</h1>
      <p className="mt-1 text-sm text-muted">
        SKU must be unique. Goods, services, subscriptions, and perpetual licences share this catalog — only goods
        track stock, and only subscriptions ever come up for renewal.
      </p>
      <NewItemForm brands={brands} showRevenuePattern={revenueCapture} customFields={customFields} />
    </div>
  );
}
