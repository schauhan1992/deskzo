import { CLOSE_AFTER_DAYS, PAST_DUE_GRACE_DAYS, TRIAL_GRACE_DAYS, billingStandings } from "@/lib/billing/lifecycle";
import { dayKeyLabel, dayMonth, dayMonthYear, istDayKey, istDaysBetween, plural, when } from "@/lib/console-shared/format";
import { gatewayLabel, grantLabel, jobLabel, schemaLabel } from "@/lib/console-shared/labels";
import type { AlertCategory, AlertFilters, AlertSeverity } from "@/lib/console-shared/params";
import { redactSecrets } from "@/lib/console-shared/redact";
import { SELLERS, SIGNUP_VIEWERS, hasRole } from "@/lib/console-shared/roles";
import type { ConsoleRole } from "@/lib/console-shared/types";
import { startOfIndianDay } from "@/lib/india-time";
import { cleanText, staffNameMap } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import { LIVE_STATUSES } from "@/lib/platform/entitlements";
import {
  HEALTH_LIMITS,
  dailyChores,
  errorLine,
  failingJobs,
  forHowLong,
  gatewayKeySets,
  platformTick,
  referenceSyncIssues,
  schemaDrift,
  securityFacts,
  warmPool,
} from "@/lib/platform/health";
import { RETENTION_DAYS } from "@/lib/platform/lifecycle";
import { autoDeprovision } from "@/lib/platform/settings";

/**
 * The console's alerts: what is wrong now, or about to be, derived on every request from the control
 * plane — nothing is stored but who acknowledged or put off which one. Shown on /alerts, on the
 * overview's "Needs attention", on a workspace's own page, and counted for the nav badge.
 *
 * ## Keys
 *
 * Every alert has a stable key, `<kind>` or `<kind>:<identity>`. An instance alert's key names the
 * thing that went wrong (a job, an event, a workspace on a date), so a new occurrence is a new alert
 * and can be acknowledged for good. A condition alert ("the warm pool is low") carries no identity:
 * it can only be put off for a while, and comes back if it is still true then.
 *
 * ## Who sees what
 *
 * Billing alerts are for the staff who sell (their sources are not even read for anybody else), and
 * the stuck-signups count for those who may open the signups page. Titles are plain sentences for
 * everybody: none uses the wording kept for the roles allowed to act (`FORBIDDEN_FOR_SUPPORT`).
 *
 * ## Cost
 *
 * `alertCounts` runs on every console page (the nav badge): each source is one or two small indexed
 * reads, all in parallel, never one read per row. A source that cannot be read is logged and left
 * out — the alerts of the others still show; the System health board reports the failure itself.
 */

export type { AlertSeverity, AlertCategory, AlertFilters } from "@/lib/console-shared/params";

export type Alert = {
  key: string;
  severity: AlertSeverity;
  category: AlertCategory;
  /** The key's kind: "provisioning.failed", "tick.stale"… */
  kind: string;
  title: string;
  detail: string;
  /** Where to fix it, root-relative. */
  href: string;
  since: Date | null;
  tenant: { id: string; slug: string; name: string } | null;
  /** An instance can be acknowledged for good; a condition only put off. */
  instance: boolean;
  /** Set on acknowledged or put-off alerts (`AlertList.acked`); null on open ones. */
  ack: { by: string; byName: string; at: Date; snoozeUntil: Date | null; note: string | null } | null;
};

export type AlertList = { asOf: Date; open: Alert[]; acked: Alert[]; counts: { critical: number; warning: number; info: number } };

type AlertKind =
  | "provisioning.failed"
  | "provisioning.stuck"
  | "tenant.migrating"
  | "schema.drift"
  | "warm.low"
  | "tick.stale"
  | "tick.failed"
  | "daily.stale"
  | "webhook.failed"
  | "billing.exempt-while-paying"
  | "past-due"
  | "close.due"
  | "gateway.keys.partial"
  | "trial.ending"
  | "job.failing"
  | "reference.sync"
  | "staff.twofactor-off"
  | "staff.no-2fa"
  | "mail.unconfigured"
  | "seats.over"
  | "purge.due"
  | "signups.stuck"
  | "grant.live";

type KindSpec = {
  severity: AlertSeverity;
  category: AlertCategory;
  instance: boolean;
  /** A condition that is one of a few (a gateway, a dataset): the only suffixes its key may carry. */
  suffixes?: readonly string[];
  /** Its identity starts with the workspace's id — the audit entry of an acknowledgement is filed under it. */
  tenantFirst?: boolean;
};

