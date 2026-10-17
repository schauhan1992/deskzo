import type { FieldErrors, FieldValues, UseFormRegister } from "react-hook-form";
import { revenuePatternLabels, revenuePatternValues, type itemTypeValues } from "@/lib/validation/item";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import Link from "next/link";
import { OptionCombobox } from "@/components/ui/option-combobox";
import { HsnCombobox } from "@/components/items/hsn-combobox";
import { useWording } from "@/components/terms/wording-provider";
import { slot } from "@/lib/terms/dictionary";

export type BrandOption = { id: string; name: string; families: { id: string; name: string }[] };

export function ItemDetailFields({
  register,
  errors,
  itemType,
  brands = [],
  brandId,
  onBrandChange,
  trackInventory,
  showOpeningStock,
  showRevenuePattern = false,
  hsnCode,
  onHsnChange,
  hsnRequired = false,
  onTypeChange,
  categories = [],
  category = "",
  onCategoryChange,
  subscriptions = false,
}: {
  register: UseFormRegister<FieldValues>;
  errors: FieldErrors<FieldValues>;
  itemType: string;
  brands?: BrandOption[];
  brandId?: string;
  /** The brand picker searches rather than scrolls, so it sets the value itself rather than through `register`. */
  onBrandChange: (brandId: string) => void;
  trackInventory: boolean;
  showOpeningStock?: boolean;
  /**
   * Whether to ask how revenue is recognised: only where Revenue & Close is available, which the page
   * decides (`isModuleEnabled("revenue_close")`). The actions ignore the field otherwise.
   */
  showRevenuePattern?: boolean;
  /** The HSN/SAC field searches the GST directory, so it sets the value itself rather than through `register`. */
  hsnCode: string;
  onHsnChange: (code: string) => void;
  /** An Indian workspace, where the code is the tax's classification and an item must carry one. */
  hsnRequired?: boolean;
  /**
   * The type is asked as two questions — goods or service, then for a service how it's sold — and set
   * here as the one value it is stored as (GOOD, SERVICE, SUBSCRIPTION, PERPETUAL).
   */
  onTypeChange: (type: (typeof itemTypeValues)[number]) => void;
  /** The workspace's item categories (Items › Categories); the field picks one by name. */
  categories?: { id: string; name: string }[];
  category?: string;
  onCategoryChange: (name: string) => void;
  /** Renewals is in the plan and switched on, so a service may be managed as a subscription. */
  subscriptions?: boolean;
}) {
  const selectedBrand = brands.find((b) => b.id === brandId);
  // The workspace's own word for an item (Settings → Wording). Only ever rendered inside the item
  // forms, which are client components.
  const wording = useWording();
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="text-sm font-medium text-text">{slot(wording, "Item details", "item", "{one} details")}</CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="name">{slot(wording, "Item name *", "item", "{one} name *")}</Label>
            <Input id="name" {...register("name")} />
            {errors.name && <p className="text-xs text-danger">{String(errors.name.message)}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sku">SKU *</Label>
            <Input id="sku" placeholder="e.g. MS365-BSTD" {...register("sku")} />
            {errors.sku && <p className="text-xs text-danger">{String(errors.sku.message)}</p>}
          </div>
          {/* Goods or a service decides the GST side — HSN or SAC, and whether stock is tracked. What
              kind of goods or service it is, the category says; whether it renews, the box below. */}
          <div className="space-y-1.5">
            <Label htmlFor="type">Goods or service *</Label>
            <Select id="type" value={itemType === "GOOD" ? "GOOD" : "SERVICE"} onChange={(e) => onTypeChange(e.target.value === "GOOD" ? "GOOD" : "SERVICE")}>
              <option value="GOOD">Goods</option>
              <option value="SERVICE">Service</option>
            </Select>
          </div>
          {/* Only where Renewals is (Deskzo Subscriptions, or One) — or on an item that already renews,
              which a workspace that has since lost Renewals keeps until somebody unticks it. */}
          {itemType !== "GOOD" && (subscriptions || itemType === "SUBSCRIPTION") ? (
            <div className="flex flex-col justify-end space-y-1.5">
              <label className="flex items-center gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  checked={itemType === "SUBSCRIPTION"}
                  onChange={(e) => onTypeChange(e.target.checked ? "SUBSCRIPTION" : "SERVICE")}
                  aria-describedby="subscription-help"
                />
                Manage as a subscription
              </label>
              <p id="subscription-help" className="text-xs text-muted">
                {itemType === "SUBSCRIPTION" && !subscriptions
                  ? "Renewals isn't in your plan, so nothing will renew it — untick to make it a one-time service."
                  : "It renews: it comes up in Renewals before its term ends. Each order sets its own term."}
              </p>
            </div>
          ) : (
            <div aria-hidden="true" />
          )}
          <div className="space-y-1.5">
            <Label htmlFor="brandId">Brand</Label>
            {/* Searched rather than scrolled: a reseller's catalogue runs to a thousand brands. */}
            <OptionCombobox
              id="brandId"
              listLabel="Brands"
              options={brands.map((b) => ({ id: b.id, name: b.name, hint: b.families.length ? `${b.families.length} famil${b.families.length === 1 ? "y" : "ies"}` : undefined }))}
              value={brandId ?? ""}
              onSelect={(b) => onBrandChange(b?.id ?? "")}
              placeholder="Search brands…"
              emptyText="No brand by that name."
            />
            {brands.length === 0 && (
              <p className="text-xs text-subtle">
                No brands yet — add them under{" "}
                <Link href="/items/brands" className="underline underline-offset-2">
                  Brands &amp; families
                </Link>
                .
              </p>
            )}
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
              <p className="text-xs text-subtle">
                {selectedBrand.name} has no families yet — add them under{" "}
                <Link href={`/items/brands?q=${encodeURIComponent(selectedBrand.name)}`} className="underline underline-offset-2">
                  Brands &amp; families
                </Link>
                .
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="category">Category</Label>
            {/* Picked from the workspace's own list, so one kind of thing isn't filed three ways. */}
            <OptionCombobox
              id="category"
              listLabel="Categories"
              // The item's own, if the list doesn't have it (a workspace from before the list), so it still shows.
              options={[...categories, ...(category && !categories.some((c) => c.name === category) ? [{ id: category, name: category }] : [])].map((c) => ({ id: c.name, name: c.name }))}
              value={category}
              onSelect={(c) => onCategoryChange(c?.id ?? "")}
              placeholder="Search categories…"
              emptyText="No category by that name."
            />
            <p className="text-xs text-subtle">
              {categories.length === 0 ? "No categories yet — add them under " : "Missing one? Add it under "}
              <Link href="/items/categories" className="underline underline-offset-2">
                Categories
              </Link>
              .
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hsnCode">HSN / SAC code{hsnRequired ? " *" : ""}</Label>
            <HsnCombobox
              id="hsnCode"
              value={hsnCode}
              onChange={onHsnChange}
              itemType={itemType}
              aria-invalid={!!errors.hsnCode}
              aria-describedby="hsnCode-help"
            />
            {errors.hsnCode ? (
              <p id="hsnCode-help" className="text-xs text-danger">{String(errors.hsnCode.message)}</p>
            ) : (
              // What every invoice line for this item will carry, and what the GST return groups by.
              <p id="hsnCode-help" className="text-xs text-subtle">
                {itemType === "GOOD"
                  ? "HSN, from the GST portal's directory. Copied onto every document line."
                  : "SAC — services start with 99. Copied onto every document line."}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vendor">Supplier note</Label>
            <Input id="vendor" placeholder="e.g. sourced via Ingram" {...register("vendor")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="unit">Unit</Label>
            <Input id="unit" placeholder="e.g. Seat, Piece, License" {...register("unit")} />
          </div>
          {showRevenuePattern && (
            <div className="space-y-1.5">
              <Label htmlFor="revenuePattern">Revenue is recognised</Label>
              <Select id="revenuePattern" {...register("revenuePattern")}>
                <option value="">{slot(wording, "Automatic (from the item type)", "item", "Automatic (from the {one:lower} type)")}</option>
                {revenuePatternValues.map((p) => (
                  <option key={p} value={p}>
                    {revenuePatternLabels[p]}
                  </option>
                ))}
              </Select>
              {/* What "automatic" means for this type, so the choice isn't made blind. */}
              <p className="text-xs text-subtle">
                {itemType === "SUBSCRIPTION"
                  ? "Automatic: over the service period, as a subscription is earned."
                  : "Automatic: when invoiced — or over the service period when an invoice line's period runs past the month it was issued in."}
              </p>
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
              {slot(wording, "Track inventory for this item", "item", "Track inventory for this {one:lower}")}
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
