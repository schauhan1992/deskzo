"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser, viewAsContext } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/authz/resolve";
import { GatewayError } from "@/lib/billing/gateway";
import { billingStanding, applyStanding, type Standing } from "@/lib/billing/lifecycle";
import { CheckoutRefused, billingPortal, cancelAtPeriodEnd, offerFor, pendingAuthorisations, scheduleRazorpayChange, startCheckout, type CheckoutStart, type OfferPlan, type Selection } from "@/lib/billing/checkout";
import { ProformaRefused, bankTransferOpen, proformasOf, requestProforma } from "@/lib/billing/proforma";
import { getRazorpaySubscription } from "@/lib/billing/razorpay";
import { creditStanding } from "@/lib/ai/credits";
import { PackRefused, packOffer, startPackCheckout } from "@/lib/ai/packs";
import { controlDb } from "@/lib/platform/control-db";
import { documentUrl } from "@/lib/billing/tax-invoice";
import { GST_STATE_CODES } from "@/lib/gst-engine";
import { seatsInUse } from "@/lib/seats";
import { currentTenant, tenantOrigin } from "@/lib/tenancy/resolve";
import type { ActionResult } from "@/actions/company";

/**
 * The workspace's plan and billing (Settings → Plan & billing): choosing a plan, paying for it,
 * changing or cancelling it. The super admin's, and whoever holds "Manage the plan and billing" (owner,
 * 17 Oct 2026 — an accounts person, say; an admin holds it like every key). Never a support account,
 * and not while "viewing as" somebody. Everything here acts on the control plane and the gateways
 * (src/lib/billing), for this workspace only.
 */

async function manager(): Promise<{ ok: true; me: { id: string; name: string; email: string } } | { ok: false; error: string }> {
  const user = await requireUser();
  if (await viewAsContext()) return { ok: false, error: "Switch back to your own account first." };
  const me = await db.user.findUnique({ where: { id: user.id }, select: { id: true, name: true, email: true, kind: true } });
  // A super admin holds every key (src/lib/authz/resolve.ts), so the owner is never shut out of paying.
  if (!me || me.kind !== "MEMBER" || !(await can(me.id, "billing.manage"))) return { ok: false, error: "You can't manage this workspace's plan and billing." };
  return { ok: true, me: { id: me.id, name: me.name, email: me.email } };
}

const refusal = (err: unknown): { ok: false; error: string } | null =>
  err instanceof CheckoutRefused || err instanceof GatewayError || err instanceof ProformaRefused || err instanceof PackRefused ? { ok: false, error: err.message } : null;

type Iso<T> = T extends Date ? string : T extends object ? { [K in keyof T]: Iso<T[K]> } : T;
const iso = (standing: Standing): Iso<Standing> => JSON.parse(JSON.stringify(standing)) as Iso<Standing>;

export type BillingView = {
  standing: Iso<Standing>;
  held: boolean;
  gateway: "STRIPE" | "RAZORPAY";
  currency: string;
  subscriptions: {
    id: string;
    gateway: string;
    status: string;
    plans: { key: string; name: string; quantity: number }[];
    currentPeriodEnd: string | null;
    trialEndsAt: string | null;
    cancelAtPeriodEnd: boolean;
    interval: string | null;
    /** A change from the next renewal, authorised and waiting to start then. */
    startsAt: string | null;
  }[];
  /** Razorpay pages to authorise — and, for a change from the next renewal, the day it starts. */
  authorisations: { id: string; plan: string; url: string | null; startsAt: string | null }[];
  /** In India: whether a proforma can be asked for (src/lib/billing/proforma.ts), and the latest asked for. */
  bankTransfer: boolean;
  proformas: { id: string; number: string; status: string; total: number; validUntil: string; expired: boolean; url: string }[];
  invoices: {
    id: string;
    number: string | null;
    status: string;
    currency: string;
    total: number;
    issuedAt: string;
    hostedUrl: string | null;
    pdfUrl: string | null;
    /** Its GST tax invoice and credit notes, by their private links (src/lib/billing/tax-invoice.ts). */
    taxNumber: string | null;
    taxUrl: string | null;
    creditNotes: { number: string; url: string }[];
  }[];
  usage: { seatsUsed: number; seatsLimit: number | null };
  /**
   * Deskzo AI credits (src/lib/ai): this month's, in thousandths — `allowance` null is no limit — the
   * packs with credits left, and the packs on sale here.
   */
  aiCredits: {
    metered: boolean;
    allowance: number | null;
    allowanceUsed: number;
    available: number | null;
    renewsAt: string;
    packs: { credits: number; remaining: number; expiresAt: string; source: string }[];
    offer: { open: boolean; reason: string | null; packs: { key: string; credits: number; amount: number; total: number }[] };
  };
  offer: OfferPlan[];
  canManageAtStripe: boolean;
  billingEmail: string | null;
  taxId: string | null;
  /** Who its tax invoices are made out to: the registered name, address and GST state code. */
  billingName: string | null;
  billingAddress: string | null;
  billingState: string | null;
};

