"use client";

import { useState } from "react";
import type { z } from "zod";
import { useForm, useFieldArray, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { createLeadSchema, type CreateLeadInput } from "@/lib/validation/lead";
import { createLead } from "@/actions/lead";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { CompanyCombobox, type CompanyComboOption } from "@/components/ui/company-combobox";
import { QuickCreateCompanyDialog, type QuickCreatedCompany } from "@/components/companies/quick-create-company-dialog";

type ItemOption = {
  id: string;
  name: string;
  sku: string;
  type: string;
  unit: string | null;
  sellingPrice: unknown;
};

type IndustryOption = { id: string; name: string };

type FormValues = z.input<typeof createLeadSchema>;

export function NewLeadForm({
  companies,
  initialCompanyId,
  items,
  itemsEnabled,
  industries,
}: {
  companies: CompanyComboOption[];
  initialCompanyId?: string;
  items: ItemOption[];
  itemsEnabled: boolean;
  industries: IndustryOption[];
}) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [localCompanies, setLocalCompanies] = useState<CompanyComboOption[]>(companies);
  const [createDialog, setCreateDialog] = useState<{ open: boolean; initialName: string }>({
    open: false,
    initialName: "",
  });
  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, CreateLeadInput>({
    resolver: zodResolver(createLeadSchema),
    defaultValues: { companyId: initialCompanyId ?? "", requirements: [] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: "requirements" });

  const selectedCompanyId = watch("companyId");
  const selectedCompany = localCompanies.find((c) => c.id === selectedCompanyId);

  function handleCompanyCreated(company: QuickCreatedCompany) {
    setLocalCompanies((prev) => [...prev, company]);
    setValue("companyId", company.id, { shouldValidate: true });
    setValue("contactId", "");
    setCreateDialog({ open: false, initialName: "" });
  }

  async function onSubmit(values: CreateLeadInput) {
    setServerError(null);
    const result = await createLead(values);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    router.push(`/leads/${result.data.id}`);
  }

  return (
    <Card>
      <CardContent className="pt-5">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {serverError && (
            <div className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{serverError}</div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="companyId">Company *</Label>
            <Controller
              name="companyId"
              control={control}
              render={({ field }) => (
                <CompanyCombobox
                  // The label above was already written as `htmlFor="companyId"` but pointed at
                  // nothing, since the combobox owns the input; forwarding the id joins the two.
                  id="companyId"
                  companies={localCompanies}
                  value={field.value ?? ""}
                  onSelect={(company) => field.onChange(company?.id ?? "")}
                  onCreateNew={(query) => setCreateDialog({ open: true, initialName: query })}
                />
              )}
            />
            {errors.companyId && <p className="text-xs text-danger">{errors.companyId.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="contactId">Contact</Label>
            <Select id="contactId" {...register("contactId")} disabled={!selectedCompany}>
              <option value="">No specific contact</option>
              {selectedCompany?.contacts?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.designation.replaceAll("_", " ")})
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="title">Title *</Label>
            <Input id="title" placeholder="e.g. Microsoft 365 renewal — 25 seats" {...register("title")} />
            {errors.title && <p className="text-xs text-danger">{errors.title.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="description">Requirement details</Label>
            <Textarea id="description" {...register("description")} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="estimatedValue">Estimated value (₹)</Label>
              <Input id="estimatedValue" type="number" step="0.01" {...register("estimatedValue")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="expectedCloseDate">Expected close date</Label>
              <Input id="expectedCloseDate" type="date" {...register("expectedCloseDate")} />
            </div>
          </div>

          {itemsEnabled && (
            <div className="space-y-2 border-t border-line pt-4">
              <div className="flex items-center justify-between">
                <Label>Products required</Label>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => append({ itemId: "", quantity: 1, notes: "" })}
                  disabled={items.length === 0}
                >
                  + Add product
                </Button>
              </div>
              {items.length === 0 && (
                <p className="text-xs text-subtle">No active items in the catalog yet.</p>
              )}
              {fields.map((field, index) => {
                const selectedItemId = watch(`requirements.${index}.itemId`);
                const selectedItem = items.find((i) => i.id === selectedItemId);
                return (
                  <div key={field.id} className="flex items-start gap-2 rounded-md border border-line p-2.5">
                    <div className="flex-1 space-y-1">
                      {/*
                       * These two get `aria-label` rather than an id/htmlFor pairing: the only visible
                       * caption is "Products required" over the whole list, so there is no per-row
                       * wording to point at, and the row number is what tells one line from the next.
                       */}
                      <Select
                        aria-label={`Product ${index + 1}`}
                        {...register(`requirements.${index}.itemId` as const)}
                      >
                        <option value="">Select a product…</option>
                        {items.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name} ({item.sku}) — {formatCurrency(String(item.sellingPrice))}
                            {item.unit ? ` / ${item.unit}` : ""}
                          </option>
                        ))}
                      </Select>
                      {errors.requirements?.[index]?.itemId && (
                        <p className="text-xs text-danger">{errors.requirements[index]?.itemId?.message}</p>
                      )}
                      {selectedItem && <p className="text-xs text-subtle">{selectedItem.type}</p>}
                    </div>
                    <div className="w-20">
                      <Input
                        type="number"
                        min={1}
                        placeholder="Qty"
                        aria-label={`Quantity for product ${index + 1}`}
                        {...register(`requirements.${index}.quantity` as const)}
                      />
                    </div>
                    <Button type="button" variant="ghost" size="sm" onClick={() => remove(index)}>
                      Remove
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : "Create lead"}
            </Button>
          </div>
        </form>
      </CardContent>

      <QuickCreateCompanyDialog
        open={createDialog.open}
        initialName={createDialog.initialName}
        industries={industries}
        onClose={() => setCreateDialog({ open: false, initialName: "" })}
        onCreated={handleCompanyCreated}
      />
    </Card>
  );
}
