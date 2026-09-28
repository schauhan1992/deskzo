import { formatMoney } from "@/lib/billing/money";
import { PARTNER_REQUEST_KIND, PARTNER_STATUS } from "@/lib/console-shared/labels";
import { dayKeyLabel, plural } from "@/lib/console-shared/format";
import type { Tone } from "@/lib/console-shared/types";
import { PARTNER_ROUTES, type PartnerPageKey } from "@/lib/partners/nav";
import { PARTNER_ROLE_LABELS, type PartnerAuditAction, type PartnerAuditRow } from "@/lib/partners/types";

/**
 * A partner's activity log in words: a past-tense label for every action the log can hold (typed
 * against `PARTNER_AUDIT_ACTIONS`, so a new action without a label fails to compile), the kinds of
 * change the Activity page filters by (each one action prefix), who did it in plain words, a one-line
 * summary built from the few detail fields the log keeps (an email, a company, a statement number),
 * and the portal screen a row is about.
 *
 * Only whitelisted detail keys are ever read, each checked for its type — nothing else a row's detail
 * might hold reaches the page. Pure and client-safe.
 */

export const PARTNER_ACTION_LABELS: Record<PartnerAuditAction, { label: string; tone: Tone }> = {
  "auth.sign-in": { label: "Signed in", tone: "neutral" },
  "auth.sign-out": { label: "Signed out", tone: "neutral" },
  "auth.password.set": { label: "Chose a password", tone: "neutral" },
  "auth.two-factor.enrolled": { label: "Turned on two-factor", tone: "success" },
  "auth.two-factor.removed": { label: "Removed their authenticator", tone: "warning" },
  "account.password-link": { label: "Asked for a password link", tone: "neutral" },
  "account.rename": { label: "Changed their name", tone: "neutral" },
  "account.session.end": { label: "Ended one of their sessions", tone: "neutral" },
  "account.sessions.end-others": { label: "Signed out their other sessions", tone: "neutral" },
  "user.invite": { label: "Invited a user", tone: "brand" },
  "user.role": { label: "Changed a user's role", tone: "info" },
  "user.deactivate": { label: "Switched off a user", tone: "danger" },
  "user.reactivate": { label: "Switched a user back on", tone: "info" },
  "user.setup-link": { label: "Sent a new setup link", tone: "neutral" },
  "user.two-factor.reset": { label: "Reset a user's two-factor", tone: "warning" },
  "user.sessions.end": { label: "Signed a user out everywhere", tone: "warning" },
  "invite.create": { label: "Created an invitation code", tone: "brand" },
  "invite.end": { label: "Ended an invitation code", tone: "warning" },
  "link.create": { label: "Created a referral link", tone: "brand" },
  "link.end": { label: "Ended a referral link", tone: "warning" },
  "deal.register": { label: "Registered a company", tone: "brand" },
  "deal.withdraw": { label: "Withdrew a deal registration", tone: "neutral" },
  "deal.approve": { label: "Deal registration approved", tone: "success" },
  "deal.decline": { label: "Deal registration declined", tone: "warning" },
  "deal.won": { label: "Deal registration won", tone: "success" },
  "deal.expire": { label: "Deal registration expired", tone: "neutral" },
  "customer.signup": { label: "A new customer signed up", tone: "success" },
  "customer.assigned": { label: "A customer was assigned to you", tone: "success" },
  "customer.removed": { label: "A customer was moved to another partner", tone: "warning" },
  "terms.set": { label: "Commission terms were set", tone: "info" },
  "partner.create": { label: "Partner account created", tone: "brand" },
  "partner.update": { label: "Company details updated", tone: "info" },
  "partner.status": { label: "Partner account status changed", tone: "warning" },
  "profile.update": { label: "Updated the company profile", tone: "neutral" },
  "request.create": { label: "Sent a change request", tone: "info" },
  "request.withdraw": { label: "Withdrew a change request", tone: "neutral" },
  "request.approve": { label: "Change request approved", tone: "success" },
  "request.reject": { label: "Change request rejected", tone: "warning" },
  "payout.set": { label: "Payout details changed", tone: "warning" },
  "payout.reveal": { label: "Platform staff viewed your payout details", tone: "warning" },
  "commission.void": { label: "Commission voided", tone: "warning" },
  "commission.adjust": { label: "Commission adjusted", tone: "info" },
  "statement.generate": { label: "Statement drafted", tone: "neutral" },
  "statement.approve": { label: "Statement approved", tone: "success" },
  "statement.paid": { label: "Statement paid", tone: "success" },
  "statement.void": { label: "Statement voided", tone: "danger" },
  "statement.invoice-number": { label: "Set a statement's invoice number", tone: "neutral" },
  "export.commissions": { label: "Exported commissions", tone: "neutral" },
  "export.statement": { label: "Exported a statement", tone: "neutral" },
  "application.submit": { label: "Application sent", tone: "neutral" },
  "application.update": { label: "Application updated", tone: "neutral" },
  "application.convert": { label: "Application accepted", tone: "success" },
};

