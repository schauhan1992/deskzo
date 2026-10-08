import { z } from "zod";
import { ifscField } from "@/lib/validation/company";

const optionalText = (max: number) => z.string().trim().max(max, `At most ${max} characters`).optional().or(z.literal(""));

/**
 * One bank account — a vendor's (paid into) or the organisation's own (printed on sales documents).
 * Owner, 8 Oct 2026: several per company and for the organisation, one of them primary.
 *
 * An Indian account has an IFSC, one abroad a SWIFT/BIC and perhaps an IBAN in the account number —
 * so neither code is required, but one given must be well formed. The account must be payable somehow:
 * an account number or a UPI id.
 */
export const bankAccountSchema = z
  .object({
    label: z.string().trim().min(1, 'Give it a short name, e.g. "Main account" or "USD account"').max(60, "At most 60 characters"),
    accountHolderName: optionalText(120),
    bankName: optionalText(120),
    branchName: optionalText(120),
    accountNumber: z
      .string()
      .trim()
      .transform((s) => s.replace(/\s+/g, ""))
      .pipe(z.string().max(40, "At most 40 characters"))
      .optional()
      .or(z.literal("")),
    ifsc: ifscField,
    swift: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/, "SWIFT/BIC must look like HDFCINBB or HDFCINBBXXX")
      .optional()
      .or(z.literal("")),
    upiId: z.string().trim().regex(/^[\w.-]+@[\w.-]+$/, "UPI ID must look like name@bank").optional().or(z.literal("")),
    isPrimary: z.boolean().default(false),
  })
  .refine((a) => Boolean(a.accountNumber || a.upiId), { message: "Enter an account number or a UPI ID", path: ["accountNumber"] });

export type BankAccountInput = z.infer<typeof bankAccountSchema>;

/** What the form's blanks mean in the database: nothing. */
export function bankAccountData(input: BankAccountInput) {
  const blank = (s: string | undefined) => (s && s.length > 0 ? s : null);
  return {
    label: input.label,
    accountHolderName: blank(input.accountHolderName),
    bankName: blank(input.bankName),
    branchName: blank(input.branchName),
    accountNumber: blank(input.accountNumber),
    ifsc: blank(input.ifsc),
    swift: blank(input.swift),
    upiId: blank(input.upiId),
  };
}

/** The account as a list or a picker shows it to somebody who may not see the number: its last four. */
export function maskedAccountNumber(accountNumber: string | null): string | null {
  if (!accountNumber) return null;
  return accountNumber.length <= 4 ? accountNumber : `•••• ${accountNumber.slice(-4)}`;
}
