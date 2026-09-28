import { istDayKey } from "@/lib/console-shared/format";
import { isoDateOrUndefined, one, parseCurrency, type RawParams } from "@/lib/console-shared/params";
import type { CommissionKind, CommissionStatus, PartnerKind, PartnerStatus, StatementStatus } from "@wroffy/control-client";

/**
 * The partner programme's URL contracts in the console: /partners, a partner's own page, /partners/requests
 * and /commissions. They read a query string the way src/lib/console-shared/params.ts reads every other
 * page's — enums whitelisted (in whatever case was typed), text trimmed and cut to 100 characters, dates
 * real `yyyy-mm-dd` days on India's calendar, pages from 1 — so a hand-edited or stale URL can only ever
 * produce a known filter, and anything unknown falls back to the default rather than failing the page.
 * The export actions run the same parsers on the server (`exportParams` → `parse…`), which is why an
 * exported CSV matches the list on screen.
 *
 * Pure and client-safe: the control plane's enums come in as types only.
 */

const MAX_PAGE = 10_000;

// ─── Building blocks (the same rules as params.ts, which keeps its own private) ──────────────────

/** A param that must be valid as a whole — a slug, a date, a number: read uncut, then checked by its pattern. */
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

/** A partner's slug, lower-cased, in the shape the database allows (3–40, no leading or trailing hyphen). */
function partnerSlug(raw: RawParams, key: string): string | undefined {
  const value = token(raw, key)?.toLowerCase();
  return value && /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(value) ? value : undefined;
}

/** A checkbox param: "1" (or "true") is on. */
function flag(raw: RawParams, key: string): boolean {
  const value = token(raw, key)?.toLowerCase();
  return value === "1" || value === "true";
}

/** Optional keys left out rather than present as undefined — the parsed object reads the same in a log or a test. */
function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

// ─── The enums, as lists (filter selects, whitelists) ────────────────────────────────────────────

export const PARTNER_KINDS: readonly PartnerKind[] = ["DISTRIBUTOR", "RESELLER"];
export const PARTNER_STATUSES: readonly PartnerStatus[] = ["ONBOARDING", "ACTIVE", "SUSPENDED", "TERMINATED"];
export const COMMISSION_STATUSES: readonly CommissionStatus[] = ["PENDING", "APPROVED", "PAID", "VOID"];
export const COMMISSION_KINDS: readonly CommissionKind[] = ["DIRECT", "OVERRIDE", "ADJUSTMENT"];
export const STATEMENT_STATUSES: readonly StatementStatus[] = ["DRAFT", "APPROVED", "PAID", "VOID"];

// ─── Partners directory (/partners) ──────────────────────────────────────────────────────────────

export type PartnerDirectoryFilters = {
  /** Part of a slug, a name or the contact's email. */
  q?: string;
  kind?: PartnerKind;
  status?: PartnerStatus;
  /** Upper-case ISO code: a country among its territories. */
  country?: string;
  /** A distributor's slug: its resellers. */
  parent?: string;
  page: number;
};

/** URL keys: `q`, `kind`, `status`, `country`, `parent`, `page`. */
export function parsePartnerDirectoryFilters(raw: RawParams): PartnerDirectoryFilters {
  return withoutUndefined({
    q: one(raw, "q"),
    kind: pick(raw, "kind", PARTNER_KINDS, "upper"),
    status: pick(raw, "status", PARTNER_STATUSES, "upper"),
    country: country(raw),
    parent: partnerSlug(raw, "parent"),
    page: page(raw),
  });
}

// ─── A partner's page (/partners/<slug>) ─────────────────────────────────────────────────────────

export const PARTNER_TABS = ["overview", "customers", "pipeline", "commissions", "statements", "users", "terms", "activity"] as const;
export type PartnerTab = (typeof PARTNER_TABS)[number];

export function parsePartnerTab(raw: RawParams): PartnerTab {
  return pick(raw, "tab", PARTNER_TABS, "lower") ?? "overview";
}

// ─── Requests (/partners/requests) ───────────────────────────────────────────────────────────────

export const REQUEST_TABS = ["applications", "deals", "changes", "resellers", "attributions"] as const;
export type RequestTab = (typeof REQUEST_TABS)[number];

export function parseRequestTab(raw: RawParams): RequestTab {
  return pick(raw, "tab", REQUEST_TABS, "lower") ?? "applications";
}

// ─── Commissions (/commissions, and a partner's Commissions and Statements tabs) ─────────────────

export const COMMISSION_TABS = ["review", "statements", "reports"] as const;
export type CommissionTab = (typeof COMMISSION_TABS)[number];

export function parseCommissionTab(raw: RawParams): CommissionTab {
  return pick(raw, "tab", COMMISSION_TABS, "lower") ?? "review";
}

export type CommissionFilters = {
  /** A partner's slug. */
  partner?: string;
  status?: CommissionStatus;
  currency?: string;
  kind?: CommissionKind;
  /** When it was earned: IST days, the earlier first. */
  from?: string;
  to?: string;
  /** Only the entries flagged for a look; left out when off. */
  flagged?: boolean;
  page: number;
};

/** URL keys: `partner`, `status`, `currency`, `kind`, `from`, `to`, `flagged=1`, `page`. The loader picks the tab's default status. */
export function parseCommissionFilters(raw: RawParams): CommissionFilters {
  return withoutUndefined({
    partner: partnerSlug(raw, "partner"),
    status: pick(raw, "status", COMMISSION_STATUSES, "upper"),
    currency: parseCurrency(raw),
    kind: pick(raw, "kind", COMMISSION_KINDS, "upper"),
    ...dateRange(raw),
    flagged: flag(raw, "flagged") || undefined,
    page: page(raw),
  });
}

export type StatementFilters = {
  /** A partner's slug. */
  partner?: string;
  status?: StatementStatus;
  currency?: string;
  /** The IST month a statement is for: "2026-09". */
  period?: string;
  page: number;
};

/** URL keys: `partner`, `status`, `currency`, `period`, `page`. */
export function parseStatementFilters(raw: RawParams): StatementFilters {
  const period = token(raw, "period");
  return withoutUndefined({
    partner: partnerSlug(raw, "partner"),
    status: pick(raw, "status", STATEMENT_STATUSES, "upper"),
    currency: parseCurrency(raw),
    period: period && /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(period) ? period : undefined,
    page: page(raw),
  });
}

/** The Reports tab's window: IST days. Without them it is the current IST year to date (`reportRange`). */
export type ReportFilters = { from?: string; to?: string };

/** URL keys: `from`, `to`. Only what the URL says — `reportRange` fills in the default, so this stays free of the clock. */
export function parseReportFilters(raw: RawParams): ReportFilters {
  return withoutUndefined(dateRange(raw));
}

/**
 * The window a report covers: the days asked for, the missing ends filled with the current IST year to
 * date (1 January to today, India's calendar), the earlier first. The page and the loader both call it,
 * with the loader's `now`, so the heading and the numbers describe the same days.
 */
export function reportRange(f: ReportFilters, now = new Date()): { from: string; to: string } {
  const today = istDayKey(now);
  const from = f.from ?? `${today.slice(0, 4)}-01-01`;
  const to = f.to ?? today;
  return from <= to ? { from, to } : { from: to, to: from };
}
