import Papa from "papaparse";
import type { BillingGateway, BillingInterval, Prisma, SubscriptionStatus } from "@wroffy/control-client";
import { usageDay } from "@/lib/copilot/settings";
import { csvFilename, istMonthKey } from "@/lib/console-shared/format";
import { INVOICE_STATUS, gatewayLabel } from "@/lib/console-shared/labels";
import type { InvoiceFilters, SubscriptionFilters } from "@/lib/console-shared/params";
import type { CsvExport, GatewayKey, GatewayModes, InvoiceStatusKey, PlanKindKey, SubscriptionStatusKey } from "@/lib/console-shared/types";
import { endOfIndianDay, istDateParts, istDateTimeInput, istMidnight, startOfIndianDay } from "@/lib/india-time";
import { EXPORT_CAPS, clampInt } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import { LIVE_STATUSES } from "@/lib/platform/entitlements";
import { ConsoleRefused } from "@/lib/platform/refused";
import { gatewayModes } from "@/lib/platform/settings";

/**
 * Revenue, as the control plane recorded it from the gateways' webhooks — before tax, and not
 * accounting figures: the books are the gateways' and the accountant's. The console's Billing
 * overview, the Overview's money tiles (sellers only) and the Trials page's cohorts read it here.
 *
 *   · Money is in each currency's smallest unit (paise, cents), per currency — never added across
 *     currencies and never converted. There is no exchange rate here, on purpose.
 *   · Months and days are India's (src/lib/india-time.ts): a payment at 00:30 IST on 1 September is
 *     September's, whatever the server's clock says.
 *   · A plan given by hand (MANUAL) has no price and brings in nothing; a subscription trialing at a
 *     gateway is not paying yet. Neither is counted as revenue. A gateway item with no price is
 *     counted as "unpriced" rather than guessed.
 *
 * Plain loaders, called by console pages after `consoleStaff`, and by the platform tick for the daily
 * snapshot. Nothing here selects a secret.
 */

export type Money = { currency: string; minor: number };

const GATEWAYS: BillingGateway[] = ["STRIPE", "RAZORPAY"];
/** Paying at a gateway: a subscription trialing there has not paid anything yet. */
const PAYING: SubscriptionStatus[] = ["ACTIVE", "PAST_DUE"];
const DAY = 86_400_000;
const PAGE_SIZE = 50;

// ─── Monthly value ───────────────────────────────────────────────────────────────────────────────

/**
 * An amount a month, kept as two whole sums — what is charged monthly, and what is charged yearly —
 * so adding items up is exact and does not depend on their order; divided by twelve only at the end.
 */
type Tally = { monthly: number; yearly: number };
const tally = (): Tally => ({ monthly: 0, yearly: 0 });

/** One item's price times its quantity (the price is per unit — per seat when it is charged per seat). */
function add(t: Tally, price: { amount: number; interval: BillingInterval }, quantity: number): void {
  const value = price.amount * quantity;
  if (price.interval === "YEAR") t.yearly += value;
  else t.monthly += value;
}

/** A month's worth, in whole minor units. */
const perMonth = (t: Tally): number => Math.round(t.monthly + t.yearly / 12);

const upper = (currency: string) => currency.trim().toUpperCase();

/** Currencies in a stable order: the one most workspaces pay in first, then alphabetically. */
const byReach = (a: { currency: string; n: number }, b: { currency: string; n: number }) => b.n - a.n || a.currency.localeCompare(b.currency);

/** The IST month keys ("2026-09") of the last `months` months, oldest first, ending with `now`'s; and the instant the first began. */
function monthWindow(months: number, now: Date): { keys: string[]; start: Date } {
  const { year, month } = istDateParts(now);
  const keys = Array.from({ length: months }, (_, i) => istMonthKey(istMidnight(year, month - (months - 1) + i, 1)));
  return { keys, start: istMidnight(year, month - (months - 1), 1) };
}

