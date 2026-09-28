import type { BillingGateway, Prisma, SubscriptionStatus, SuspendedFor, TenantStatus } from "@wroffy/control-client";
import { controlDb } from "@/lib/platform/control-db";
import { deprovisionTenant, liftBillingHold, suspendTenant } from "@/lib/platform/lifecycle";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { autoDeprovision } from "@/lib/platform/settings";
import { protocolFor } from "@/lib/tenancy/host";
import { subdomainHost } from "@/lib/tenancy/registry";

/**
 * Where each workspace stands with paying, and what follows from it — run by the platform tick
 * (/api/platform/tick) and after every webhook.
 *
 *   · A trial runs its course, then has seven days' grace; then the workspace is held.
 *   · A failed payment has fourteen days' grace while the gateway retries; then it is held.
 *   · A subscription cancelled runs to the end of its period; then the workspace is held — and, if
 *     staff have turned it on, closed ninety days later.
 *   · Paying again lifts a billing hold at once. A staff hold is never lifted by billing.
 *   · Reminders go to its billing address seven, three and one days before any of those ends.
 *
 * The installation's own workspace, and any workspace staff put on a plan by hand, are never touched.
 *
 * The decisions are pure (`standingOf`, `plannedAction`), so the console can preview a run with the
 * very functions that make it (`previewLifecycle`) and never disagree with it.
 */

export const TRIAL_GRACE_DAYS = 7;
export const PAST_DUE_GRACE_DAYS = 14;
export const CLOSE_AFTER_DAYS = 90;
const REMIND_DAYS = [7, 3, 1] as const;
const DAY = 86_400_000;
/** Ids per query when many workspaces are read at once — well inside Postgres's bind limit. */
const CHUNK = 1_000;

export type Standing =
  /** The installation's own, or on a plan staff gave by hand: nothing to collect. */
  | { kind: "exempt" }
  /** A live subscription at a gateway, paid up. */
  | { kind: "paid" }
  | { kind: "trial"; endsAt: Date }
  /** The trial is over; held at `holdAt` unless a plan is bought. */
  | { kind: "trial-over"; holdAt: Date }
  /** A payment failed; held at `holdAt` unless it is paid. */
  | { kind: "past-due"; holdAt: Date }
  /** Cancelled: runs to the end of its period, held then. */
  | { kind: "ending"; holdAt: Date }
  /** Nothing live: it should be held. */
  | { kind: "lapsed"; since: Date }
  /** No subscription at all — made before plans, or by hand without one. Left to staff. */
  | { kind: "none" };

/** What a standing is worked out from: each of the workspace's subscriptions, as these fields. */
export type StandingSub = {
  gateway: BillingGateway;
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  pastDueSince: Date | null;
  cancelledAt: Date | null;
};

const STANDING_SUB_SELECT = {
  gateway: true,
  status: true,
  trialEndsAt: true,
  currentPeriodEnd: true,
  cancelAtPeriodEnd: true,
  pastDueSince: true,
  cancelledAt: true,
} as const satisfies Prisma.SubscriptionSelect;

/** A workspace's standing from its subscriptions — no reads, so one or many are worked out alike. */
export function standingOf(isDefault: boolean, subs: StandingSub[], now: Date): Standing {
  if (isDefault) return { kind: "exempt" };
  if (!subs.length) return { kind: "none" };
  if (subs.some((s) => s.gateway === "MANUAL" && s.status === "ACTIVE")) return { kind: "exempt" };

  const paid = subs.filter((s) => s.gateway !== "MANUAL");
  const live = paid.filter((s) => s.status === "ACTIVE" || s.status === "TRIALING");
  const renewing = live.filter((s) => !s.cancelAtPeriodEnd);
  if (renewing.length) return { kind: "paid" };
  if (live.length) {
    const end = live.map((s) => s.currentPeriodEnd?.getTime() ?? now.getTime()).reduce((a, b) => Math.max(a, b));
    return { kind: "ending", holdAt: new Date(end) };
  }
  const pastDue = paid.filter((s) => s.status === "PAST_DUE");
  if (pastDue.length) {
    const since = pastDue.map((s) => s.pastDueSince?.getTime() ?? now.getTime()).reduce((a, b) => Math.min(a, b));
    return { kind: "past-due", holdAt: new Date(since + PAST_DUE_GRACE_DAYS * DAY) };
  }
  const trial = subs.find((s) => s.gateway === "MANUAL" && s.status === "TRIALING");
  if (trial) {
    const endsAt = trial.trialEndsAt ?? now;
    return endsAt > now ? { kind: "trial", endsAt } : { kind: "trial-over", holdAt: new Date(endsAt.getTime() + TRIAL_GRACE_DAYS * DAY) };
  }
  const ended = subs.map((s) => (s.cancelledAt ?? s.currentPeriodEnd ?? s.trialEndsAt)?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
  return { kind: "lapsed", since: new Date(ended || now.getTime()) };
}

export async function billingStanding(tenantId: string, now = new Date()): Promise<Standing> {
  const tenant = await controlDb().tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { isDefault: true, subscriptions: { select: STANDING_SUB_SELECT } },
  });
  return standingOf(tenant.isDefault, tenant.subscriptions, now);
}

