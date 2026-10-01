import type { BillingInterval } from "@deskzo/control-client";
import { createRazorpayPlan } from "@/lib/billing/razorpay";
import { createStripePrice, createStripeProduct } from "@/lib/billing/stripe";
import { controlDb } from "@/lib/platform/control-db";

/**
 * A plan's price at a gateway — made there first (a Stripe price on the plan's product, a Razorpay
 * plan), then here with the gateway's id. Prices are never changed: a new one replaces the one on
 * offer, which stays on the subscriptions already paying it.
 */

export class PriceRefused extends Error {}

export async function addPlanPrice(
  input: { planKey: string; gateway: "STRIPE" | "RAZORPAY"; currency: string; interval: BillingInterval; amount: number; perSeat: boolean },
  actor: string,
): Promise<{ id: string; externalId: string }> {
  const control = controlDb();
  const plan = await control.plan.findUnique({ where: { key: input.planKey } });
  if (!plan) throw new PriceRefused("No such plan.");
  if (plan.kind === "INTERNAL") throw new PriceRefused("An internal plan is never sold.");
  const currency = String(input.currency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new PriceRefused("A currency is a three-letter code, like INR or USD.");
  if (input.gateway === "RAZORPAY" && currency !== "INR") throw new PriceRefused("Razorpay charges in rupees here: INR.");
  const amount = Math.round(Number(input.amount));
  if (!Number.isInteger(amount) || amount < 1) throw new PriceRefused("An amount is in the smallest unit (paise, cents), 1 or more.");
  if (input.interval !== "MONTH" && input.interval !== "YEAR") throw new PriceRefused("Monthly or yearly.");
  const reference = `${plan.key}-${input.gateway}-${currency}-${input.interval}-${amount}-${input.perSeat ? "seat" : "flat"}`.toLowerCase();

  let externalId: string;
  if (input.gateway === "STRIPE") {
    let productId = plan.stripeProductId;
    if (!productId) {
      productId = (await createStripeProduct({ name: plan.name, planKey: plan.key })).id;
      await control.plan.update({ where: { id: plan.id }, data: { stripeProductId: productId } });
    }
    externalId = (await createStripePrice({ productId, currency, amount, interval: input.interval, planKey: plan.key, reference })).id;
  } else {
    externalId = (await createRazorpayPlan({ planKey: plan.key, name: plan.name, amount, currency, interval: input.interval })).id;
  }

  const saved = await control.$transaction(async (tx) => {
    await tx.planPrice.updateMany({ where: { planId: plan.id, gateway: input.gateway, currency, interval: input.interval, active: true }, data: { active: false } });
    const made = await tx.planPrice.create({ data: { planId: plan.id, gateway: input.gateway, currency, interval: input.interval, amount, perSeat: !!input.perSeat, externalId }, select: { id: true } });
    const kind = actor.startsWith("staff:") ? "STAFF" : actor.startsWith("script:") ? "SCRIPT" : "SYSTEM";
    await tx.platformAuditLog.create({ data: { actorKind: kind, actor: actor.replace(/^(staff|script):/, ""), action: "plan.price", detail: { plan: plan.key, gateway: input.gateway, currency, interval: input.interval, amount, perSeat: !!input.perSeat, externalId } } });
    return made;
  });
  return { id: saved.id, externalId };
}

/** Taken off sale; subscriptions already paying it carry on. */
export async function retirePlanPrice(priceId: string, actor: string): Promise<void> {
  const price = await controlDb().planPrice.update({ where: { id: priceId }, data: { active: false }, select: { externalId: true, plan: { select: { key: true } } } });
  const kind = actor.startsWith("staff:") ? "STAFF" : actor.startsWith("script:") ? "SCRIPT" : "SYSTEM";
  await controlDb().platformAuditLog.create({ data: { actorKind: kind, actor: actor.replace(/^(staff|script):/, ""), action: "plan.price.retire", detail: { plan: price.plan.key, externalId: price.externalId } } });
}
