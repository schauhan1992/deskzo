import { DIRECTORY_GATEWAY_LABELS, STANDING_KIND_LABEL, TENANT_STATUS } from "@/lib/console-shared/labels";
import { dayKeyLabel } from "@/lib/console-shared/format";
import { ALL_ROLES } from "@/lib/console-shared/roles";
import type {
  AuditCategoryKey,
  ConsoleRole,
  GatewayKey,
  InvoiceStatusKey,
  PlanKindKey,
  StandingKind,
  SubscriptionStatusKey,
  TenantStatusKey,
} from "@/lib/console-shared/types";
import { PRIORITY_LABELS, SUPPORT_PRIORITIES, type SupportPriorityKey } from "@/lib/support/types";

/**
 * The console's URL contracts. Every page, loader and export reads its query string through one of
 * these parsers, so a hand-edited or stale URL can only ever produce a known filter: enums are
 * whitelisted, text is trimmed and cut to 100 characters, dates must be real `yyyy-mm-dd` days, page
 * numbers start at 1. Anything unknown falls back to the default rather than failing the page.
 *
 * The same parsers run on the server for the export actions (`exportParams` → `parse…`), which is
 * why an exported CSV always matches the list on screen.
 */

export type RawParams = Record<string, string | string[] | undefined>;

const MAX_PAGE = 10_000;

/** The first value of a param, trimmed and cut to `max`; empty is undefined. */
export function one(raw: RawParams, key: string, max = 100): string | undefined {
  const value = raw[key];
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== "string") return undefined;
  const text = first.trim().slice(0, max).trim();
  return text || undefined;
}

/**
 * `path` with the current params, some of them changed. A null, undefined or empty change removes
 * the param. Changing anything but `page`/`cursor` also drops those two (a new filter starts at the
 * first page) unless `changes` sets them itself.
 */
export function withParams(path: string, current: RawParams, changes: Record<string, string | number | null | undefined>): string {
  const changed = Object.keys(changes);
  const resetPaging = changed.some((k) => k !== "page" && k !== "cursor");
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(current)) {
    if (changed.includes(key)) continue;
    if (resetPaging && (key === "page" || key === "cursor")) continue;
    for (const v of Array.isArray(value) ? value : [value]) if (typeof v === "string" && v !== "") params.append(key, v);
  }
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/** The filters of a page as plain strings, for binding to an export action (paging left out). */
export function exportParams(raw: RawParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(raw).slice(0, 40)) {
    if (key === "page" || key === "cursor" || key === "pageSize" || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key)) continue;
    const value = key === "ids" ? idsParam(raw)?.join(",") : one(raw, key);
    if (value) out[key] = value;
  }
  return out;
}

/** `yyyy-mm-dd` naming a real day, or undefined. */
export function isoDateOrUndefined(v: string | undefined): string | undefined {
  if (typeof v !== "string") return undefined;
  const text = v.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const at = new Date(Date.UTC(year, month, day));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month && at.getUTCDate() === day ? text : undefined;
}

// ─── Building blocks ─────────────────────────────────────────────────────────────────────────────

/**
 * A param that must be valid as a whole — an id, a key, a date, a number. Read uncut (up to a sane
 * length) and checked by its pattern: cutting it first would turn "IND" into "IN".
 */
function token(raw: RawParams, key: string): string | undefined {
  return one(raw, key, 200);
}

/** A whitelisted value; `upper`/`lower` forgive the case a person typed. */
function pick<T extends string>(raw: RawParams, key: string, allowed: readonly T[], fold?: "upper" | "lower"): T | undefined {
  let value = token(raw, key);
  if (value === undefined) return undefined;
  if (fold === "upper") value = value.toUpperCase();
  if (fold === "lower") value = value.toLowerCase();
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function page(raw: RawParams): number {
  const n = Number(token(raw, "page"));
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_PAGE) : 1;
}

