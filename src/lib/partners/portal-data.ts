import type {
  AttributionSource,
  BillingInterval,
  CommissionKind,
  CommissionStatus,
  DealStatus,
  PartnerKind,
  PartnerRequestKind,
  PartnerRequestStatus,
  PartnerStatus,
  Prisma,
  StatementStatus,
  SubscriptionStatus,
  TenantStatus,
} from "@deskzo/control-client";
import type { CsvExport } from "@/lib/console-shared/types";
import { istDateParts, istMidnight, endOfIndianDay } from "@/lib/india-time";
import { listPartnerAudit } from "@/lib/partners/audit";
import { CSV_MAX_ROWS, commissionCsv, statementCsv, type CommissionCsvRow } from "@/lib/partners/csv";
import { attributedMrr, customerFacts, type CustomerFacts, type StandingKind } from "@/lib/partners/customers";
import { canOpenPartnerPage, type PartnerPageKey } from "@/lib/partners/nav";
import { referralUrl } from "@/lib/partners/referrals";
import { dealDays } from "@/lib/partners/settings";
import { istDayStart } from "@/lib/partners/terms";
import {
  PARTNER_MONEY,
  PartnerRefused,
  bpToPercent,
  partnerCapsFor,
  type Money,
  type Paged,
  type PartnerAuditRow,
  type PartnerMe,
  type PartnerSessionRow,
  type PartnerUserRow,
  type PayoutMask,
  type TaxLine,
} from "@/lib/partners/types";
import { listPartnerSessions, listPartnerUsers } from "@/lib/partners/users";
import { controlDb } from "@/lib/platform/control-db";
import { LIVE_STATUSES } from "@/lib/platform/entitlements";
import { signupOpen } from "@/lib/platform/settings";
import { siteOrigin } from "@/lib/platform/site-content";

/**
 * What the partner portal's pages show (spec §8.5, §8.7, Appendix B) — server only, called by the
 * pages after `partnerPage(…)` and by the portal actions after `requirePartner(…)`.
 *
 * The boundary this file holds:
 *
 *   · Every function takes the signed-in `me` first, and every query carries `partnerId: me.partner.id`
 *     (a distributor's resellers: `parentId: me.partner.id`) in the same `where` as any slug or number
 *     from the URL. Another partner's, or none, is null (the page's notFound) — the same answer for
 *     both. No parameter anywhere names a partner.
 *   · Money — commission figures, statements, terms, the payout mask — is read only for the money
 *     roles (ADMIN, FINANCE): for the others it is not selected at all, and the view carries null.
 *   · A page a role may not open (nav.ts) gets an empty view here too, whatever the page does.
 *   · Customers are the workspaces attributed to the partner now, with the control plane's facts
 *     only (customers.ts): never an owner's or billing address, a tax id, an invoice link, seats or
 *     usage. A former customer keeps its name on the partner's own commission entries, never a link.
 *   · A distributor sees its resellers' aggregates and its own OVERRIDE entries on their customers —
 *     never a reseller's entries, rates, statements, users or activity.
 *   · Staff's fields never leave: notes, attribution reasons and flags, void reasons, the terms'
 *     note, a request's sealed copy, the payout cipher, DRAFT and VOID statements.
 *
 * Dates from the URL are India days, half-open: `from` from its start, `to` to the start of the next.
 */

export type { CustomerFacts, StandingKind } from "@/lib/partners/customers";
export type { Paged } from "@/lib/partners/types";

export const CUSTOMERS_PAGE_SIZE = 50;
export const DEALS_PAGE_SIZE = 50;
export const COMMISSIONS_PAGE_SIZE = 100;
/** The most codes, links, statements, requests or entries one list holds (newest first). */
const LIST_CAP = 300;
/** A statement's entries on its page; the CSV has them all. */
const STATEMENT_ENTRIES_CAP = 1000;
/** Workspaces read at once to filter by billing standing (worked out, not stored). */
const STANDING_SCAN_CAP = 20_000;
const DAY = 86_400_000;

// ─── Views (Appendix B, with the additions its pages need) ───────────────────────────────────────

/**
 * The dashboard. Counts are of the workspaces attributed now and not closed (DEPROVISIONED): `active`
 * pays at a gateway and is paid up (standing paid, or cancelled but running to its period's end),
 * `trial` is in its trial, `pastDue` has a failed payment, `held` is SUSPENDED, `newThisMonth` came to
 * the partner (its current attribution began) this IST month.
 */
export type PortalDashboard = {
  asOf: Date;
  customers: { total: number; active: number; trial: number; held: number; pastDue: number; newThisMonth: number };
  mrr: Money[];
  /** Trials ending within 14 days, soonest first. */
  trialsEnding: { slug: string; name: string; endsAt: Date }[];
  /** Renewals (`ending` false) and cancellations taking effect (`ending` true) within 30 days, soonest first. */
  renewals: { slug: string; name: string; at: Date; ending: boolean; mrr: Money[] }[];
  latest: { slug: string; name: string; since: Date; source: AttributionSource }[];
  /** Money roles only: net commission earned this IST month, PENDING (awaiting a statement), APPROVED (to be paid). */
  money: null | { thisMonth: Money[]; awaitingStatement: Money[]; approvedToPay: Money[] };
  /** Distributors: resellers not terminated, and their customers' MRR. */
  resellers: null | { count: number; mrr: Money[] };
  /** While ONBOARDING: another user invited, an address (line 1, city, postal code) on file, payout details on file. */
  setup: null | { teamInvited: boolean; profileComplete: boolean; payoutOnFile: boolean };
};

export type CustomerRow = CustomerFacts & { source: AttributionSource; since: Date; commissionable: boolean };

/** A live subscription as the customer page lists it (added to Appendix B: the page's subscriptions table). */
export type CustomerSubscription = {
  status: SubscriptionStatus;
  interval: BillingInterval | null;
  currency: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: Date | null;
  items: { key: string; name: string; quantity: number; interval: BillingInterval | null; unitAmount: number | null; currency: string | null }[];
};

export type CustomerDetail = CustomerRow & {
  asOf: Date;
  subscriptions: CustomerSubscription[];
  /** Money roles only: net commission from this customer per currency (VOID left out), and its entries, newest first. */
  commission: null | { earned: Money[]; entries: CommissionRow[] };
};

export type PortalCustomers = Paged<CustomerRow> & { asOf: Date };

/**
 * One invitation code. `state`: used (every use spent), ended (ended from the portal before its
 * expiry: `expiresAt` was set to that moment and an `invite.end` row names it), expired, or live.
 * `customers`: workspaces it set up that are this partner's now.
 */
export type InviteRow = {
  codeHash: string;
  codeHint: string | null;
  note: string | null;
  planName: string | null;
  uses: number;
  maxUses: number;
  expiresAt: Date | null;
  state: "live" | "used" | "expired" | "ended";
  createdAt: Date;
  customers: { slug: string; name: string }[];
};

/** One referral link. `signups`: verified with its code on the form, whoever won them; `customers`: its signups that are this partner's now. */
export type LinkRow = {
  id: string;
  code: string;
  url: string;
  label: string | null;
  planName: string | null;
  signups: number;
  customers: number;
  expiresAt: Date | null;
  endedAt: Date | null;
  state: "live" | "expired" | "ended";
  createdAt: Date;
};

export type PortalInvitations = { codes: InviteRow[]; links: LinkRow[]; plans: { key: string; name: string }[]; signupUrl: string; signupOpen: boolean; canSell: boolean };

