import { mailConfigured } from "@/lib/platform/mail/store";
import { compactNumber, dayKeyLabel, plural } from "@/lib/console-shared/format";
import { jobLabel, schemaLabel } from "@/lib/console-shared/labels";
import { redactSecrets } from "@/lib/console-shared/redact";
import { PIN_DIRECTORY_KEY } from "@/lib/geo/pincode";
import { consoleClock } from "@/lib/platform/console-clock";
import { platformEnv } from "@/lib/platform/console-page";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { platformKeyConfigured } from "@/lib/platform/kek";
import { latestMigrationName } from "@/lib/platform/migrate";
import { WARM_POOL_SIZE } from "@/lib/platform/provisioning";
import { refDb, referenceConfigured } from "@/lib/platform/reference-db";
import { readPinDirectory, readWorldPlaces } from "@/lib/platform/reference-sync";
import { gatewayModes, secretsSet, staffTwoFactorPolicy, type GatewayMode, type SecretKey } from "@/lib/platform/settings";
import type { Clock } from "@/lib/time/zone";

/**
 * The platform's own health, read for the console's System health page (/health): whether the
 * scheduled work runs, whether workspaces are being set up, whether every schema is current, whether
 * the gateways are wired, whether the reference data syncs, whether staff sign-in is as safe as it
 * should be, and which settings the environment carries.
 *
 * Read-only, from the control plane (and the reference database, fail-soft). A check that cannot be
 * worked out says so as a failing row instead of taking the page down with it. Nothing secret leaves
 * here: environment variables only as set or not, gateway keys only as set or not and their mode, and
 * every error text through `redactSecrets` — redacted before it is cut, so a cut cannot split a secret
 * past recognising.
 *
 * The small reads at the top (the tick, the daily chores, schema drift, the warm pool, gateway keys,
 * security, reference syncs, failing jobs) are shared with the derived alerts (src/lib/platform/
 * alerts.ts), so the board and the alerts never disagree about what is wrong.
 */

export type HealthGroup = "background" | "provisioning" | "schemas" | "billing" | "reference" | "security" | "configuration";
export type HealthStatus = "ok" | "warn" | "fail" | "off";
export type HealthCheck = { key: string; group: HealthGroup; label: string; status: HealthStatus; detail: string; since: Date | null; href: string | null };

export type FailingJob = {
  tenantId: string;
  /** Null for a workspace with no control-plane row (one read from the environment): its id shows raw. */
  slug: string | null;
  name: string | null;
  job: string;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  /** Redacted. */
  lastError: string | null;
  runningNow: boolean;
};
export type FailingJobSummary = { job: string; label: string; workspaces: number; slugs: string[]; lastError: string | null; lastAt: Date | null };
export type PlatformLease = {
  job: string;
  label: string;
  /** Which process holds or last held it: host and pid. */
  holder: string;
  leasedUntil: Date;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastOk: boolean | null;
  /** Redacted. */
  lastError: string | null;
  runningNow: boolean;
};
export type PresenceRow = { key: string; label: string; set: boolean; note: string | null };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The lines the board draws — shared with the alerts, so both call the same thing late. */
export const HEALTH_LIMITS = {
  /** The platform tick is meant to run every hour: two hours without a finished run is late, six is stale. */
  tickLateMs: 2 * HOUR,
  tickStaleMs: 6 * HOUR,
  /** A setup RUNNING this long belonged to a worker that died (src/lib/platform/provisioning.ts takes it again). */
  setupRunningMs: 30 * MINUTE,
  /** A setup PENDING this long past its run-after: no worker is taking jobs. */
  setupWaitingMs: 10 * MINUTE,
  /** A reference sync RUNNING this long is a worker that died — the rule src/lib/platform/reference-sync.ts claims by. */
  syncStaleMs: 30 * MINUTE,
} as const;
const { tickLateMs: TICK_LATE_MS, tickStaleMs: TICK_STALE_MS, setupRunningMs: SETUP_RUNNING_MS, setupWaitingMs: SETUP_WAITING_MS, syncStaleMs: SYNC_STALE_MS } = HEALTH_LIMITS;
/** GeoNames' sync row (src/lib/platform/reference-sync.ts, prisma/reference/geonames-worker.ts). */
const WORLD_SYNC_KEY = "geonames";
/** How many failing leases one read looks at. */
const FAILING_TAKE = 100;

// ─── Wording ─────────────────────────────────────────────────────────────────────────────────────

/** "12 minutes", "7 hours", "3 days" — a span in its largest whole unit. */
export function forHowLong(ms: number): string {
  const n = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (n < HOUR) return plural(Math.max(1, Math.floor(n / MINUTE)), "minute");
  if (n < 2 * DAY) return plural(Math.floor(n / HOUR), "hour");
  return plural(Math.floor(n / DAY), "day");
}

function ago(at: Date, now: Date): string {
  const ms = now.getTime() - at.getTime();
  return ms < MINUTE ? "just now" : `${forHowLong(ms)} ago`;
}

/**
 * One line of an error, for a row or a card: redacted first and cut after, so a cut can never leave
 * half a secret the patterns no longer recognise. The full (redacted) text is kept where the row has it.
 */
