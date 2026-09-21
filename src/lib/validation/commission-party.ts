import { z } from "zod";
import { panField, ifscField } from "@/lib/validation/company";

/** One of a commission party's payee accounts (PAN/bank/UPI) — see the `CommissionPartyAccount` schema doc-comment for why this is a list, not a single set of fields. */
export const commissionPartyAccountSchema = z.object({
  label: z.string().trim().min(1, "A short label is required, e.g. \"Primary\" or the account holder's name"),
  accountHolderName: z.string().trim().optional().or(z.literal("")),
  panNumber: panField,
  bankAccountNumber: z.string().trim().optional().or(z.literal("")),
  bankIfsc: ifscField,
  bankName: z.string().trim().optional().or(z.literal("")),
  upiId: z.string().trim().optional().or(z.literal("")),
  isDefault: z.boolean().default(false),
});

export type CommissionPartyAccountInput = z.infer<typeof commissionPartyAccountSchema>;

export const linkCommissionPartySchema = z.object({
  commissionPartyId: z.string().min(1),
  companyId: z.string().min(1, "Select a company to link"),
});
