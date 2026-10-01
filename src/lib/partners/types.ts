import type {
  AttributionSource,
  CommissionKind,
  CommissionStatus,
  DealStatus,
  PartnerActorKind,
  PartnerApplicationStatus,
  PartnerKind,
  PartnerRequestKind,
  PartnerRequestStatus,
  PartnerRole,
  PartnerStatus,
  StatementStatus,
} from "@deskzo/control-client";

/**
 * The partner programme's shared vocabulary — roles and what each may do, the shapes the portal's
 * and the console's loaders and actions hand out, rates as basis points, and the one result type
 * every portal action answers with.
 *
 * Client-safe: plain data and types only (the control client is imported for its types alone), so
 * the portal's client components import from here freely. The server side is src/lib/partners/*.ts.
 */

export type {
  AttributionSource,
  CommissionKind,
  CommissionStatus,
  DealStatus,
  PartnerActorKind,
  PartnerApplicationStatus,
  PartnerKind,
  PartnerRequestKind,
  PartnerRequestStatus,
  PartnerRole,
  PartnerStatus,
  StatementStatus,
};

// ─── Roles ───────────────────────────────────────────────────────────────────────────────────────

export const PARTNER_ROLES = ["ADMIN", "FINANCE", "SALES", "VIEWER"] as const satisfies readonly PartnerRole[];

/** Everybody signed in to the portal. */
export const PARTNER_EVERYONE: readonly PartnerRole[] = PARTNER_ROLES;
/** Commission figures anywhere, statements, terms, the payout mask and payout requests. */
export const PARTNER_MONEY: readonly PartnerRole[] = ["ADMIN", "FINANCE"];
/** Invitation codes, referral links and deal registrations — while the partner is ACTIVE. */
export const PARTNER_SELLERS: readonly PartnerRole[] = ["ADMIN", "SALES"];
/** The team, the activity log, the company profile and its requests, new resellers. */
export const PARTNER_ADMINS: readonly PartnerRole[] = ["ADMIN"];

export const PARTNER_ROLE_LABELS: Record<PartnerRole, string> = { ADMIN: "Admin", FINANCE: "Finance", SALES: "Sales", VIEWER: "Viewer" };

/** One line each, for the role picker. */
export const PARTNER_ROLE_DESCRIPTIONS: Record<PartnerRole, string> = {
  ADMIN: "Everything: customers, selling, commissions and statements, the company profile and its requests, the team and the activity log.",
  FINANCE: "Commissions, statements and their exports, commission terms, and the payout details on file. Sells nothing.",
  SALES: "Customers, invitation codes, referral links and deal registrations. Sees no commission figures.",
  VIEWER: "Reads customers, invitations and deal registrations, and changes nothing.",
};

/**
 * What the signed-in user may do, as plain booleans a server page hands to a client component. For
 * showing and hiding only — every action checks the role (and the partner's status) again itself.
 */
export type PartnerCaps = {
  role: PartnerRole;
  kind: PartnerKind;
  status: PartnerStatus;
  /** Commission figures, statements, terms, the payout mask. */
  money: boolean;
  /** Create codes, links and registrations: a selling role, and the partner is ACTIVE. */
  sell: boolean;
  /** The team, the activity log, profile edits and requests. */
  admin: boolean;
  /** Has (or may have) resellers: the Resellers pages. */
  distributor: boolean;
};

export function partnerCapsFor(me: { role: PartnerRole; partner: { kind: PartnerKind; status: PartnerStatus } }): PartnerCaps {
  return {
    role: me.role,
    kind: me.partner.kind,
    status: me.partner.status,
    money: PARTNER_MONEY.includes(me.role),
    sell: me.partner.status === "ACTIVE" && PARTNER_SELLERS.includes(me.role),
    admin: PARTNER_ADMINS.includes(me.role),
    distributor: me.partner.kind === "DISTRIBUTOR",
  };
}

// ─── Results ─────────────────────────────────────────────────────────────────────────────────────

/** The signed-in partner user, and the partner they sign in for. Never a hash, token or secret. */
export type PartnerMe = {
  id: string;
  email: string;
  name: string;
  role: PartnerRole;
  partner: { id: string; slug: string; displayName: string; kind: PartnerKind; status: PartnerStatus; parentId: string | null; territories: string[] };
};

/**
 * What every portal action answers — structurally the console's ConsoleResult, so the portal's
 * client components use the console kit's `useConsoleAction`. Never a hash, token or secret.
 */
