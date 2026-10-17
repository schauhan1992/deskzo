import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";
import { isModuleEnabled } from "@/actions/module";
import { countryFeatureAvailable, moduleAvailableForTenant } from "@/lib/modules-access";
import { listItemCategories } from "@/actions/item-category";
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
  // HSN/SAC is required where it is the tax's classification — an Indian workspace.
  // A service may be managed as a subscription only where Renewals is (Deskzo Subscriptions, or One).
  const [brands, revenueCapture, customFields, hsnRequired, categories, subscriptions, wording] = await Promise.all([
    listBrands(),
    isModuleEnabled("revenue_close"),
    formSetup("ITEM", user.id),
    countryFeatureAvailable("hsn"),
    listItemCategories(),
    moduleAvailableForTenant("renewals"),
    // The workspace's own word for an item (Settings → Wording).
    getWording(),
  ]);

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">{slot(wording, "New item", "item", "New {one:lower}")}</h1>
      <p className="mt-1 text-sm text-muted">
        SKU must be unique. Goods and services share this catalog — only goods track stock, and only a service
        managed as a subscription ever comes up for renewal.
      </p>
      <NewItemForm brands={brands} showRevenuePattern={revenueCapture} customFields={customFields} hsnRequired={hsnRequired} categories={categories} subscriptions={subscriptions} />
    </div>
  );
}