// ─── MRR ─────────────────────────────────────────────────────────────────────────────────────────

export type MrrRow = {
  currency: string;
  /** Minor units a month, before tax. */
  mrr: number;
  /** `mrr` × 12. */
  arr: number;
  subscriptions: number;
  /** Distinct workspaces — Razorpay has a subscription per plan, so one workspace may have several. */
  workspaces: number;
  /** The part of `mrr` whose payment has failed and is being retried. */
  pastDue: number;
  /** The part of `mrr` set to cancel at the end of its period. */
  ending: number;
};
export type MrrSummary = { rows: MrrRow[]; unpriced: number; asOf: Date };
export type MrrByPlan = { currency: string; plans: { key: string; name: string; mrr: number }[] }[];

type CurrencyTally = {
  mrr: Tally;
  pastDue: Tally;
  ending: Tally;
  subscriptions: Set<string>;
  workspaces: Set<string>;
  plans: Map<string, { name: string; mrr: Tally }>;
};

/** Every item of every subscription paying at a gateway, tallied per currency (and per plan within it). */
async function payingTally(): Promise<{ currencies: Map<string, CurrencyTally>; unpriced: number }> {
  const items = await controlDb().subscriptionItem.findMany({
    where: { subscription: { gateway: { in: GATEWAYS }, status: { in: PAYING } } },
    select: {
      subscriptionId: true,
      quantity: true,
      plan: { select: { key: true, name: true } },
      price: { select: { amount: true, currency: true, interval: true } },
      subscription: { select: { tenantId: true, status: true, cancelAtPeriodEnd: true } },
    },
  });
  const currencies = new Map<string, CurrencyTally>();
  let unpriced = 0;
  for (const item of items) {
    if (!item.price) {
      unpriced += 1;
      continue;
    }
    const currency = upper(item.price.currency);
    let c = currencies.get(currency);
    if (!c) {
      c = { mrr: tally(), pastDue: tally(), ending: tally(), subscriptions: new Set(), workspaces: new Set(), plans: new Map() };
      currencies.set(currency, c);
    }
    add(c.mrr, item.price, item.quantity);
    if (item.subscription.status === "PAST_DUE") add(c.pastDue, item.price, item.quantity);
    if (item.subscription.cancelAtPeriodEnd) add(c.ending, item.price, item.quantity);
    c.subscriptions.add(item.subscriptionId);
    c.workspaces.add(item.subscription.tenantId);
    let plan = c.plans.get(item.plan.key);
    if (!plan) {
      plan = { name: item.plan.name, mrr: tally() };
      c.plans.set(item.plan.key, plan);
    }
    add(plan.mrr, item.price, item.quantity);
  }
  return { currencies, unpriced };
}

const inReachOrder = (currencies: Map<string, CurrencyTally>) =>
  [...currencies].map(([currency, c]) => ({ currency, c, n: c.workspaces.size })).sort(byReach);

/** Monthly recurring revenue per currency, from what the gateways charge (features F8). */
export async function mrrByCurrency(now = new Date()): Promise<MrrSummary> {
  const { currencies, unpriced } = await payingTally();
  const rows = inReachOrder(currencies).map(({ currency, c }) => {
    const mrr = perMonth(c.mrr);
    return { currency, mrr, arr: mrr * 12, subscriptions: c.subscriptions.size, workspaces: c.workspaces.size, pastDue: perMonth(c.pastDue), ending: perMonth(c.ending) };
  });
  return { rows, unpriced, asOf: now };
}

/** The same MRR, split by plan within each currency — largest first. */
export async function mrrByPlan(now = new Date()): Promise<MrrByPlan> {
  void now; // Today's subscriptions; the clock is in the signature for symmetry with mrrByCurrency.
  const { currencies } = await payingTally();
  return inReachOrder(currencies).map(({ currency, c }) => ({
    currency,
    plans: [...c.plans]
      .map(([key, p]) => ({ key, name: p.name, mrr: perMonth(p.mrr) }))
      .sort((a, b) => b.mrr - a.mrr || a.name.localeCompare(b.name)),
  }));
}

