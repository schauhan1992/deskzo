import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { inventoryCapabilities, listWarehouses } from "@/actions/inventory";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { InventoryNotReady } from "@/components/inventory/not-ready";
import { StockDocumentForm } from "@/components/inventory/stock-document-form";
import { isStockDocumentType, STOCK_DOCUMENT_TYPES, stockTypeHint, stockTypeLabel, stockTypeNeeds } from "@/components/inventory/labels";
import { Card, CardContent } from "@/components/ui/card";
import { workspaceClock } from "@/lib/time/workspace";

/** A new stock voucher of the kind the address names — or, without one, the kinds this person may write. */
export default async function NewStockVoucherPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  if (!(await isModuleEnabled("items"))) return <ModuleDisabledNotice moduleKey="items" />;
  const caps = await inventoryCapabilities();
  if (!caps.view) notFound();
  if (!caps.migrated) return <InventoryNotReady title="New stock voucher" />;
  const { type } = await searchParams;

  if (!isStockDocumentType(type)) {
    const kinds = STOCK_DOCUMENT_TYPES.filter((t) => caps[stockTypeNeeds[t]]);
    if (kinds.length === 0) notFound();
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold text-text">New stock voucher</h1>
        <div className="grid gap-3 sm:grid-cols-2">
          {kinds.map((t) => (
            <Link key={t} href={`/items/stock/new?type=${t}`}>
              <Card className="h-full">
                <CardContent>
                  <div className="font-medium text-text">{stockTypeLabel[t]}</div>
                  <p className="mt-1 text-sm text-muted">{stockTypeHint[t]}</p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    );
  }
  if (!caps[stockTypeNeeds[type]]) notFound();

  const [warehouses, clock] = await Promise.all([listWarehouses(), workspaceClock()]);
  const first = warehouses.find((w) => w.isDefault) ?? warehouses[0];
  if (!first) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold text-text">New {stockTypeLabel[type].toLowerCase()}</h1>
        <p className="text-sm text-muted">
          There&apos;s no open warehouse. <Link href="/items/warehouses" className="text-brand hover:underline">Add one</Link> first.
        </p>
      </div>
    );
  }
  return (
    <StockDocumentForm
      type={type}
      warehouses={warehouses.map((w) => ({ id: w.id, name: w.name, code: w.code, isDefault: w.isDefault }))}
      initial={{
        date: clock.today(),
        warehouseId: first.id,
        toWarehouseId: "",
        vendor: null,
        purchaseOrder: null,
        billId: null,
        reference: "",
        reason: "",
        notes: "",
        lines: [],
      }}
    />
  );
}
