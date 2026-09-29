import { z } from "zod";
import { tradeDocumentTypeValues } from "@/lib/trade-documents";
import { GST_STATE_CODES, GSTIN_PATTERN } from "@/lib/gst-engine";
import { gstTreatmentValues } from "@/lib/gst";
import { BASE_CURRENCY, CURRENCY_CODES } from "@/lib/currency";
import { postalCodeField, refinePostalCode } from "@/lib/geo/postal";
import { servicePeriodProblem } from "@/lib/documents/service-period";

const number = (fallback?: number) =>
  z.preprocess((v) => (v === "" || v === undefined || v === null ? fallback : Number(v)), z.number());

export const tradeDocumentLineSchema = z.object({
  /** Kept when the line came from the catalogue, so we can trace an invoice line back to a SKU. */
  itemId: z.string().optional().or(z.literal("")),
  /** Set when this line bills an existing order. */
  companyProductId: z.string().optional().or(z.literal("")),
  name: z.string().trim().min(1, "Every line needs an item"),
  /** Free text under the name — optional, because most lines don't need one. */
  description: z.string().trim().optional().or(z.literal("")),
  hsnCode: z.string().trim().optional().or(z.literal("")),
  unit: z.string().trim().optional().or(z.literal("")),
  quantity: number(1).pipe(z.number().positive("Quantity must be greater than 0")),
  unitPrice: number(0).pipe(z.number().min(0, "Unit price can't be negative")),
  discountMode: z.enum(["PERCENT", "AMOUNT"]).default("PERCENT"),
  discountValue: number(0).pipe(z.number().min(0, "A discount can't be negative")),
  taxRatePercent: number(0).pipe(z.number().min(0).max(100, "Tax rate can't exceed 100%")),
  /**
   * The period the line pays for, as Indian calendar days (`yyyy-mm-dd`), both inclusive. Both or
   * neither; the rules are checked on the document (`servicePeriodProblem`) so the message can say
   * which line. See src/lib/documents/service-period.ts.
   */
  servicePeriodFrom: z.string().trim().optional().or(z.literal("")),
  servicePeriodTo: z.string().trim().optional().or(z.literal("")),
  /**
   * The project billing stage this line bills. Only "Raise invoice" sets it; the form carries it
   * through an edit, and the action keeps it only while the stage still points at this document.
   */
  billingMilestoneId: z.string().optional().or(z.literal("")),
});

export type TradeDocumentLineInput = z.infer<typeof tradeDocumentLineSchema>;

const stateCode = z
  .string()
  .trim()
  .refine((v) => v === "" || v in GST_STATE_CODES, "That isn't a valid GST state code")
  .optional()
  .or(z.literal(""));

const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .refine((v) => v === "" || GSTIN_PATTERN.test(v), "That doesn't look like a valid GSTIN")
  .optional()
  .or(z.literal(""));

/** The treatments that mean the party is GST-registered, and so must carry a GSTIN. */
export const registeredTreatments = ["REGISTERED_REGULAR", "REGISTERED_COMPOSITION", "SEZ", "DEEMED_EXPORT"] as const;

const addressFields = {
  attention: z.string().trim().optional().or(z.literal("")),
  line1: z.string().trim().optional().or(z.literal("")),
  line2: z.string().trim().optional().or(z.literal("")),
  city: z.string().trim().optional().or(z.literal("")),
  state: z.string().trim().optional().or(z.literal("")),
  stateCode,
  // Six digits in India, any postal code elsewhere — the rule is `refinePostalCode`, on the object.
  pincode: postalCodeField,
  country: z.string().trim().optional().or(z.literal("")),
  phone: z.string().trim().optional().or(z.literal("")),
};

export const documentAddressSchema = z.object(addressFields).superRefine(refinePostalCode);
export type DocumentAddressInput = z.infer<typeof documentAddressSchema>;

