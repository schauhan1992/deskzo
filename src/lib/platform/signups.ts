import type { Prisma } from "@wroffy/control-client";
import { istDayKey } from "@/lib/console-shared/format";
import { STUCK_STAGES, isoDateOrUndefined, type StuckStage } from "@/lib/console-shared/params";
import { redactSecrets } from "@/lib/console-shared/redact";
import type { TenantStatusKey } from "@/lib/console-shared/types";
import { endOfIndianDay, startOfIndianDay } from "@/lib/india-time";
import { controlDb } from "@/lib/platform/control-db";

/**
 * The signups page (/signups): how far people get between "start" and "paying", and who got stuck on
 * the way — for staff to follow up with.
 *
 * A pending signup keeps secrets for the few minutes it is in flight: the owner's password as bcrypt,
 * the emailed code's hash, the signing-up browser's secret. None of them is ever selected here — every
 * query goes through `loadSignups`, whose select names the columns it may read. The invitation's hash
 * is read only to become `invited: true | false` and is dropped on the spot. The address the signup
 * came from (`ip`) is read only when the caller asks for it, which the page does for managers alone.
 */

export type SignupFunnel = {
  /** The effective range, IST days: what was asked for, or the last 30 days ending today. */
  from: string;
  to: string;
  started: number;
  /** Proved their email address with the code. */
  verified: number;
  /** A workspace was requested for them. */
  provisioned: number;
  /** Its setup finished. */
  ready: number;
  /** Signed in to it from the signup page. */
  handedOff: number;
  /** It pays at Stripe or Razorpay now. */
  paying: number;
  /** Its setup failed and has not been tried again. */
  failed: number;
  byInvite: { invited: number; open: number };
  /** Most first. */
  byCountry: { country: string; n: number }[];
  /** Every day of the range, oldest first, empty days included. */
  byDay: { day: string; n: number }[];
};

export type StuckRow = {
  id: string;
  email: string;
  ownerName: string;
  companyName: string;
  slug: string;
  country: string;
  createdAt: Date;
  /** Wrong codes entered. */
  attempts: number;
  /** The emailed code ran out before it was entered. */
  codeExpired: boolean;
  invited: boolean;
  stage: StuckStage;
  /** Only when asked for (`withIp`) — otherwise the key is absent. */
  ip?: string | null;
  tenant: { slug: string; status: TenantStatusKey } | null;
  job: { status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED"; step: string; error: string | null } | null;
};

export type StuckSignups = { rows: StuckRow[]; total: number; counts: Record<StuckStage, number>; page: number; pageSize: number };

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 30;
/** The longest range the funnel reads — a year and a day; a longer one keeps its end and is cut at the start. */
const MAX_DAYS = 366;
const PAGE_SIZE = 50;
/** An unverified signup older than this is a lost visitor, not somebody to follow up with. */
const NEVER_VERIFIED_WINDOW_MS = 7 * DAY_MS;
/** A setup running longer than this is stuck. */
const SETUP_STUCK_AFTER_MS = 30 * 60_000;
/** A workspace ready this long without its owner signing in from the signup page... */
const NEVER_LANDED_AFTER_MS = 60 * 60_000;
/** ...up to this age: past it they have long since signed in some other way, or will not. */
const NEVER_LANDED_WINDOW_MS = 30 * DAY_MS;
const CHUNK = 1000;

// ─── The one way signups are read ────────────────────────────────────────────────────────────────

const SIGNUP_SELECT = {
  id: true,
  email: true,
  ownerName: true,
  companyName: true,
  slug: true,
  country: true,
  createdAt: true,
  codeExpiresAt: true,
  attempts: true,
  verifiedAt: true,
  tenantId: true,
  handedOffAt: true,
  inviteCodeHash: true,
} as const satisfies Prisma.PendingSignupSelect;
const SIGNUP_SELECT_WITH_IP = { ...SIGNUP_SELECT, ip: true } as const satisfies Prisma.PendingSignupSelect;

type SignupRecord = Prisma.PendingSignupGetPayload<{ select: typeof SIGNUP_SELECT }> & { ip?: string | null };
type Signup = Omit<SignupRecord, "inviteCodeHash"> & { invited: boolean };

async function loadSignups(where: Prisma.PendingSignupWhereInput, withIp: boolean): Promise<Signup[]> {
  const pending = controlDb().pendingSignup;
  const orderBy: Prisma.PendingSignupOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "desc" }];
  const rows: SignupRecord[] = withIp
    ? await pending.findMany({ where, orderBy, select: SIGNUP_SELECT_WITH_IP })
    : await pending.findMany({ where, orderBy, select: SIGNUP_SELECT });
  return rows.map(({ inviteCodeHash, ...rest }) => ({ ...rest, invited: inviteCodeHash !== null }));
}

