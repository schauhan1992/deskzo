import type { FieldErrors, FieldValues, UseFormRegister } from "react-hook-form";
import type { CompanyRelationshipType } from "@prisma/client";
import { companySourceValues, companyTypeValues, relationshipTypeValues, relationshipTypeLabels } from "@/lib/validation/company";
import { paymentTermsValues, paymentTermsLabels } from "@/lib/gst";
import { Input, Label, Select } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

type IndustryOption = { id: string; name: string };

export function CompanyDetailFields({
  register,
  errors,
  industries,
  relationshipTypeOptions = relationshipTypeValues,
}: {
  register: UseFormRegister<FieldValues>;
  errors: FieldErrors<FieldValues>;
  industries: IndustryOption[];
  relationshipTypeOptions?: readonly CompanyRelationshipType[];
}) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="text-sm font-medium text-text">Company details</CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="name">Company name *</Label>
            <Input id="name" {...register("name")} />
            {errors.name && <p className="text-xs text-danger">{String(errors.name.message)}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="industryId">Industry</Label>
            <Select id="industryId" {...register("industryId")}>
              <option value="">Not set</option>
              {industries.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </Select>
            {industries.length === 0 && (
              <p className="text-xs text-subtle">
                No industries configured yet — add some from Settings.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="category">Category</Label>
            <Input id="category" placeholder="e.g. SMB, Enterprise, Education" {...register("category")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="companyType">Company type</Label>
            <Select id="companyType" {...register("companyType")}>
              <option value="">Unknown</option>
              {companyTypeValues.map((t) => (
                <option key={t} value={t}>
                  {t.replaceAll("_", " ")}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="relationshipType">Relationship</Label>
            <Select id="relationshipType" {...register("relationshipType")}>
              {relationshipTypeOptions.map((t) => (
                <option key={t} value={t}>
                  {relationshipTypeLabels[t]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="employeeCount">Number of employees</Label>
            <Input id="employeeCount" type="number" min={0} {...register("employeeCount")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="website">Website</Label>
            <Input id="website" {...register("website")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="linkedinUrl">Company LinkedIn URL</Label>
            <Input id="linkedinUrl" {...register("linkedinUrl")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="paymentTerms">Payment terms</Label>
            <Select id="paymentTerms" {...register("paymentTerms")}>
              {paymentTermsValues.map((t) => (
                <option key={t} value={t}>
                  {paymentTermsLabels[t]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dunsNumber">D-U-N-S number</Label>
            <Input id="dunsNumber" {...register("dunsNumber")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="source">Source</Label>
            <Select id="source" {...register("source")}>
              {companySourceValues.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="tags">Tags</Label>
            <Input id="tags" placeholder="comma separated, e.g. Hot lead, Education sector" {...register("tags")} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
