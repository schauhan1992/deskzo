import { z } from "zod";

export const createBrandSchema = z.object({
  name: z.string().trim().min(1, "Brand name is required"),
});

export const updateBrandSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1, "Brand name is required"),
});

export const createProductFamilySchema = z.object({
  brandId: z.string().min(1, "Pick a brand"),
  name: z.string().trim().min(1, "Family name is required"),
});

export const updateProductFamilySchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1, "Family name is required"),
});
