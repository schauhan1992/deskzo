import { Prisma } from "@deskzo/control-client";
import { plural } from "@/lib/console-shared/format";
import { redactSecrets } from "@/lib/console-shared/redact";
import { MANAGERS, SELLERS, SIGNUP_VIEWERS, SUPPORT_VIEWERS, hasRole } from "@/lib/console-shared/roles";
import type { ConsoleRole, NavBadge, NavBadgeKey, NavCounts } from "@/lib/console-shared/types";
import { alertCounts } from "@/lib/platform/alerts";
import { controlDb } from "@/lib/platform/control-db";
import { LIVE_STATUSES } from "@/lib/platform/entitlements";
import { forHowLong, platformTick, referenceSyncIssues, schemaDrift } from "@/lib/platform/health";
import { stuckSignups } from "@/lib/platform/signups";

/**
 * The console sidebar's badges: how many alerts are open, trials about to end, stuck signups, live
 * announcements, failed webhooks, failed setups, held or lagging schemas, and a dot when the platform
 * tick or a reference sync is in trouble. The console layout awaits this on every full render, and the
 * shell asks again (`consoleNavCounts`) every minute while the tab is visible.
 *
 * Nothing here may take the console down: each badge is worked out on its own, and one that throws or
 * has not answered within a few seconds is left off (logged, redacted) — the shell asks again within a
 * minute. The whole never throws. Each badge is a count or two, not rows, and reads the same rules as
 * the page it sits on, so the number next to a link is the number that page shows:
 *
 *   alerts          open critical + warning alerts (src/lib/platform/alerts.ts), danger with any critical
 *   support         support requests open or in progress, danger with any urgent — for those who may open the inbox
 *   trials          workspaces whose trial ends within 3 days or has ended (the Trials board's rule)
 *   signups         stuck signups (src/lib/platform/signups.ts) — only for those who may open that page
 *   partners        partner applications, deals and requests awaiting a decision, and flagged attributions
 *                   nobody has reviewed — only for the staff who manage partners or sell, who act on them
 *   announcements   live now
 *   billing         webhooks that failed to apply — only for the staff who sell
 *   commissions     partner statements to approve or to pay — only for the staff who sell
 *   health          a dot when the platform tick never ran, is six hours late, or its last run failed
 *   provisioning    failed setups; else a pulsing dot while setups wait or run
 *   migrations      workspaces held by a migration; else those behind the latest schema
 *   reference       a dot when a PIN or world-places sync failed or stopped responding
 *
 * No badge is worked out for a page the role cannot open, so none of its numbers is read for them.
 */

const DAY_MS = 86_400_000;
/** How long one badge may take before this render goes without it. */
const BADGE_BUDGET_MS = 4_000;
/** The trials badge's horizon. */
const TRIAL_DAYS = 3;
/** How far back a flagged, unreviewed attribution still counts as something to look at. */
const FLAGGED_DAYS = 90;

/**
 * One badge's work, or null when it failed or ran over the budget. The late answer is dropped, not
 * awaited (its promise settles on its own, handled by the race), and the timer is always cleared.
 */
