"use client";

import { useState, useEffect, useRef } from "react";
import type { z } from "zod";
import { useForm, type UseFormRegister, type FieldValues } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { updateItemSchema, type UpdateItemInput } from "@/lib/validation/item";
import { updateItem } from "@/actions/item";
import { Button } from "@/components/ui/button";
import { ItemDetailFields, type BrandOption } from "@/components/items/item-fields";
import type { Item } from "@prisma/client";

type FormValues = z.input<typeof updateItemSchema>;

/** Money columns reach the client as plain numbers — see the Decimal extension in src/lib/db.ts. */
type ItemWithPlainPrices = Omit<Item, "costPrice" | "sellingPrice" | "taxRatePercent"> & {
  costPrice: number | null;
  sellingPrice: number;
  taxRatePercent: number | null;
};

export function EditItemForm({ item, brands }: { item: ItemWithPlainPrices; brands: BrandOption[] }) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, UpdateItemInput>({
    resolver: zodResolver(updateItemSchema),
    defaultValues: {
      id: item.id,
      name: item.name,
      sku: item.sku,
      type: item.type,
      category: item.category ?? "",
      vendor: item.vendor ?? "",
      brandId: item.brandId ?? "",
      productFamilyId: item.productFamilyId ?? "",
      unit: item.unit ?? "",
      billingCycle: item.billingCycle ?? "",
      costPrice: item.costPrice ? Number(item.costPrice) : undefined,
      sellingPrice: Number(item.sellingPrice),
      taxRatePercent: item.taxRatePercent ? Number(item.taxRatePercent) : undefined,
      description: item.description ?? "",
      trackInventory: item.trackInventory,
      reorderLevel: item.reorderLevel ?? undefined,
      active: item.active,
    },
  });

  const itemType = watch("type");
  const brandId = watch("brandId");
  const trackInventory = watch("trackInventory");

  useEffect(() => {
    if (itemType !== "GOOD") setValue("trackInventory", false);
  }, [itemType, setValue]);

  // Clear the family when the brand changes — but not on first render, or editing an item would
  // wipe the family it already has.
  const initialBrandId = useRef(item.brandId ?? "");
  useEffect(() => {
    if (brandId === initialBrandId.current) return;
    initialBrandId.current = brandId ?? "";
    setValue("productFamilyId", "");
  }, [brandId, setValue]);

  async function onSubmit(values: UpdateItemInput) {
    setServerError(null);
    const result = await updateItem(values);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    router.push(`/items/${result.data.id}`);
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {serverError && <div className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{serverError}</div>}

      <ItemDetailFields
        register={register as unknown as UseFormRegister<FieldValues>}
        errors={errors}
        itemType={itemType}
        brands={brands}
        brandId={brandId}
        trackInventory={!!trackInventory}
      />

      <div className="flex justify-end gap-3">
        <Button type="button" variant="secondary" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
