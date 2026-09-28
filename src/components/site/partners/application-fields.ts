/**
 * The "Become a partner" form's rules, shared by the form (./application-form.tsx) and the action
 * that checks them again (src/actions/platform/partner-site.ts). The lengths are the columns' own
 * (partner_applications, spec §2.2).
 */

export const APPLICATION_LIMITS = { company: 160, website: 200, name: 120, email: 254, phone: 32, messageMin: 20, message: 4000 } as const;

export const KINDS_WANTED = ["RESELLER", "DISTRIBUTOR"] as const;
export type KindWanted = (typeof KINDS_WANTED)[number];

export type PartnerApplicationField = "companyName" | "companyWebsite" | "country" | "kindWanted" | "contactName" | "contactEmail" | "contactPhone" | "message";

export type PartnerApplicationInput = {
  companyName: string;
  /** The company's own site — optional. */
  companyWebsite?: string;
  /** A country code from the list (src/lib/geo/countries.ts). */
  country: string;
  kindWanted: string;
  contactName: string;
  contactEmail: string;
  contactPhone?: string;
  message: string;
  /** Left empty by people; filled by bots that fill every field (the honeypot, as on the contact form). */
  website?: string;
};

export type PartnerApplicationResult = { ok: true } | { ok: false; error: string; field?: PartnerApplicationField };
