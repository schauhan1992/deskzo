import type { SubscriptionStatus } from "@wroffy/control-client";
import { TRIAL_GRACE_DAYS } from "@/lib/billing/lifecycle";
import { noticeLabel } from "@/lib/console-shared/labels";
import type { TrialView } from "@/lib/console-shared/params";
import type { SubscriptionStatusKey, TenantStatusKey } from "@/lib/console-shared/types";
import { controlDb } from "@/lib/platform/control-db";
import { LIVE_STATUSES } from "@/lib/platform/entitlements";
import { trialDays } from "@/lib/platform/settings";
import { latestUsage } from "@/lib/platform/usage";

/**
 * The trials board (/trials): every workspace on a free trial — running, just ended and in its
 * grace days, or held because it ended — with the reminders billing has sent it.
 *
 * A trial here is a manual subscription with a trial end (src/lib/billing/lifecycle.ts): running
 * (TRIALING), or ended by the hold in the last three weeks (CANCELLED). A workspace paying at a
 * gateway is left out — its trial, if any, is the gateway's. Read from the control plane only.
 */

export type TrialBucket = "3d" | "7d" | "later" | "grace" | "held";

export type TrialRow = {
  tenant: { id: string; slug: string; name: string; country: string; ownerEmail: string | null; status: TenantStatusKey; suspendedFor: "STAFF" | "BILLING" | null };
  subscriptionStatus: SubscriptionStatusKey;
  trialEndsAt: Date;
  /** Whole days until it ends, rounded up; 0 or less once it has ended. */
  daysLeft: number;
  /** When billing holds it unless a plan is bought: the end plus the grace days. Null once it is held for billing. */
  holdAt: Date | null;
  bucket: TrialBucket;
  /** The names of the plans it is trying. */
  plans: string[];
  /**
   * Trial reminders sent, oldest first. `step` (7, 3 or 1 days before) is set for the reminders
   * about the trial's current end — an extended trial keeps the ones about its old end, without a step.
   */
  reminders: { key: string; sentAt: Date; label: string; step: 7 | 3 | 1 | null }[];
  /** People using it at the latest daily snapshot. */
  seatsUsed: number | null;
};

export type TrialsBoard = {
  asOf: Date;
  /** How long a new trial lasts (settings). */
  trialDays: number;
  graceDays: number;
  /** Rows in each bucket, and `active`: trials still running (3d + 7d + later). */
  counts: Record<TrialBucket, number> & { active: number };
  /** Soonest end first. */
  rows: TrialRow[];
};

const DAY = 86_400_000;
/** A trial the hold ended stays on the board this long. */
const ENDED_WITHIN_DAYS = 21;
const CHUNK = 1_000;
const LIVE: SubscriptionStatus[] = [...LIVE_STATUSES];

function bucketOf(t: { status: TenantStatusKey; suspendedFor: "STAFF" | "BILLING" | null }, daysLeft: number, ended: boolean): TrialBucket {
  if (t.status === "SUSPENDED" && t.suspendedFor === "BILLING") return "held";
  if (ended) return "grace";
  if (daysLeft <= 3) return "3d";
  if (daysLeft <= 7) return "7d";
  return "later";
}

/** "trial:2026-10-01:3" → its date and step; null for a key of another shape. */
function reminderParts(key: string): { day: string; step: number } | null {
  const match = /^trial:(\d{4}-\d{2}-\d{2}):(\d{1,3})$/.exec(key);
  return match ? { day: match[1], step: Number(match[2]) } : null;
}