// ─── Collected, outstanding ──────────────────────────────────────────────────────────────────────

export type CollectedByMonth = {
  /** IST months, oldest first: "2026-09". */
  months: string[];
  /** Per currency, one value per month (minor units paid), aligned with `months`. */
  series: { currency: string; values: number[] }[];
  /** Open and uncollectible invoices: what is still owed, per currency. */
  outstanding: Money[];
  /** The current month's value of each series. */
  thisMonth: Money[];
};

/** Paid invoices by the IST month they were paid in (or issued in, when the gateway gave no payment time). */
export async function collectedByMonth(months = 12, now = new Date()): Promise<CollectedByMonth> {
  const n = clampInt(months, 1, 36, 12);
  const { keys, start } = monthWindow(n, now);
  const control = controlDb();
  const [paid, owed] = await Promise.all([
    control.invoice.findMany({
      where: { status: "PAID", OR: [{ paidAt: { gte: start } }, { paidAt: null, issuedAt: { gte: start } }] },
      select: { paidAt: true, issuedAt: true, amountPaid: true, currency: true },
    }),
    control.invoice.groupBy({ by: ["currency"], where: { status: { in: ["OPEN", "UNCOLLECTIBLE"] } }, _sum: { total: true, amountPaid: true } }),
  ]);

  const index = new Map(keys.map((key, i) => [key, i]));
  const byCurrency = new Map<string, { values: number[]; n: number }>();
  for (const invoice of paid) {
    const at = index.get(istMonthKey(invoice.paidAt ?? invoice.issuedAt));
    if (at === undefined) continue; // Dated after this month — nothing to put it against.
    const currency = upper(invoice.currency);
    let s = byCurrency.get(currency);
    if (!s) {
      s = { values: keys.map(() => 0), n: 0 };
      byCurrency.set(currency, s);
    }
    s.values[at] += invoice.amountPaid;
    s.n += 1;
  }
  const series = [...byCurrency].map(([currency, s]) => ({ currency, values: s.values, n: s.n })).sort(byReach).map(({ currency, values }) => ({ currency, values }));

  const outstanding = new Map<string, number>();
  for (const row of owed) {
    const currency = upper(row.currency);
    outstanding.set(currency, (outstanding.get(currency) ?? 0) + (row._sum.total ?? 0) - (row._sum.amountPaid ?? 0));
  }
  return {
    months: keys,
    series,
    outstanding: [...outstanding]
      .filter(([, minor]) => minor > 0)
      .map(([currency, minor]) => ({ currency, minor }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    thisMonth: series.map((s) => ({ currency: s.currency, minor: s.values[s.values.length - 1] ?? 0 })),
  };
}

// ─── Subscriptions, plans ────────────────────────────────────────────────────────────────────────

export type SubscriptionStatusCount = { gateway: GatewayKey; status: SubscriptionStatusKey; n: number };

const GATEWAY_ORDER: GatewayKey[] = ["STRIPE", "RAZORPAY", "MANUAL"];
const STATUS_ORDER: SubscriptionStatusKey[] = ["ACTIVE", "TRIALING", "PAST_DUE", "INCOMPLETE", "CANCELLED"];

/** How many subscriptions there are of each gateway and status — the ended ones included. */
export async function subscriptionStatusCounts(): Promise<SubscriptionStatusCount[]> {
  const rows = await controlDb().subscription.groupBy({ by: ["gateway", "status"], _count: { _all: true } });
  return rows
    .map((r) => ({ gateway: r.gateway, status: r.status, n: r._count._all }))
    .sort((a, b) => GATEWAY_ORDER.indexOf(a.gateway) - GATEWAY_ORDER.indexOf(b.gateway) || STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
}

/**
 * Each plan on a live subscription, with how many workspaces have it and how: on a trial, given by
 * hand, or paying at a gateway. A workspace is counted once per plan — paying before given before trial.
 */
export async function planMix(): Promise<{ key: string; name: string; kind: PlanKindKey; trial: number; given: number; paying: number }[]> {
  const items = await controlDb().subscriptionItem.findMany({
    where: { subscription: { status: { in: [...LIVE_STATUSES] } } },
    select: { plan: { select: { key: true, name: true, kind: true } }, subscription: { select: { tenantId: true, gateway: true, status: true } } },
  });
  const RANK = { trial: 1, given: 2, paying: 3 } as const;
  const plans = new Map<string, { name: string; kind: PlanKindKey; tenants: Map<string, keyof typeof RANK> }>();
  for (const item of items) {
    const how: keyof typeof RANK = item.subscription.gateway !== "MANUAL" ? "paying" : item.subscription.status === "TRIALING" ? "trial" : "given";
    let plan = plans.get(item.plan.key);
    if (!plan) {
      plan = { name: item.plan.name, kind: item.plan.kind, tenants: new Map() };
      plans.set(item.plan.key, plan);
    }
    const was = plan.tenants.get(item.subscription.tenantId);
    if (!was || RANK[how] > RANK[was]) plan.tenants.set(item.subscription.tenantId, how);
  }
  return [...plans]
    .map(([key, p]) => {
      const counts = { trial: 0, given: 0, paying: 0 };
      for (const how of p.tenants.values()) counts[how] += 1;
      return { key, name: p.name, kind: p.kind, ...counts };
    })
    .sort((a, b) => b.trial + b.given + b.paying - (a.trial + a.given + a.paying) || a.name.localeCompare(b.name));
}

// ─── Trials and churn ────────────────────────────────────────────────────────────────────────────

export type TrialCohort = {
  /** The IST month the workspaces were made in: "2026-09". */
  month: string;
  started: number;
  /** Pays at a gateway now, or has paid an invoice (converted, perhaps gone since). */
  paying: number;
  /** On a plan given by hand. */
  given: number;
  /** Still in its trial. */
  trialing: number;
  /** Trial over, nothing bought. */
  lapsed: number;
  /** Closed since. */
  closed: number;
  /** paying ÷ (started − trialing): of those whose trial has run its course, how many pay. Null when none has. */
  rate: number | null;
};

/**
 * The workspaces made each month (the installation's own left out), by what became of them. Anchored
 * on when the workspace was made, not on its trial: a trial given free (`giveTrialPlans`) loses its end.
 */
export async function trialCohorts(months = 6, now = new Date()): Promise<TrialCohort[]> {
  const n = clampInt(months, 1, 24, 6);
  const { keys, start } = monthWindow(n, now);
  const tenants = await controlDb().tenant.findMany({
    where: { isDefault: false, createdAt: { gte: start } },
    select: { createdAt: true, status: true, subscriptions: { select: { gateway: true, status: true } }, invoices: { where: { status: "PAID" }, select: { id: true }, take: 1 } },
  });
  const cohorts = new Map(keys.map((month) => [month, { month, started: 0, paying: 0, given: 0, trialing: 0, lapsed: 0, closed: 0, rate: null as number | null }]));
  for (const t of tenants) {
    const cohort = cohorts.get(istMonthKey(t.createdAt));
    if (!cohort) continue;
    cohort.started += 1;
    const has = (gateway: "MANUAL" | "GATEWAY", statuses: SubscriptionStatus[]) =>
      t.subscriptions.some((s) => (gateway === "MANUAL" ? s.gateway === "MANUAL" : s.gateway !== "MANUAL") && statuses.includes(s.status));
    if (t.status === "DEPROVISIONED") cohort.closed += 1;
    else if (has("GATEWAY", ["ACTIVE", "PAST_DUE", "TRIALING"]) || t.invoices.length > 0) cohort.paying += 1;
    else if (has("MANUAL", ["ACTIVE"])) cohort.given += 1;
    else if (has("MANUAL", ["TRIALING"])) cohort.trialing += 1;
    else cohort.lapsed += 1;
  }
  return [...cohorts.values()].map((c) => {
    const decided = c.started - c.trialing;
    return { ...c, rate: decided > 0 ? c.paying / decided : null };
  });
}

/** Gateway subscriptions that ended, by the IST month they ended in: how many workspaces, and the monthly revenue that went with them. */
export async function churnByMonth(months = 6, now = new Date()): Promise<{ month: string; workspaces: number; lost: Money[] }[]> {
  const n = clampInt(months, 1, 36, 6);
  const { keys, start } = monthWindow(n, now);
  const subs = await controlDb().subscription.findMany({
    where: { gateway: { in: GATEWAYS }, cancelledAt: { gte: start } },
    select: { tenantId: true, cancelledAt: true, items: { select: { quantity: true, price: { select: { amount: true, currency: true, interval: true } } } } },
  });
  const byMonth = new Map(keys.map((month) => [month, { tenants: new Set<string>(), lost: new Map<string, Tally>() }]));
  for (const sub of subs) {
    if (!sub.cancelledAt) continue;
    const month = byMonth.get(istMonthKey(sub.cancelledAt));
    if (!month) continue;
    month.tenants.add(sub.tenantId);
    for (const item of sub.items) {
      if (!item.price) continue;
      const currency = upper(item.price.currency);
      let t = month.lost.get(currency);
      if (!t) {
        t = tally();
        month.lost.set(currency, t);
      }
      add(t, item.price, item.quantity);
    }
  }
  return keys.map((key) => {
    const m = byMonth.get(key)!;
    return {
      month: key,
      workspaces: m.tenants.size,
      lost: [...m.lost].map(([currency, t]) => ({ currency, minor: perMonth(t) })).sort((a, b) => a.currency.localeCompare(b.currency)),
    };
  });
}

// ─── The daily snapshot ──────────────────────────────────────────────────────────────────────────

/** MRR as the tick recorded it each day, oldest first — `day` is the IST calendar day, "2026-09-27". */
export async function mrrHistory(days = 180, now = new Date()): Promise<{ day: string; currency: string; mrr: number }[]> {
  const n = clampInt(days, 1, 3660, 180);
  const today = usageDay(now);
  const rows = await controlDb().platformRevenueSnapshot.findMany({
    // A date column: inclusive bounds, compared by calendar day.
    where: { day: { gte: new Date(today.getTime() - (n - 1) * DAY), lte: today } },
    orderBy: [{ day: "asc" }, { currency: "asc" }],
    select: { day: true, currency: true, mrr: true },
  });
  // BigInt in the table (a large INR sum passes 2^31 paise); well inside 2^53 as a number.
  return rows.map((r) => ({ day: r.day.toISOString().slice(0, 10), currency: r.currency, mrr: Number(r.mrr) }));
}

/**
 * Today's MRR, one row per currency, for the history — run by the platform tick's once-a-day block.
 * Run again on the same day, it replaces that day's rows. A currency recorded in the last week that
 * has nothing now is written as zero, so its history falls to nothing rather than stopping short.
 * Returns the rows written.
 */
export async function snapshotRevenue(now = new Date()): Promise<number> {
  const control = controlDb();
  const day = usageDay(now);
  const [summary, recent] = await Promise.all([
    mrrByCurrency(now),
    control.platformRevenueSnapshot.findMany({ where: { day: { gte: new Date(day.getTime() - 7 * DAY), lt: day } }, select: { currency: true }, distinct: ["currency"] }),
  ]);
  const rows = summary.rows.map((r) => ({ currency: r.currency, mrr: r.mrr, subscriptions: r.subscriptions, workspaces: r.workspaces }));
  for (const { currency } of recent) {
    if (!rows.some((r) => r.currency === currency)) rows.push({ currency, mrr: 0, subscriptions: 0, workspaces: 0 });
  }
  await control.$transaction(async (tx) => {
    for (const r of rows) {
      const values = { mrr: BigInt(Math.max(0, Math.round(r.mrr))), subscriptions: r.subscriptions, workspaces: r.workspaces };
      await tx.platformRevenueSnapshot.upsert({
        where: { day_currency: { day, currency: r.currency } },
        create: { day, currency: r.currency, ...values },
        update: { ...values, recordedAt: now },
        select: { day: true },
      });
    }
  });
  return rows.length;
}

// ─── Invoices ────────────────────────────────────────────────────────────────────────────────────

export type InvoiceListRow = {
  id: string;
  tenant: { slug: string };
  gateway: GatewayKey;
  externalId: string;
  number: string | null;
  status: InvoiceStatusKey;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  amountPaid: number;
  periodStart: Date | null;
  periodEnd: Date | null;
  issuedAt: Date;
  paidAt: Date | null;
  hostedUrl: string | null;
  pdfUrl: string | null;
};
export type InvoicesPage = {
  rows: InvoiceListRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Per currency, over every invoice the filters match (not just this page). */
  totals: { currency: string; total: number; paid: number; tax: number; count: number }[];
};

const INVOICE_ROW_SELECT = {
  id: true,
  gateway: true,
  externalId: true,
  number: true,
  status: true,
  currency: true,
  subtotal: true,
  tax: true,
  total: true,
  amountPaid: true,
  periodStart: true,
  periodEnd: true,
  issuedAt: true,
  paidAt: true,
  hostedUrl: true,
  pdfUrl: true,
  tenant: { select: { slug: true } },
} as const satisfies Prisma.InvoiceSelect;

/** A gateway's page for an invoice, only as an https address — anything else is not a link to follow. */
function safeUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** A workspace's id from its slug; undefined when no slug is asked for, null when there is no such workspace. */
async function tenantIdFor(slug: string | undefined): Promise<string | null | undefined> {
  if (!slug) return undefined;
  const tenant = await controlDb().tenant.findUnique({ where: { slug }, select: { id: true } });
  return tenant?.id ?? null;
}

/** The half-open IST range of `from`–`to` (whole days), for a timestamp column. */
function istRange(from: string | undefined, to: string | undefined): { gte?: Date; lt?: Date } | undefined {
  const gte = from ? startOfIndianDay(from) : null;
  const lt = to ? endOfIndianDay(to) : null;
  if (!gte && !lt) return undefined;
  return { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) };
}

/** The filters as a query; null when they name a workspace that does not exist (so nothing matches). */
async function invoiceWhere(f: InvoiceFilters): Promise<Prisma.InvoiceWhereInput | null> {
  const tenantId = await tenantIdFor(f.tenant);
  if (tenantId === null) return null;
  const issuedAt = istRange(f.from, f.to);
  return {
    ...(f.status ? { status: f.status } : {}),
    ...(f.gateway ? { gateway: f.gateway } : {}),
    ...(f.currency ? { currency: f.currency } : {}),
    ...(tenantId ? { tenantId } : {}),
    ...(issuedAt ? { issuedAt } : {}),
  };
}

/** The page asked for, or the last one there is — a stale link past the end shows the end. */
function pageWithin(page: number, total: number): number {
  const last = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return Math.min(Math.max(1, Math.trunc(page) || 1), last);
}

/** Invoices, newest first, fifty to a page, with per-currency totals over the whole filtered set (features E2). */
export async function invoicesList(f: InvoiceFilters): Promise<InvoicesPage> {
  const where = await invoiceWhere(f);
  if (!where) return { rows: [], total: 0, page: 1, pageSize: PAGE_SIZE, totals: [] };
  const control = controlDb();
  const [total, sums] = await Promise.all([
    control.invoice.count({ where }),
    control.invoice.groupBy({ by: ["currency"], where, _sum: { total: true, amountPaid: true, tax: true }, _count: { _all: true } }),
  ]);
  const page = pageWithin(f.page, total);
  const rows = total
    ? await control.invoice.findMany({ where, orderBy: [{ issuedAt: "desc" }, { id: "desc" }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE, select: INVOICE_ROW_SELECT })
    : [];
  return {
    rows: rows.map((r) => ({ ...r, hostedUrl: safeUrl(r.hostedUrl), pdfUrl: safeUrl(r.pdfUrl) })),
    total,
    page,
    pageSize: PAGE_SIZE,
    totals: sums
      .map((s) => ({ currency: upper(s.currency), total: s._sum.total ?? 0, paid: s._sum.amountPaid ?? 0, tax: s._sum.tax ?? 0, count: s._count._all }))
      .sort((a, b) => b.count - a.count || a.currency.localeCompare(b.currency)),
  };
}

/** How many decimal places a currency's amounts have: 2 for INR and USD, 0 for JPY. */
function minorDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** A time as India's wall clock, sortable: "2026-09-27 18:30". Empty for none. */
const istStamp = (at: Date | null) => (at ? istDateTimeInput(at).replace("T", " ") : "");

const INVOICE_CSV_FIELDS = [
  "Issued (IST)",
  "Workspace",
  "Number",
  "Gateway",
  "Gateway invoice id",
  "Status",
  "Currency",
  "Subtotal",
  "Tax",
  "Total",
  "Paid",
  "Period from (IST)",
  "Period to (IST)",
  "Paid on (IST)",
  "Invoice page",
  "PDF",
];

/**
 * The filtered invoices as CSV — every one, not a page; at most 10,000 (more is refused: narrow it
 * down). Amounts are in each currency's main unit (1499.00 rupees, not 149900 paise), beside their
 * currency. Text cells that a spreadsheet would read as a formula are escaped.
 */
export async function invoicesCsv(f: InvoiceFilters, now = new Date()): Promise<CsvExport> {
  const cap = EXPORT_CAPS.invoices;
  const where = await invoiceWhere(f);
  const control = controlDb();
  const count = where ? await control.invoice.count({ where }) : 0;
  if (count > cap) throw new ConsoleRefused(`That is ${count.toLocaleString("en-IN")} invoices — narrow it down to at most ${cap.toLocaleString("en-IN")} in one export.`);
  const rows = where ? await control.invoice.findMany({ where, orderBy: [{ issuedAt: "desc" }, { id: "desc" }], take: cap, select: INVOICE_ROW_SELECT }) : [];

  const digits = new Map<string, number>();
  const major = (minor: number, currency: string) => {
    let d = digits.get(currency);
    if (d === undefined) {
      d = minorDigits(currency);
      digits.set(currency, d);
    }
    return Number((minor / 10 ** d).toFixed(d));
  };
  const data = rows.map((r) => {
    const currency = upper(r.currency);
    return [
      istStamp(r.issuedAt),
      r.tenant.slug,
      r.number ?? "",
      gatewayLabel(r.gateway),
      r.externalId,
      INVOICE_STATUS[r.status].label,
      currency,
      major(r.subtotal, currency),
      major(r.tax, currency),
      major(r.total, currency),
      major(r.amountPaid, currency),
      istStamp(r.periodStart),
      istStamp(r.periodEnd),
      istStamp(r.paidAt),
      safeUrl(r.hostedUrl) ?? "",
      safeUrl(r.pdfUrl) ?? "",
    ];
  });
  return { filename: csvFilename("invoices", now), csv: Papa.unparse({ fields: INVOICE_CSV_FIELDS, data }, { escapeFormulae: true }), rows: data.length };
}

// ─── Subscriptions ───────────────────────────────────────────────────────────────────────────────

export type SubscriptionListRow = {
  id: string;
  tenant: { slug: string; name: string };
  gateway: GatewayKey;
  status: SubscriptionStatusKey;
  plans: { name: string; quantity: number }[];
  interval: "MONTH" | "YEAR" | null;
  currency: string | null;
  /** What it charges a month, in minor units; null when given by hand or when an item has no price. */
  monthly: number | null;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  pastDueSince: Date | null;
  cancelAtPeriodEnd: boolean;
  externalId: string | null;
  syncedAt: Date | null;
};
export type SubscriptionsPage = { rows: SubscriptionListRow[]; total: number; page: number; pageSize: number; modes: GatewayModes };

const SUBSCRIPTION_ROW_SELECT = {
  id: true,
  gateway: true,
  status: true,
  interval: true,
  currency: true,
  currentPeriodEnd: true,
  trialEndsAt: true,
  pastDueSince: true,
  cancelAtPeriodEnd: true,
  externalId: true,
  syncedAt: true,
  tenant: { select: { slug: true, name: true } },
  items: {
    select: {
      quantity: true,
      plan: { select: { name: true, sortOrder: true } },
      price: { select: { amount: true, currency: true, interval: true } },
    },
  },
} as const satisfies Prisma.SubscriptionSelect;

type SubscriptionRow = Prisma.SubscriptionGetPayload<{ select: typeof SUBSCRIPTION_ROW_SELECT }>;

function subscriptionRow(s: SubscriptionRow): SubscriptionListRow {
  // Only a whole answer: every item priced, in one currency. A part would understate it.
  const prices = s.items.map((i) => i.price);
  let monthly: number | null = null;
  if (s.gateway !== "MANUAL" && prices.length > 0 && prices.every((p) => p !== null) && new Set(prices.map((p) => upper(p!.currency))).size === 1) {
    const t = tally();
    for (const i of s.items) add(t, i.price!, i.quantity);
    monthly = perMonth(t);
  }
  const firstPrice = s.items.find((i) => i.price)?.price ?? null;
  return {
    id: s.id,
    tenant: s.tenant,
    gateway: s.gateway,
    status: s.status,
    plans: [...s.items]
      .sort((a, b) => a.plan.sortOrder - b.plan.sortOrder || a.plan.name.localeCompare(b.plan.name))
      .map((i) => ({ name: i.plan.name, quantity: i.quantity })),
    interval: s.interval ?? firstPrice?.interval ?? null,
    currency: s.currency ? upper(s.currency) : firstPrice ? upper(firstPrice.currency) : null,
    monthly,
    currentPeriodEnd: s.currentPeriodEnd,
    trialEndsAt: s.trialEndsAt,
    pastDueSince: s.pastDueSince,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    externalId: s.externalId,
    syncedAt: s.syncedAt,
  };
}

/** Subscriptions of every kind — at a gateway, on a trial, given by hand — newest first, fifty to a page. */
export async function subscriptionsList(f: SubscriptionFilters): Promise<SubscriptionsPage> {
  const [tenantId, modes] = await Promise.all([tenantIdFor(f.tenant), gatewayModes()]);
  if (tenantId === null) return { rows: [], total: 0, page: 1, pageSize: PAGE_SIZE, modes };
  const where: Prisma.SubscriptionWhereInput = {
    ...(f.status ? { status: f.status } : {}),
    ...(f.gateway ? { gateway: f.gateway } : {}),
    ...(f.interval ? { interval: f.interval } : {}),
    ...(tenantId ? { tenantId } : {}),
  };
  const control = controlDb();
  const total = await control.subscription.count({ where });
  const page = pageWithin(f.page, total);
  const rows = total
    ? await control.subscription.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE, select: SUBSCRIPTION_ROW_SELECT })
    : [];
  return { rows: rows.map(subscriptionRow), total, page, pageSize: PAGE_SIZE, modes };
}
