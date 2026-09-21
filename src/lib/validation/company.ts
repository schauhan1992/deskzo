import { z } from "zod";
import type { CompanyRelationshipType } from "@prisma/client";
import { paymentTermsValues } from "@/lib/gst";
import { companyLocationFieldsSchema } from "@/lib/validation/company-location";

export const companySourceValues = ["LINKEDIN", "REFERRAL", "INBOUND", "OTHER"] as const;

export const companyTypeValues = [
  "PRIVATE_LIMITED",
  "PUBLIC_LIMITED",
  "PROPRIETORSHIP",
  "PARTNERSHIP",
  "LLP",
  "NGO",
  "GOVERNMENT",
  "OTHER",
] as const;

export const relationshipTypeValues = [
  "CLIENT",
  "RESELLER",
  "VENDOR",
  "OEM",
  "DISTRIBUTOR",
  "PARTNER",
  "COMMISSION_PARTY",
  "OTHER",
] as const;

export const relationshipTypeLabels: Record<(typeof relationshipTypeValues)[number], string> = {
  CLIENT: "Client",
  RESELLER: "Reseller",
  VENDOR: "Vendor",
  OEM: "OEM",
  DISTRIBUTOR: "Distributor",
  PARTNER: "Partner",
  COMMISSION_PARTY: "Commission Party",
  OTHER: "Other",
};

/**
 * The buying side — companies we sell to, so orders, payments, subscriptions and renewals hang off
 * them. Resellers count: we invoice the reseller, not their end customer. Use this wherever the
 * question is "can this company hold an order", rather than testing `relationshipType !== "CLIENT"`.
 */
export const customerRelationshipTypeValues = ["CLIENT", "RESELLER"] as const;

export function isCustomerRelationshipType(type: CompanyRelationshipType) {
  return customerRelationshipTypeValues.some((t) => t === type);
}

/**
 * The supply/partner side — everything that isn't a customer or a commission party, shown in the
 * Vendors module. Commission parties get their own module even though they share the same
 * onboarding lifecycle. This is the single definition of "counts as a vendor": use it for Prisma
 * filters (`relationshipType: { in: vendorRelationshipTypeValues }`) and membership checks too, so
 * the set can't drift between the list queries, the dashboard, and order processing.
 */
export const vendorRelationshipTypeValues = relationshipTypeValues.filter(
  (t) => !isCustomerRelationshipType(t) && t !== "COMMISSION_PARTY",
);

export function isVendorRelationshipType(type: CompanyRelationshipType) {
  return vendorRelationshipTypeValues.some((t) => t === type);
}

/** Fixed to a single option — the Commission Parties module's "New" form doesn't let you pick a different relationship type. */
export const commissionPartyRelationshipTypeValues = ["COMMISSION_PARTY"] as const;

/** Fixed to a single option — the plain Companies module's "New" form is CLIENT-track only; Reseller/Vendor/Commission Party companies are created from their own dedicated modules. */
export const clientRelationshipTypeValues = ["CLIENT"] as const;

/** Fixed to a single option — the Resellers module's "New" form. */
export const resellerRelationshipTypeValues = ["RESELLER"] as const;

export const vendorStatusValues = ["ONBOARDING", "ACTIVE", "INACTIVE"] as const;

export const vendorStatusLabels: Record<(typeof vendorStatusValues)[number], string> = {
  ONBOARDING: "Onboarding",
  ACTIVE: "Active",
  INACTIVE: "Inactive",
};

export const contactDesignationValues = [
  "IT_MANAGER",
  "PURCHASE_MANAGER",
  "IT_HEAD",
  "DIRECTOR",
  "CEO",
  "CIO",
  "HR",
  "OTHER",
] as const;

export const contactInputSchema = z.object({
  name: z.string().trim().min(1, "Contact name is required"),
  designation: z.enum(contactDesignationValues).default("OTHER"),
  email: z.string().trim().email("Invalid email").optional().or(z.literal("")),
  phone: z.string().trim().optional().or(z.literal("")),
  linkedinUrl: z.string().trim().url("Invalid URL").optional().or(z.literal("")),
  isPrimary: z.boolean().default(false),
});

