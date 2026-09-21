import { z } from "zod";
import { paymentMethodValues } from "@/lib/gst";

const money = (message: string) =>
  z.preprocess((v) => (v === "" || v === undefined || v === null ? undefined : Number(v)), z.number().positive(message));

export const recordInvoicePaymentSchema = z.object({
  invoiceId: z.string().min(1),
  amount: money("Enter an amount greater than 0"),
  paidOn: z.string().min(1, "Pick the date it was received"),
  method: z.enum(paymentMethodValues).default("BANK_TRANSFER"),
  reference: z.string().trim().optional().or(z.literal("")),
  notes: z.string().trim().optional().or(z.literal("")),
});

export const applyCreditNoteSchema = z.object({
  creditNoteId: z.string().min(1),
  invoiceId: z.string().min(1, "Pick the invoice to apply it to"),
  amount: money("Enter an amount greater than 0"),
});
