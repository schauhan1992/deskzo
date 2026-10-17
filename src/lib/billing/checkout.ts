import type { BillingInterval } from "@deskzo/control-client";
import { GatewayError, GatewayNotConfigured } from "@/lib/billing/gateway";
import { PriceRefused, gatewayPriceId } from "@/lib/billing/prices";
import { choiceRefusal } from "@/lib/billing/plan-choice";
import { cancelRazorpaySubscription, createRazorpaySubscription } from "@/lib/billing/razorpay";
import { createStripeCheckout, createStripePortal } from "@/lib/billing/stripe";
import { controlDb } from "@/lib/platform/control-db";
import { seatsFrom } from "@/lib/platform/entitlements";

/**
 * Buying a plan, from a workspace's billing page (src/actions/billing.ts).
 *
 * The gateway follows the country: a workspace in India pays Razorpay in rupees, every other one
 * Stripe — in its own currency where a price is set in it, in US dollars otherwise. What is offered is
 * what is on sale there: plans offered in its country, with a price in its currency. Prices are the
 * plans' own (src/lib/billing/prices.ts): they are offered whether the gateway is connected or not, and
 * its copy of each is made as somebody pays.
 */

export type Gateway = "STRIPE" | "RAZORPAY";
export const gatewayFor = (country: string): Gateway => (country === "IN" ? "RAZORPAY" : "STRIPE");

/** A refusal worth showing whoever asked. */
export class CheckoutRefused extends Error {}

export type OfferPrice = { id: string; currency: string; interval: BillingInterval; amount: number; perSeat: boolean };
export type OfferPlan = {
  key: string;
  name: string;
  kind: "EDITION" | "BUNDLE" | "ADDON";
  /** The product an edition sells (src/lib/products.ts) — "one" for Deskzo One; null: none. */
  productKey: string | null;
  description: string | null;
  seats: number | null;
  /** `["all"]` for every module. */
  modules: string[];
  prices: OfferPrice[];
};

/** The currency a country's prices are shown and charged in: rupees in India; elsewhere its own, where prices are set in it, or US dollars. */
export function currencyFor(country: string, own: string | null | undefined, priced: Set<string>): string {
  if (country === "IN") return "INR";
  return own && priced.has(own.toUpperCase()) ? own.toUpperCase() : "USD";
}

/** What this workspace can buy: its gateway, its currency, and the plans with a price in it. */
export async function offerFor(tenantId: string): Promise<{ gateway: Gateway; currency: string; plans: OfferPlan[] }> {
  const control = controlDb();
  const tenant = await control.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { country: true, currency: true } });
  const gateway = gatewayFor(tenant.country);
  const plans = await control.plan.findMany({
    where: { active: true, kind: { in: ["EDITION", "BUNDLE", "ADDON"] }, OR: [{ countries: { isEmpty: true } }, { countries: { has: tenant.country } }] },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { modules: { select: { moduleKey: true } }, prices: { where: { active: true } } },
  });
  const currency = currencyFor(tenant.country, tenant.currency, new Set(plans.flatMap((p) => p.prices.map((x) => x.currency))));
  return {
    gateway,
    currency,
    plans: plans
      .map((p) => ({
        key: p.key,
        name: p.name,
        kind: p.kind as OfferPlan["kind"],
        productKey: p.productKey,
        description: p.description,
        seats: p.seats,
        modules: p.allModules ? ["all"] : p.modules.map((m) => m.moduleKey),
        prices: p.prices.filter((x) => x.currency === currency).map((x) => ({ id: x.id, currency: x.currency, interval: x.interval, amount: x.amount, perSeat: x.perSeat })),
      }))
      .filter((p) => p.prices.length > 0),
  };
}

/** What a customer is told when no gateway takes payments for them yet. */
export const PAYING_ONLINE_CLOSED = "Paying online isn't open yet. Write to us and we'll set your plan up — and keep your workspace going meanwhile.";

export type Selection = { interval: BillingInterval; items: { planKey: string; quantity: number }[] };
export type CheckoutStart =
  | { gateway: "STRIPE"; url: string }
  /** Razorpay: one page per plan, each to be authorised by the customer. */
  | { gateway: "RAZORPAY"; authorisations: { plan: string; url: string }[] };

/** What a purchase is checked against besides the plans: how many people have an account now. */
export type CheckoutOptions = { seatsInUse?: number | null };