/** `from`/`to` as real days, the earlier first. */
function dateRange(raw: RawParams): { from?: string; to?: string } {
  const from = isoDateOrUndefined(token(raw, "from"));
  const to = isoDateOrUndefined(token(raw, "to"));
  if (from && to && from > to) return { from: to, to: from };
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

function country(raw: RawParams, key = "country"): string | undefined {
  const value = token(raw, key)?.toUpperCase();
  return value && /^[A-Z]{2}$/.test(value) ? value : undefined;
}

/** A workspace's address (slug), lower-cased. */
function slug(raw: RawParams, key: string): string | undefined {
  const value = token(raw, key)?.toLowerCase();
  return value && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value) ? value : undefined;
}

function recordId(raw: RawParams, key: string): string | undefined {
  const value = token(raw, key);
  return value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
}

/** Selected rows: repeated `ids` params or one comma-separated list; de-duplicated, at most 100. */
function idsParam(raw: RawParams): string[] | undefined {
  const value = raw.ids;
  const all = (Array.isArray(value) ? value : [value]).slice(0, 100).flatMap((v) => (typeof v === "string" ? v.split(",") : []));
  const ids = [...new Set(all.map((v) => v.trim()).filter((v) => /^[A-Za-z0-9_-]{1,64}$/.test(v)))].slice(0, 100);
  return ids.length ? ids : undefined;
}

const TENANT_STATUSES: readonly TenantStatusKey[] = ["PROVISIONING", "ACTIVE", "SUSPENDED", "MIGRATING", "DEPROVISIONED"];
const STANDING_KINDS: readonly StandingKind[] = ["exempt", "paid", "trial", "trial-over", "past-due", "ending", "lapsed", "none"];
const GATEWAYS: readonly GatewayKey[] = ["MANUAL", "STRIPE", "RAZORPAY"];
const SUBSCRIPTION_STATUSES: readonly SubscriptionStatusKey[] = ["INCOMPLETE", "TRIALING", "ACTIVE", "PAST_DUE", "CANCELLED"];
const INVOICE_STATUSES: readonly InvoiceStatusKey[] = ["DRAFT", "OPEN", "PAID", "VOID", "UNCOLLECTIBLE"];
const PLAN_KINDS: readonly PlanKindKey[] = ["EDITION", "BUNDLE", "ADDON", "INTERNAL"];
const AUDIT_CATEGORY_KEYS: readonly AuditCategoryKey[] = ["lifecycle", "billing", "staff", "support", "setup", "reference", "invites", "notes", "terminals", "console", "partners"];

// ─── Workspaces directory ────────────────────────────────────────────────────────────────────────

export const DIRECTORY_VIEWS = ["all", "attention", "trials", "past-due", "held", "setting-up", "behind", "closed"] as const;
export type DirectoryView = (typeof DIRECTORY_VIEWS)[number];
export const DIRECTORY_SORTS = ["-created", "created", "name", "-seats", "trial", "standing"] as const;
export type DirectorySort = (typeof DIRECTORY_SORTS)[number];
export const DIRECTORY_GATEWAYS = ["STRIPE", "RAZORPAY", "TRIAL", "GIVEN", "NONE"] as const;
export const DIRECTORY_PAGE_SIZES = [25, 50, 100] as const;

export type DirectoryFilters = {
  view: DirectoryView;
  q?: string;
  status?: TenantStatusKey;
  heldFor?: "STAFF" | "BILLING";
  /** Upper-case ISO code. */
  country?: string;
  plan?: string;
  gateway?: "STRIPE" | "RAZORPAY" | "TRIAL" | "GIVEN" | "NONE";
  standing?: StandingKind;
  /** Lower-case. */
  tag?: string;
  schema?: "behind" | "current";
  grant?: "live";
  from?: string;
  to?: string;
  sort: DirectorySort;
  page: number;
  pageSize: 25 | 50 | 100;
  /** Selected rows (export selected); at most 100. */
  ids?: string[];
};

