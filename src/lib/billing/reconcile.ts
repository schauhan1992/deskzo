import type { SubscriptionStatus } from "@wroffy/control-client";
import { applyStanding } from "@/lib/billing/lifecycle";
import { getRazorpaySubscription } from "@/lib/billing/razorpay";
import { getStripeSubscription } from "@/lib/billing/stripe";
import { applyRazorpaySubscription, applyStripeSubscription } from "@/lib/billing/sync";
import { usedThisMonth, usageDay } from "@/lib/copilot/settings";
import { controlDb } from "@/lib/platform/control-db";
import { forEachTenant } from "@/lib/platform/fanout";
import { ConsoleRefused } from "@/lib/platform/refused";
import { seatsInUse } from "@/lib/seats";
import { activeTenants } from "@/lib/tenancy/registry";

/**
 * The platform tick's daily chores (/api/platform/tick).
 *
 *   · Reconcile: every subscription at a gateway read back and written again, so a webhook that
 *     never arrived is made good within a day. One that was read in the last twenty hours is left.
 *   · Usage: each open workspace's people with an account and copilot tokens this month, a row a day
 *     — what the console shows beside its limits.
 *
 * And one subscription at a time, when staff ask from the console (`resyncSubscription`).
 */

const FRESH_MS = 20 * 60 * 60_000;

export async function reconcileSubscriptions(now = new Date()): Promise<{ read: number; failed: string[] }> {
  const subs = await controlDb().subscription.findMany({
    where: { gateway: { not: "MANUAL" }, externalId: { not: null }, status: { not: "CANCELLED" }, OR: [{ syncedAt: null }, { syncedAt: { lt: new Date(now.getTime() - FRESH_MS) } }] },
    select: { gateway: true, externalId: true },
  });
  const failed: string[] = [];
  for (const s of subs) {
    try {
      if (s.gateway === "STRIPE") await applyStripeSubscription(await getStripeSubscription(s.externalId!), now);
      else await applyRazorpaySubscription(await getRazorpaySubscription(s.externalId!), now);
    } catch (err) {
      failed.push(`${s.externalId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { read: subs.length - failed.length, failed };
}

/**
 * One subscription read back from its gateway now — the reconcile for a single row, fresh or not —
 * and its workspace's standing applied, so a payment the webhooks missed lifts a hold at once.
 * A gateway that says no, or cannot be reached, is thrown on as it is.
 */
export async function resyncSubscription(
  subscriptionId: string,
  now = new Date(),
): Promise<{ tenantId: string; gateway: "STRIPE" | "RAZORPAY"; externalId: string; before: SubscriptionStatus; after: SubscriptionStatus }> {
  const control = controlDb();
  const sub = await control.subscription.findUnique({ where: { id: subscriptionId }, select: { tenantId: true, gateway: true, externalId: true, status: true } });
  if (!sub) throw new ConsoleRefused("That subscription no longer exists.");
  const { tenantId, gateway, externalId, status: before } = sub;
  if (gateway === "MANUAL") throw new ConsoleRefused("A plan given by hand is not at a gateway, so there is nothing to read back.");
  if (!externalId) throw new ConsoleRefused("It was never made at the gateway, so there is nothing to read back.");

  if (gateway === "STRIPE") await applyStripeSubscription(await getStripeSubscription(externalId), now);
  else await applyRazorpaySubscription(await getRazorpaySubscription(externalId), now);
  await applyStanding(tenantId, now);
  const { status: after } = await control.subscription.findUniqueOrThrow({ where: { id: subscriptionId }, select: { status: true } });
  return { tenantId, gateway, externalId, before, after };
}

export async function snapshotUsage(now = new Date()) {
  const day = usageDay(now);
  return forEachTenant(
    "usage-snapshot",
    // Workspaces in the control plane: one from the environment has no row to record against.
    (await activeTenants()).filter((t) => t.source === "control"),
    async (tenant) => {
      const [seatsUsed, copilotTokens] = await Promise.all([seatsInUse(), usedThisMonth(now)]);
      const row = { seatsUsed, seatsLimit: tenant.entitlements.seats, copilotTokens, recordedAt: now };
      await controlDb().tenantUsage.upsert({ where: { tenantId_day: { tenantId: tenant.id, day } }, create: { tenantId: tenant.id, day, ...row }, update: row });
      return { seatsUsed, copilotTokens };
    },
    { concurrency: 4, timeoutMs: 60_000 },
  );
}
