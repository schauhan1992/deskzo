"use client";

import { useState } from "react";
import type { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { createCompanySchema, type CreateCompanyInput, companySourceValues } from "@/lib/validation/company";
import { createCompany } from "@/actions/company";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";

type FormValues = z.input<typeof createCompanySchema>;
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
  onClose,
  onCreated,
}: {
  open: boolean;
  initialName: string;
  industries: IndustryOption[];
  onClose: () => void;
  onCreated: (company: QuickCreatedCompany) => void;
}) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, CreateCompanyInput>({
    resolver: zodResolver(createCompanySchema),
    defaultValues: { name: initialName, source: "LINKEDIN", location: { label: "Head Office", country: "India" } },
  });

  // Reset the form each time the dialog opens — adjusted during render (per React's
  // guidance) rather than in an effect, to avoid an extra render pass.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setServerError(null);
      reset({ name: initialName, source: "LINKEDIN", location: { label: "Head Office", country: "India" } });
    }
  }

  async function onSubmit(values: CreateCompanyInput) {
    setServerError(null);
    const result = await createCompany(values);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    onCreated({ id: result.data.id, name: values.name.trim(), contacts: [] });
  }

  return (
    <Dialog open={open} onClose={onClose} title="Create new company">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
        {serverError && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{serverError}</p>}

        <div className="space-y-1.5">
          <Label htmlFor="qc-name">Company name *</Label>
          <Input id="qc-name" {...register("name")} />
          {errors.name && <p className="text-xs text-danger">{errors.name.message}</p>}
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
          <div className="space-y-1.5">
            <Label htmlFor="qc-city">City</Label>
            <Input id="qc-city" {...register("location.city")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="qc-state">State</Label>
            <Input id="qc-state" {...register("location.state")} />
          </div>
        </div>

        <p className="text-xs text-subtle">
          You can add contacts, GST/DUNS numbers, and more from the company page after it&rsquo;s created.
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
