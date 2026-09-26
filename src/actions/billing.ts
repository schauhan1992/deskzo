"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser, viewAsContext } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { GatewayError } from "@/lib/billing/gateway";
import { billingStanding, applyStanding, type Standing } from "@/lib/billing/lifecycle";
import { CheckoutRefused, billingPortal, cancelAtPeriodEnd, offerFor, pendingAuthorisations, startCheckout, type CheckoutStart, type OfferPlan, type Selection } from "@/lib/billing/checkout";
import { getRazorpaySubscription } from "@/lib/billing/razorpay";
import { usedThisMonth } from "@/lib/copilot/settings";
import { controlDb } from "@/lib/platform/control-db";
import { seatsInUse } from "@/lib/seats";
import { currentTenant, tenantOrigin } from "@/lib/tenancy/resolve";
import type { ActionResult } from "@/actions/company";

/**
 * The workspace's plan and billing (Settings → Plan & billing) — its super admin's alone: choosing a
 * plan, paying for it, cancelling it. Not while "viewing as" somebody. Everything here acts on the
 * control plane and the gateways (src/lib/billing), for this workspace only.
 */

async function owner(): Promise<{ ok: true; me: { id: string; name: string } } | { ok: false; error: string }> {
  const user = await requireUser();
  if (await viewAsContext()) return { ok: false, error: "Switch back to your own account first." };
  const me = await db.user.findUnique({ where: { id: user.id }, select: { id: true, name: true, isSuperAdmin: true, kind: true } });
  if (!me || !me.isSuperAdmin || me.kind !== "MEMBER") return { ok: false, error: "Only the workspace owner manages its plan and billing." };
  return { ok: true, me: { id: me.id, name: me.name } };
}

const refusal = (err: unknown): { ok: false; error: string } | null =>
  err instanceof CheckoutRefused || err instanceof GatewayError ? { ok: false, error: err.message } : null;

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
    plans: { name: string; quantity: number }[];
    currentPeriodEnd: string | null;
    trialEndsAt: string | null;
    cancelAtPeriodEnd: boolean;
    interval: string | null;
  }[];
  authorisations: { id: string; plan: string; url: string | null }[];
  invoices: { id: string; number: string | null; status: string; currency: string; total: number; issuedAt: string; hostedUrl: string | null; pdfUrl: string | null }[];
  usage: { seatsUsed: number; seatsLimit: number | null; copilotUsed: number; copilotLimit: number | null };
  offer: OfferPlan[];
  canManageAtStripe: boolean;
  billingEmail: string | null;
  taxId: string | null;
};

export async function getBilling(): Promise<BillingView | null> {
  const a = await owner();
  if (!a.ok) return null;
  const tenant = await currentTenant();
  const control = controlDb();
  const [row, standing, subs, invoices, offer, pending, seatsUsed, copilotUsed] = await Promise.all([
    control.tenant.findUniqueOrThrow({ where: { id: tenant.id }, select: { status: true, suspendedFor: true, billingEmail: true, taxId: true, stripeCustomerId: true } }),
    billingStanding(tenant.id),
    control.subscription.findMany({
      where: { tenantId: tenant.id, status: { not: "CANCELLED" } },
      orderBy: { createdAt: "asc" },
      include: { items: { include: { plan: { select: { name: true } } } } },
    }),
    control.invoice.findMany({ where: { tenantId: tenant.id }, orderBy: { issuedAt: "desc" }, take: 24 }),
    offerFor(tenant.id),
    pendingAuthorisations(tenant.id),
    seatsInUse(),
    usedThisMonth(),
  ]);
  // Where each Razorpay page is, asked of Razorpay — only for those still waiting.
  const authorisations = await Promise.all(
    pending.map(async (p) => ({ id: p.id, plan: p.plan, url: (await getRazorpaySubscription(p.externalId).catch(() => null))?.short_url ?? null })),
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
        plans: s.items.map((i) => ({ name: i.plan.name, quantity: i.quantity })),
        currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
        trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        interval: s.interval,
      })),
    authorisations,
    invoices: invoices.map((i) => ({ id: i.id, number: i.number, status: i.status, currency: i.currency, total: i.total, issuedAt: i.issuedAt.toISOString(), hostedUrl: i.hostedUrl, pdfUrl: i.pdfUrl })),
    usage: { seatsUsed, seatsLimit: tenant.entitlements.seats, copilotUsed, copilotLimit: tenant.entitlements.copilotTokens },
    offer: offer.plans,
    canManageAtStripe: !!row.stripeCustomerId,
    billingEmail: row.billingEmail,
    taxId: row.taxId,
  };
}

/** For the banner above every page: the owner's reminder while a trial or a grace period runs. */
export async function billingNotice(): Promise<{ tone: "info" | "warning"; text: string } | null> {
  const a = await owner().catch(() => null);
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
    default:
      return null;
  }
}

export async function checkoutPlan(selection: Selection): Promise<ActionResult<CheckoutStart>> {
  const a = await owner();
  if (!a.ok) return a;
  const tenant = await currentTenant();
  try {
    const started = await startCheckout(tenant.id, selection, `${await tenantOrigin()}/settings/billing`);
    await recordAudit({ userId: a.me.id, action: "CREATE", entityType: "Subscription", entityId: tenant.id, entityLabel: `Checkout started: ${(selection.items ?? []).map((i) => i.planKey).join(", ")}` });
    return { ok: true, data: started };
  } catch (err) {
    const r = refusal(err);
    if (r) return r;
    throw err;
  }
}

export async function openBillingPortal(): Promise<ActionResult<{ url: string }>> {
  const a = await owner();
  if (!a.ok) return a;
  try {
    return { ok: true, data: { url: await billingPortal((await currentTenant()).id, `${await tenantOrigin()}/settings/billing`) } };
  } catch (err) {
    const r = refusal(err);
    if (r) return r;
    throw err;
  }
}

export async function cancelSubscription(subscriptionId: string): Promise<ActionResult<null>> {
  const a = await owner();
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

export async function saveBillingDetails(input: { billingEmail: string; taxId: string }): Promise<ActionResult<null>> {
  const a = await owner();
  if (!a.ok) return a;
  const email = String(input?.billingEmail ?? "").trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "That doesn't look like an email address." };
  const taxId = String(input?.taxId ?? "").trim().toUpperCase().slice(0, 40);
  await controlDb().tenant.update({ where: { id: (await currentTenant()).id }, data: { billingEmail: email || null, taxId: taxId || null } });
  await recordAudit({ userId: a.me.id, action: "UPDATE", entityType: "BillingDetails", entityId: (await currentTenant()).id, entityLabel: "Billing email and tax number" });
  revalidatePath("/settings/billing");
  return { ok: true, data: null };
}