export type PartnerResult<T = null> = { ok: true; data: T } | { ok: false; error: string };

/** A refusal the person can act on — turned into `{ ok: false, error }` by the actions. */
export class PartnerRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PartnerRefused";
  }
}

// ─── Terms, money and inputs ─────────────────────────────────────────────────────────────────────

/** A partner's rates, in basis points (1500 is 15 %). */
export type TermsRates = {
  defaultRateBp: number;
  newRateBp: number | null;
  renewalRateBp: number | null;
  newMonths: number;
  durationMonths: number | null;
  overrideRateBp: number | null;
  territoryRateBp: number | null;
  planRates: { planKey: string; rateBp: number }[];
  countryRates: { country: string; rateBp: number }[];
};

/** Terms as a form sends them: rates as percent strings with at most two decimals ("15", "12.5"). */
export type TermsInput = {
  effectiveFrom?: string | null;
  defaultRate: string;
  newRate?: string | null;
  renewalRate?: string | null;
  newMonths?: number | null;
  durationMonths?: number | null;
  overrideRate?: string | null;
  territoryRate?: string | null;
  planRates?: { planKey: string; rate: string }[];
  countryRates?: { country: string; rate: string }[];
  note?: string | null;
};

/**
 * What the console's new-partner and new-terms forms start from (owner decision O1): 20 % for the
 * customer's first twelve months, then 10 %, for the customer's lifetime; a distributor's override
 * 5 %; no territory default. Only a starting point — a partner has no terms until staff save them.
 */
export const DEFAULT_TERMS: Record<"DISTRIBUTOR" | "RESELLER", TermsInput> = {
  DISTRIBUTOR: { effectiveFrom: null, defaultRate: "10", newRate: "20", renewalRate: "10", newMonths: 12, durationMonths: null, overrideRate: "5", territoryRate: null, planRates: [], countryRates: [], note: null },
  RESELLER: { effectiveFrom: null, defaultRate: "10", newRate: "20", renewalRate: "10", newMonths: 12, durationMonths: null, overrideRate: null, territoryRate: null, planRates: [], countryRates: [], note: null },
};

export const TAX_ID_KINDS = ["GSTIN", "PAN", "VAT", "GST", "ABN", "EIN", "TIN", "OTHER"] as const;
export type TaxIdKind = (typeof TAX_ID_KINDS)[number];

export type PartnerInput = {
  slug: string;
  kind: PartnerKind;
  parentSlug?: string | null;
  legalName: string;
  displayName: string;
  country: string;
  territories: string[];
  contactName: string;
  contactEmail: string;
  contactPhone?: string | null;
  website?: string | null;
  address?: { line1?: string | null; line2?: string | null; city?: string | null; region?: string | null; postalCode?: string | null };
  taxIds?: { kind: string; value: string }[];
  publicListing?: boolean;
  publicBlurb?: string | null;
};

/** Bank details as they are typed. Sealed on arrival; only a PayoutMask is ever shown again. */
export type PayoutInput = {
  accountHolder: string;
  bankName: string;
  country: string;
  currency: string;
  accountNumber?: string | null;
  ifsc?: string | null;
  iban?: string | null;
  swift?: string | null;
  routingNumber?: string | null;
  note?: string | null;
};

/** What may be shown of a partner's bank details. */
export type PayoutMask = { method: "BANK"; accountHolder: string; bankName: string; country: string; currency: string; last4: string; ifsc: string | null; swift: string | null };

export type TaxLineInput = { label: string; kind: "ADD" | "WITHHOLD"; rate?: string | null; amount?: number | null };
export type TaxLine = { label: string; kind: "ADD" | "WITHHOLD"; rateBp: number | null; amount: number };

/** An amount in one currency's minor units. Never added across currencies, never converted. */
export type Money = { currency: string; minor: number };

/**
 * A percent string → basis points: "12.5" → 1250, "15" → 1500, "0.25" → 25 (a trailing "%" is
 * allowed). Null for anything else — more than two decimals, a sign, words — or outside 0–100.
 */
export function percentToBp(input: string): number | null {
  const text = String(input ?? "").trim().replace(/\s*%$/, "");
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bp >= 0 && bp <= 10000 ? bp : null;
}