const KINDS: Record<AlertKind, KindSpec> = {
  "provisioning.failed": { severity: "critical", category: "setup", instance: true },
  "provisioning.stuck": { severity: "warning", category: "setup", instance: true },
  "tenant.migrating": { severity: "critical", category: "migrations", instance: true, tenantFirst: true },
  "schema.drift": { severity: "warning", category: "migrations", instance: false },
  "warm.low": { severity: "warning", category: "setup", instance: false },
  "tick.stale": { severity: "critical", category: "jobs", instance: false },
  "tick.failed": { severity: "critical", category: "jobs", instance: true },
  "daily.stale": { severity: "warning", category: "billing", instance: false },
  "webhook.failed": { severity: "critical", category: "billing", instance: true },
  "billing.exempt-while-paying": { severity: "warning", category: "billing", instance: true, tenantFirst: true },
  "past-due": { severity: "warning", category: "billing", instance: true, tenantFirst: true },
  // Info instead while closing on its own is off.
  "close.due": { severity: "warning", category: "billing", instance: true, tenantFirst: true },
  "gateway.keys.partial": { severity: "warning", category: "billing", instance: false, suffixes: ["stripe", "razorpay"] },
  "trial.ending": { severity: "info", category: "trials", instance: true, tenantFirst: true },
  "job.failing": { severity: "warning", category: "jobs", instance: true, tenantFirst: true },
  "reference.sync": { severity: "warning", category: "reference", instance: false, suffixes: ["pin", "world"] },
  "staff.twofactor-off": { severity: "critical", category: "security", instance: false },
  "staff.no-2fa": { severity: "warning", category: "security", instance: false },
  "mail.unconfigured": { severity: "warning", category: "security", instance: false },
  "seats.over": { severity: "warning", category: "workspaces", instance: true, tenantFirst: true },
  "purge.due": { severity: "info", category: "workspaces", instance: true, tenantFirst: true },
  "signups.stuck": { severity: "info", category: "workspaces", instance: false },
  "grant.live": { severity: "info", category: "workspaces", instance: true },
};

const isKind = (k: string): k is AlertKind => Object.prototype.hasOwnProperty.call(KINDS, k);

/** At most this many alerts in each list; the counts are of all of them. */
const CAP = 200;
const RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
const DAY = 86_400_000;
/** A billing hold is flagged this many days before it would be closed on its own. */
const CLOSE_WARNING_DAYS = 10;
const TENANT_REF = { id: true, slug: true, name: true } as const;

type TenantRef = { id: string; slug: string; name: string };
type Draft = { title: string; detail: string; href: string; since?: Date | null; tenant?: TenantRef | null; severity?: AlertSeverity };

/** One part of a key's identity, kept to the characters a key may hold. */
const part = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "_";
const isOrAre = (n: number) => (n === 1 ? "is" : "are");
const workspaceHref = (slug: string, tab: string) => `/workspaces/${encodeURIComponent(slug)}?tab=${tab}`;

function make(kind: AlertKind, identity: string[], d: Draft): Alert {
  const spec = KINDS[kind];
  return {
    key: identity.length ? `${kind}:${identity.join(":")}` : kind,
    severity: d.severity ?? spec.severity,
    category: spec.category,
    kind,
    title: d.title,
    detail: d.detail,
    href: d.href,
    since: d.since ?? null,
    tenant: d.tenant ?? null,
    instance: spec.instance,
    ack: null,
  };
}

// ─── Keys ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Whether `key` is one the console raises: at most 200 characters of letters, digits and `.:_-`, a
 * known kind, an identity for an instance kind (none for a condition, or one of its few suffixes).
 */
export function alertKeyInfo(key: string): { valid: boolean; instance: boolean } {
  const invalid = { valid: false, instance: false };
  if (typeof key !== "string" || key.length === 0 || key.length > 200 || !/^[a-z0-9.:_-]+$/i.test(key)) return invalid;
  const at = key.indexOf(":");
  const kind = at < 0 ? key : key.slice(0, at);
  if (!isKind(kind)) return invalid;
  const spec = KINDS[kind];
  const rest = at < 0 ? null : key.slice(at + 1);
  if (spec.instance) return rest && rest.split(":").every(Boolean) ? { valid: true, instance: true } : invalid;
  if (spec.suffixes) return rest !== null && spec.suffixes.includes(rest) ? { valid: true, instance: false } : invalid;
  return rest === null ? { valid: true, instance: false } : invalid;
}

/** The workspace id an alert's key names, for the kinds keyed by one; null for the others and for a key that is not valid. */
export function alertTenantId(key: string): string | null {
  if (!alertKeyInfo(key).valid) return null;
  const at = key.indexOf(":");
  if (at < 0) return null;
  const kind = key.slice(0, at);
  if (!isKind(kind) || !KINDS[kind].tenantFirst) return null;
  return key.slice(at + 1).split(":")[0] || null;
}

// ─── Sources ─────────────────────────────────────────────────────────────────────────────────────

type Ctx = { now: Date };

