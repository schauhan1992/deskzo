"use client";

import type { CategoryTree, FlatCategory } from "@/lib/customers/categories";
import { useId, useState } from "react";
import type { z } from "zod";
import { useForm, useFieldArray, type UseFormRegister, type FieldValues } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import type { CompanyRelationshipType } from "@prisma/client";
import {
  createCompanySchema,
  type CreateCompanyInput,
  contactDesignationValues,
  relationshipTypeValues,
} from "@/lib/validation/company";
import { createCompany } from "@/actions/company";
import { companyPath } from "@/lib/record-links";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { AddressFields } from "@/components/ui/address-fields";
import { isIndia } from "@/lib/geo/countries";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CompanyDetailFields, type TermsAdvice } from "@/components/companies/company-fields";
import { ExistingCompanyMatches } from "@/components/companies/existing-company-matches";
import { gstTreatmentValues, gstTreatmentLabels, treatmentForCountryChange } from "@/lib/gst";
import {
  CustomFieldInputs,
  missingRequired,
  type CustomFieldFormValues,
  type CustomFieldPerson,
} from "@/components/custom-fields/custom-field-inputs";
import type { CustomFieldDef } from "@/lib/custom-fields/rules";

type FormValues = z.input<typeof createCompanySchema>;
type IndustryOption = { id: string; name: string };