export function parseDirectoryFilters(raw: RawParams): DirectoryFilters {
  const plan = token(raw, "plan")?.toLowerCase();
  const tag = token(raw, "tag")?.toLowerCase();
  const size = Number(token(raw, "pageSize"));
  const f: DirectoryFilters = {
    view: pick(raw, "view", DIRECTORY_VIEWS, "lower") ?? "all",
    q: one(raw, "q"),
    status: pick(raw, "status", TENANT_STATUSES, "upper"),
    heldFor: pick(raw, "heldFor", ["STAFF", "BILLING"] as const, "upper"),
    country: country(raw),
    plan: plan && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(plan) ? plan : undefined,
    gateway: pick(raw, "gateway", DIRECTORY_GATEWAYS, "upper"),
    standing: pick(raw, "standing", STANDING_KINDS, "lower"),
    tag: tag && /^[a-z0-9][a-z0-9-]{0,23}$/.test(tag) ? tag : undefined,
    schema: pick(raw, "schema", ["behind", "current"] as const, "lower"),
    grant: pick(raw, "grant", ["live"] as const, "lower"),
    ...dateRange(raw),
    sort: pick(raw, "sort", DIRECTORY_SORTS, "lower") ?? "-created",
    page: page(raw),
    pageSize: (DIRECTORY_PAGE_SIZES as readonly number[]).includes(size) ? (size as 25 | 50 | 100) : 50,
    ids: idsParam(raw),
  };
  return withoutUndefined(f);
}

/** The active filters as removable chips; `key` is the param a chip's ✕ removes. View, sort and paging are not chips. */
export function directoryChips(f: DirectoryFilters): { key: string; label: string }[] {
  const chips: { key: string; label: string }[] = [];
  if (f.q) chips.push({ key: "q", label: `Search: “${f.q}”` });
  if (f.status) chips.push({ key: "status", label: `Status: ${TENANT_STATUS[f.status].label}` });
  if (f.heldFor) chips.push({ key: "heldFor", label: f.heldFor === "BILLING" ? "Held for billing" : "Held by staff" });
  if (f.plan) chips.push({ key: "plan", label: `Plan: ${f.plan}` });
  if (f.gateway) chips.push({ key: "gateway", label: `Pays: ${DIRECTORY_GATEWAY_LABELS[f.gateway]}` });
  if (f.standing) chips.push({ key: "standing", label: `Standing: ${STANDING_KIND_LABEL[f.standing]}` });
  if (f.country) chips.push({ key: "country", label: `Country: ${f.country}` });
  if (f.tag) chips.push({ key: "tag", label: `Tag: ${f.tag}` });
  if (f.schema) chips.push({ key: "schema", label: f.schema === "behind" ? "Behind schema" : "Schema up to date" });
  if (f.grant) chips.push({ key: "grant", label: "Support access live" });
  if (f.from) chips.push({ key: "from", label: `Created from ${dayKeyLabel(f.from)}` });
  if (f.to) chips.push({ key: "to", label: `Created until ${dayKeyLabel(f.to)}` });
  if (f.ids?.length) chips.push({ key: "ids", label: `${f.ids.length} selected` });
  return chips;
}

// ─── Workspace 360 ───────────────────────────────────────────────────────────────────────────────

export const WORKSPACE_TABS = ["overview", "plan", "billing", "usage", "support", "operations", "activity", "notes"] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

export function parseWorkspaceTab(raw: RawParams): WorkspaceTab {
  return pick(raw, "tab", WORKSPACE_TABS, "lower") ?? "overview";
}

// ─── Trials, signups, invitations ────────────────────────────────────────────────────────────────

export const TRIAL_VIEWS = ["ending", "later", "grace", "held", "all"] as const;
export type TrialView = (typeof TRIAL_VIEWS)[number];

