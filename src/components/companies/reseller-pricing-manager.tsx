"use client";

import { useId, useState } from "react";
import type { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { resellerItemPriceSchema, type ResellerItemPriceInput } from "@/lib/validation/reseller";
import { upsertResellerItemPrice, deleteResellerItemPrice } from "@/actions/reseller";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";

type PricedItem = {
  id: string;
  price: unknown;
  notes: string | null;
  item: { id: string; name: string; sku: string; unit: string | null; sellingPrice: unknown };
};

type ItemOption = { id: string; name: string; sku: string; sellingPrice: unknown };

export function ResellerPricingManager({
  resellerId,
  prices,
  items,
  discountPercent,
}: {
  resellerId: string;
  prices: PricedItem[];
  items: ItemOption[];
  discountPercent: number | null;
}) {
  const router = useRouter();
  const fieldId = useId();
  const [adding, setAdding] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  type FormValues = z.input<typeof resellerItemPriceSchema>;
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, ResellerItemPriceInput>({
    resolver: zodResolver(resellerItemPriceSchema),
    defaultValues: { itemId: "", notes: "" },
  });

  async function onSubmit(values: ResellerItemPriceInput) {
    setServerError(null);
    const result = await upsertResellerItemPrice(resellerId, values);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    reset({ itemId: "", price: undefined, notes: "" });
    setAdding(false);
    router.refresh();
  }

  function remove(id: string) {
    setPendingId(id);
    deleteResellerItemPrice(id).then(() => {
      setPendingId(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        A price agreed with this reseller for a specific product. It beats their tier discount
        {discountPercent ? ` (${discountPercent}% off catalog)` : ""}, which in turn beats the catalog price. The
        punch form fills the sale price in automatically.
      </p>

      {prices.length === 0 && !adding && (
        <p className="text-sm text-subtle">No special pricing yet — their tier discount applies.</p>
      )}

      {prices.map((p) => {
        const catalog = Number(p.item.sellingPrice);
        const agreed = Number(p.price);
        const off = catalog > 0 ? Math.round(((catalog - agreed) / catalog) * 1000) / 10 : 0;
        return (
          <div key={p.id} className="flex items-start justify-between border-t border-line pt-2 text-sm">
            <div>
              <div className="font-medium text-text">{p.item.name}</div>
              <div className="text-muted">
                {p.item.sku} · {formatCurrency(String(agreed))}
                {p.item.unit ? ` / ${p.item.unit}` : ""} · catalog {formatCurrency(String(catalog))}
                {off !== 0 && ` (${off}% off)`}
              </div>
              {p.notes && <div className="text-xs text-muted">{p.notes}</div>}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-danger hover:bg-danger-bg hover:text-danger"
              disabled={pendingId === p.id}
              onClick={() => remove(p.id)}
            >
              {pendingId === p.id ? "Removing…" : "Remove"}
            </Button>
          </div>
        );
      })}

      {!adding ? (
        <Button type="button" variant="secondary" size="sm" onClick={() => setAdding(true)}>
          + Add special price
        </Button>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-2 rounded-md border border-line p-3">
          {serverError && <p className="text-xs text-danger">{serverError}</p>}
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2 space-y-1">
              <Label htmlFor={`${fieldId}-item`} className="text-xs">
                Product
              </Label>
              <Select id={`${fieldId}-item`} {...register("itemId")}>
                <option value="">Select a product…</option>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} ({i.sku}) — catalog {formatCurrency(String(i.sellingPrice))}
                  </option>
                ))}
              </Select>
              {errors.itemId && <p className="text-xs text-danger">{String(errors.itemId.message)}</p>}
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${fieldId}-price`} className="text-xs">
                Their price (₹ per unit)
              </Label>
              <Input id={`${fieldId}-price`} type="number" step="0.01" {...register("price")} />
              {errors.price && <p className="text-xs text-danger">{String(errors.price.message)}</p>}
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${fieldId}-notes`} className="text-xs">
                Notes
              </Label>
              <Input id={`${fieldId}-notes`} placeholder="e.g. valid till Mar 2027" {...register("notes")} />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : "Save price"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
