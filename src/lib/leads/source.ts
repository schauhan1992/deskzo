import type { LeadSource } from "@prisma/client";

/** Where a lead came from, as the forms and the list say it. */
export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  WEBSITE: "Website",
  REFERRAL: "Referral",
  LINKEDIN: "LinkedIn",
  CALLING: "Outbound call",
  EMAIL: "Email",
  EVENT: "Event",
  PARTNER: "Partner",
  ADVERTISEMENT: "Advertisement",
  EXISTING_CUSTOMER: "Existing customer",
  WALK_IN: "Walk-in",
  DIGITAL_CARD: "Digital card",
  OTHER: "Other",
};

export const LEAD_SOURCE_VALUES = Object.keys(LEAD_SOURCE_LABELS) as [LeadSource, ...LeadSource[]];

/**
 * A lead's source in words — or, where field access masks or restricts it (src/lib/leads/masking.ts),
 * the masked text the server sent in its place, as it is.
 */
export function leadSourceLabel(source: string | null | undefined): string {
  if (!source) return "—";
  return (LEAD_SOURCE_LABELS as Record<string, string>)[source] ?? source;
}
