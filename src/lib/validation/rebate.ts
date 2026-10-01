import { z } from "zod";
import { rebatePayerValues, rebateSettlementValues } from "@/lib/validation/order";

const optionalId = z.string().optional().or(z.literal(""));
const optionalDay = z
  .string()
  .trim()
  .optional()
  .or(z.literal(""))
  .refine((v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v), "Enter a date");
/** GST on a credit note: blank is none. */
const tax = z.preprocess((v) => (v === "" || v === undefined || v === null ? 0 : Number(v)), z.number({ error: "Enter the tax as a number" }).nonnegative("Tax can't be negative"));
const money = (message: string) =>
  z.preprocess((v) => (v === "" || v === undefined || v === null ? undefined : Number(v)), z.number({ error: message }));

/**
 * A standing rebate programme with an OEM, perhaps through one distributor. A percentage of what we pay
 * or of what we sell for — a fixed amount belongs on an order, not on a programme.
 */
export const rebateProgrammeSchema = z
  .object({
    id: optionalId,
    name: z.string().trim().min(2, "Name the programme — \"Adobe VIP deal registration\"").max(120),
    brandId: optionalId,
    vendorId: optionalId,
    basis: z.enum(["PURCHASE_VALUE", "SALE_VALUE"]),
    rate: money("Enter the rebate as a percentage").pipe(z.number().positive("A rebate is more than nothing").max(100, "A percentage is 100 at most")),
    needsDealRegistration: z.boolean().default(false),
    payer: z.enum(rebatePayerValues),
    settlement: z.enum(rebateSettlementValues),
    validFrom: optionalDay,
    validTo: optionalDay,
    active: z.boolean().default(true),
    notes: z.string().trim().max(1000).optional().or(z.literal("")),
  })
  .superRefine((val, ctx) => {
    if (val.validFrom && val.validTo && val.validTo < val.validFrom) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "It can't end before it starts", path: ["validTo"] });
    }
  });

export const writeOffRebateSchema = z.object({
  rebateId: z.string().min(1),
  reason: z.string().trim().min(5, "Say why it won't come").max(500),
});

const allocationSchema = z.object({
  orderRebateId: z.string().min(1),
  amount: money("Enter an amount").pipe(z.number().positive("Enter an amount")),
});
const applicationSchema = z.object({
  billId: z.string().min(1),
  amount: money("Enter an amount").pipe(z.number().positive("Enter an amount")),
});

/**
 * A credit note or a payout from a distributor or an OEM: before GST, the GST on it if any, and — all
 * optional, and possible later — what it settles: orders' expected rebates and, for a credit note,
 * the issuer's open bills.
 */
export const vendorCreditSchema = z
  .object({
    vendorId: z.string().min(1, "Choose who it is from"),
    form: z.enum(rebateSettlementValues),
    kind: z.enum(["REBATE", "PRICE_DIFFERENCE", "OTHER"]).default("REBATE"),
    reference: z.string().trim().min(1, "Enter its number, or the payment's reference").max(100),
    date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter its date"),
    taxableAmount: money("Enter the amount before GST").pipe(z.number().positive("Enter the amount before GST")),
    cgstAmount: tax,
    sgstAmount: tax,
    igstAmount: tax,
    bankAccountId: optionalId,
    notes: z.string().trim().max(1000).optional().or(z.literal("")),
    allocations: z.array(allocationSchema).max(200).default([]),
    applications: z.array(applicationSchema).max(100).default([]),
  })
  .superRefine((val, ctx) => {
    if (val.igstAmount > 0 && (val.cgstAmount > 0 || val.sgstAmount > 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Either IGST, or CGST and SGST — not both", path: ["igstAmount"] });
    }
    if (Math.round(val.cgstAmount * 100) !== Math.round(val.sgstAmount * 100)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "CGST and SGST are always equal", path: ["sgstAmount"] });
    }
    if (val.form === "PAYOUT" && val.applications.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Money paid into the bank isn't set against bills — only a credit note is", path: ["applications"] });
    }
  });

/** More of a vendor credit set against orders' rebates or the issuer's bills, after it was recorded. */
export const settleVendorCreditSchema = z.object({
  vendorCreditId: z.string().min(1),
  allocations: z.array(allocationSchema).max(200).default([]),
  applications: z.array(applicationSchema).max(100).default([]),
});

export const cancelVendorCreditSchema = z.object({
  vendorCreditId: z.string().min(1),
  reason: z.string().trim().min(5, "Say why it is cancelled").max(500),
});