/** Many workspaces' standings in two queries per thousand — for lists and previews. An id with no workspace is left out. */
export async function billingStandings(tenantIds: string[], now = new Date()): Promise<Map<string, Standing>> {
  const control = controlDb();
  const ids = [...new Set(tenantIds)];
  const out = new Map<string, Standing>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const [tenants, subs] = await Promise.all([
      control.tenant.findMany({ where: { id: { in: chunk } }, select: { id: true, isDefault: true } }),
      control.subscription.findMany({ where: { tenantId: { in: chunk } }, select: { tenantId: true, ...STANDING_SUB_SELECT } }),
    ]);
    const byTenant = new Map<string, StandingSub[]>();
    for (const { tenantId, ...sub } of subs) {
      const list = byTenant.get(tenantId);
      if (list) list.push(sub);
      else byTenant.set(tenantId, [sub]);
    }
    for (const t of tenants) out.set(t.id, standingOf(t.isDefault, byTenant.get(t.id) ?? [], now));
  }
  return out;
}

/** The date a standing turns on: a trial's end, the hold, or when it lapsed; nothing when paid, exempt or without a plan. */
export function standingDate(s: Standing): Date | null {
  switch (s.kind) {
    case "trial":
      return s.endsAt;
    case "trial-over":
    case "past-due":
    case "ending":
      return s.holdAt;
    case "lapsed":
      return s.since;
    default:
      return null;
  }
}

/** The reminder a date calls for now, if any: the tightest of 7/3/1 days it has come within. */
function reminderStep(at: Date, now: Date): { daysLeft: number; step: number } | null {
  const daysLeft = Math.ceil((at.getTime() - now.getTime()) / DAY);
  if (daysLeft < 1) return null;
  const step = [...REMIND_DAYS].reverse().find((d) => daysLeft <= d);
  return step ? { daysLeft, step } : null;
}

/** Each reminder is sent once: its key names what it is about, the date, and the step. */
const noticeKey = (what: "trial" | "hold", at: Date, step: number) => `${what}:${at.toISOString().slice(0, 10)}:${step}`;

export type PlannedAction = { action: "none" | "held" | "lifted" | "closed"; remind: "trial" | "hold" | null };

/**
 * What a standing calls for, decided without doing any of it — `applyStanding` acts on exactly this,
 * and the console's previews show it. `remind` is set when a reminder falls due by date (7, 3 or 1
 * days before); one already sent, or a workspace without an address, is still skipped when acting.
 * `autoClose`: whether staff have turned closing on (`autoDeprovision()`).
 */
export function plannedAction(t: { status: TenantStatus; suspendedFor: SuspendedFor | null; suspendedAt: Date | null }, standing: Standing, now: Date, autoClose: boolean): PlannedAction {
  const none: PlannedAction = { action: "none", remind: null };
  // Being set up, mid-migration or closed: billing leaves it alone.
  if (t.status !== "ACTIVE" && t.status !== "SUSPENDED") return none;

  const due = "holdAt" in standing ? standing.holdAt <= now : standing.kind === "lapsed";
  const fine = standing.kind === "exempt" || standing.kind === "paid" || standing.kind === "trial" || ("holdAt" in standing && !due);

  if (fine) {
    const at = standingDate(standing);
    return {
      action: t.status === "SUSPENDED" && t.suspendedFor === "BILLING" ? "lifted" : "none",
      remind: at && reminderStep(at, now) ? (standing.kind === "trial" ? "trial" : "hold") : null,
    };
  }
  if (standing.kind === "none") return none;
  if (t.status === "ACTIVE") return { action: "held", remind: null };
  if (standing.kind === "lapsed" && t.suspendedFor === "BILLING" && t.suspendedAt && t.suspendedAt.getTime() + CLOSE_AFTER_DAYS * DAY <= now.getTime() && autoClose) {
    return { action: "closed", remind: null };
  }
  return none;
}

function billingUrl(slug: string): string {
  const host = subdomainHost(slug);
  return `${protocolFor(host)}://${host}/settings/billing`;
}

const dateText = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });

/** The reminder due now, if one is: the tightest of 7/3/1 days the date has come within, once. */
async function remind(tenant: { id: string; slug: string; name: string; to: string | null }, what: "trial" | "hold", at: Date, now: Date): Promise<boolean> {
  if (!tenant.to) return false;
  const due = reminderStep(at, now);
  if (!due) return false;
  const key = noticeKey(what, at, due.step);
  try {
    await controlDb().billingNotice.create({ data: { tenantId: tenant.id, key } });
  } catch {
    return false; // Sent already.
  }
  const when = due.daysLeft === 1 ? "tomorrow" : `in ${due.daysLeft} days`;
  const subject = what === "trial" ? `Your trial of ${tenant.name} ends ${when}` : `${tenant.name} will be held ${when}`;
  const body =
    what === "trial"
      ? [`Your free trial ends on ${dateText(at)}.`, "", "Choose a plan to keep everything as it is:", billingUrl(tenant.slug)]
      : [`${tenant.name} will be held on ${dateText(at)} unless the subscription is paid — nothing is deleted, but nobody can work in it until it is.`, "", "Settle it here:", billingUrl(tenant.slug)];
  await sendPlatformMail({ to: tenant.to, subject, text: body.join("\n") });
  return true;
}

