import { z } from "zod";

export const createDepartmentSchema = z.object({
  name: z.string().trim().min(2, "Name is required"),
});

export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;

export const updateDepartmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(2, "Name is required"),
});

export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;
