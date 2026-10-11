import type { BillingInterval } from "@deskzo/control-client";
import type { Gateway } from "@/lib/billing/checkout";
import { GatewayNotConfigured } from "@/lib/billing/gateway";
import { withPlatformGst } from "@/lib/billing/platform-gst";
import { createRazorpayPlan } from "@/lib/billing/razorpay";
import { createStripePrice, createStripeProduct } from "@/lib/billing/stripe";
import { controlDb } from "@/lib/platform/control-db";
import { gatewayModes } from "@/lib/platform/settings";

/**
 * A plan's prices. Owner, 12 Oct 2026: a price belongs to the plan, not to a payment gateway — it is
 * shown on the website and the billing page whether a gateway is connected or not, and a gateway added
 * later (Cashfree, PayU…) needs no new prices.
 *
 *   · `addPlanPrice`: a price in a currency, monthly or yearly, before tax — here only; no gateway is
 *     called. It replaces the one on sale for the same plan, currency and interval, which stays on
 *     the subscriptions already paying it. Prices are never changed.
 *   · `gatewayPriceId`: the price's copy at a gateway — a Stripe price, a Razorpay plan — made the
 *     first time somebody pays it there (checkout), for the keys then in use: test and live keys are
 *     different accounts at the gateway, so each has its own copy. Stripe adds the tax itself; a
 *     Razorpay plan carries the GST, since Razorpay charges exactly its amount (platform-gst.ts).
 */

export class PriceRefused extends Error {}

export async function addPlanPrice(
  input: { planKey: string; currency: string; interval: BillingInterval; amount: number; perSeat: boolean },
  actor: string,
): Promise<{ id: string }> {
  const control = controlDb();
  const plan = await control.plan.findUnique({ where: { key: input.planKey } });
  if (!plan) throw new PriceRefused("No such plan.");
  if (plan.kind === "INTERNAL") throw new PriceRefused("An internal plan is never sold.");
  const currency = String(input.currency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new PriceRefused("A currency is a three-letter code, like INR or USD.");
  const amount = Math.round(Number(input.amount));
  if (!Number.isInteger(amount) || amount < 1) throw new PriceRefused("An amount is in the smallest unit (paise, cents), 1 or more.");
  if (input.interval !== "MONTH" && input.interval !== "YEAR") throw new PriceRefused("Monthly or yearly.");

  return control.$transaction(async (tx) => {
    await tx.planPrice.updateMany({ where: { planId: plan.id, currency, interval: input.interval, active: true }, data: { active: false } });
    const made = await tx.planPrice.create({ data: { planId: plan.id, currency, interval: input.interval, amount, perSeat: !!input.perSeat }, select: { id: true } });
    const kind = actor.startsWith("staff:") ? "STAFF" : actor.startsWith("script:") ? "SCRIPT" : "SYSTEM";
    await tx.platformAuditLog.create({ data: { actorKind: kind, actor: actor.replace(/^(staff|script):/, ""), action: "plan.price", detail: { plan: plan.key, currency, interval: input.interval, amount, perSeat: !!input.perSeat } } });
    return made;
  });
}

/** Taken off sale; subscriptions already paying it carry on. */
export async function retirePlanPrice(priceId: string, actor: string): Promise<void> {
  const price = await controlDb().planPrice.update({ where: { id: priceId }, data: { active: false }, select: { plan: { select: { key: true } }, currency: true, interval: true, amount: true } });
  const kind = actor.startsWith("staff:") ? "STAFF" : actor.startsWith("script:") ? "SCRIPT" : "SYSTEM";
  await controlDb().platformAuditLog.create({
    data: { actorKind: kind, actor: actor.replace(/^(staff|script):/, ""), action: "plan.price.retire", detail: { plan: price.plan.key, currency: price.currency, interval: price.interval, amount: price.amount } },
  });
}

/** Which keys a gateway is on now: "test", "live", or "unknown" when they can't be told apart. */
async function modeNow(gateway: Gateway): Promise<"test" | "live" | "unknown"> {
  const modes = await gatewayModes();
  const mode = gateway === "STRIPE" ? modes.stripe : modes.razorpay;
  if (mode === null) throw new GatewayNotConfigured(gateway === "STRIPE" ? "Stripe" : "Razorpay");
  return mode === "test" || mode === "live" ? mode : "unknown";
}

/**
 * The gateway's id for a price — its copy there, made now if it has none for the keys in use. A copy
 * made before modes were kept ("unknown") is used for either. Two checkouts making the same copy at
 * once: one is kept, the other's object at the gateway is left unused.
 */
export async function gatewayPriceId(priceId: string, gateway: Gateway): Promise<string> {
  const control = controlDb();
  const mode = await modeNow(gateway);
  const copies = await control.gatewayPrice.findMany({ where: { priceId, gateway, mode: { in: [mode, "unknown"] } }, select: { mode: true, externalId: true } });
  const copy = copies.find((c) => c.mode === mode) ?? copies[0];
  if (copy) return copy.externalId;

  const price = await control.planPrice.findUniqueOrThrow({ where: { id: priceId }, include: { plan: true } });
  const { plan } = price;
  let externalId: string;
  if (gateway === "STRIPE") {
    let productId = plan.stripeProductId;
    if (!productId) {
      productId = (await createStripeProduct({ name: plan.name, planKey: plan.key })).id;
      await control.plan.update({ where: { id: plan.id }, data: { stripeProductId: productId } });
    }
    const reference = `${plan.key}-${price.currency}-${price.interval}-${price.amount}-${price.perSeat ? "seat" : "flat"}-${mode}`.toLowerCase();
    externalId = (await createStripePrice({ productId, currency: price.currency, amount: price.amount, interval: price.interval, planKey: plan.key, reference })).id;
  } else {
    if (price.currency !== "INR") throw new PriceRefused("Razorpay charges in rupees: this price is not in INR.");
    externalId = (await createRazorpayPlan({ planKey: plan.key, name: plan.name, amount: withPlatformGst(price.amount), currency: price.currency, interval: price.interval })).id;
  }
  try {
    await control.gatewayPrice.create({ data: { priceId, gateway, mode, externalId } });
  } catch (err) {
    // Made at the same moment by another checkout: theirs is the one kept.
    const kept = await control.gatewayPrice.findUnique({ where: { priceId_gateway_mode: { priceId, gateway, mode } }, select: { externalId: true } });
    if (kept) return kept.externalId;
    throw err;
  }
  return externalId;
}

/** The price a gateway's id stands for — what a webhook names — or null when it is none of ours. */
export async function priceOfGatewayId(gateway: Gateway, externalId: string | null | undefined) {
  if (!externalId) return null;
  const copy = await controlDb().gatewayPrice.findUnique({
    where: { externalId },
    select: { gateway: true, price: { select: { id: true, planId: true, currency: true, interval: true, plan: { select: { key: true } } } } },
  });
  return copy && copy.gateway === gateway ? copy.price : null;
}