type Line = { plan: OfferPlan; price: OfferPrice; quantity: number };

/**
 * A selection made into lines: each plan on sale here at the interval, with its price and quantity,
 * that can be bought together — the rules and words of src/lib/billing/plan-choice.ts.
 */
function chosenLines(offer: { plans: OfferPlan[] }, selection: Selection): { interval: BillingInterval; lines: Line[] } {
  const interval = selection?.interval === "YEAR" ? "YEAR" : "MONTH";
  const wanted = new Map<string, number>();
  for (const item of selection?.items ?? []) {
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) throw new CheckoutRefused("A quantity is a whole number from 1.");
    wanted.set(String(item.planKey), quantity);
  }
  const lines = [...wanted].map(([key, quantity]) => {
    const plan = offer.plans.find((p) => p.key === key);
    const price = plan?.prices.find((p) => p.interval === interval);
    if (!plan || !price) throw new CheckoutRefused(`${plan?.name ?? key} is not on sale ${interval === "YEAR" ? "yearly" : "monthly"} here.`);
    return { plan, price, quantity };
  });
  const refusal = choiceRefusal(lines.map((l) => l.plan));
  if (refusal) throw new CheckoutRefused(refusal);
  return { interval, lines };
}

/**
 * Fewer people than have an account already (owner, 17 Oct 2026): refused, rather than sold and then
 * blocking everybody added afterwards. Null when the plans are enough — or allow anybody.
 */
export function seatShortfall(lines: { quantity: number; price: { perSeat: boolean }; plan: { kind: OfferPlan["kind"]; seats: number | null } }[], seatsInUse: number | null | undefined): string | null {
  if (typeof seatsInUse !== "number" || seatsInUse < 1) return null;
  const allowed = seatsFrom(lines.map((l) => ({ quantity: l.quantity, perSeat: l.price.perSeat, plan: { kind: l.plan.kind, seats: l.plan.seats } })));
  if (allowed === null || allowed >= seatsInUse) return null;
  return `${seatsInUse} people have an account in this workspace, and the plans chosen are for ${allowed}. Choose at least ${seatsInUse} people, or switch some accounts off first.`;
}

/** Each price's copy at the gateway, made now where it has none — or why paying online isn't open. */
async function gatewayCopies(lines: Line[], gateway: Gateway): Promise<(priceId: string) => string> {
  // Without the gateway connected yet, paying online simply isn't open: staff set plans up by hand
  // (a bank transfer, a distributor).
  const external = new Map<string, string>();
  try {
    for (const line of lines) if (!external.has(line.price.id)) external.set(line.price.id, await gatewayPriceId(line.price.id, gateway));
  } catch (err) {
    if (err instanceof GatewayNotConfigured) throw new CheckoutRefused(PAYING_ONLINE_CLOSED);
    if (err instanceof PriceRefused) throw new CheckoutRefused(err.message);
    throw err;
  }
  return (id: string) => external.get(id)!;
}

/**
 * Razorpay pages still unpaid from an earlier attempt — and a change already authorised that hasn't
 * started — cancelled there and here, so one choice waits at a time: paying twice, or a change made
 * twice, never leaves two sets of plans to authorise.
 */
export async function dropWaitingRazorpay(tenantId: string, now: Date): Promise<void> {
  const control = controlDb();
  const waiting = await control.subscription.findMany({
    where: { tenantId, gateway: "RAZORPAY", OR: [{ status: "INCOMPLETE" }, { status: "ACTIVE", startsAt: { gt: now } }] },
    select: { id: true, externalId: true },
  });
  for (const sub of waiting) {
    if (sub.externalId) {
      try {
        await cancelRazorpaySubscription(sub.externalId, false);
      } catch (err) {
        // Gone at Razorpay already (expired, cancelled): nothing left to stop. Anything else, try again.
        if (!(err instanceof GatewayError) || (err.status !== 400 && err.status !== 404)) throw err;
      }
    }
    await control.subscription.update({ where: { id: sub.id }, data: { status: "CANCELLED", cancelledAt: now } });
  }
}