export type DealRow = {
  id: string;
  companyName: string;
  domain: string;
  country: string;
  /** An APPROVED registration past its protection reads EXPIRED even before the daily tick moves it. */
  status: DealStatus;
  expiresAt: Date | null;
  decisionNote: string | null;
  /** The workspace it became (WON), while it is this partner's. */
  customer: { slug: string; name: string } | null;
  createdAt: Date;
};

/** The registrations page (not in Appendix B; the page's counts, protection copy and dialog need these). */
export type PortalDeals = Paged<DealRow> & {
  counts: Record<DealStatus, number>;
  /** `partners.dealDays`: how long an approved registration is protected. */
  dealDays: number;
  territories: string[];
  plans: { key: string; name: string }[];
  canSell: boolean;
  asOf: Date;
};

export type CommissionRow = {
  id: string;
  earnedAt: Date;
  /** The customer's name; `slug` only while it is this partner's customer (a link to its page), else null. Null for an adjustment about nobody. */
  customer: { slug: string | null; name: string } | null;
  invoiceNumber: string | null;
  kind: CommissionKind;
  /** A clawback of an accrual (a refund, credit note or void) — added to Appendix B so the page can say so. */
  reversal: boolean;
  base: number;
  rateBp: number;
  amount: number;
  currency: string;
  status: CommissionStatus;
  /** Only an APPROVED or PAID statement's number; a DRAFT is staff's work in progress. */
  statementNumber: string | null;
  /** An adjustment's reason. */
  note: string | null;
  /** An accrual's phase and the rules that set its rates; `{}` otherwise. */
  basis: { phase?: "NEW" | "RENEWAL"; by?: string[] };
};

/** `totals`: per currency, the sums by status over the filters (the status filter aside), VOID left out. */
export type PortalCommissions = Paged<CommissionRow> & { totals: { currency: string; pending: number; approved: number; paid: number }[] };

export type StatementRow = {
  number: string;
  period: string;
  currency: string;
  status: StatementStatus;
  total: number;
  netPayable: number;
  partnerInvoiceNumber: string | null;
  approvedAt: Date | null;
  paidAt: Date | null;
  paymentReference: string | null;
};

/** The partner as a statement recorded it (Appendix B's `snapshot: unknown`, typed and re-checked field by field). */
export type StatementSnapshot = {
  legalName: string;
  displayName: string;
  country: string;
  address: PartnerAddress;
  taxIds: { kind: string; value: string }[];
  payout: PayoutMask | null;
};

export type StatementDetail = StatementRow & {
  snapshot: StatementSnapshot;
  taxLines: TaxLine[];
  earned: number;
  reversed: number;
  adjustments: number;
  /** How many entries it holds — `entries` lists at most 1,000 (added to Appendix B). */
  entryCount: number;
  entries: CommissionRow[];
};

export type PartnerAddress = { line1: string | null; line2: string | null; city: string | null; region: string | null; postalCode: string | null };

export type TermsView = {
  effectiveFrom: Date;
  defaultRate: string;
  newRate: string | null;
  renewalRate: string | null;
  newMonths: number;
  durationMonths: number | null;
  /** Distributors only. */
  overrideRate: string | null;
  /** Distributors only: the rate on signups credited to it by territory (added to Appendix B — it is one of its own rates). */
  territoryRate: string | null;
  planRates: { planName: string; rate: string }[];
  countryRates: { country: string; rate: string }[];
};

export type RequestRow = {
  id: string;
  kind: PartnerRequestKind;
  status: PartnerRequestStatus;
  createdAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
  /** One line, in words: which fields, which bank (masked), which reseller. Never the sealed details. */
  summary: string;
};

export type PortalProfile = {
  partner: {
    legalName: string;
    displayName: string;
    kind: PartnerKind;
    status: PartnerStatus;
    country: string;
    territories: string[];
    contactName: string;
    contactEmail: string;
    contactPhone: string | null;
    website: string | null;
    address: PartnerAddress;
    taxIds: { kind: string; value: string }[];
    publicListing: boolean;
    publicBlurb: string | null;
    parent: { displayName: string } | null;
  };
  /** Money roles only. */
  payout: PayoutMask | null;
  /** Money roles only: the terms in force now, and those starting later (soonest first). */
  terms: null | { inForce: TermsView | null; scheduled: TermsView[] };
  /** Newest first; PAYOUT requests for the money roles only. */
  requests: RequestRow[];
};

/**
 * One reseller as its distributor sees it. `customers` counts its current, not closed, workspaces;
 * `active` and `trial` as on the dashboard; `newThisMonth` came to it this IST month.
 */
export type ResellerRow = { slug: string; displayName: string; status: PartnerStatus; territories: string[]; customers: number; active: number; trial: number; mrr: Money[]; newThisMonth: number };

/** Money roles only: this distributor's OVERRIDE entries (and their clawbacks) on that reseller's customers, newest first; else []. */
export type ResellerDetail = ResellerRow & { overrides: CommissionRow[] };

/** A proposed reseller waiting for staff (not in Appendix B; the page lists them with Withdraw). */
export type ResellerRequestRow = { id: string; displayName: string; legalName: string; country: string; territories: string[]; createdAt: Date };

/** The resellers page (not in Appendix B). `territories`: the distributor's own, which a proposal must stay within. */
export type PortalResellers = { resellers: ResellerRow[]; requests: ResellerRequestRow[]; territories: string[]; canRequest: boolean; asOf: Date };

export type PortalAccount = { me: PartnerMe; sessions: PartnerSessionRow[]; enrolled: boolean };

export type CustomerFilters = { q?: string; status?: string; standing?: string; page?: number | string };
export type DealFilters = { status?: string; page?: number | string };
export type CommissionFilters = { status?: string; currency?: string; from?: string; to?: string; customer?: string; page?: number | string };
export type ActivityFilters = { action?: string; from?: string; to?: string; page?: number | string };

// ─── Small helpers ───────────────────────────────────────────────────────────────────────────────

const hasMoney = (me: PartnerMe) => PARTNER_MONEY.includes(me.role);
const mayOpen = (me: PartnerMe, key: PartnerPageKey) => canOpenPartnerPage(me.role, me.partner.kind, key);
const pageOf = (raw: unknown) => Math.max(1, Math.min(10_000, Math.floor(Number(raw) || 1)));
const textOf = (raw: unknown, max: number) => (typeof raw === "string" ? raw.trim().slice(0, max) : "");
const emptyPage = <T>(pageSize: number): Paged<T> => ({ rows: [], total: 0, page: 1, pageSize });

/** Whether a value is one of a union's members, given every member once (so a new member fails to compile until listed). */
const memberOf = <K extends string>(all: Record<K, true>, raw: unknown): K | null => (typeof raw === "string" && Object.hasOwn(all, raw) ? (raw as K) : null);

const TENANT_STATUSES: Record<TenantStatus, true> = { PROVISIONING: true, ACTIVE: true, SUSPENDED: true, MIGRATING: true, DEPROVISIONED: true };
const STANDINGS: Record<StandingKind, true> = { exempt: true, paid: true, trial: true, "trial-over": true, "past-due": true, ending: true, lapsed: true, none: true };
const DEAL_STATUSES: Record<DealStatus, true> = { PENDING: true, APPROVED: true, DECLINED: true, WON: true, EXPIRED: true, WITHDRAWN: true };
const ENTRY_STATUSES: Record<CommissionStatus, true> = { PENDING: true, APPROVED: true, PAID: true, VOID: true };
const RATE_BYS = new Set(["plan", "country", "phase", "default", "territory"]);
/** The statuses a partner sees of its statements; DRAFT and VOID are staff's. */
const SHOWN_STATEMENTS: StatementStatus[] = ["APPROVED", "PAID"];

