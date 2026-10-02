import { formatMoney } from "@/lib/billing/money";
import { dayKeyLabel, dayMonth, dayMonthYear, istDaysBetween, plural, when } from "@/lib/console-shared/format";
import type {
  AlertCategory,
  AlertSeverity,
  AnnouncementTab,
  BillingTab,
  DirectorySort,
  DirectoryView,
  InviteState,
  StuckStage,
  SupportAssigneeFilter,
  SupportStatusTab,
  TerminalState,
  TrialView,
  WorkspaceTab,
} from "@/lib/console-shared/params";
import type {
  AuditCategoryKey,
  ConsoleRole,
  GatewayKey,
  InvoiceStatusKey,
  PlanKindKey,
  PlatformEnv,
  StandingKind,
  SubscriptionStatusKey,
  TenantStatusKey,
  Tone,
} from "@/lib/console-shared/types";
import type { SupportPriorityKey, SupportStatusKey } from "@/lib/support/types";
import type {
  AttributionSource,
  CommissionKind,
  CommissionStatus,
  DealStatus,
  PartnerApplicationStatus,
  PartnerKind,
  PartnerRequestKind,
  PartnerRequestStatus,
  PartnerStatus,
  StatementStatus,
} from "@deskzo/control-client";

/**
 * How the console names things: status pills, standing, audit entries, jobs, schemas, actors.
 * Every label and tone the console shows comes from here (spec §1.3), so a status reads the same on
 * every page, in every table and in every chart legend.
 *
 * One rule runs through all of it: text shared between roles never contains the phrases kept for the
 * roles allowed to act (`FORBIDDEN_FOR_SUPPORT`) — audit titles are past tense ("Workspace held").
 */

type Label = { label: string; tone: Tone };

/** The phrases only the roles allowed to act may ever see, anywhere in a page. */
export const FORBIDDEN_FOR_SUPPORT = ["Hold workspace", "Close workspace", "Add someone"] as const;

const has = <T extends object>(map: T, key: string): key is Extract<keyof T, string> => Object.prototype.hasOwnProperty.call(map, key);

// ─── Workspaces and standing ─────────────────────────────────────────────────────────────────────

export const TENANT_STATUS: Record<TenantStatusKey, Label> = {
  ACTIVE: { label: "Active", tone: "success" },
  PROVISIONING: { label: "Setting up", tone: "info" },
  SUSPENDED: { label: "Held", tone: "warning" },
  MIGRATING: { label: "Migration held", tone: "danger" },
  DEPROVISIONED: { label: "Closed", tone: "neutral" },
};

/** The sub-line under "Held". */
export const HELD_FOR: Record<"STAFF" | "BILLING", Label> = {
  STAFF: { label: "held by staff", tone: "warning" },
  BILLING: { label: "held for billing", tone: "danger" },
};

/** A standing's name without its date — filters, legends, audit summaries. */
export const STANDING_KIND_LABEL: Record<StandingKind, string> = {
  exempt: "Exempt",
  paid: "Paid",
  trial: "Trial",
  "trial-over": "Trial over",
  "past-due": "Past due",
  ending: "Cancelled",
  lapsed: "Lapsed",
  none: "No plan",
};

