import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { StockDocumentsView, type StockListParams } from "@/components/inventory/stock-documents-view";

/**
 * Stock vouchers (owner, 22 Oct 2026): goods receipts, transfers, adjustments, physical counts and purchase
 * returns, under Finance → Accounts › Inventory. Reading them is `inventory.view`; writing each kind, its own
 * permission (src/actions/inventory.ts).
 */
export default async function StockVouchersPage({ searchParams }: { searchParams: Promise<StockListParams> }) {
  if (!(await isModuleEnabled("items"))) return <ModuleDisabledNotice moduleKey="items" />;
  return (
    <StockDocumentsView
      params={await searchParams}
      basePath="/items/stock"
      title="Stock vouchers"
      intro="Every change to stock that isn't a sale or a bill: goods received, moved between warehouses, found, written off, counted, or sent back to a vendor. A voucher moves stock only once it is posted, and is undone by cancelling it — never by editing or deleting."
    />
  );
}