/** The instant this IST month began, and the next one. */
function istMonth(now: Date): { start: Date; end: Date } {
  const { year, month } = istDateParts(now);
  return { start: istMidnight(year, month, 1), end: istMidnight(year, month + 1, 1) };
}

/** "yyyy-mm-dd" → [start of that India day, start of the day after); a missing or impossible day is no bound. */
function istRange(from: unknown, to: unknown): { gte?: Date; lt?: Date } | null {
  const start = typeof from === "string" && from ? istDayStart(from) : null;
  const end = typeof to === "string" && to && istDayStart(to) ? endOfIndianDay(to.trim()) : null;
  return start || end ? { ...(start ? { gte: start } : {}), ...(end ? { lt: end } : {}) } : null;
}

/** Sums per currency — never added across currencies — without the zeros, by currency code. */
function moneyList(groups: { currency: string; _sum: { amount: number | null } }[]): Money[] {
  const sums = new Map<string, number>();
  for (const g of groups) {
    const currency = g.currency.trim().toUpperCase();
    sums.set(currency, (sums.get(currency) ?? 0) + (g._sum.amount ?? 0));
  }
  return [...sums]
    .map(([currency, minor]) => ({ currency, minor }))
    .filter((m) => m.minor !== 0)
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

const asRecord = (raw: unknown): Record<string, unknown> => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});
const str = (raw: unknown): string | null => (typeof raw === "string" && raw ? raw : null);

function taxIdsOf(raw: unknown): { kind: string; value: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t) => {
    const x = asRecord(t);
    return typeof x.kind === "string" && typeof x.value === "string" ? [{ kind: x.kind, value: x.value }] : [];
  });
}

/** A stored payout mask, re-read field by field — only what a mask holds ever leaves. */
function payoutMaskOf(raw: unknown): PayoutMask | null {
  const x = asRecord(raw);
  if (typeof x.last4 !== "string" || typeof x.accountHolder !== "string" || typeof x.bankName !== "string") return null;
  return {
    method: "BANK",
    accountHolder: x.accountHolder,
    bankName: x.bankName,
    country: typeof x.country === "string" ? x.country : "",
    currency: typeof x.currency === "string" ? x.currency : "",
    last4: x.last4.slice(-4),
    ifsc: str(x.ifsc),
    swift: str(x.swift),
  };
}

function taxLinesOf(raw: unknown): TaxLine[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((l) => {
    const x = asRecord(l);
    if (typeof x.label !== "string" || (x.kind !== "ADD" && x.kind !== "WITHHOLD") || typeof x.amount !== "number") return [];
    return [{ label: x.label, kind: x.kind, rateBp: typeof x.rateBp === "number" ? x.rateBp : null, amount: x.amount }];
  });
}

function snapshotOf(raw: unknown): StatementSnapshot {
  const x = asRecord(raw);
  const a = asRecord(x.address);
  return {
    legalName: typeof x.legalName === "string" ? x.legalName : "",
    displayName: typeof x.displayName === "string" ? x.displayName : "",
    country: typeof x.country === "string" ? x.country : "",
    address: { line1: str(a.line1), line2: str(a.line2), city: str(a.city), region: str(a.region), postalCode: str(a.postalCode) },
    taxIds: taxIdsOf(x.taxIds),
    payout: payoutMaskOf(x.payout),
  };
}

async function planNames(keys: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(keys.filter((k): k is string => !!k))];
  if (!unique.length) return new Map();
  const plans = await controlDb().plan.findMany({ where: { key: { in: unique } }, select: { key: true, name: true } });
  return new Map(plans.map((p) => [p.key, p.name]));
}

/** The plans a new workspace may start on: active, and not INTERNAL (as referrals.ts checks). */
function offeredPlans(): Promise<{ key: string; name: string }[]> {
  return controlDb().plan.findMany({ where: { active: true, kind: { not: "INTERNAL" } }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { key: true, name: true } });
}

// ─── Commission entries ──────────────────────────────────────────────────────────────────────────

/** An entry as the portal may show it: no void reason, no staff ids, the invoice's number only (never its links). */
const ENTRY_SELECT = {
  id: true,
  earnedAt: true,
  kind: true,
  base: true,
  rateBp: true,
  amount: true,
  currency: true,
  status: true,
  note: true,
  basis: true,
  reversesId: true,
  tenant: { select: { slug: true, name: true, partnerId: true } },
  invoice: { select: { number: true } },
  statement: { select: { number: true, status: true } },
} as const satisfies Prisma.CommissionEntrySelect;

type EntryRecord = Prisma.CommissionEntryGetPayload<{ select: typeof ENTRY_SELECT }>;

/** An accrual's phase and the distinct rules behind its line rates (spec §5.8: the portal shows phase and `by`). */
function basisOf(raw: unknown): CommissionRow["basis"] {
  const x = asRecord(raw);
  if (x.type !== "accrual") return {};
  const by = Array.isArray(x.lines) ? [...new Set(x.lines.map((l) => asRecord(l).by).filter((b): b is string => typeof b === "string" && RATE_BYS.has(b)))] : [];
  return { ...(x.phase === "NEW" || x.phase === "RENEWAL" ? { phase: x.phase } : {}), ...(by.length ? { by } : {}) };
}

const shownStatement = (s: EntryRecord["statement"]) => (s && SHOWN_STATEMENTS.includes(s.status) ? s.number : null);

function commissionRow(e: EntryRecord, partnerId: string): CommissionRow {
  return {
    id: e.id,
    earnedAt: e.earnedAt,
    customer: e.tenant ? { slug: e.tenant.partnerId === partnerId ? e.tenant.slug : null, name: e.tenant.name } : null,
    invoiceNumber: e.invoice?.number ?? null,
    kind: e.kind,
    reversal: e.reversesId !== null,
    base: e.base,
    rateBp: e.rateBp,
    amount: e.amount,
    currency: e.currency,
    status: e.status,
    statementNumber: shownStatement(e.statement),
    note: e.note,
    basis: basisOf(e.basis),
  };
}

function csvRowOf(e: EntryRecord, partnerId: string): CommissionCsvRow {
  const own = e.tenant?.partnerId === partnerId;
  return {
    earnedAt: e.earnedAt,
    customer: e.tenant?.name ?? null,
    workspace: own ? (e.tenant?.slug ?? null) : null,
    invoice: e.invoice?.number ?? null,
    kind: e.kind,
    reversal: e.reversesId !== null,
    base: e.base,
    rateBp: e.rateBp,
    amount: e.amount,
    currency: e.currency,
    status: e.status,
    statement: shownStatement(e.statement),
  };
}

/** The commissions filters as a query — always this partner's entries. `withStatus: false` for the totals. */
function commissionWhere(me: PartnerMe, f: CommissionFilters, withStatus: boolean): Prisma.CommissionEntryWhereInput {
  const status = withStatus ? memberOf(ENTRY_STATUSES, f.status) : null;
  const currency = textOf(f.currency, 20).toUpperCase();
  const range = istRange(f.from, f.to);
  const customer = textOf(f.customer, 100);
  return {
    partnerId: me.partner.id,
    ...(status ? { status } : {}),
    ...(/^[A-Z]{3}$/.test(currency) ? { currency } : {}),
    ...(range ? { earnedAt: range } : {}),
    ...(customer ? { tenant: { is: { OR: [{ name: { contains: customer, mode: "insensitive" } }, { slug: { contains: customer, mode: "insensitive" } }] } } } : {}),
  };
}

// ─── Customers ───────────────────────────────────────────────────────────────────────────────────

/** The current attribution row — how and since when; never its reference, reason or flags. */
const CURRENT_ATTRIBUTION = { where: { validTo: null }, take: 1, select: { partnerId: true, source: true, validFrom: true, commissionable: true } } as const;