/** The kinds of change the Activity page filters by — each one prefix of the action names. */
export const PARTNER_ACTIVITY_KINDS = [
  { key: "auth", label: "Sign-ins" },
  { key: "account", label: "Own accounts" },
  { key: "user", label: "Team" },
  { key: "invite", label: "Invitation codes" },
  { key: "link", label: "Referral links" },
  { key: "deal", label: "Deal registrations" },
  { key: "customer", label: "Customers" },
  { key: "commission", label: "Commissions" },
  { key: "statement", label: "Statements" },
  { key: "export", label: "Exports" },
  { key: "profile", label: "Company profile" },
  { key: "request", label: "Change requests" },
  { key: "payout", label: "Payout details" },
  { key: "terms", label: "Commission terms" },
  { key: "partner", label: "Partner account" },
] as const;
export type PartnerActivityKind = (typeof PARTNER_ACTIVITY_KINDS)[number]["key"];

const isKnown = (action: string): action is PartnerAuditAction => Object.prototype.hasOwnProperty.call(PARTNER_ACTION_LABELS, action);

/** A row's words and colour. An action written by a newer release shows as itself rather than breaking the page. */
export function partnerActionLabel(action: string): { label: string; tone: Tone } {
  return isKnown(action) ? PARTNER_ACTION_LABELS[action] : { label: action, tone: "neutral" };
}

/**
 * Who did it, for people: a portal user by name (the address kept for a tooltip), platform staff as
 * the log names them, and the platform's own jobs in plain words rather than "script" or "system: tick".
 */
export function partnerActorParts(row: Pick<PartnerAuditRow, "actorKind" | "actorLabel">): { name: string; email: string | null; origin: string | null } {
  switch (row.actorKind) {
    case "PARTNER": {
      const m = /^(.*) \(([^()\s]+@[^()\s]+)\)$/.exec(row.actorLabel);
      return m ? { name: m[1]!, email: m[2]!, origin: null } : { name: row.actorLabel, email: null, origin: null };
    }
    case "STAFF":
      return { name: row.actorLabel, email: null, origin: "platform team" };
    case "PUBLIC":
      return { name: "Website", email: null, origin: "a public form" };
    default:
      return { name: "Automatic", email: null, origin: "done by the platform" };
  }
}

const text = (value: unknown, max = 120): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function money(detail: Record<string, unknown>, key: string): string | null {
  const minor = count(detail[key]);
  const currency = text(detail.currency, 3);
  return minor !== null && currency ? formatMoney(minor, currency) : null;
}

function roleLabel(value: unknown): string | null {
  const role = text(value, 20);
  return role && Object.prototype.hasOwnProperty.call(PARTNER_ROLE_LABELS, role) ? PARTNER_ROLE_LABELS[role as keyof typeof PARTNER_ROLE_LABELS] : null;
}

function statusLabel(value: unknown): string | null {
  const status = text(value, 20);
  return status && Object.prototype.hasOwnProperty.call(PARTNER_STATUS, status) ? PARTNER_STATUS[status as keyof typeof PARTNER_STATUS].label : null;
}

