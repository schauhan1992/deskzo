/**
 * The shape the document form edits, before the GST engine and the database get involved. It lives
 * outside the form component because a server page builds the starting draft, and a server
 * component can't call a function exported from a "use client" module.
 *
 * Every numeric field is a string: these come straight from text inputs, and keeping them as typed
 * means a half-entered "1." doesn't become NaN mid-keystroke.
 */
export type LineDraft = {
  key: string;
  itemId: string;
  name: string;
  description: string;
  hsnCode: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  /** "PERCENT" or "AMOUNT" — which way the discount value is read. */
  discountMode: string;
  discountValue: string;
  taxRatePercent: string;
  /** The order this line bills, when it was taken from one ("Bills order"). */
  companyProductId: string;
  /** The catalogue item's type, when the line came from one — decides whether the period is offered. */
  itemType: string;
  /** Its billing cycle: a subscription's default period is one cycle from the document's date. */
  itemCycle: string;
  /** The period the line pays for, `yyyy-mm-dd` at both ends, or both blank. */
  servicePeriodFrom: string;
  servicePeriodTo: string;
  /**
   * Where the period came from, so a default can follow the order or item and never overwrite what
   * somebody typed: "order" or "item" while it is a default, "typed" once edited (and for a period the
   * document was saved with), blank for none.
   */
  periodSource: LinePeriodSource;
  /** Set once somebody asks for a period on a line whose item doesn't suggest one. */
  periodOpen: boolean;
  /** The project billing stage this line bills — set by "Raise invoice", carried through an edit. */
  billingMilestoneId: string;
};

export type AddressDraft = {
  attention: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  stateCode: string;
  pincode: string;
  country: string;
  phone: string;
};

export type DocumentFormDefaults = {
  id?: string;
  docNumber: string;
  companyId: string;
  locationId: string;
  placeOfSupplyCode: string;
  gstTreatment: string;
  /**
   * The party's GSTIN — the customer's on a sale, the vendor's on a purchase (stored as `sellerGstin`
   * there). Named for the payload field it has always travelled in; our own GSTIN is the branch's.
   */
  buyerGstin: string;
  reverseCharge: boolean;
  /** The branch it is raised from (on a purchase, the one buying). Empty lets the server choose: the user's own, else the head office. */
  branchId: string;
  /** What the customer is quoted in. The ledger stays in rupees whatever this is. */
  currency: string;
  /** Rupees per unit of `currency`. Always 1 on a rupee document — the schema insists. */
  exchangeRate: number;
  issueDate: string;
  dueDate: string;
  validUntil: string;
  reference: string;
  /** Empty means "whoever owns the account" — resolved on the server when the document is created. */
  salespersonId: string;
  notes: string;
  terms: string;

  dispatchFromAddress: string;
  billing: AddressDraft;
  shippingSameAsBilling: boolean;
  shipping: AddressDraft;
  shippingGstin: string;

  shippingCharge: string;
  shippingTaxRatePercent: string;
  withholdingMode: string;
  withholdingSection: string;
  withholdingRatePercent: string;
  adjustmentLabel: string;
  adjustment: string;

  sourceDocumentId: string;
  againstDocumentId: string;
  /** Set when the form was opened from a lead, so the document remembers which deal it serves. */
  leadId: string;
  lines: LineDraft[];
};

export function emptyAddress(): AddressDraft {
  return { attention: "", line1: "", line2: "", city: "", state: "", stateCode: "", pincode: "", country: "India", phone: "" };
}

/**
 * Keys are for React's benefit only — a line's identity has to survive reordering and removal.
 * They're random rather than sequential because this module is instantiated twice, once on the
 * server (which builds the starting draft) and once in the browser (which adds lines afterwards):
 * a per-module counter restarts at 1 in the browser and collides with the server's first line, and
 * two lines sharing a key means editing one edits both.
 */
export function blankLine(): LineDraft {
  return {
    key: crypto.randomUUID(),
    itemId: "",
    name: "",
    description: "",
    hsnCode: "",
    unit: "",
    quantity: "1",
    unitPrice: "0",
    discountMode: "PERCENT",
    discountValue: "0",
    // 18% covers most of what Wroffy sells; the catalogue overrides it as soon as an item is picked.
    taxRatePercent: "18",
    companyProductId: "",
    itemType: "",
    itemCycle: "",
    servicePeriodFrom: "",
    servicePeriodTo: "",
    periodSource: "",
    periodOpen: false,
    billingMilestoneId: "",
  };
}

export function emptyDefaults(): DocumentFormDefaults {
  return {
    docNumber: "",
    companyId: "",
    locationId: "",
    placeOfSupplyCode: "",
    gstTreatment: "UNREGISTERED",
    buyerGstin: "",
    reverseCharge: false,
    branchId: "",
    currency: BASE_CURRENCY,
    exchangeRate: 1,
    // Today in India. toISOString() is today in UTC, which before 05:30 IST is yesterday.
    issueDate: istDateTimeInput(new Date()).slice(0, 10),
    dueDate: "",
    validUntil: "",
    reference: "",
    salespersonId: "",
    notes: "",
    terms: "",
    dispatchFromAddress: "",
    billing: emptyAddress(),
    shippingSameAsBilling: true,
    shipping: emptyAddress(),
    shippingGstin: "",
    shippingCharge: "",
    shippingTaxRatePercent: "18",
    withholdingMode: "NONE",
    withholdingSection: "",
    withholdingRatePercent: "",
    adjustmentLabel: "Adjustment",
    adjustment: "",
    sourceDocumentId: "",
    againstDocumentId: "",
    leadId: "",
    lines: [blankLine()],
  };
}

/** Renders a stored address back into the block a printed document shows. */
export function formatAddress(parts: {
  attention?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  country?: string | null;
}) {
  return [
    parts.attention,
    parts.line1,
    parts.line2,
    [parts.city, parts.pincode].filter(Boolean).join(" "),
    parts.state,
    parts.country,
  ]
    .map((line) => line?.trim())
    .filter(Boolean) as string[];
}
import { BASE_CURRENCY } from "@/lib/currency";
import { istDateTimeInput } from "@/lib/india-time";
import type { LinePeriodSource } from "@/lib/documents/service-period";