type CurrentAttribution = { partnerId: string | null; source: AttributionSource; validFrom: Date; commissionable: boolean };

function customerRow(facts: CustomerFacts, current: CurrentAttribution | undefined, partnerId: string): CustomerRow {
  // tenants.partnerId and the current row move together; were they ever apart, the engine would pay nothing, so say "No commission".
  const own = current && current.partnerId === partnerId ? current : null;
  return { ...facts, source: own?.source ?? "STAFF", since: own?.validFrom ?? facts.createdAt, commissionable: own?.commissionable ?? false };
}

const isActive = (kind: StandingKind) => kind === "paid" || kind === "ending";

/**
 * The dashboard (`/`): customer counts and MRR for everyone; for the money roles the commission
 * tiles; for a distributor its resellers; while ONBOARDING the setup checklist.
 */
export async function portalDashboard(me: PartnerMe, now: Date = new Date()): Promise<PortalDashboard> {
  const control = controlDb();
  const partnerId = me.partner.id;
  const month = istMonth(now);
  const [tenants, latest] = await Promise.all([
    control.tenant.findMany({ where: { partnerId, status: { not: "DEPROVISIONED" } }, select: { id: true, status: true, attributions: CURRENT_ATTRIBUTION } }),
    control.tenantAttribution.findMany({
      where: { partnerId, validTo: null, tenant: { is: { partnerId } } },
      orderBy: [{ validFrom: "desc" }, { id: "desc" }],
      take: 8,
      select: { validFrom: true, source: true, tenant: { select: { slug: true, name: true } } },
    }),
  ]);
  const ids = tenants.map((t) => t.id);
  const [facts, mrr] = await Promise.all([customerFacts(ids, now), attributedMrr(ids)]);

  const customers = { total: tenants.length, active: 0, trial: 0, held: 0, pastDue: 0, newThisMonth: 0 };
  const trialsEnding: PortalDashboard["trialsEnding"] = [];
  const renewals: PortalDashboard["renewals"] = [];
  const soon = (at: Date | null, days: number) => !!at && at.getTime() >= now.getTime() && at.getTime() <= now.getTime() + days * DAY;
  for (const t of tenants) {
    const current = t.attributions[0];
    if (current && current.partnerId === partnerId && current.validFrom >= month.start) customers.newThisMonth += 1;
    if (t.status === "SUSPENDED") customers.held += 1;
    const f = facts.get(t.id);
    if (!f) continue;
    if (isActive(f.standing.kind)) customers.active += 1;
    if (f.standing.kind === "trial") customers.trial += 1;
    if (f.standing.kind === "past-due") customers.pastDue += 1;
    if (f.standing.kind === "trial" && f.endsAt && soon(f.endsAt, 14)) trialsEnding.push({ slug: f.slug, name: f.name, endsAt: f.endsAt });
    if (f.standing.kind === "ending" && f.endsAt && soon(f.endsAt, 30)) renewals.push({ slug: f.slug, name: f.name, at: f.endsAt, ending: true, mrr: f.mrr });
    else if (f.renewsAt && soon(f.renewsAt, 30)) renewals.push({ slug: f.slug, name: f.name, at: f.renewsAt, ending: false, mrr: f.mrr });
  }
  trialsEnding.sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime());
  renewals.sort((a, b) => a.at.getTime() - b.at.getTime());

  let money: PortalDashboard["money"] = null;
  if (hasMoney(me)) {
    const [thisMonth, pending, approved] = await Promise.all([
      control.commissionEntry.groupBy({ by: ["currency"], where: { partnerId, status: { not: "VOID" }, earnedAt: { gte: month.start, lt: month.end } }, _sum: { amount: true } }),
      control.commissionEntry.groupBy({ by: ["currency"], where: { partnerId, status: "PENDING" }, _sum: { amount: true } }),
      control.commissionEntry.groupBy({ by: ["currency"], where: { partnerId, status: "APPROVED" }, _sum: { amount: true } }),
    ]);
    money = { thisMonth: moneyList(thisMonth), awaitingStatement: moneyList(pending), approvedToPay: moneyList(approved) };
  }

  let resellers: PortalDashboard["resellers"] = null;
  if (me.partner.kind === "DISTRIBUTOR") {
    const [count, theirs] = await Promise.all([
      control.partner.count({ where: { parentId: partnerId, status: { not: "TERMINATED" } } }),
      control.tenant.findMany({ where: { partner: { is: { parentId: partnerId } } }, select: { id: true } }),
    ]);
    resellers = { count, mrr: await attributedMrr(theirs.map((t) => t.id)) };
  }

  let setup: PortalDashboard["setup"] = null;
  if (me.partner.status === "ONBOARDING") {
    const [partner, users] = await Promise.all([
      control.partner.findUnique({ where: { id: partnerId }, select: { addressLine1: true, city: true, postalCode: true, payoutUpdatedAt: true } }),
      control.partnerUser.count({ where: { partnerId, active: true } }),
    ]);
    setup = { teamInvited: users > 1, profileComplete: !!(partner?.addressLine1 && partner.city && partner.postalCode), payoutOnFile: !!partner?.payoutUpdatedAt };
  }

  return {
    asOf: now,
    customers,
    mrr,
    trialsEnding: trialsEnding.slice(0, 20),
    renewals: renewals.slice(0, 20),
    latest: latest.map((a) => ({ slug: a.tenant.slug, name: a.tenant.name, since: a.validFrom, source: a.source })),
    money,
    resellers,
    setup,
  };
}

/**
 * The customers list (`/customers`): the workspaces attributed to the partner now, by name, 50 a
 * page, filtered by name or address (`q`), status and billing standing. Standing is worked out, not
 * stored, so filtering by it reads the partner's matching workspaces whole (at most 20,000).
 */