export function NewCompanyForm({
  industries,
  categories,
  defaultRelationshipType = "CLIENT",
  relationshipTypeOptions = relationshipTypeValues,
  managedByResellerId,
  canAddContacts = true,
  termsAdvice = null,
  customFields = { fields: [], values: {}, people: [] },
}: {
  industries: IndustryOption[];
  categories?: CategoryTree<FlatCategory>[];
  defaultRelationshipType?: CompanyRelationshipType;
  relationshipTypeOptions?: readonly CompanyRelationshipType[];
  /** Creating one of this reseller's end customers — the record is flagged do-not-contact on save. */
  managedByResellerId?: string;
  /** Without `contacts.view` the company is created bare, and its people added by someone who has it. */
  canAddContacts?: boolean;
  /** For a customer: what a new customer's (empty) credit record supports. */
  termsAdvice?: TermsAdvice | null;
  /** The workspace's own company fields (src/lib/custom-fields/server.ts `formSetup`). */
  customFields?: { fields: CustomFieldDef[]; values: CustomFieldFormValues; people: CustomFieldPerson[] };
}) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [custom, setCustom] = useState<CustomFieldFormValues>(customFields.values);
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});
  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, CreateCompanyInput>({
    resolver: zodResolver(createCompanySchema),
    defaultValues: {
      source: "LINKEDIN",
      relationshipType: defaultRelationshipType,
      managedByResellerId,
      paymentTerms: "ADVANCE",
      location: { label: "Head Office", country: "India", gstTreatment: "UNREGISTERED" },
      contacts: canAddContacts
        ? [{ name: "", designation: "OTHER", email: "", phone: "", linkedinUrl: "", isPrimary: true }]
        : [],
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: "contacts" });
  /**
   * DOM ids for the contact rows, from `useId` rather than from `field.id`.
   *
   * `useFieldArray` gives each row an id that is stable across re-renders — which is what makes
   * it the right React `key`, and it stays one below. But it is a fresh random UUID per render
   * *environment*, so the server and the browser generate different ones and every `htmlFor` on
   * these rows mismatches on hydration. React cannot patch attributes up, so the labels end up
   * pointing at nothing: clicking one does not focus its field, and a screen reader announces
   * the input unnamed.
   */
  const rowId = useId();

  async function onSubmit(values: CreateCompanyInput) {
    setServerError(null);
    const missing = missingRequired(customFields.fields, custom);
    setCustomErrors(missing);
    if (Object.keys(missing).length > 0) return;
    const result = await createCompany({ ...values, customFields: custom });
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    router.push(companyPath(result.data.companySeq));
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-6">
      {serverError && <div className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{serverError}</div>}

      <CompanyDetailFields
        register={register as unknown as UseFormRegister<FieldValues>}
        errors={errors}
        industries={industries}
        categories={categories}
        relationshipTypeOptions={relationshipTypeOptions}
        nameAddon={<ExistingCompanyMatches name={String(watch("name") ?? "")} />}
        termsAdvice={termsAdvice}
        selectedTerms={String(watch("paymentTerms") ?? "")}
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
              onChange={(key, value) => {
                setCustom((c) => ({ ...c, [key]: value }));
                setCustomErrors((e) => {
                  if (!e[key]) return e;
                  const next = { ...e };
                  delete next[key];
                  return next;
                });
              }}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="text-sm font-medium text-text">Primary location</CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <p className="col-span-2 text-sm text-muted">
            A company can have more than one office, each with its own GST registration — add the rest from the
            Locations tab after creating it.
          </p>
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="location.label">Location label</Label>
            <Input id="location.label" {...register("location.label")} />
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="location.address">Address</Label>
            <Textarea id="location.address" {...register("location.address")} />
          </div>
          {/* The state decides the tax on every document raised against this address, so it is
              chosen from the GST table rather than typed. See `AddressFields`. */}
          <div className="col-span-2">
            <AddressFields
              columns={2}
              country={String(watch("location.country") ?? "")}
              state={String(watch("location.state") ?? "")}
              city={String(watch("location.city") ?? "")}
              pincode={String(watch("location.pincode") ?? "")}
              onChange={(patch) => {
                for (const [key, value] of Object.entries(patch)) {
                  setValue(`location.${key}` as never, value as never, { shouldDirty: true, shouldValidate: true });
                }
                // A customer abroad is Overseas, not Unregistered — see `treatmentForCountryChange`.
                if (patch.country !== undefined) {
                  const next = treatmentForCountryChange(isIndia(patch.country), watch("location.gstTreatment"));
                  if (next) setValue("location.gstTreatment", next, { shouldDirty: true });
                }
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="location.gstNumber">GST number</Label>
            <Input id="location.gstNumber" {...register("location.gstNumber")} />
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="location.gstTreatment">GST treatment</Label>
            <Select id="location.gstTreatment" {...register("location.gstTreatment")}>
              {gstTreatmentValues.map((t) => (
                <option key={t} value={t}>
                  {gstTreatmentLabels[t]}
                </option>
              ))}
            </Select>
          </div>
        </CardContent>
      </Card>

      {canAddContacts && (
        <Card>
          <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
            <span>Contacts</span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() =>
                append({ name: "", designation: "OTHER", email: "", phone: "", linkedinUrl: "", isPrimary: false })
              }
            >
              + Add contact
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            {fields.map((field, index) => (
              <div key={field.id} className="grid grid-cols-2 gap-3 rounded-md border border-line p-3">
                {/* Ids are keyed off field.id, not the row index: useFieldArray hands each row a stable
                    unique key, so removing a contact cannot leave two rows sharing an id and pointing
                    every label at the first one. */}
                <div className="col-span-2 space-y-1.5">
                  <Label htmlFor={`${rowId}-${index}-name`}>Name</Label>
                  <Input id={`${rowId}-${index}-name`} {...register(`contacts.${index}.name` as const)} />
                  {errors.contacts?.[index]?.name && (
                    <p className="text-xs text-danger">{errors.contacts[index]?.name?.message}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${rowId}-${index}-designation`}>Designation</Label>
                  <Select id={`${rowId}-${index}-designation`} {...register(`contacts.${index}.designation` as const)}>
                    {contactDesignationValues.map((d) => (
                      <option key={d} value={d}>
                        {d.replaceAll("_", " ")}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${rowId}-${index}-email`}>Email</Label>
                  <Input id={`${rowId}-${index}-email`} type="email" {...register(`contacts.${index}.email` as const)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${rowId}-${index}-phone`}>Phone</Label>
                  <Input id={`${rowId}-${index}-phone`} {...register(`contacts.${index}.phone` as const)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${rowId}-${index}-linkedin`}>LinkedIn URL</Label>
                  <Input id={`${rowId}-${index}-linkedin`} {...register(`contacts.${index}.linkedinUrl` as const)} />
                </div>
                <div className="col-span-2 flex items-center justify-between pt-1">
                  <label className="flex items-center gap-2 text-sm text-muted">
                    <input type="checkbox" {...register(`contacts.${index}.isPrimary` as const)} />
                    Primary contact
                  </label>
                  {fields.length > 1 && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => remove(index)}>
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end gap-3">
        <Button type="button" variant="secondary" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Save company"}
        </Button>
      </div>
    </form>
  );
}