export function parseTrialView(raw: RawParams): TrialView {
  return pick(raw, "view", TRIAL_VIEWS, "lower") ?? "ending";
}

export type StuckStage = "never-verified" | "setup-stuck" | "never-landed";
export const STUCK_STAGES: readonly StuckStage[] = ["never-verified", "setup-stuck", "never-landed"];
export type SignupFilters = { from?: string; to?: string; stage?: StuckStage; q?: string; page: number };

/** The loader applies the 30-day default when there is no range. */
export function parseSignupFilters(raw: RawParams): SignupFilters {
  return withoutUndefined({ ...dateRange(raw), stage: pick(raw, "stage", STUCK_STAGES, "lower"), q: one(raw, "q"), page: page(raw) });
}

export type InviteState = "live" | "used" | "expired" | "ended";
export type InviteFilters = { status: "live" | "used" | "expired" /* expired or ended */ | "all"; q?: string; page: number };

export function parseInviteFilters(raw: RawParams): InviteFilters {
  return withoutUndefined({ status: pick(raw, "status", ["live", "used", "expired", "all"] as const, "lower") ?? "live", q: one(raw, "q"), page: page(raw) });
}

// ─── Billing ─────────────────────────────────────────────────────────────────────────────────────

export const BILLING_TABS = ["overview", "invoices", "subscriptions", "events"] as const;
export type BillingTab = (typeof BILLING_TABS)[number];

export function parseBillingTab(raw: RawParams): BillingTab {
  return pick(raw, "tab", BILLING_TABS, "lower") ?? "overview";
}

export type InvoiceFilters = { status?: InvoiceStatusKey; gateway?: GatewayKey; currency?: string; tenant?: string /* slug */; from?: string; to?: string; page: number };
export type SubscriptionFilters = { status?: SubscriptionStatusKey; gateway?: GatewayKey; interval?: "MONTH" | "YEAR"; tenant?: string; page: number };
export type EventFilters = { gateway?: "STRIPE" | "RAZORPAY"; state?: "failed" | "waiting" | "processed"; type?: string; tenant?: string; from?: string; to?: string; page: number };

export function parseInvoiceFilters(raw: RawParams): InvoiceFilters {
  return withoutUndefined({
    status: pick(raw, "status", INVOICE_STATUSES, "upper"),
    gateway: pick(raw, "gateway", GATEWAYS, "upper"),
    currency: parseCurrency(raw),
    tenant: slug(raw, "tenant"),
    ...dateRange(raw),
    page: page(raw),
  });
}

export function parseSubscriptionFilters(raw: RawParams): SubscriptionFilters {
  return withoutUndefined({
    status: pick(raw, "status", SUBSCRIPTION_STATUSES, "upper"),
    gateway: pick(raw, "gateway", GATEWAYS, "upper"),
    interval: pick(raw, "interval", ["MONTH", "YEAR"] as const, "upper"),
    tenant: slug(raw, "tenant"),
    page: page(raw),
  });
}

export function parseEventFilters(raw: RawParams): EventFilters {
  const type = one(raw, "type");
  return withoutUndefined({
    gateway: pick(raw, "gateway", ["STRIPE", "RAZORPAY"] as const, "upper"),
    state: pick(raw, "state", ["failed", "waiting", "processed"] as const, "lower"),
    // Event names are dotted words ("customer.subscription.updated"); a search is a part of one.
    type: type && /^[A-Za-z0-9_.*-]+$/.test(type) ? type : undefined,
    tenant: slug(raw, "tenant"),
    ...dateRange(raw),
    page: page(raw),
  });
}

/** `?currency=` as an ISO 4217 code. */
export function parseCurrency(raw: RawParams): string | undefined {
  const value = token(raw, "currency")?.toUpperCase();
  return value && /^[A-Z]{3}$/.test(value) ? value : undefined;
}

// ─── Plans ───────────────────────────────────────────────────────────────────────────────────────