/** A subscription per line, waiting at Razorpay to be authorised — remembered at once, so its webhooks find their workspace. */
async function razorpayPages(tenantId: string, lines: Line[], interval: BillingInterval, externalOf: (id: string) => string, startsAt: Date | null): Promise<{ plan: string; url: string }[]> {
  const control = controlDb();
  const authorisations: { plan: string; url: string }[] = [];
  for (const line of lines) {
    const sub = await createRazorpaySubscription({ planId: externalOf(line.price.id), quantity: line.quantity, tenantId, interval: interval === "YEAR" ? "YEAR" : "MONTH", startAt: startsAt });
    await control.subscription.create({
      data: {
        tenantId,
        gateway: "RAZORPAY",
        status: "INCOMPLETE",
        externalId: sub.id,
        currency: "INR",
        interval,
        startsAt,
        items: { create: { planId: (await control.plan.findUniqueOrThrow({ where: { key: line.plan.key }, select: { id: true } })).id, priceId: line.price.id, quantity: line.quantity } },
      },
    });
    if (!sub.short_url) throw new GatewayError("Razorpay did not return a payment page.");
    authorisations.push({ plan: line.plan.name, url: sub.short_url });
  }
  return authorisations;
}

/**
 * Starts paying, at one interval: Deskzo One, or a plan for each product wanted (or an edition of its
 * own), with any bundles and add-ons whose needs those meet — the rules and words of
 * src/lib/billing/plan-choice.ts — for at least as many people as have an account. A workspace already
 * paying at a gateway changes its plan instead: Stripe's billing portal, or a change from the next
 * renewal at Razorpay (`scheduleRazorpayChange`).
 */
export async function startCheckout(tenantId: string, selection: Selection, returnUrl: string, opts: CheckoutOptions = {}): Promise<CheckoutStart> {
  const control = controlDb();
  const tenant = await control.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { id: true, ownerEmail: true, billingEmail: true, stripeCustomerId: true } });
  const offer = await offerFor(tenantId);
  const { interval, lines } = chosenLines(offer, selection);
  const short = seatShortfall(lines, opts.seatsInUse);
  if (short) throw new CheckoutRefused(short);

  const now = new Date();
  const live = await control.subscription.findMany({ where: { tenantId, gateway: { not: "MANUAL" }, status: { in: ["TRIALING", "ACTIVE", "PAST_DUE"] } }, select: { gateway: true } });
  if (live.some((s) => s.gateway === "OFFLINE")) throw new CheckoutRefused("This workspace is paid by bank transfer — ask for a proforma for the next period, or write to us to change how it pays.");
  if (live.some((s) => s.gateway === "RAZORPAY")) throw new CheckoutRefused("This workspace already pays through Razorpay — change its plan or people from the next renewal instead.");
  if (live.length) throw new CheckoutRefused("This workspace is already paying for a plan — change it from Manage billing.");

  const externalOf = await gatewayCopies(lines, offer.gateway);

  if (offer.gateway === "STRIPE") {
    const session = await createStripeCheckout({
      tenantId,
      customerId: tenant.stripeCustomerId,
      email: tenant.billingEmail ?? tenant.ownerEmail ?? "",
      lineItems: lines.map((l) => ({ price: externalOf(l.price.id), quantity: l.quantity })),
      successUrl: `${returnUrl}?checkout=done`,
      cancelUrl: returnUrl,
    });
    if (!session.url) throw new GatewayError("Stripe did not return a checkout page.");
    return { gateway: "STRIPE", url: session.url };
  }

  // Razorpay: a subscription per plan, each authorised on Razorpay's page — an earlier attempt's dropped.
  await dropWaitingRazorpay(tenantId, now);
  return { gateway: "RAZORPAY", authorisations: await razorpayPages(tenantId, lines, interval, externalOf, null) };
}

export type ChangeStart = { startsAt: Date; authorisations: { plan: string; url: string }[] };

/**
 * A workspace paying through Razorpay changes its plans or its people from the next renewal (owner, 17
 * Oct 2026). Razorpay can't change a subscription paid by UPI Autopay or an e-mandate — most of India
 * pays that way — so the new plans are new subscriptions, authorised now and starting the day the
 * current ones renew; nothing is charged, and nothing in the workspace changes, until then. Once every
 * one of them is authorised, the current ones are cancelled at the end of their period
 * (`finishScheduledChange`), so a change half-authorised changes nothing. A newer change replaces one
 * still waiting.
 */
