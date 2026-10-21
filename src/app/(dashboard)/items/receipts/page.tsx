import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { StockDocumentsView, type StockListParams } from "@/components/inventory/stock-documents-view";

/**
 * Goods receipts alone (owner, 22 Oct 2026) — the purchase side's step between a purchase order and its bill:
 * PO → GRN → bill → payment. The same list as Stock vouchers, fixed to receipts.
 */
export default async function GoodsReceiptsPage({ searchParams }: { searchParams: Promise<StockListParams> }) {
  if (!(await isModuleEnabled("items"))) return <ModuleDisabledNotice moduleKey="items" />;
  return (
    <StockDocumentsView
      params={await searchParams}
      basePath="/items/receipts"
      fixedType="GRN"
      title="Goods receipts (GRN)"
      intro="Goods in from vendors, against a purchase order or on their own, with what was accepted and what was rejected. A receipt adds to stock when posted; the vendor's bill for it then clears what the receipt left owing."
    />
  );
}
