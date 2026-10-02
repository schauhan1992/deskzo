"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ItemType } from "@prisma/client";
import { bulkUpdateItems } from "@/actions/item";
import { itemTypeValues, itemTypeLabels } from "@/lib/validation/item";
import { formatItemId } from "@/lib/order-id";
import { formatCurrency } from "@/lib/utils";
import { Badge, Card } from "@/components/ui/card";
import { CustomFieldBodyCells, CustomFieldHeaderCells, type CustomColumn } from "@/components/custom-fields/custom-field-cells";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { BulkBar, Checkbox, useRowSelection } from "@/components/ui/bulk-select";
import type { BrandOption } from "@/components/items/item-fields";
import { OptionCombobox } from "@/components/ui/option-combobox";

const TYPE_TONE: Record<ItemType, "default" | "blue" | "green" | "amber"> = {
  GOOD: "default",
  SERVICE: "blue",
  SUBSCRIPTION: "green",
  PERPETUAL: "amber",
};

export type ItemRow = {
  id: string;
  itemSeq: number;
  name: string;
  sku: string;
  type: ItemType;
  category: string | null;
  sellingPrice: number;
  trackInventory: boolean;
  stockQuantity: number;
  reorderLevel: number | null;
  active: boolean;
  brand: { id: string; name: string } | null;
  productFamily: { id: string; name: string } | null;
};

export function ItemsTable({
  items,
  brands,
  customColumns = { columns: [], texts: {} },
}: {
  items: ItemRow[];
  brands: BrandOption[];
  /** The workspace's own fields marked "a column in the list" (src/lib/custom-fields/server.ts `listColumns`). */
  customColumns?: { columns: CustomColumn[]; texts: Record<string, Record<string, string>> };
}) {
  const router = useRouter();
  const selection = useRowSelection(items);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [brandId, setBrandId] = useState("");
  const [productFamilyId, setProductFamilyId] = useState("");
  const [type, setType] = useState("");
  const [category, setCategory] = useState("");
  const [active, setActive] = useState("");

  const selectedBrand = brands.find((b) => b.id === brandId);

  function resetChanges() {
    setBrandId("");
    setProductFamilyId("");
    setType("");
    setCategory("");
    setActive("");
  }

  function apply() {
    setError(null);
    setDone(null);
    startTransition(async () => {
      const result = await bulkUpdateItems({
        itemIds: selection.ids,
        brandId,
        productFamilyId,
        type,
        category,
        active,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone(`Updated ${result.data.count} item(s).`);
      selection.clear();
      resetChanges();
      router.refresh();
    });
  }

  return (
    <div>
      <BulkBar count={selection.count} onClear={selection.clear} error={error} notice={done}>
        <div className="flex w-full flex-wrap items-center gap-2">
            {/* The bulk bar has no captions — the "no change" option is the only visible cue, and an
                option is not a name. Each control carries its own. */}
            {/* Searched, not scrolled — the catalogue can hold a thousand brands. "Remove brand" is
                offered first, as the one choice that isn't a brand. */}
            <div className="w-52">
              <OptionCombobox
                listLabel="Brands"
                options={[{ id: "clear", name: "Remove brand" }, ...brands.map((b) => ({ id: b.id, name: b.name }))]}
                value={brandId}
                onSelect={(b) => {
                  setBrandId(b?.id ?? "");
                  setProductFamilyId("");
                }}
                placeholder="Brand — no change"
              />
            </div>
            <Select
              value={productFamilyId}
              onChange={(e) => setProductFamilyId(e.target.value)}
              disabled={!selectedBrand}
              className="h-9 w-44"
              aria-label="Product family"
            >
              <option value="">{selectedBrand ? "Family — no change" : "Family — pick a brand"}</option>
              {selectedBrand?.families.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
            <Select value={type} onChange={(e) => setType(e.target.value)} className="h-9 w-44" aria-label="Type">
              <option value="">Type — no change</option>
              {itemTypeValues.map((t) => (
                <option key={t} value={t}>
                  {itemTypeLabels[t]}
                </option>
              ))}
            </Select>
            <Input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Category — no change"
              className="h-9 w-48"
              aria-label="Category"
            />
            <Select value={active} onChange={(e) => setActive(e.target.value)} className="h-9 w-44" aria-label="Status">
              <option value="">Status — no change</option>
              <option value="true">Mark active</option>
              <option value="false">Mark inactive</option>
            </Select>
          <Button size="sm" disabled={isPending} onClick={apply}>
            {isPending ? "Applying…" : `Apply to ${selection.count}`}
          </Button>
        </div>
        <p className="w-full text-xs text-muted">
          Only the fields you change are applied — everything left on &ldquo;no change&rdquo; is untouched.
        </p>
      </BulkBar>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="w-10 px-4 py-2.5">
                  <Checkbox
                    checked={selection.allSelected}
                    onChange={selection.toggleAll}
                    aria-label="Select all items on this page"
                  />
                </th>
                <th className="px-4 py-2.5">Item ID</th>
                <th className="px-4 py-2.5">Item</th>
                <th className="px-4 py-2.5">Type</th>
                <th className="px-4 py-2.5">SKU</th>
                <th className="px-4 py-2.5">Brand / family</th>
                <th className="px-4 py-2.5">Category</th>
                <th className="px-4 py-2.5">Selling price</th>
                <th className="px-4 py-2.5">Stock</th>
                <th className="px-4 py-2.5">Status</th>
                <CustomFieldHeaderCells columns={customColumns.columns} className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const lowStock =
                  item.trackInventory && item.reorderLevel !== null && item.stockQuantity <= item.reorderLevel;
                return (
                  <tr key={item.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                    <td className="px-4 py-2.5">
                      <Checkbox
                        checked={selection.isSelected(item.id)}
                        onChange={() => selection.toggle(item.id)}
                        aria-label={`Select ${item.name}`}
                      />
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted">{formatItemId(item.itemSeq)}</td>
                    <td className="px-4 py-2.5">
                      <Link href={`/items/${item.id}`} className="font-medium text-text hover:underline">
                        {item.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={TYPE_TONE[item.type]}>{itemTypeLabels[item.type]}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-muted">{item.sku}</td>
                    <td className="px-4 py-2.5 text-muted">
                      {item.brand ? (
                        <>
                          {item.brand.name}
                          {item.productFamily && <span className="text-subtle"> · {item.productFamily.name}</span>}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-muted">{item.category ?? "—"}</td>
                    <td className="px-4 py-2.5 text-muted">{formatCurrency(String(item.sellingPrice))}</td>
                    <td className="px-4 py-2.5 text-muted">
                      {item.trackInventory ? (
                        <span className={lowStock ? "font-medium text-warning" : undefined}>
                          {item.stockQuantity}
                          {lowStock && " (low)"}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {item.active ? <Badge tone="green">Active</Badge> : <Badge tone="red">Inactive</Badge>}
                    </td>
                    <CustomFieldBodyCells columns={customColumns.columns} texts={customColumns.texts[item.id]} className="px-4 py-2.5 text-muted" />
                  </tr>
                );
              })}
              {items.length === 0 && (
                <tr>
                  <td colSpan={10 + customColumns.columns.length} className="px-4 py-8 text-center text-subtle">
                    No items found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
