import { Prisma, type BillingGateway } from "@deskzo/control-client";
import { fromUnix } from "@/lib/billing/gateway";
import { idOf, stripeInvoiceStatus, stripePeriodEnd, stripeStatus, type StripeCharge, type StripeInvoice, type StripeSubscription } from "@/lib/billing/stripe";
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
 *
 * An invoice also keeps what partner commission is worked out from: the subscription it bills, its
 * lines by plan, and the money that went back to the customer — refunded, or credited after payment.
 * What was refunded only ever goes up here; the commission engine reverses its share of it.
 */

const LIVE = new Set(["TRIALING", "ACTIVE", "PAST_DUE"]);

/** An invoice's amount by plan, as `invoices.planLines` holds it: `planKey` null for a price that is not ours. */
export type PlanLine = { planKey: string | null; amount: number };

/** A paid subscription going live ends the free trial it replaces; a staff-given one stays. */
async function endTrialFor(tx: Prisma.TransactionClient, tenantId: string, now: Date) {
  await tx.subscription.updateMany({ where: { tenantId, gateway: "MANUAL", status: "TRIALING" }, data: { status: "CANCELLED", cancelledAt: now } });
}

async function tenantExists(tenantId: string | null | undefined): Promise<string | null> {
  if (!tenantId) return null;
  return (await controlDb().tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))?.id ?? null;
}

/**
 * What was refunded on one of our invoices, raised to `refunded` — never lowered, since gateways send
 * refunds more than once and out of order. `refundedAt` moves only when the amount grows. The workspace,
 * or null for an invoice that is not here.
 */
async function raiseRefunded(gateway: BillingGateway, externalId: string | null, refunded: number | undefined, now: Date): Promise<string | null> {
  if (!externalId) return null;
  const control = controlDb();
  const invoice = await control.invoice.findUnique({ where: { gateway_externalId: { gateway, externalId } }, select: { tenantId: true } });
  if (!invoice) return null;
  if (typeof refunded === "number" && Number.isInteger(refunded) && refunded > 0) {
    // One conditional statement: a smaller figure arriving late matches no row, so it cannot lower it.
    await control.invoice.updateMany({ where: { gateway, externalId, amountRefunded: { lt: refunded } }, data: { amountRefunded: refunded, refundedAt: now } });
  }
  return invoice.tenantId;
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

/** Each line's price as our plan's key; null when it has no lines, or Stripe sent only some of them — the engine then falls back to the subscription's plan. */
async function stripePlanLines(invoice: StripeInvoice): Promise<PlanLine[] | null> {
  const lines = invoice.lines;
  if (!lines?.data.length || lines.has_more) return null;
  const priceIds = [...new Set(lines.data.flatMap((l) => (l.price?.id ? [l.price.id] : [])))];
  const prices = priceIds.length
    ? await controlDb().planPrice.findMany({ where: { gateway: "STRIPE", externalId: { in: priceIds } }, select: { externalId: true, plan: { select: { key: true } } } })
    : [];
  const keyOf = new Map(prices.map((p) => [p.externalId, p.plan.key]));
  return lines.data.map((l) => ({ planKey: (l.price?.id ? keyOf.get(l.price.id) : undefined) ?? null, amount: l.amount }));
}

export async function applyStripeInvoice(invoice: StripeInvoice): Promise<string | null> {
  const control = controlDb();
  const subscriptionId = idOf(invoice.subscription);
  const customerId = idOf(invoice.customer);
  const sub = subscriptionId ? await control.subscription.findUnique({ where: { externalId: subscriptionId }, select: { id: true, tenantId: true } }) : null;
  const byCustomer = !sub && customerId ? await control.tenant.findUnique({ where: { stripeCustomerId: customerId }, select: { id: true } }) : null;
  const tenantId = sub?.tenantId ?? byCustomer?.id ?? (await tenantExists(invoice.metadata?.tenantId));
  if (!tenantId) return null;
  const excludingTax = invoice.total_excluding_tax ?? invoice.subtotal;
  const planLines = await stripePlanLines(invoice);
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
    planLines: planLines ?? Prisma.DbNull,
    // Stripe's running total, which falls again when a credit note is voided; a payload without it leaves ours alone.
    ...(typeof invoice.post_payment_credit_notes_amount === "number" ? { amountCredited: Math.max(0, invoice.post_payment_credit_notes_amount) } : {}),
  };
  await control.invoice.upsert({
    where: { gateway_externalId: { gateway: "STRIPE", externalId: invoice.id } },
    create: { tenantId, gateway: "STRIPE", externalId: invoice.id, subscriptionId: sub?.id ?? null, ...data },
    // An invoice's subscription never changes: one not (yet) here leaves the one already known.
    update: { ...data, ...(sub ? { subscriptionId: sub.id } : {}) },
  });
  return tenantId;
}

/** A charge refunded, in whole or in part: its invoice keeps how much went back. */
export async function applyStripeRefund(charge: StripeCharge, now = new Date()): Promise<string | null> {
  return raiseRefunded("STRIPE", idOf(charge.invoice), charge.amount_refunded, now);
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
  const ours = await control.subscription.findUnique({
    where: { externalId: sub.id },
    select: { id: true, tenantId: true, items: { select: { plan: { select: { key: true } } }, orderBy: { createdAt: "asc" }, take: 1 } },
  });
  const tenantId = ours?.tenantId ?? (await tenantExists(noteOf(sub.notes, "tenantId")));
  if (!tenantId) return null;
  const externalId = payment.invoice_id ?? payment.id;
  const paid = payment.status === "captured";
  const tax = payment.tax ?? 0;
  // A Razorpay subscription carries a single plan, so the whole charge, less its tax, is that plan's.
  const planKey = ours?.items[0]?.plan.key ?? null;
  const planLines: PlanLine[] | null = planKey ? [{ planKey, amount: payment.amount - tax }] : null;
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
    planLines: planLines ?? Prisma.DbNull,
  };
  await control.invoice.upsert({
    where: { gateway_externalId: { gateway: "RAZORPAY", externalId } },
    create: { tenantId, gateway: "RAZORPAY", externalId, subscriptionId: ours?.id ?? null, ...data },
    update: { ...data, ...(ours ? { subscriptionId: ours.id } : {}) },
  });
  return tenantId;
}

/** A payment refunded, in whole or in part: the invoice it paid keeps how much went back. */
export async function applyRazorpayRefund(payment: RazorpayPayment, now = new Date()): Promise<string | null> {
  return raiseRefunded("RAZORPAY", payment.invoice_id ?? payment.id, payment.amount_refunded, now);
}
