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

/** An optional money field: blank is "not given", anything else must be a number of rupees. */
const optionalMoney = z.preprocess(
  (v) => (v === "" || v === undefined || v === null ? undefined : Number(v)),
  z.number({ error: "Enter the price as a number of rupees" }).nonnegative("A price can't be negative").optional(),
);

/**
 * The price a salesperson got from a distributor, and where from — optional on an order, and all of a
 * piece: details without a price say nothing, and a price without its distributor can't be checked.
 * `quoteVendorId` is a vendor in the CRM; `quoteVendorName` is free text for one that isn't.
 */
const quoteFields = {
  quotedPurchasePrice: optionalMoney,
  quoteVendorId: z.string().optional().or(z.literal("")),
  quoteVendorName: z.string().trim().max(200).optional().or(z.literal("")),
  quoteContact: z.string().trim().max(200).optional().or(z.literal("")),
  /** `yyyy-mm-dd`; blank is today (in India). */
  quotedOn: z.string().trim().optional().or(z.literal("")),
  quoteRemarks: z.string().trim().max(1000).optional().or(z.literal("")),
};

type QuoteInput = {
  quotedPurchasePrice?: number;
  quoteVendorId?: string;
  quoteVendorName?: string;
  quoteContact?: string;
  quotedOn?: string;
  quoteRemarks?: string;
};

function refineQuote(val: QuoteInput, ctx: z.RefinementCtx) {
  const hasDetails = !!(val.quoteVendorId || val.quoteVendorName || val.quoteContact || val.quoteRemarks || val.quotedOn);
  if (val.quotedPurchasePrice === undefined) {
    if (hasDetails) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter the distributor's price per unit, or clear the distributor details",
        path: ["quotedPurchasePrice"],
      });
    }
    return;
  }
  if (!val.quoteVendorId && !val.quoteVendorName) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Say which distributor gave this price", path: ["quoteVendorName"] });
  }
}

export const dealRegStatusValues = ["APPLIED", "APPROVED", "REJECTED"] as const;

/**
 * The deal registration with the OEM and the upfront deal price (owner, 1 Oct 2026) — optional, and
 * recorded by whoever punches the order: nothing waits on them. A number or a date says nothing
 * without where the registration stands.
 */
const dealFields = {
  dealRegStatus: z.enum(dealRegStatusValues).optional().or(z.literal("")),
  dealRegNumber: z.string().trim().max(100).optional().or(z.literal("")),
  /** `yyyy-mm-dd`. */
  dealRegValidTo: z.string().trim().optional().or(z.literal("")),
  dealPrice: optionalMoney,
};

type DealInput = { dealRegStatus?: string; dealRegNumber?: string; dealRegValidTo?: string };

function refineDeal(val: DealInput, ctx: z.RefinementCtx) {
  if (!val.dealRegStatus && (val.dealRegNumber || val.dealRegValidTo)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Say where the deal registration stands", path: ["dealRegStatus"] });
  }
  if (val.dealRegValidTo && !/^\d{4}-\d{2}-\d{2}$/.test(val.dealRegValidTo)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter the date the registration runs to", path: ["dealRegValidTo"] });
  }
}

export const rebateBasisValues = ["PURCHASE_VALUE", "SALE_VALUE", "AMOUNT"] as const;
export const rebatePayerValues = ["DISTRIBUTOR", "OEM"] as const;
export const rebateSettlementValues = ["CREDIT_NOTE", "PAYOUT"] as const;

/**
 * One backend rebate on an order: a percentage of what we pay or sell for, or a fixed amount; who pays
 * it and how. Entered only by somebody holding `rebates.view` — the action refuses it from anybody else.
 */
export const orderRebateInputSchema = z
  .object({
    programmeId: z.string().optional().or(z.literal("")),
    basis: z.enum(rebateBasisValues),
    /** Percent for the two percentage bases; rupees for AMOUNT. */
    value: z.preprocess(
      (v) => (v === "" || v === undefined || v === null ? undefined : Number(v)),
      z.number({ error: "Enter the rebate" }).positive("A rebate is more than nothing"),
    ),
    payer: z.enum(rebatePayerValues),
    payerCompanyId: z.string().optional().or(z.literal("")),
    settlement: z.enum(rebateSettlementValues),
    note: z.string().trim().max(500).optional().or(z.literal("")),
  })
  .superRefine((val, ctx) => {
    if (val.basis !== "AMOUNT" && val.value > 100) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A percentage is 100 at most", path: ["value"] });
    }
  });

export type OrderRebateInput = z.infer<typeof orderRebateInputSchema>;

/** How the salesperson hands the order to purchase: now (the default, as every order always went), held, or on a day. */
export const handoffValues = ["NOW", "HOLD", "SCHEDULE"] as const;

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
  handoff: z.enum(handoffValues).default("NOW"),
  /** The go-ahead day, `yyyy-mm-dd`, for SCHEDULE — checked against India's today in the action. */
  releaseOn: z.string().trim().optional().or(z.literal("")),
  ...quoteFields,
  ...dealFields,
  /** Backend rebates — only from somebody holding `rebates.view`. */
  rebates: z.array(orderRebateInputSchema).max(5, "Five rebates on one order at most").default([]),
}).superRefine((val, ctx) => {
  if (val.handoff === "SCHEDULE" && !val.releaseOn) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Choose the day it goes to purchase", path: ["releaseOn"] });
  }
  refineQuote(val, ctx);
  refineDeal(val, ctx);
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
  /** Why purchase is paying more than the salesperson's distributor price — required when it is. */
  increaseReason: z.string().trim().max(1000).optional().or(z.literal("")),
});

/** The deal registration and deal price on an order already punched. Blank fields clear them. */
export const orderDealSchema = z
  .object({ orderId: z.string().min(1), ...dealFields })
  .superRefine((val, ctx) => refineDeal(val, ctx));

/** Adding or changing one backend rebate on an order. */
export const saveOrderRebateSchema = z.object({
  orderId: z.string().min(1),
  /** Present to change an existing one. */
  rebateId: z.string().optional().or(z.literal("")),
  rebate: orderRebateInputSchema,
});

/** Approving an order sold below cost — a manager, never on their own order. */
export const approveLossSchema = z.object({
  orderId: z.string().min(1),
  note: z.string().trim().min(5, "Say why this negative call is worth taking").max(1000),
  /** Approve up to this unit cost, when it is higher than any the order knows of. */
  upToCost: optionalMoney,
});

/** Adding, changing or removing the distributor price after the order was punched. A blank price removes it. */
export const orderQuoteSchema = z
  .object({ orderId: z.string().min(1), ...quoteFields })
  .superRefine((val, ctx) => refineQuote(val, ctx));
