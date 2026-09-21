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
  const [item, brands] = await Promise.all([getItem(id), listBrands()]);
  if (!item) notFound();

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">Edit item</h1>
      <div className="mt-6">
        <EditItemForm item={item} brands={brands} />
      </div>
    </div>
  );
}
