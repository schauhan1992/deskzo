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
 */

export const TRIAL_GRACE_DAYS = 7;
export const PAST_DUE_GRACE_DAYS = 14;
export const CLOSE_AFTER_DAYS = 90;
const REMIND_DAYS = [7, 3, 1] as const;
const DAY = 86_400_000;

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

export async function billingStanding(tenantId: string, now = new Date()): Promise<Standing> {
  const tenant = await controlDb().tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { isDefault: true, subscriptions: { select: { gateway: true, status: true, trialEndsAt: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, pastDueSince: true, cancelledAt: true } } },
  });
  if (tenant.isDefault) return { kind: "exempt" };
  const subs = tenant.subscriptions;
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

function billingUrl(slug: string): string {
  const host = subdomainHost(slug);
  return `${protocolFor(host)}://${host}/settings/billing`;
}

const dateText = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });

/** The reminder due now, if one is: the tightest of 7/3/1 days the date has come within, once. */
async function remind(tenant: { id: string; slug: string; name: string; to: string | null }, what: "trial" | "hold", at: Date, now: Date): Promise<boolean> {
  if (!tenant.to) return false;
  const daysLeft = Math.ceil((at.getTime() - now.getTime()) / DAY);
  if (daysLeft < 1) return false;
  const step = [...REMIND_DAYS].reverse().find((d) => daysLeft <= d);
  if (!step) return false;
  const key = `${what}:${at.toISOString().slice(0, 10)}:${step}`;
  try {
    await controlDb().billingNotice.create({ data: { tenantId: tenant.id, key } });
  } catch {
    return false; // Sent already.
  }
  const when = daysLeft === 1 ? "tomorrow" : `in ${daysLeft} days`;
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
  if (tenant.status !== "ACTIVE" && tenant.status !== "SUSPENDED") return out;

  const due = "holdAt" in standing ? standing.holdAt <= now : standing.kind === "lapsed";
  const fine = standing.kind === "exempt" || standing.kind === "paid" || standing.kind === "trial" || (("holdAt" in standing) && !due);

  if (fine) {
    if (tenant.status === "SUSPENDED" && tenant.suspendedFor === "BILLING" && (await liftBillingHold(tenantId, "billing"))) out.action = "lifted";
    if (standing.kind === "trial") out.reminded = await remind(who, "trial", standing.endsAt, now);
    else if ("holdAt" in standing) out.reminded = await remind(who, "hold", standing.holdAt, now);
    return out;
  }
  if (standing.kind === "none") return out;

  if (tenant.status === "ACTIVE") {
    const reason = standing.kind === "trial-over" ? "trial ended" : standing.kind === "past-due" ? "payment overdue" : "subscription ended";
    await suspendTenant(tenantId, "billing", reason, "BILLING");
    // A trial that has run out is over, not merely paused: buying a plan starts the paid one.
    await control.subscription.updateMany({ where: { tenantId, gateway: "MANUAL", status: "TRIALING" }, data: { status: "CANCELLED", cancelledAt: now } });
    out.action = "held";
    return out;
  }
  if (
    standing.kind === "lapsed" &&
    tenant.suspendedFor === "BILLING" &&
    tenant.suspendedAt &&
    tenant.suspendedAt.getTime() + CLOSE_AFTER_DAYS * DAY <= now.getTime() &&
    (await autoDeprovision())
  ) {
    await deprovisionTenant(tenantId, "billing");
    out.action = "closed";
  }
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