export function errorLine(text: string | null | undefined, max = 200): string | null {
  const clean = redactSecrets(text);
  if (!clean) return null;
  const line = clean
    .split("\n")
    .map((s) => s.trim())
    .find(Boolean);
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const isOrAre = (n: number) => (n === 1 ? "is" : "are");
const hasOrHave = (n: number) => (n === 1 ? "has" : "have");

// ─── Shared reads (the board and the alerts) ─────────────────────────────────────────────────────

type LeaseRow = { holder: string; leasedUntil: Date; lastStartedAt: Date | null; lastFinishedAt: Date | null; lastOk: boolean | null; lastError: string | null };
const LEASE_SELECT = { holder: true, leasedUntil: true, lastStartedAt: true, lastFinishedAt: true, lastOk: true, lastError: true } as const;

export type TickStatus = {
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastOk: boolean | null;
  /** Redacted. */
  lastError: string | null;
  /** Its lease is held right now. */
  runningNow: boolean;
  /** It has never finished a run. */
  never: boolean;
  /** Since it last finished; null when it never has. */
  ageMs: number | null;
  /** Never run, or last finished more than six hours ago — and not running now. */
  stale: boolean;
  /** Last finished more than two hours ago, and not running now. */
  late: boolean;
  /** Its last run ended in an error. */
  failed: boolean;
};

function tickStatusOf(row: LeaseRow | null | undefined, now: Date): TickStatus {
  const runningNow = !!row && row.leasedUntil > now;
  const lastFinishedAt = row?.lastFinishedAt ?? null;
  const ageMs = lastFinishedAt ? Math.max(0, now.getTime() - lastFinishedAt.getTime()) : null;
  return {
    lastStartedAt: row?.lastStartedAt ?? null,
    lastFinishedAt,
    lastOk: row?.lastOk ?? null,
    lastError: redactSecrets(row?.lastError),
    runningNow,
    never: lastFinishedAt === null,
    ageMs,
    stale: !runningNow && (ageMs === null || ageMs > TICK_STALE_MS),
    late: !runningNow && ageMs !== null && ageMs > TICK_LATE_MS,
    failed: row?.lastOk === false,
  };
}

/** The platform tick's lease (/api/platform/tick): when it last ran, how it ended, whether it runs now. */
export async function platformTick(now = new Date()): Promise<TickStatus> {
  const row = await controlDb().tenantJobLease.findUnique({ where: { tenantId_job: { tenantId: "platform", job: "platform-tick" } }, select: LEASE_SELECT });
  return tickStatusOf(row, now);
}

export type DailyChores = {
  /** The day it last ran, on the console's clock ("2026-09-27"); null when it never has. */
  ranOn: string | null;
  /** When that was recorded. */
  at: Date | null;
  /** "late": before yesterday. */
  state: "today" | "yesterday" | "late" | "never";
};

/** Yesterday's `yyyy-mm-dd` on `clock` — by the calendar, so a clock change never makes it two days back. */
function yesterdayOn(clock: Clock, now: Date): string {
  const { year, month, day } = clock.parts(now);
  return clock.dateKey(clock.midnight(year, month, day - 1));
}

/**
 * The once-a-day billing work the first tick of each day does (reading subscriptions back, usage
 * snapshots) — a day on the console's clock (`clock`), as the tick records it.
 */
export async function dailyChores(now: Date, clock: Clock): Promise<DailyChores> {
  const row = await controlDb().platformSetting.findUnique({ where: { key: "billing.dailyRanOn" }, select: { value: true, updatedAt: true } });
  const ranOn = row?.value && /^\d{4}-\d{2}-\d{2}$/.test(row.value) ? row.value : null;
  if (!ranOn) return { ranOn: null, at: null, state: "never" };
  const today = clock.today(now);
  const yesterday = yesterdayOn(clock, now);
  return { ranOn, at: row?.updatedAt ?? null, state: ranOn >= today ? "today" : ranOn === yesterday ? "yesterday" : "late" };
}

export type SchemaDrift = {
  /** The newest workspace migration this build carries; null when it carries none (or the folder cannot be read). */
  latest: string | null;
  /** Open workspaces and those a migration holds — the ones a run migrates. */
  total: number;
  /** Of those, how many are not at `latest` (a workspace with no recorded schema counts as behind). */
  behind: number;
  /** Held at the maintenance page by a migration, oldest first. */
  migrating: { id: string; slug: string; name: string; since: Date }[];
  /** A migration run holds its lease right now. */
  runBusy: boolean;
};

function workspaceLatest(): string | null {
  try {
    return latestMigrationName("workspace");
  } catch {
    return null;
  }
}

export async function schemaDrift(now = new Date()): Promise<SchemaDrift> {
  const control = controlDb();
  const latest = workspaceLatest();
  const migratable = { status: { in: ["ACTIVE" as const, "MIGRATING" as const] } };
  const [total, behind, migrating, lease] = await Promise.all([
    control.tenant.count({ where: migratable }),
    // `NOT: { schemaVersion: latest }` alone would drop the rows with no version at all.
    latest ? control.tenant.count({ where: { ...migratable, OR: [{ schemaVersion: null }, { schemaVersion: { not: latest } }] } }) : Promise.resolve(0),
    control.tenant.findMany({ where: { status: "MIGRATING" }, orderBy: { updatedAt: "asc" }, take: 200, select: { id: true, slug: true, name: true, updatedAt: true } }),
    control.tenantJobLease.findUnique({ where: { tenantId_job: { tenantId: "platform", job: "migrate" } }, select: { leasedUntil: true } }),
  ]);
  return {
    latest,
    total,
    behind,
    migrating: migrating.map((t) => ({ id: t.id, slug: t.slug, name: t.name, since: t.updatedAt })),
    runBusy: !!lease && lease.leasedUntil > now,
  };
}

/** How many ready databases the worker keeps (PLATFORM_WARM_POOL, default 2); 0 turns the pool off. */
function warmTarget(): number {
  return Number.isFinite(WARM_POOL_SIZE) ? Math.max(0, Math.floor(WARM_POOL_SIZE)) : 0;
}

export async function warmPool(): Promise<{ ready: number; target: number }> {
  const ready = await controlDb().warmDatabase.count({ where: { claimedAt: null } });
  return { ready, target: warmTarget() };
}

export type KeySet = {
  /** "partial": some of its keys saved and not the rest. */
  state: "none" | "partial" | "complete";
  /** What is missing, in words ("the webhook signing secret"); empty unless partial. */
  missing: string[];
  /** Which of its keys are saved, in words. */
  saved: string[];
};

const KEY_WORDS: Record<SecretKey, string> = {
  "stripe.secretKey": "the secret key",
  "stripe.webhookSecret": "the webhook signing secret",
  "razorpay.keyId": "the key id",
  "razorpay.keySecret": "the key secret",
  "razorpay.webhookSecret": "the webhook secret",
};
const GATEWAY_KEYS: { stripe: readonly SecretKey[]; razorpay: readonly SecretKey[] } = {
  stripe: ["stripe.secretKey", "stripe.webhookSecret"],
  razorpay: ["razorpay.keyId", "razorpay.keySecret", "razorpay.webhookSecret"],
};

/** Each gateway's keys as saved or not (`secretsSet`) — nothing about a key but that. */
export async function gatewayKeySets(): Promise<{ stripe: KeySet; razorpay: KeySet }> {
  const set = await secretsSet();
  const of = (keys: readonly SecretKey[]): KeySet => {
    const saved = keys.filter((k) => set[k]);
    const state = saved.length === 0 ? "none" : saved.length === keys.length ? "complete" : "partial";
    return { state, missing: state === "partial" ? keys.filter((k) => !set[k]).map((k) => KEY_WORDS[k]) : [], saved: saved.map((k) => KEY_WORDS[k]) };
  };
  return { stripe: of(GATEWAY_KEYS.stripe), razorpay: of(GATEWAY_KEYS.razorpay) };
}

export type SecurityFacts = {
  /** This installation is production (PLATFORM_ENV, or the build — `platformEnv()`). */
  production: boolean;
  twoFactor: "required" | "off";
  /** An owner chose the policy, rather than it following the environment. */
  chosen: boolean;
  /** Active staff without an authenticator — counted only while two-factor is required. */
  withoutAuthenticator: number | null;
  /** Platform mail is sent, not written to platform-outbox/: Settings › Mail has a default account, or PLATFORM_SMTP_URL is set. */
  mailServer: boolean;
  /** PLATFORM_CONSOLE_IP_ALLOWLIST is set. */
  allowlist: boolean;
  /** TRUST_PROXY is 1 — the only value that turns it on (src/lib/client-ip.ts). */
  trustProxy: boolean;
};

export async function securityFacts(): Promise<SecurityFacts> {
  const policy = await staffTwoFactorPolicy();
  const withoutAuthenticator = policy.mode === "required" ? await controlDb().platformUser.count({ where: { active: true, totpEnabledAt: null } }) : null;
  return {
    production: platformEnv().key === "production",
    twoFactor: policy.mode,
    chosen: policy.chosen,
    withoutAuthenticator,
    mailServer: await mailConfigured(),
    allowlist: Boolean(process.env.PLATFORM_CONSOLE_IP_ALLOWLIST?.trim()),
    trustProxy: process.env.TRUST_PROXY?.trim() === "1",
  };
}

export type SyncIssue = {
  dataset: "pin" | "world";
  /** "stopped": RUNNING for longer than a sync takes — its worker died. */
  problem: "failed" | "stopped";
  /** Redacted. */
  message: string | null;
  at: Date | null;
};

function syncProblem(status: string, startedAt: Date | null, now: Date): SyncIssue["problem"] | null {
  if (status === "FAILED") return "failed";
  if (status === "RUNNING" && startedAt && now.getTime() - startedAt.getTime() > SYNC_STALE_MS) return "stopped";
  return null;
}

/**
 * The PIN directory's and world places' syncs that failed or stopped — one small read of their sync
 * rows (the datasets themselves are not counted here), so it is cheap enough for every page's alerts.
 * Empty without a reference database. Throws when the reference database cannot be reached: callers
 * decide how soft to be.
 */
export async function referenceSyncIssues(now = new Date()): Promise<SyncIssue[]> {
  if (!referenceConfigured()) return [];
  const rows = await refDb().referenceSync.findMany({
    where: { key: { in: [PIN_DIRECTORY_KEY, WORLD_SYNC_KEY] } },
    select: { key: true, status: true, startedAt: true, finishedAt: true, message: true },
  });
  const issues: SyncIssue[] = [];
  for (const r of rows) {
    const problem = syncProblem(r.status, r.startedAt, now);
    if (!problem) continue;
    issues.push({
      dataset: r.key === PIN_DIRECTORY_KEY ? "pin" : "world",
      problem,
      message: redactSecrets(r.message),
      at: problem === "failed" ? (r.finishedAt ?? r.startedAt) : r.startedAt,
    });
  }
  return issues.sort((a, b) => a.dataset.localeCompare(b.dataset));
}

// ─── Scheduled jobs ──────────────────────────────────────────────────────────────────────────────

/**
 * Scheduled jobs whose last run failed in a workspace — backups, the marketing heartbeat, usage
 * snapshots — newest failure first, at most a hundred. A closed workspace's are left out: its jobs
 * never run again, so its last failure would stand for ever. `name` is extra to the spec's shape.
 */
export async function failingJobs(now = new Date()): Promise<FailingJob[]> {
  const control = controlDb();
  const rows = await control.tenantJobLease.findMany({
    where: { lastOk: false, NOT: { tenantId: "platform" } },
    orderBy: { lastFinishedAt: "desc" },
    take: FAILING_TAKE,
    select: { tenantId: true, job: true, leasedUntil: true, lastStartedAt: true, lastFinishedAt: true, lastError: true },
  });
  if (!rows.length) return [];
  const tenants = await control.tenant.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.tenantId))] } },
    select: { id: true, slug: true, name: true, status: true },
  });
  const byId = new Map(tenants.map((t) => [t.id, t]));
  return rows
    .filter((r) => byId.get(r.tenantId)?.status !== "DEPROVISIONED")
    .map((r) => {
      const tenant = byId.get(r.tenantId);
      return {
        tenantId: r.tenantId,
        slug: tenant?.slug ?? null,
        name: tenant?.name ?? null,
        job: r.job,
        lastStartedAt: r.lastStartedAt,
        lastFinishedAt: r.lastFinishedAt,
        lastError: redactSecrets(r.lastError),
        runningNow: r.leasedUntil > now,
      };
    });
}

