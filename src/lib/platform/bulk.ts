import { billingStandings, plannedAction, type Standing } from "@/lib/billing/lifecycle";
import type { StandingKind } from "@/lib/console-shared/types";
import { consoleClock } from "@/lib/platform/console-clock";
import { controlDb } from "@/lib/platform/control-db";
import { PLAN_REFUSALS, liveGatewaySubscription } from "@/lib/platform/plans";
import { autoDeprovision } from "@/lib/platform/settings";
import type { Clock } from "@/lib/time/zone";

/**
 * What a bulk action from the workspace directory would do, before it does it — shown in its
 * confirmation, and worked out again by the action itself so a stale confirmation is refused rather
 * than acted on (src/actions/platform/console-directory.ts).
 *
 * Each preview decides with the function the action runs: `plannedAction` is what `applyStanding`
 * does, and a trial's new end is `trialEndAfter`, checked against `setTrialEnd`'s own refusals. Nothing
 * here writes. Ids that no longer name a workspace are left out of a preview.
 *
 * (Bulk migration is not offered: a migration runs from its own page, one workspace or all of them.)
 */

export { BULK_CAPS } from "@/lib/platform/console-guard";

/** How far a trial is extended at a time — from the console's +7 / +14 / +30. */
export const EXTEND_DAYS = [7, 14, 30] as const;
export type ExtendDays = (typeof EXTEND_DAYS)[number];

/** `days` when it is one of the lengths a trial is extended by, else null. */
export function extendDays(days: unknown): ExtendDays | null {
  const n = typeof days === "number" ? days : typeof days === "string" && days.trim() ? Number(days) : NaN;
  return (EXTEND_DAYS as readonly number[]).includes(n) ? (n as ExtendDays) : null;
}

/**
 * The last second on `clock` of the day `days` after `base`'s — 23:59:59 there, the same end a trial
 * set by date gets (`consoleSetTrialEnd`). Counted in calendar days, so a clock change on the way
 * moves no end. From the console, the console's clock: the day staff see is the day it ends.
 */
export function trialEndAfter(base: Date, days: number, clock: Clock): Date {
  const { year, month, day } = clock.parts(base);
  return new Date(clock.midnight(year, month, day + days + 1).getTime() - 1000);
}

const unique = (ids: string[]) => [...new Set(ids)];

// ─── Apply billing rules ─────────────────────────────────────────────────────────────────────────

export type ApplyStandingPreview = {
  items: {
    tenantId: string;
    slug: string;
    standing: StandingKind;
    planned: "none" | "held" | "lifted" | "closed";
    /** A reminder falls due by date (one already sent is not sent again). */
    remind: boolean;
    /** The installation's own workspace: billing never touches it, and the batch passes over it. */
    skipped?: "default";
  }[];
  counts: { held: number; lifted: number; closed: number };
};

/** What applying each workspace's billing standing would do now: hold it, lift its hold, close it, or nothing. */
export async function previewApplyStanding(ids: string[], now = new Date()): Promise<ApplyStandingPreview> {
  const wanted = unique(ids);
  const counts = { held: 0, lifted: 0, closed: 0 };
  if (!wanted.length) return { items: [], counts };
  const [tenants, standings, autoClose] = await Promise.all([
    controlDb().tenant.findMany({
      where: { id: { in: wanted } },
      select: { id: true, slug: true, status: true, suspendedFor: true, suspendedAt: true, isDefault: true },
    }),
    billingStandings(wanted, now),
    autoDeprovision(),
  ]);
  const byId = new Map(tenants.map((t) => [t.id, t]));
  const items: ApplyStandingPreview["items"] = [];
  for (const id of wanted) {
    const t = byId.get(id);
    if (!t) continue;
    const standing: Standing = standings.get(id) ?? { kind: "none" };
    if (t.isDefault) {
      items.push({ tenantId: t.id, slug: t.slug, standing: standing.kind, planned: "none", remind: false, skipped: "default" });
      continue;
    }
    const plan = plannedAction(t, standing, now, autoClose);
    if (plan.action !== "none") counts[plan.action] += 1;
    items.push({ tenantId: t.id, slug: t.slug, standing: standing.kind, planned: plan.action, remind: plan.remind !== null });
  }
  return { items, counts };
}

// ─── Extend trials ───────────────────────────────────────────────────────────────────────────────

export type ExtendTrialPreview = {
  days: ExtendDays;
  items: {
    tenantId: string;
    slug: string;
    eligible: boolean;
    /** Why not, in the words the change itself would refuse with. */
    why?: string;
    /** Its trial's end now (past, for a trial that has ended); null without a trial. */
    from: Date | null;
    /** The new end, when eligible. */
    to: Date | null;
    /** It is held for billing, and extending reopens it. */
    liftsHold: boolean;
  }[];
};

/**
 * Each workspace's trial extended by `days` from its end — or from now, for a trial that has already
 * ended. The trial is the one `setTrialEnd` changes: the newest manual subscription with a trial end,
 * running or ended. Not for a closed workspace, one without a trial, or one paying at a gateway.
 */
export async function previewExtendTrial(ids: string[], days: ExtendDays, now = new Date()): Promise<ExtendTrialPreview> {
  const wanted = unique(ids);
  if (!wanted.length) return { days, items: [] };
  const control = controlDb();
  const [tenants, trials, clock] = await Promise.all([
    control.tenant.findMany({ where: { id: { in: wanted } }, select: { id: true, slug: true, status: true, suspendedFor: true } }),
    control.subscription.findMany({
      where: { tenantId: { in: wanted }, gateway: "MANUAL", status: { in: ["TRIALING", "CANCELLED"] }, trialEndsAt: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { tenantId: true, trialEndsAt: true },
    }),
    consoleClock(),
  ]);
  // The guard `setTrialEnd` applies, asked the same way — at most a batch's worth of workspaces.
  const gateways = new Map(await Promise.all(tenants.map(async (t) => [t.id, await liveGatewaySubscription(t.id, now)] as const)));
  const trialEnd = new Map<string, Date>();
  for (const s of trials) if (s.trialEndsAt && !trialEnd.has(s.tenantId)) trialEnd.set(s.tenantId, s.trialEndsAt);

  const byId = new Map(tenants.map((t) => [t.id, t]));
  const items: ExtendTrialPreview["items"] = [];
  for (const id of wanted) {
    const t = byId.get(id);
    if (!t) continue;
    const from = trialEnd.get(id) ?? null;
    const gateway = gateways.get(id) ?? null;
    const why =
      t.status === "DEPROVISIONED" ? PLAN_REFUSALS.closed : gateway ? PLAN_REFUSALS.trialWhilePaying(gateway) : !from ? "This workspace has no trial." : undefined;
    if (why || !from) {
      items.push({ tenantId: t.id, slug: t.slug, eligible: false, why: why ?? "This workspace has no trial.", from, to: null, liftsHold: false });
      continue;
    }
    items.push({
      tenantId: t.id,
      slug: t.slug,
      eligible: true,
      from,
      to: trialEndAfter(new Date(Math.max(now.getTime(), from.getTime())), days, clock),
      liftsHold: t.status === "SUSPENDED" && t.suspendedFor === "BILLING",
    });
  }
  return { days, items };
}