export async function portalCustomers(me: PartnerMe, filters: CustomerFilters = {}, now: Date = new Date()): Promise<PortalCustomers> {
  const control = controlDb();
  const page = pageOf(filters?.page);
  const q = textOf(filters?.q, 100);
  const status = memberOf(TENANT_STATUSES, filters?.status);
  const standing = memberOf(STANDINGS, filters?.standing);
  const where: Prisma.TenantWhereInput = {
    partnerId: me.partner.id,
    ...(status ? { status } : {}),
    ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { slug: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const order: Prisma.TenantOrderByWithRelationInput[] = [{ name: "asc" }, { id: "asc" }];
  const skip = (page - 1) * CUSTOMERS_PAGE_SIZE;

  let total: number;
  let rows: { id: string; attributions: CurrentAttribution[] }[];
  let facts: Map<string, CustomerFacts>;
  if (standing) {
    const all = await control.tenant.findMany({ where, orderBy: order, take: STANDING_SCAN_CAP, select: { id: true, attributions: CURRENT_ATTRIBUTION } });
    facts = await customerFacts(all.map((t) => t.id), now);
    const matching = all.filter((t) => facts.get(t.id)?.standing.kind === standing);
    total = matching.length;
    rows = matching.slice(skip, skip + CUSTOMERS_PAGE_SIZE);
  } else {
    [total, rows] = await Promise.all([
      control.tenant.count({ where }),
      control.tenant.findMany({ where, orderBy: order, skip, take: CUSTOMERS_PAGE_SIZE, select: { id: true, attributions: CURRENT_ATTRIBUTION } }),
    ]);
    facts = await customerFacts(rows.map((t) => t.id), now);
  }
  return {
    rows: rows.flatMap((t) => {
      const f = facts.get(t.id);
      return f ? [customerRow(f, t.attributions[0], me.partner.id)] : [];
    }),
    total,
    page,
    pageSize: CUSTOMERS_PAGE_SIZE,
    asOf: now,
  };
}

/**
 * One customer (`/customers/[slug]`), only while it is this partner's: its facts, live subscriptions
 * and attribution; for the money roles the commission from it. Null otherwise (the page's notFound).
 */
export async function portalCustomer(me: PartnerMe, slug: string, now: Date = new Date()): Promise<CustomerDetail | null> {
  const key = String(slug ?? "").trim().toLowerCase().slice(0, 63);
  if (!key) return null;
  const control = controlDb();
  const partnerId = me.partner.id;
  const tenant = await control.tenant.findFirst({ where: { slug: key, partnerId }, select: { id: true, attributions: CURRENT_ATTRIBUTION } });
  if (!tenant) return null;
  const [facts, subs] = await Promise.all([
    customerFacts([tenant.id], now),
    control.subscription.findMany({
      where: { tenantId: tenant.id, tenant: { is: { partnerId } }, status: { in: [...LIVE_STATUSES] } },
      orderBy: { createdAt: "asc" },
      select: {
        status: true,
        interval: true,
        currency: true,
        currentPeriodEnd: true,
        cancelAtPeriodEnd: true,
        trialEndsAt: true,
        items: { orderBy: { createdAt: "asc" }, select: { quantity: true, plan: { select: { key: true, name: true } }, price: { select: { amount: true, currency: true, interval: true } } } },
      },
    }),
  ]);
  const f = facts.get(tenant.id);
  if (!f) return null;

  let commission: CustomerDetail["commission"] = null;
  if (hasMoney(me)) {
    const [entries, sums] = await Promise.all([
      control.commissionEntry.findMany({ where: { partnerId, tenantId: tenant.id }, orderBy: [{ earnedAt: "desc" }, { id: "desc" }], take: LIST_CAP, select: ENTRY_SELECT }),
      control.commissionEntry.groupBy({ by: ["currency"], where: { partnerId, tenantId: tenant.id, status: { not: "VOID" } }, _sum: { amount: true } }),
    ]);
    commission = { earned: moneyList(sums), entries: entries.map((e) => commissionRow(e, partnerId)) };
  }

  return {
    ...customerRow(f, tenant.attributions[0], partnerId),
    asOf: now,
    subscriptions: subs.map((s) => ({
      status: s.status,
      interval: s.interval,
      currency: s.currency?.toUpperCase() ?? null,
      currentPeriodEnd: s.currentPeriodEnd,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      trialEndsAt: s.trialEndsAt,
      items: s.items.map((i) => ({
        key: i.plan.key,
        name: i.plan.name,
        quantity: i.quantity,
        interval: i.price?.interval ?? s.interval ?? null,
        unitAmount: i.price?.amount ?? null,
        currency: (i.price?.currency ?? s.currency ?? null)?.toUpperCase() ?? null,
      })),
    })),
    commission,
  };
}

// ─── Invitations and links ───────────────────────────────────────────────────────────────────────

/**
 * Invitation codes and referral links (`/invitations`), the newest 300 of each, with the customers
 * each produced that are this partner's now (the attribution's reference: "invite:<first 8 of the
 * code's hash>", "link:<code>"). The codes themselves were shown once, at creation; only hints here.
 */
export async function portalInvitations(me: PartnerMe, now: Date = new Date()): Promise<PortalInvitations> {
  const [plans, open] = await Promise.all([offeredPlans(), signupOpen()]);
  const base = { plans, signupUrl: `${siteOrigin()}/signup`, signupOpen: open };
  if (!mayOpen(me, "invitations")) return { ...base, codes: [], links: [], canSell: false };
  const control = controlDb();
  const partnerId = me.partner.id;
  const [codes, links] = await Promise.all([
    control.signupInvite.findMany({
      where: { partnerId },
      orderBy: [{ createdAt: "desc" }, { codeHash: "asc" }],
      take: LIST_CAP,
      select: { codeHash: true, codeHint: true, note: true, planKey: true, uses: true, maxUses: true, expiresAt: true, createdAt: true },
    }),
    control.partnerReferralLink.findMany({
      where: { partnerId },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: LIST_CAP,
      select: { id: true, code: true, label: true, planKey: true, signups: true, expiresAt: true, endedAt: true, createdAt: true },
    }),
  ]);
  const prefixes = [...new Set(codes.map((c) => c.codeHash.slice(0, 8)))];
  const references = [...prefixes.map((p) => `invite:${p}`), ...links.map((l) => `link:${l.code}`)];
  // An empty `in` matches nothing, so a partner with no codes or links asks nothing of these.
  const [ended, made, names] = await Promise.all([
    control.partnerAuditLog.findMany({ where: { partnerId, action: "invite.end", entityId: { in: prefixes } }, select: { entityId: true } }),
    control.tenantAttribution.findMany({
      where: { partnerId, reference: { in: references }, tenant: { is: { partnerId } } },
      orderBy: { validFrom: "desc" },
      select: { reference: true, tenant: { select: { id: true, slug: true, name: true } } },
    }),
    planNames([...codes.map((c) => c.planKey), ...links.map((l) => l.planKey)]),
  ]);
  const endedPrefixes = new Set(ended.map((e) => e.entityId));
  const byReference = new Map<string, Map<string, { slug: string; name: string }>>();
  for (const m of made) {
    if (!m.reference) continue;
    const tenants = byReference.get(m.reference) ?? new Map<string, { slug: string; name: string }>();
    tenants.set(m.tenant.id, { slug: m.tenant.slug, name: m.tenant.name });
    byReference.set(m.reference, tenants);
  }

  return {
    ...base,
    canSell: partnerCapsFor(me).sell,
    codes: codes.map((c) => {
      const prefix = c.codeHash.slice(0, 8);
      const over = !!c.expiresAt && c.expiresAt <= now;
      const state: InviteRow["state"] = c.uses >= c.maxUses ? "used" : over && endedPrefixes.has(prefix) ? "ended" : over ? "expired" : "live";
      return {
        codeHash: c.codeHash,
        codeHint: c.codeHint,
        note: c.note,
        planName: c.planKey ? (names.get(c.planKey) ?? c.planKey) : null,
        uses: c.uses,
        maxUses: c.maxUses,
        expiresAt: c.expiresAt,
        state,
        createdAt: c.createdAt,
        customers: [...(byReference.get(`invite:${prefix}`)?.values() ?? [])],
      };
    }),
    links: links.map((l) => ({
      id: l.id,
      code: l.code,
      url: referralUrl(l.code),
      label: l.label,
      planName: l.planKey ? (names.get(l.planKey) ?? l.planKey) : null,
      signups: l.signups,
      customers: byReference.get(`link:${l.code}`)?.size ?? 0,
      expiresAt: l.expiresAt,
      endedAt: l.endedAt,
      state: l.endedAt ? "ended" : l.expiresAt && l.expiresAt <= now ? "expired" : "live",
      createdAt: l.createdAt,
    })),
  };
}

// ─── Deal registrations ──────────────────────────────────────────────────────────────────────────

/** A status filter as a query; an APPROVED registration past its protection counts as EXPIRED already. */
function dealStatusWhere(status: DealStatus, now: Date): Prisma.DealRegistrationWhereInput {
  if (status === "APPROVED") return { status: "APPROVED", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
  if (status === "EXPIRED") return { OR: [{ status: "EXPIRED" }, { status: "APPROVED", expiresAt: { lte: now } }] };
  return { status };
}

/** The deal registrations (`/deals`), newest first, 50 a page, with counts by status over all of them. */
export async function portalDeals(me: PartnerMe, filters: DealFilters = {}, now: Date = new Date()): Promise<PortalDeals> {
  const [days, plans] = await Promise.all([dealDays(), offeredPlans()]);
  const base = { dealDays: days, territories: me.partner.territories, plans, asOf: now };
  const counts = Object.fromEntries(Object.keys(DEAL_STATUSES).map((s) => [s, 0])) as Record<DealStatus, number>;
  if (!mayOpen(me, "deals")) return { ...emptyPage<DealRow>(DEALS_PAGE_SIZE), ...base, counts, canSell: false };
  const control = controlDb();
  const partnerId = me.partner.id;
  const page = pageOf(filters?.page);
  const status = memberOf(DEAL_STATUSES, filters?.status);
  const where: Prisma.DealRegistrationWhereInput = { partnerId, ...(status ? dealStatusWhere(status, now) : {}) };
  const [rows, total, grouped, lapsed] = await Promise.all([
    control.dealRegistration.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * DEALS_PAGE_SIZE,
      take: DEALS_PAGE_SIZE,
      select: { id: true, companyName: true, domain: true, country: true, status: true, expiresAt: true, decisionNote: true, createdAt: true, tenant: { select: { slug: true, name: true, partnerId: true } } },
    }),
    control.dealRegistration.count({ where }),
    control.dealRegistration.groupBy({ by: ["status"], where: { partnerId }, _count: { _all: true } }),
    control.dealRegistration.count({ where: { partnerId, status: "APPROVED", expiresAt: { lte: now } } }),
  ]);
  for (const g of grouped) counts[g.status] = g._count._all;
  counts.APPROVED -= lapsed;
  counts.EXPIRED += lapsed;
  return {
    rows: rows.map((d) => ({
      id: d.id,
      companyName: d.companyName,
      domain: d.domain,
      country: d.country,
      status: d.status === "APPROVED" && d.expiresAt && d.expiresAt <= now ? "EXPIRED" : d.status,
      expiresAt: d.expiresAt,
      decisionNote: d.decisionNote,
      customer: d.tenant && d.tenant.partnerId === partnerId ? { slug: d.tenant.slug, name: d.tenant.name } : null,
      createdAt: d.createdAt,
    })),
    total,
    page,
    pageSize: DEALS_PAGE_SIZE,
    ...base,
    counts,
    canSell: partnerCapsFor(me).sell,
  };
}

// ─── Commissions and statements (money roles) ────────────────────────────────────────────────────

/**
 * The commission entries (`/commissions`), newest first, 100 a page — filtered by status, currency,
 * India dates and customer (name or address) — with totals per currency per status. Money roles only.
 */
export async function portalCommissions(me: PartnerMe, filters: CommissionFilters = {}, now: Date = new Date()): Promise<PortalCommissions> {
  void now; // Filters are India days; nothing here depends on the hour.
  if (!hasMoney(me)) return { ...emptyPage<CommissionRow>(COMMISSIONS_PAGE_SIZE), totals: [] };
  const control = controlDb();
  const f = filters ?? {};
  const page = pageOf(f.page);
  const where = commissionWhere(me, f, true);
  const [rows, total, grouped] = await Promise.all([
    control.commissionEntry.findMany({ where, orderBy: [{ earnedAt: "desc" }, { id: "desc" }], skip: (page - 1) * COMMISSIONS_PAGE_SIZE, take: COMMISSIONS_PAGE_SIZE, select: ENTRY_SELECT }),
    control.commissionEntry.count({ where }),
    control.commissionEntry.groupBy({ by: ["currency", "status"], where: { ...commissionWhere(me, f, false), status: { not: "VOID" } }, _sum: { amount: true } }),
  ]);
  const totals = new Map<string, { currency: string; pending: number; approved: number; paid: number }>();
  for (const g of grouped) {
    const currency = g.currency.trim().toUpperCase();
    const t = totals.get(currency) ?? { currency, pending: 0, approved: 0, paid: 0 };
    const amount = g._sum.amount ?? 0;
    if (g.status === "PENDING") t.pending += amount;
    else if (g.status === "APPROVED") t.approved += amount;
    else if (g.status === "PAID") t.paid += amount;
    totals.set(currency, t);
  }
  return {
    rows: rows.map((e) => commissionRow(e, me.partner.id)),
    total,
    page,
    pageSize: COMMISSIONS_PAGE_SIZE,
    totals: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
  };
}

const STATEMENT_ROW_SELECT = {
  id: true,
  number: true,
  period: true,
  currency: true,
  status: true,
  total: true,
  netPayable: true,
  partnerInvoiceNumber: true,
  approvedAt: true,
  paidAt: true,
  paymentReference: true,
} as const satisfies Prisma.PartnerStatementSelect;

function statementRow(s: Prisma.PartnerStatementGetPayload<{ select: typeof STATEMENT_ROW_SELECT }>): StatementRow {
  return {
    number: s.number,
    period: s.period,
    currency: s.currency,
    status: s.status,
    total: Number(s.total),
    netPayable: Number(s.netPayable),
    partnerInvoiceNumber: s.partnerInvoiceNumber,
    approvedAt: s.approvedAt,
    paidAt: s.paidAt,
    paymentReference: s.paymentReference,
  };
}

/** The statements (`/statements`): APPROVED and PAID only, the latest period first (at most 300). Money roles only. */
export async function portalStatements(me: PartnerMe): Promise<StatementRow[]> {
  if (!hasMoney(me)) return [];
  const rows = await controlDb().partnerStatement.findMany({
    where: { partnerId: me.partner.id, status: { in: SHOWN_STATEMENTS } },
    orderBy: [{ period: "desc" }, { currency: "asc" }, { number: "desc" }],
    take: LIST_CAP,
    select: STATEMENT_ROW_SELECT,
  });
  return rows.map(statementRow);
}

/** One APPROVED or PAID statement of this partner by its number (any case). */
async function shownStatementByNumber(me: PartnerMe, number: string) {
  const key = String(number ?? "").trim().toUpperCase().slice(0, 80);
  if (!key || !hasMoney(me)) return null;
  return controlDb().partnerStatement.findFirst({
    where: { number: key, partnerId: me.partner.id, status: { in: SHOWN_STATEMENTS } },
    select: { ...STATEMENT_ROW_SELECT, partnerSnapshot: true, taxLines: true, earned: true, reversed: true, adjustments: true },
  });
}

/**
 * One statement (`/statements/[number]`): the partner as it was recorded, the sums, tax lines and
 * entries. Null for a DRAFT or VOID one, another partner's, none — and for a role without money.
 */
export async function portalStatement(me: PartnerMe, number: string): Promise<StatementDetail | null> {
  const st = await shownStatementByNumber(me, number);
  if (!st) return null;
  const [entries, entryCount] = await Promise.all([
    controlDb().commissionEntry.findMany({ where: { statementId: st.id, partnerId: me.partner.id }, orderBy: [{ earnedAt: "asc" }, { id: "asc" }], take: STATEMENT_ENTRIES_CAP, select: ENTRY_SELECT }),
    controlDb().commissionEntry.count({ where: { statementId: st.id, partnerId: me.partner.id } }),
  ]);
  return {
    ...statementRow(st),
    snapshot: snapshotOf(st.partnerSnapshot),
    taxLines: taxLinesOf(st.taxLines),
    earned: Number(st.earned),
    reversed: Number(st.reversed),
    adjustments: Number(st.adjustments),
    entryCount,
    entries: entries.map((e) => commissionRow(e, me.partner.id)),
  };
}

/**
 * The commissions list as CSV (the same filters, oldest first), for `partnerExportCommissions`. More
 * than 10,000 entries is refused — narrow it down. Money roles only.
 */
export async function portalCommissionsCsv(me: PartnerMe, filters: CommissionFilters = {}, now: Date = new Date()): Promise<CsvExport> {
  if (!hasMoney(me)) throw new PartnerRefused("Your role cannot do that.");
  const where = commissionWhere(me, filters ?? {}, true);
  const count = await controlDb().commissionEntry.count({ where });
  if (count > CSV_MAX_ROWS) {
    throw new PartnerRefused(`That is ${count.toLocaleString("en-IN")} entries — narrow it down to at most ${CSV_MAX_ROWS.toLocaleString("en-IN")} in one export.`);
  }
  const rows = await controlDb().commissionEntry.findMany({ where, orderBy: [{ earnedAt: "asc" }, { id: "asc" }], take: CSV_MAX_ROWS + 1, select: ENTRY_SELECT });
  return commissionCsv(rows.map((e) => csvRowOf(e, me.partner.id)), { withPartner: false, filenamePrefix: "commissions" }, now);
}

/** One statement as CSV, for `partnerExportStatement`; null when the page would be notFound. Also names the statement for the audit row. */
export async function portalStatementCsv(me: PartnerMe, number: string, now: Date = new Date()): Promise<(CsvExport & { statementId: string; number: string }) | null> {
  const st = await shownStatementByNumber(me, number);
  if (!st) return null;
  const entries = await controlDb().commissionEntry.findMany({
    where: { statementId: st.id, partnerId: me.partner.id },
    orderBy: [{ earnedAt: "asc" }, { id: "asc" }],
    take: CSV_MAX_ROWS + 1,
    select: ENTRY_SELECT,
  });
  const csv = statementCsv(
    { number: st.number, currency: st.currency, total: st.total, netPayable: st.netPayable, taxLines: taxLinesOf(st.taxLines) },
    entries.map((e) => csvRowOf(e, me.partner.id)),
    now,
  );
  return { ...csv, statementId: st.id, number: st.number };
}

// ─── Profile ─────────────────────────────────────────────────────────────────────────────────────

const TERMS_VIEW_SELECT = {
  effectiveFrom: true,
  defaultRateBp: true,
  newRateBp: true,
  renewalRateBp: true,
  newMonths: true,
  durationMonths: true,
  overrideRateBp: true,
  territoryRateBp: true,
  planRates: true,
  countryRates: true,
} as const satisfies Prisma.PartnerTermsSelect;

type TermsRecord = Prisma.PartnerTermsGetPayload<{ select: typeof TERMS_VIEW_SELECT }>;

/** `planRates` ([{ planKey, rateBp }]) or `countryRates` ([{ country, rateBp }]) as stored, re-read: `key` names the first field. */
function rateRows(raw: unknown, key: "planKey" | "country"): { name: string; rateBp: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    const x = asRecord(r);
    const name = x[key];
    return typeof name === "string" && typeof x.rateBp === "number" ? [{ name, rateBp: x.rateBp }] : [];
  });
}

