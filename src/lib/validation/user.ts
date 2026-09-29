import { z } from "zod";
import { isSystemAddress } from "@/lib/people";


/**
 * A role key, checked against the database rather than against a union.
 *
 * This was `z.enum(ROLES)`, which could enumerate the eight roles the enum declared. Roles are rows
 * now, so the schema can only say "a non-empty string" and the action behind it calls `roleExists`
 * before writing — with the foreign key on `users.role` as the backstop if anything ever slips past
 * both.
 */
const roleKey = z.string().trim().min(1, "Pick a role");

export const updateUserAssignmentSchema = z.object({
  id: z.string().min(1),
  role: roleKey,
  departmentId: z.string().min(1).nullable(),
  managerId: z.string().min(1).nullable(),
});

export type UpdateUserAssignmentInput = z.infer<typeof updateUserAssignmentSchema>;

/**
 * No password: the person chooses their own from the setup email (src/lib/account-setup.ts). A
 * `temporaryPassword` an older caller still sends is dropped, like any other key the schema doesn't know.
 */
export const createUserSchema = z.object({
  name: z.string().trim().min(2, "Name is required"),
  email: z
    .string()
    .trim()
    .email("Enter a valid email")
    // Platform support's and the Automation account's addresses (src/lib/people.ts) are nobody's.
    .refine((email) => !isSystemAddress(email), "That address is reserved. Enter the person's own email."),
  role: roleKey,
  departmentId: z.string().optional().or(z.literal("")),
  /** "This person already uses another workspace on this platform": the setup email is the one-step invite, which also offers linking. */
  usesAnotherWorkspace: z.boolean().optional(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
