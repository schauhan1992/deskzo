import { z } from "zod";

export const addCompanyProductSchema = z.object({
  companyId: z.string().min(1),
  locationId: z.string().min(1, "Select a location"),
  itemId: z.string().min(1, "Select a product"),
  vendorId: z.string().min(1, "Select which vendor this was purchased from"),
  quantity: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? 1 : Number(v)),
    z.number().int().positive("Quantity must be at least 1"),
  ),
  poNumber: z.string().trim().optional().or(z.literal("")),
  startDate: z.string().optional().or(z.literal("")),
  endDate: z.string().optional().or(z.literal("")),
  notes: z.string().trim().optional().or(z.literal("")),
});

export type AddCompanyProductInput = z.infer<typeof addCompanyProductSchema>;

export const updateCompanyProductSchema = z.object({
  id: z.string().min(1),
  locationId: z.string().min(1, "Select a location"),
  quantity: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? 1 : Number(v)),
    z.number().int().positive("Quantity must be at least 1"),
  ),
  poNumber: z.string().trim().optional().or(z.literal("")),
  startDate: z.string().optional().or(z.literal("")),
  endDate: z.string().optional().or(z.literal("")),
  notes: z.string().trim().optional().or(z.literal("")),
});

export type UpdateCompanyProductInput = z.infer<typeof updateCompanyProductSchema>;
