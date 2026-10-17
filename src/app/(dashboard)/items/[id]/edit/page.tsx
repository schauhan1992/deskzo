import { notFound } from "next/navigation";
import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";
import { getItem } from "@/actions/item";
import { listBrands } from "@/actions/brand";
import { isModuleEnabled } from "@/actions/module";
import { countryFeatureAvailable, moduleAvailableForTenant } from "@/lib/modules-access";
import { listItemCategories } from "@/actions/item-category";
import { EditItemForm } from "@/components/items/edit-item-form";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";

export default async function EditItemPage({ params }: { params: Promise<{ id: string }> }) {
  const enabled = await isModuleEnabled("items");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="items" />;
  }

  const { id } = await params;
  // How revenue is recognised is asked only where Revenue & Close is available.
  const [item, brands, revenueCapture, hsnRequired, categories, subscriptions, wording] = await Promise.all([
    getItem(id),
    listBrands(),
    isModuleEnabled("revenue_close"),
    countryFeatureAvailable("hsn"),
    listItemCategories(),
    moduleAvailableForTenant("renewals"),
    // The workspace's own word for an item (Settings → Wording).
    getWording(),
  ]);
  if (!item) notFound();

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">{slot(wording, "Edit item", "item", "Edit {one:lower}")}</h1>
      <div className="mt-6">
        <EditItemForm item={item} brands={brands} showRevenuePattern={revenueCapture} hsnRequired={hsnRequired} categories={categories} subscriptions={subscriptions} />
      </div>
    </div>
  );
}
