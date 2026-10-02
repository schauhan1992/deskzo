"use client";

import { useEffect, useState } from "react";
import type { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  createCompanySchema,
  type CreateCompanyInput,
  companySourceValues,
  contactDesignationValues,
} from "@/lib/validation/company";
import { companyFieldSetup, createCompany } from "@/actions/company";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { AddressFields } from "@/components/ui/address-fields";
import { isIndia } from "@/lib/geo/countries";
import { treatmentForCountryChange } from "@/lib/gst";
import { ExistingCompanyMatches } from "@/components/companies/existing-company-matches";
import {
  CustomFieldInputs,
  missingRequired,
  type CustomFieldFormValues,
  type CustomFieldPerson,
} from "@/components/custom-fields/custom-field-inputs";
import type { CustomFieldDef } from "@/lib/custom-fields/rules";

/** The workspace's required company fields — the only ones a quick create asks for. */
type RequiredFields = { fields: CustomFieldDef[]; values: CustomFieldFormValues; people: CustomFieldPerson[] };
const NO_FIELDS: RequiredFields = { fields: [], values: {}, people: [] };

type FormValues = z.input<typeof createCompanySchema>;

const EMPTY_CONTACT = { name: "", designation: "OTHER" as (typeof contactDesignationValues)[number], email: "", phone: "" };
type IndustryOption = { id: string; name: string };

export type QuickCreatedCompany = {
  id: string;
  name: string;
  contacts: { id: string; name: string; designation: string }[];
};