export async function getBilling(): Promise<BillingView | null> {
  const a = await manager();
  if (!a.ok) return null;
  const tenant = await currentTenant();
  const control = controlDb();
  const [row, standing, subs, invoices, offer, pending, seatsUsed, credits, packs] = await Promise.all([
    control.tenant.findUniqueOrThrow({ where: { id: tenant.id }, select: { status: true, suspendedFor: true, billingEmail: true, taxId: true, billingName: true, billingAddress: true, billingState: true, stripeCustomerId: true } }),
    billingStanding(tenant.id),
    control.subscription.findMany({
      where: { tenantId: tenant.id, status: { not: "CANCELLED" } },
      orderBy: { createdAt: "asc" },
      include: { items: { include: { plan: { select: { key: true, name: true } } } } },
    }),
    control.invoice.findMany({ where: { tenantId: tenant.id }, orderBy: { issuedAt: "desc" }, take: 24, include: { creditNotes: { orderBy: { issuedAt: "asc" }, select: { id: true, number: true } } } }),
    offerFor(tenant.id),
    pendingAuthorisations(tenant.id),
    seatsInUse(),
    creditStanding(tenant),
    packOffer(tenant),
  ]);
  const india = tenant.country === "IN";
  const [bankTransfer, proformas] = india ? await Promise.all([bankTransferOpen(), proformasOf(tenant.id, { take: 5 })]) : [false, []];
  // Where each Razorpay page is, asked of Razorpay — only for those still waiting.
  const authorisations = await Promise.all(
    pending.map(async (p) => ({ id: p.id, plan: p.plan, startsAt: p.startsAt?.toISOString() ?? null, url: (await getRazorpaySubscription(p.externalId).catch(() => null))?.short_url ?? null })),
  );
  return {
    standing: iso(standing),
    held: row.status === "SUSPENDED" && row.suspendedFor === "BILLING",
    gateway: offer.gateway,
    currency: offer.currency,
    subscriptions: subs
      .filter((s) => s.status !== "INCOMPLETE")
      .map((s) => ({
        id: s.id,
        gateway: s.gateway,
        status: s.status,
        plans: s.items.map((i) => ({ key: i.plan.key, name: i.plan.name, quantity: i.quantity })),
        currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
        trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        interval: s.interval,
        startsAt: s.startsAt && s.startsAt > new Date() ? s.startsAt.toISOString() : null,
      })),
    authorisations,
    bankTransfer,
    proformas: proformas.map((p) => ({ id: p.id, number: p.number, status: p.status, total: p.total, validUntil: p.validUntil.toISOString(), expired: p.expired, url: p.url })),
    invoices: invoices.map((i) => ({
      id: i.id,
      number: i.number,
      status: i.status,
      currency: i.currency,
      total: i.total,
      issuedAt: i.issuedAt.toISOString(),
      hostedUrl: i.hostedUrl,
      pdfUrl: i.pdfUrl,
      taxNumber: i.taxNumber,
      taxUrl: i.taxNumber ? documentUrl("i", i.id) : null,
      creditNotes: i.creditNotes.map((c) => ({ number: c.number, url: documentUrl("c", c.id) })),
    })),
    usage: { seatsUsed, seatsLimit: tenant.entitlements.seats },
    aiCredits: {
      metered: credits.metered,
      allowance: credits.allowance,
      allowanceUsed: credits.allowanceUsed,
      available: credits.available,
      renewsAt: credits.renewsAt.toISOString(),
      packs: credits.packs.map((p) => ({ credits: p.credits, remaining: p.remaining, expiresAt: p.expiresAt.toISOString(), source: p.source })),
      offer: packs,
    },
    offer: offer.plans,
    canManageAtStripe: !!row.stripeCustomerId,
    billingEmail: row.billingEmail,
    taxId: row.taxId,
    billingName: row.billingName,
    billingAddress: row.billingAddress,
    billingState: row.billingState,
  };
}

