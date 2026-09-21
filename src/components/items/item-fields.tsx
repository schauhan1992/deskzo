import type { FieldErrors, FieldValues, UseFormRegister } from "react-hook-form";
import { itemTypeValues, itemTypeLabels, billingCycleValues } from "@/lib/validation/item";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export type BrandOption = { id: string; name: string; families: { id: string; name: string }[] };

export function ItemDetailFields({
  register,
  errors,
  itemType,
  brands = [],
  brandId,
  trackInventory,
  showOpeningStock,
}: {
  register: UseFormRegister<FieldValues>;
  errors: FieldErrors<FieldValues>;
  itemType: string;
  brands?: BrandOption[];
  brandId?: string;
  trackInventory: boolean;
  showOpeningStock?: boolean;
}) {
  const selectedBrand = brands.find((b) => b.id === brandId);
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="text-sm font-medium text-text">Item details</CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="name">Item name *</Label>
            <Input id="name" {...register("name")} />
            {errors.name && <p className="text-xs text-danger">{String(errors.name.message)}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sku">SKU *</Label>
            <Input id="sku" placeholder="e.g. MS365-BSTD" {...register("sku")} />
            {errors.sku && <p className="text-xs text-danger">{String(errors.sku.message)}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="type">Type *</Label>
            <Select id="type" {...register("type")}>
              {itemTypeValues.map((t) => (
                <option key={t} value={t}>
                  {itemTypeLabels[t]}
                </option>
              ))}
            </Select>
            {itemType === "PERPETUAL" && (
              <p className="text-xs text-muted">Owned outright — never expires, so it stays out of Renewals.</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="brandId">Brand</Label>
            <Select id="brandId" {...register("brandId")}>
              <option value="">Not set</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
            {brands.length === 0 && <p className="text-xs text-subtle">Add brands from Settings.</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="productFamilyId">Product family</Label>
            <Select id="productFamilyId" {...register("productFamilyId")} disabled={!selectedBrand}>
              <option value="">Not set</option>
              {selectedBrand?.families.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
            {!selectedBrand && <p className="text-xs text-subtle">Pick a brand first.</p>}
            {selectedBrand && selectedBrand.families.length === 0 && (
              <p className="text-xs text-subtle">{selectedBrand.name} has no families yet — add them in Settings.</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="category">Category</Label>
            <Input id="category" placeholder="e.g. Laptop, Productivity Suite" {...register("category")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vendor">Supplier note</Label>
            <Input id="vendor" placeholder="e.g. sourced via Ingram" {...register("vendor")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="unit">Unit</Label>
            <Input id="unit" placeholder="e.g. Seat, Piece, License" {...register("unit")} />
          </div>
          {itemType === "SUBSCRIPTION" && (
            <div className="space-y-1.5">
              <Label htmlFor="billingCycle">Billing cycle</Label>
              <Select id="billingCycle" {...register("billingCycle")}>
                <option value="">Not set</option>
                {billingCycleValues.map((b) => (
                  <option key={b} value={b}>
                    {b.replaceAll("_", " ")}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="costPrice">Cost price (₹)</Label>
            <Input id="costPrice" type="number" min={0} step="0.01" {...register("costPrice")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sellingPrice">Selling price (₹) *</Label>
            <Input id="sellingPrice" type="number" min={0} step="0.01" {...register("sellingPrice")} />
            {errors.sellingPrice && (
              <p className="text-xs text-danger">{String(errors.sellingPrice.message)}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="taxRatePercent">GST rate (%)</Label>
            <Input id="taxRatePercent" type="number" min={0} max={100} step="0.01" {...register("taxRatePercent")} />
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" {...register("description")} />
          </div>
        </CardContent>
      </Card>

      {itemType === "GOOD" && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Inventory</CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <label className="col-span-2 flex items-center gap-2 text-sm text-text">
              <input type="checkbox" {...register("trackInventory")} />
              Track inventory for this item
            </label>
            {trackInventory && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="reorderLevel">Reorder level</Label>
                  <Input id="reorderLevel" type="number" min={0} {...register("reorderLevel")} />
                </div>
                {showOpeningStock && (
                  <div className="space-y-1.5">
                    <Label htmlFor="openingStock">Opening stock</Label>
                    <Input id="openingStock" type="number" min={0} {...register("openingStock")} />
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-5">
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="checkbox" {...register("active")} />
            Active (sellable / orderable)
          </label>
        </CardContent>
      </Card>
    </div>
  );
}