/**
 * Every scheduled job workspaces run, with how many are failing it — failing first, then the most
 * recent failure, then by name. `slugs` names the failing workspaces (a raw id for one with no row).
 */
export async function failingJobsSummary(now = new Date()): Promise<FailingJobSummary[]> {
  const [failing, jobs] = await Promise.all([
    failingJobs(now),
    controlDb().tenantJobLease.groupBy({ by: ["job"], where: { NOT: { tenantId: "platform" } }, _count: { _all: true } }),
  ]);
  const summaries = new Map<string, FailingJobSummary>();
  for (const { job } of jobs) summaries.set(job, { job, label: jobLabel(job), workspaces: 0, slugs: [], lastError: null, lastAt: null });
  // Newest failure first, so the first row of each job is the one its summary quotes.
  for (const f of failing) {
    const s = summaries.get(f.job) ?? { job: f.job, label: jobLabel(f.job), workspaces: 0, slugs: [], lastError: null, lastAt: null };
    if (s.workspaces === 0) {
      s.lastError = f.lastError;
      s.lastAt = f.lastFinishedAt;
    }
    s.workspaces += 1;
    s.slugs.push(f.slug ?? f.tenantId);
    summaries.set(f.job, s);
  }
  return [...summaries.values()].sort(
    (a, b) => b.workspaces - a.workspaces || (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0) || a.label.localeCompare(b.label),
  );
}

