"use client";

import { useState } from "react";
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
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CompanyDetailFields } from "@/components/companies/company-fields";
import { gstTreatmentValues, gstTreatmentLabels } from "@/lib/gst";

type FormValues = z.input<typeof createCompanySchema>;
type IndustryOption = { id: string; name: string };

export function NewCompanyForm({
  industries,
  defaultRelationshipType = "CLIENT",
  relationshipTypeOptions = relationshipTypeValues,
  managedByResellerId,
}: {
  industries: IndustryOption[];
  defaultRelationshipType?: CompanyRelationshipType;
  relationshipTypeOptions?: readonly CompanyRelationshipType[];
  /** Creating one of this reseller's end customers — the record is flagged do-not-contact on save. */
  managedByResellerId?: string;
}) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, CreateCompanyInput>({
    resolver: zodResolver(createCompanySchema),
    defaultValues: {
      source: "LINKEDIN",
      relationshipType: defaultRelationshipType,
      managedByResellerId,
      paymentTerms: "NET_30",
      location: { label: "Head Office", country: "India", gstTreatment: "UNREGISTERED" },
      contacts: [{ name: "", designation: "OTHER", email: "", phone: "", linkedinUrl: "", isPrimary: true }],
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: "contacts" });

  async function onSubmit(values: CreateCompanyInput) {
    setServerError(null);
    const result = await createCompany(values);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    router.push(`/companies/${result.data.id}`);
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-6">
      {serverError && <div className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{serverError}</div>}

      <CompanyDetailFields
        register={register as unknown as UseFormRegister<FieldValues>}
        errors={errors}
        industries={industries}
        relationshipTypeOptions={relationshipTypeOptions}
      />

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
          <div className="space-y-1.5">
            <Label htmlFor="location.city">City</Label>
            <Input id="location.city" {...register("location.city")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="location.state">State</Label>
            <Input id="location.state" {...register("location.state")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="location.country">Country</Label>
            <Input id="location.country" placeholder="India" {...register("location.country")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="location.pincode">PIN code</Label>
            <Input id="location.pincode" placeholder="400001" {...register("location.pincode")} />
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
                <Label htmlFor={`${field.id}-name`}>Name</Label>
                <Input id={`${field.id}-name`} {...register(`contacts.${index}.name` as const)} />
                {errors.contacts?.[index]?.name && (
                  <p className="text-xs text-danger">{errors.contacts[index]?.name?.message}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${field.id}-designation`}>Designation</Label>
                <Select id={`${field.id}-designation`} {...register(`contacts.${index}.designation` as const)}>
                  {contactDesignationValues.map((d) => (
                    <option key={d} value={d}>
                      {d.replaceAll("_", " ")}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${field.id}-email`}>Email</Label>
                <Input id={`${field.id}-email`} type="email" {...register(`contacts.${index}.email` as const)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${field.id}-phone`}>Phone</Label>
                <Input id={`${field.id}-phone`} {...register(`contacts.${index}.phone` as const)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${field.id}-linkedin`}>LinkedIn URL</Label>
                <Input id={`${field.id}-linkedin`} {...register(`contacts.${index}.linkedinUrl` as const)} />
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