/** For the banner above every page: the reminder, to whoever manages billing, while a trial or a grace period runs. */
export async function billingNotice(): Promise<{ tone: "info" | "warning"; text: string } | null> {
  const a = await manager().catch(() => null);
  if (!a?.ok) return null;
  const standing = await billingStanding((await currentTenant()).id);
  const days = (d: string | Date) => Math.max(0, Math.ceil((new Date(d).getTime() - Date.now()) / 86_400_000));
  switch (standing.kind) {
    case "trial":
      return days(standing.endsAt) <= 7 ? { tone: "info", text: `Your free trial ends in ${days(standing.endsAt)} day(s). Choose a plan to keep everything as it is.` } : null;
    case "trial-over":
      return { tone: "warning", text: `Your trial has ended. The workspace will be held in ${days(standing.holdAt)} day(s) unless a plan is chosen.` };
    case "past-due":
      return { tone: "warning", text: `A payment has failed. The workspace will be held in ${days(standing.holdAt)} day(s) unless it is paid.` };
    case "ending":
      return days(standing.holdAt) <= 14 ? { tone: "info", text: `Your subscription ends in ${days(standing.holdAt)} day(s) and will not renew.` } : null;
    case "paid":
      // Paid offline: it doesn't renew by itself — the next period is paid the same way.
      return standing.renewBy && days(standing.renewBy) <= 14 ? { tone: "info", text: `Your plan is paid until ${new Date(standing.renewBy).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}. Pay the next period by bank transfer as before to carry on.` } : null;
    default:
      return null;
  }
}

export async function checkoutPlan(selection: Selection): Promise<ActionResult<CheckoutStart>> {
  const a = await manager();
  if (!a.ok) return a;
  const tenant = await currentTenant();
  try {
    const started = await startCheckout(tenant.id, selection, `${await tenantOrigin()}/settings/billing`, { seatsInUse: await seatsInUse() });
    await recordAudit({ userId: a.me.id, action: "CREATE", entityType: "Subscription", entityId: tenant.id, entityLabel: `Checkout started: ${(selection.items ?? []).map((i) => i.planKey).join(", ")}` });
    return { ok: true, data: started };
  } catch (err) {
    const r = refusal(err);
    if (r) return r;
    throw err;
  }
}

/** A Deskzo AI credit pack (src/lib/ai/packs.ts): the page to pay on, in India through Razorpay. */
export async function buyCreditPack(packKey: string): Promise<ActionResult<{ url: string }>> {
  const a = await manager();
  if (!a.ok) return a;
  const tenant = await currentTenant();
  try {
    const started = await startPackCheckout(tenant.id, String(packKey ?? ""), `${await tenantOrigin()}/settings/billing?credits=done#ai-credits`);
    await recordAudit({ userId: a.me.id, action: "CREATE", entityType: "AiCreditPack", entityId: tenant.id, entityLabel: `Credit pack checkout started: ${String(packKey)}` });
    return { ok: true, data: started };
  } catch (err) {
    const r = refusal(err);
    if (r) return r;
    throw err;
  }
}

export async function openBillingPortal(): Promise<ActionResult<{ url: string }>> {
  const a = await manager();
  if (!a.ok) return a;
  try {
    return { ok: true, data: { url: await billingPortal((await currentTenant()).id, `${await tenantOrigin()}/settings/billing`) } };
  } catch (err) {
    const r = refusal(err);
    if (r) return r;
    throw err;
  }
}

/**
 * Paying through Razorpay: the plans or people from the next renewal (src/lib/billing/checkout.ts
 * `scheduleRazorpayChange`) — authorised now on Razorpay's pages, charged and switched on from then.
 */
