"use client";

import { useId, useState } from "react";
import type { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { adjustStockSchema, type AdjustStockInput, stockMovementTypeValues } from "@/lib/validation/item";
import { adjustStock } from "@/actions/item";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";

type FormValues = z.input<typeof adjustStockSchema>;

export function AdjustStockForm({ itemId }: { itemId: string }) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  // `useId` rather than plain field names: nothing stops this form appearing twice on one screen.
  const id = useId();
  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, AdjustStockInput>({
    resolver: zodResolver(adjustStockSchema),
    defaultValues: { itemId, type: "RECEIVED", direction: "IN" },
  });

  const type = watch("type");

  async function onSubmit(values: AdjustStockInput) {
    setServerError(null);
    const result = await adjustStock(values);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    reset({ itemId, type: "RECEIVED", direction: "IN", quantity: undefined, reason: "" });
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
      {serverError && <p className="text-xs text-danger">{serverError}</p>}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor={`${id}-type`}>Movement type</Label>
          <Select id={`${id}-type`} {...register("type")}>
            {stockMovementTypeValues.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </div>
        {type === "ADJUSTMENT" && (
          <div className="space-y-1">
            <Label htmlFor={`${id}-direction`}>Direction</Label>
            <Select id={`${id}-direction`} {...register("direction")}>
              <option value="IN">Increase stock</option>
              <option value="OUT">Decrease stock</option>
            </Select>
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor={`${id}-quantity`}>Quantity</Label>
          <Input id={`${id}-quantity`} type="number" min={1} {...register("quantity")} />
          {errors.quantity && <p className="text-xs text-danger">{errors.quantity.message}</p>}
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-reason`}>Reason / note</Label>
        <Input
          id={`${id}-reason`}
          placeholder="e.g. Purchase order #123, damaged in transit"
          {...register("reason")}
        />
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={isSubmitting}>
          {isSubmitting ? "Recording…" : "Record movement"}
        </Button>
      </div>
    </form>
  );
}