export const tradeDocumentSchema = z
  .object({
    docType: z.enum(tradeDocumentTypeValues),
    companyId: z.string().min(1, "Select a party"),
    locationId: z.string().optional().or(z.literal("")),
    /** Blank asks the server to generate one from the type's numbering preference. */
    docNumber: z.string().trim().max(64).optional().or(z.literal("")),
    /**
     * The branch it is raised from (on a purchase, bought by). Blank = the user's home branch, else the
     * head office; a credit note always takes its invoice's.
     */
    branchId: z.string().optional().or(z.literal("")),
    placeOfSupplyCode: stateCode,
    gstTreatment: z.enum(gstTreatmentValues).default("UNREGISTERED"),
    /**
     * The *party's* GSTIN, whichever side of the document they are on. The name is the payload's, kept
     * for compatibility: on a sale it is stored as `buyerGstin`, on a purchase as `sellerGstin` — ours
     * takes the other column.
     */
    buyerGstin: gstin,
    reverseCharge: z.boolean().default(false),
    /** What the customer is quoted in. The books stay in rupees whatever this says. */
    currency: z.enum(CURRENCY_CODES as unknown as [string, ...string[]]).default(BASE_CURRENCY),
    /**
     * Rupees per unit of `currency`, as agreed on the day.
     *
     * Capped rather than left open: a rate is a small number, and a fat-fingered 8300 instead of
     * 83 posts a lakh of revenue as a crore. The ceiling is generous enough for any real pair and
     * tight enough to catch a slipped decimal.
     */
    exchangeRate: z.coerce.number().positive("The rate must be more than zero").max(100000).default(1),
    issueDate: z.string().min(1, "Pick a date"),
    dueDate: z.string().optional().or(z.literal("")),
    validUntil: z.string().optional().or(z.literal("")),
    reference: z.string().trim().max(120).optional().or(z.literal("")),
    /** Blank falls back to the company's owner, so a document is never left without one. */
    salespersonId: z.string().optional().or(z.literal("")),
    notes: z.string().trim().optional().or(z.literal("")),
    terms: z.string().trim().optional().or(z.literal("")),

    dispatchFromAddress: z.string().trim().optional().or(z.literal("")),
    billing: documentAddressSchema,
    shippingSameAsBilling: z.boolean().default(true),
    shipping: documentAddressSchema,
    shippingGstin: gstin,

    shippingCharge: number(0).pipe(z.number().min(0)),
    shippingTaxRatePercent: number(0).pipe(z.number().min(0).max(100)),
    withholdingMode: z.enum(["NONE", "TDS", "TCS"]).default("NONE"),
    withholdingSection: z.string().trim().max(20).optional().or(z.literal("")),
    withholdingRatePercent: number(0).pipe(z.number().min(0).max(100)),
    adjustmentLabel: z.string().trim().max(40).optional().or(z.literal("")),
    adjustment: number(0),

    /** Proposal → proforma → invoice, or PO → bill: where this document was converted from. */
    sourceDocumentId: z.string().optional().or(z.literal("")),
    /** The deal this was raised from, when it started on a lead rather than against the account. */
    leadId: z.string().optional().or(z.literal("")),
    /** The invoice a credit note reduces. */
    againstDocumentId: z.string().optional().or(z.literal("")),
    lines: z.array(tradeDocumentLineSchema).min(1, "Add at least one line"),
  })
  .superRefine((val, ctx) => {
    // A registered party without a GSTIN can't be invoiced correctly — the buyer can't claim input
    // credit, and the e-invoice portal rejects it outright.
    if (val.currency === BASE_CURRENCY && Number(val.exchangeRate) !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["exchangeRate"],
        message: "A rupee document has an exchange rate of 1.",
      });
    }

    if (registeredTreatments.includes(val.gstTreatment as (typeof registeredTreatments)[number]) && !val.buyerGstin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A GSTIN is required for a registered party.",
        path: ["buyerGstin"],
      });
    }
    if (val.withholdingMode !== "NONE" && !(val.withholdingRatePercent > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Enter the ${val.withholdingMode} rate.`,
        path: ["withholdingRatePercent"],
      });
    }
    // Named by line: "the service period ends before it starts" on a twelve-line invoice is a hunt.
    val.lines.forEach((line, index) => {
      const problem = servicePeriodProblem(line.servicePeriodFrom, line.servicePeriodTo);
      if (problem) {
        ctx.addIssue({
          code: "custom",
          path: ["lines", index, "servicePeriodTo"],
          message: `Line ${index + 1}: ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`,
        });
      }
    });
  });

export type TradeDocumentInput = z.infer<typeof tradeDocumentSchema>;

export const updateTradeDocumentSchema = z.intersection(
  tradeDocumentSchema,
  z.object({ id: z.string().min(1) }),
);

export const issueTradeDocumentSchema = z.object({
  id: z.string().min(1),
  /** Generate the IRN as part of issuing, rather than as a separate step afterwards. */
  generateEInvoice: z.boolean().default(false),
});

export const cancelEInvoiceSchema = z.object({
  id: z.string().min(1),
  reason: z.enum(["1", "2", "3", "4"]),
  remark: z.string().trim().min(1, "The portal requires a remark").max(100),
});

export const convertTradeDocumentSchema = z.object({
  id: z.string().min(1),
  target: z.enum(tradeDocumentTypeValues),
});

export const documentNumberSettingSchema = z.object({
  // Delivery challans are numbered too, though they are not in the document form's list of types —
  // leaving them out made every save of the challan row fail validation.
  docType: z.enum([...tradeDocumentTypeValues, "DELIVERY_CHALLAN"]),
  mode: z.enum(["AUTO", "MANUAL"]).default("AUTO"),
  prefix: z.string().max(40).optional().or(z.literal("")),
  nextNumber: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? 1 : Number(v)),
    z.number().int().min(1, "The next number must be at least 1"),
  ),
  padding: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? 4 : Number(v)),
    z.number().int().min(1).max(10),
  ),
});

export const organisationSettingsSchema = z.object({
  legalName: z.string().trim().min(1, "Your registered legal name is required"),
  tradeName: z.string().trim().optional().or(z.literal("")),
  gstin,
  pan: z.string().trim().max(10).optional().or(z.literal("")),
  cin: z.string().trim().max(21).optional().or(z.literal("")),
  addressLine1: z.string().trim().optional().or(z.literal("")),
  addressLine2: z.string().trim().optional().or(z.literal("")),
  city: z.string().trim().optional().or(z.literal("")),
  state: z.string().trim().optional().or(z.literal("")),
  stateCode,
  // Six digits in India, any postal code elsewhere — the rule is `refinePostalCode`, on the object.
  pincode: postalCodeField,
  country: z.string().trim().max(60).optional().or(z.literal("")),
  email: z.string().trim().email("Enter a valid email").optional().or(z.literal("")),
  phone: z.string().trim().optional().or(z.literal("")),
  bankName: z.string().trim().optional().or(z.literal("")),
  bankAccountNumber: z.string().trim().optional().or(z.literal("")),
  bankIfsc: z.string().trim().optional().or(z.literal("")),
  bankBranch: z.string().trim().optional().or(z.literal("")),
  upiId: z.string().trim().optional().or(z.literal("")),
  invoiceTerms: z.string().trim().optional().or(z.literal("")),
  invoiceNotes: z.string().trim().optional().or(z.literal("")),
  roundOffTotals: z.boolean().default(true),
})
  .superRefine(refinePostalCode)
  /**
   * The GST state code is the GSTIN's own first two digits, not a second opinion.
   *
   * It is the seller half of CGST + SGST against IGST, and the e-invoice portal rejects a document
   * whose seller state disagrees with the seller GSTIN. The form used to move the code whenever the
   * address state was changed — so choosing Haryana for a Maharashtra GSTIN quietly re-taxed every
   * invoice from the wrong state. A registration is in exactly one state; there is no correct
   * invoice where the two differ, so they are refused together rather than saved apart.
   */
  .superRefine((value, ctx) => {
    const prefix = value.gstin && GSTIN_PATTERN.test(value.gstin) ? value.gstin.slice(0, 2) : null;
    if (prefix && value.stateCode && value.stateCode !== prefix) {
      ctx.addIssue({
        code: "custom",
        path: ["stateCode"],
        message: `Your GSTIN is registered in ${GST_STATE_CODES[prefix] ?? prefix} (${prefix}) — the GST state code has to match it.`,
      });
    }
  });

/**
 * The e-invoicing switch and minimum value — entity-wide. `updateEInvoiceSettings` now reads only
 * `einvoiceEnabled` and `einvoiceMinValue`; the credential fields stay optional here so an older form
 * still parses, but credentials are saved per GST registration (`registrationEInvoiceSchema` in
 * src/lib/validation/branch.ts).
 */
export const einvoiceSettingsSchema = z.object({
  einvoiceEnabled: z.boolean().default(false),
  einvoiceProvider: z.enum(["mock", "nic_sandbox", "nic_production"]).default("mock"),
  einvoiceUsername: z.string().trim().optional().or(z.literal("")),
  /** Blank means "leave the stored secret alone" — the form never round-trips the decrypted value. */
  einvoicePassword: z.string().optional().or(z.literal("")),
  einvoiceClientId: z.string().trim().optional().or(z.literal("")),
  einvoiceClientSecret: z.string().optional().or(z.literal("")),
  einvoiceMinValue: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : Number(v)),
    z.number().min(0).optional(),
  ),
});

export const bulkUpdateTradeDocumentsSchema = z.object({
  documentIds: z.array(z.string().min(1)).min(1, "Select at least one document"),
  action: z.enum(["issue", "status", "delete"]),
  status: z.enum(["ACCEPTED", "REJECTED", "PAID", "CANCELLED", "EXPIRED"]).optional().or(z.literal("")),
});
