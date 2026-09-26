import type { Prisma } from "@wroffy/control-client";
import { fromUnix } from "@/lib/billing/gateway";
import { idOf, stripeInvoiceStatus, stripePeriodEnd, stripeStatus, type StripeInvoice, type StripeSubscription } from "@/lib/billing/stripe";
import { noteOf, razorpayStatus, type RazorpayPayment, type RazorpaySubscription } from "@/lib/billing/razorpay";
import { controlDb } from "@/lib/platform/control-db";
import { refreshEntitlements } from "@/lib/platform/entitlements";

/**
 * A gateway's word, written into the control plane: its subscriptions and invoices as ours, and then
 * the workspace's entitlements worked out again. The same functions serve webhooks and the daily
 * reconcile, so a missed webhook is made good by the next read.
 *
 * Each returns the workspace it concerned, or null for something that is not ours (another app on
 * the same gateway account, a subscription deleted here).
 */

const LIVE = new Set(["TRIALING", "ACTIVE", "PAST_DUE"]);

/** A paid subscription going live ends the free trial it replaces; a staff-given one stays. */
async function endTrialFor(tx: Prisma.TransactionClient, tenantId: string, now: Date) {
  await tx.subscription.updateMany({ where: { tenantId, gateway: "MANUAL", status: "TRIALING" }, data: { status: "CANCELLED", cancelledAt: now } });
}

async function tenantExists(tenantId: string | null | undefined): Promise<string | null> {
  if (!tenantId) return null;
  return (await controlDb().tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))?.id ?? null;
}

// ─── Stripe ────────────────────────────────────────────────────────────────────────────────────

export async function applyStripeSubscription(sub: StripeSubscription, now = new Date()): Promise<string | null> {
  const control = controlDb();
  const existing = await control.subscription.findUnique({ where: { externalId: sub.id }, select: { tenantId: true, pastDueSince: true } });
  const customerId = idOf(sub.customer);
  const byCustomer = customerId ? await control.tenant.findUnique({ where: { stripeCustomerId: customerId }, select: { id: true } }) : null;
  const tenantId = existing?.tenantId ?? (await tenantExists(sub.metadata?.tenantId)) ?? byCustomer?.id ?? null;
  if (!tenantId) return null;

  const status = stripeStatus(sub.status);
  const prices = await control.planPrice.findMany({ where: { externalId: { in: sub.items.data.map((i) => i.price.id) } }, select: { id: true, planId: true, externalId: true, interval: true } });
  const periodEnd = fromUnix(stripePeriodEnd(sub));
  const fields = {
    status,
    trialEndsAt: fromUnix(sub.trial_end),
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end || (!!sub.cancel_at && status !== "CANCELLED"),
    cancelledAt: status === "CANCELLED" ? (fromUnix(sub.ended_at) ?? fromUnix(sub.canceled_at) ?? now) : null,
    // The first failure starts the grace period; paying ends it.
    pastDueSince: status === "PAST_DUE" ? (existing?.pastDueSince ?? now) : null,
    externalCustomerId: customerId,
    currency: sub.currency?.toUpperCase() ?? null,
    interval: prices[0]?.interval ?? null,
    syncedAt: now,
  };

  await control.$transaction(async (tx) => {
    const saved = await tx.subscription.upsert({
      where: { externalId: sub.id },
      create: { tenantId, gateway: "STRIPE", externalId: sub.id, ...fields },
      update: fields,
      select: { id: true },
    });
    // The items as Stripe has them; one whose price is not ours is left out, not guessed at.
    const known = sub.items.data.filter((i) => prices.some((p) => p.externalId === i.price.id));
    await tx.subscriptionItem.deleteMany({ where: { subscriptionId: saved.id, OR: [{ externalId: null }, { externalId: { notIn: known.map((i) => i.id) } }] } });
    for (const item of known) {
      const price = prices.find((p) => p.externalId === item.price.id)!;
      const data = { planId: price.planId, priceId: price.id, quantity: Math.max(1, item.quantity ?? 1) };
      const clash = await tx.subscriptionItem.findUnique({ where: { subscriptionId_planId: { subscriptionId: saved.id, planId: price.planId } }, select: { externalId: true } });
      if (clash && clash.externalId !== item.id) await tx.subscriptionItem.delete({ where: { subscriptionId_planId: { subscriptionId: saved.id, planId: price.planId } } });
      await tx.subscriptionItem.upsert({ where: { externalId: item.id }, create: { subscriptionId: saved.id, externalId: item.id, ...data }, update: data });
    }
    if (customerId) {
      const holder = await tx.tenant.findUnique({ where: { stripeCustomerId: customerId }, select: { id: true } });
      if (!holder) await tx.tenant.update({ where: { id: tenantId }, data: { stripeCustomerId: customerId } });
    }
    if (LIVE.has(status)) await endTrialFor(tx, tenantId, now);
  });
  await refreshEntitlements(tenantId);
  return tenantId;
}