const validDate = (at: Date | string | null): Date | null => {
  if (at === null || at === "") return null;
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * A workspace's billing standing as a pill: "Trial · 5 days left", "Past due · hold 12 Oct". `at` is
 * the standing's date (`standingDate`); days are counted from the loader's `asOf`, never from the
 * reader's clock, so the server and the browser agree.
 */
export function standingLabel(kind: StandingKind, at: Date | string | null, asOf: Date | string): Label {
  const date = validDate(at);
  switch (kind) {
    case "exempt":
      return { label: "Exempt", tone: "neutral" };
    case "paid":
      return { label: "Paid", tone: "success" };
    case "trial": {
      const now = validDate(asOf);
      if (!date || !now) return { label: "Trial", tone: "info" };
      const days = istDaysBetween(now, date);
      if (days < 0) return { label: `Trial · ended ${dayMonth(date)}`, tone: "info" };
      return { label: days === 0 ? "Trial · ends today" : `Trial · ${plural(days, "day")} left`, tone: "info" };
    }
    case "trial-over":
      return { label: date ? `Trial over · hold ${dayMonth(date)}` : "Trial over", tone: "warning" };
    case "past-due":
      return { label: date ? `Past due · hold ${dayMonth(date)}` : "Past due", tone: "danger" };
    case "ending":
      return { label: date ? `Cancelled · ends ${dayMonth(date)}` : "Cancelled", tone: "warning" };
    case "lapsed":
      return { label: "Lapsed", tone: "danger" };
    default:
      return { label: "No plan", tone: "neutral" };
  }
}

/** The directory's "pays through" filter. */
export const DIRECTORY_GATEWAY_LABELS: Record<"STRIPE" | "RAZORPAY" | "TRIAL" | "GIVEN" | "NONE", string> = {
  STRIPE: "Stripe",
  RAZORPAY: "Razorpay",
  TRIAL: "On a trial",
  GIVEN: "Given by hand",
  NONE: "No plan",
};

export const DIRECTORY_VIEW_LABELS: Record<DirectoryView, string> = {
  all: "All",
  attention: "Needs attention",
  trials: "Trials",
  "past-due": "Past due",
  held: "Held",
  "setting-up": "Setting up",
  behind: "Behind schema",
  closed: "Closed",
};

export const DIRECTORY_SORT_LABELS: Record<DirectorySort, string> = {
  "-created": "Newest",
  created: "Oldest",
  name: "Name A–Z",
  "-seats": "Seats used",
  trial: "Trial ends soonest",
  standing: "Standing",
};

export const WORKSPACE_TAB_LABELS: Record<WorkspaceTab, string> = {
  overview: "Overview",
  plan: "Plan & modules",
  billing: "Billing",
  usage: "Usage",
  support: "Support",
  operations: "Operations",
  activity: "Activity",
  notes: "Notes",
};

export const TRIAL_VIEW_LABELS: Record<TrialView, string> = { ending: "Ending soon", later: "Later", grace: "In grace", held: "Held", all: "All" };

// ─── Jobs, runs, schemas ─────────────────────────────────────────────────────────────────────────

export const JOB_STATUS: Record<"PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED", Label> = {
  PENDING: { label: "Waiting", tone: "neutral" },
  RUNNING: { label: "Running", tone: "info" },
  SUCCEEDED: { label: "Done", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
};

/** A migration run's outcome: null while it is still going. */
export function runOutcome(ok: boolean | null): Label {
  if (ok === true) return { label: "Done", tone: "success" };
  if (ok === false) return { label: "Failed", tone: "danger" };
  return { label: "Running", tone: "info" };
}

/** A scheduled job's lease: running now, or how its last run ended. */
export function leaseOutcome(l: { lastOk: boolean | null; runningNow: boolean }): Label {
  if (l.runningNow) return { label: "Running", tone: "info" };
  if (l.lastOk === true) return { label: "OK", tone: "success" };
  if (l.lastOk === false) return { label: "Failed", tone: "danger" };
  return { label: "Never run", tone: "neutral" };
}

const JOB_NAMES: Record<string, string> = {
  "platform-tick": "Platform tick",
  "usage-snapshot": "Usage snapshot",
  "backup-tick": "Backups",
  "marketing-tick": "Marketing",
  migrate: "Migrations",
  "warm-pool": "Warm pool",
};

/** "platform-tick" → "Platform tick"; a job this list does not know keeps its own name. */
export function jobLabel(job: string): string {
  return has(JOB_NAMES, job) ? JOB_NAMES[job] : job;
}

/** "20260928100000_billing" → "billing · 28 Sep 2026"; null → "none"; a name of another shape as it is. */
export function schemaLabel(name: string | null): string {
  if (!name) return "none";
  const match = /^(\d{4})(\d{2})(\d{2})\d{6}_(.+)$/.exec(name);
  if (!match) return name;
  const day = dayKeyLabel(`${match[1]}-${match[2]}-${match[3]}`);
  if (day === `${match[1]}-${match[2]}-${match[3]}`) return name;
  return `${match[4].replace(/_/g, " ")} · ${day}`;
}

/** A schema pill: "Up to date", "Behind 3" (the raw name for its title), or "Unknown". */
export function schemaStatus(version: string | null, latest: string | null, behindBy: number | null): Label & { title: string | null } {
  if (version && latest && version === latest) return { label: "Up to date", tone: "success", title: version };
  if (version && behindBy !== null && behindBy > 0) return { label: `Behind ${behindBy}`, tone: "warning", title: version };
  if (version && behindBy === 0) return { label: "Up to date", tone: "success", title: version };
  return { label: "Unknown", tone: "neutral", title: version };
}

// ─── Billing ─────────────────────────────────────────────────────────────────────────────────────

export const SUBSCRIPTION_STATUS: Record<SubscriptionStatusKey, Label> = {
  INCOMPLETE: { label: "Incomplete", tone: "neutral" },
  TRIALING: { label: "Trialing", tone: "info" },
  ACTIVE: { label: "Active", tone: "success" },
  PAST_DUE: { label: "Past due", tone: "danger" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

/** The extra chip on a subscription set to cancel. */
export const ENDS_AT_PERIOD_END: Label = { label: "Ends at period end", tone: "warning" };

export const INVOICE_STATUS: Record<InvoiceStatusKey, Label> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  OPEN: { label: "Open", tone: "info" },
  PAID: { label: "Paid", tone: "success" },
  VOID: { label: "Void", tone: "neutral" },
  UNCOLLECTIBLE: { label: "Uncollectible", tone: "danger" },
};

export const EVENT_STATE: Record<"processed" | "failed" | "waiting", Label> = {
  processed: { label: "Processed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  waiting: { label: "Waiting", tone: "warning" },
};

/** What kind of subscription it is: a trial and a plan given by hand are both MANUAL. */
export function subscriptionKind(gateway: GatewayKey, status: SubscriptionStatusKey): string {
  if (gateway === "MANUAL") return status === "TRIALING" ? "Trial" : "Given by hand";
  return gatewayLabel(gateway);
}

export function gatewayLabel(g: GatewayKey): string {
  return g === "STRIPE" ? "Stripe" : g === "RAZORPAY" ? "Razorpay" : "Manual";
}

export function intervalLabel(i: "MONTH" | "YEAR" | null): string {
  return i === "MONTH" ? "month" : i === "YEAR" ? "year" : "—";
}

export function planKindLabel(k: PlanKindKey): string {
  return k === "EDITION" ? "Edition" : k === "BUNDLE" ? "Bundle" : k === "ADDON" ? "Add-on" : "Internal";
}

export const BILLING_TAB_LABELS: Record<BillingTab, string> = { overview: "Overview", invoices: "Invoices", subscriptions: "Subscriptions", events: "Events" };

/** "trial:2026-10-01:7" → "7-day trial reminder for 1 Oct" — a BillingNotice key (src/lib/billing/lifecycle.ts). */
export function noticeLabel(key: string): string {
  const match = /^(trial|hold):(\d{4}-\d{2}-\d{2}):(\d{1,3})$/.exec(key);
  if (!match) return key;
  const day = dayKeyLabel(match[2], false);
  return `${Number(match[3])}-day ${match[1]} reminder for ${day}`;
}

// ─── Platform ────────────────────────────────────────────────────────────────────────────────────

export const ALERT_SEVERITY: Record<AlertSeverity, Label> = {
  critical: { label: "Critical", tone: "danger" },
  warning: { label: "Warning", tone: "warning" },
  info: { label: "Info", tone: "info" },
};

export const ALERT_CATEGORY_LABELS: Record<AlertCategory, string> = {
  setup: "Setup",
  migrations: "Migrations",
  billing: "Billing",
  trials: "Trials",
  jobs: "Background jobs",
  reference: "Reference",
  security: "Security",
  workspaces: "Workspaces",
};

export const HEALTH_STATUS: Record<"ok" | "warn" | "fail" | "off", Label> = {
  ok: { label: "OK", tone: "success" },
  warn: { label: "Check", tone: "warning" },
  fail: { label: "Failing", tone: "danger" },
  off: { label: "Off", tone: "neutral" },
};

export const TERMINAL_STATE: Record<TerminalState, Label> = {
  live: { label: "Live", tone: "success" },
  quiet: { label: "Quiet", tone: "info" },
  stale: { label: "Stale", tone: "warning" },
  never: { label: "Never seen", tone: "neutral" },
};

export const SYNC_STATUS: Record<"never" | "RUNNING" | "SUCCEEDED" | "FAILED" | "stale", Label> = {
  never: { label: "Never synced", tone: "neutral" },
  RUNNING: { label: "Running", tone: "info" },
  SUCCEEDED: { label: "Up to date", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  stale: { label: "Stale", tone: "warning" },
};

export const ENV_LABEL: Record<PlatformEnv["key"], { label: PlatformEnv["label"]; tone: PlatformEnv["tone"] }> = {
  production: { label: "Production", tone: "danger" },
  staging: { label: "Staging", tone: "warning" },
  development: { label: "Development", tone: "info" },
};

// ─── Customers ───────────────────────────────────────────────────────────────────────────────────

export const INVITE_STATE: Record<InviteState, Label> = {
  live: { label: "Live", tone: "success" },
  used: { label: "Used up", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
  ended: { label: "Ended", tone: "neutral" },
};

/** What a staff rule about workspace names does (WorkspaceNameRule.kind), in words. */
export const NAME_RULE_KIND: Record<"BLOCK_EXACT" | "BLOCK_WORD" | "RELEASE", Label> = {
  BLOCK_EXACT: { label: "Blocked: this exact name", tone: "warning" },
  BLOCK_WORD: { label: "Blocked: any name with this word", tone: "warning" },
  RELEASE: { label: "Released: a built-in word let through", tone: "info" },
};

export const SIGNUP_STAGE: Record<StuckStage, Label> = {
  "never-verified": { label: "Code not entered", tone: "warning" },
  "setup-stuck": { label: "Setup stuck", tone: "danger" },
  "never-landed": { label: "Never signed in", tone: "info" },
};

export const ANNOUNCEMENT_TONE: Record<"INFO" | "WARNING" | "CRITICAL", Label> = {
  INFO: { label: "Info", tone: "info" },
  WARNING: { label: "Warning", tone: "warning" },
  CRITICAL: { label: "Critical", tone: "danger" },
};

export const ANNOUNCEMENT_STATE: Record<AnnouncementTab, Label> = {
  live: { label: "Live", tone: "success" },
  scheduled: { label: "Scheduled", tone: "info" },
  ended: { label: "Ended", tone: "neutral" },
  archived: { label: "Archived", tone: "neutral" },
};

// ─── Support requests ────────────────────────────────────────────────────────────────────────────

export const SUPPORT_STATUS: Record<SupportStatusKey, Label> = {
  OPEN: { label: "Open", tone: "info" },
  IN_PROGRESS: { label: "In progress", tone: "brand" },
  WAITING: { label: "Waiting on customer", tone: "warning" },
  RESOLVED: { label: "Resolved", tone: "success" },
  CLOSED: { label: "Closed", tone: "neutral" },
};

export const SUPPORT_PRIORITY: Record<SupportPriorityKey, Label> = {
  LOW: { label: "Low", tone: "neutral" },
  NORMAL: { label: "Normal", tone: "info" },
  HIGH: { label: "High", tone: "warning" },
  URGENT: { label: "Urgent", tone: "danger" },
};

export const SUPPORT_STATUS_TAB_LABELS: Record<SupportStatusTab, string> = { open: "Open", waiting: "Waiting", resolved: "Resolved", closed: "Closed", all: "All" };
export const SUPPORT_ASSIGNEE_LABELS: Record<SupportAssigneeFilter, string> = { anyone: "Anyone", me: "Assigned to me", unassigned: "Unassigned" };

/** A support grant: its level while live, otherwise how it stopped. */
export function grantLabel(state: "live" | "expired" | "ended", level: "READONLY" | "ADMIN" | null): Label {
  if (state === "live") return level === "ADMIN" ? { label: "Administrator", tone: "warning" } : { label: "Read-only", tone: "info" };
  return state === "expired" ? { label: "Expired", tone: "neutral" } : { label: "Ended", tone: "neutral" };
}

// ─── Partners ────────────────────────────────────────────────────────────────────────────────────
// The partner portal draws its pills from these same maps, which is one more reason this file stays
// client-safe: the enums come in as types only.

export const PARTNER_KIND: Record<PartnerKind, Label> = {
  DISTRIBUTOR: { label: "Distributor", tone: "brand" },
  RESELLER: { label: "Reseller", tone: "info" },
};

export const PARTNER_STATUS: Record<PartnerStatus, Label> = {
  ONBOARDING: { label: "Onboarding", tone: "info" },
  ACTIVE: { label: "Active", tone: "success" },
  SUSPENDED: { label: "Suspended", tone: "warning" },
  TERMINATED: { label: "Terminated", tone: "neutral" },
};

/** How a workspace came to belong to its partner. */
export const ATTRIBUTION_SOURCE: Record<AttributionSource, Label> = {
  SIGNUP_INVITE: { label: "Invitation code", tone: "neutral" },
  REFERRAL_LINK: { label: "Referral link", tone: "neutral" },
  DEAL_REGISTRATION: { label: "Deal registration", tone: "neutral" },
  TERRITORY: { label: "Territory", tone: "neutral" },
  STAFF: { label: "Assigned by staff", tone: "neutral" },
};

export const DEAL_STATUS: Record<DealStatus, Label> = {
  PENDING: { label: "Pending", tone: "warning" },
  APPROVED: { label: "Approved", tone: "success" },
  DECLINED: { label: "Declined", tone: "neutral" },
  WON: { label: "Won", tone: "brand" },
  EXPIRED: { label: "Expired", tone: "neutral" },
  WITHDRAWN: { label: "Withdrawn", tone: "neutral" },
};

export const COMMISSION_STATUS: Record<CommissionStatus, Label> = {
  PENDING: { label: "Pending", tone: "info" },
  APPROVED: { label: "Approved", tone: "success" },
  PAID: { label: "Paid", tone: "neutral" },
  VOID: { label: "Void", tone: "neutral" },
};

export const COMMISSION_KIND: Record<CommissionKind, Label> = {
  DIRECT: { label: "Direct", tone: "neutral" },
  OVERRIDE: { label: "Override", tone: "neutral" },
  ADJUSTMENT: { label: "Adjustment", tone: "neutral" },
};

export const STATEMENT_STATUS: Record<StatementStatus, Label> = {
  DRAFT: { label: "Draft", tone: "warning" },
  APPROVED: { label: "Approved — to pay", tone: "info" },
  PAID: { label: "Paid", tone: "success" },
  VOID: { label: "Void", tone: "neutral" },
};

export const PARTNER_REQUEST_KIND: Record<PartnerRequestKind, Label> = {
  PROFILE: { label: "Profile change", tone: "neutral" },
  PAYOUT: { label: "Payout details change", tone: "neutral" },
  NEW_RESELLER: { label: "New reseller", tone: "neutral" },
};

export const PARTNER_REQUEST_STATUS: Record<PartnerRequestStatus, Label> = {
  PENDING: { label: "Pending", tone: "warning" },
  APPROVED: { label: "Approved", tone: "success" },
  REJECTED: { label: "Rejected", tone: "neutral" },
  WITHDRAWN: { label: "Withdrawn", tone: "neutral" },
};

export const PARTNER_APPLICATION_STATUS: Record<PartnerApplicationStatus, Label> = {
  NEW: { label: "New", tone: "info" },
  REVIEWING: { label: "Reviewing", tone: "warning" },
  ACCEPTED: { label: "Accepted", tone: "success" },
  DECLINED: { label: "Declined", tone: "neutral" },
  SPAM: { label: "Spam", tone: "neutral" },
};

// ─── Staff ───────────────────────────────────────────────────────────────────────────────────────

export const ROLE_LABEL: Record<ConsoleRole, Label> = {
  OWNER: { label: "Owner", tone: "brand" },
  ADMIN: { label: "Admin", tone: "info" },
  SUPPORT: { label: "Support", tone: "success" },
  BILLING: { label: "Billing", tone: "warning" },
  READONLY: { label: "Read-only", tone: "neutral" },
};

export const STAFF_STATE: Record<"active" | "off", Label> = {
  active: { label: "Active", tone: "success" },
  off: { label: "Switched off", tone: "neutral" },
};

/** "Set up 3 Mar", or "Not yet" — a warning while the policy requires an authenticator. */
export function twoFactorLabel(enrolledAt: Date | string | null, required: boolean): Label {
  const at = validDate(enrolledAt);
  if (at) return { label: `Set up ${dayMonth(at)}`, tone: "success" };
  return { label: "Not yet", tone: required ? "warning" : "neutral" };
}

// ─── Audit log ───────────────────────────────────────────────────────────────────────────────────

/** Every action the platform writes to its audit log, as people read it (spec §5.12.2). */
export const ACTION_LABELS: Record<string, string> = {
  "tenant.suspend": "Workspace held",
  "tenant.resume": "Workspace reopened",
  "tenant.deprovision": "Workspace closed",
  "tenant.purge": "Workspace purged",
  "tenant.provision.requested": "Workspace requested",
  "tenant.provision.done": "Workspace set up",
  "tenant.keys.from-backup": "Keys restored from a backup",
  "tenant.adopt": "Workspace adopted",
  "tenant.adopt.refresh": "Adopted workspace refreshed",

  "tenant.plans": "Plans changed",
  "tenant.plans.manual-ended": "Hand-given plan ended",
  "tenant.module-override": "Module override changed",
  "tenant.limit-override": "Limits overridden",
  "tenant.trial": "Trial end changed",
  "tenant.trial.given": "Trial plans given free",
  "tenant.billing-details": "Billing details changed",
  "plan.create": "Plan created",
  "plan.update": "Plan updated",
  "plan.price": "Price added",
  "plan.price.retire": "Price taken off sale",
  "billing.keys": "Gateway keys changed",
  "billing.settings": "Signup and trial settings changed",
  "billing.apply": "Billing rules applied",
  "billing.resync": "Subscription resynced",
  "billing.event.replay": "Webhook replayed",
  "billing.event.view-raw": "Webhook payload viewed",
  "billing.lifecycle.run": "Billing lifecycle run",
  "cms.admin.invite": "Website CMS admin invited",
  "cms.admin.setup-link": "Website CMS set-password link sent",
  "tenant.domain.remove": "Workspace address removed",
  "tenant.domain.add": "Workspace address added",
  "tenant.domain.check": "Workspace address checked",
  "tenant.domain.verified": "Workspace address verified",
  "tenant.domain.broken": "Workspace address stopped",
  "tenant.domain.recovered": "Workspace address working again",
  "tenant.domain.primary": "Primary address changed",
  "tenant.domain.expired": "Unproved address removed",
  "tenant.domain.mail": "Owner told about a failing address",
  "domains.settings": "Custom domains setting changed",
  "bulk.apply-standing": "Billing rules applied to a batch",
  "bulk.trial-extend": "Trials extended in bulk",
  "export.invoices": "Invoices exported",

  "tenant.migration.failed": "Migration failed",
  "migrate.workspace": "Migration run",
  "provision.retry": "Setup retried",
  "warm-pool.top-up": "Warm pool topped up",
  "tenant.role-limits": "Role limits re-applied",

  "invite.create": "Invitation created",
  "invite.end": "Invitation ended",
  "invite.extend": "Invitation extended",
  "invite.hold": "Address held on an invitation",

  "names.block": "Workspace name blocked",
  "names.unblock": "Workspace name unblocked",
  "names.release": "Reserved name released",
  "names.unrelease": "Reserved name blocked again",

  "partner.create": "Partner created",
  "partner.update": "Partner updated",
  "partner.status": "Partner status changed",
  "partner.terms": "Commission terms set",
  "partner.user.invite": "Partner user invited",
  "partner.user.setup-link": "Partner set-password link sent",
  "partner.user.deactivate": "Partner user switched off",
  "partner.user.reactivate": "Partner user switched back on",
  "partner.user.two-factor.reset": "Partner user's two-factor reset",
  "partner.attribution": "Workspace's partner changed",
  "partner.attribution.review": "Partner attribution reviewed",
  "partner.attribution.signup": "Workspace attributed to a partner at signup",
  "partner.deal.decide": "Deal registration decided",
  "partner.request.decide": "Partner request decided",
  "partner.application.update": "Partner application updated",
  "partner.application.convert": "Partner application turned into a partner",
  "partner.payout.reveal": "Payout details viewed",
  "partner.payout.set": "Payout details set",
  "partner.commission.void": "Commission voided",
  "partner.commission.adjust": "Commission adjustment added",
  "partner.commissions.run": "Commissions worked out",
  "partner.statements.generate": "Statements generated",
  "partner.statement.approve": "Statement approved",
  "partner.statement.paid": "Statement marked paid",
  "partner.statement.void": "Statement voided",
  "partner.settings": "Partner programme settings changed",
  "export.partners": "Partners exported",
  "export.commissions": "Commissions exported",
  "export.partner-report": "Partner report exported",

  "device-route.release": "Terminal released",

  "reference.pin-key.save": "PIN directory key saved",
  "reference.pin-key.remove": "PIN directory key removed",
  "reference.pin.sync": "PIN directory sync started",
  "reference.world.sync": "World places sync started",

  "staff.create": "Staff member added",
  "staff.role": "Role changed",
  "staff.deactivate": "Staff member switched off",
  "staff.reactivate": "Staff member switched back on",
  "staff.sessions.end": "Sessions ended",
  "staff.session.end": "Session ended",
  "staff.two-factor.reset": "Two-factor reset",
  "staff.two-factor.policy": "Two-factor policy changed",
  "staff.setup-link": "Password link issued",
  "staff.sign-in": "Signed in",
  "staff.two-factor.enrolled": "Authenticator enrolled",
  "staff.password.set": "Password set",

  "support.enter": "Entered as support",
  "support.grant": "Support access granted",
  "support.end": "Support access ended",
  "support.request": "Support access requested",
  "support.reply": "Support request answered",
  "support.note": "Support request note added",
  "support.status": "Support request status changed",
  "support.priority": "Support request priority changed",
  "support.assign": "Support request assigned",
  "support.file.open": "Support attachment opened",
  "support.settings": "Support settings changed",

  "tenant.note.add": "Note added",
  "tenant.note.edit": "Note edited",
  "tenant.note.pin": "Note pinned or unpinned",
  "tenant.note.delete": "Note removed",
  "tenant.tags": "Tags changed",
  "bulk.tag": "Tags changed in bulk",

  "alert.ack": "Alert acknowledged",
  "alert.unack": "Alert reopened",
  "announcement.create": "Announcement created",
  "announcement.update": "Announcement updated",
  "announcement.end": "Announcement ended",
  "announcement.archive": "Announcement archived",
  // Help and What's new from Deskzo (src/actions/platform/console-help.ts).
  "help.article.create": "Help article created",
  "help.article.update": "Help article updated",
  "help.article.reorder": "Help articles reordered",
  "help.article.publish": "Help article published",
  "help.article.schedule": "Help article scheduled",
  "help.article.unpublish": "Help article taken down",
  "help.article.archive": "Help article archived",
  "help.article.restore": "Help article restored as a draft",
  "help.video.create": "Video created",
  "help.video.update": "Video updated",
  "help.video.reorder": "Videos reordered",
  "help.video.publish": "Video published",
  "help.video.schedule": "Video scheduled",
  "help.video.unpublish": "Video taken down",
  "help.video.archive": "Video archived",
  "help.video.restore": "Video restored as a draft",
  "help.post.create": "What's new post created",
  "help.post.update": "What's new post updated",
  "help.post.publish": "What's new post published",
  "help.post.schedule": "What's new post scheduled",
  "help.post.unpublish": "What's new post taken down",
  "help.post.archive": "What's new post archived",
  "help.post.restore": "What's new post restored as a draft",
  "export.workspaces": "Workspaces exported",
  "export.audit": "Audit log exported",
  "linked.settings": "Linked sign-in setting changed",
};

/**
 * The audit log's categories, by action prefix. An action belongs to the category with the longest
 * prefix it starts with; no prefix starts another category's, so a `startsWith` filter in a query
 * and `categoryOf` always agree.
 */
export const AUDIT_CATEGORIES: readonly { key: AuditCategoryKey; label: string; prefixes: readonly string[] }[] = [
  { key: "lifecycle", label: "Workspace lifecycle", prefixes: ["tenant.suspend", "tenant.resume", "tenant.deprovision", "tenant.purge", "tenant.provision", "tenant.keys", "tenant.domain"] },
  {
    key: "billing",
    label: "Plans and billing",
    prefixes: ["tenant.plans", "tenant.module-override", "tenant.limit-override", "tenant.trial", "tenant.billing-details", "plan.", "billing.", "bulk.apply-standing", "bulk.trial-extend", "export.invoices"],
  },
  { key: "staff", label: "Staff", prefixes: ["staff."] },
  { key: "support", label: "Support", prefixes: ["support."] },
  { key: "setup", label: "Setup and migrations", prefixes: ["provision.", "warm-pool.", "migrate.", "tenant.migration", "tenant.role-limits", "tenant.adopt"] },
  { key: "reference", label: "Reference data", prefixes: ["reference."] },
  { key: "invites", label: "Invitations", prefixes: ["invite."] },
  { key: "names", label: "Workspace names", prefixes: ["names."] },
  { key: "partners", label: "Partners", prefixes: ["partner.", "export.partners", "export.commissions", "export.partner-report"] },
  { key: "notes", label: "Notes and tags", prefixes: ["tenant.note.", "tenant.tags", "bulk.tag"] },
  { key: "terminals", label: "Terminals", prefixes: ["device-route."] },
  { key: "console", label: "Console", prefixes: ["alert.", "announcement.", "help.", "export.workspaces", "export.audit", "cms.", "linked.settings", "domains.settings"] },
];

export function categoryOf(action: string): AuditCategoryKey | null {
  let best: { key: AuditCategoryKey; length: number } | null = null;
  for (const category of AUDIT_CATEGORIES) {
    for (const prefix of category.prefixes) {
      if (action.startsWith(prefix) && (!best || prefix.length > best.length)) best = { key: category.key, length: prefix.length };
    }
  }
  return best?.key ?? null;
}

const ACTION_TONES: Record<string, Tone> = {
  "tenant.suspend": "warning",
  "tenant.resume": "success",
  "tenant.deprovision": "danger",
  "tenant.purge": "danger",
  "tenant.provision.requested": "info",
  "tenant.provision.done": "success",
  "tenant.plans.manual-ended": "warning",
  "tenant.domain.verified": "success",
  "tenant.domain.broken": "danger",
  "tenant.domain.recovered": "success",
  "tenant.domain.remove": "warning",
  "tenant.domain.mail": "warning",
  "plan.price.retire": "warning",
  "billing.keys": "warning",
  "billing.event.view-raw": "warning",
  "tenant.migration.failed": "danger",
  "invite.create": "success",
  "invite.hold": "info",
  "names.block": "warning",
  "names.release": "info",
  "device-route.release": "warning",
  "reference.pin-key.remove": "warning",
  "staff.create": "success",
  "staff.deactivate": "warning",
  "staff.reactivate": "success",
  "staff.sessions.end": "warning",
  "staff.session.end": "warning",
  "staff.two-factor.reset": "warning",
  "staff.two-factor.enrolled": "success",
  "staff.password.set": "success",
  "support.enter": "warning",
  "support.grant": "info",
  "support.request": "info",
  "support.reply": "success",
  "support.file.open": "info",
  "support.settings": "warning",
  "tenant.note.delete": "warning",
  "announcement.create": "success",
  "help.article.publish": "success",
  "help.article.unpublish": "warning",
  "help.video.publish": "success",
  "help.video.unpublish": "warning",
  "help.post.publish": "success",
  "help.post.unpublish": "warning",
  "partner.create": "success",
  "partner.user.deactivate": "warning",
  "partner.user.reactivate": "success",
  "partner.user.two-factor.reset": "warning",
  "partner.application.convert": "success",
  "partner.payout.reveal": "warning",
  "partner.payout.set": "warning",
  "partner.commission.void": "danger",
  "partner.statement.paid": "success",
  "partner.statement.void": "danger",
};

/** An audit entry's title, tone and category. Titles are past tense; an unknown action is its own title. */
export function auditLabel(action: string, detail: unknown): { title: string; tone: Tone; category: AuditCategoryKey | null } {
  const d = record(detail);
  let title = has(ACTION_LABELS, action) ? ACTION_LABELS[action] : action;
  let tone: Tone = has(ACTION_TONES, action) ? ACTION_TONES[action] : "neutral";
  switch (action) {
    case "tenant.suspend":
      if (d.kind === "BILLING") title = "Workspace held for billing";
      break;
    case "tenant.resume":
      if (d.billing === true) title = "Billing hold lifted";
      break;
    case "tenant.module-override":
      if (d.granted === true) title = "Module added";
      else if (d.granted === false) title = "Module taken away";
      else if ("granted" in d && d.granted === null) title = "Module override removed";
      break;
    case "tenant.note.pin":
      if (d.pinned === true) title = "Note pinned";
      else if (d.pinned === false) title = "Note unpinned";
      break;
    case "billing.apply":
      tone = d.action === "held" ? "warning" : d.action === "closed" ? "danger" : d.action === "lifted" ? "success" : "neutral";
      break;
    case "billing.event.replay":
      if (d.ok === false) {
        title = "Webhook replay failed";
        tone = "danger";
      } else if (d.ok === true) tone = "success";
      break;
    case "migrate.workspace":
      tone = d.ok === false ? "danger" : d.ok === true ? "success" : "neutral";
      break;
    case "staff.two-factor.policy":
      if (d.mode === "off") {
        title = "Two-factor turned off";
        tone = "warning";
      } else if (d.mode === "required") title = "Two-factor required";
      break;
    case "linked.settings":
      if (d.enabled === false) {
        title = "Linked sign-in switched off";
        tone = "warning";
      } else if (d.enabled === true) {
        title = "Linked sign-in switched on";
        tone = "success";
      }
      break;
    case "alert.ack":
      if (typeof d.snoozeUntil === "string" && d.snoozeUntil) title = "Alert snoozed";
      break;
    case "bulk.tag":
      if (d.add === true) title = "Tag added in bulk";
      else if (d.add === false) title = "Tag removed in bulk";
      break;
    case "partner.status": {
      // The status it was set to: `to` (or `status`) in the detail.
      const to = d.to ?? d.status;
      if (to === "TERMINATED") {
        title = "Partner terminated";
        tone = "danger";
      } else if (to === "SUSPENDED") {
        title = "Partner suspended";
        tone = "warning";
      } else if (to === "ACTIVE") {
        title = "Partner activated";
        tone = "success";
      } else if (to === "ONBOARDING") title = "Partner set back to onboarding";
      break;
    }
    case "partner.attribution":
      if ("to" in d && d.to === null) title = "Workspace made direct";
      break;
    case "partner.attribution.signup":
      if (d.flagged === true) tone = "warning";
      break;
    case "partner.deal.decide":
      if (d.decision === "APPROVE") {
        title = "Deal registration approved";
        tone = "success";
      } else if (d.decision === "DECLINE") title = "Deal registration declined";
      break;
    case "partner.request.decide":
      if (d.decision === "APPROVE") {
        title = "Partner request approved";
        tone = "success";
      } else if (d.decision === "REJECT") title = "Partner request rejected";
      break;
  }
  return { title, tone, category: categoryOf(action) };
}

/**
 * A one-line summary of an audit entry's detail — "crm ×1, seats ×2", "Admin → Billing". Null when
 * there is nothing a person would want. The detail holds no secrets by design; the console still
 * passes this through `redactSecrets` before showing it.
 */
export function auditSummary(action: string, detail: unknown): string | null {
  const d = record(detail);
  if (action.startsWith("help.")) return helpSummary(action, d);
  switch (action) {
    case "tenant.suspend":
      return join([d.kind === "BILLING" ? "for billing" : null, quote(d.reason)]);
    case "tenant.resume":
    case "tenant.purge":
    case "tenant.trial.given":
    case "tenant.note.edit":
    case "tenant.note.delete":
    case "tenant.note.pin":
    case "provision.retry":
    case "warm-pool.top-up":
    case "reference.pin-key.save":
    case "reference.pin-key.remove":
    case "reference.pin.sync":
    case "reference.world.sync":
    case "staff.two-factor.reset":
    case "staff.two-factor.enrolled":
    case "staff.password.set":
      return null;
    case "tenant.deprovision":
      return d.backup ? `final backup ${text(d.backup)}` : null;
    case "tenant.provision.requested":
      return text(d.slug);
    case "tenant.plans": {
      const plans = record(d.plans);
      const items = Object.entries(plans).map(([key, qty]) => `${key} ×${typeof qty === "number" ? qty : text(qty) ?? "?"}`);
      return items.length ? items.join(", ") : "no plans";
    }
    case "tenant.plans.manual-ended":
      return list(d.plans);
    case "tenant.module-override":
      return join([text(d.module), d.granted === true ? "added" : d.granted === false ? "taken away" : "override removed", quote(d.reason)]);
    case "tenant.limit-override":
      return join([`seats ${limitText(d.seats)}`, `copilot tokens ${limitText(d.copilotTokens)}`, "customDomains" in d ? `custom domains ${limitText(d.customDomains)}` : null]);
    case "tenant.domain.add":
    case "tenant.domain.verified":
    case "tenant.domain.broken":
    case "tenant.domain.recovered":
    case "tenant.domain.expired":
      return text(d.host);
    case "tenant.domain.remove":
      return join([text(d.host), quote(d.reason)]);
    case "tenant.domain.check":
      return join([text(d.host), text(d.outcome)]);
    case "tenant.domain.primary":
      return d.host ? text(d.host) : "back to its own address";
    case "tenant.domain.mail":
      return join([text(d.host), d.kind === "broken" ? "stopped" : d.kind === "failing" ? "failing" : null, d.mailed === false ? "no owner email" : null]);
    case "domains.settings":
      return typeof d.offered === "boolean" ? (d.offered ? "offered to workspaces" : "not offered") : null;
    case "tenant.trial":
      return join([date(d.endsAt) ? `ends ${dayMonthYear(date(d.endsAt))}` : null, typeof d.days === "number" ? `+${d.days} days` : null]);
    case "tenant.billing-details":
      return join([change("billing email", record(d.from).billingEmail, record(d.to).billingEmail), change("tax ID", record(d.from).taxId, record(d.to).taxId), quote(d.reason)]);
    case "tenant.role-limits":
      return text(d.role);
    case "tenant.migration.failed":
      return d.runId ? `run ${text(d.runId, 12)}` : null;
    case "plan.create":
    case "plan.update":
      return join([text(d.key), text(d.name)]);
    case "plan.price": {
      const amount = typeof d.amount === "number" && typeof d.currency === "string" ? formatMoney(d.amount, d.currency) : null;
      const interval = d.interval === "MONTH" || d.interval === "YEAR" ? ` / ${intervalLabel(d.interval)}` : "";
      return join([text(d.plan), amount ? `${amount}${interval}${d.perSeat === true ? " per person" : ""}` : null, gatewayText(d.gateway)]);
    }
    case "plan.price.retire":
      return join([text(d.plan), text(d.externalId)]);
    case "billing.keys":
      return list(d.changed);
    case "billing.settings":
      return join([
        typeof d.signupOpen === "boolean" ? (d.signupOpen ? "signup open" : "invite-only") : null,
        typeof d.trialDays === "number" ? `trials ${d.trialDays} days` : null,
        typeof d.autoDeprovision === "boolean" ? `auto-close ${d.autoDeprovision ? "on" : "off"}` : null,
      ]);
    case "billing.apply":
      return join([standingText(d.standing), outcomeText(d.action)]);
    case "billing.resync":
      return join([gatewayText(d.gateway), text(d.externalId), d.before && d.after ? `${subscriptionText(d.before)} → ${subscriptionText(d.after)}` : null]);
    case "billing.event.replay":
      return join([gatewayText(d.gateway), text(d.type), d.ok === true ? "processed" : d.ok === false ? "failed" : null]);
    case "billing.event.view-raw":
      return join([gatewayText(d.gateway), text(d.type)]);
    case "billing.lifecycle.run": {
      // The slug lists are capped at 50 in the audit row; `counts` carries the true totals.
      const c = record(d.counts);
      return join([counted(c.held ?? d.held, "held"), counted(c.lifted ?? d.lifted, "lifted"), counted(c.closed ?? d.closed, "closed"), counted(c.reminded ?? d.reminded, "reminded")]);
    }
    case "bulk.apply-standing":
      return join([workspaces(d.count), counted(d.held, "held"), counted(d.lifted, "lifted"), counted(d.closed, "closed"), failed(d.failed)]);
    case "bulk.trial-extend":
      return join([workspaces(d.count), typeof d.days === "number" ? `+${d.days} days` : null, counted(d.ok, "extended"), failed(d.failed)]);
    case "bulk.tag":
      return join([d.tag ? `${d.add === false ? "removed" : "added"} ${text(d.tag)}` : null, workspaces(d.count), failed(d.failed)]);
    case "export.workspaces":
    case "export.invoices":
    case "export.audit":
      return join([typeof d.rows === "number" ? plural(d.rows, "row") : null, typeof d.selected === "number" && d.selected > 0 ? `${d.selected} selected` : null]);
    case "migrate.workspace":
      return join([text(d.slug), d.ok === true ? "done" : d.ok === false ? "failed" : null]);
    case "invite.create":
      return join([quote(d.note), typeof d.days === "number" ? `valid ${d.days} days` : null, d.planKey ? `plan ${text(d.planKey)}` : null, d.heldSlug ? `holds ${text(d.heldSlug)}` : null]);
    case "invite.end":
      return d.heldSlug ? `${text(d.heldSlug)} no longer held` : null;
    case "invite.hold":
      return join([text(d.slug), d.skipsReserved === true ? "may be reserved or blocked" : null]);
    case "names.block":
      return join([text(d.value), d.kind === "BLOCK_WORD" ? "any name with this word" : d.kind === "BLOCK_EXACT" ? "this exact name" : null, quote(d.reason), typeof d.workspaces === "number" && d.workspaces > 0 ? `${plural(d.workspaces, "workspace")} ${d.workspaces === 1 ? "keeps" : "keep"} it` : null]);
    case "names.unblock":
      return join([text(d.value), d.kind === "BLOCK_WORD" ? "any name with this word" : d.kind === "BLOCK_EXACT" ? "this exact name" : null]);
    case "names.release":
      return join([text(d.value), quote(d.reason)]);
    case "names.unrelease":
      return text(d.value);
    case "invite.extend":
      return typeof d.days === "number" ? `+${d.days} days` : null;
    case "device-route.release":
      return d.serial ? `serial ${text(d.serial)}` : null;
    case "staff.create":
      return join([text(d.email), roleText(d.role)]);
    case "staff.role":
      return join([text(d.email), roleText(d.from) && roleText(d.to) ? `${roleText(d.from)} → ${roleText(d.to)}` : null]);
    case "staff.deactivate":
    case "staff.reactivate":
      return text(d.email);
    case "staff.sessions.end":
      return d.others === true ? "every other device" : null;
    case "staff.session.end":
      return d.session ? `session ${text(d.session, 12)}` : null;
    case "staff.two-factor.policy":
      return d.mode === "off" ? "off" : d.mode === "required" ? "required" : null;
    case "linked.settings":
      return d.enabled === false ? "every workspace, off" : d.enabled === true ? "every workspace, on" : null;
    case "staff.setup-link":
      return d.self === true ? "to their own address" : null;
    case "staff.sign-in":
      return d.twoFactor === true ? "with an authenticator code" : null;
    case "support.enter":
      return levelText(d.level);
    case "support.grant":
      return join([levelText(d.level), typeof d.hours === "number" ? `for ${d.hours} h` : null, d.by ? `by ${text(d.by)}` : null]);
    case "support.end":
      return d.by ? `by ${text(d.by)}` : null;
    case "support.request":
      return join([quote(d.reason), d.to ? `to ${text(d.to)}` : null]);
    case "support.reply":
      return join([supportNumber(d.number), d.emailed === true ? "emailed" : d.emailed === false ? "email failed" : null, charCount(d.length)]);
    case "support.note":
      return join([supportNumber(d.number), charCount(d.length)]);
    case "support.status":
      return join([supportNumber(d.number), labelChange(SUPPORT_STATUS, d.from, d.to)]);
    case "support.priority":
      return join([supportNumber(d.number), labelChange(SUPPORT_PRIORITY, d.from, d.to)]);
    case "support.assign":
      return join([supportNumber(d.number), d.to ? (d.toName ? `to ${text(d.toName)}` : "assigned") : "unassigned"]);
    case "support.file.open":
      return join([supportNumber(d.number), d.kind === "RECORDING" ? "recording" : d.kind === "FILE" ? "file" : null]);
    case "support.settings":
      return join([
        typeof d.enabled === "boolean" ? `Contact Support ${d.enabled ? "on" : "off"}` : null,
        typeof d.recording === "boolean" ? `recording ${d.recording ? "on" : "off"}` : null,
        typeof d.retentionDays === "number" ? `files kept ${d.retentionDays} days` : null,
        d.emailChanged === true ? "address changed" : null,
      ]);
    case "tenant.note.add":
      return d.pinned === true ? "pinned" : null;
    case "tenant.tags": {
      const added = strings(d.added).map((t) => `+${t}`);
      const removed = strings(d.removed).map((t) => `−${t}`);
      return [...added, ...removed].join(", ") || null;
    }
    case "alert.ack":
      return join([text(d.key), date(d.snoozeUntil) ? `until ${when(date(d.snoozeUntil))}` : null, quote(d.note)]);
    case "alert.unack":
      return text(d.key);
    case "announcement.create":
    case "announcement.update":
    case "announcement.end":
    case "announcement.archive":
      return join([quote(d.title), d.tone === "INFO" || d.tone === "WARNING" || d.tone === "CRITICAL" ? ANNOUNCEMENT_TONE[d.tone].label : null, audienceText(d.audience, d.targets)]);
    default:
      return genericSummary(d);
  }
}

/**
 * Where an audit entry leads: the workspace it was about, or the page the thing lives on. Only pages
 * every role may open — but for statements, which live on Commissions (the staff who sell).
 */
export function auditHref(action: string, detail: unknown, workspaceSlug: string | null): string | null {
  const d = record(detail);
  if (action.startsWith("partner.statement.") || action.startsWith("partner.statements.")) return "/commissions?tab=statements";
  // A workspace's partner changed: the workspace's own page shows who it belongs to (and the history).
  if (action.startsWith("partner.attribution") && workspaceSlug) return `/workspaces/${encodeURIComponent(workspaceSlug)}`;
  if (action.startsWith("partner.")) {
    // The partner is named by its slug (`detail.partner`); the programme's settings live on the list.
    const partner = text(d.partner)?.toLowerCase();
    if (partner && /^[a-z0-9][a-z0-9-]*$/.test(partner)) return `/partners/${encodeURIComponent(partner)}`;
    if (action === "partner.settings") return "/partners";
  }
  if (action.startsWith("plan.")) {
    const key = text(d.key) ?? text(d.plan);
    return key ? `/plans/${encodeURIComponent(key)}` : "/plans";
  }
  if (action.startsWith("announcement.")) {
    const id = text(d.id);
    return id ? `/announcements/${encodeURIComponent(id)}` : "/announcements";
  }
  if (action.startsWith("help.")) {
    const id = text(d.id);
    if (id) return `/help-content/${encodeURIComponent(id)}`;
    return action.startsWith("help.video.") ? "/help-content?tab=videos" : "/help-content";
  }
  if (action.startsWith("staff.")) return "/staff";
  if (action.startsWith("invite.")) return "/invites";
  if (action.startsWith("names.")) return "/names";
  if (action.startsWith("device-route.")) return "/devices";
  if (action.startsWith("reference.")) return "/reference";
  if (action.startsWith("alert.")) return "/alerts";
  if (action === "warm-pool.top-up") return "/provisioning#warm-pool";
  if (!workspaceSlug) return null;
  const tab: Partial<Record<AuditCategoryKey, string>> = { billing: "billing", support: "support", setup: "operations", notes: "notes", terminals: "operations" };
  const category = categoryOf(action);
  const on = category ? tab[category] : undefined;
  return `/workspaces/${encodeURIComponent(workspaceSlug)}${on ? `?tab=${on}` : ""}`;
}

/** Who did it: a staff member's name, or what a script or the system is called in the console. */
export function actorLabel(actorKind: "STAFF" | "SCRIPT" | "SYSTEM", actor: string, names: ReadonlyMap<string, string>): string {
  if (actorKind === "STAFF") return names.get(actor) ?? "A former staff member";
  if (actorKind === "SCRIPT") {
    // "script:<npm script>" kept as written ("script:linked-sign-in", the kill switch): the script is what follows.
    const scripted = /^script:([a-z][a-z0-9:-]*)$/.exec(actor);
    if (scripted) return `npm run ${scripted[1]}`;
    // An npm script ("tenants:migrate", "platform:adopt"), or a named job ("billing").
    return /^[a-z][a-z0-9-]*:[a-z0-9:-]+$/.test(actor) ? `npm run ${actor}` : actor || "a script";
  }
  if (actor.startsWith("workspace:")) return "workspace user";
  if (actor === "platform-worker") return "setup worker";
  return actor || "the platform";
}

// ─── Small helpers for the summaries ─────────────────────────────────────────────────────────────

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, max = 80): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const t = value.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const quote = (value: unknown) => {
  const t = text(value);
  return t ? `“${t}”` : null;
};

const join = (parts: (string | null | undefined)[]) => parts.filter((p): p is string => !!p).join(" · ") || null;

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map((v) => text(v, 40)).filter((v): v is string => !!v) : []);

function list(value: unknown): string | null {
  const items = strings(value);
  if (!items.length) return null;
  return items.length > 6 ? `${items.slice(0, 6).join(", ")} and ${items.length - 6} more` : items.join(", ");
}

function date(value: unknown): Date | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  return validDate(value);
}

/** An array of slugs or a number, as "2 held". */
function counted(value: unknown, what: string): string | null {
  const n = Array.isArray(value) ? value.length : typeof value === "number" ? value : null;
  return n === null ? null : `${n} ${what}`;
}

const workspaces = (value: unknown) => (typeof value === "number" ? plural(value, "workspace") : null);
const failed = (value: unknown) => (typeof value === "number" && value > 0 ? `${value} failed` : null);
const limitText = (value: unknown) => (typeof value === "number" ? value.toLocaleString("en-IN") : "from plans");
const gatewayText = (value: unknown) => (value === "STRIPE" || value === "RAZORPAY" || value === "MANUAL" ? gatewayLabel(value) : null);
const roleText = (value: unknown) => (typeof value === "string" && has(ROLE_LABEL, value) ? ROLE_LABEL[value].label : null);
const levelText = (value: unknown) => (value === "ADMIN" ? "Administrator" : value === "READONLY" ? "Read-only" : null);
const standingText = (value: unknown) => (typeof value === "string" && has(STANDING_KIND_LABEL, value) ? STANDING_KIND_LABEL[value] : null);
const subscriptionText = (value: unknown) => (typeof value === "string" && has(SUBSCRIPTION_STATUS, value) ? SUBSCRIPTION_STATUS[value].label : text(value));

const supportNumber = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) ? `SR-${value}` : null);
const charCount = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? plural(value, "character") : null);