export async function scheduleRazorpayChange(tenantId: string, selection: Selection, opts: CheckoutOptions = {}, now = new Date()): Promise<ChangeStart> {
  const control = controlDb();
  const offer = await offerFor(tenantId);
  if (offer.gateway !== "RAZORPAY") throw new CheckoutRefused("Change the plan from Manage billing.");
  const current = await control.subscription.findMany({
    where: { tenantId, gateway: "RAZORPAY", status: { in: ["ACTIVE", "PAST_DUE"] }, OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
    select: { status: true, currentPeriodEnd: true },
  });
  if (!current.length) throw new CheckoutRefused("This workspace isn't paying through Razorpay yet — choose a plan instead.");
  if (current.some((s) => s.status === "PAST_DUE")) throw new CheckoutRefused("A payment is overdue — once it's paid, the plan can be changed.");
  const renewal = current.map((s) => s.currentPeriodEnd?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
  if (renewal <= now.getTime()) throw new CheckoutRefused("Razorpay hasn't told us when the plan renews yet — try again in a few minutes.");
  const { interval, lines } = chosenLines(offer, selection);
  const short = seatShortfall(lines, opts.seatsInUse);
  if (short) throw new CheckoutRefused(short);
  const externalOf = await gatewayCopies(lines, "RAZORPAY");
  await dropWaitingRazorpay(tenantId, now);
  const startsAt = new Date(renewal);
  return { startsAt, authorisations: await razorpayPages(tenantId, lines, interval, externalOf, startsAt) };
}

/**
 * Once every subscription of a change is authorised, the ones it replaces are cancelled at the end of
 * their period — the day the change starts. Until then they renew as before. How many were cancelled.
 */
export async function finishScheduledChange(tenantId: string, now = new Date()): Promise<number> {
  const control = controlDb();
  const upcoming = await control.subscription.findMany({ where: { tenantId, gateway: "RAZORPAY", startsAt: { gt: now }, status: { in: ["INCOMPLETE", "ACTIVE"] } }, select: { status: true } });
  if (!upcoming.length || upcoming.some((s) => s.status === "INCOMPLETE")) return 0;
  const replaced = await control.subscription.findMany({
    where: { tenantId, gateway: "RAZORPAY", status: { in: ["ACTIVE", "PAST_DUE"] }, cancelAtPeriodEnd: false, OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
    select: { id: true, externalId: true },
  });
  for (const sub of replaced) {
    if (sub.externalId) await cancelRazorpaySubscription(sub.externalId, true);
    await control.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
  }
  return replaced.length;
}

/** Razorpay pages still waiting for the customer to authorise them — and, for a change, the day it starts. */
export async function pendingAuthorisations(tenantId: string): Promise<{ id: string; plan: string; externalId: string; startsAt: Date | null }[]> {
  const subs = await controlDb().subscription.findMany({
    where: { tenantId, gateway: "RAZORPAY", status: "INCOMPLETE" },
    select: { id: true, externalId: true, startsAt: true, items: { select: { plan: { select: { name: true } } } } },
  });
  return subs.filter((s) => s.externalId).map((s) => ({ id: s.id, plan: s.items[0]?.plan.name ?? "Plan", externalId: s.externalId!, startsAt: s.startsAt }));
}

/** Stripe's own page for changing plan, card, address or cancelling. */
export async function billingPortal(tenantId: string, returnUrl: string): Promise<string> {
  const tenant = await controlDb().tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { stripeCustomerId: true } });
  if (!tenant.stripeCustomerId) throw new CheckoutRefused("There is nothing to manage at Stripe yet.");
  return (await createStripePortal({ customerId: tenant.stripeCustomerId, returnUrl })).url;
}

/** A Razorpay subscription, cancelled at the end of the period it is in (Stripe's is cancelled in its portal). */
export async function cancelAtPeriodEnd(tenantId: string, subscriptionId: string): Promise<void> {
  const sub = await controlDb().subscription.findFirst({ where: { id: subscriptionId, tenantId, gateway: "RAZORPAY" }, select: { id: true, externalId: true, status: true } });
  if (!sub?.externalId) throw new CheckoutRefused("That subscription is not one to cancel here.");
  if (sub.status === "INCOMPLETE") {
    await cancelRazorpaySubscription(sub.externalId, false);
    await controlDb().subscription.update({ where: { id: sub.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    return;
  }
  await cancelRazorpaySubscription(sub.externalId, true);
  await controlDb().subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
}
