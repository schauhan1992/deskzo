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
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  CustomFieldInputs,
  missingRequired,
  type CustomFieldFormValues,
  type CustomFieldPerson,
} from "@/components/custom-fields/custom-field-inputs";
import type { CustomFieldDef } from "@/lib/custom-fields/rules";
import { itemPath } from "@/lib/record-links";

type FormValues = z.input<typeof createItemSchema>;

export function NewItemForm({
  brands,
  showRevenuePattern = false,
  customFields = { fields: [], values: {}, people: [] },
}: {
  brands: BrandOption[];
  showRevenuePattern?: boolean;
  /** The workspace's own product fields (src/lib/custom-fields/server.ts `formSetup`). */
  customFields?: { fields: CustomFieldDef[]; values: CustomFieldFormValues; people: CustomFieldPerson[] };
}) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [custom, setCustom] = useState<CustomFieldFormValues>(customFields.values);
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});
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
    const missing = missingRequired(customFields.fields, custom);
    setCustomErrors(missing);
    if (Object.keys(missing).length > 0) return;
    const result = await createItem({ ...values, customFields: custom });
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    router.push(itemPath(result.data.itemSeq));
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
        showRevenuePattern={showRevenuePattern}
      />

      {customFields.fields.length > 0 && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">More details</CardHeader>
          <CardContent>
            <CustomFieldInputs
              fields={customFields.fields}
              values={custom}
              people={customFields.people}
              errors={customErrors}
              onChange={(key, value) => setCustom((c) => ({ ...c, [key]: value }))}
            />
          </CardContent>
        </Card>
      )}

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