/** The platform's own leases — the tick, migration runs, the warm pool — by job. */
export async function platformLeases(now = new Date()): Promise<PlatformLease[]> {
  const rows = await controlDb().tenantJobLease.findMany({ where: { tenantId: "platform" }, orderBy: { job: "asc" }, select: { job: true, ...LEASE_SELECT } });
  return rows.map((r) => ({
    job: r.job,
    label: jobLabel(r.job),
    holder: r.holder,
    leasedUntil: r.leasedUntil,
    lastStartedAt: r.lastStartedAt,
    lastFinishedAt: r.lastFinishedAt,
    lastOk: r.lastOk,
    lastError: redactSecrets(r.lastError),
    runningNow: r.leasedUntil > now,
  }));
}

// ─── Configuration ───────────────────────────────────────────────────────────────────────────────

/**
 * A presence row with the board's verdict on it: `required` fails when unset; `misread` is set but not
 * taking effect (TRUST_PROXY other than 1, an unknown PLATFORM_ENV, an allowlist nobody can pass).
 */
type Presence = PresenceRow & { required: boolean; misread: boolean };

function presence(): Presence[] {
  const control = controlConfigured();
  const reference = referenceConfigured();
  const platformKey = platformKeyConfigured();
  const smtp = Boolean(process.env.PLATFORM_SMTP_URL?.trim());
  const mailFrom = Boolean(process.env.PLATFORM_MAIL_FROM?.trim());
  const tickSecret = Boolean(process.env.PLATFORM_TICK_SECRET?.trim());
  const provisioner = Boolean(process.env.PLATFORM_PROVISIONER_URL?.trim());
  const allowlist = Boolean(process.env.PLATFORM_CONSOLE_IP_ALLOWLIST?.trim());
  const trustProxySet = Boolean(process.env.TRUST_PROXY?.trim());
  const trustProxyOn = process.env.TRUST_PROXY?.trim() === "1";
  const envNamed = process.env.PLATFORM_ENV?.trim().toLowerCase();
  const envSet = Boolean(envNamed);
  const envKnown = envNamed === "production" || envNamed === "staging" || envNamed === "development";
  const warmSet = Boolean(process.env.PLATFORM_WARM_POOL?.trim());
  const env = platformEnv();
  const target = warmTarget();
  const row = (key: string, label: string, set: boolean, note: string | null, flags: { required?: boolean; misread?: boolean } = {}): Presence => ({
    key,
    label,
    set,
    note,
    required: flags.required ?? false,
    misread: flags.misread ?? false,
  });
  return [
    row("CONTROL_DATABASE_URL", "Control plane database", control, control ? null : "The console and every workspace lookup need it.", { required: true }),
    row("REFERENCE_DATABASE_URL", "Reference database", reference, reference ? null : "Address lookups by PIN and place are off."),
    row("PLATFORM_MASTER_KEY", "Platform key", platformKey, platformKey ? null : "Workspace keys and saved settings cannot be sealed or opened.", { required: true }),
    row("PLATFORM_SMTP_URL", "Mail server (fallback)", smtp, smtp ? "Used while Settings › Mail has no default account." : "Optional: mail accounts are set in Settings › Mail. Without one, or this, mail is written to platform-outbox/."),
    row("PLATFORM_MAIL_FROM", "Mail sender (fallback)", mailFrom, mailFrom ? "Used with the server setting above." : "Accounts in Settings › Mail name their own sender."),
    row("PLATFORM_TICK_SECRET", "Platform tick secret", tickSecret, tickSecret ? null : "The platform tick refuses every call, so it never runs."),
    row("PLATFORM_PROVISIONER_URL", "Provisioner login", provisioner, provisioner ? null : "New databases are made with the main database server's login — for development only."),
    row(
      "PLATFORM_CONSOLE_IP_ALLOWLIST",
      "Console network allowlist",
      allowlist,
      allowlist ? (trustProxyOn ? null : "It needs TRUST_PROXY=1, or nobody reaches the console.") : "Any network reaches the console's sign-in page.",
      { misread: allowlist && !trustProxyOn },
    ),
    row(
      "TRUST_PROXY",
      "Trust the reverse proxy",
      trustProxySet,
      trustProxySet ? (trustProxyOn ? null : "Only 1 turns it on.") : "Callers' addresses are not read from proxy headers.",
      { misread: trustProxySet && !trustProxyOn },
    ),
    row(
      "PLATFORM_ENV",
      "Environment name",
      envSet,
      envSet && envKnown
        ? `This is the ${env.label.toLowerCase()} installation.`
        : envSet
          ? `Not a name it knows — worked out from the build: ${env.label}.`
          : `Worked out from the build: ${env.label}.`,
      { misread: envSet && !envKnown },
    ),
    row("PLATFORM_WARM_POOL", "Warm pool size", warmSet, Number.isFinite(WARM_POOL_SIZE) ? `target ${target}` : "Not a number — the pool is not kept.", {
      misread: !Number.isFinite(WARM_POOL_SIZE),
    }),
  ];
}

