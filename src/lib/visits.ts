import type { VisitPurpose, VisitStatus } from "@prisma/client";

export const visitPurposeValues = [
  "INTRO_MEETING",
  "REQUIREMENT_GATHERING",
  "PRODUCT_DEMO",
  "PROPOSAL_DISCUSSION",
  "NEGOTIATION",
  "ORDER_COLLECTION",
  "PAYMENT_FOLLOW_UP",
  "SUPPORT_ESCALATION",
  "RELATIONSHIP_BUILDING",
  "DELIVERY_INSTALLATION",
  "OTHER",
] as const;

export const visitPurposeLabels: Record<VisitPurpose, string> = {
  INTRO_MEETING: "Intro meeting",
  REQUIREMENT_GATHERING: "Requirement gathering",
  PRODUCT_DEMO: "Product demo",
  PROPOSAL_DISCUSSION: "Proposal discussion",
  NEGOTIATION: "Negotiation",
  ORDER_COLLECTION: "Order collection",
  PAYMENT_FOLLOW_UP: "Payment follow-up",
  SUPPORT_ESCALATION: "Support escalation",
  RELATIONSHIP_BUILDING: "Relationship building",
  DELIVERY_INSTALLATION: "Delivery / installation",
  OTHER: "Other",
};

export const visitStatusValues = ["PLANNED", "CHECKED_IN", "COMPLETED", "CANCELLED", "NO_SHOW"] as const;

export const visitStatusLabels: Record<VisitStatus, string> = {
  PLANNED: "Planned",
  CHECKED_IN: "Checked in",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  NO_SHOW: "No show",
};

export const visitStatusTone: Record<VisitStatus, "default" | "green" | "blue" | "red" | "amber" | "brand"> = {
  PLANNED: "blue",
  CHECKED_IN: "amber",
  COMPLETED: "green",
  CANCELLED: "default",
  NO_SHOW: "red",
};

/** A visit is still in play until it's been written up or called off. */
export function isVisitOpen(status: VisitStatus) {
  return status === "PLANNED" || status === "CHECKED_IN";
}

export function formatVisitId(seq: number) {
  return `VIS-${String(seq).padStart(6, "0")}`;
}

/**
 * Minutes on site, once both ends are stamped. Null means "not recorded" and nothing else — a visit
 * that really did take under a minute returns 0, so a rounding artefact can't be mistaken for a
 * missing check-in. Negative is treated as unrecorded, since it can only mean the stamps are wrong.
 */
export function visitDuration(checkInAt: Date | string | null, checkOutAt: Date | string | null) {
  if (!checkInAt || !checkOutAt) return null;
  const minutes = Math.round((new Date(checkOutAt).getTime() - new Date(checkInAt).getTime()) / 60000);
  return minutes >= 0 ? minutes : null;
}

export function formatDuration(minutes: number | null) {
  if (minutes === null) return "—";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
}