export function QuickCreateCompanyDialog({
  open,
  initialName,
  industries,
  canAddContact = true,
  onClose,
  onCreated,
}: {
  open: boolean;
  initialName: string;
  industries: IndustryOption[];
  /** `contacts.view` — without it the company is created with nobody on it. */
  canAddContact?: boolean;
  onClose: () => void;
  onCreated: (company: QuickCreatedCompany) => void;
}) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  /**
   * The person at the new company — optional, and outside the zod form on purpose.
   *
   * Registered as `contacts.0` it would make the name required the moment the dialog opened, and a
   * company created without anybody's name yet is still a company. So it is held here and becomes
   * `contacts: [...]` only when a name has been typed. The server still validates it, email format
   * included, so nothing weaker gets through than the full form allows.
   */
  const [contact, setContact] = useState(EMPTY_CONTACT);
  /**
   * The workspace's own company fields that must be answered (src/lib/custom-fields), loaded the first
   * time the dialog opens: without them a required one would refuse the save with nothing to fill in.
   * The rest wait for the company's page.
   */
  const [required, setRequired] = useState<RequiredFields | null>(null);
  const [custom, setCustom] = useState<CustomFieldFormValues>({});
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});
  const setContactField = (key: keyof typeof EMPTY_CONTACT) => (e: { target: { value: string } }) =>
    setContact((prev) => ({ ...prev, [key]: e.target.value }));
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, CreateCompanyInput>({
    resolver: zodResolver(createCompanySchema),
    defaultValues: { name: initialName, source: "LINKEDIN", location: { label: "Head Office", country: "India", gstTreatment: "UNREGISTERED" } },
  });

  // Reset the form each time the dialog opens — adjusted during render (per React's
  // guidance) rather than in an effect, to avoid an extra render pass.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setServerError(null);
      setContact(EMPTY_CONTACT);
      setCustom(required?.values ?? {});
      setCustomErrors({});
      reset({ name: initialName, source: "LINKEDIN", location: { label: "Head Office", country: "India", gstTreatment: "UNREGISTERED" } });
    }
  }

  useEffect(() => {
    if (!open || required) return;
    let live = true;
    companyFieldSetup().then(
      (setup) => {
        if (!live) return;
        const fields = setup.fields.filter((f) => f.required);
        const values = Object.fromEntries(fields.map((f) => [f.key, setup.values[f.key]!]));
        setRequired({ fields, values, people: setup.people });
        setCustom(values);
      },
      // Without them the company is still created — and a field the server insists on says so.
      () => {
        if (live) setRequired(NO_FIELDS);
      },
    );
    return () => {
      live = false;
    };
  }, [open, required]);

  async function onSubmit(values: CreateCompanyInput) {
    setServerError(null);
    const missing = missingRequired(required?.fields ?? [], custom);
    setCustomErrors(missing);
    if (Object.keys(missing).length > 0) return;
    const named = contact.name.trim();
    // An email or phone with nobody to attach it to is a contact half-entered, not a choice to skip
    // one — dropping it silently would lose exactly what somebody just typed.
    if (!named && (contact.email.trim() || contact.phone.trim())) {
      setServerError("Add the contact's name, or clear their email and phone.");
      return;
    }
    const result = await createCompany({
      ...values,
      customFields: custom,
      contacts: named
        ? [{ name: named, designation: contact.designation, email: contact.email.trim(), phone: contact.phone.trim(), isPrimary: true }]
        : [],
    });
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    // The contact comes back with its id, so the form that opened this can select it at once.
    onCreated({ id: result.data.id, name: values.name.trim(), contacts: result.data.contacts });
  }

  return (
    <Dialog open={open} onClose={onClose} title="Create new company">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
        {serverError && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{serverError}</p>}

        <div className="space-y-1.5">
          <Label htmlFor="qc-name">Company name *</Label>
          <Input id="qc-name" {...register("name")} />
          {errors.name && <p className="text-xs text-danger">{errors.name.message}</p>}
          {/* The picker that opened this only knows this person's accounts. The same name held by
              somebody else is a duplicate the save will refuse — said here, before the rest is filled. */}
          <ExistingCompanyMatches name={String(watch("name") ?? "")} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="qc-industry">Industry</Label>
            <Select id="qc-industry" {...register("industryId")}>
              <option value="">Not set</option>
              {industries.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="qc-source">Source</Label>
            <Select id="qc-source" {...register("source")}>
              {companySourceValues.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </div>
          {/* Country, state, city and PIN, picked or looked up: the state resolves to the GST code
              that decides CGST + SGST against IGST on every document this customer is ever sent, and
              a typed PIN fills the other two in. The country defaults to India; choosing another
              turns the state into free text and the PIN into a postal code. */}
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
        </div>

        {required && required.fields.length > 0 && (
          <fieldset className="space-y-3 rounded-md border border-line p-3">
            <legend className="px-1 text-xs font-medium text-muted">Required by your workspace</legend>
            <CustomFieldInputs
              fields={required.fields}
              values={custom}
              people={required.people}
              errors={customErrors}
              idPrefix="qc-cf"
              onChange={(key, value) => setCustom((c) => ({ ...c, [key]: value }))}
            />
          </fieldset>
        )}

        {canAddContact && (
          <fieldset className="space-y-3 rounded-md border border-line p-3">
            <legend className="px-1 text-xs font-medium text-muted">Contact person — optional</legend>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="qc-contact-name">Name</Label>
                <Input id="qc-contact-name" value={contact.name} onChange={setContactField("name")} autoComplete="off" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="qc-contact-designation">Designation</Label>
                <Select id="qc-contact-designation" value={contact.designation} onChange={setContactField("designation")}>
                  {contactDesignationValues.map((d) => (
                    <option key={d} value={d}>
                      {d.replaceAll("_", " ")}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="qc-contact-email">Email</Label>
                <Input id="qc-contact-email" type="email" value={contact.email} onChange={setContactField("email")} autoComplete="off" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="qc-contact-phone">Phone</Label>
                <Input id="qc-contact-phone" value={contact.phone} onChange={setContactField("phone")} autoComplete="off" />
              </div>
            </div>
            <p className="text-[11px] text-subtle">Saved as the company&apos;s primary contact, and picked for this lead.</p>
          </fieldset>
        )}

        <p className="text-xs text-subtle">
          GST and D-U-N-S numbers, more contacts and other addresses can be added from the company page.
        </p>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={isSubmitting}>
            {isSubmitting ? "Creating…" : "Create company"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
