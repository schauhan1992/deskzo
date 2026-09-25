import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import type { ProviderConfig } from "@/lib/einvoice/provider";

/** The "us" side of every document: who we are on paper, where we bank, and how we reach the IRP. */
export type Organisation = {
  legalName: string;
  tradeName: string | null;
  gstin: string | null;
  pan: string | null;
  cin: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  stateCode: string | null;
  pincode: string | null;
  /** Blank means India — see `isIndia`. */
  country: string | null;
  email: string | null;
  phone: string | null;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankBranch: string | null;
  upiId: string | null;
  invoiceTerms: string | null;
  invoiceNotes: string | null;
  signatureDataUrl: string | null;
  roundOffTotals: boolean;
  /**
   * Letterhead. Separate from the app's own branding: the mark at the top of an appointment letter
   * is the employer's, the one in the sidebar is the software's. Null falls back to the app logo.
   */
  letterheadLogoDataUrl: string | null;
  letterheadFooter: string | null;
  letterNumberPrefix: string;
  letterSignatoryName: string | null;
  letterSignatoryTitle: string | null;
  einvoiceEnabled: boolean;
  einvoiceProvider: string;
  einvoiceUsername: string | null;
  einvoiceClientId: string | null;
  einvoiceMinValue: number | null;
  /**
   * Feedback. The review page a happy customer is offered, and the score at or above which they
   * are offered it — see `reviewInvitation` in src/lib/feedback/rating.ts for what the threshold
   * means and what Google's policy says about filtering by it.
   */
  feedbackReviewUrl: string | null;
  feedbackReviewMinRating: number;
  feedbackLinkDays: number;
  feedbackIntro: string | null;
  /**
   * Marketing. The from-domain is kept apart from the primary one on purpose — see `routeFor`
   * in src/lib/marketing/providers/index.ts for why bulk must not share a domain with invoices.
   */
  marketingFromDomain: string | null;
  marketingPostalAddress: string | null;
  marketingQuietStartMinute: number;
  marketingQuietEndMinute: number;
  marketingSkipNonWorkingDays: boolean;
  marketingMaxPerContactPerWeek: number;
  marketingApprovalThreshold: number;
  /** Whether a secret is stored, so the settings form can say "saved" without ever sending it back. */
  hasPassword: boolean;
  hasClientSecret: boolean;
};

export const EMPTY_ORGANISATION: Organisation = {
  legalName: "",
  tradeName: null,
  gstin: null,
  pan: null,
  cin: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  state: null,
  stateCode: null,
  pincode: null,
  country: null,
  email: null,
  phone: null,
  bankName: null,
  bankAccountNumber: null,
  bankIfsc: null,
  bankBranch: null,
  upiId: null,
  invoiceTerms: null,
  invoiceNotes: null,
  signatureDataUrl: null,
  roundOffTotals: true,
  letterheadLogoDataUrl: null,
  letterheadFooter: null,
  letterNumberPrefix: "WRF",
  letterSignatoryName: null,
  letterSignatoryTitle: null,
  einvoiceEnabled: false,
  einvoiceProvider: "mock",
  einvoiceUsername: null,
  einvoiceClientId: null,
  einvoiceMinValue: null,
  feedbackReviewUrl: null,
  feedbackReviewMinRating: 4,
  feedbackLinkDays: 30,
  feedbackIntro: null,
  marketingFromDomain: null,
  marketingPostalAddress: null,
  marketingQuietStartMinute: 1200,
  marketingQuietEndMinute: 540,
  marketingSkipNonWorkingDays: true,
  marketingMaxPerContactPerWeek: 2,
  marketingApprovalThreshold: 200,
  hasPassword: false,
  hasClientSecret: false,
};

/**
 * Never throws. Organisation details are read on every document page, including before anyone has
 * filled them in and while the database is still migrating — an empty form is a far better outcome
 * there than a 500.
 */
