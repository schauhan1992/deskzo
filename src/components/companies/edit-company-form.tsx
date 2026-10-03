"use client";

import type { CategoryTree, FlatCategory } from "@/lib/customers/categories";
import { useState } from "react";
import type { z } from "zod";
import { useForm, type UseFormRegister, type FieldValues } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import {
  updateCompanySchema,
  type UpdateCompanyInput,
  clientRelationshipTypeValues,
  commissionPartyRelationshipTypeValues,
  vendorRelationshipTypeValues,
} from "@/lib/validation/company";
import { updateCompany } from "@/actions/company";
import { Button } from "@/components/ui/button";
import { CompanyDetailFields, type TermsAdvice } from "@/components/companies/company-fields";
import type { Company, CompanyRelationshipType } from "@prisma/client";
import { bandForCount } from "@/lib/company-size";
import { companyPath } from "@/lib/record-links";

type FormValues = z.input<typeof updateCompanySchema>;
type IndustryOption = { id: string; name: string };

/**
 * A company can be re-typed within its own family (Vendor to Distributor, say) but not moved across
 * one. Crossing families silently drops the record out of its module and hides the tabs that hold
 * its history — a customer flipped to Vendor loses access to its own orders, and a commission party
 * flipped to Client orphans its linked companies and payee accounts.
 */
function relationshipTypeOptionsFor(current: CompanyRelationshipType) {
  if (current === "CLIENT") return clientRelationshipTypeValues;
  if (current === "COMMISSION_PARTY") return commissionPartyRelationshipTypeValues;
  return vendorRelationshipTypeValues;
}

export function EditCompanyForm({
  company,
  industries,
  categories,
  termsAdvice = null,
}: {
  // Money columns reach the client as plain numbers — see `toPlain`.
  company: Omit<Company, "creditLimit"> & { creditLimit: number | null };
  /** For a customer: their credit rating and what it supports. Null for a vendor, or without the payments view. */
  termsAdvice?: TermsAdvice | null;
  industries: IndustryOption[];
  categories?: CategoryTree<FlatCategory>[];
}) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, UpdateCompanyInput>({
    resolver: zodResolver(updateCompanySchema),
    defaultValues: {
      id: company.id,
      name: company.name,
      industryId: company.industryId ?? "",
      customerCategoryId: company.customerCategoryId ?? "",
      companyType: company.companyType ?? "",
      relationshipType: company.relationshipType,
      website: company.website ?? "",
      linkedinUrl: company.linkedinUrl ?? "",
      // The band the stored count falls in; saving it unchanged keeps the exact count (countForBand).
      employeeBand: bandForCount(company.employeeCount)?.key ?? "",
      paymentTerms: company.paymentTerms,
      dunsNumber: company.dunsNumber ?? "",
      tags: company.tags.join(", "),
      source: company.source,
    },
  });

  async function onSubmit(values: UpdateCompanyInput) {
    setServerError(null);
    const result = await updateCompany(values);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    router.push(companyPath(company.companySeq));
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {serverError && <div className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{serverError}</div>}

      <CompanyDetailFields
        register={register as unknown as UseFormRegister<FieldValues>}
        errors={errors}
        industries={industries}
        categories={categories}
        relationshipTypeOptions={relationshipTypeOptionsFor(company.relationshipType)}
        termsAdvice={termsAdvice}
        selectedTerms={String(watch("paymentTerms") ?? "")}
      />
      <p className="text-xs text-subtle">
        Addresses and GST numbers are now managed per location — see the Locations tab on the company page.
      </p>

      <div className="flex justify-end gap-3">
        <Button type="button" variant="secondary" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