/**
 * What the environment carries, as set or not — never a value. The databases and the platform key
 * through their own `…Configured()`; the rest by presence. The warm pool's size is the one number
 * shown, because it is a size and not a secret.
 */
export async function configurationPresence(): Promise<PresenceRow[]> {
  return presence().map(({ key, label, set, note }) => ({ key, label, set, note }));
}

// ─── The board ───────────────────────────────────────────────────────────────────────────────────

type Verdict = { status: HealthStatus; detail: string; since?: Date | null; href?: string | null };

/** One row of the board, worked out on its own: a check that throws becomes a failing row, not a failed page. */
async function check(key: string, group: HealthGroup, label: string, href: string | null, run: () => Promise<Verdict> | Verdict): Promise<HealthCheck> {
  try {
    const v = await run();
    return { key, group, label, status: v.status, detail: v.detail, since: v.since ?? null, href: v.href === undefined ? href : v.href };
  } catch (err) {
    const why = errorLine(err instanceof Error ? err.message : String(err)) ?? "unknown error";
    return { key, group, label, status: "fail", detail: `Could not be checked: ${why}`, since: null, href };
  }
}

function tickVerdict(t: TickStatus, now: Date): Verdict {
  if (t.failed) {
    const age = t.stale && t.ageMs !== null ? ` It last finished ${forHowLong(t.ageMs)} ago.` : "";
    return { status: "fail", detail: `Its last run failed: ${errorLine(t.lastError) ?? "no reason recorded"}.${age}`, since: t.lastFinishedAt };
  }
  if (t.never) {
    return t.runningNow
      ? { status: "ok", detail: "Running now, for the first time.", since: t.lastStartedAt }
      : { status: "fail", detail: "It has never run. Call /api/platform/tick every hour, with PLATFORM_TICK_SECRET.", since: null };
  }
  const finished = t.lastFinishedAt!;
  if (t.stale) return { status: "fail", detail: `Last finished ${ago(finished, now)} — it should run every hour.`, since: finished };
  if (t.late) return { status: "warn", detail: `Last finished ${ago(finished, now)} — it should run every hour.`, since: finished };
  return { status: "ok", detail: t.runningNow ? "Running now; its last run finished without errors." : `Last run finished ${ago(finished, now)}, without errors.`, since: finished };
}

function dailyVerdict(d: DailyChores): Verdict {
  switch (d.state) {
    case "today":
      return { status: "ok", detail: "Ran today.", since: d.at };
    case "yesterday":
      return { status: "ok", detail: "Ran yesterday; today's run comes with the next platform tick.", since: d.at };
    case "late":
      return { status: "warn", detail: `Last ran on ${dayKeyLabel(d.ranOn!)} — it runs with the first platform tick of each day.`, since: d.at };
    default:
      return { status: "warn", detail: "Never run — it runs with the first platform tick of each day.", since: null };
  }
}

async function usageVerdict(now: Date, clock: Clock): Promise<Verdict> {
  const newest = await controlDb().tenantUsage.aggregate({ _max: { day: true } });
  const day = newest._max.day;
  if (!day) return { status: "off", detail: "No usage has been recorded yet." };
  // A @db.Date comes back as midnight UTC of the calendar day it holds — a day on the console's clock.
  const key = day.toISOString().slice(0, 10);
  const since = clock.startOfDay(key);
  if (key >= clock.today(now)) return { status: "ok", detail: "Taken today.", since };
  if (key === yesterdayOn(clock, now)) return { status: "ok", detail: "Taken yesterday.", since };
  return { status: "warn", detail: `The newest is from ${dayKeyLabel(key)} — one is taken with each day's billing chores.`, since };
}

function migrateRunsVerdict(row: LeaseRow | undefined, now: Date): Verdict {
  if (!row) return { status: "off", detail: "No run recorded. A full run is npm run tenants:migrate on the server." };
  if (row.leasedUntil > now) return { status: "ok", detail: `Running now, started ${row.lastStartedAt ? ago(row.lastStartedAt, now) : "recently"}.`, since: row.lastStartedAt };
  if (row.lastOk === false) return { status: "warn", detail: `The last run stopped with an error: ${errorLine(row.lastError) ?? "no reason recorded"}.`, since: row.lastFinishedAt };
  return { status: "ok", detail: "The last run finished.", since: row.lastFinishedAt };
}