/**
 * The country, for printing — or null when it is India.
 *
 * Every document this company issues is addressed from India by default, and printing "India" under
 * a Mumbai address adds a line nobody reads. It is printed only when it says something.
 */
export function foreignCountry(org: { country: string | null }): string | null {
  const country = org.country?.trim();
  return country && country.toLowerCase() !== "india" ? country : null;
}

export async function getOrganisation(): Promise<Organisation> {
  try {
    const row = await db.organisationSettings.findUnique({ where: { id: "global" } });
    if (!row) return EMPTY_ORGANISATION;
    return {
      legalName: row.legalName,
      tradeName: row.tradeName,
      gstin: row.gstin,
      pan: row.pan,
      cin: row.cin,
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2,
      city: row.city,
      state: row.state,
      stateCode: row.stateCode,
      pincode: row.pincode,
      country: row.country,
      email: row.email,
      phone: row.phone,
      bankName: row.bankName,
      bankAccountNumber: row.bankAccountNumber,
      bankIfsc: row.bankIfsc,
      bankBranch: row.bankBranch,
      upiId: row.upiId,
      invoiceTerms: row.invoiceTerms,
      invoiceNotes: row.invoiceNotes,
      signatureDataUrl: row.signatureDataUrl,
      roundOffTotals: row.roundOffTotals,
      letterheadLogoDataUrl: row.letterheadLogoDataUrl,
      letterheadFooter: row.letterheadFooter,
      letterNumberPrefix: row.letterNumberPrefix,
      letterSignatoryName: row.letterSignatoryName,
      letterSignatoryTitle: row.letterSignatoryTitle,
      einvoiceEnabled: row.einvoiceEnabled,
      einvoiceProvider: row.einvoiceProvider,
      einvoiceUsername: row.einvoiceUsername,
      einvoiceClientId: row.einvoiceClientId,
      einvoiceMinValue: row.einvoiceMinValue ? Number(row.einvoiceMinValue) : null,
      feedbackReviewUrl: row.feedbackReviewUrl,
      feedbackReviewMinRating: row.feedbackReviewMinRating,
      feedbackLinkDays: row.feedbackLinkDays,
      feedbackIntro: row.feedbackIntro,
      marketingFromDomain: row.marketingFromDomain,
      marketingPostalAddress: row.marketingPostalAddress,
      marketingQuietStartMinute: row.marketingQuietStartMinute,
      marketingQuietEndMinute: row.marketingQuietEndMinute,
      marketingSkipNonWorkingDays: row.marketingSkipNonWorkingDays,
      marketingMaxPerContactPerWeek: row.marketingMaxPerContactPerWeek,
      marketingApprovalThreshold: row.marketingApprovalThreshold,
      hasPassword: !!row.einvoicePasswordCipher,
      hasClientSecret: !!row.einvoiceClientSecretCipher,
    };
  } catch {
    return EMPTY_ORGANISATION;
  }
}

/**
 * Server-only: decrypts the IRP credentials. Deliberately not exported from a "use server" module —
 * every export there is a client-callable endpoint, and this returns plaintext secrets.
 */
export async function getEInvoiceConfig(): Promise<ProviderConfig | null> {
  const row = await db.organisationSettings.findUnique({ where: { id: "global" } });
  if (!row || !row.einvoiceEnabled) return null;
  const decrypt = async (cipher: string | null) => {
    if (!cipher) return null;
    try {
      return await decryptSecret(cipher);
    } catch {
      return null;
    }
  };
  return {
    provider: row.einvoiceProvider,
    username: row.einvoiceUsername,
    password: await decrypt(row.einvoicePasswordCipher),
    clientId: row.einvoiceClientId,
    clientSecret: await decrypt(row.einvoiceClientSecretCipher),
    gstin: row.gstin,
  };
}

/** Enough of an address filled in that a document header won't print half-blank. */
export function isOrganisationReady(org: Organisation) {
  return !!(org.legalName && org.gstin && org.stateCode && org.addressLine1 && org.city && org.pincode);
}
