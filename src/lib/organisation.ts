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
  /** Entity-wide: the e-invoice mandate follows the PAN's turnover, not one GSTIN's. */
  einvoiceEnabled: boolean;
  /** @deprecated per registration now — see eInvoiceConfigFor. The head office registration's; "mock" when it has none. */
  einvoiceProvider: string;
  /** @deprecated per registration now — see eInvoiceConfigFor. The head office registration's. */
  einvoiceUsername: string | null;
  /** @deprecated per registration now — see eInvoiceConfigFor. The head office registration's. */
  einvoiceClientId: string | null;
  /** Entity-wide, like the switch. */
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
  /**
   * Whether a secret is stored, so the settings form can say "saved" without ever sending it back.
   * @deprecated per registration now — see eInvoiceConfigFor. The head office registration's.
   */
  hasPassword: boolean;
  /** @deprecated per registration now — see eInvoiceConfigFor. The head office registration's. */
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
 * The country, for printing — or null when it is India.
 *
 * Every document this company issues is addressed from India by default, and printing "India" under
 * a Mumbai address adds a line nobody reads. It is printed only when it says something.
 */
export function foreignCountry(org: { country: string | null }): string | null {
  const country = org.country?.trim();
  return country && country.toLowerCase() !== "india" ? country : null;
}

/** The registration columns the organisation still answers for — the head office's; ciphers only to say whether one is stored. */
const HEAD_OFFICE_REGISTRATION_SELECT = {
  gstin: true,
  einvoiceProvider: true,
  einvoiceUsername: true,
  einvoiceClientId: true,
  einvoicePasswordCipher: true,
  einvoiceClientSecretCipher: true,
} as const;

/**
 * The organisation, as the entity: the legal name, PAN and registered office are its own; the GSTIN
 * is the head office's registration — which is what every entity-level reader (a letter, a report
 * header, a payslip, getting-started) meant by "our GSTIN". The organisation row's own `gstin` is
 * only a mirror for rolling back to the previous build, and `stateCode` is the registered office's.
 * Documents do not read their seller from here: they read their branch (`branchIdentity`).
 *
 * Never throws. Organisation details are read on every document page, including before anyone has
 * filled them in and while the database is still migrating — an empty form is a far better outcome
 * there than a 500.
 */
export async function getOrganisation(): Promise<Organisation> {
  try {
    const [row, headOffice] = await Promise.all([
      db.organisationSettings.findUnique({ where: { id: "global" } }),
      // Read apart, so a missing branches table (a database mid-migration) costs the GSTIN, not the whole row.
      db.branch
        .findFirst({ where: { isHeadOffice: true }, select: { gstRegistration: { select: HEAD_OFFICE_REGISTRATION_SELECT } } })
        .catch(() => null),
    ]);
    const registration = headOffice?.gstRegistration ?? null;
    const fromRegistration = {
      gstin: registration?.gstin ?? null,
      einvoiceProvider: registration?.einvoiceProvider ?? "mock",
      einvoiceUsername: registration?.einvoiceUsername ?? null,
      einvoiceClientId: registration?.einvoiceClientId ?? null,
      hasPassword: !!registration?.einvoicePasswordCipher,
      hasClientSecret: !!registration?.einvoiceClientSecretCipher,
    };
    if (!row) return { ...EMPTY_ORGANISATION, ...fromRegistration };
    return {
      legalName: row.legalName,
      tradeName: row.tradeName,
      gstin: fromRegistration.gstin,
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
      einvoiceProvider: fromRegistration.einvoiceProvider,
      einvoiceUsername: fromRegistration.einvoiceUsername,
      einvoiceClientId: fromRegistration.einvoiceClientId,
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
      hasPassword: fromRegistration.hasPassword,
      hasClientSecret: fromRegistration.hasClientSecret,
    };
  } catch {
    return EMPTY_ORGANISATION;
  }
}

async function decrypt(cipher: string | null): Promise<string | null> {
  if (!cipher) return null;
  try {
    return await decryptSecret(cipher);
  } catch {
    return null;
  }
}

/**
 * The IRP connection for one GST registration — the NIC issues API users per GSTIN, so a document
 * is sent with its own registration's credentials (e-way bills use the same ones).
 *
 * Server-only: decrypts the credentials. Deliberately not exported from a "use server" module —
 * every export there is a client-callable endpoint, and this returns plaintext secrets.
 *
 * An error, never a silent fallback to another GSTIN's login: an IRN generated under the wrong
 * registration is a filing on the wrong GSTIN. The message names what to fix and is shown as it is.
 *
 * `allowInactive` is for cancelling: a registration given up today still cancels the IRNs and e-way
 * bills raised under it within their window, with the credentials it keeps.
 */
export async function eInvoiceConfigFor(
  gstRegistrationId: string | null | undefined,
  opts: { allowInactive?: boolean } = {},
): Promise<{ config: ProviderConfig } | { error: string }> {
  const [org, registration] = await Promise.all([
    db.organisationSettings.findUnique({ where: { id: "global" }, select: { einvoiceEnabled: true } }),
    gstRegistrationId ? db.gstRegistration.findUnique({ where: { id: gstRegistrationId } }) : Promise.resolve(null),
  ]);
  // One switch for the whole company, because the mandate follows the PAN's aggregate turnover — CA question C5.
  if (!org?.einvoiceEnabled) return { error: "E-invoicing is switched off — Settings → e-Invoicing" };
  if (!registration) return { error: "This branch has no GST registration" };
  if (!registration.active && !opts.allowInactive) {
    return { error: `GSTIN ${registration.gstin} is inactive — reactivate it under Settings → Branches & GST registrations to use it` };
  }
  // Null is "not set up" — never quietly the mock portal, which would hand out IRNs the IRP never issued.
  if (!registration.einvoiceProvider) {
    return { error: `E-invoicing isn't set up for GSTIN ${registration.gstin} — add its IRP credentials in Settings → e-Invoicing` };
  }
  return {
    config: {
      provider: registration.einvoiceProvider,
      username: registration.einvoiceUsername,
      password: await decrypt(registration.einvoicePasswordCipher),
      clientId: registration.einvoiceClientId,
      clientSecret: await decrypt(registration.einvoiceClientSecretCipher),
      gstin: registration.gstin,
    },
  };
}

/**
 * The head office registration's connection, or null for any reason it can't be used.
 * @deprecated per registration now — call eInvoiceConfigFor with the document's gstRegistrationId,
 * whose error says what is wrong.
 */
export async function getEInvoiceConfig(): Promise<ProviderConfig | null> {
  try {
    const headOffice = await db.branch.findFirst({ where: { isHeadOffice: true }, select: { gstRegistrationId: true } });
    const got = await eInvoiceConfigFor(headOffice?.gstRegistrationId);
    return "config" in got ? got.config : null;
  } catch {
    return null;
  }
}

/** Enough of an address filled in that a document header won't print half-blank. */
export function isOrganisationReady(org: Organisation) {
  return !!(org.legalName && org.gstin && org.stateCode && org.addressLine1 && org.city && org.pincode);
}
