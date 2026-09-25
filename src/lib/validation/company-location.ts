import { z } from "zod";
import { gstTreatmentValues } from "@/lib/gst";
import { postalCodeField, refinePostalCode } from "@/lib/geo/postal";

export const companyLocationFieldsSchema = z.object({
  label: z.string().trim().min(1, "Location label is required").default("Head Office"),
  address: z.string().trim().optional().or(z.literal("")),
  city: z.string().trim().optional().or(z.literal("")),
  state: z.string().trim().optional().or(z.literal("")),
  country: z.string().trim().optional().or(z.literal("")),
  // Six digits in India, any postal code elsewhere — the rule is `refinePostalCode`, on the object.
  pincode: postalCodeField,
  gstNumber: z.string().trim().optional().or(z.literal("")),
  /** Marks this as the address invoices are billed to, and/or the one goods are sent to. */
  isBilling: z.boolean().default(false),
  isShipping: z.boolean().default(false),
  gstTreatment: z.enum(gstTreatmentValues).default("UNREGISTERED"),
}).superRefine(refinePostalCode);

// Re-applied: spreading `.shape` copies the fields and leaves the object-level postal rule behind.
export const addCompanyLocationSchema = z
  .object({
    companyId: z.string().min(1),
    ...companyLocationFieldsSchema.shape,
  })
  .superRefine(refinePostalCode);

export const updateCompanyLocationSchema = z
  .object({
    id: z.string().min(1),
    ...companyLocationFieldsSchema.shape,
  })
  .superRefine(refinePostalCode);

export type AddCompanyLocationInput = z.infer<typeof addCompanyLocationSchema>;
export type UpdateCompanyLocationInput = z.infer<typeof updateCompanyLocationSchema>;