function termsView(t: TermsRecord, plans: Map<string, string>, distributor: boolean): TermsView {
  const pct = (bp: number | null) => (bp === null ? null : bpToPercent(bp));
  return {
    effectiveFrom: t.effectiveFrom,
    defaultRate: bpToPercent(t.defaultRateBp),
    newRate: pct(t.newRateBp),
    renewalRate: pct(t.renewalRateBp),
    newMonths: t.newMonths,
    durationMonths: t.durationMonths,
    overrideRate: distributor ? pct(t.overrideRateBp) : null,
    territoryRate: distributor ? pct(t.territoryRateBp) : null,
    planRates: rateRows(t.planRates, "planKey").map((r) => ({ planName: plans.get(r.name) ?? r.name, rate: bpToPercent(r.rateBp) })),
    countryRates: rateRows(t.countryRates, "country").map((r) => ({ country: r.name, rate: bpToPercent(r.rateBp) })),
  };
}

const PROFILE_FIELD_WORDS: Record<string, string> = {
  legalName: "legal name",
  country: "country",
  contactName: "contact name",
  contactEmail: "contact email",
  addressLine1: "address",
  addressLine2: "address",
  city: "address",
  region: "address",
  postalCode: "address",
  taxIds: "tax ids",
};

/** A request in one line of words, from its payload — a PAYOUT one from its mask alone (the sealed copy is never read). */
function requestSummary(kind: PartnerRequestKind, payload: unknown): string {
  const x = asRecord(payload);
  if (kind === "PROFILE") {
    const words = [...new Set(Object.keys(x).map((k) => PROFILE_FIELD_WORDS[k]).filter((w): w is string => !!w))];
    return words.length ? `Change of ${words.join(", ")}` : "Change of company details";
  }
  if (kind === "PAYOUT") {
    const mask = payoutMaskOf(x);
    return mask ? `New payout details: ${mask.bankName}, account ending ${mask.last4}` : "New payout details";
  }
  const name = typeof x.displayName === "string" ? x.displayName : "a new reseller";
  const territories = Array.isArray(x.territories) ? x.territories.filter((c): c is string => typeof c === "string") : [];
  return `New reseller: ${name}${territories.length ? ` (${territories.join(", ")})` : ""}`;
}

