/**
 * Who "we" are on a document, as plain data — the pure half of the branch identity engine.
 *
 * No database and no Prisma runtime here, so a client component can import the types and the
 * labels, and a check suite can call `mergeIdentity` with two plain objects. The half that reads
 * rows is `src/lib/branches/identity.ts`.
 */
import { stateCodeFromName } from "@/lib/gst-engine";
import { isIndia } from "@/lib/geo/countries";

/** Everything a document prints, e-invoices or e-ways about its seller (or, on a purchase, its buyer). */
export type BranchIdentity = {
  branchId: string;
  name: string;
  code: string;
  isHeadOffice: boolean;
  active: boolean;
  gstRegistrationId: string | null;
  gstin: string | null;
  registrationCode: string | null;
  /** Registration's state; else stateCodeFromName(effective address state); else null. */
  stateCode: string | null;
  legalName: string;
  tradeName: string | null;
  pan: string | null;
  cin: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  country: string | null;
  email: string | null;
  phone: string | null;
  addressSource: "branch" | "organisation";
  bankName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankBranch: string | null;
  upiId: string | null;
  /** The branch's own logo only; callers fall back to the app's branding, as they do today. */
  logoDataUrl: string | null;
  signatureDataUrl: string | null;
  invoiceTerms: string | null;
  invoiceNotes: string | null;
  roundOffTotals: boolean;
};

/** A branch as a picker offers it. */
export type BranchChoice = {
  id: string;
  name: string;
  code: string;
  isHeadOffice: boolean;
  active: boolean;
  gstRegistrationId: string | null;
  gstin: string | null;
  stateCode: string | null;
  /** Multi-line "dispatch from" text, the same shape the document form builds from the org today. */
  dispatchAddress: string;
  /** Effective: the branch's own terms, else the organisation's. */
  invoiceTerms: string | null;
  /** Has an active registration, or the organisation has none at all (unregistered, or abroad). */
  canIssueTaxDocuments: boolean;
};

export type RegistrationChoice = { id: string; gstin: string; stateCode: string; code: string; active: boolean; isHeadOffice: boolean };

/** The registration fields the merge reads. */
export type RegistrationRowLike = { id: string; gstin: string; stateCode: string; code: string };

/**
 * The branch fields the merge reads — a `Branch` row with its registration included fits, and so
 * does a plain object in a test. Anything left out counts as blank.
 */
export type BranchRowLike = {
  id: string;
  name: string;
  code: string;
  isHeadOffice: boolean;
  active?: boolean;
  gstRegistration?: RegistrationRowLike | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  country?: string | null;
  email?: string | null;
  phone?: string | null;
  bankName?: string | null;
  bankAccountNumber?: string | null;
  bankIfsc?: string | null;
  bankBranch?: string | null;
  upiId?: string | null;
  logoDataUrl?: string | null;
  signatureDataUrl?: string | null;
  invoiceTerms?: string | null;
  invoiceNotes?: string | null;
};

/** The organisation fields the merge reads — the `OrganisationSettings` row fits. Null = not filled in yet. */
export type OrganisationRowLike = {
  legalName?: string | null;
  /** The registered office's GST state code, as Profile stored it — the fallback for an unregistered head office. */
  stateCode?: string | null;
  tradeName?: string | null;
  pan?: string | null;
  cin?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  country?: string | null;
  email?: string | null;
  phone?: string | null;
  bankName?: string | null;
  bankAccountNumber?: string | null;
  bankIfsc?: string | null;
  bankBranch?: string | null;
  upiId?: string | null;
  signatureDataUrl?: string | null;
  invoiceTerms?: string | null;
  invoiceNotes?: string | null;
  roundOffTotals?: boolean | null;
};

/** A stored value, or null when it is missing or only whitespace — a blank override is no override. */
const given = (value: string | null | undefined): string | null => (value && value.trim() ? value : null);

/** The branch's value when it has one, else the organisation's. */
const either = (own: string | null | undefined, inherited: string | null | undefined) => given(own) ?? given(inherited);