async function setupsFailedVerdict(): Promise<Verdict> {
  const failed = await controlDb().provisioningJob.aggregate({
    where: { status: "FAILED", tenant: { status: { not: "DEPROVISIONED" } } },
    _count: { _all: true },
    _max: { finishedAt: true },
  });
  const n = failed._count._all;
  if (!n) return { status: "ok", detail: "None failed." };
  return { status: "fail", detail: `${plural(n, "setup")} failed — try ${n === 1 ? "it" : "them"} again from Provisioning.`, since: failed._max.finishedAt };
}

async function setupsRunningVerdict(now: Date): Promise<Verdict> {
  const stale = await controlDb().provisioningJob.aggregate({
    where: { status: "RUNNING", startedAt: { lt: new Date(now.getTime() - SETUP_RUNNING_MS) } },
    _count: { _all: true },
    _min: { startedAt: true },
  });
  const n = stale._count._all;
  if (!n) return { status: "ok", detail: "None running for longer than a setup takes." };
  return { status: "warn", detail: `${plural(n, "setup")} ${hasOrHave(n)} been running for more than 30 minutes — the worker running ${n === 1 ? "it" : "them"} may have stopped.`, since: stale._min.startedAt };
}

async function waitingSetups(now: Date): Promise<{ n: number; since: Date | null }> {
  const waiting = await controlDb().provisioningJob.aggregate({
    where: { status: "PENDING", runAfter: { lt: new Date(now.getTime() - SETUP_WAITING_MS) } },
    _count: { _all: true },
    _min: { runAfter: true },
  });
  return { n: waiting._count._all, since: waiting._min.runAfter };
}

async function setupsWaitingVerdict(now: Date): Promise<Verdict> {
  const { n, since } = await waitingSetups(now);
  if (!n) return { status: "ok", detail: "None waiting longer than they should." };
  return { status: "warn", detail: `${plural(n, "setup")} ${hasOrHave(n)} waited more than 10 minutes to start — is the platform worker running?`, since };
}

function warmVerdict({ ready, target }: { ready: number; target: number }): Verdict {
  if (target === 0) return { status: "off", detail: "Turned off — each new workspace's database is made as it signs up." };
  if (ready >= target) return { status: "ok", detail: `${ready} of ${target} ready.` };
  return { status: "warn", detail: `${ready} of ${target} ready — signups wait while a database is made.` };
}

async function workerVerdict(pool: LeaseRow | undefined, now: Date): Promise<Verdict> {
  const [lastJob, waiting] = await Promise.all([controlDb().provisioningJob.aggregate({ _max: { finishedAt: true } }), waitingSetups(now)]);
  if (pool?.lastOk === false) return { status: "warn", detail: `Topping up the warm pool failed: ${errorLine(pool.lastError) ?? "no reason recorded"}.`, since: pool.lastFinishedAt };
  const times = [lastJob._max.finishedAt, pool?.lastFinishedAt].filter((d): d is Date => !!d);
  const last = times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null;
  if (waiting.n) return { status: "warn", detail: "Setups are waiting and it has not taken them. It runs as npm run platform:worker.", since: last };
  if (!last) return { status: "off", detail: "No sign of it yet. It runs as npm run platform:worker." };
  return { status: "ok", detail: `Last finished work ${ago(last, now)}.`, since: last };
}

async function controlSchemaVerdict(): Promise<Verdict> {
  let expected: string | null;
  try {
    expected = latestMigrationName("control");
  } catch {
    return { status: "warn", detail: "This build's control plane migrations could not be read." };
  }
  if (!expected) return { status: "off", detail: "This build carries no control plane migrations." };
  const rows = await controlDb().$queryRaw<{ name: string }[]>`
    SELECT "migration_name"::text AS "name" FROM "_prisma_migrations"
    WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
    ORDER BY "migration_name" DESC LIMIT 1`;
  const applied = rows[0]?.name ?? null;
  if (applied === expected) return { status: "ok", detail: `Up to date: ${schemaLabel(applied)}.` };
  const behind = !applied || applied < expected;
  return {
    status: "fail",
    detail: `The database is at ${schemaLabel(applied)}; the code expects ${schemaLabel(expected)}.${behind ? " Run npm run control:migrate on the server." : ""}`,
  };
}

function workspaceSchemasVerdict(d: SchemaDrift): Verdict {
  if (!d.latest) return { status: "off", detail: "This build carries no workspace migrations." };
  if (!d.total) return { status: "ok", detail: "No workspaces to migrate yet." };
  const running = d.runBusy ? " A migration run is going on now." : "";
  if (!d.behind) return { status: "ok", detail: `${d.total === 1 ? "The one workspace is" : `All ${plural(d.total, "workspace")} are`} at ${schemaLabel(d.latest)}.${running}` };
  return { status: "warn", detail: `${d.behind} of ${plural(d.total, "workspace")} ${isOrAre(d.behind)} behind ${schemaLabel(d.latest)}.${running}` };
}

function migratingVerdict(d: SchemaDrift): Verdict {
  const n = d.migrating.length;
  if (!n) return { status: "ok", detail: "None held." };
  const why = d.runBusy ? "while a migration runs" : "after a failed migration — people see the maintenance page until it is migrated again";
  return { status: "fail", detail: `${plural(n, "workspace")} ${isOrAre(n)} held ${why}.`, since: d.migrating[0].since };
}

const MODE_WORDS: Record<Exclude<GatewayMode, null>, string> = { test: "test keys", live: "live keys", unknown: "a key of a kind it does not recognise" };

