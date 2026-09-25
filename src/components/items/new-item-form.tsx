"use client";

import { useState, useEffect } from "react";
import type { z } from "zod";
import { useForm, type UseFormRegister, type FieldValues } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { createItemSchema, type CreateItemInput } from "@/lib/validation/item";
import { createItem } from "@/actions/item";
import { Button } from "@/components/ui/button";
import { ItemDetailFields, type BrandOption } from "@/components/items/item-fields";

type FormValues = z.input<typeof createItemSchema>;

export function NewItemForm({ brands }: { brands: BrandOption[] }) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, CreateItemInput>({
    resolver: zodResolver(createItemSchema),
    defaultValues: { type: "GOOD", trackInventory: true, active: true },
  });

  const itemType = watch("type");
  const brandId = watch("brandId");
  const trackInventory = watch("trackInventory");

  useEffect(() => {
    if (itemType !== "GOOD") setValue("trackInventory", false);
  }, [itemType, setValue]);

  // A family belongs to one brand, so switching brand invalidates whatever family was picked.
  useEffect(() => {
    setValue("productFamilyId", "");
  }, [brandId, setValue]);

  async function onSubmit(values: CreateItemInput) {
    setServerError(null);
    const result = await createItem(values);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    router.push(`/items/${result.data.id}`);
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-6">
      {serverError && <div className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{serverError}</div>}

      <ItemDetailFields
        register={register as unknown as UseFormRegister<FieldValues>}
        errors={errors}
        itemType={itemType}
        brands={brands}
        brandId={brandId}
        onBrandChange={(id) => setValue("brandId", id, { shouldDirty: true })}
        trackInventory={!!trackInventory}
        showOpeningStock
      />

      <div className="flex justify-end gap-3">
        <Button type="button" variant="secondary" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Save item"}
        </Button>
      </div>
    </form>
  );
}