async function guarded<T>(what: string, work: () => Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${BADGE_BUDGET_MS / 1000} s`)), BADGE_BUDGET_MS);
  });
  try {
    return await Promise.race([work(), late]);
  } catch (err) {
    console.error(`[nav-counts] the ${what} badge was left out: ${redactSecrets(err instanceof Error ? err.message : String(err)) ?? "unknown error"}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── The badges ──────────────────────────────────────────────────────────────────────────────────

function alertsBadge(counts: { critical: number; warning: number }): NavBadge | null {
  const { critical, warning } = counts;
  const n = critical + warning;
  if (n === 0) return null;
  const label =
    critical && warning
      ? `${critical} critical and ${warning} warning ${n === 1 ? "alert" : "alerts"}`
      : critical
        ? `${critical} critical ${critical === 1 ? "alert" : "alerts"}`
        : `${warning} warning ${warning === 1 ? "alert" : "alerts"}`;
  return { count: n, tone: critical > 0 ? "danger" : "warning", label };
}

/**
 * Active workspaces on a trial given by hand that ends within three days, or already ended and not yet
 * held — as the Trials board counts them, so a workspace paying at a gateway is left out (its trial,
 * if any, is the gateway's). One per workspace.
 */
async function trialsBadge(now: Date): Promise<NavBadge | null> {
  const control = controlDb();
  const trialing = (endsBy: Date) => ({ gateway: "MANUAL" as const, status: "TRIALING" as const, trialEndsAt: { lte: endsBy } });
  const onTrial = (endsBy: Date) => ({
    status: "ACTIVE" as const,
    AND: [
      { subscriptions: { some: trialing(endsBy) } },
      { subscriptions: { none: { gateway: { in: ["STRIPE" as const, "RAZORPAY" as const] }, status: { in: [...LIVE_STATUSES] } } } },
    ],
  });
  const [soon, ended] = await Promise.all([
    control.tenant.count({ where: onTrial(new Date(now.getTime() + TRIAL_DAYS * DAY_MS)) }),
    control.tenant.count({ where: onTrial(now) }),
  ]);
  if (soon === 0) return null;
  const ending = Math.max(0, soon - ended);
  const parts = [
    ending > 0 ? `${plural(ending, "trial")} ${ending === 1 ? "ends" : "end"} within ${TRIAL_DAYS} days` : null,
    ended > 0 ? `${plural(ended, "trial")} ${ended === 1 ? "has" : "have"} ended` : null,
  ].filter((p): p is string => !!p);
  return { count: soon, tone: "warning", label: parts.join("; ") };
}

/** The signups page's own count of stuck signups, so the badge and the page agree (never the address it came from). */
async function signupsBadge(now: Date): Promise<NavBadge | null> {
  const { total } = await stuckSignups({ withIp: false }, now);
  return total > 0 ? { count: total, tone: "muted", label: plural(total, "stuck signup") } : null;
}

/** The Support inbox's Open tab (OPEN and IN_PROGRESS); the urgent ones make it red and are named in the label. */
async function supportBadge(): Promise<NavBadge | null> {
  const table = controlDb().supportRequest;
  const open = { status: { in: ["OPEN" as const, "IN_PROGRESS" as const] } };
  const [total, urgent] = await Promise.all([table.count({ where: open }), table.count({ where: { ...open, priority: "URGENT" } })]);
  if (total === 0) return null;
  const label = `${plural(total, "open support request")}${urgent > 0 ? `, ${urgent} urgent` : ""}`;
  return { count: total, tone: urgent > 0 ? "danger" : "info", label };
}

/**
 * What waits on staff in the partner programme, as /partners/requests has it: new applications, deal
 * registrations and partner requests awaiting a decision, and current attributions flagged at signup (a
 * conflict, or outside the partner's territories) that nobody has reviewed — made in the last 90 days, so
 * an old flag does not keep the badge lit for ever.
 */
async function partnersBadge(now: Date): Promise<NavBadge | null> {
  const control = controlDb();
  const since = new Date(now.getTime() - FLAGGED_DAYS * DAY_MS);
  const [applications, deals, requests, flagged] = await Promise.all([
    control.partnerApplication.count({ where: { status: "NEW" } }),
    control.dealRegistration.count({ where: { status: "PENDING" } }),
    control.partnerRequest.count({ where: { status: "PENDING" } }),
    control.tenantAttribution.count({ where: { validTo: null, reviewedAt: null, flags: { not: Prisma.AnyNull }, createdAt: { gte: since } } }),
  ]);
  const n = applications + deals + requests + flagged;
  return n > 0 ? { count: n, tone: "warning", label: `${plural(n, "partner item")} to review` } : null;
}

async function announcementsBadge(now: Date): Promise<NavBadge | null> {
  // "Live" as the Announcements page's tab has it: started, not ended, not archived.
  const live = await controlDb().platformAnnouncement.count({
    where: { archivedAt: null, startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
  });
  return live > 0 ? { count: live, tone: "info", label: plural(live, "live announcement") } : null;
}

async function billingBadge(): Promise<NavBadge | null> {
  const failed = await controlDb().billingEvent.count({ where: { processedAt: null, error: { not: null } } });
  return failed > 0 ? { count: failed, tone: "danger", label: `${plural(failed, "webhook")} failed to apply` } : null;
}

/** Statements drafted and waiting for approval, or approved and waiting to be paid. */
async function commissionsBadge(): Promise<NavBadge | null> {
  const waiting = await controlDb().partnerStatement.count({ where: { status: { in: ["DRAFT", "APPROVED"] } } });
  return waiting > 0 ? { count: waiting, tone: "info", label: `${plural(waiting, "statement")} to approve or pay` } : null;
}

/** The platform tick, read as the System health board and the tick alerts read it. */
async function healthBadge(now: Date): Promise<NavBadge | null> {
  const tick = await platformTick(now);
  if (!tick.stale && !tick.failed) return null;
  const label = tick.failed
    ? "The last platform tick failed"
    : tick.never
      ? "The platform tick has never run"
      : `The platform tick hasn't run for ${forHowLong(tick.ageMs ?? 0)}`;
  return { count: null, tone: "danger", label };
}

async function provisioningBadge(): Promise<NavBadge | null> {
  const control = controlDb();
  // A closed workspace's setup waits on nobody — the health board and the alerts leave those out too.
  const open = { tenant: { status: { not: "DEPROVISIONED" as const } } };
  const [failed, busy] = await Promise.all([
    control.provisioningJob.count({ where: { status: "FAILED", ...open } }),
    control.provisioningJob.count({ where: { status: { in: ["PENDING", "RUNNING"] }, ...open } }),
  ]);
  if (failed > 0) return { count: failed, tone: "danger", label: plural(failed, "failed setup") };
  if (busy > 0) return { count: null, tone: "info", label: `${plural(busy, "setup")} in progress`, pulse: true };
  return null;
}

/** Schema drift as the Migrations page and the alerts work it out (src/lib/platform/health.ts). */
async function migrationsBadge(now: Date): Promise<NavBadge | null> {
  const drift = await schemaDrift(now);
  const held = drift.migrating.length;
  if (held > 0) return { count: held, tone: "danger", label: `${plural(held, "workspace")} held by a migration` };
  if (drift.latest && drift.behind > 0) return { count: drift.behind, tone: "warning", label: `${plural(drift.behind, "workspace")} behind the latest schema` };
  return null;
}

/**
 * The reference syncs' own rows only — one small read, the one the alerts use — rather than counting
 * the datasets as the Reference data page does: this runs on every page. None without a reference database.
 */
async function referenceBadge(now: Date): Promise<NavBadge | null> {
  const issues = await referenceSyncIssues(now);
  if (issues.length === 0) return null;
  if (issues.length > 1) return { count: null, tone: "warning", label: "The PIN directory and world places syncs need attention" };
  const [issue] = issues;
  const what = issue.dataset === "pin" ? "PIN directory" : "world places";
  return { count: null, tone: "warning", label: issue.problem === "failed" ? `The ${what} sync failed` : `The ${what} sync stopped responding` };
}

// ─── All of them ─────────────────────────────────────────────────────────────────────────────────

/**
 * The badges `role` sees, and how many alerts are open for it (critical, warning and info). Never
 * throws: a badge that cannot be worked out is simply absent, and `alertsOpen` is 0 when the alerts
 * could not be counted.
 */
export async function navCounts(role: ConsoleRole, now = new Date()): Promise<NavCounts> {
  const none = Promise.resolve(null);
  const [alerts, support, trials, signups, partners, announcements, billing, commissions, health, provisioning, migrations, reference] = await Promise.all([
    guarded("alerts", () => alertCounts(role, now)),
    hasRole(role, SUPPORT_VIEWERS) ? guarded("support", () => supportBadge()) : none,
    guarded("trials", () => trialsBadge(now)),
    hasRole(role, SIGNUP_VIEWERS) ? guarded("signups", () => signupsBadge(now)) : none,
    hasRole(role, MANAGERS) || hasRole(role, SELLERS) ? guarded("partners", () => partnersBadge(now)) : none,
    guarded("announcements", () => announcementsBadge(now)),
    hasRole(role, SELLERS) ? guarded("billing", () => billingBadge()) : none,
    hasRole(role, SELLERS) ? guarded("commissions", () => commissionsBadge()) : none,
    guarded("health", () => healthBadge(now)),
    guarded("provisioning", () => provisioningBadge()),
    guarded("migrations", () => migrationsBadge(now)),
    guarded("reference", () => referenceBadge(now)),
  ]);

  const found: [NavBadgeKey, NavBadge | null][] = [
    ["alerts", alerts ? alertsBadge(alerts) : null],
    ["support", support],
    ["trials", trials],
    ["signups", signups],
    ["partners", partners],
    ["announcements", announcements],
    ["billing", billing],
    ["commissions", commissions],
    ["health", health],
    ["provisioning", provisioning],
    ["migrations", migrations],
    ["reference", reference],
  ];
  const badges: NavCounts["badges"] = {};
  for (const [key, badge] of found) if (badge) badges[key] = badge;
  return { asOf: now.toISOString(), alertsOpen: alerts ? alerts.critical + alerts.warning + alerts.info : 0, badges };
}