async function setupAlerts({ now }: Ctx): Promise<Alert[]> {
  const control = controlDb();
  const [failed, stuck] = await Promise.all([
    control.provisioningJob.findMany({
      // A setup whose workspace was closed since is not waiting on anybody.
      where: { status: "FAILED", tenant: { status: { not: "DEPROVISIONED" } } },
      orderBy: { finishedAt: "desc" },
      take: 20,
      select: { id: true, step: true, error: true, finishedAt: true, tenant: { select: TENANT_REF } },
    }),
    control.provisioningJob.findMany({
      where: {
        OR: [
          { status: "RUNNING", startedAt: { lt: new Date(now.getTime() - HEALTH_LIMITS.setupRunningMs) } },
          { status: "PENDING", runAfter: { lt: new Date(now.getTime() - HEALTH_LIMITS.setupWaitingMs) } },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: 20,
      select: { id: true, status: true, step: true, startedAt: true, runAfter: true, tenant: { select: TENANT_REF } },
    }),
  ]);
  const out = failed.map((j) => {
    const step = errorLine(j.step, 80) ?? "its first step";
    const error = errorLine(j.error);
    return make("provisioning.failed", [part(j.id)], {
      title: `Setup failed for ${j.tenant.slug}`,
      detail: error ? `At "${step}": ${error}` : `It stopped at "${step}".`,
      href: "/provisioning?filter=attention",
      since: j.finishedAt,
      tenant: j.tenant,
    });
  });
  for (const j of stuck) {
    const step = errorLine(j.step, 80) ?? "its first step";
    if (j.status === "RUNNING") {
      const started = j.startedAt ?? j.runAfter;
      out.push(
        make("provisioning.stuck", [part(j.id)], {
          title: `Setup of ${j.tenant.slug} has been running for ${forHowLong(now.getTime() - started.getTime())}`,
          detail: `It is still at "${step}", and no worker has taken it back — is the platform worker running?`,
          href: "/provisioning",
          since: started,
          tenant: j.tenant,
        }),
      );
    } else {
      out.push(
        make("provisioning.stuck", [part(j.id)], {
          title: `Setup of ${j.tenant.slug} has waited ${forHowLong(now.getTime() - j.runAfter.getTime())} to start`,
          detail: "The platform worker has not taken it — is it running?",
          href: "/provisioning",
          since: j.runAfter,
          tenant: j.tenant,
        }),
      );
    }
  }
  return out;
}

async function warmAlerts(): Promise<Alert[]> {
  const { ready, target } = await warmPool();
  if (target === 0 || ready >= target) return [];
  return [
    make("warm.low", [], {
      title: ready === 0 ? `The warm pool is empty (0 of ${target} ready)` : `The warm pool is low (${ready} of ${target} ready)`,
      detail: "New signups wait while a database is made. The platform worker tops the pool up.",
      href: "/provisioning#warm-pool",
    }),
  ];
}

async function migrationAlerts({ now }: Ctx): Promise<Alert[]> {
  const d = await schemaDrift(now);
  const out = d.migrating.map((t) =>
    make("tenant.migrating", [part(t.id)], {
      title: d.runBusy ? `${t.slug} is held while a migration runs` : `${t.slug} is held after a failed migration`,
      detail: d.runBusy ? "It reopens when the run finishes." : "People see the maintenance page until it is migrated again.",
      href: workspaceHref(t.slug, "operations"),
      since: t.since,
      tenant: { id: t.id, slug: t.slug, name: t.name },
    }),
  );
  if (d.latest && d.behind > 0) {
    out.push(
      make("schema.drift", [], {
        title: `${plural(d.behind, "workspace")} ${isOrAre(d.behind)} behind the latest schema`,
        detail: `The latest is ${schemaLabel(d.latest)}.${d.runBusy ? " A migration run is going on now." : " Migrate them from Migrations."}`,
        href: "/migrations",
      }),
    );
  }
  return out;
}

async function tickAlerts({ now }: Ctx): Promise<Alert[]> {
  const t = await platformTick(now);
  const out: Alert[] = [];
  if (t.stale) {
    out.push(
      make("tick.stale", [], {
        title: t.never ? "The platform tick has never run" : `The platform tick hasn't run for ${forHowLong(t.ageMs ?? 0)}`,
        detail: "Billing holds, reminders and the daily chores wait for it. It should be called every hour.",
        href: "/health",
        since: t.lastFinishedAt,
      }),
    );
  }
  if (t.failed) {
    const started = t.lastStartedAt ?? t.lastFinishedAt;
    out.push(
      make("tick.failed", [started ? started.toISOString() : "unknown"], {
        title: "The last platform tick failed",
        detail: errorLine(t.lastError) ?? "It stopped with an error.",
        href: "/health",
        since: t.lastFinishedAt,
      }),
    );
  }
  return out;
}

async function jobAlerts({ now }: Ctx): Promise<Alert[]> {
  return (await failingJobs(now)).map((f) =>
    make("job.failing", [part(f.tenantId), part(f.job), f.lastStartedAt ? f.lastStartedAt.toISOString() : "never"], {
      title: `${jobLabel(f.job)} failed for ${f.slug ?? f.tenantId}`,
      detail: errorLine(f.lastError) ?? "It stopped with an error.",
      href: f.slug ? workspaceHref(f.slug, "operations") : "/health#scheduled-jobs",
      since: f.lastFinishedAt,
      tenant: f.slug ? { id: f.tenantId, slug: f.slug, name: f.name ?? f.slug } : null,
    }),
  );
}

async function trialAlerts({ now }: Ctx): Promise<Alert[]> {
  const subs = await controlDb().subscription.findMany({
    where: { gateway: "MANUAL", status: "TRIALING", trialEndsAt: { lte: new Date(now.getTime() + 3 * DAY) }, tenant: { status: "ACTIVE", isDefault: false } },
    orderBy: { trialEndsAt: "asc" },
    take: CAP,
    select: { trialEndsAt: true, tenant: { select: TENANT_REF } },
  });
  const seen = new Set<string>();
  const out: Alert[] = [];
  for (const s of subs) {
    if (!s.trialEndsAt || seen.has(s.tenant.id)) continue;
    seen.add(s.tenant.id);
    const { slug } = s.tenant;
    const ends = s.trialEndsAt;
    const holdAt = new Date(ends.getTime() + TRIAL_GRACE_DAYS * DAY);
    const days = istDaysBetween(now, ends);
    let title: string;
    let detail: string;
    if (ends <= now) {
      title = `${slug}'s trial ended on ${dayMonth(ends)}`;
      detail = holdAt > now ? `It is held on ${dayMonth(holdAt)} unless a plan is bought.` : "Its grace is over; the next platform tick holds it unless a plan is bought.";
    } else {
      title = days <= 0 ? `${slug}'s trial ends today` : days === 1 ? `${slug}'s trial ends tomorrow` : `${slug}'s trial ends in ${days} days`;
      detail = `It ends ${when(ends)}. Extend it from Trials, or it is held ${TRIAL_GRACE_DAYS} days later unless a plan is bought.`;
    }
    out.push(make("trial.ending", [part(s.tenant.id), istDayKey(ends)], { title, detail, href: "/trials", since: ends, tenant: s.tenant }));
  }
  return out;
}

async function referenceAlerts({ now }: Ctx): Promise<Alert[]> {
  return (await referenceSyncIssues(now)).map((issue) => {
    const what = issue.dataset === "pin" ? "PIN directory" : "world places";
    return make("reference.sync", [issue.dataset], {
      title: issue.problem === "failed" ? `The ${what} sync failed` : `The ${what} sync stopped responding`,
      detail: issue.problem === "failed" ? (errorLine(issue.message) ?? "It stopped with an error.") : "Its worker has been silent for more than 30 minutes. Start it again from Reference data.",
      href: "/reference",
      since: issue.at,
    });
  });
}

async function securityAlerts(): Promise<Alert[]> {
  const s = await securityFacts();
  const out: Alert[] = [];
  if (s.production && s.twoFactor === "off") {
    out.push(
      make("staff.twofactor-off", [], {
        title: "Staff two-factor is off in production",
        detail: "A password alone opens the console. An owner can require an authenticator again from Staff.",
        href: "/staff",
      }),
    );
  }
  if (s.twoFactor === "required" && s.withoutAuthenticator) {
    const n = s.withoutAuthenticator;
    out.push(
      make("staff.no-2fa", [], {
        title: `${plural(n, "staff member")} ${n === 1 ? "has" : "have"} no authenticator`,
        detail: "Two-factor is required, so each is asked to set one up at the next sign-in.",
        href: "/staff?status=active",
      }),
    );
  }
  if (s.production && !s.mailServer) {
    out.push(
      make("mail.unconfigured", [], {
        title: "No mail server is set in production",
        detail: "Signup codes, password links and billing reminders are written to platform-outbox/, and nobody receives them.",
        href: "/health#configuration",
      }),
    );
  }
  return out;
}

type SeatRow = { tenantId: string; slug: string; name: string; day: Date | string; seatsUsed: number | bigint; seatsLimit: number | bigint };

/**
 * Open workspaces using more seats than their limit when last counted — the rule of `overLimit().seats`
 * (src/lib/platform/usage.ts), worked out in the database so only the few over it come back.
 */
async function seatAlerts(): Promise<Alert[]> {
  const rows = await controlDb().$queryRaw<SeatRow[]>`
    SELECT l."tenantId", t."slug", t."name", l."day", l."seatsUsed", l."seatsLimit"
    FROM (
      SELECT DISTINCT ON ("tenantId") "tenantId", "day", "seatsUsed", "seatsLimit"
      FROM "tenant_usage"
      ORDER BY "tenantId", "day" DESC
    ) l
    JOIN "tenants" t ON t."id" = l."tenantId"
    WHERE t."status" = 'ACTIVE' AND l."seatsLimit" IS NOT NULL AND l."seatsUsed" > l."seatsLimit"
    ORDER BY l."seatsUsed" - l."seatsLimit" DESC, t."slug" ASC
    LIMIT 200`;
  return rows.map((r) => {
    // A date column: a Date at midnight UTC of the day it holds, or that day as text.
    const dayKey = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
    const used = Number(r.seatsUsed);
    const limit = Number(r.seatsLimit);
    return make("seats.over", [part(r.tenantId), dayKey], {
      title: `${r.slug} uses ${used} of ${limit} seats`,
      detail: `${plural(used - limit, "seat")} over its limit when counted on ${dayKeyLabel(dayKey, false)}.`,
      href: workspaceHref(r.slug, "usage"),
      since: startOfIndianDay(dayKey),
      tenant: { id: r.tenantId, slug: r.slug, name: r.name },
    });
  });
}

async function purgeAlerts({ now }: Ctx): Promise<Alert[]> {
  const rows = await controlDb().tenant.findMany({
    // Keys still kept: purging empties the sealed bundle (src/lib/platform/lifecycle.ts). Compared in the database, never read.
    where: { status: "DEPROVISIONED", deprovisionedAt: { lt: new Date(now.getTime() - RETENTION_DAYS * DAY) }, keyBundleCipher: { not: "" } },
    orderBy: { deprovisionedAt: "asc" },
    take: 50,
    select: { ...TENANT_REF, deprovisionedAt: true },
  });
  return rows.flatMap((t) => {
    if (!t.deprovisionedAt) return [];
    const due = new Date(t.deprovisionedAt.getTime() + RETENTION_DAYS * DAY);
    return [
      make("purge.due", [part(t.id)], {
        title: `${t.slug} can be purged`,
        detail: `Closed on ${dayMonthYear(t.deprovisionedAt)}; its ${RETENTION_DAYS} days of retention ended on ${dayMonthYear(due)}. Purging deletes its keys and final backups: npm run platform:tenant -- purge ${t.slug} on the server.`,
        href: "/workspaces?view=closed",
        since: due,
        tenant: { id: t.id, slug: t.slug, name: t.name },
      }),
    ];
  });
}

async function grantAlerts({ now }: Ctx): Promise<Alert[]> {
  const control = controlDb();
  const grants = await control.supportAccessGrant.findMany({
    where: { revokedAt: null, expiresAt: { gt: now } },
    orderBy: { expiresAt: "asc" },
    take: 50,
    select: { id: true, tenantId: true, level: true, grantedByName: true, createdAt: true, expiresAt: true },
  });
  if (!grants.length) return [];
  const tenants = await control.tenant.findMany({ where: { id: { in: [...new Set(grants.map((g) => g.tenantId))] }, status: { not: "DEPROVISIONED" } }, select: TENANT_REF });
  const byId = new Map(tenants.map((t) => [t.id, t]));
  return grants.flatMap((g) => {
    const tenant = byId.get(g.tenantId);
    if (!tenant) return [];
    const by = cleanText(g.grantedByName, 80) || "its super admin";
    return [
      make("grant.live", [part(g.id)], {
        title: `${tenant.slug} has let support in — ${grantLabel("live", g.level).label.toLowerCase()}`,
        detail: `Granted by ${by}; it ends ${when(g.expiresAt)}.`,
        href: workspaceHref(tenant.slug, "support"),
        since: g.createdAt,
        tenant,
      }),
    ];
  });
}

type StuckCounts = { neverVerified: number | bigint | null; setupStuck: number | bigint | null; neverLanded: number | bigint | null; total: number | bigint | null };

/**
 * Signups that stopped on the way (features F20): the emailed code never entered and expired (within
 * the last seven days); verified, but the workspace still being set up after half an hour or its setup
 * failed; set up, but the owner never handed in to it after an hour. Counted in one read — the rows
 * themselves are the signups page's. Times go in as text read as `timestamp`, the UTC wall-clock the
 * columns hold, so the session's time zone never shifts a bound.
 */
async function signupAlerts({ now }: Ctx): Promise<Alert[]> {
  const before = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const [row] = await controlDb().$queryRaw<StuckCounts[]>`
    WITH s AS (
      SELECT
        (p."verifiedAt" IS NULL AND p."codeExpiresAt" < ${now.toISOString()}::timestamp AND p."createdAt" >= ${before(7 * DAY)}::timestamp) AS "neverVerified",
        (p."verifiedAt" IS NOT NULL AND t."status" <> 'DEPROVISIONED'
          AND ((t."status" = 'PROVISIONING' AND p."createdAt" < ${before(30 * 60_000)}::timestamp) OR j."status" = 'FAILED')) AS "setupStuck",
        (t."status" = 'ACTIVE' AND p."handedOffAt" IS NULL AND p."createdAt" < ${before(60 * 60_000)}::timestamp) AS "neverLanded"
      FROM "pending_signups" p
      LEFT JOIN "tenants" t ON t."id" = p."tenantId"
      LEFT JOIN LATERAL (
        SELECT "status" FROM "provisioning_jobs" WHERE "tenantId" = p."tenantId" ORDER BY "createdAt" DESC LIMIT 1
      ) j ON true
    )
    SELECT
      COUNT(*) FILTER (WHERE "neverVerified")::int AS "neverVerified",
      COUNT(*) FILTER (WHERE "setupStuck")::int AS "setupStuck",
      COUNT(*) FILTER (WHERE "neverLanded")::int AS "neverLanded",
      COUNT(*) FILTER (WHERE "neverVerified" OR "setupStuck" OR "neverLanded")::int AS "total"
    FROM s`;
  const n = (v: number | bigint | null | undefined) => Number(v ?? 0);
  const total = n(row?.total);
  if (!total) return [];
  const [code, setup, landed] = [n(row?.neverVerified), n(row?.setupStuck), n(row?.neverLanded)];
  const parts = [
    code ? `${code} never entered the emailed code` : null,
    setup ? `${setup} ${isOrAre(setup)} stuck in setup` : null,
    landed ? `${landed} never signed in to ${landed === 1 ? "its" : "their"} workspace` : null,
  ].filter((p): p is string => !!p);
  return [
    make("signups.stuck", [], {
      title: `${plural(total, "signup")} ${isOrAre(total)} stuck`,
      detail: `${parts.join("; ")}.`,
      href: "/signups",
    }),
  ];
}

// Billing — read only for the staff who sell.

async function dailyAlerts({ now }: Ctx): Promise<Alert[]> {
  const d = await dailyChores(now);
  if (d.state !== "late" && d.state !== "never") return [];
  return [
    make("daily.stale", [], {
      title: d.ranOn ? `The daily billing chores haven't run since ${dayKeyLabel(d.ranOn, false)}` : "The daily billing chores have never run",
      detail: "Subscriptions are read back from the gateways, and usage counted, with the first platform tick of each day.",
      href: "/health",
      since: d.at,
    }),
  ];
}

async function webhookAlerts(): Promise<Alert[]> {
  const control = controlDb();
  const events = await control.billingEvent.findMany({
    where: { processedAt: null, error: { not: null } },
    orderBy: { receivedAt: "desc" },
    take: 20,
    select: { id: true, gateway: true, type: true, tenantId: true, receivedAt: true, error: true },
  });
  if (!events.length) return [];
  const ids = [...new Set(events.map((e) => e.tenantId).filter((id): id is string => !!id))];
  const tenants = ids.length ? await control.tenant.findMany({ where: { id: { in: ids } }, select: TENANT_REF }) : [];
  const byId = new Map(tenants.map((t) => [t.id, t]));
  return events.map((e) => {
    const tenant = (e.tenantId && byId.get(e.tenantId)) || null;
    const type = cleanText(e.type, 80) || "An event";
    return make("webhook.failed", [part(e.id)], {
      title: `A ${gatewayLabel(e.gateway)} webhook failed${tenant ? ` for ${tenant.slug}` : ""}`,
      detail: `${type}: ${errorLine(e.error) ?? "it could not be applied"}.`,
      href: "/billing?tab=events&state=failed",
      since: e.receivedAt,
      tenant,
    });
  });
}

async function exemptAlerts(): Promise<Alert[]> {
  const tenants = await controlDb().tenant.findMany({
    where: {
      isDefault: false,
      status: { not: "DEPROVISIONED" },
      AND: [
        { subscriptions: { some: { gateway: "MANUAL", status: "ACTIVE" } } },
        { subscriptions: { some: { gateway: { in: ["STRIPE", "RAZORPAY"] }, status: { in: [...LIVE_STATUSES] } } } },
      ],
    },
    orderBy: { slug: "asc" },
    take: CAP,
    select: TENANT_REF,
  });
  return tenants.map((t) =>
    make("billing.exempt-while-paying", [part(t.id)], {
      title: `${t.slug} pays through a gateway and also has a plan given by hand`,
      detail: "While the hand-given plan is active, what it owes is never enforced. End the hand-given plan from its Plan tab.",
      href: workspaceHref(t.slug, "plan"),
      tenant: t,
    }),
  );
}

async function pastDueAlerts({ now }: Ctx): Promise<Alert[]> {
  const subs = await controlDb().subscription.findMany({
    where: {
      gateway: { not: "MANUAL" },
      status: "PAST_DUE",
      // A plan given by hand makes it exempt: nothing is held for it (the exempt-while-paying alert says so instead).
      tenant: { isDefault: false, status: { in: ["ACTIVE", "SUSPENDED"] }, subscriptions: { none: { gateway: "MANUAL", status: "ACTIVE" } } },
    },
    take: 500,
    select: { pastDueSince: true, updatedAt: true, tenant: { select: { ...TENANT_REF, status: true } } },
  });
  // The earliest failure of each workspace's subscriptions sets its hold, as its standing does (src/lib/billing/lifecycle.ts).
  const byTenant = new Map<string, { tenant: TenantRef & { status: string }; since: Date }>();
  for (const s of subs) {
    // Without a recorded start, the row's last change stands in — never "now", which would move the key on every read.
    const since = s.pastDueSince ?? s.updatedAt;
    const seen = byTenant.get(s.tenant.id);
    if (!seen || since < seen.since) byTenant.set(s.tenant.id, { tenant: s.tenant, since });
  }
  return [...byTenant.values()].map(({ tenant, since }) => {
    const holdAt = new Date(since.getTime() + PAST_DUE_GRACE_DAYS * DAY);
    const { status, ...ref } = tenant;
    const title =
      holdAt > now
        ? `${ref.slug} is past due — it will be held on ${dayMonth(holdAt)}`
        : status === "SUSPENDED"
          ? `${ref.slug} is past due and held`
          : `${ref.slug} is past due — its hold was due on ${dayMonth(holdAt)}`;
    const next = holdAt <= now && status !== "SUSPENDED" ? " The next platform tick holds it." : "";
    return make("past-due", [part(ref.id), istDayKey(holdAt)], {
      title,
      detail: `A payment failed on ${dayMonth(since)}, and the gateway keeps retrying it.${next}`,
      href: workspaceHref(ref.slug, "billing"),
      since,
      tenant: ref,
    });
  });
}

async function closeAlerts({ now }: Ctx): Promise<Alert[]> {
  const held = await controlDb().tenant.findMany({
    where: { status: "SUSPENDED", suspendedFor: "BILLING", suspendedAt: { lt: new Date(now.getTime() - (CLOSE_AFTER_DAYS - CLOSE_WARNING_DAYS) * DAY) } },
    orderBy: { suspendedAt: "asc" },
    take: CAP,
    select: { ...TENANT_REF, suspendedAt: true },
  });
  if (!held.length) return [];
  const [standings, autoClose] = await Promise.all([billingStandings(held.map((t) => t.id), now), autoDeprovision()]);
  return held.flatMap((t) => {
    // Closing acts only on a workspace whose plan has lapsed (`plannedAction`); one still retrying a payment stays held.
    if (!t.suspendedAt || standings.get(t.id)?.kind !== "lapsed") return [];
    const closeAt = new Date(t.suspendedAt.getTime() + CLOSE_AFTER_DAYS * DAY);
    const ref = { id: t.id, slug: t.slug, name: t.name };
    const base = { href: workspaceHref(t.slug, "billing"), since: t.suspendedAt, tenant: ref };
    if (!autoClose) {
      return [
        make("close.due", [part(t.id)], {
          ...base,
          severity: "info",
          title: `${t.slug} has been held for billing for ${forHowLong(now.getTime() - t.suspendedAt.getTime())}`,
          detail: "Closing on its own is off, so it stays held until staff decide.",
        }),
      ];
    }
    return [
      make("close.due", [part(t.id)], {
        ...base,
        title: closeAt > now ? `${t.slug} is due to be closed automatically on ${dayMonth(closeAt)}` : `${t.slug} is due to be closed automatically at the next platform tick`,
        detail: `Held for billing since ${dayMonth(t.suspendedAt)}. Paying again lifts the hold.`,
      }),
    ];
  });
}

async function gatewayAlerts(): Promise<Alert[]> {
  const sets = await gatewayKeySets();
  return (["stripe", "razorpay"] as const)
    .filter((g) => sets[g].state === "partial")
    .map((g) =>
      make("gateway.keys.partial", [g], {
        title: `${g === "stripe" ? "Stripe" : "Razorpay"} keys are incomplete`,
        detail: `Missing ${sets[g].missing.join(" and ")}. Payments are not recorded until every key is saved.`,
        href: "/settings#gateways",
      }),
    );
}

// ─── Putting them together ───────────────────────────────────────────────────────────────────────

/** A source that cannot be read is left out, not fatal — logged, with its error redacted. */
async function soft<T>(what: string, fallback: T, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    console.error(`[alerts] ${what} could not be read: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
    return fallback;
  }
}

/** Every alert `role` may see, acknowledged or not, each key once. */
async function derive(role: ConsoleRole, now: Date): Promise<Alert[]> {
  const seller = hasRole(role, SELLERS);
  const ctx: Ctx = { now };
  const sources: [string, (ctx: Ctx) => Promise<Alert[]>][] = [
    ["setups", setupAlerts],
    ["the warm pool", warmAlerts],
    ["migrations", migrationAlerts],
    ["the platform tick", tickAlerts],
    ["scheduled jobs", jobAlerts],
    ["trials", trialAlerts],
    ["reference syncs", referenceAlerts],
    ["security", securityAlerts],
    ["seats", seatAlerts],
    ["closed workspaces", purgeAlerts],
    ["support grants", grantAlerts],
  ];
  // The signups page is theirs alone (decision D2); the count would lead anybody else to a page they cannot open.
  if (hasRole(role, SIGNUP_VIEWERS)) sources.push(["signups", signupAlerts]);
  if (seller) {
    sources.push(
      ["daily chores", dailyAlerts],
      ["webhooks", webhookAlerts],
      ["hand-given plans", exemptAlerts],
      ["past-due subscriptions", pastDueAlerts],
      ["billing holds", closeAlerts],
      ["gateway keys", gatewayAlerts],
    );
  }
  const lists = await Promise.all(sources.map(([what, source]) => soft(what, [] as Alert[], () => source(ctx))));
  const seen = new Set<string>();
  const out: Alert[] = [];
  for (const alert of lists.flat()) {
    if (seen.has(alert.key) || (alert.category === "billing" && !seller)) continue;
    seen.add(alert.key);
    out.push(alert);
  }
  return out;
}

type AckRow = { key: string; ackedBy: string; ackedAt: Date; snoozeUntil: Date | null; note: string | null };

async function readAcks(keys: string[]): Promise<Map<string, AckRow>> {
  const acks = new Map<string, AckRow>();
  for (let i = 0; i < keys.length; i += 1000) {
    const rows = await controlDb().platformAlertAck.findMany({
      where: { key: { in: keys.slice(i, i + 1000) } },
      select: { key: true, ackedBy: true, ackedAt: true, snoozeUntil: true, note: true },
    });
    for (const r of rows) acks.set(r.key, r);
  }
  return acks;
}

/** Hidden: acknowledged for good (an instance), or put off until a time still to come. */
function hides(ack: AckRow, instance: boolean, now: Date): boolean {
  return ack.snoozeUntil === null ? instance : ack.snoozeUntil > now;
}

/** Critical first, then warning, then info; within each, conditions (no date) first, then the newest. */
function bySeverity(a: Alert, b: Alert): number {
  if (RANK[a.severity] !== RANK[b.severity]) return RANK[a.severity] - RANK[b.severity];
  if (a.since === null || b.since === null) {
    if (a.since !== b.since) return a.since === null ? -1 : 1;
  } else if (a.since.getTime() !== b.since.getTime()) {
    return b.since.getTime() - a.since.getTime();
  }
  return a.key.localeCompare(b.key);
}

/** Splits alerts into open and acknowledged-or-put-off, the latter with who did it (by name when `named`). */
async function withAcks(list: Alert[], now: Date, named: boolean): Promise<{ open: Alert[]; acked: Alert[] }> {
  const acks = list.length ? await soft("acknowledgements", new Map<string, AckRow>(), () => readAcks(list.map((a) => a.key))) : new Map<string, AckRow>();
  const hidden = list.filter((a) => {
    const ack = acks.get(a.key);
    return !!ack && hides(ack, a.instance, now);
  });
  const staff = named && hidden.length ? [...new Set(hidden.map((a) => acks.get(a.key)!.ackedBy))] : [];
  const names = staff.length ? await soft("staff names", new Map<string, string>(), () => staffNameMap(staff)) : new Map<string, string>();
  const hiddenKeys = new Set(hidden.map((a) => a.key));
  const open = list.filter((a) => !hiddenKeys.has(a.key)).sort(bySeverity);
  const acked = hidden
    .map((a) => {
      const ack = acks.get(a.key)!;
      return { ...a, ack: { by: ack.ackedBy, byName: names.get(ack.ackedBy) ?? ack.ackedBy, at: ack.ackedAt, snoozeUntil: ack.snoozeUntil, note: ack.note } };
    })
    .sort(bySeverity);
  return { open, acked };
}

function countOf(list: Alert[]): { critical: number; warning: number; info: number } {
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const a of list) counts[a.severity] += 1;
  return counts;
}

/**
 * Every alert `role` may see: open ones, and those acknowledged or put off (with who and until when).
 * Billing alerts only for the staff who sell. Each list holds at most 200; the counts are of every open one.
 */
export async function alerts(role: ConsoleRole, now = new Date()): Promise<AlertList> {
  const { open, acked } = await withAcks(await derive(role, now), now, true);
  return { asOf: now, open: open.slice(0, CAP), acked: acked.slice(0, CAP), counts: countOf(open) };
}

/** How many open alerts there are of each severity — for the nav badge, on every console page. */
export async function alertCounts(role: ConsoleRole, now = new Date()): Promise<{ critical: number; warning: number; info: number }> {
  const { open } = await withAcks(await derive(role, now), now, false);
  return countOf(open);
}

/** One workspace's open alerts, most severe first — for its own page. */
export async function alertsForTenant(tenantId: string, role: ConsoleRole, now = new Date()): Promise<Alert[]> {
  const id = String(tenantId);
  const mine = (await derive(role, now)).filter((a) => a.tenant?.id === id);
  const { open } = await withAcks(mine, now, false);
  return open.slice(0, CAP);
}

/**
 * The list as the Alerts page filters it: severity, category, and a search over the workspace, the
 * title and the detail. With `showAcked`, the acknowledged and put-off ones follow the open ones.
 */
export function filterAlerts(list: AlertList, f: AlertFilters): Alert[] {
  const q = f.q?.trim().toLowerCase();
  const matches = (a: Alert) =>
    !q || [a.tenant?.slug, a.tenant?.name, a.title, a.detail].some((text) => typeof text === "string" && text.toLowerCase().includes(q));
  return (f.showAcked ? [...list.open, ...list.acked] : list.open).filter(
    (a) => (!f.severity || a.severity === f.severity) && (!f.category || a.category === f.category) && matches(a),
  );
}
