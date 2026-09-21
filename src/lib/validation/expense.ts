import { z } from "zod";
import { expenseCategoryValues, expensePaymentModeValues, expenseStatusValues } from "@/lib/expenses";

const money = (message: string) =>
  z.preprocess((v) => (v === "" || v === undefined || v === null ? undefined : Number(v)), z.number().positive(message));

export const createExpenseSchema = z.object({
  category: z.enum(expenseCategoryValues).default("TRAVEL"),
  amount: money("Amount must be greater than 0"),
  taxAmount: z
    .preprocess((v) => (v === "" || v === undefined || v === null ? undefined : Number(v)), z.number().min(0).optional()),
  spentOn: z.string().min(1, "Pick the date it was spent"),
  description: z.string().trim().min(1, "Say what this was for"),
  paymentMode: z.enum(expensePaymentModeValues).default("CASH"),
  reimbursable: z.boolean().default(true),
  visitId: z.string().optional().or(z.literal("")),
  companyId: z.string().optional().or(z.literal("")),
  leadId: z.string().optional().or(z.literal("")),
  receiptDataUrl: z.string().optional().or(z.literal("")),
  receiptName: z.string().trim().optional().or(z.literal("")),
  /** Blank means the claim is the current user's; only an admin can raise one on someone's behalf. */
  userId: z.string().optional().or(z.literal("")),
  /** Submit straight away rather than parking it in draft. */
  submit: z.boolean().default(false),
});

export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

export const updateExpenseSchema = createExpenseSchema.omit({ submit: true }).extend({
  id: z.string().min(1),
});

export const decideExpenseSchema = z.object({
  id: z.string().min(1),
  approved: z.boolean(),
  /** A rejection has to say why — otherwise the claimant has nothing to act on. */
  note: z.string().trim().optional().or(z.literal("")),
});

export const reimburseExpenseSchema = z.object({
  expenseIds: z.array(z.string().min(1)).min(1, "Select at least one expense"),
  reimbursementRef: z.string().trim().optional().or(z.literal("")),
  reimbursedOn: z.string().optional().or(z.literal("")),
});

export const expenseFilterSchema = z.object({
  status: z.enum(expenseStatusValues).optional(),
  category: z.enum(expenseCategoryValues).optional(),
  userId: z.string().optional(),
  companyId: z.string().optional(),
  reimbursable: z.enum(["yes", "no"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  search: z.string().optional(),
});
