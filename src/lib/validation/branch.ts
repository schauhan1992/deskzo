import { z } from "zod";
import { tradeDocumentTypeValues } from "@/lib/trade-documents";
import { GSTIN_PATTERN } from "@/lib/gst-engine";
import { postalCodeField, refinePostalCode } from "@/lib/geo/postal";

const optionalText = z.string().trim().optional().or(z.literal(""));

/**
 * One of this company's GST registrations. The pattern is checked here; the checksum and the PAN are
 * checked by the action, so its message can name the PAN the GSTIN belongs to.
 */
export const gstRegistrationSchema = z.object({
  id: z.string().optional().or(z.literal("")),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => GSTIN_PATTERN.test(v), "That doesn't look like a valid GSTIN"),
  /** What `{GST}` prints in a number prefix — MH, KA, TG… */
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,4}$/, "A registration code is 1–4 letters or digits"),
});
export type GstRegistrationInput = z.infer<typeof gstRegistrationSchema>;

const branchAddressFields = ["addressLine1", "addressLine2", "city", "state", "pincode"] as const;
const branchAddressRequired = ["addressLine1", "city", "state", "pincode"] as const;

/**
 * A place of business. Anything left blank is the organisation's; the address is taken whole, so it
 * is all or nothing — half a branch address printed over the rest of the registered office is
 * nobody's address. Whether a branch may leave it blank at all (only the head office may) is the
 * action's to decide: it knows which branch is the head office.
 */
export const branchSchema = z
  .object({
    id: z.string().optional().or(z.literal("")),
    name: z.string().trim().min(1, "Give the branch a name").max(80, "Keep the name under 80 characters"),
    /** `{BR}` in number prefixes, and the value in list columns. */
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{1,6}$/, "A branch code is 1–6 letters or digits"),
    /** Blank = no registration: a liaison office, or a company not registered at all. */
    gstRegistrationId: z.string().optional().or(z.literal("")),
    addressLine1: optionalText,
    addressLine2: optionalText,
    city: optionalText,
    state: optionalText,
    // Six digits in India, any postal code elsewhere — the rule is `refinePostalCode`, on the object.
    pincode: postalCodeField,
    /** Blank means India, as everywhere. */
    country: z.string().trim().max(60).optional().or(z.literal("")),
    email: z.string().trim().email("Enter a valid email").optional().or(z.literal("")),
    phone: optionalText,
    bankName: optionalText,
    bankAccountNumber: optionalText,
    bankIfsc: optionalText,
    bankBranch: optionalText,
    upiId: optionalText,
    invoiceTerms: optionalText,
    invoiceNotes: optionalText,
  })
  .superRefine(refinePostalCode)
  .superRefine((value, ctx) => {
    const started = branchAddressFields.some((field) => value[field]);
    const missing = branchAddressRequired.find((field) => !value[field]);
    if (started && missing) {
      ctx.addIssue({ code: "custom", path: [missing], message: "Fill in the whole address, or leave it all blank to use the registered office." });
    }
  });
export type BranchInput = z.infer<typeof branchSchema>;

/**
 * One registration's IRP connection. Mirrors the organisation's old form: blank secrets mean "keep
 * what's stored" (the form is never sent the decrypted value), and a blank provider is "not set up".
 */
export const registrationEInvoiceSchema = z.object({
  gstRegistrationId: z.string().min(1, "Choose a registration"),
  provider: z.enum(["mock", "nic_sandbox", "nic_production", ""]),
  username: optionalText,
  password: z.string().optional().or(z.literal("")),
  clientId: optionalText,
  clientSecret: z.string().optional().or(z.literal("")),
});
export type RegistrationEInvoiceInput = z.infer<typeof registrationEInvoiceSchema>;

/** Every numbered type, the delivery challan included — it is raised from a consignment, but numbered like the rest. */
const numberedTypeValues = [...tradeDocumentTypeValues, "DELIVERY_CHALLAN"] as const;

/** A blank field is its default, as on the company series (`documentNumberSettingSchema`). */
const blankIs = (fallback: number) => (v: unknown) => (v === "" || v === undefined || v === null ? fallback : Number(v));

/** One registration's or one branch's series of a type. Exactly one owner, and `ownerKey`, if sent, is that owner. */
export const documentSeriesSchema = z
  .object({
    docType: z.enum(numberedTypeValues),
    ownerKey: z.string().optional().or(z.literal("")),
    gstRegistrationId: z.string().optional().or(z.literal("")),
    branchId: z.string().optional().or(z.literal("")),
    prefix: z.string().max(40).optional().or(z.literal("")),
    nextNumber: z.preprocess(blankIs(1), z.number().int().min(1, "The next number must be at least 1")),
    padding: z.preprocess(blankIs(4), z.number().int().min(1).max(10)),
  })
  .superRefine((value, ctx) => {
    const owners = [value.gstRegistrationId, value.branchId].filter(Boolean);
    if (owners.length !== 1) {
      ctx.addIssue({ code: "custom", path: ["gstRegistrationId"], message: "A series belongs to one registration or one branch." });
      return;
    }
    if (value.ownerKey && value.ownerKey !== owners[0]) {
      ctx.addIssue({ code: "custom", path: ["ownerKey"], message: "That series belongs to a different owner." });
    }
  });
export type DocumentSeriesInput = z.infer<typeof documentSeriesSchema>;

/** Whose series a type counts in (spec §6.6). */
export const numberingScopeSchema = z.object({
  docType: z.enum(numberedTypeValues),
  scope: z.enum(["COMPANY", "REGISTRATION", "BRANCH"]),
});
export type NumberingScopeInput = z.infer<typeof numberingScopeSchema>;