function gatewayVerdict(name: "Stripe" | "Razorpay", keys: KeySet, mode: GatewayMode, lastWebhook: Date | null, production: boolean, now: Date): Verdict {
  const heard = lastWebhook ? ` Last webhook ${ago(lastWebhook, now)}.` : " No webhook received yet.";
  if (keys.state === "none") return { status: "off", detail: "Not connected.", since: lastWebhook };
  if (keys.state === "partial") {
    const words = keys.missing.join(" and ");
    return { status: "warn", detail: `Missing ${words} — payments at ${name} are not recorded here until every key is saved.`, since: lastWebhook };
  }
  if (mode === "unknown") return { status: "warn", detail: `Connected with ${MODE_WORDS.unknown} — check the key saved.${heard}`, since: lastWebhook };
  if (mode === "test" && production) return { status: "warn", detail: `Connected with test keys on the production installation — nobody is charged.${heard}`, since: lastWebhook };
  return { status: "ok", detail: `Connected with ${mode ? MODE_WORDS[mode] : "its keys"}.${heard}`, since: lastWebhook };
}

async function webhooksVerdict(): Promise<Verdict> {
  const control = controlDb();
  const [failing, last] = await Promise.all([
    control.billingEvent.aggregate({ where: { processedAt: null, error: { not: null } }, _count: { _all: true }, _max: { receivedAt: true } }),
    control.billingEvent.aggregate({ _max: { receivedAt: true } }),
  ]);
  const n = failing._count._all;
  if (n) return { status: "fail", detail: `${plural(n, "webhook")} failed to apply — replay ${n === 1 ? "it" : "them"} from Billing › Events.`, since: failing._max.receivedAt };
  if (!last._max.receivedAt) return { status: "off", detail: "None received yet." };
  return { status: "ok", detail: "None failing.", since: last._max.receivedAt };
}

async function lastWebhookAt(gateway: "STRIPE" | "RAZORPAY"): Promise<Date | null> {
  const row = await controlDb().billingEvent.findFirst({ where: { gateway }, orderBy: { receivedAt: "desc" }, select: { receivedAt: true } });
  return row?.receivedAt ?? null;
}

type SyncView = { status: string; startedAt: Date | null; finishedAt: Date | null; message: string | null };
const dateOf = (iso: string | null) => (iso ? new Date(iso) : null);

function syncVerdict(what: string, sync: SyncView, now: Date): Verdict | null {
  const problem = syncProblem(sync.status, sync.startedAt, now);
  if (problem === "failed") return { status: "warn", detail: `The last sync failed: ${errorLine(sync.message) ?? "no reason recorded"}.`, since: sync.finishedAt ?? sync.startedAt };
  if (problem === "stopped") return { status: "warn", detail: `The ${what} sync stopped responding — start it again from Reference data.`, since: sync.startedAt };
  return null;
}

async function pinVerdict(now: Date): Promise<Verdict> {
  if (!referenceConfigured()) return { status: "off", detail: "The reference database is not configured." };
  const pin = await readPinDirectory();
  const s = pin.sync;
  const problem = syncVerdict("PIN directory", { status: s.status, startedAt: dateOf(s.startedAt), finishedAt: dateOf(s.finishedAt), message: s.message }, now);
  if (problem) return problem;
  if (s.status === "RUNNING") return { status: "ok", detail: `Syncing now: ${compactNumber(s.fetched)}${s.total ? ` of ${compactNumber(s.total)}` : ""} fetched.`, since: dateOf(s.startedAt) };
  if (pin.loaded) {
    return { status: "ok", detail: `${compactNumber(pin.loaded.postOffices)} post offices across ${compactNumber(pin.loaded.pincodes)} PIN codes.`, since: dateOf(pin.loaded.loadedAt) };
  }
  return { status: "off", detail: s.hasApiKey ? "Not loaded yet — sync it from Reference data." : "Not loaded yet — save a data.gov.in key, then sync it from Reference data." };
}

async function worldVerdict(now: Date): Promise<Verdict> {
  if (!referenceConfigured()) return { status: "off", detail: "The reference database is not configured." };
  const world = await readWorldPlaces();
  const s = world.sync;
  const problem = syncVerdict("world places", { status: s.status, startedAt: dateOf(s.startedAt), finishedAt: dateOf(s.finishedAt), message: s.message }, now);
  if (problem) return problem;
  if (s.status === "RUNNING") return { status: "ok", detail: `Syncing now: ${compactNumber(s.done)}${s.total ? ` of ${compactNumber(s.total)}` : ""} done.`, since: dateOf(s.startedAt) };
  if (world.loaded.length) {
    const rows = world.loaded.reduce((sum, d) => sum + d.rows, 0);
    const newest = world.loaded.map((d) => d.loadedAt).sort().at(-1) ?? null;
    return { status: "ok", detail: `${compactNumber(rows)} places in ${plural(world.loaded.length, "dataset")}.`, since: dateOf(newest) };
  }
  return { status: "off", detail: "Not loaded yet — sync it from Reference data." };
}

function twoFactorVerdict(s: SecurityFacts): Verdict {
  if (s.twoFactor === "required") return { status: "ok", detail: s.chosen ? "Required of every staff member." : "Required of every staff member (the production default)." };
  if (s.production) return { status: "fail", detail: "Off on the production installation — a password alone opens the console. An owner can require it from Staff." };
  return { status: "off", detail: "Off — a password alone opens the console. Fine outside production." };
}

function enrolmentVerdict(s: SecurityFacts): Verdict {
  if (s.withoutAuthenticator === null) return { status: "off", detail: "Not asked for while two-factor is off." };
  const n = s.withoutAuthenticator;
  if (!n) return { status: "ok", detail: "Every active staff member has one." };
  return { status: "warn", detail: `${plural(n, "staff member")} ${hasOrHave(n)} no authenticator yet — each is asked to set one up at the next sign-in.` };
}

