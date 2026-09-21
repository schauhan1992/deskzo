import { z } from "zod";
import { gstTreatmentValues } from "@/lib/gst";

export const companyLocationFieldsSchema = z.object({
  label: z.string().trim().min(1, "Location label is required").default("Head Office"),
  address: z.string().trim().optional().or(z.literal("")),
  city: z.string().trim().optional().or(z.literal("")),
  state: z.string().trim().optional().or(z.literal("")),
  country: z.string().trim().optional().or(z.literal("")),
  pincode: z
    .string()
    .trim()
    .refine((v) => v === "" || /^[1-9][0-9]{5}$/.test(v), "A PIN code is six digits")
    .optional()
    .or(z.literal("")),
  gstNumber: z.string().trim().optional().or(z.literal("")),
  /** Marks this as the address invoices are billed to, and/or the one goods are sent to. */
  isBilling: z.boolean().default(false),
  isShipping: z.boolean().default(false),
  gstTreatment: z.enum(gstTreatmentValues).default("UNREGISTERED"),
});

export const addCompanyLocationSchema = z.object({
  companyId: z.string().min(1),
  ...companyLocationFieldsSchema.shape,
});

export const updateCompanyLocationSchema = z.object({
  id: z.string().min(1),
  ...companyLocationFieldsSchema.shape,
});

export type AddCompanyLocationInput = z.infer<typeof addCompanyLocationSchema>;
export type UpdateCompanyLocationInput = z.infer<typeof updateCompanyLocationSchema>;
