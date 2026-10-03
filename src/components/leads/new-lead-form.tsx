"use client";

import { useId, useState } from "react";
import type { z } from "zod";
import { useForm, useFieldArray, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { createLeadSchema, type CreateLeadInput } from "@/lib/validation/lead";
import { createLead } from "@/actions/lead";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  CustomFieldInputs,
  missingRequired,
  type CustomFieldFormValues,
  type CustomFieldPerson,
} from "@/components/custom-fields/custom-field-inputs";
import type { CustomFieldDef } from "@/lib/custom-fields/rules";
import { CompanyCombobox, type CompanyComboOption } from "@/components/ui/company-combobox";
import { QuickCreateCompanyDialog, type QuickCreatedCompany } from "@/components/companies/quick-create-company-dialog";
import { NewContactDialog, type CreatedContact } from "@/components/companies/new-contact-dialog";
import { ItemCombobox } from "@/components/items/item-combobox";
import { PersonCombobox, type PersonOption } from "@/components/ui/person-combobox";
import { LEAD_SOURCE_LABELS, LEAD_SOURCE_VALUES } from "@/lib/leads/source";
import { leadPath } from "@/lib/record-links";

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
  currentUser,
  canAssign,
  canAddContact = true,
  people,
  customFields = { fields: [], values: {}, people: [] },
}: {
  companies: CompanyComboOption[];
  initialCompanyId?: string;
  items: ItemOption[];
  itemsEnabled: boolean;
  industries: IndustryOption[];
  currentUser: { id: string; role: string };
  /** `leads.assign` — may choose anybody as the salesperson. */
  canAssign: boolean;
  /** `contacts.view` — may add a person at the company from here. */
  canAddContact?: boolean;
  people: PersonOption[];
  /** The workspace's own lead fields (src/lib/custom-fields/server.ts `formSetup`). */
  customFields?: { fields: CustomFieldDef[]; values: CustomFieldFormValues; people: CustomFieldPerson[] };
}) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [custom, setCustom] = useState<CustomFieldFormValues>(customFields.values);
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});
  const [localCompanies, setLocalCompanies] = useState<CompanyComboOption[]>(companies);
  const [createDialog, setCreateDialog] = useState<{ open: boolean; initialName: string }>({
    open: false,
    initialName: "",
  });
  const [contactDialog, setContactDialog] = useState(false);
  // DOM ids for the product rows — from useId, never from useFieldArray's row id, which is a fresh
  // uuid per render environment and breaks hydration (see check:address).
  const rowId = useId();
  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, CreateLeadInput>({
    resolver: zodResolver(createLeadSchema),
    defaultValues: { companyId: initialCompanyId ?? "", requirements: [], source: "OTHER", sourceDetail: "", ownerUserId: "" },
  });
  const { fields, append, remove } = useFieldArray({ control, name: "requirements" });

  const selectedCompanyId = watch("companyId");
  const selectedCompany = localCompanies.find((c) => c.id === selectedCompanyId);

  function handleCompanyCreated(company: QuickCreatedCompany) {
    setLocalCompanies((prev) => [...prev, company]);
    setValue("companyId", company.id, { shouldValidate: true });
    // The person entered in the dialog is who this lead is with — selected, not left for a second trip.
    setValue("contactId", company.contacts[0]?.id ?? "");
    setCreateDialog({ open: false, initialName: "" });
  }

  /**
   * A new person at the company already chosen: added to that company's contacts here, so the
   * dropdown can show them, and selected — they are who this lead came from.
   */
  function handleContactCreated(contact: CreatedContact) {
    setLocalCompanies((prev) =>
      prev.map((c) => (c.id === selectedCompanyId ? { ...c, contacts: [...(c.contacts ?? []), contact] } : c)),
    );
    setValue("contactId", contact.id, { shouldDirty: true });
    setContactDialog(false);
  }

  async function onSubmit(values: CreateLeadInput) {
    setServerError(null);
    const missing = missingRequired(customFields.fields, custom);
    setCustomErrors(missing);
    if (Object.keys(missing).length > 0) return;
    const result = await createLead({ ...values, customFields: custom });
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    router.push(leadPath(result.data.leadSeq));
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
            <div className="flex gap-2">
              <Select id="contactId" className="flex-1" {...register("contactId")} disabled={!selectedCompany}>
                <option value="">No specific contact</option>
                {selectedCompany?.contacts?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.designation.replaceAll("_", " ")})
                  </option>
                ))}
              </Select>
              {canAddContact && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!selectedCompany}
                  onClick={() => setContactDialog(true)}
                  title={selectedCompany ? undefined : "Choose the company first"}
                >
                  + New contact
                </Button>
              )}
            </div>
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

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="source">Source</Label>
              <Select id="source" {...register("source")}>
                {LEAD_SOURCE_VALUES.map((s) => (
                  <option key={s} value={s}>
                    {LEAD_SOURCE_LABELS[s]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sourceDetail">Source detail</Label>
              <Input
                id="sourceDetail"
                placeholder="Which website or page, campaign, who referred them…"
                autoComplete="off"
                {...register("sourceDetail")}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ownerUserId">Salesperson</Label>
            {canAssign ? (
              <>
                <Controller
                  name="ownerUserId"
                  control={control}
                  render={({ field }) => (
                    <PersonCombobox
                      id="ownerUserId"
                      people={people}
                      value={field.value ?? ""}
                      onSelect={(person) => field.onChange(person?.id ?? "")}
                      placeholder="Search a salesperson — or leave empty to assign automatically"
                    />
                  )}
                />
                <p className="text-xs text-subtle">
                  Left empty, the assignment rules choose (Settings → Lead assignment).
                </p>
              </>
            ) : (
              // Without `leads.assign` there is no choice to offer — say where it will go instead.
              <p id="ownerUserId" className="text-sm text-muted">
                {currentUser.role === "SALES" ? "This lead will be yours." : "Assigned automatically by the lead assignment rules."}
              </p>
            )}
          </div>

          {itemsEnabled && (
            <div className="space-y-2 border-t border-line pt-4">
              <div className="flex items-center justify-between">
                <Label>Products required</Label>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => append({ itemId: "", quantity: 1, notes: "", renewalDate: "" })}
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
                  <div key={field.id} className="space-y-2 rounded-md border border-line p-2.5">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1 space-y-1">
                        {/* Search, not a dropdown: the catalogue is long, and the name is what people know. */}
                        <Controller
                          name={`requirements.${index}.itemId` as const}
                          control={control}
                          render={({ field: itemField }) => (
                            <ItemCombobox
                              items={items}
                              value={itemField.value ?? ""}
                              onSelect={(item) => itemField.onChange(item?.id ?? "")}
                              ariaLabel={`Product ${index + 1}`}
                              showPrice
                            />
                          )}
                        />
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
                    {/* Both optional. The remarks are where the reference to an existing subscription goes,
                        so a renewal can be matched to the right tenant or VIP account later. */}
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[11rem_1fr]">
                      <div className="space-y-1">
                        <Label htmlFor={`${rowId}-${index}-renewal`} className="text-xs">
                          Renewal date
                        </Label>
                        <Input
                          id={`${rowId}-${index}-renewal`}
                          type="date"
                          {...register(`requirements.${index}.renewalDate` as const)}
                        />
                        {errors.requirements?.[index]?.renewalDate && (
                          <p className="text-xs text-danger">{errors.requirements[index]?.renewalDate?.message}</p>
                        )}
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`${rowId}-${index}-remarks`} className="text-xs">
                          Remarks
                        </Label>
                        <Input
                          id={`${rowId}-${index}-remarks`}
                          placeholder="Contract ID, VIP number, subscription ID, tenant ID…"
                          autoComplete="off"
                          {...register(`requirements.${index}.notes` as const)}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

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
        canAddContact={canAddContact}
        onClose={() => setCreateDialog({ open: false, initialName: "" })}
        onCreated={handleCompanyCreated}
      />
      {selectedCompany && canAddContact && (
        <NewContactDialog
          open={contactDialog}
          companyId={selectedCompany.id}
          companyName={selectedCompany.name}
          onClose={() => setContactDialog(false)}
          onCreated={handleContactCreated}
        />
      )}
    </Card>
  );
}