export type PlanCatalogueFilters = { kind?: PlanKindKey; country?: string; retired: boolean; view: "cards" | "compare" };

export function parsePlanCatalogueFilters(raw: RawParams): PlanCatalogueFilters {
  return withoutUndefined({
    kind: pick(raw, "kind", PLAN_KINDS, "upper"),
    country: country(raw),
    retired: flag(raw, "retired"),
    view: pick(raw, "view", ["cards", "compare"] as const, "lower") ?? "cards",
  });
}

// ─── Operations ──────────────────────────────────────────────────────────────────────────────────

export type ProvisioningFilters = { filter: "all" | "attention" | "progress" | "done"; q?: string; page: number };
export type MigrationFilters = { outcome: "all" | "failed"; q?: string; page: number };
export type TerminalState = "live" | "quiet" | "stale" | "never";
export const TERMINAL_STATES: readonly TerminalState[] = ["live", "quiet", "stale", "never"];
export type TerminalFilters = { q?: string; tenant?: string; state?: TerminalState; page: number };

export function parseProvisioningFilters(raw: RawParams): ProvisioningFilters {
  return withoutUndefined({ filter: pick(raw, "filter", ["all", "attention", "progress", "done"] as const, "lower") ?? "all", q: one(raw, "q"), page: page(raw) });
}

export function parseMigrationFilters(raw: RawParams): MigrationFilters {
  return withoutUndefined({ outcome: pick(raw, "outcome", ["all", "failed"] as const, "lower") ?? "all", q: one(raw, "q"), page: page(raw) });
}

export function parseTerminalFilters(raw: RawParams): TerminalFilters {
  return withoutUndefined({ q: one(raw, "q"), tenant: slug(raw, "tenant"), state: pick(raw, "state", TERMINAL_STATES, "lower"), page: page(raw) });
}

// ─── Staff, audit ────────────────────────────────────────────────────────────────────────────────

export type StaffFilters = { q?: string; role?: ConsoleRole; status: "active" | "off" | "all" };

export function parseStaffFilters(raw: RawParams): StaffFilters {
  return withoutUndefined({ q: one(raw, "q"), role: pick(raw, "role", ALL_ROLES, "upper"), status: pick(raw, "status", ["active", "off", "all"] as const, "lower") ?? "active" });
}

export type AuditFilters = {
  q?: string;
  actorKind?: "STAFF" | "SCRIPT" | "SYSTEM";
  /** A staff member's id. */
  staff?: string;
  /** Part of a staff member's name or email. */
  who?: string;
  /** An action key or its beginning ("tenant.", "billing.event"). */
  action?: string;
  category?: AuditCategoryKey;
  /** A workspace's slug. */
  tenant?: string;
  from?: string;
  to?: string;
  cursor?: string;
  /** 50 by default, 200 at most. */
  limit: number;
};

/** URL key `kind` → `actorKind`. */
export function parseAuditFilters(raw: RawParams): AuditFilters {
  const action = token(raw, "action");
  const limit = Number(token(raw, "limit"));
  return withoutUndefined({
    q: one(raw, "q"),
    actorKind: pick(raw, "kind", ["STAFF", "SCRIPT", "SYSTEM"] as const, "upper"),
    staff: recordId(raw, "staff"),
    who: one(raw, "who"),
    action: action && /^[a-z0-9][a-z0-9.:_-]{0,63}$/i.test(action) ? action : undefined,
    category: pick(raw, "category", AUDIT_CATEGORY_KEYS, "lower"),
    tenant: slug(raw, "tenant"),
    ...dateRange(raw),
    cursor: recordId(raw, "cursor"),
    limit: Number.isInteger(limit) && limit >= 1 ? Math.min(limit, 200) : 50,
  });
}

// ─── Alerts, announcements ───────────────────────────────────────────────────────────────────────

