"use client";

import { Controller, useWatch } from "react-hook-form";
import { dealRegStatusValues } from "@/lib/validation/order";
import { DEAL_REG_LABELS } from "@/lib/rebates/rules";
import { istTodayKey } from "@/lib/orders/handoff-rules";
import { formatCurrency } from "@/lib/utils";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { CompanyCombobox } from "@/components/ui/company-combobox";
import type { ItemComboOption } from "@/components/items/item-combobox";
import { FieldError, Fold } from "./parts";
import { usePriceFigures } from "./use-figures";
import { invalidProps, type PunchErrors, type PunchForm, type VendorOption } from "./types";

/** "Margin at this price: ₹1,200 (12%) before expenses" — green above cost, red under it. */
function MarginNote({ label, margin }: { label: string; margin: { margin: number; percent: number | null } | null }) {
  if (!margin) return null;
  return (
    <p className={`text-xs ${margin.margin >= 0 ? "text-success" : "text-danger"}`}>
      {label}: {formatCurrency(margin.margin)}
      {margin.percent !== null ? ` (${margin.percent}%)` : ""} before expenses
    </p>
  );
}

/**
 * What the order costs us, as far as the salesperson knows it: a price they already have from a
 * distributor, and the OEM's deal registration with the lower price the distributor bills at under
 * it. Both optional, both editable on the order later; folded until used. The margin they imply is in
 * the order summary.
 */
