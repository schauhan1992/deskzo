import { z } from "zod";

/**
 * What a new joiner may send us before they have an account.
 *
 * Lives outside `src/actions` because a `"use server"` module may only export async functions —
 * a schema exported from one fails the build. Keeping it here also means the same rules can be
 * read by the form without dragging the server action into the client bundle.
 */

const pan = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "A PAN is five letters, four digits, then a letter.")
  .optional()
  .or(z.literal(""));

const ifsc = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "An IFSC is four letters, a zero, then six characters.")
  .optional()
  .or(z.literal(""));

const text = (max = 120) => z.string().trim().max(max).optional().or(z.literal(""));

export const intakeSchema = z.object({
  token: z.string().min(10),
  personalEmail: z.string().trim().email("That isn't a valid email.").optional().or(z.literal("")),
  personalPhone: z.string().trim().min(6, "We need a number we can reach you on.").max(20),
  dateOfBirth: z.string().trim().min(1, "Date of birth is needed for your records."),
  bloodGroup: text(8),
  maritalStatus: text(20),

  addressLine1: z.string().trim().min(3, "Street address.").max(160),
  addressLine2: text(160),
  city: z.string().trim().min(2, "City.").max(80),
  state: z.string().trim().min(2, "State — it decides your professional tax.").max(80),
  pincode: z.string().trim().regex(/^\d{6}$/, "A six-digit PIN code."),

  emergencyContactName: z.string().trim().min(2, "Somebody we can call.").max(80),
  emergencyContactPhone: z.string().trim().min(6, "Their number.").max(20),
  emergencyContactRelation: text(40),

  panNumber: pan,
  aadhaarLast4: z
    .string()
    .trim()
    .regex(/^\d{4}$/, "Only the last four digits — never the whole number.")
    .optional()
    .or(z.literal("")),
  uanNumber: text(20),

  bankName: text(80),
  bankAccountNumber: text(32),
  bankIfsc: ifsc,
});

export type IntakeInput = z.infer<typeof intakeSchema>;