/**
 * The merge rule (spec D3): whatever a branch leaves blank is the organisation's.
 *
 *   · The address is taken whole — the branch's when it has a first line, else the registered office
 *     (`addressSource` says which). A head office created with every override blank therefore prints
 *     exactly what the company printed before branches existed.
 *   · So is the bank block: the branch's when it has an account number or a UPI id, never half of
 *     each — an IFSC from one account under the number of another sends money nowhere.
 *   · Email, phone, signature, terms and notes fall back one by one. The logo does not: callers fall
 *     back to the app's branding, as they always have.
 *   · Legal and trade name, PAN, CIN and round-off are the entity's; the GSTIN is the registration's.
 */
export function mergeIdentity(branch: BranchRowLike, org: OrganisationRowLike | null | undefined): BranchIdentity {
  const o = org ?? {};
  const ownAddress = given(branch.addressLine1) !== null;
  const address = ownAddress ? branch : o;
  const ownBank = given(branch.bankAccountNumber) !== null || given(branch.upiId) !== null;
  const bank = ownBank ? branch : o;
  const registration = branch.gstRegistration ?? null;

  const country = given(address.country);
  const state = given(address.state);
  // A branch abroad has no GST state, whatever its region is called.
  // Without a registration, the state is read from the address's name; for a branch on the registered
  // office's address whose name doesn't map ("Orissa", a typo), Profile's own stored code — before
  // branches this was the only source, and an unregistered company must not start charging IGST.
  const stateCode =
    registration?.stateCode ?? (isIndia(country) ? (stateCodeFromName(state) ?? (ownAddress ? null : given(o.stateCode))) : null);

  return {
    branchId: branch.id,
    name: branch.name,
    code: branch.code,
    isHeadOffice: branch.isHeadOffice,
    active: branch.active ?? true,
    gstRegistrationId: registration?.id ?? null,
    gstin: registration?.gstin ?? null,
    registrationCode: registration?.code ?? null,
    stateCode,
    legalName: o.legalName ?? "",
    tradeName: given(o.tradeName),
    pan: given(o.pan),
    cin: given(o.cin),
    addressLine1: given(address.addressLine1),
    addressLine2: given(address.addressLine2),
    city: given(address.city),
    state,
    pincode: given(address.pincode),
    country,
    email: either(branch.email, o.email),
    phone: either(branch.phone, o.phone),
    addressSource: ownAddress ? "branch" : "organisation",
    bankName: given(bank.bankName),
    bankAccountNumber: given(bank.bankAccountNumber),
    bankIfsc: given(bank.bankIfsc),
    bankBranch: given(bank.bankBranch),
    upiId: given(bank.upiId),
    logoDataUrl: given(branch.logoDataUrl),
    signatureDataUrl: either(branch.signatureDataUrl, o.signatureDataUrl),
    invoiceTerms: either(branch.invoiceTerms, o.invoiceTerms),
    invoiceNotes: either(branch.invoiceNotes, o.invoiceNotes),
    roundOffTotals: o.roundOffTotals ?? true,
  };
}

/**
 * The "dispatch from" block: legal name, the two address lines, "city pincode", state, and the
 * country only when it is not India — the text the document form used to build from the organisation.
 */
export function formatDispatchAddress(
  identity: Pick<BranchIdentity, "legalName" | "addressLine1" | "addressLine2" | "city" | "pincode" | "state" | "country">,
): string {
  const country = identity.country && !isIndia(identity.country) ? identity.country.trim() : null;
  return [identity.legalName, identity.addressLine1, identity.addressLine2, [identity.city, identity.pincode].filter(Boolean).join(" "), identity.state, country]
    .filter(Boolean)
    .join("\n");
}

/** "Pune (PUN)" — or just "Head office" for the head office that still goes by that name. */
export function branchLabel(b: { name: string; code: string; isHeadOffice: boolean }): string {
  if (b.isHeadOffice && b.name.trim().toLowerCase() === "head office") return "Head office";
  return `${b.name} (${b.code})`;
}
