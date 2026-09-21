import { z } from "zod";

export const createIndustrySchema = z.object({
  name: z.string().trim().min(2, "Name is required"),
});

export type CreateIndustryInput = z.infer<typeof createIndustrySchema>;

export const updateIndustrySchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(2, "Name is required"),
});

export type UpdateIndustryInput = z.infer<typeof updateIndustrySchema>;