export function CostFold({
  form,
  errors,
  vendors,
  selectedItem,
  open,
  hasError,
  onOpenChange,
}: {
  form: PunchForm;
  errors: PunchErrors;
  vendors: VendorOption[];
  selectedItem: ItemComboOption | null;
  /** Open or shut as the person left it; undefined until they touch it. */
  open: boolean | undefined;
  hasError: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { control, register, setValue } = form;
  const figures = usePriceFigures(control, selectedItem);
  const details = useWatch({
    control,
    name: [
      "quoteVendorId",
      "quoteVendorName",
      "quoteContact",
      "quotedOn",
      "quoteRemarks",
      "dealRegStatus",
      "dealRegNumber",
      "dealRegValidTo",
    ],
  });
  const [quoteVendorId, quoteVendorName, , , , dealRegStatus] = details;
  const hasValue = figures.quotePrice !== null || figures.dealPrice !== null || details.some((v) => !!v);
  const today = istTodayKey(new Date());

  const vendorName = quoteVendorId ? vendors.find((v) => v.id === quoteVendorId)?.name : quoteVendorName?.trim();
  const summary = [
    figures.dealPrice !== null ? `Deal price ${formatCurrency(figures.dealPrice)}` : null,
    dealRegStatus ? `DR ${DEAL_REG_LABELS[dealRegStatus].toLowerCase()}` : null,
    figures.quotePrice !== null ? `${formatCurrency(figures.quotePrice)} from ${vendorName || "a distributor"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Fold title="Cost and margin" summary={summary} open={open ?? (hasValue || hasError)} onOpenChange={onOpenChange}>
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-text">Distributor price</legend>
        <p className="text-xs text-muted">
          A price you already have from a distributor. Purchase may buy for less; paying more needs your agreement.
        </p>
        {/* By the fold's width, not the screen's — see `Fold`. */}
        <div className="grid grid-cols-1 gap-4 @sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="quotedPurchasePrice">Price per unit</Label>
            <Input
              id="quotedPurchasePrice"
              type="number"
              step="0.01"
              min={0}
              className="aria-[invalid=true]:border-danger"
              {...register("quotedPurchasePrice")}
              {...invalidProps("quotedPurchasePrice", errors.quotedPurchasePrice?.message)}
            />
            <FieldError id="quotedPurchasePrice" message={errors.quotedPurchasePrice?.message} />
            <MarginNote label="Margin at this price" margin={figures.quoteMargin} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="quotedOn">Date quoted</Label>
            <Input id="quotedOn" type="date" max={today} {...register("quotedOn")} />
            <p className="text-xs text-subtle">Blank is today.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="quoteVendorId">Distributor</Label>
            <Controller
              name="quoteVendorId"
              control={control}
              render={({ field }) => (
                <CompanyCombobox
                  id="quoteVendorId"
                  inputRef={field.ref}
                  companies={vendors}
                  value={field.value ?? ""}
                  // Enter on a typed name takes the top match rather than punching the order without it.
                  autoHighlightFirst="typed"
                  // Picked here or typed below, the distributor is one answer, and its error is both fields'.
                  {...invalidProps("quoteVendorName", errors.quoteVendorName?.message)}
                  onSelect={(vendor) => {
                    field.onChange(vendor?.id ?? "");
                    if (vendor) setValue("quoteVendorName", "");
                  }}
                  placeholder="Search vendors…"
                />
              )}
            />
            {!quoteVendorId && (
              <Input
                aria-label="Distributor's name, if not in the CRM"
                placeholder="…or type their name"
                maxLength={200}
                className="aria-[invalid=true]:border-danger"
                {...register("quoteVendorName")}
                {...invalidProps("quoteVendorName", errors.quoteVendorName?.message)}
              />
            )}
            <FieldError id="quoteVendorName" message={errors.quoteVendorName?.message} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="quoteContact">Contact at the distributor</Label>
            <Input
              id="quoteContact"
              placeholder="Who gave you the price"
              maxLength={200}
              {...register("quoteContact")}
              {...invalidProps("quoteContact", errors.quoteContact?.message)}
            />
            <FieldError id="quoteContact" message={errors.quoteContact?.message} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="quoteRemarks">Remarks</Label>
            <Textarea
              id="quoteRemarks"
              placeholder="Validity, stock, terms…"
              maxLength={1000}
              {...register("quoteRemarks")}
              {...invalidProps("quoteRemarks", errors.quoteRemarks?.message)}
            />
            <FieldError id="quoteRemarks" message={errors.quoteRemarks?.message} />
          </div>
        </div>
      </fieldset>

      {/* A wrapper carries the rule: on the fieldset itself the border would run through its legend. */}
      <div className="border-t border-line pt-4">
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-text">Deal registration</legend>
          <p className="text-xs text-muted">
            The OEM&apos;s registration behind this order, and the lower price the distributor bills at under it. Nothing
            waits on it.
          </p>
          <div className="grid grid-cols-1 gap-4 @sm:grid-cols-2 @lg:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="dealRegStatus">Deal registration</Label>
              <Select
                id="dealRegStatus"
                className="aria-[invalid=true]:border-danger"
                {...register("dealRegStatus")}
                {...invalidProps("dealRegStatus", errors.dealRegStatus?.message)}
              >
                <option value="">None</option>
                {dealRegStatusValues.map((v) => (
                  <option key={v} value={v}>
                    {DEAL_REG_LABELS[v]}
                  </option>
                ))}
              </Select>
              <FieldError id="dealRegStatus" message={errors.dealRegStatus?.message} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dealRegNumber">DR number</Label>
              <Input
                id="dealRegNumber"
                placeholder="The OEM's reference"
                maxLength={100}
                {...register("dealRegNumber")}
                {...invalidProps("dealRegNumber", errors.dealRegNumber?.message)}
              />
              <FieldError id="dealRegNumber" message={errors.dealRegNumber?.message} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dealRegValidTo">Valid until</Label>
              <Input
                id="dealRegValidTo"
                type="date"
                className="aria-[invalid=true]:border-danger"
                {...register("dealRegValidTo")}
                {...invalidProps("dealRegValidTo", errors.dealRegValidTo?.message)}
              />
              <FieldError id="dealRegValidTo" message={errors.dealRegValidTo?.message} />
            </div>
          </div>
          <div className="space-y-1.5 sm:max-w-xs">
            <Label htmlFor="dealPrice">Deal price per unit</Label>
            <Input
              id="dealPrice"
              type="number"
              step="0.01"
              min={0}
              placeholder="What the distributor bills at"
              className="aria-[invalid=true]:border-danger"
              {...register("dealPrice")}
              {...invalidProps("dealPrice", errors.dealPrice?.message)}
            />
            <FieldError id="dealPrice" message={errors.dealPrice?.message} />
            <MarginNote label="Margin at the deal price" margin={figures.dealMargin} />
          </div>
        </fieldset>
      </div>
    </Fold>
  );
}
