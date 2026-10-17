import type { BillingInterval, OfflinePaymentMethod, Prisma } from "@deskzo/control-client";
import { choiceRefusal } from "@/lib/billing/plan-choice";
import { platformGstIn, withPlatformGst } from "@/lib/billing/platform-gst";
import { issueCreditNote, issueTaxInvoice } from "@/lib/billing/tax-invoice";
import { controlDb } from "@/lib/platform/control-db";
import { refreshEntitlements } from "@/lib/platform/entitlements";
import { PLAN_CHOICE_SELECT, choicePlanOf, liveGatewaySubscription, planChoiceRefusal } from "@/lib/platform/plans";
import { clockFor } from "@/lib/time/zone";

/**
 * Payments no gateway took, recorded by staff (owner, 12 Oct 2026: bank transfer is staff only) — a
 * NEFT, RTGS, IMPS or UPI transfer, a cheque, or a distributor paying for its customer.
 *
 *   · A workspace has one OFFLINE subscription. Each payment pays it for a period — so many months or
 *     years of the plans chosen, from a day — moves its paid-until date on, sets its plans and people,
 *     and has its own paid invoice and GST tax invoice (billed to the distributor when one paid).
 *   · Paid until the period ends; then it is due like any subscription (src/lib/billing/lifecycle.ts):
 *     reminders before the end, fourteen days' grace after it, then the workspace is held. Recording the
 *     next payment carries it on; a held workspace is let back in at once.
 *   · Never deleted. A payment recorded by mistake is voided with a reason: its period comes off the
 *     paid-until date (the subscription ends with its last payment), and its tax invoice is credited.
 *   · Rupees, for workspaces in India — what the GST tax invoice is for.
 */

export class OfflineRefused extends Error {}

export const OFFLINE_METHODS: readonly OfflinePaymentMethod[] = ["NEFT", "RTGS", "IMPS", "UPI", "CHEQUE", "CASH", "OTHER"];
export const MAX_PERIODS = { MONTH: 24, YEAR: 5 } as const;

export type OfflineItem = { planKey: string; quantity: number };

export type OfflineQuoteLine = { planKey: string; name: string; quantity: number; unitPrice: number; perSeat: boolean; amount: number };
export type OfflineQuote = { lines: OfflineQuoteLine[]; subtotal: number; gst: number; total: number; currency: "INR" };

const INDIA = "Asia/Kolkata";

/** A day on India's calendar as the moment it starts there; null when it isn't one. */
function dayStart(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const at = new Date(`${day}T00:00:00+05:30`);
  return Number.isNaN(at.getTime()) || clockFor(INDIA).dateKey(at) !== day ? null : at;
}

