"use client";

import { useEffect, useState } from "react";
import { Controller, useFieldArray, useWatch } from "react-hook-form";
import { suggestOrderRebates } from "@/actions/rebate";
import { rebateBasisValues, rebatePayerValues, rebateSettlementValues } from "@/lib/validation/order";
import {
  REBATE_BASIS_LABELS,
  REBATE_PAYER_LABELS,
  REBATE_SETTLEMENT_LABELS,
  type RebateBasisKey,
} from "@/lib/rebates/rules";
import { typedAmount } from "@/lib/orders/punch-figures";
import { formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { CompanyCombobox } from "@/components/ui/company-combobox";
import type { ItemComboOption } from "@/components/items/item-combobox";
import { FieldError, Fold } from "./parts";
import { useOrderFigures } from "./use-figures";
import { invalidProps, type PunchErrors, type PunchForm, type VendorOption } from "./types";

type Suggestion = Awaited<ReturnType<typeof suggestOrderRebates>>[number];

/** The most rebates one order takes — the schema's limit, so the form stops offering more at it. */
const MAX_REBATES = 5;

/**
 * What the distributor or the OEM pays back after the sale. Rendered only for somebody holding
 * `rebates.view` — the action refuses rebates from anybody else, and nothing about them is shown to
 * the rest — so the parent leaves this out entirely rather than hiding it.
 *
 * The rebate programmes that match the product, the distributor and the deal registration are offered
 * with a "Use" button; each is looked up for exactly those three, and shown only for them.
 */
export function RebateFold({
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
  open: boolean | undefined;
  hasError: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { control } = form;
  const { fields, append, remove } = useFieldArray({ control, name: "rebates" });
  const figures = useOrderFigures(control, selectedItem);
  const [itemId, quoteVendorId, dealRegStatus, rebates] = useWatch({
    control,
    name: ["itemId", "quoteVendorId", "dealRegStatus", "rebates"],
  });
  const rows = rebates ?? [];

  // Keyed by what they were asked for, so a change of product, distributor or registration never
  // leaves the previous answer on screen while the next is on its way.
  const suggestKey = itemId ? `${itemId}|${quoteVendorId ?? ""}|${dealRegStatus ?? ""}` : "";
  const [fetched, setFetched] = useState<{ key: string; rows: Suggestion[] }>({ key: "", rows: [] });
  const suggestions = suggestKey && fetched.key === suggestKey ? fetched.rows : [];
  useEffect(() => {
    if (!itemId) return;
    const key = `${itemId}|${quoteVendorId ?? ""}|${dealRegStatus ?? ""}`;
    let cancelled = false;
    suggestOrderRebates({ itemId, vendorId: quoteVendorId || null, dealRegStatus: dealRegStatus || null })
      .then((found) => {
        if (!cancelled) setFetched({ key, rows: found });
      })
      // No suggestions is what a failed lookup leaves; rebates can still be entered by hand.
      .catch(() => {
        if (!cancelled) setFetched({ key, rows: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [itemId, quoteVendorId, dealRegStatus]);

  const first = rows[0];
  let summary: string | null = null;
  if (first) {
    const value = typedAmount(first.value);
    const what = value === null ? "A rebate" : first.basis === "AMOUNT" ? formatCurrency(value) : `${value}%`;
    const payerName = first.payerCompanyId ? vendors.find((v) => v.id === first.payerCompanyId)?.name : undefined;
    summary = `${what} from ${payerName ?? REBATE_PAYER_LABELS[first.payer].toLowerCase()}`;
    if (rows.length > 1) summary += ` + ${rows.length - 1} more`;
  } else if (suggestions.length > 0) {
    summary = suggestions.length === 1 ? "1 programme applies" : `${suggestions.length} programmes apply`;
  }

  return (
    <Fold title="Backend rebate" summary={summary} open={open ?? (rows.length > 0 || hasError)} onOpenChange={onOpenChange}>
      <p className="text-xs text-muted">
        What the distributor or the OEM pays back after the sale, by credit note or into the bank. It shows on the order and
        in the rebates report, and never counts toward targets.
      </p>
      {suggestions.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted">From your rebate programmes:</p>
          {suggestions.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 rounded-md bg-surface-sunken px-2 py-1.5 text-xs">
              <span className="text-text">
                {p.name} — {p.rate}% {REBATE_BASIS_LABELS[p.basis as RebateBasisKey].replace(/^% /, "")}, from{" "}
                {REBATE_PAYER_LABELS[p.payer].toLowerCase()}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={fields.length >= MAX_REBATES || rows.some((r) => r?.programmeId === p.id)}
                onClick={() =>
                  append({
                    programmeId: p.id,
                    basis: p.basis,
                    value: p.rate,
                    payer: p.payer,
                    payerCompanyId: p.payerCompanyId ?? "",
                    settlement: p.settlement,
                    note: "",
                  })
                }
              >
                Use
              </Button>
            </div>
          ))}
        </div>
      )}
      {fields.map((field, index) => (
        <RebateRow
          key={field.id}
          index={index}
          form={form}
          errors={errors}
          vendors={vendors}
          basis={(rows[index]?.basis ?? "PURCHASE_VALUE") as RebateBasisKey}
          expected={figures.rebateExpected[index] ?? null}
          onRemove={() => remove(index)}
        />
      ))}
      {fields.length < MAX_REBATES && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() =>
            append({
              programmeId: "",
              basis: "PURCHASE_VALUE",
              value: "",
              payer: "DISTRIBUTOR",
              payerCompanyId: quoteVendorId || "",
              settlement: "CREDIT_NOTE",
              note: "",
            })
          }
        >
          + Add a rebate
        </Button>
      )}
    </Fold>
  );
}

/**
 * One rebate. Its fields are named by index, never by the row's key: `useFieldArray` gives each row a
 * fresh random id per render environment, and an id built from it would differ between the server's
 * markup and the browser's (scripts/check-address.ts).
 */
function RebateRow({
  index,
  form,
  errors,
  vendors,
  basis,
  expected,
  onRemove,
}: {
  index: number;
  form: PunchForm;
  errors: PunchErrors;
  vendors: VendorOption[];
  basis: RebateBasisKey;
  expected: number | null;
  onRemove: () => void;
}) {
  const { control, register } = form;
  const rowError = errors.rebates?.[index];
  return (
    <div className="space-y-3 rounded-md border border-line p-3">
      {/* By the fold's width, not the screen's (see `Fold`): three to a line only once "% of what we sell for" fits. */}
      <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2 @2xl:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor={`rebates.${index}.basis`}>Worked out as</Label>
          <Select id={`rebates.${index}.basis`} {...register(`rebates.${index}.basis`)}>
            {rebateBasisValues.map((v) => (
              <option key={v} value={v}>
                {REBATE_BASIS_LABELS[v]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`rebates.${index}.value`}>{basis === "AMOUNT" ? "Amount (₹)" : "Percent"}</Label>
          <Input
            id={`rebates.${index}.value`}
            type="number"
            step="0.001"
            min={0}
            className="aria-[invalid=true]:border-danger"
            {...register(`rebates.${index}.value`)}
            {...invalidProps(`rebates.${index}.value`, rowError?.value?.message)}
          />
          <FieldError id={`rebates.${index}.value`} message={rowError?.value?.message} />
        </div>
        <div className="space-y-1">
          <p className="text-[13px] font-medium text-muted">Expected back</p>
          <p className="pt-2 text-sm text-text">{expected !== null ? formatCurrency(expected) : "—"}</p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2 @2xl:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor={`rebates.${index}.payer`}>Paid by</Label>
          <Select id={`rebates.${index}.payer`} {...register(`rebates.${index}.payer`)}>
            {rebatePayerValues.map((v) => (
              <option key={v} value={v}>
                {REBATE_PAYER_LABELS[v]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`rebates.${index}.payerCompanyId`}>Which company</Label>
          <Controller
            name={`rebates.${index}.payerCompanyId`}
            control={control}
            render={({ field: payer }) => (
              <CompanyCombobox
                id={`rebates.${index}.payerCompanyId`}
                inputRef={payer.ref}
                companies={vendors}
                value={payer.value ?? ""}
                autoHighlightFirst="typed"
                onSelect={(company) => payer.onChange(company?.id ?? "")}
                placeholder="Distributor or OEM…"
              />
            )}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`rebates.${index}.settlement`}>Comes as</Label>
          <Select id={`rebates.${index}.settlement`} {...register(`rebates.${index}.settlement`)}>
            {rebateSettlementValues.map((v) => (
              <option key={v} value={v}>
                {REBATE_SETTLEMENT_LABELS[v]}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor={`rebates.${index}.note`}>Note</Label>
          <Input
            id={`rebates.${index}.note`}
            placeholder="Quarter, scheme, condition…"
            maxLength={500}
            {...register(`rebates.${index}.note`)}
            {...invalidProps(`rebates.${index}.note`, rowError?.note?.message)}
          />
          <FieldError id={`rebates.${index}.note`} message={rowError?.note?.message} />
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </div>
  );
}