/**
 * The company profile (`/profile`), read by every role: the partner's own fields and its
 * distributor's name; for the money roles the payout mask and the terms in force and scheduled;
 * its requests (PAYOUT ones for the money roles only).
 */
export async function portalProfile(me: PartnerMe, now: Date = new Date()): Promise<PortalProfile> {
  const control = controlDb();
  const partnerId = me.partner.id;
  const money = hasMoney(me);
  const partner = await control.partner.findUnique({
    where: { id: partnerId },
    select: {
      legalName: true,
      displayName: true,
      kind: true,
      status: true,
      country: true,
      territories: true,
      contactName: true,
      contactEmail: true,
      contactPhone: true,
      website: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      region: true,
      postalCode: true,
      taxIds: true,
      publicListing: true,
      publicBlurb: true,
      parent: { select: { displayName: true } },
    },
  });
  // The session was read a moment ago; a partner gone since is a session gone.
  if (!partner) throw new PartnerRefused("Sign in to the partner portal again.");
  const distributor = partner.kind === "DISTRIBUTOR";

  const requests = await control.partnerRequest.findMany({
    where: { partnerId, ...(money ? {} : { kind: { not: "PAYOUT" } }) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
    select: { id: true, kind: true, status: true, createdAt: true, decidedAt: true, decisionNote: true, payload: true },
  });

  // Money roles only: the mask (never the cipher) and the terms (never staff's note on them).
  let payout: PayoutMask | null = null;
  let terms: PortalProfile["terms"] = null;
  if (money) {
    const [mask, inForce, scheduled] = await Promise.all([
      control.partner.findUnique({ where: { id: partnerId }, select: { payoutMask: true } }),
      control.partnerTerms.findFirst({ where: { partnerId, effectiveFrom: { lte: now } }, orderBy: { effectiveFrom: "desc" }, select: TERMS_VIEW_SELECT }),
      control.partnerTerms.findMany({ where: { partnerId, effectiveFrom: { gt: now } }, orderBy: { effectiveFrom: "asc" }, take: 20, select: TERMS_VIEW_SELECT }),
    ]);
    payout = payoutMaskOf(mask?.payoutMask);
    const all = inForce ? [inForce, ...scheduled] : scheduled;
    const plans = await planNames(all.flatMap((t) => rateRows(t.planRates, "planKey").map((r) => r.name)));
    terms = { inForce: inForce ? termsView(inForce, plans, distributor) : null, scheduled: scheduled.map((t) => termsView(t, plans, distributor)) };
  }

  return {
    partner: {
      legalName: partner.legalName,
      displayName: partner.displayName,
      kind: partner.kind,
      status: partner.status,
      country: partner.country,
      territories: partner.territories,
      contactName: partner.contactName,
      contactEmail: partner.contactEmail,
      contactPhone: partner.contactPhone,
      website: partner.website,
      address: { line1: partner.addressLine1, line2: partner.addressLine2, city: partner.city, region: partner.region, postalCode: partner.postalCode },
      taxIds: taxIdsOf(partner.taxIds),
      publicListing: partner.publicListing,
      publicBlurb: partner.publicBlurb,
      parent: partner.parent ? { displayName: partner.parent.displayName } : null,
    },
    payout,
    terms,
    requests: requests.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
      decisionNote: r.decisionNote,
      summary: requestSummary(r.kind, r.payload),
    })),
  };
}