function allowlistVerdict(s: SecurityFacts): Verdict {
  if (!s.allowlist) return { status: "off", detail: "Not set — any network reaches the console's sign-in page." };
  if (!s.trustProxy) return { status: "warn", detail: "Set without TRUST_PROXY=1 — the caller's address is unknown, so everybody would be refused." };
  return { status: "ok", detail: "Only the listed networks reach the console." };
}

function mailVerdict(s: SecurityFacts): Verdict {
  if (s.mailServer) return { status: "ok", detail: "Sent through the mail server." };
  if (s.production) return { status: "warn", detail: "No mail server in production — signup codes and password links are written to platform-outbox/, and nobody receives them." };
  return { status: "off", detail: "Written to platform-outbox/ — fine outside production." };
}

function presenceCheck(row: Presence): HealthCheck {
  // The platform key keeps the key the spec gives its check; the rest are "config.<VARIABLE>".
  const key = row.key === "PLATFORM_MASTER_KEY" ? "platform.key" : `config.${row.key}`;
  const base = { key, group: "configuration" as const, label: row.label, since: null, href: null };
  // A note that is a sentence follows as one; a fragment ("target 2") after a dash.
  const said = (head: string) => (!row.note ? `${head}.` : /^[a-z]/.test(row.note) ? `${head} — ${row.note}` : `${head}. ${row.note}`);
  if (!row.set) return { ...base, status: row.required ? "fail" : "off", detail: said("Not set") };
  return { ...base, status: row.misread ? "warn" : "ok", detail: said("Set") };
}

/**
 * Every check, in the board's order: background work, provisioning, schemas, billing, reference data,
 * security, configuration. The page drops the billing group for staff who do not sell.
 */
export async function systemHealth(now = new Date()): Promise<{ asOf: Date; checks: HealthCheck[]; counts: Record<HealthStatus, number> }> {
  // Read once, shared by the rows that need them; each row still fails on its own.
  const leases = (async () =>
    await controlDb().tenantJobLease.findMany({ where: { tenantId: "platform", job: { in: ["platform-tick", "migrate", "warm-pool"] } }, select: { job: true, ...LEASE_SELECT } }))();
  const drift = schemaDrift(now);
  const security = securityFacts();
  const gateways = Promise.all([gatewayKeySets(), gatewayModes(), lastWebhookAt("STRIPE"), lastWebhookAt("RAZORPAY")]);
  // The console's clock (India's when its setting can't be read — it never throws): the days the daily work keeps.
  const clock = consoleClock();
  for (const shared of [leases, drift, security, gateways]) shared.catch(() => {}); // Each row reports its own failure.
  const lease = async (job: string) => (await leases).find((r) => r.job === job);
  const settings = presence();

  const checks = await Promise.all([
    check("tick", "background", "Platform tick", null, async () => tickVerdict(tickStatusOf(await lease("platform-tick"), now), now)),
    check("daily", "background", "Daily billing chores", null, async () => dailyVerdict(await dailyChores(now, await clock))),
    check("usage", "background", "Usage snapshots", null, async () => usageVerdict(now, await clock)),
    check("migrate.runs", "background", "Migration runs", "/migrations", async () => migrateRunsVerdict(await lease("migrate"), now)),

    check("provisioning.failed", "provisioning", "Failed setups", "/provisioning?filter=attention", () => setupsFailedVerdict()),
    check("provisioning.stale", "provisioning", "Setups running too long", "/provisioning", () => setupsRunningVerdict(now)),
    check("provisioning.waiting", "provisioning", "Setups waiting to start", "/provisioning", () => setupsWaitingVerdict(now)),
    check("warm.pool", "provisioning", "Warm pool", "/provisioning#warm-pool", async () => warmVerdict(await warmPool())),
    check("worker", "provisioning", "Platform worker", "/provisioning", async () => workerVerdict(await lease("warm-pool"), now)),

    check("control.migrations", "schemas", "Control plane schema", null, () => controlSchemaVerdict()),
    check("workspace.schemas", "schemas", "Workspace schemas", "/migrations", async () => workspaceSchemasVerdict(await drift)),
    check("workspace.migrating", "schemas", "Held by a migration", "/migrations", async () => migratingVerdict(await drift)),

    check("gateway.stripe", "billing", "Stripe", "/settings#gateways", async () => {
      const [keys, modes, stripe] = await gateways;
      return gatewayVerdict("Stripe", keys.stripe, modes.stripe, stripe, (await security).production, now);
    }),
    check("gateway.razorpay", "billing", "Razorpay", "/settings#gateways", async () => {
      const [keys, modes, , razorpay] = await gateways;
      return gatewayVerdict("Razorpay", keys.razorpay, modes.razorpay, razorpay, (await security).production, now);
    }),
    check("webhooks", "billing", "Webhooks", "/billing?tab=events&state=failed", () => webhooksVerdict()),

    check("reference.pin", "reference", "PIN directory", "/reference", () => pinVerdict(now)),
    check("reference.world", "reference", "World places", "/reference", () => worldVerdict(now)),

    check("security.twofactor", "security", "Staff two-factor", "/staff", async () => twoFactorVerdict(await security)),
    check("security.enrolment", "security", "Authenticators", "/staff?status=active", async () => enrolmentVerdict(await security)),
    check("security.allowlist", "security", "Console network allowlist", null, async () => allowlistVerdict(await security)),
    check("security.mail", "security", "Platform mail", null, async () => mailVerdict(await security)),

    ...settings.map((row) => Promise.resolve(presenceCheck(row))),
  ]);

  const counts: Record<HealthStatus, number> = { ok: 0, warn: 0, fail: 0, off: 0 };
  for (const c of checks) counts[c.status] += 1;
  return { asOf: now, checks, counts };
}
