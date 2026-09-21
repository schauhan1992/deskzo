import { z } from "zod";
import { paymentMethodValues } from "@/lib/gst";

export const recordPaymentSchema = z.object({
  companyId: z.string().min(1, "Select a company"),
  amount: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : Number(v)),
    z.number().positive("Amount must be greater than 0"),
  ),
  paidOn: z.string().min(1, "Payment date is required"),
  method: z.enum(paymentMethodValues).default("BANK_TRANSFER"),
  reference: z.string().trim().optional().or(z.literal("")),
  notes: z.string().trim().optional().or(z.literal("")),
  allocateToOrderId: z.string().trim().optional().or(z.literal("")),
});

export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const allocatePaymentSchema = z.object({
  paymentId: z.string().min(1),
  companyProductId: z.string().min(1, "Select an order"),
  amount: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : Number(v)),
    z.number().positive("Amount must be greater than 0"),
  ),
});

export type AllocatePaymentInput = z.infer<typeof allocatePaymentSchema>;