/** So many months or years on from a day: the same day of the month, or the month's last when it has none. */
export function periodEndOf(start: Date, interval: BillingInterval, periods: number): Date {
  const [y, m, d] = clockFor(INDIA).dateKey(start).split("-").map(Number) as [number, number, number];
  const months = interval === "YEAR" ? periods * 12 : periods;
  const targetMonth = m - 1 + months;
  const ty = y + Math.floor(targetMonth / 12);
  const tm = targetMonth % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const day = `${ty}-${String(tm + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
  return dayStart(day)!;
}

function wanted(items: readonly OfflineItem[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items ?? []) {
    const quantity = Number(item?.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) throw new OfflineRefused("A quantity is a whole number from 1.");
    out.set(String(item.planKey), quantity);
  }
  if (!out.size) throw new OfflineRefused("Choose what it pays for.");
  return out;
}

/** What the price list says these plans cost for the period, before and with GST — what staff check what came in against. */
export async function quoteOffline(tenantId: string, items: readonly OfflineItem[], interval: BillingInterval, periods: number): Promise<OfflineQuote> {
  if (interval !== "MONTH" && interval !== "YEAR") throw new OfflineRefused("Monthly or yearly.");
  if (!Number.isInteger(periods) || periods < 1 || periods > MAX_PERIODS[interval]) throw new OfflineRefused(interval === "YEAR" ? `1 to ${MAX_PERIODS.YEAR} years.` : `1 to ${MAX_PERIODS.MONTH} months.`);
  const control = controlDb();
  const tenant = await control.tenant.findUnique({ where: { id: tenantId }, select: { country: true, status: true } });
  if (!tenant || tenant.status === "DEPROVISIONED") throw new OfflineRefused("That workspace is closed.");
  if (tenant.country !== "IN") throw new OfflineRefused("Offline payments are recorded in rupees, for workspaces in India.");
  const want = wanted(items);
  const keys = [...want.keys()];
  const plans = (await control.plan.findMany({ where: { key: { in: keys } }, select: { ...PLAN_CHOICE_SELECT, prices: { where: { active: true, currency: "INR", interval } } } })).sort(
    (a, b) => keys.indexOf(a.key) - keys.indexOf(b.key),
  );
  const missing = keys.filter((k) => !plans.some((p) => p.key === k));
  if (missing.length) throw new OfflineRefused(`No such plan: ${missing.join(", ")}.`);
  for (const plan of plans) {
    if (plan.kind === "INTERNAL") throw new OfflineRefused("An internal plan is never sold.");
    const refusal = planChoiceRefusal(plan, false, tenant.country);
    if (refusal) throw new OfflineRefused(refusal);
  }
  const rules = choiceRefusal(plans.map(choicePlanOf));
  if (rules) throw new OfflineRefused(rules);
  const lines = plans.map((plan) => {
    const price = plan.prices[0];
    if (!price) throw new OfflineRefused(`${plan.name} has no ${interval === "YEAR" ? "yearly" : "monthly"} price in rupees — add one in Plans first.`);
    const quantity = want.get(plan.key)!;
    return { planKey: plan.key, name: plan.name, quantity, unitPrice: price.amount, perSeat: price.perSeat, amount: price.amount * quantity * periods };
  });
  const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);
  const total = withPlatformGst(subtotal);
  return { lines, subtotal, gst: total - subtotal, total, currency: "INR" };
}

export type OfflineInput = {
  tenantId: string;
  items: OfflineItem[];
  interval: BillingInterval;
  periods: number;
  /** The first day it pays for (India's calendar); empty: the day after the paid-until date, or today. */
  startsOn?: string | null;
  /** What came in, in paise, GST included. */
  amount: number;
  method: OfflinePaymentMethod;
  reference?: string | null;
  receivedOn: string;
  /** A distributor or reseller paying for the workspace; empty: the workspace itself. */
  partnerId?: string | null;
  note?: string | null;
  /** The workspace's proforma it pays (src/lib/billing/proforma.ts) — closed as paid with it. */
  proformaId?: string | null;
};

export type RecordedPayment = { paymentId: string; invoiceId: string; subscriptionId: string; periodEnd: Date; taxNumber: string | null };

/** Records a payment: the workspace is paid for the period, its invoice paid, its tax invoice issued and mailed. */
export async function recordOfflinePayment(input: OfflineInput, staffId: string, now = new Date()): Promise<RecordedPayment> {
  const control = controlDb();
  if (!OFFLINE_METHODS.includes(input.method)) throw new OfflineRefused("Choose how it was paid.");
  const amount = Math.round(Number(input.amount));
  if (!Number.isInteger(amount) || amount < 1) throw new OfflineRefused("Enter the amount received.");
  const receivedOn = dayStart(String(input.receivedOn ?? ""));
  if (!receivedOn) throw new OfflineRefused("Enter the day it was received.");
  if (receivedOn.getTime() > now.getTime()) throw new OfflineRefused("The day it was received can't be in the future.");
  const reference = String(input.reference ?? "").trim().slice(0, 80) || null;
  const note = String(input.note ?? "").trim().slice(0, 500) || null;
  if (!reference && input.method !== "CASH") throw new OfflineRefused("Enter its reference — the UTR, or the cheque's number.");

  const quote = await quoteOffline(input.tenantId, input.items, input.interval, Number(input.periods));
  const gateway = await liveGatewaySubscription(input.tenantId, now);
  if (gateway) throw new OfflineRefused(`It pays through ${gateway.gateway === "STRIPE" ? "Stripe" : "Razorpay"} — cancel that first, or change its plan there.`);
  if (input.partnerId) {
    const partner = await control.partner.findUnique({ where: { id: input.partnerId }, select: { status: true } });
    if (!partner || partner.status === "TERMINATED") throw new OfflineRefused("Choose a partner from the directory.");
  }
  const existing = await control.subscription.findFirst({
    where: { tenantId: input.tenantId, gateway: "OFFLINE", status: { not: "CANCELLED" } },
    select: { id: true, currentPeriodEnd: true },
  });
  // From the day asked; otherwise straight on from what is paid already, or today.
  const asked = input.startsOn ? dayStart(input.startsOn) : null;
  if (input.startsOn && !asked) throw new OfflineRefused("Enter the first day it pays for, or leave it empty.");
  const startsAt = asked ?? (existing?.currentPeriodEnd && existing.currentPeriodEnd > now ? existing.currentPeriodEnd : dayStart(clockFor(INDIA).dateKey(now))!);
  const endsAt = periodEndOf(startsAt, input.interval, Number(input.periods));
  const plans = await control.plan.findMany({ where: { key: { in: quote.lines.map((l) => l.planKey) } }, select: { id: true, key: true, prices: { where: { active: true, currency: "INR", interval: input.interval }, select: { id: true } } } });
  const tax = platformGstIn(amount);
  if (input.proformaId) {
    const proforma = await control.platformProforma.findUnique({ where: { id: input.proformaId }, select: { tenantId: true, status: true } });
    if (!proforma || proforma.tenantId !== input.tenantId) throw new OfflineRefused("That proforma isn't this workspace's.");
    if (proforma.status !== "OPEN") throw new OfflineRefused("That proforma is closed already — record the payment without it.");
  }

  const made = await control.$transaction(async (tx) => {
    const sub = existing
      ? await tx.subscription.update({
          where: { id: existing.id },
          data: { status: "ACTIVE", currentPeriodEnd: existing.currentPeriodEnd && existing.currentPeriodEnd > endsAt ? existing.currentPeriodEnd : endsAt, pastDueSince: null, cancelledAt: null, cancelAtPeriodEnd: false, currency: "INR", interval: input.interval },
          select: { id: true, currentPeriodEnd: true },
        })
      : await tx.subscription.create({ data: { tenantId: input.tenantId, gateway: "OFFLINE", status: "ACTIVE", currentPeriodEnd: endsAt, currency: "INR", interval: input.interval }, select: { id: true, currentPeriodEnd: true } });
    // Its plans and people are what was last paid for.
    await tx.subscriptionItem.deleteMany({ where: { subscriptionId: sub.id } });
    for (const line of quote.lines) {
      const plan = plans.find((p) => p.key === line.planKey)!;
      await tx.subscriptionItem.create({ data: { subscriptionId: sub.id, planId: plan.id, priceId: plan.prices[0]?.id ?? null, quantity: line.quantity } });
    }
    const invoice = await tx.invoice.create({
      data: {
        tenantId: input.tenantId,
        gateway: "OFFLINE",
        externalId: `offline-${sub.id}-${now.getTime()}`,
        status: "PAID",
        currency: "INR",
        subtotal: amount - tax,
        tax,
        total: amount,
        amountPaid: amount,
        periodStart: startsAt,
        periodEnd: endsAt,
        issuedAt: now,
        paidAt: receivedOn,
        subscriptionId: sub.id,
        billToPartnerId: input.partnerId || null,
        // What this payment bought, as its tax invoice lists it — the subscription's items change with the next payment.
        planLines: quote.lines.map((l) => ({ planKey: l.planKey, amount: l.amount, name: l.name, quantity: l.quantity, perSeat: l.perSeat, periods: Number(input.periods), interval: input.interval })) as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    const payment = await tx.offlinePayment.create({
      data: {
        tenantId: input.tenantId,
        subscriptionId: sub.id,
        invoiceId: invoice.id,
        periodStart: startsAt,
        periodEnd: endsAt,
        method: input.method,
        reference,
        receivedOn,
        amount,
        currency: "INR",
        partnerId: input.partnerId || null,
        note,
        recordedBy: staffId,
      },
      select: { id: true },
    });
    // The proforma it pays, paid — only if nobody closed it in the meantime.
    if (input.proformaId) {
      const closed = await tx.platformProforma.updateMany({ where: { id: input.proformaId, tenantId: input.tenantId, status: "OPEN" }, data: { status: "PAID", paymentId: payment.id, closedAt: now } });
      if (closed.count !== 1) throw new OfflineRefused("That proforma was closed a moment ago — record the payment without it.");
    }
    // A free trial is over once it is paid for.
    await tx.subscription.updateMany({ where: { tenantId: input.tenantId, gateway: "MANUAL", status: "TRIALING" }, data: { status: "CANCELLED", cancelledAt: now } });
    await tx.platformAuditLog.create({
      data: {
        actorKind: "STAFF",
        actor: staffId,
        action: "billing.offline.record",
        tenantId: input.tenantId,
        detail: { payment: payment.id, method: input.method, amount, periods: Number(input.periods), interval: input.interval, until: endsAt.toISOString(), partnerId: input.partnerId || null, proformaId: input.proformaId || null },
      },
    });
    return { paymentId: payment.id, invoiceId: invoice.id, subscriptionId: sub.id, periodEnd: sub.currentPeriodEnd ?? endsAt };
  });
  await refreshEntitlements(input.tenantId);
  const taxNumber = await issueTaxInvoice(made.invoiceId, { now });
  return { ...made, taxNumber };
}

/**
 * A payment recorded by mistake, voided — never deleted. Its period comes off: the paid-until date goes
 * back to the latest of the payments left, and with none left the subscription ends. Its invoice is
 * voided and its tax invoice credited in full.
 */
export async function voidOfflinePayment(paymentId: string, reason: string, staffId: string, now = new Date()): Promise<void> {
  const why = String(reason ?? "").trim();
  if (why.length < 3 || why.length > 500) throw new OfflineRefused("Say why it is voided.");
  const control = controlDb();
  const payment = await control.offlinePayment.findUnique({ where: { id: paymentId }, select: { id: true, tenantId: true, subscriptionId: true, invoiceId: true, voidedAt: true, amount: true } });
  if (!payment) throw new OfflineRefused("That payment no longer exists.");
  if (payment.voidedAt) throw new OfflineRefused("That payment is voided already.");
  await control.$transaction(async (tx) => {
    await tx.offlinePayment.update({ where: { id: payment.id }, data: { voidedAt: now, voidedBy: staffId, voidReason: why } });
    await tx.invoice.update({ where: { id: payment.invoiceId }, data: { status: "VOID" } });
    const left = await tx.offlinePayment.findMany({ where: { subscriptionId: payment.subscriptionId, voidedAt: null }, select: { periodEnd: true } });
    const until = left.reduce<Date | null>((max, p) => (!max || p.periodEnd > max ? p.periodEnd : max), null);
    await tx.subscription.update({
      where: { id: payment.subscriptionId },
      data: until ? { currentPeriodEnd: until } : { status: "CANCELLED", cancelledAt: now, currentPeriodEnd: now },
    });
    await tx.platformAuditLog.create({ data: { actorKind: "STAFF", actor: staffId, action: "billing.offline.void", tenantId: payment.tenantId, detail: { payment: payment.id, reason: why } } });
  });
  await refreshEntitlements(payment.tenantId);
  await issueCreditNote(payment.invoiceId, payment.amount, `Payment voided: ${why}`, { now });
}
