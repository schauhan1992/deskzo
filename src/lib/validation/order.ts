import type { OrderBusinessType } from "@prisma/client";
import { z } from "zod";

export const orderStatusValues = [
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "PROCESSING",
  "FULFILLED",
  "CANCELLED",
] as const;

/**
 * The types a blank order form offers.
 *
 * ADDON is deliberately absent: extra seats are raised from the subscription they attach to, where
 * the term to co-terminate with and the price to pro-rate against are already known. Offering it
 * here would invite an addon with no parent, which is a row nothing can renew.
 */
export const orderBusinessTypeValues = ["NEW", "RENEWAL", "NEW_TO_US_RENEWAL"] as const;

export const orderBusinessTypeLabels: Record<OrderBusinessType, string> = {
  NEW: "New business",
  RENEWAL: "Renewal",
  NEW_TO_US_RENEWAL: "New to us (renewal elsewhere)",
  ADDON: "Added seats",
};

export const orderExpenseTypeValues = ["COMMISSION", "FREIGHT", "INSTALLATION", "OTHER"] as const;

export const orderExpenseTypeLabels: Record<(typeof orderExpenseTypeValues)[number], string> = {
  COMMISSION: "Commission",
  FREIGHT: "Freight",
  INSTALLATION: "Installation",
  OTHER: "Other",
};

const orderExpenseInputSchema = z
  .object({
    type: z.enum(orderExpenseTypeValues),
    amount: z.preprocess((v) => (v === "" || v === undefined ? undefined : Number(v)), z.number().positive("Amount must be greater than 0")),
    notes: z.string().trim().optional().or(z.literal("")),
    /** Who this expense is paid to — required for COMMISSION so it can be tracked against a Commission Party. */
    payeeCompanyId: z.string().optional().or(z.literal("")),
    /** Which of the payee's accounts (see `CommissionPartyAccount`) this was actually paid into — optional even when a payee is set. */
    payeeAccountId: z.string().optional().or(z.literal("")),
  })
  .superRefine((val, ctx) => {
    if (val.type === "COMMISSION" && !val.payeeCompanyId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Select who this commission is paid to", path: ["payeeCompanyId"] });
    }
  })
  // A payee only means anything for a commission. The form keeps a row's payee in state after the
  // type is switched away from COMMISSION (react-hook-form doesn't unregister hidden fields), so
  // drop it here rather than recording a freight line as "paid to" a commission party.
  .transform((val) => ({
    ...val,
    payeeCompanyId: val.type === "COMMISSION" ? val.payeeCompanyId : "",
    payeeAccountId: val.type === "COMMISSION" ? val.payeeAccountId : "",
  }));

export const createOrderSchema = z.object({
  companyId: z.string().min(1, "Select a customer"),
  locationId: z.string().min(1, "Select a location"),
  itemId: z.string().min(1, "Select a product"),
  quantity: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? 1 : Number(v)),
    z.number().int().positive("Quantity must be at least 1"),
  ),
  unitPrice: z.preprocess((v) => (v === "" || v === undefined ? undefined : Number(v)), z.number().positive().optional()),
  businessType: z.enum(orderBusinessTypeValues).default("NEW"),
  /** Only meaningful when the customer is a reseller — which of their end customers this order is for. */
  endCustomerId: z.string().optional().or(z.literal("")),
  poNumber: z.string().trim().optional().or(z.literal("")),
  proposalId: z.string().optional().or(z.literal("")),
  paymentTerms: z.enum(["DUE_ON_RECEIPT", "ADVANCE", "NET_15", "NET_30", "NET_45", "NET_60"]).optional().or(z.literal("")),
  /** Why this order gets longer terms than the customer's credit rating supports — see src/lib/credit/guard.ts. */
  creditOverrideReason: z.string().trim().max(500).optional().or(z.literal("")),
  startDate: z.string().optional().or(z.literal("")),
  endDate: z.string().optional().or(z.literal("")),
  notes: z.string().trim().optional().or(z.literal("")),
  watcherUserIds: z.array(z.string()).default([]),
  expenses: z.array(orderExpenseInputSchema).default([]),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const approveOrderSchema = z.object({
  orderId: z.string().min(1),
  approved: z.boolean(),
  notes: z.string().trim().optional().or(z.literal("")),
  /** Required to approve an order with a credit concern — longer terms than rated, or over the limit. */
  creditOverrideReason: z.string().trim().max(500).optional().or(z.literal("")),
});

export const processOrderSchema = z.object({
  orderId: z.string().min(1),
  vendorId: z.string().min(1, "Select which vendor this was purchased from"),
  purchasePrice: z.preprocess((v) => (v === "" || v === undefined ? undefined : Number(v)), z.number().positive("Purchase price must be greater than 0")),
  ourPoNumber: z.string().trim().optional().or(z.literal("")),
});
