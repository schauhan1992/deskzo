import { stateCodeFromGstin, stateCodeFromName, isValidGstin, OTHER_COUNTRY_CODE } from "@/lib/gst-engine";
import { isIndia } from "@/lib/geo/countries";
import { registeredTreatments } from "@/lib/validation/trade-document";

/**
 * Working out who a document is being raised against, from the site it was sold to.
 *
 * Shared by every "raise a proposal from a record" button, because the alternative is each of them
 * deriving the place of supply slightly differently — and the place of supply decides whether the
 * customer is charged CGST+SGST or IGST. Two buttons disagreeing about that produce two documents
 * the accounts team cannot reconcile.
 *
 * Pure, so the rules below can be checked without a database.
 */

/** What a `CompanyLocation` has to offer a document. */
export type PartySite = {
  id: string;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  /** Blank is India, as everywhere in src/lib/geo/. */
  country?: string | null;
  gstNumber: string | null;
  gstTreatment: string;
} | null;

export type DocumentAddress = {
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

export type PartyDetails = {
  locationId: string;
  placeOfSupplyCode: string;
  gstin: string;
  gstTreatment: string;
  address: DocumentAddress;
};

export function partyDetails(
  site: PartySite,
  companyName: string,
): { ok: true; data: PartyDetails } | { ok: false; error: string } {
  const gstin = site?.gstNumber?.trim().toUpperCase() || "";
  const gstTreatment = site?.gstTreatment ?? "UNREGISTERED";

  /**
   * The two GST refusals, named.
   *
   * `tradeDocumentSchema` catches both anyway, but it answers "That doesn't look like a valid GSTIN"
   * with no indication of whose or where it came from — a puzzle, when the field was never on
   * screen. The address is the thing to go and fix, so the message says so.
   */
  if (gstin && !isValidGstin(gstin)) {
    return {
      ok: false,
      error: `The GSTIN on ${companyName}'s address (${gstin}) isn't valid, so a compliant document can't be raised. Correct it on the account first.`,
    };
  }
  if (registeredTreatments.includes(gstTreatment as (typeof registeredTreatments)[number]) && !gstin) {
    return {
      ok: false,
      error: `${companyName}'s address is marked GST-registered but has no GSTIN on it. Add it to the account first.`,
    };
  }

  // From the GSTIN first, because it is authoritative — its first two digits *are* the state code.
  // The address's state name is the fallback for an unregistered party that has no GSTIN at all.
  // A site abroad is "Other Country" (96); its state is never run through the Indian lookup, where a
  // foreign "Punjab" would come back as India's code 03.
  const abroad = !!site && !isIndia(site.country);
  const placeOfSupplyCode = stateCodeFromGstin(gstin) ?? (abroad ? OTHER_COUNTRY_CODE : stateCodeFromName(site?.state)) ?? "";
  if (!placeOfSupplyCode) {
    return {
      ok: false,
      error: `${companyName} has no state on its address and no GSTIN, so the place of supply can't be worked out — and without it the document would be taxed as inter-state. Add an address to the account first.`,
    };
  }

  return {
    ok: true,
    data: {
      locationId: site?.id ?? "",
      placeOfSupplyCode,
      gstin,
      gstTreatment,
      address: {
        attention: "",
        line1: site?.address ?? "",
        line2: "",
        city: site?.city ?? "",
        state: site?.state ?? "",
        stateCode: placeOfSupplyCode,
        /**
         * Dropped rather than refused when it is malformed.
         *
         * A PIN code is required by the IRP, but only when a document is e-invoiced — which happens
         * at issue, and never to a proposal. Refusing to draft a quote over a typo in a field it
         * does not need would be the wrong trade; the document form shows it blank, which is where
         * it gets corrected.
         */
        pincode: abroad ? (site?.pincode ?? "").trim() : /^[1-9][0-9]{5}$/.test(site?.pincode ?? "") ? site!.pincode! : "",
        // Where the site is. This said "India" whatever the address, so a proposal to a customer
        // in Dubai printed an Indian address.
        country: abroad ? site!.country!.trim() : "India",
        phone: "",
      },
    },
  };
}

/*
 * A document raised from a record is dated today on the workspace's calendar: `(await
 * workspaceClock()).today()`. Not `toISOString()`, which is UTC's today — yesterday until half past
 * five in the morning in India. This module's todayInIndia was India's, by a fixed offset.
 */
