import type { BillingInterval, PlanKind, SubscriptionStatus, TenantStatus } from "@deskzo/control-client";
import { billingStandings, standingDate, type Standing } from "@/lib/billing/lifecycle";
import type { Money } from "@/lib/partners/types";
import { controlDb } from "@/lib/platform/control-db";
import { LIVE_STATUSES } from "@/lib/platform/entitlements";

/**
 * What partners — and staff looking at a partner — may know about its customers (spec §8.5): the
 * control plane's facts about each workspace and its subscriptions, nothing from inside any
 * workspace, and never an owner's or billing address, a tax id, an invoice link, seats or usage.
 * Shared by the portal's and the console's loaders.
 *
 * MRR is what the gateways charge (the same rule as src/lib/platform/revenue.ts, rewritten here so
 * the partner tree depends on no console loader): subscriptions ACTIVE or PAST_DUE at Stripe or
 * Razorpay, each priced item's amount × quantity, yearly ones ÷ 12, per currency — never added
 * across currencies, never converted. A trial, a plan given by hand, and an item without a price
 * count nothing.
 *
 * What a workspace's own Billing page shows of its partner is `partnerShownToCustomer`, kept in the
 * light file customer-facing.ts (this one loads the billing engine); it is re-exported here.
 */

export { partnerShownToCustomer } from "@/lib/partners/customer-facing";

export type StandingKind = Standing["kind"];

export type CustomerFacts = {
  tenantId: string;
  slug: string;
  name: string;
  country: string;
  createdAt: Date;
  status: TenantStatus;
  /** Where it stands with paying (src/lib/billing/lifecycle.ts) and the date that turns on: a trial's end, the hold, when it lapsed. */
  standing: { kind: StandingKind; at: Date | null };
  /** The currency it pays in at a gateway, when it does. */
  currency: string | null;
  /** Its MRR at list prices, per currency. */
  mrr: Money[];
  /** Every plan of its live subscriptions (trialing, active, past due), with list prices where a gateway charges them. */
  plans: { key: string; name: string; kind: PlanKind; quantity: number; interval: BillingInterval | null; unitAmount: number | null; currency: string | null }[];
  /** The next renewal of a gateway subscription that renews. */
  renewsAt: Date | null;
  /** When it ends unless something is bought or paid: a trial's end, or a cancelled subscription's period end. */
  endsAt: Date | null;
};

/** Ids per query — well inside Postgres's bind limit. */
const CHUNK = 1_000;
const GATEWAYS = ["STRIPE", "RAZORPAY"] as const;
const PAYING: SubscriptionStatus[] = ["ACTIVE", "PAST_DUE"];

/**
 * A month's worth per currency, kept as two whole sums — charged monthly, charged yearly — so adding
 * items up is exact whatever their order; divided by twelve only at the end.
 */
type Tally = Map<string, { monthly: number; yearly: number }>;

function add(t: Tally, price: { amount: number; currency: string; interval: BillingInterval }, quantity: number): void {
  const currency = price.currency.trim().toUpperCase();
  const sums = t.get(currency) ?? { monthly: 0, yearly: 0 };
  if (price.interval === "YEAR") sums.yearly += price.amount * quantity;
  else sums.monthly += price.amount * quantity;
  t.set(currency, sums);
}

const moneyOf = (t: Tally): Money[] =>
  [...t]
    .map(([currency, s]) => ({ currency, minor: Math.round(s.monthly + s.yearly / 12) }))
    .filter((m) => m.minor !== 0)
    .sort((a, b) => a.currency.localeCompare(b.currency));

const chunks = (ids: string[]) => {
  const unique = [...new Set(ids.map((id) => String(id ?? "")).filter(Boolean))];
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += CHUNK) out.push(unique.slice(i, i + CHUNK));
  return out;
};

/**
 * The facts of each workspace in `tenantIds` (an id with no workspace is left out): its standing,
 * live subscriptions and plans with list prices, MRR, renewal and end dates. A few queries per
 * thousand workspaces.
 */
export async function customerFacts(tenantIds: string[], now: Date = new Date()): Promise<Map<string, CustomerFacts>> {
  const out = new Map<string, CustomerFacts>();
  const control = controlDb();
  for (const chunk of chunks(tenantIds)) {
    const [tenants, standings, subs] = await Promise.all([
      control.tenant.findMany({ where: { id: { in: chunk } }, select: { id: true, slug: true, name: true, country: true, createdAt: true, status: true } }),
      billingStandings(chunk, now),
      control.subscription.findMany({
        where: { tenantId: { in: chunk }, status: { in: [...LIVE_STATUSES] } },
        orderBy: { createdAt: "asc" },
        select: {
          tenantId: true,
          status: true,
          gateway: true,
          currency: true,
          interval: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          items: {
            orderBy: { createdAt: "asc" },
            select: { quantity: true, plan: { select: { key: true, name: true, kind: true } }, price: { select: { amount: true, currency: true, interval: true } } },
          },
        },
      }),
    ]);
    const subsOf = new Map<string, typeof subs>();
    for (const s of subs) subsOf.set(s.tenantId, [...(subsOf.get(s.tenantId) ?? []), s]);

    for (const t of tenants) {
      const live = subsOf.get(t.id) ?? [];
      const atGateway = live.filter((s) => s.gateway !== "MANUAL");
      const tally: Tally = new Map();
      for (const s of atGateway) {
        if (!PAYING.includes(s.status)) continue;
        for (const item of s.items) if (item.price) add(tally, item.price, item.quantity);
      }
      const renewing = atGateway.filter((s) => !s.cancelAtPeriodEnd && s.currentPeriodEnd).map((s) => s.currentPeriodEnd!.getTime());
      const standing = standings.get(t.id) ?? { kind: "none" as const };
      const pricedCurrency = atGateway.flatMap((s) => s.items.map((i) => i.price?.currency ?? null)).find((c): c is string => !!c);
      out.set(t.id, {
        tenantId: t.id,
        slug: t.slug,
        name: t.name,
        country: t.country,
        createdAt: t.createdAt,
        status: t.status,
        standing: { kind: standing.kind, at: standingDate(standing) },
        currency: (atGateway.find((s) => s.currency)?.currency ?? pricedCurrency ?? null)?.toUpperCase() ?? null,
        mrr: moneyOf(tally),
        plans: live.flatMap((s) =>
          s.items.map((item) => ({
            key: item.plan.key,
            name: item.plan.name,
            kind: item.plan.kind,
            quantity: item.quantity,
            interval: item.price?.interval ?? s.interval ?? null,
            unitAmount: item.price?.amount ?? null,
            currency: (item.price?.currency ?? s.currency ?? null)?.toUpperCase() ?? null,
          })),
        ),
        renewsAt: renewing.length ? new Date(Math.min(...renewing)) : null,
        endsAt: standing.kind === "trial" ? standing.endsAt : standing.kind === "ending" ? standing.holdAt : null,
      });
    }
  }
  return out;
}

/** The MRR of these workspaces together, per currency (ACTIVE and PAST_DUE at a gateway; yearly ÷ 12). */
export async function attributedMrr(tenantIds: string[]): Promise<Money[]> {
  const tally: Tally = new Map();
  for (const chunk of chunks(tenantIds)) {
    const items = await controlDb().subscriptionItem.findMany({
      where: { subscription: { tenantId: { in: chunk }, gateway: { in: [...GATEWAYS] }, status: { in: PAYING } } },
      select: { quantity: true, price: { select: { amount: true, currency: true, interval: true } } },
    });
    for (const item of items) if (item.price) add(tally, item.price, item.quantity);
  }
  return moneyOf(tally);
}
