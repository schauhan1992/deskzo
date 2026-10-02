import type { z } from "zod";
import type { FieldErrors, FieldPath, UseFormReturn } from "react-hook-form";
import type { createOrderSchema, CreateOrderInput } from "@/lib/validation/order";
import type { CreditRating, TermsKey } from "@/lib/credit/engine";

/** The order form's values as typed — what react-hook-form holds before the schema has read them. */
export type PunchFormValues = z.input<typeof createOrderSchema>;

/** The form as each section of it is handed it. */
export type PunchForm = UseFormReturn<PunchFormValues, unknown, CreateOrderInput>;

export type PunchErrors = FieldErrors<PunchFormValues>;

export type LocationOption = { id: string; label: string; isPrimary: boolean };
export type ProposalOption = { id: string; status: string; validUntil: Date | string | null; lead: { title: string } };
export type EndCustomerOption = { id: string; name: string };
export type PersonOption = { id: string; name: string };
/** `linked` is the old way of marking a party tied to the customer; the customer's context says so now. */
export type CommissionPartyOption = { id: string; name: string; linked?: boolean };
export type VendorOption = { id: string; name: string };
/**
 * What the form reads of the customer's credit. `punchCustomerContext` answers with all of this and more;
 * spelt out here rather than imported from the action, which this file — shared, and not a client
 * file — would otherwise appear to call (scripts/check-module-guards.ts reads imports, not types).
 */
export type CreditSnapshot = {
  rating: CreditRating;
  score: number | null;
  recommendedTerms: TermsKey;
  limit: number;
  outstanding: number;
  defaultTerms: TermsKey;
  canOverride: boolean;
} | null;

/**
 * What the form knows about the chosen customer — `punchCustomerContext`'s answer, loosened only so the
 * three separate lists an older caller may still pass (locations, proposals, end customers) fit it too.
 */
export type CustomerContext = {
  locations: LocationOption[];
  proposals: ProposalOption[];
  linkedPartyIds: string[];
  endCustomers: EndCustomerOption[];
  credit: CreditSnapshot;
};

/** The folded sections, each a `<details>` that opens itself for a validation error inside it. */
export type FoldKey = "cost" | "rebates" | "extras" | "notes";

/** Which form fields live in each folded section — so a failed submit can open the one holding the error. */
export const FOLD_FIELDS: Record<FoldKey, readonly (keyof PunchFormValues)[]> = {
  cost: [
    "quotedPurchasePrice",
    "quoteVendorId",
    "quoteVendorName",
    "quoteContact",
    "quotedOn",
    "quoteRemarks",
    "dealRegStatus",
    "dealRegNumber",
    "dealRegValidTo",
    "dealPrice",
  ],
  rebates: ["rebates"],
  extras: ["expenses", "watcherUserIds"],
  notes: ["notes", "proposalId"],
};

/** The folded sections holding an error, in `errors` as react-hook-form reports them. */
export function foldsWithErrors(errors: PunchErrors): FoldKey[] {
  return (Object.keys(FOLD_FIELDS) as FoldKey[]).filter((key) => FOLD_FIELDS[key].some((name) => errors[name] !== undefined));
}

/** Whether a field — or a field of one of its rows, `expenses.2.amount` — sits in a folded section. */
export function inFold(path: string): boolean {
  const name = path.split(".")[0] as keyof PunchFormValues;
  return (Object.keys(FOLD_FIELDS) as FoldKey[]).some((key) => FOLD_FIELDS[key].includes(name));
}

/**
 * The form's fields in the order they appear on the page, and those of one rebate or expense row. A failed
 * submit focuses the first of these with an error. react-hook-form's own focusing goes by the order the
 * fields registered in, which is not the page's: a section's plain fields register before its pickers, and
 * a field that appears on a choice — "Goes to purchase on" — registers after every folded section.
 */
const PAGE_ORDER = [
  "companyId",
  "endCustomerId",
  "locationId",
  "poNumber",
  "itemId",
  "quantity",
  "unitPrice",
  "startDate",
  "endDate",
  "businessType",
  "paymentTerms",
  "creditOverrideReason",
  "handoff",
  "releaseOn",
  "quotedPurchasePrice",
  "quotedOn",
  "quoteVendorId",
  "quoteVendorName",
  "quoteContact",
  "quoteRemarks",
  "dealRegStatus",
  "dealRegNumber",
  "dealRegValidTo",
  "dealPrice",
  "rebates",
  "expenses",
  "watcherUserIds",
  "notes",
  "proposalId",
  // The workspace's own fields (src/lib/custom-fields) sit between the hand-off and the folded sections,
  // but they are kept beside the form rather than in it: checked by `missingRequired` and focused by the
  // form itself (new-order-form.tsx), so react-hook-form never reports an error here. Placed, all the same.
  "customFields",
] as const satisfies readonly (keyof PunchFormValues)[];
// Every field has its place: this fails to compile if one is added to the schema and not here.
type Assert<T extends true> = T;
export type EveryFieldPlaced = Assert<[Exclude<keyof PunchFormValues, (typeof PAGE_ORDER)[number]>] extends [never] ? true : false>;
const ROW_ORDER = {
  rebates: ["basis", "value", "payer", "payerCompanyId", "settlement", "note"],
  expenses: ["type", "amount", "notes", "payeeCompanyId", "payeeAccountId"],
} as const;

/** The first field on the page holding an error, as a path `setFocus` takes — or null when none can take focus. */
export function firstErrorField(errors: PunchErrors): FieldPath<PunchFormValues> | null {
  for (const name of PAGE_ORDER) {
    if (!errors[name]) continue;
    if (name !== "rebates" && name !== "expenses") return name;
    // A row's errors sit at their row's index; an error about the list as a whole has no field to focus.
    const rows = errors[name];
    if (!Array.isArray(rows)) continue;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index] as Record<string, unknown> | undefined;
      if (!row) continue;
      const key = ROW_ORDER[name].find((k) => row[k] !== undefined);
      if (key) return `${name}.${index}.${key}` as FieldPath<PunchFormValues>;
    }
  }
  return null;
}

/** A field's error, wired to the field: the id `aria-describedby` points at, and the attributes that mark it invalid. */
export function invalidProps(id: string, message: string | undefined) {
  return message ? { "aria-invalid": true as const, "aria-describedby": `${id}-error` } : {};
}
