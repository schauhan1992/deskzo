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
