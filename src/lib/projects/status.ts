import type {
  ProjectBillingStatus,
  ProjectDocumentType,
  ProjectHealth,
  ProjectRiskKind,
  ProjectRiskSeverity,
  ProjectRiskStatus,
  ProjectStakeholderRole,
  ProjectStatus,
} from "@prisma/client";

/**
 * What a project's states are called, and what they mean for the numbers.
 *
 * Pure, so the list screen, the detail screen, a dashboard widget and the check all read the same
 * definitions rather than each deciding for itself what "finished" means.
 */

type Tone = "default" | "green" | "blue" | "red" | "amber";

export const projectStatusLabels: Record<ProjectStatus, string> = {
  PROPOSED: "Proposed",
  DISCOVERY: "Discovery",
  PLANNING: "Planning",
  IN_PROGRESS: "In progress",
  UAT: "Customer testing",
  GO_LIVE: "Go live",
  HANDOVER: "Handover",
  COMPLETED: "Completed",
  ON_HOLD: "On hold",
  CANCELLED: "Cancelled",
};

export const projectStatusTone: Record<ProjectStatus, Tone> = {
  PROPOSED: "default",
  DISCOVERY: "blue",
  PLANNING: "blue",
  IN_PROGRESS: "blue",
  UAT: "amber",
  GO_LIVE: "amber",
  HANDOVER: "amber",
  COMPLETED: "green",
  ON_HOLD: "amber",
  CANCELLED: "red",
};

/** The order a project normally moves through. `ON_HOLD` and `CANCELLED` are off it, from anywhere. */
export const PROJECT_PIPELINE: ProjectStatus[] = [
  "PROPOSED",
  "DISCOVERY",
  "PLANNING",
  "IN_PROGRESS",
  "UAT",
  "GO_LIVE",
  "HANDOVER",
  "COMPLETED",
];

/** Nothing more will happen without somebody reopening it. */
export function isClosed(status: ProjectStatus) {
  return status === "COMPLETED" || status === "CANCELLED";
}

/** Work is actually happening — what a "live projects" count should mean. */
export function isActive(status: ProjectStatus) {
  return !isClosed(status) && status !== "PROPOSED" && status !== "ON_HOLD";
}

export const projectHealthLabels: Record<ProjectHealth, string> = {
  ON_TRACK: "On track",
  AT_RISK: "At risk",
  OFF_TRACK: "Off track",
};

export const projectHealthTone: Record<ProjectHealth, Tone> = {
  ON_TRACK: "green",
  AT_RISK: "amber",
  OFF_TRACK: "red",
};

export const stakeholderRoleLabels: Record<ProjectStakeholderRole, string> = {
  SPONSOR: "Sponsor",
  PROJECT_MANAGER: "Project manager",
  TECHNICAL_LEAD: "Technical lead",
  TEAM_MEMBER: "Team member",
  CUSTOMER_SPONSOR: "Customer sponsor",
  CUSTOMER_TECHNICAL: "Customer technical",
  CUSTOMER_USER: "Customer user",
  VENDOR: "Vendor",
  OBSERVER: "Observer",
};

/** Roles that describe somebody at the customer, so the form offers the right half of the list. */
export const CUSTOMER_SIDE_ROLES: ProjectStakeholderRole[] = [
  "CUSTOMER_SPONSOR",
  "CUSTOMER_TECHNICAL",
  "CUSTOMER_USER",
  "VENDOR",
];

export const projectDocumentTypeLabels: Record<ProjectDocumentType, string> = {
  AGREEMENT: "Agreement",
  NDA: "NDA",
  SOW: "Scope of work",
  PROPOSAL: "Proposal",
  DESIGN: "Design",
  SIGN_OFF: "Sign-off",
  HANDOVER: "Handover",
  REPORT: "Report",
  OTHER: "Other",
};

export const riskKindLabels: Record<ProjectRiskKind, string> = {
  RISK: "Risk",
  ISSUE: "Issue",
};

export const riskSeverityLabels: Record<ProjectRiskSeverity, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  CRITICAL: "Critical",
};

export const riskSeverityTone: Record<ProjectRiskSeverity, Tone> = {
  LOW: "default",
  MEDIUM: "blue",
  HIGH: "amber",
  CRITICAL: "red",
};

export const riskStatusLabels: Record<ProjectRiskStatus, string> = {
  OPEN: "Open",
  MITIGATING: "Being handled",
  RESOLVED: "Resolved",
  ACCEPTED: "Accepted",
  CLOSED: "Closed",
};

/** Still needs somebody's attention. `ACCEPTED` does not — it was a decision. */
export function riskIsOpen(status: ProjectRiskStatus) {
  return status === "OPEN" || status === "MITIGATING";
}

export const billingStatusLabels: Record<ProjectBillingStatus, string> = {
  PENDING: "Not yet due",
  DUE: "Due",
  INVOICED: "Invoiced",
  PAID: "Paid",
  WAIVED: "Waived",
};

export const billingStatusTone: Record<ProjectBillingStatus, Tone> = {
  PENDING: "default",
  DUE: "amber",
  INVOICED: "blue",
  PAID: "green",
  WAIVED: "default",
};

/**
 * How far along, from the milestones rather than from somebody's impression.
 *
 * A project with no milestones reports `null`, not zero. Those are different statements — "nothing
 * done" and "nobody has said what done looks like" — and a progress bar sitting at 0% on a project
 * that is nearly finished is worse than no bar at all.
 */
export function milestoneProgress(milestones: { completedAt: Date | null }[]): {
  done: number;
  total: number;
  percent: number | null;
} {
  const total = milestones.length;
  const done = milestones.filter((m) => m.completedAt !== null).length;
  return { done, total, percent: total === 0 ? null : Math.round((done / total) * 100) };
}

/**
 * Days late against the promised end date, or null while there is nothing to be late for.
 *
 * Measured against `targetEndDate` even after it has passed, deliberately: a target quietly
 * replaced by the date it actually finished is a project that was never late.
 */
export function daysLate(
  project: { targetEndDate: Date | null; actualEndDate: Date | null; status: ProjectStatus },
  asOf: Date,
): number | null {
  if (!project.targetEndDate) return null;
  const end = project.actualEndDate ?? (isClosed(project.status) ? null : asOf);
  if (!end) return null;
  const days = Math.floor((end.getTime() - project.targetEndDate.getTime()) / 86400000);
  return days > 0 ? days : null;
}

/**
 * What a template's milestones become for a project starting on a given day.
 *
 * Pure so the dates can be checked without a database — an off-by-one here silently shifts every
 * due date on every project of that type.
 */
export function milestonesFromTemplate(
  template: { name: string; note: string | null; dayOffset: number; sortOrder: number }[],
  startDate: Date | null,
): { name: string; note: string | null; dueDate: Date | null; sortOrder: number }[] {
  return template
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((t, i) => ({
      name: t.name,
      note: t.note,
      // No start date means no due dates. Inventing them from today would date a project that
      // starts in three months as though it started this morning.
      dueDate: startDate ? new Date(startDate.getTime() + t.dayOffset * 86400000) : null,
      sortOrder: i,
    }));
}
