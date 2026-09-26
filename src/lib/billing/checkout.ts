import type { BillingInterval } from "@wroffy/control-client";
import { GatewayError } from "@/lib/billing/gateway";
import { cancelRazorpaySubscription, createRazorpaySubscription } from "@/lib/billing/razorpay";
import { createStripeCheckout, createStripePortal } from "@/lib/billing/stripe";
import { controlDb } from "@/lib/platform/control-db";

/**
 * Buying a plan, from a workspace's billing page (src/actions/billing.ts).
 *
 * The gateway follows the country: a workspace in India pays Razorpay in rupees, every other one
 * Stripe — in its own currency where a price is set in it, in US dollars otherwise. What is offered is
 * what is on sale there: plans offered in its country, with a price at its gateway.
 */

export type Gateway = "STRIPE" | "RAZORPAY";
export const gatewayFor = (country: string): Gateway => (country === "IN" ? "RAZORPAY" : "STRIPE");

/** A refusal worth showing whoever asked. */
export class CheckoutRefused extends Error {}

export type OfferPrice = { id: string; currency: string; interval: BillingInterval; amount: number; perSeat: boolean };
export type OfferPlan = { key: string; name: string; kind: "EDITION" | "BUNDLE" | "ADDON"; description: string | null; seats: number | null; modules: string[]; prices: OfferPrice[] };

/** What this workspace can buy: its gateway, its currency, and the plans with a price in it. */
export async function offerFor(tenantId: string): Promise<{ gateway: Gateway; currency: string; plans: OfferPlan[] }> {
  const control = controlDb();
  const tenant = await control.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { country: true, currency: true } });
  const gateway = gatewayFor(tenant.country);
  const plans = await control.plan.findMany({
    where: { active: true, kind: { in: ["EDITION", "BUNDLE", "ADDON"] }, OR: [{ countries: { isEmpty: true } }, { countries: { has: tenant.country } }] },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { modules: { select: { moduleKey: true } }, prices: { where: { gateway, active: true } } },
  });
  const currencies = new Set(plans.flatMap((p) => p.prices.map((x) => x.currency)));
  const currency = gateway === "RAZORPAY" ? "INR" : currencies.has(tenant.currency) ? tenant.currency : "USD";
  return {
    gateway,
    currency,
    plans: plans
      .map((p) => ({
        key: p.key,
        name: p.name,
        kind: p.kind as OfferPlan["kind"],
        description: p.description,
        seats: p.seats,
        modules: p.allModules ? ["all"] : p.modules.map((m) => m.moduleKey),
        prices: p.prices.filter((x) => x.currency === currency).map((x) => ({ id: x.id, currency: x.currency, interval: x.interval, amount: x.amount, perSeat: x.perSeat })),
      }))
      .filter((p) => p.prices.length > 0),
  };
}

export type Selection = { interval: BillingInterval; items: { planKey: string; quantity: number }[] };
export type CheckoutStart =
  | { gateway: "STRIPE"; url: string }
  /** Razorpay: one page per plan, each to be authorised by the customer. */
  | { gateway: "RAZORPAY"; authorisations: { plan: string; url: string }[] };

/**
 * Starts paying: an edition, with any bundles and add-ons, at one interval. A workspace already
 * paying at a gateway changes its plan there instead (Stripe's billing portal), not here.
 */
export async function startCheckout(tenantId: string, selection: Selection, returnUrl: string): Promise<CheckoutStart> {
  const control = controlDb();
  const tenant = await control.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { id: true, ownerEmail: true, billingEmail: true, stripeCustomerId: true } });
  const offer = await offerFor(tenantId);
  const interval = selection.interval === "YEAR" ? "YEAR" : "MONTH";
  const wanted = new Map<string, number>();
  for (const item of selection.items ?? []) {
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
  if (lines.filter((l) => l.plan.kind === "EDITION").length !== 1) throw new CheckoutRefused("Choose one edition, and any add-ons with it.");

  const live = await control.subscription.findMany({ where: { tenantId, gateway: { not: "MANUAL" }, status: { in: ["TRIALING", "ACTIVE", "PAST_DUE"] } }, select: { gateway: true } });
  if (live.length) throw new CheckoutRefused("This workspace is already paying for a plan — change it from Manage billing.");

  const prices = await control.planPrice.findMany({ where: { id: { in: lines.map((l) => l.price.id) } }, select: { id: true, externalId: true } });
  const externalOf = (id: string) => {
    const external = prices.find((p) => p.id === id)?.externalId;
    if (!external) throw new CheckoutRefused("That price is not set up at the gateway yet. Staff can finish it in the platform console.");
    return external;
  };

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

  // Razorpay: a subscription per plan, remembered at once so its webhooks find their workspace.
  const authorisations: { plan: string; url: string }[] = [];
  for (const line of lines) {
    const sub = await createRazorpaySubscription({ planId: externalOf(line.price.id), quantity: line.quantity, tenantId, interval });
    await control.subscription.create({
      data: {
        tenantId,
        gateway: "RAZORPAY",
        status: "INCOMPLETE",
        externalId: sub.id,
        currency: "INR",
        interval,
        items: { create: { planId: (await control.plan.findUniqueOrThrow({ where: { key: line.plan.key }, select: { id: true } })).id, priceId: line.price.id, quantity: line.quantity } },
      },
    });
    if (!sub.short_url) throw new GatewayError("Razorpay did not return a payment page.");
    authorisations.push({ plan: line.plan.name, url: sub.short_url });
  }
  return { gateway: "RAZORPAY", authorisations };
}

/** Razorpay pages still waiting for the customer to authorise them. */
export async function pendingAuthorisations(tenantId: string): Promise<{ id: string; plan: string; externalId: string }[]> {
  const subs = await controlDb().subscription.findMany({
    where: { tenantId, gateway: "RAZORPAY", status: "INCOMPLETE" },
    select: { id: true, externalId: true, items: { select: { plan: { select: { name: true } } } } },
  });
  return subs.filter((s) => s.externalId).map((s) => ({ id: s.id, plan: s.items[0]?.plan.name ?? "Plan", externalId: s.externalId! }));
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
