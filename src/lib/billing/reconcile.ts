import { getRazorpaySubscription } from "@/lib/billing/razorpay";
import { getStripeSubscription } from "@/lib/billing/stripe";
import { applyRazorpaySubscription, applyStripeSubscription } from "@/lib/billing/sync";
import { usedThisMonth, usageDay } from "@/lib/copilot/settings";
import { controlDb } from "@/lib/platform/control-db";
import { forEachTenant } from "@/lib/platform/fanout";
import { seatsInUse } from "@/lib/seats";
import { activeTenants } from "@/lib/tenancy/registry";

/**
 * The platform tick's daily chores (/api/platform/tick).
 *
 *   · Reconcile: every subscription at a gateway read back and written again, so a webhook that
 *     never arrived is made good within a day. One that was read in the last twenty hours is left.
 *   · Usage: each open workspace's people with an account and copilot tokens this month, a row a day
 *     — what the console shows beside its limits.
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