export type AlertSeverity = "critical" | "warning" | "info";
export type AlertCategory = "setup" | "migrations" | "billing" | "trials" | "jobs" | "reference" | "security" | "workspaces";
export const ALERT_SEVERITIES: readonly AlertSeverity[] = ["critical", "warning", "info"];
export const ALERT_CATEGORIES: readonly AlertCategory[] = ["setup", "migrations", "billing", "trials", "jobs", "reference", "security", "workspaces"];
export type AlertFilters = { severity?: AlertSeverity; category?: AlertCategory; q?: string; showAcked: boolean };

/** URL key `acked=1` → `showAcked`. */
export function parseAlertFilters(raw: RawParams): AlertFilters {
  return withoutUndefined({
    severity: pick(raw, "severity", ALERT_SEVERITIES, "lower"),
    category: pick(raw, "category", ALERT_CATEGORIES, "lower"),
    q: one(raw, "q"),
    showAcked: flag(raw, "acked"),
  });
}

export const ANNOUNCEMENT_TABS = ["live", "scheduled", "ended", "archived"] as const;
export type AnnouncementTab = (typeof ANNOUNCEMENT_TABS)[number];

export function parseAnnouncementTab(raw: RawParams): AnnouncementTab {
  return pick(raw, "tab", ANNOUNCEMENT_TABS, "lower") ?? "live";
}

// ─── Support ─────────────────────────────────────────────────────────────────────────────────────

/** The inbox's tabs: Open is OPEN and IN_PROGRESS together — everything not waiting on the customer or done. */
export const SUPPORT_STATUS_TABS = ["open", "waiting", "resolved", "closed", "all"] as const;
export type SupportStatusTab = (typeof SUPPORT_STATUS_TABS)[number];
export const SUPPORT_ASSIGNEE_FILTERS = ["anyone", "me", "unassigned"] as const;
export type SupportAssigneeFilter = (typeof SUPPORT_ASSIGNEE_FILTERS)[number];
export type SupportFilters = {
  status: SupportStatusTab;
  priority?: SupportPriorityKey;
  /** A workspace's slug. */
  workspace?: string;
  assignee: SupportAssigneeFilter;
  /** The subject, the requester's email, or the number ("SR-1042", "1042"). */
  q?: string;
  page: number;
};

/** URL keys: `status`, `priority`, `workspace`, `assignee`, `q`, `page`. */
export function parseSupportFilters(raw: RawParams): SupportFilters {
  return withoutUndefined({
    status: pick(raw, "status", SUPPORT_STATUS_TABS, "lower") ?? "open",
    priority: pick(raw, "priority", SUPPORT_PRIORITIES, "upper"),
    workspace: slug(raw, "workspace"),
    assignee: pick(raw, "assignee", SUPPORT_ASSIGNEE_FILTERS, "lower") ?? "anyone",
    q: one(raw, "q"),
    page: page(raw),
  });
}

/** The active filters as removable chips; the status tab and paging are not chips. */
export function supportChips(f: SupportFilters): { key: string; label: string }[] {
  const chips: { key: string; label: string }[] = [];
  if (f.q) chips.push({ key: "q", label: `Search: “${f.q}”` });
  if (f.priority) chips.push({ key: "priority", label: `Priority: ${PRIORITY_LABELS[f.priority]}` });
  if (f.workspace) chips.push({ key: "workspace", label: `Workspace: ${f.workspace}` });
  if (f.assignee === "me") chips.push({ key: "assignee", label: "Assigned to me" });
  if (f.assignee === "unassigned") chips.push({ key: "assignee", label: "Unassigned" });
  return chips;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────────

/** A checkbox param: "1" (or "true") is on. */
function flag(raw: RawParams, key: string): boolean {
  const value = token(raw, key)?.toLowerCase();
  return value === "1" || value === "true";
}

/** Optional keys left out rather than present as undefined — the parsed object reads the same in a log or a test. */
function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
