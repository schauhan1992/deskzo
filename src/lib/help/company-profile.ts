import { GSTIN_PATTERN, GST_STATE_CODES, hasValidGstinChecksum } from "@/lib/gst-engine";
import { isIndia } from "@/lib/geo/countries";

/**
 * The company profile's essentials, as the onboarding wizard asks for them — the legal name, the GSTIN
 * in India, and the registered address — and what is wrong with each, in words that say why. Pure, so
 * the wizard checks a field as it is left and `saveCompanyProfile` (src/actions/onboarding.ts) checks
 * the same things again before anything is saved.
 *
 * The GSTIN is optional: a business under the GST threshold has none (see `profileComplete` in
 * src/lib/help/getting-started.ts). A GSTIN that is given must be one, checksum and all — it goes on
 * every invoice.
 */
export type CompanyProfileInput = {
  legalName: string;
  gstin: string;
  addressLine1: string;
  city: string;
  state: string;
  pincode: string;
  country: string;
};

export type CompanyProfileField = keyof CompanyProfileInput;
export type CompanyProfileIssues = Partial<Record<CompanyProfileField, string>>;

export const COMPANY_PROFILE_FIELDS: readonly CompanyProfileField[] = ["legalName", "gstin", "addressLine1", "country", "state", "city", "pincode"];

export function companyProfileProblem(field: CompanyProfileField, input: CompanyProfileInput): string | null {
  const value = String(input[field] ?? "").trim();
  const india = isIndia(input.country);
  switch (field) {
    case "legalName":
      if (!value) return "Enter your company's legal name, exactly as registered — it prints on every invoice.";
      if (value.length > 200) return `Keep it to 200 characters — this one has ${value.length}.`;
      return null;
    case "gstin": {
      if (!india || !value) return null;
      const gstin = value.toUpperCase().replace(/\s+/g, "");
      if (gstin.length !== 15) return `A GSTIN is 15 characters — this one has ${gstin.length}.`;
      if (!GSTIN_PATTERN.test(gstin)) return "That isn't the shape of a GSTIN — two digits for the state, then the PAN, like 27AABCW1234F1ZV.";
      if (!GST_STATE_CODES[gstin.slice(0, 2)] || gstin.startsWith("96")) return `${gstin.slice(0, 2)} isn't a GST state code — check the GSTIN's first two digits.`;
      if (!hasValidGstinChecksum(gstin)) return "That GSTIN's last character doesn't check out — compare it with your registration certificate.";
      return null;
    }
    case "addressLine1":
      return value ? null : "Enter the registered office's street address.";
    case "city":
      return value ? null : "Enter the city.";
    case "state":
      return india && !value ? "Choose the state — in India, the GST on every sale follows it." : null;
    case "pincode": {
      if (!india) return null;
      if (!value) return "Enter the 6-digit PIN code.";
      const digits = value.replace(/\s+/g, "");
      if (!/^\d+$/.test(digits)) return "A PIN code is digits only — 6 of them.";
      return digits.length === 6 ? null : `A PIN code is 6 digits — this one has ${digits.length}.`;
    }
    case "country":
      return null;
  }
}

export function companyProfileIssues(input: CompanyProfileInput): CompanyProfileIssues {
  const issues: CompanyProfileIssues = {};
  for (const field of COMPANY_PROFILE_FIELDS) {
    const problem = companyProfileProblem(field, input);
    if (problem) issues[field] = problem;
  }
  return issues;
}
