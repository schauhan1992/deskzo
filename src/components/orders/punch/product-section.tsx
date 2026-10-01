"use client";

import { Controller, useWatch } from "react-hook-form";
import { searchItemOptions } from "@/actions/item";
import { orderBusinessTypeLabels, orderBusinessTypeValues } from "@/lib/validation/order";
import { formatCurrency } from "@/lib/utils";
import { Badge } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { ItemCombobox, type ItemComboOption } from "@/components/items/item-combobox";
import { FieldError, Section } from "./parts";
import { usePriceFigures } from "./use-figures";
import { invalidProps, type PunchErrors, type PunchForm } from "./types";

/**
 * What is sold and for how much: the product, the quantity, the price against list, whether it is
 * new business or a renewal, and a subscription's dates.
 *
 * New or renewal is worked out from the customer's orders once both are chosen, and shown as
 * detected; the moment somebody picks it themselves the detection stops touching it.
 */
export function ProductSection({
  form,
  errors,
  items,
  itemSearch,
  selectedItem,
  resellerPrice,
  detectedType,
  onItemChange,
  onTypeChosen,
}: {
  form: PunchForm;
  errors: PunchErrors;
  items: ItemComboOption[];
  itemSearch: boolean;
  selectedItem: ItemComboOption | null;
  /** A reseller's own price for this product and where it came from, when the customer is one. */
  resellerPrice: { unitPrice: number; note: string } | null;
  /** What the order history suggests, until the person chooses for themselves. */
  detectedType: "NEW" | "RENEWAL" | null;
  onItemChange: (item: ItemComboOption | null) => void;
  onTypeChosen: () => void;
}) {
  const { control, register } = form;
  const figures = usePriceFigures(control, selectedItem);
  const businessType = useWatch({ control, name: "businessType" });
  const isSubscription = selectedItem?.type === "SUBSCRIPTION";
  const showDetected = detectedType !== null && businessType === detectedType;
  // The schema's own words for these are about number types; these say what to type instead.
  const quantityError = errors.quantity ? "Enter a whole number, 1 or more." : undefined;
  const priceError = errors.unitPrice ? "Enter a price above zero, or leave it blank for the list price." : undefined;

  return (
    <Section title="Product and price">
      <div className="space-y-1.5 sm:col-span-2" data-search={itemSearch ? "server" : "list"}>
        <Label htmlFor="itemId">Product *</Label>
        <Controller
          name="itemId"
          control={control}
          render={({ field }) => (
            <ItemCombobox
              id="itemId"
              inputRef={field.ref}
              items={items}
              value={field.value ?? ""}
              // A catalogue too long to send whole is searched on the server; the page says when it is.
              search={itemSearch ? searchItemOptions : undefined}
              autoHighlightFirst
              {...invalidProps("itemId", errors.itemId?.message)}
              showPrice
              onSelect={(item) => {
                field.onChange(item?.id ?? "");
                onItemChange(item);
              }}
            />
          )}
        />
        <FieldError id="itemId" message={errors.itemId?.message} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="quantity">Quantity</Label>
        <Input
          id="quantity"
          type="number"
          min={1}
          className="aria-[invalid=true]:border-danger"
          {...register("quantity")}
          {...invalidProps("quantity", quantityError)}
        />
        <FieldError id="quantity" message={quantityError} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="unitPrice">Sales price / unit</Label>
        <Input
          id="unitPrice"
          type="number"
          step="0.01"
          placeholder={figures.listPrice !== null ? String(figures.listPrice) : "List price"}
          className="aria-[invalid=true]:border-danger"
          {...register("unitPrice")}
          {...invalidProps("unitPrice", priceError)}
        />
        <FieldError id="unitPrice" message={priceError} />
        {resellerPrice ? (
          <p className="text-xs text-info">
            {resellerPrice.note}: {formatCurrency(resellerPrice.unitPrice)}
          </p>
        ) : figures.listPrice !== null ? (
          <p className="text-xs text-subtle">
            List {formatCurrency(figures.listPrice)}
            {figures.belowListPercent !== null &&
              (figures.belowListPercent > 0
                ? ` · ${figures.belowListPercent}% below`
                : ` · ${Math.abs(figures.belowListPercent)}% above`)}
          </p>
        ) : (
          <p className="text-xs text-subtle">Blank uses the list price.</p>
        )}
        {figures.belowCost && figures.unitCost !== null && (
          <p className="text-xs text-danger">Below cost — {formatCurrency(figures.unitCost)} a unit.</p>
        )}
      </div>

      {isSubscription && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="startDate">Start date</Label>
            <Input id="startDate" type="date" {...register("startDate")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="endDate">Expiry date</Label>
            <Input id="endDate" type="date" {...register("endDate")} />
          </div>
        </>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Label htmlFor="businessType">New or renewal?</Label>
          {showDetected && <Badge>Detected</Badge>}
        </div>
        <Select id="businessType" {...register("businessType", { onChange: onTypeChosen })}>
          {orderBusinessTypeValues.map((t) => (
            <option key={t} value={t}>
              {orderBusinessTypeLabels[t]}
            </option>
          ))}
        </Select>
        {showDetected && (
          <p className="text-xs text-subtle">From their orders — change it if they had this elsewhere before.</p>
        )}
      </div>
    </Section>
  );
}
