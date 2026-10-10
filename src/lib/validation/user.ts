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
  /**
   * Added with Staff & roles' Add staff form, and optional so every older caller is unchanged. The job
   * title is their designation on the HR record (EmployeeProfile), the phone their work number on the
   * account — the one a quote prints, never their personal mobile.
   */
  jobTitle: z.string().trim().max(80, "Keep the job title under 80 characters").optional().or(z.literal("")),
  phone: z.string().trim().max(32, "That is too long for a phone number").optional().or(z.literal("")),
  /** False makes the account switched off: no seat, and no setup email until somebody switches it on. Default on. */
  active: z.boolean().optional(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;

/**
 * The work profile Staff & roles edits without the HR module (docs/digital-cards-and-signatures.md
 * §2.3): the job title (`EmployeeProfile.designation`) and the work phone (`User.phone`). Digital cards
 * and signatures fill themselves from these, so a workspace that buys only Cards still needs them.
 * Empty clears the field.
 */
export const updateWorkProfileSchema = z.object({
  id: z.string().min(1),
  jobTitle: z.string().trim().max(80, "Keep the job title under 80 characters"),
  phone: z.string().trim().max(32, "That is too long for a phone number"),
});

export type UpdateWorkProfileInput = z.infer<typeof updateWorkProfileSchema>;