/** "Open → In progress", from a label table; null unless both ends are in it. */
function labelChange(table: Record<string, Label>, from: unknown, to: unknown): string | null {
  const a = typeof from === "string" && has(table, from) ? table[from].label : null;
  const b = typeof to === "string" && has(table, to) ? table[to].label : null;
  return a && b ? `${a} → ${b}` : null;
}

function outcomeText(value: unknown): string | null {
  if (value === "held") return "held";
  if (value === "lifted") return "hold lifted";
  if (value === "closed") return "closed";
  if (value === "none") return "nothing to do";
  return null;
}

function change(what: string, from: unknown, to: unknown): string | null {
  const a = text(from) ?? "none";
  const b = text(to) ?? "none";
  return a === b ? null : `${what} ${a} → ${b}`;
}

/**
 * A help article's, video's or What's new post's change: its title, then what the entry adds — its
 * state and how narrowly it is aimed, when it goes live, what it was, or how much a reorder moved.
 */
function helpSummary(action: string, d: Record<string, unknown>): string | null {
  const state = d.state === "draft" ? "Draft" : d.state === "scheduled" ? "Scheduled" : d.state === "live" ? "Live" : null;
  const was = d.was === "scheduled" || d.was === "live" || d.was === "draft" ? `was ${d.was}` : null;
  const narrowed = [
    typeof d.modules === "number" && d.modules > 0 ? plural(d.modules, "module") : null,
    typeof d.countries === "number" && d.countries > 0 ? plural(d.countries, "country", "countries") : null,
  ].filter((p): p is string => !!p);
  const aimed = "modules" in d || "countries" in d ? (narrowed.length ? narrowed.join(", ") : "every workspace") : null;
  const at = d.state === "scheduled" || action.endsWith(".schedule") ? date(d.publishedAt) : null;
  const moved = typeof d.moved === "number" && typeof d.count === "number" ? `${d.moved} of ${d.count} moved` : null;
  return join([quote(d.title), state, d.pinned === true ? "pinned" : null, aimed, at ? `from ${when(at)}` : null, was, moved]);
}

function audienceText(audience: unknown, targets: unknown): string | null {
  const n = typeof targets === "number" ? targets : Array.isArray(targets) ? targets.length : null;
  if (audience === "ALL") return "All workspaces";
  if (audience === "TENANTS") return n === null ? "Chosen workspaces" : plural(n, "workspace");
  if (audience === "COUNTRIES") return n === null ? "Chosen countries" : plural(n, "country", "countries");
  if (audience === "PLANS") return n === null ? "Chosen plans" : plural(n, "plan");
  return null;
}

/** For an action this file does not know: up to four plain values, ids left out. */
function genericSummary(d: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(d)) {
    if (parts.length >= 4) break;
    if (key === "id" || /Id$|Hash|Prefix$/.test(key)) continue;
    if (typeof value === "boolean") parts.push(`${key} ${value ? "yes" : "no"}`);
    else {
      const t = text(value, 40);
      if (t) parts.push(`${key} ${t}`);
    }
  }
  return parts.length ? parts.join(" · ") : null;
}
