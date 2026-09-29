import { notFound } from "next/navigation";
import { getItem } from "@/actions/item";
import { listBrands } from "@/actions/brand";
import { isModuleEnabled } from "@/actions/module";
import { EditItemForm } from "@/components/items/edit-item-form";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";

export default async function EditItemPage({ params }: { params: Promise<{ id: string }> }) {
  const enabled = await isModuleEnabled("items");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="items" />;
  }

  const { id } = await params;
  // How revenue is recognised is asked only where Revenue & Close is available.
  const [item, brands, revenueCapture] = await Promise.all([getItem(id), listBrands(), isModuleEnabled("revenue_close")]);
  if (!item) notFound();

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">Edit item</h1>
      <div className="mt-6">
        <EditItemForm item={item} brands={brands} showRevenuePattern={revenueCapture} />
      </div>
    </div>
  );
}
