import { notFound, redirect } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { getStockDocument, listWarehouses } from "@/actions/inventory";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { StockDocumentForm, formInitialFromDocument } from "@/components/inventory/stock-document-form";

/** A draft stock voucher, changed. Anything past draft is changed only by cancelling it. */
export default async function EditStockVoucherPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isModuleEnabled("items"))) return <ModuleDisabledNotice moduleKey="items" />;
  const { id } = await params;
  const doc = await getStockDocument(id);
  if (!doc) notFound();
  if (!doc.can.edit) redirect(`/items/stock/${id}`);
  const warehouses = await listWarehouses();
  // A draft written for a warehouse closed since still shows it, so the form doesn't quietly change it.
  const choices = warehouses.some((w) => w.id === doc.warehouseId) ? warehouses : [...warehouses, { ...doc.warehouse, code: "closed", isDefault: false }];
  return (
    <StockDocumentForm
      type={doc.type}
      warehouses={choices.map((w) => ({ id: w.id, name: w.name, code: w.code, isDefault: w.isDefault }))}
      initial={formInitialFromDocument(doc)}
    />
  );
}