export type LifecycleOutcome = { tenantId: string; slug: string; standing: Standing["kind"]; action: "none" | "held" | "lifted" | "closed"; reminded: boolean };

/** One workspace: hold it, lift its hold, close it, remind it — whatever its standing calls for. */
export async function applyStanding(tenantId: string, now = new Date()): Promise<LifecycleOutcome> {
  const control = controlDb();
  const tenant = await control.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { id: true, slug: true, name: true, status: true, suspendedFor: true, suspendedAt: true, billingEmail: true, ownerEmail: true },
  });
  const standing = await billingStanding(tenantId, now);
  const who = { id: tenant.id, slug: tenant.slug, name: tenant.name, to: tenant.billingEmail ?? tenant.ownerEmail };
  const out: LifecycleOutcome = { tenantId, slug: tenant.slug, standing: standing.kind, action: "none", reminded: false };

  let plan = plannedAction(tenant, standing, now, true);
  // Whether staff turned closing on is read only when it would close — as it always has been.
  if (plan.action === "closed" && !(await autoDeprovision())) plan = plannedAction(tenant, standing, now, false);

  switch (plan.action) {
    case "lifted":
      if (await liftBillingHold(tenantId, "billing")) out.action = "lifted";
      break;
    case "held": {
      const reason = standing.kind === "trial-over" ? "trial ended" : standing.kind === "past-due" ? "payment overdue" : "subscription ended";
      await suspendTenant(tenantId, "billing", reason, "BILLING");
      // A trial that has run out is over, not merely paused: buying a plan starts the paid one.
      await control.subscription.updateMany({ where: { tenantId, gateway: "MANUAL", status: "TRIALING" }, data: { status: "CANCELLED", cancelledAt: now } });
      out.action = "held";
      break;
    }
    case "closed":
      await deprovisionTenant(tenantId, "billing");
      out.action = "closed";
      break;
  }
  const at = standingDate(standing);
  if (plan.remind && at) out.reminded = await remind(who, plan.remind, at, now);
  return out;
}

/** Every workspace that is open or held — not one being set up, mid-migration, or closed. */
export async function runBillingLifecycle(now = new Date()): Promise<LifecycleOutcome[]> {
  const tenants = await controlDb().tenant.findMany({ where: { status: { in: ["ACTIVE", "SUSPENDED"] } }, select: { id: true }, orderBy: { createdAt: "asc" } });
  const outcomes: LifecycleOutcome[] = [];
  for (const t of tenants) {
    try {
      outcomes.push(await applyStanding(t.id, now));
    } catch (err) {
      console.error(`[billing] lifecycle failed for ${t.id}`, err);
    }
  }
  return outcomes;
}

/**
 * What `runBillingLifecycle` would do now, done to nothing: the slugs it would hold, lift, close and
 * remind, in the order it would reach them. A reminder already sent, or with no address to go to,
 * is left out — as the run would leave it.
 */
export async function previewLifecycle(now = new Date()): Promise<{ held: string[]; lifted: string[]; closed: string[]; remind: string[] }> {
  const control = controlDb();
  const tenants = await control.tenant.findMany({
    where: { status: { in: ["ACTIVE", "SUSPENDED"] } },
    select: { id: true, slug: true, status: true, suspendedFor: true, suspendedAt: true, billingEmail: true, ownerEmail: true },
    orderBy: { createdAt: "asc" },
  });
  const [standings, autoClose] = await Promise.all([billingStandings(tenants.map((t) => t.id), now), autoDeprovision()]);
  const out = { held: [] as string[], lifted: [] as string[], closed: [] as string[], remind: [] as string[] };
  const reminders: { tenantId: string; slug: string; key: string }[] = [];
  for (const t of tenants) {
    const standing = standings.get(t.id);
    if (!standing) continue;
    const plan = plannedAction(t, standing, now, autoClose);
    if (plan.action !== "none") out[plan.action].push(t.slug);
    const at = standingDate(standing);
    const due = at && reminderStep(at, now);
    if (plan.remind && at && due && (t.billingEmail ?? t.ownerEmail)) reminders.push({ tenantId: t.id, slug: t.slug, key: noticeKey(plan.remind, at, due.step) });
  }
  const sent = new Set<string>();
  for (let i = 0; i < reminders.length; i += CHUNK) {
    const chunk = reminders.slice(i, i + CHUNK);
    const rows = await control.billingNotice.findMany({
      where: { tenantId: { in: chunk.map((r) => r.tenantId) }, key: { in: [...new Set(chunk.map((r) => r.key))] } },
      select: { tenantId: true, key: true },
    });
    for (const r of rows) sent.add(`${r.tenantId} ${r.key}`);
  }
  out.remind = reminders.filter((r) => !sent.has(`${r.tenantId} ${r.key}`)).map((r) => r.slug);
  return out;
}