const employeeCountField = z.preprocess(
  (v) => (v === "" || v === undefined || v === null ? undefined : Number(v)),
  z.number().int().nonnegative().optional(),
);

const tagsField = z.preprocess((v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}, z.array(z.string()));

const companyDetailsShape = {
  name: z.string().trim().min(2, "Company name is required"),
  industryId: z.string().optional().or(z.literal("")),
  category: z.string().trim().optional().or(z.literal("")),
  companyType: z.enum(companyTypeValues).optional().or(z.literal("")),
  relationshipType: z.enum(relationshipTypeValues).default("CLIENT"),
  website: z.string().trim().optional().or(z.literal("")),
  linkedinUrl: z.string().trim().optional().or(z.literal("")),
  employeeCount: employeeCountField,
  paymentTerms: z.enum(paymentTermsValues).default("NET_30"),
  dunsNumber: z.string().trim().optional().or(z.literal("")),
  tags: tagsField,
  source: z.enum(companySourceValues).default("OTHER"),
};

export const createCompanySchema = z.object({
  ...companyDetailsShape,
  /** Set only when creating a reseller's end customer from that reseller's page — see `Company.managedByResellerId`. */
  managedByResellerId: z.string().optional().or(z.literal("")),
  // The first address a company gets is both its billing and its shipping address until somebody
  // says otherwise. That is true of nearly every customer, and starting with neither ticked means
  // the first invoice has nothing to default from.
  location: companyLocationFieldsSchema.default({
    label: "Head Office",
    gstTreatment: "UNREGISTERED",
    isBilling: true,
    isShipping: true,
  }),
  contacts: z.array(contactInputSchema).default([]),
});

export const updateCompanySchema = z.object({
  id: z.string().min(1),
  ...companyDetailsShape,
});

export const updateContactSchema = z.object({
  id: z.string().min(1),
  ...contactInputSchema.shape,
});

export type CreateCompanyInput = z.infer<typeof createCompanySchema>;
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;
export type ContactInput = z.infer<typeof contactInputSchema>;
export type UpdateContactInput = z.infer<typeof updateContactSchema>;

export function normalizeCompanyName(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export const assignCompaniesSchema = z.object({
  companyIds: z.array(z.string().min(1)).min(1, "Select at least one company"),
  userId: z.string().min(1, "Choose someone to assign to"),
});

export const panField = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "PAN must look like ABCDE1234F")
  .optional()
  .or(z.literal(""));

export const ifscField = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "IFSC must look like HDFC0001234")
  .optional()
  .or(z.literal(""));

/** Payout/compliance details for a vendor or commission party — set separately from the main company form, same pattern as `vendorCode`. */
export const payoutDetailsSchema = z.object({
  panNumber: panField,
  bankAccountName: z.string().trim().optional().or(z.literal("")),
  bankAccountNumber: z.string().trim().optional().or(z.literal("")),
  bankIfsc: ifscField,
  bankName: z.string().trim().optional().or(z.literal("")),
});

export type PayoutDetailsInput = z.infer<typeof payoutDetailsSchema>;

export type AssignCompaniesInput = z.infer<typeof assignCompaniesSchema>;

export const bulkUpdateCompaniesSchema = z.object({
  companyIds: z.array(z.string().min(1)).min(1, "Select at least one company"),
  /** "" leaves the field alone; "unassign" clears the caller. */
  assignedToUserId: z.string().optional().or(z.literal("")),
  vendorStatus: z.enum(vendorStatusValues).optional().or(z.literal("")),
  /** Tags to add to every selected company, on top of what each already has. */
  addTags: z.array(z.string().trim().min(1)).default([]),
});

export const bulkUpdateContactsSchema = z.object({
  contactIds: z.array(z.string().min(1)).min(1, "Select at least one contact"),
  designation: z.enum(contactDesignationValues).optional().or(z.literal("")),
  /** Deleting is separate from editing, so a mis-click on a dropdown can't remove records. */
  action: z.enum(["update", "delete"]).default("update"),
});
