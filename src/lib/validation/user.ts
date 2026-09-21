import { z } from "zod";
import { ROLES } from "@/lib/roles";

export const updateUserAssignmentSchema = z.object({
  id: z.string().min(1),
  role: z.enum(ROLES),
  departmentId: z.string().min(1).nullable(),
  managerId: z.string().min(1).nullable(),
});

export type UpdateUserAssignmentInput = z.infer<typeof updateUserAssignmentSchema>;

export const createUserSchema = z.object({
  name: z.string().trim().min(2, "Name is required"),
  email: z.string().trim().email("Enter a valid email"),
  role: z.enum(ROLES),
  departmentId: z.string().optional().or(z.literal("")),
  temporaryPassword: z.string().min(8, "Temporary password must be at least 8 characters"),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
