"use client";

import { useId, useState } from "react";
import type { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { adjustStockSchema, type AdjustStockInput, stockMovementTypeValues } from "@/lib/validation/item";
import { adjustStock } from "@/actions/item";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";

type FormValues = z.input<typeof adjustStockSchema>;

/** A fresh token per movement: the server records one movement per token, so a double submit can't record two. */
const token = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

export function AdjustStockForm({
  itemId,
  warehouses = [],
  tracked = false,
}: {
  itemId: string;
  /** The open warehouses — a picker is shown when there is more than one; the default takes it otherwise. */
  warehouses?: { id: string; name: string; isDefault: boolean }[];
  /** The item keeps batches or serial numbers, which this quick form can't record — a stock voucher can. */
  tracked?: boolean;
}) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(token);
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
    defaultValues: { itemId, type: "RECEIVED", direction: "IN", warehouseId: warehouses.find((w) => w.isDefault)?.id ?? warehouses[0]?.id ?? "" },
  });

  const type = watch("type");

  async function onSubmit(values: AdjustStockInput) {
    setServerError(null);
    const result = await adjustStock({ ...values, requestId });
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    // The next movement is a new one.
    setRequestId(token());
    reset({ itemId, type: "RECEIVED", direction: "IN", quantity: undefined, reason: "", warehouseId: values.warehouseId });
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
      {serverError && <p className="text-xs text-danger">{serverError}</p>}
      {tracked && (
        <p className="text-xs text-muted">
          This item keeps batches or serial numbers — record its stock with a{" "}
          <Link href="/items/stock/new" className="text-brand hover:underline">
            stock voucher
          </Link>, which takes them.
        </p>
      )}
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
          <Input id={`${id}-quantity`} type="number" min={0} step="0.001" {...register("quantity")} />
          {errors.quantity && <p className="text-xs text-danger">{errors.quantity.message}</p>}
        </div>
        {warehouses.length > 1 && (
          <div className="space-y-1">
            <Label htmlFor={`${id}-warehouse`}>Warehouse</Label>
            <Select id={`${id}-warehouse`} {...register("warehouseId")}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </div>
        )}
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