type TenantBrief = { slug: string; status: TenantStatusKey };
type JobBrief = { status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED"; step: string; error: string | null };

async function tenantsById(ids: string[]): Promise<Map<string, TenantBrief>> {
  const out = new Map<string, TenantBrief>();
  for (const part of chunks(ids)) {
    const rows = await controlDb().tenant.findMany({ where: { id: { in: part } }, select: { id: true, slug: true, status: true } });
    for (const t of rows) out.set(t.id, { slug: t.slug, status: t.status });
  }
  return out;
}

/** Each workspace's latest setup job, its error redacted. */
async function latestJobs(tenantIds: string[]): Promise<Map<string, JobBrief>> {
  const out = new Map<string, JobBrief>();
  for (const part of chunks(tenantIds)) {
    const rows = await controlDb().provisioningJob.findMany({
      where: { tenantId: { in: part } },
      orderBy: { createdAt: "desc" },
      select: { tenantId: true, status: true, step: true, error: true },
    });
    for (const j of rows) if (!out.has(j.tenantId)) out.set(j.tenantId, { status: j.status, step: j.step, error: redactSecrets(j.error) });
  }
  return out;
}

/** Workspaces with a live subscription at a gateway — trialing, active or past due there (plans.ts' `liveGatewaySubscription`, less a checkout merely started). */
async function payingTenants(tenantIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunks(tenantIds)) {
    const rows = await controlDb().subscription.findMany({
      where: { tenantId: { in: part }, gateway: { in: ["STRIPE", "RAZORPAY"] }, status: { in: ["TRIALING", "ACTIVE", "PAST_DUE"] } },
      distinct: ["tenantId"],
      select: { tenantId: true },
    });
    for (const s of rows) out.add(s.tenantId);
  }
  return out;
}

// ─── The funnel ──────────────────────────────────────────────────────────────────────────────────

/** How far the signups started in a range of IST days got. Without a range: the last 30 days, today included. */
export async function signupFunnel(range: { from?: string; to?: string }, now = new Date()): Promise<SignupFunnel> {
  const { from, to } = effectiveRange(range, now);
  const signups = await loadSignups({ createdAt: { gte: startOfIndianDay(from)!, lt: endOfIndianDay(to)! } }, false);
  const tenantIds = [...new Set(signups.flatMap((s) => (s.tenantId ? [s.tenantId] : [])))];
  const [tenants, jobs, paying] = await Promise.all([tenantsById(tenantIds), latestJobs(tenantIds), payingTenants(tenantIds)]);

  const funnel: SignupFunnel = {
    from,
    to,
    started: signups.length,
    verified: 0,
    provisioned: 0,
    ready: 0,
    handedOff: 0,
    paying: 0,
    failed: 0,
    byInvite: { invited: 0, open: 0 },
    byCountry: [],
    byDay: [],
  };
  const countries = new Map<string, number>();
  const days = new Map<string, number>();
  for (const s of signups) {
    const tenant = s.tenantId ? tenants.get(s.tenantId) : undefined;
    const job = s.tenantId ? jobs.get(s.tenantId) : undefined;
    if (s.verifiedAt) funnel.verified += 1;
    if (s.tenantId) funnel.provisioned += 1;
    if (isReady(tenant, job)) funnel.ready += 1;
    if (s.handedOffAt) funnel.handedOff += 1;
    if (s.tenantId && paying.has(s.tenantId)) funnel.paying += 1;
    if (job?.status === "FAILED") funnel.failed += 1;
    if (s.invited) funnel.byInvite.invited += 1;
    else funnel.byInvite.open += 1;
    const country = s.country.trim().toUpperCase() || "—";
    countries.set(country, (countries.get(country) ?? 0) + 1);
    const day = istDayKey(s.createdAt);
    days.set(day, (days.get(day) ?? 0) + 1);
  }
  funnel.byCountry = [...countries].map(([country, n]) => ({ country, n })).sort((a, b) => b.n - a.n || a.country.localeCompare(b.country));
  for (let day = from; day <= to; day = shiftDay(day, 1)) funnel.byDay.push({ day, n: days.get(day) ?? 0 });
  return funnel;
}

/**
 * Its setup finished: the job says so, or the workspace has been in use since (held or migrating
 * counts — it was ready to be). A closed one counts only on the job's word: some are closed because
 * their setup never finished.
 */
function isReady(tenant: TenantBrief | undefined, job: JobBrief | undefined): boolean {
  if (job?.status === "SUCCEEDED") return true;
  return !!tenant && (tenant.status === "ACTIVE" || tenant.status === "SUSPENDED" || tenant.status === "MIGRATING");
}

/** The range the funnel reads, as whole IST days, earlier first, at most MAX_DAYS long. */
function effectiveRange(range: { from?: string; to?: string }, now: Date): { from: string; to: string } {
  const today = istDayKey(now);
  let from = isoDateOrUndefined(range.from);
  let to = isoDateOrUndefined(range.to);
  if (!to) to = from && from > today ? from : today;
  if (!from) from = shiftDay(to, -(DEFAULT_DAYS - 1));
  if (from > to) [from, to] = [to, from];
  if (shiftDay(from, MAX_DAYS - 1) < to) from = shiftDay(to, -(MAX_DAYS - 1));
  return { from, to };
}