export async function changePlanAtRenewal(selection: Selection): Promise<ActionResult<{ startsAt: string; authorisations: { plan: string; url: string }[] }>> {
  const a = await manager();
  if (!a.ok) return a;
  const tenant = await currentTenant();
  try {
    const change = await scheduleRazorpayChange(tenant.id, selection, { seatsInUse: await seatsInUse() });
    await recordAudit({ userId: a.me.id, action: "UPDATE", entityType: "Subscription", entityId: tenant.id, entityLabel: `Plan change from ${change.startsAt.toISOString().slice(0, 10)}: ${(selection.items ?? []).map((i) => `${i.planKey}×${i.quantity}`).join(", ")}` });
    revalidatePath("/settings/billing");
    return { ok: true, data: { startsAt: change.startsAt.toISOString(), authorisations: change.authorisations } };
  } catch (err) {
    const r = refusal(err);
    if (r) return r;
    throw err;
  }
}

/**
 * Paying by bank transfer, in India: a proforma for the plans, people and months chosen, mailed to the
 * billing address and whoever asked (src/lib/billing/proforma.ts). Staff record the transfer against it.
 */
export async function askForProforma(input: Selection & { periods: number }): Promise<ActionResult<{ number: string; url: string; total: number; validUntil: string }>> {
  const a = await manager();
  if (!a.ok) return a;
  const tenant = await currentTenant();
  try {
    const made = await requestProforma({
      tenantId: tenant.id,
      items: (input?.items ?? []).slice(0, 20).map((i) => ({ planKey: String(i.planKey), quantity: Number(i.quantity) })),
      interval: input?.interval === "YEAR" ? "YEAR" : "MONTH",
      periods: Number(input?.periods),
      requestedBy: { name: a.me.name, email: a.me.email },
      seatsInUse: await seatsInUse(),
    });
    await recordAudit({ userId: a.me.id, action: "CREATE", entityType: "Proforma", entityId: made.id, entityLabel: `Proforma ${made.number}` });
    revalidatePath("/settings/billing");
    return { ok: true, data: { number: made.number, url: made.url, total: made.total, validUntil: made.validUntil.toISOString() } };
  } catch (err) {
    const r = refusal(err);
    if (r) return r;
    throw err;
  }
}

export async function cancelSubscription(subscriptionId: string): Promise<ActionResult<null>> {
  const a = await manager();
  if (!a.ok) return a;
  const tenant = await currentTenant();
  try {
    await cancelAtPeriodEnd(tenant.id, String(subscriptionId));
  } catch (err) {
    const r = refusal(err);
    if (r) return r;
    throw err;
  }
  await recordAudit({ userId: a.me.id, action: "UPDATE", entityType: "Subscription", entityId: String(subscriptionId), entityLabel: "Cancelled at the end of the period" });
  await applyStanding(tenant.id);
  revalidatePath("/settings/billing");
  return { ok: true, data: null };
}

export async function saveBillingDetails(input: { billingEmail: string; taxId: string; billingName?: string; billingAddress?: string; billingState?: string }): Promise<ActionResult<null>> {
  const a = await manager();
  if (!a.ok) return a;
  const email = String(input?.billingEmail ?? "").trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "That doesn't look like an email address." };
  const taxId = String(input?.taxId ?? "").trim().toUpperCase().slice(0, 40);
  // Who its tax invoices are made out to; a form without them leaves them as they are.
  const named = input?.billingName === undefined ? {} : { billingName: String(input.billingName ?? "").trim().slice(0, 200) || null };
  const addressed = input?.billingAddress === undefined ? {} : { billingAddress: String(input.billingAddress ?? "").replace(/\r\n?/g, "\n").trim().slice(0, 500) || null };
  const state = input?.billingState === undefined ? undefined : String(input.billingState ?? "").trim();
  if (state && !GST_STATE_CODES[state]) return { ok: false, error: "Choose the state from the list." };
  const stated = state === undefined ? {} : { billingState: state || null };
  await controlDb().tenant.update({ where: { id: (await currentTenant()).id }, data: { billingEmail: email || null, taxId: taxId || null, ...named, ...addressed, ...stated } });
  await recordAudit({ userId: a.me.id, action: "UPDATE", entityType: "BillingDetails", entityId: (await currentTenant()).id, entityLabel: "Billing email and tax number" });
  revalidatePath("/settings/billing");
  return { ok: true, data: null };
}