export async function trialsBoard(now = new Date()): Promise<TrialsBoard> {
  const control = controlDb();
  const [subs, days] = await Promise.all([
    control.subscription.findMany({
      where: {
        gateway: "MANUAL",
        trialEndsAt: { not: null },
        OR: [{ status: "TRIALING" }, { status: "CANCELLED", cancelledAt: { gte: new Date(now.getTime() - ENDED_WITHIN_DAYS * DAY) } }],
        tenant: {
          status: { in: ["ACTIVE", "SUSPENDED"] },
          subscriptions: { none: { gateway: { in: ["STRIPE", "RAZORPAY"] }, status: { in: LIVE } } },
        },
      },
      orderBy: { trialEndsAt: "asc" },
      select: {
        trialEndsAt: true,
        status: true,
        items: { select: { plan: { select: { name: true } } } },
        tenant: { select: { id: true, slug: true, name: true, country: true, ownerEmail: true, status: true, suspendedFor: true } },
      },
    }),
    trialDays(),
  ]);

  // One row a workspace: its running trial, or else the latest one to have ended.
  const chosen = new Map<string, (typeof subs)[number]>();
  for (const s of subs) {
    const had = chosen.get(s.tenant.id);
    if (!had || (had.status !== "TRIALING" && (s.status === "TRIALING" || s.trialEndsAt! > had.trialEndsAt!))) chosen.set(s.tenant.id, s);
  }
  const picked = [...chosen.values()].sort((a, b) => a.trialEndsAt!.getTime() - b.trialEndsAt!.getTime() || a.tenant.slug.localeCompare(b.tenant.slug));
  const ids = picked.map((s) => s.tenant.id);

  const notices: { tenantId: string; key: string; sentAt: Date }[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    notices.push(
      ...(await control.billingNotice.findMany({
        where: { tenantId: { in: ids.slice(i, i + CHUNK) }, key: { startsWith: "trial:" } },
        orderBy: { sentAt: "asc" },
        select: { tenantId: true, key: true, sentAt: true },
      })),
    );
  }
  const noticesOf = new Map<string, typeof notices>();
  for (const n of notices) {
    const list = noticesOf.get(n.tenantId);
    if (list) list.push(n);
    else noticesOf.set(n.tenantId, [n]);
  }
  const usage = await latestUsage(ids);

  const counts: TrialsBoard["counts"] = { "3d": 0, "7d": 0, later: 0, grace: 0, held: 0, active: 0 };
  const rows = picked.map((s): TrialRow => {
    const end = s.trialEndsAt!;
    const t = s.tenant;
    const daysLeft = Math.ceil((end.getTime() - now.getTime()) / DAY) || 0;
    const bucket = bucketOf(t, daysLeft, end <= now);
    counts[bucket] += 1;
    if (bucket === "3d" || bucket === "7d" || bucket === "later") counts.active += 1;
    // A reminder's key carries the end's UTC date, as billing writes it (noticeKey in lifecycle.ts).
    const endDay = end.toISOString().slice(0, 10);
    return {
      tenant: { id: t.id, slug: t.slug, name: t.name, country: t.country, ownerEmail: t.ownerEmail, status: t.status, suspendedFor: t.suspendedFor },
      subscriptionStatus: s.status,
      trialEndsAt: end,
      daysLeft,
      holdAt: bucket === "held" ? null : new Date(end.getTime() + TRIAL_GRACE_DAYS * DAY),
      bucket,
      plans: [...new Set(s.items.map((i) => i.plan.name))],
      reminders: (noticesOf.get(t.id) ?? []).map((n) => {
        const parts = reminderParts(n.key);
        const step = parts && parts.day === endDay && (parts.step === 7 || parts.step === 3 || parts.step === 1) ? parts.step : null;
        return { key: n.key, sentAt: n.sentAt, label: noticeLabel(n.key), step };
      }),
      seatsUsed: usage.get(t.id)?.seatsUsed ?? null,
    };
  });

  return { asOf: now, trialDays: days, graceDays: TRIAL_GRACE_DAYS, counts, rows };
}

/** The rows a view of the board shows: "ending" is the 3-day and 7-day buckets together. */
export function trialRowsFor(board: TrialsBoard, view: TrialView): TrialRow[] {
  switch (view) {
    case "ending":
      return board.rows.filter((r) => r.bucket === "3d" || r.bucket === "7d");
    case "later":
    case "grace":
    case "held":
      return board.rows.filter((r) => r.bucket === view);
    default:
      return board.rows;
  }
}