/** A `yyyy-mm-dd` day moved by whole calendar days — arithmetic on the date it names, not on any clock. */
function shiftDay(day: string, by: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + by)).toISOString().slice(0, 10);
}

// ─── Stuck signups ───────────────────────────────────────────────────────────────────────────────

/**
 * People who started and did not get through, newest first, 50 a page:
 *
 *   · never-verified — the code ran out before it was entered (started in the last 7 days);
 *   · setup-stuck    — verified, and the workspace still setting up 30 minutes on, or its setup failed;
 *   · never-landed   — the workspace is ready and nobody signed in from the signup page for an hour
 *                      (started in the last 30 days).
 *
 * `q` matches the email, company, owner or address. The counts are per stage, with `q` applied.
 */
export async function stuckSignups(opts: { stage?: StuckStage; q?: string; page?: number; withIp: boolean }, now = new Date()): Promise<StuckSignups> {
  const control = controlDb();
  const withIp = opts.withIp === true;
  const q = typeof opts.q === "string" ? opts.q.trim().slice(0, 100).trim() : "";
  const stage = opts.stage && STUCK_STAGES.includes(opts.stage) ? opts.stage : undefined;
  const at = (ms: number) => new Date(now.getTime() - ms);

  // Workspaces still setting up are few; their signups are the setup-stuck candidates.
  const settingUp = (await control.tenant.findMany({ where: { status: "PROVISIONING" }, select: { id: true } })).map((t) => t.id);
  const candidates: Prisma.PendingSignupWhereInput[] = [
    { verifiedAt: null, codeExpiresAt: { lte: now }, createdAt: { gte: at(NEVER_VERIFIED_WINDOW_MS) } },
    { tenantId: { not: null }, handedOffAt: null, createdAt: { gte: at(NEVER_LANDED_WINDOW_MS), lte: at(NEVER_LANDED_AFTER_MS) } },
  ];
  for (const part of chunks(settingUp)) candidates.push({ verifiedAt: { not: null }, tenantId: { in: part } });
  const search: Prisma.PendingSignupWhereInput[] = q
    ? [
        {
          OR: [
            { email: { contains: q, mode: "insensitive" } },
            { companyName: { contains: q, mode: "insensitive" } },
            { ownerName: { contains: q, mode: "insensitive" } },
            { slug: { contains: q, mode: "insensitive" } },
          ],
        },
      ]
    : [];
  const signups = await loadSignups({ AND: [{ OR: candidates }, ...search] }, withIp);

  const tenantIds = [...new Set(signups.flatMap((s) => (s.tenantId ? [s.tenantId] : [])))];
  const [tenants, jobs] = await Promise.all([tenantsById(tenantIds), latestJobs(tenantIds)]);
  const counts: Record<StuckStage, number> = { "never-verified": 0, "setup-stuck": 0, "never-landed": 0 };
  const stuck: StuckRow[] = [];
  for (const s of signups) {
    const tenant = s.tenantId ? (tenants.get(s.tenantId) ?? null) : null;
    const job = s.tenantId ? (jobs.get(s.tenantId) ?? null) : null;
    const kind = stageOf(s, tenant, job, now);
    if (!kind) continue;
    counts[kind] += 1;
    if (stage && kind !== stage) continue;
    stuck.push({
      id: s.id,
      email: s.email,
      ownerName: s.ownerName,
      companyName: s.companyName,
      slug: s.slug,
      country: s.country,
      createdAt: s.createdAt,
      attempts: s.attempts,
      codeExpired: !s.verifiedAt && s.codeExpiresAt.getTime() <= now.getTime(),
      invited: s.invited,
      stage: kind,
      ...(withIp ? { ip: s.ip ?? null } : {}),
      tenant,
      job,
    });
  }

  const pages = Math.max(1, Math.ceil(stuck.length / PAGE_SIZE));
  const requested = typeof opts.page === "number" && Number.isInteger(opts.page) && opts.page >= 1 ? opts.page : 1;
  const page = Math.min(requested, pages);
  return { rows: stuck.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total: stuck.length, counts, page, pageSize: PAGE_SIZE };
}

/** Which way a signup is stuck, if it is. The three never overlap: unverified, still setting up, ready. */
function stageOf(s: Signup, tenant: TenantBrief | null, job: JobBrief | null, now: Date): StuckStage | null {
  const age = now.getTime() - s.createdAt.getTime();
  if (!s.verifiedAt) return s.codeExpiresAt.getTime() <= now.getTime() && age <= NEVER_VERIFIED_WINDOW_MS ? "never-verified" : null;
  if (tenant?.status === "PROVISIONING") {
    // Setting up since the code was entered — that is when the workspace was asked for.
    const settingUpFor = now.getTime() - s.verifiedAt.getTime();
    return job?.status === "FAILED" || settingUpFor > SETUP_STUCK_AFTER_MS ? "setup-stuck" : null;
  }
  if (tenant?.status === "ACTIVE" && !s.handedOffAt && age > NEVER_LANDED_AFTER_MS && age <= NEVER_LANDED_WINDOW_MS) return "never-landed";
  return null;
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}