/** "Legal name, address" from a list of changed field names — words only, never values. */
function fieldsLabel(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const words = value.filter((v): v is string => typeof v === "string" && /^[A-Za-z0-9 _-]{1,40}$/.test(v)).slice(0, 8);
  if (!words.length) return null;
  const spoken = words.map((w) => w.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase());
  const joined = spoken.join(", ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/**
 * The row in one line: the thing it is about (`subject`) and one detail worth knowing (`note`), from
 * the detail's whitelisted fields only. Either may be null.
 */
export function describePartnerActivity(row: Pick<PartnerAuditRow, "action" | "detail">): { subject: string | null; note: string | null } {
  const d = row.detail ?? {};
  const prefix = row.action.split(".")[0];
  switch (row.action) {
    case "auth.sign-in":
      return { subject: null, note: d.twoFactor === true ? "With two-factor" : null };
    case "account.sessions.end-others":
    case "user.sessions.end": {
      const n = count(d.sessions);
      return { subject: text(d.email, 254), note: n !== null ? plural(n, "session") : null };
    }
    case "user.invite":
      return { subject: text(d.email, 254), note: roleLabel(d.role) ? `As ${roleLabel(d.role)}` : null };
    case "user.role": {
      const from = roleLabel(d.from);
      const to = roleLabel(d.to);
      return { subject: text(d.email, 254), note: from && to ? `${from} → ${to}` : null };
    }
    case "invite.create": {
      const uses = count(d.uses);
      const days = count(d.days);
      return { subject: null, note: [uses !== null ? plural(uses, "use") : null, days !== null ? `lasts ${plural(days, "day")}` : null].filter(Boolean).join(" · ") || null };
    }
    case "partner.status": {
      const from = statusLabel(d.from);
      const to = statusLabel(d.to);
      return { subject: null, note: from && to ? `${from} → ${to}` : to };
    }
    case "partner.update":
    case "profile.update":
      return { subject: null, note: fieldsLabel(d.fields) };
    case "payout.set":
      return { subject: null, note: [text(d.country, 2), text(d.currency, 3)].filter(Boolean).join(" · ") || null };
    case "terms.set": {
      const from = text(d.from, 10);
      return { subject: null, note: from && DAY.test(from) ? `In force from ${dayKeyLabel(from)}` : null };
    }
    case "commission.void":
      return { subject: null, note: money(d, "amount") };
    case "commission.adjust":
      return { subject: text(d.workspace), note: money(d, "amount") };
    case "statement.approve":
      return { subject: text(d.statement, 40), note: money(d, "netPayable") ? `Net payable ${money(d, "netPayable")}` : null };
    case "statement.paid":
      return { subject: text(d.statement, 40), note: money(d, "netPayable") ? `${money(d, "netPayable")} paid` : null };
    case "statement.invoice-number":
      return { subject: text(d.statement, 40), note: text(d.invoiceNumber, 60) ? `Invoice ${text(d.invoiceNumber, 60)}` : null };
    case "export.commissions": {
      const rows = count(d.rows);
      return { subject: null, note: rows !== null ? plural(rows, "row") : null };
    }
    case "export.statement": {
      const rows = count(d.rows);
      return { subject: text(d.statement, 40), note: rows !== null ? plural(rows, "row") : null };
    }
    case "request.create":
    case "request.withdraw":
    case "request.approve":
    case "request.reject": {
      const kind = text(d.kind, 20);
      return { subject: kind && Object.prototype.hasOwnProperty.call(PARTNER_REQUEST_KIND, kind) ? PARTNER_REQUEST_KIND[kind as keyof typeof PARTNER_REQUEST_KIND].label : null, note: null };
    }
    default:
      break;
  }
  switch (prefix) {
    case "user":
      return { subject: text(d.email, 254), note: null };
    case "link":
      return { subject: text(d.code, 40), note: null };
    case "deal":
      return { subject: text(d.companyName), note: text(d.domain, 253) };
    case "customer":
      return { subject: text(d.workspace), note: null };
    case "statement":
      return { subject: text(d.statement, 40), note: null };
    default:
      return { subject: null, note: null };
  }
}

/**
 * The portal screen a row is about, where there is one this user may open (`canOpen`, from the nav
 * registry): the team, invitations, deal registrations, commissions, a statement (by the number the
 * row carries), the company profile. A voided statement links to the list: the portal shows only
 * approved and paid ones. A workspace row does not link — the log keeps its name, not its address.
 */
export function partnerEntityHref(row: Pick<PartnerAuditRow, "entity" | "action" | "detail">, canOpen: (key: PartnerPageKey) => boolean): { href: string; label: string } | null {
  const go = (key: PartnerPageKey, href: string, label: string) => (canOpen(key) ? { href, label } : null);
  switch (row.entity) {
    case "user":
      return row.action.startsWith("user.") ? go("team", PARTNER_ROUTES.team, "Team") : null;
    case "invite":
    case "link":
      return go("invitations", PARTNER_ROUTES.invitations, "Invitations");
    case "deal":
      return go("deals", PARTNER_ROUTES.deals, "Deals");
    case "commission":
      return go("commissions", PARTNER_ROUTES.commissions, "Commissions");
    case "statement": {
      const number = text(row.detail?.statement, 40);
      return number && row.action !== "statement.void" ? go("statements", PARTNER_ROUTES.statement(number), "Statement") : go("statements", PARTNER_ROUTES.statements, "Statements");
    }
    case "partner":
    case "request":
    case "payout":
    case "terms":
      return go("profile", PARTNER_ROUTES.profile, "Profile");
    default:
      return null;
  }
}