export async function applyStripeInvoice(invoice: StripeInvoice): Promise<string | null> {
  const control = controlDb();
  const subscriptionId = idOf(invoice.subscription);
  const customerId = idOf(invoice.customer);
  const sub = subscriptionId ? await control.subscription.findUnique({ where: { externalId: subscriptionId }, select: { tenantId: true } }) : null;
  const byCustomer = !sub && customerId ? await control.tenant.findUnique({ where: { stripeCustomerId: customerId }, select: { id: true } }) : null;
  const tenantId = sub?.tenantId ?? byCustomer?.id ?? (await tenantExists(invoice.metadata?.tenantId));
  if (!tenantId) return null;
  const excludingTax = invoice.total_excluding_tax ?? invoice.subtotal;
  const data = {
    number: invoice.number ?? null,
    status: stripeInvoiceStatus(invoice.status),
    currency: invoice.currency.toUpperCase(),
    subtotal: invoice.subtotal,
    tax: invoice.tax ?? Math.max(0, invoice.total - excludingTax),
    total: invoice.total,
    amountPaid: invoice.amount_paid ?? 0,
    periodStart: fromUnix(invoice.period_start),
    periodEnd: fromUnix(invoice.period_end),
    issuedAt: fromUnix(invoice.created) ?? new Date(),
    paidAt: fromUnix(invoice.status_transitions?.paid_at),
    hostedUrl: invoice.hosted_invoice_url ?? null,
    pdfUrl: invoice.invoice_pdf ?? null,
  };
  await control.invoice.upsert({
    where: { gateway_externalId: { gateway: "STRIPE", externalId: invoice.id } },
    create: { tenantId, gateway: "STRIPE", externalId: invoice.id, ...data },
    update: data,
  });
  return tenantId;
}

// ─── Razorpay ──────────────────────────────────────────────────────────────────────────────────

export async function applyRazorpaySubscription(sub: RazorpaySubscription, now = new Date()): Promise<string | null> {
  const control = controlDb();
  const existing = await control.subscription.findUnique({ where: { externalId: sub.id }, select: { tenantId: true, pastDueSince: true, cancelAtPeriodEnd: true } });
  const tenantId = existing?.tenantId ?? (await tenantExists(noteOf(sub.notes, "tenantId")));
  if (!tenantId) return null;
  const price = await control.planPrice.findUnique({ where: { externalId: sub.plan_id }, select: { id: true, planId: true, currency: true, interval: true } });
  const status = razorpayStatus(sub.status);
  const fields = {
    status,
    currentPeriodEnd: fromUnix(sub.current_end) ?? fromUnix(sub.charge_at),
    cancelledAt: status === "CANCELLED" ? (fromUnix(sub.ended_at) ?? now) : null,
    cancelAtPeriodEnd: status === "CANCELLED" ? false : (existing?.cancelAtPeriodEnd ?? false),
    pastDueSince: status === "PAST_DUE" ? (existing?.pastDueSince ?? now) : null,
    externalCustomerId: sub.customer_id ?? null,
    currency: price?.currency ?? "INR",
    interval: price?.interval ?? null,
    syncedAt: now,
  };
  await control.$transaction(async (tx) => {
    const saved = await tx.subscription.upsert({
      where: { externalId: sub.id },
      create: { tenantId, gateway: "RAZORPAY", externalId: sub.id, ...fields },
      update: fields,
      select: { id: true },
    });
    if (price) {
      const data = { planId: price.planId, priceId: price.id, quantity: Math.max(1, sub.quantity ?? 1) };
      await tx.subscriptionItem.deleteMany({ where: { subscriptionId: saved.id, NOT: { planId: price.planId } } });
      await tx.subscriptionItem.upsert({ where: { subscriptionId_planId: { subscriptionId: saved.id, planId: price.planId } }, create: { subscriptionId: saved.id, ...data }, update: data });
    }
    if (sub.customer_id) {
      const holder = await tx.tenant.findUnique({ where: { razorpayCustomerId: sub.customer_id }, select: { id: true } });
      if (!holder) await tx.tenant.update({ where: { id: tenantId }, data: { razorpayCustomerId: sub.customer_id } });
    }
    if (LIVE.has(status)) await endTrialFor(tx, tenantId, now);
  });
  await refreshEntitlements(tenantId);
  return tenantId;
}

/** A charge on a subscription: its invoice, paid. */
export async function applyRazorpayCharge(payment: RazorpayPayment, sub: RazorpaySubscription): Promise<string | null> {
  const control = controlDb();
  const ours = await control.subscription.findUnique({ where: { externalId: sub.id }, select: { tenantId: true } });
  const tenantId = ours?.tenantId ?? (await tenantExists(noteOf(sub.notes, "tenantId")));
  if (!tenantId) return null;
  const externalId = payment.invoice_id ?? payment.id;
  const paid = payment.status === "captured";
  const tax = payment.tax ?? 0;
  const data = {
    status: paid ? ("PAID" as const) : ("OPEN" as const),
    currency: payment.currency.toUpperCase(),
    subtotal: payment.amount - tax,
    tax,
    total: payment.amount,
    amountPaid: paid ? payment.amount : 0,
    periodStart: fromUnix(sub.current_start),
    periodEnd: fromUnix(sub.current_end),
    issuedAt: fromUnix(payment.created_at) ?? new Date(),
    paidAt: paid ? fromUnix(payment.created_at) : null,
  };
  await control.invoice.upsert({
    where: { gateway_externalId: { gateway: "RAZORPAY", externalId } },
    create: { tenantId, gateway: "RAZORPAY", externalId, ...data },
    update: data,
  });
  return tenantId;
}