/** Basis points → a percent for people: 1250 → "12.5 %", 1500 → "15 %", 1255 → "12.55 %". */
export function bpToPercent(bp: number): string {
  const n = Math.round(Number(bp) || 0);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  return `${sign}${whole}${cents ? `.${String(cents).padStart(2, "0").replace(/0$/, "")}` : ""} %`;
}

// ─── People ──────────────────────────────────────────────────────────────────────────────────────

export type PartnerTwoFactorMode = "optional" | "required";

export type PartnerUserRow = {
  id: string;
  email: string;
  name: string;
  role: PartnerRole;
  active: boolean;
  /** An authenticator is set up. */
  twoFactor: boolean;
  /** Has chosen a password (a setup link has been used at least once). */
  hasPassword: boolean;
  /** A setup link is out and has not expired. */
  setupPending: boolean;
  lastSignInAt: Date | null;
  createdAt: Date;
  /** Who made the account, as a name ("Asha Rao", "Platform staff: Ravi", "Script"). */
  createdBy: string;
  /** Sessions that still let them in. */
  liveSessions: number;
};

/**
 * A portal session as the portal lists it. `handle` names it for "End this session" and is neither
 * the cookie's token nor the stored hash of it.
 */
export type PartnerSessionRow = { handle: string; createdAt: Date; lastSeenAt: Date; expiresAt: Date; mfa: boolean; ip: string | null; device: string; current: boolean };

export const PARTNER_MIN_PASSWORD = 12;

// ─── Limits ──────────────────────────────────────────────────────────────────────────────────────

/** Counted in the database (rows made by the partner in the last 24 hours, or open rows), except exports (per user, per hour). */
export const PARTNER_LIMITS = { users: 50, invitesPerDay: 50, liveLinks: 50, dealsPerDay: 20, openDeals: 200, exportsPerHour: 20, pendingResellers: 10 } as const;

/** The programme settings' whole-number ranges and what each is until an owner sets it (src/lib/partners/settings.ts). */
export const PARTNER_SETTING_RANGES = {
  statementDay: { min: 1, max: 28, fallback: 5 },
  dealDays: { min: 30, max: 365, fallback: 90 },
  refCookieDays: { min: 0, max: 90, fallback: 0 },
  clawbackMonths: { min: 1, max: 60, fallback: 12 },
} as const;

// ─── Activity ────────────────────────────────────────────────────────────────────────────────────

export type PartnerAuditRow = {
  id: string;
  at: Date;
  actorKind: PartnerActorKind;
  /** The partner user's or staff member's id; null for scripts, the system and the public site (and staff in the partner's own view). */
  actorId: string | null;
  actorLabel: string;
  action: string;
  entity: string;
  entityId: string | null;
  detail: Record<string, unknown> | null;
  visibleToPartner: boolean;
};

/**
 * Every action the partner audit log holds (partner_audit_log.action), for the activity pages'
 * labels and filters. The account.* four are a person's own account, as in the CMS's log.
 */
export const PARTNER_AUDIT_ACTIONS = [
  "auth.sign-in",
  "auth.sign-out",
  "auth.password.set",
  "auth.two-factor.enrolled",
  "auth.two-factor.removed",
  "account.password-link",
  "account.rename",
  "account.session.end",
  "account.sessions.end-others",
  "user.invite",
  "user.role",
  "user.deactivate",
  "user.reactivate",
  "user.setup-link",
  "user.two-factor.reset",
  "user.sessions.end",
  "invite.create",
  "invite.end",
  "link.create",
  "link.end",
  "deal.register",
  "deal.withdraw",
  "deal.approve",
  "deal.decline",
  "deal.won",
  "deal.expire",
  "customer.signup",
  "customer.assigned",
  "customer.removed",
  "terms.set",
  "partner.create",
  "partner.update",
  "partner.status",
  "profile.update",
  "request.create",
  "request.withdraw",
  "request.approve",
  "request.reject",
  "payout.set",
  "payout.reveal",
  "commission.void",
  "commission.adjust",
  "statement.generate",
  "statement.approve",
  "statement.paid",
  "statement.void",
  "statement.invoice-number",
  "export.commissions",
  "export.statement",
  "application.submit",
  "application.update",
  "application.convert",
] as const;
export type PartnerAuditAction = (typeof PARTNER_AUDIT_ACTIONS)[number];

export type PartnerAuditFilters = { actorId?: string; action?: string; entity?: string; from?: string; to?: string; page?: number };

/** One page of a list: `total` across every page. */
export type Paged<T> = { rows: T[]; total: number; page: number; pageSize: number };