// ─── Resellers (distributors) ────────────────────────────────────────────────────────────────────

const RESELLER_SELECT = { id: true, slug: true, displayName: true, status: true, territories: true } as const satisfies Prisma.PartnerSelect;

type ResellerRecord = Prisma.PartnerGetPayload<{ select: typeof RESELLER_SELECT }>;

/** Each reseller's aggregates: its current, not closed, customers by standing, their MRR, and how many came this IST month. */
async function resellerRows(me: PartnerMe, resellers: ResellerRecord[], now: Date): Promise<ResellerRow[]> {
  if (!resellers.length) return [];
  const month = istMonth(now);
  const tenants = await controlDb().tenant.findMany({
    where: { partnerId: { in: resellers.map((r) => r.id) }, partner: { is: { parentId: me.partner.id } }, status: { not: "DEPROVISIONED" } },
    select: { id: true, partnerId: true, attributions: CURRENT_ATTRIBUTION },
  });
  const facts = await customerFacts(tenants.map((t) => t.id), now);
  const byReseller = new Map<string, typeof tenants>();
  for (const t of tenants) if (t.partnerId) byReseller.set(t.partnerId, [...(byReseller.get(t.partnerId) ?? []), t]);
  const mrrs = await Promise.all(resellers.map((r) => attributedMrr((byReseller.get(r.id) ?? []).map((t) => t.id))));
  return resellers.map((r, i) => {
    const theirs = byReseller.get(r.id) ?? [];
    const kinds = theirs.map((t) => facts.get(t.id)?.standing.kind);
    return {
      slug: r.slug,
      displayName: r.displayName,
      status: r.status,
      territories: r.territories,
      customers: theirs.length,
      active: kinds.filter((k) => k && isActive(k)).length,
      trial: kinds.filter((k) => k === "trial").length,
      mrr: mrrs[i],
      newThisMonth: theirs.filter((t) => t.attributions[0]?.partnerId === r.id && t.attributions[0].validFrom >= month.start).length,
    };
  });
}

/**
 * A distributor's resellers (`/resellers`) with their aggregates, and its proposed resellers waiting
 * for staff. A reseller gets an empty view (the page is not for it).
 */
export async function portalResellers(me: PartnerMe, now: Date = new Date()): Promise<PortalResellers> {
  const empty: PortalResellers = { resellers: [], requests: [], territories: me.partner.territories, canRequest: false, asOf: now };
  if (!mayOpen(me, "resellers")) return empty;
  const control = controlDb();
  const [resellers, requests] = await Promise.all([
    control.partner.findMany({ where: { parentId: me.partner.id, kind: "RESELLER" }, orderBy: [{ displayName: "asc" }, { id: "asc" }], take: LIST_CAP, select: RESELLER_SELECT }),
    control.partnerRequest.findMany({
      where: { partnerId: me.partner.id, kind: "NEW_RESELLER", status: "PENDING" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
      select: { id: true, payload: true, createdAt: true },
    }),
  ]);
  const caps = partnerCapsFor(me);
  return {
    ...empty,
    resellers: await resellerRows(me, resellers, now),
    requests: requests.map((r) => {
      const x = asRecord(r.payload);
      return {
        id: r.id,
        displayName: typeof x.displayName === "string" ? x.displayName : "",
        legalName: typeof x.legalName === "string" ? x.legalName : "",
        country: typeof x.country === "string" ? x.country : "",
        territories: Array.isArray(x.territories) ? x.territories.filter((c): c is string => typeof c === "string") : [],
        createdAt: r.createdAt,
      };
    }),
    // Proposing a reseller is an ADMIN's request, and any status but TERMINATED may make requests (spec D18).
    canRequest: caps.admin && caps.distributor,
  };
}

/**
 * One reseller of this distributor (`/resellers/[slug]`): its aggregates and, for the money roles,
 * this distributor's own OVERRIDE entries on its customers — never the reseller's own commissions,
 * users or payout. Null for anybody else's reseller, or for a reseller signed in.
 */
export async function portalReseller(me: PartnerMe, slug: string, now: Date = new Date()): Promise<ResellerDetail | null> {
  if (!mayOpen(me, "resellers")) return null;
  const key = String(slug ?? "").trim().toLowerCase().slice(0, 40);
  if (!key) return null;
  const control = controlDb();
  const reseller = await control.partner.findFirst({ where: { slug: key, parentId: me.partner.id, kind: "RESELLER" }, select: RESELLER_SELECT });
  if (!reseller) return null;
  const [row] = await resellerRows(me, [reseller], now);
  let overrides: EntryRecord[] = [];
  if (hasMoney(me)) {
    overrides = await control.commissionEntry.findMany({
      // The override names the reseller in its basis; its clawbacks point at the override they reverse.
      where: {
        partnerId: me.partner.id,
        kind: "OVERRIDE",
        OR: [{ basis: { path: ["resellerId"], equals: reseller.id } }, { reverses: { is: { basis: { path: ["resellerId"], equals: reseller.id } } } }],
      },
      orderBy: [{ earnedAt: "desc" }, { id: "desc" }],
      take: LIST_CAP,
      select: ENTRY_SELECT,
    });
  }
  return { ...row, overrides: overrides.map((e) => commissionRow(e, me.partner.id)) };
}

// ─── Team, activity, account ─────────────────────────────────────────────────────────────────────

/** The team (`/team`, ADMIN): every user of this partner. */
export async function portalTeam(me: PartnerMe): Promise<PartnerUserRow[]> {
  if (!mayOpen(me, "team")) return [];
  return listPartnerUsers(me.partner.id);
}

/** The activity log (`/activity`, ADMIN): this partner's rows written visible to it, 50 a page. */
export async function portalActivity(me: PartnerMe, filters: ActivityFilters = {}): Promise<Paged<PartnerAuditRow>> {
  if (!mayOpen(me, "activity")) return emptyPage<PartnerAuditRow>(50);
  const f = filters ?? {};
  return listPartnerAudit(me.partner.id, { action: textOf(f.action, 60) || undefined, from: textOf(f.from, 10) || undefined, to: textOf(f.to, 10) || undefined, page: pageOf(f.page) }, "partner");
}

/**
 * My account (`/account`): the user, their live sessions (each with a safe handle; the session id
 * stays on the server) and whether they have an authenticator.
 */
export async function portalAccount(me: PartnerMe, sessionId: string): Promise<PortalAccount> {
  const [sessions, user] = await Promise.all([
    listPartnerSessions(me.id, sessionId),
    controlDb().partnerUser.findFirst({ where: { id: me.id, partnerId: me.partner.id }, select: { totpEnabledAt: true } }),
  ]);
  return { me, sessions, enrolled: !!user?.totpEnabledAt };
}
