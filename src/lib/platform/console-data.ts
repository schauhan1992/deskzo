import { Prisma } from "@wroffy/control-client";
import { controlDb } from "@/lib/platform/control-db";
import { latestMigrationName } from "@/lib/platform/migrate";
import { activeSupportGrant } from "@/lib/platform/support";
import { parseEntitlements } from "@/lib/entitlements";
import { billingStanding } from "@/lib/billing/lifecycle";
import { consoleOrigin } from "@/lib/platform/staff";
import { autoDeprovision, gatewayModes, getSetting, secretsSet, signupOpen, trialDays } from "@/lib/platform/settings";
import { subdomainHost } from "@/lib/tenancy/registry";
import { PLATFORM_DOMAIN, protocolFor } from "@/lib/tenancy/host";
import { dayKeyLabel, istDayKey } from "@/lib/console-shared/format";
import { actorLabel } from "@/lib/console-shared/labels";
import type { InviteFilters, InviteState, MigrationFilters, ProvisioningFilters, TerminalFilters, TerminalState } from "@/lib/console-shared/params";
import { redactSecrets } from "@/lib/console-shared/redact";
import type { ActivityItem, TenantStatusKey } from "@/lib/console-shared/types";
import { istDateParts, istMidnight } from "@/lib/india-time";
import { JOB_SAFE_SELECT, TENANT_SAFE_SELECT, WARM_SAFE_SELECT, staffNameMap, toActivityItems } from "@/lib/platform/console-guard";
import { normaliseSerial } from "@/lib/platform/device-routes";
import { LIVE_STATUSES } from "@/lib/platform/entitlements";
import { WARM_POOL_SIZE } from "@/lib/platform/provisioning";
import { readPinDirectory, readWorldPlaces } from "@/lib/platform/reference-sync";
import { behindBy, workspaceMigrationNames } from "@/lib/platform/schema-info";
import { lastTick } from "@/lib/platform/tick-summary";

/**
 * What the console shows — read from the control plane only. The console never opens a workspace's
 * database to look at it; staff who need to see inside one go in as support, on its grant.
 *
 * Every function here is called by a console page after `requireStaff` (src/lib/platform/
 * staff-session.ts); none is an action, so none can be called from a browser.
 *
 * Secrets stay in the database: tenants, setup jobs and warm databases are read through the safe
 * selects (src/lib/platform/console-guard.ts), and every error or output a tool wrote passes through
 * `redactSecrets` before it leaves — a migration's output can quote a connection string.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A setup RUNNING this long belonged to a worker that died (src/lib/platform/provisioning.ts takes it again). */
const STALE_RUNNING_MS = 30 * MINUTE;
/** A setup this long past its time and still waiting means no worker is taking jobs. */
const LATE_PENDING_MS = 10 * MINUTE;
/** How many times the worker tries a setup before leaving it FAILED for staff (provisioning.ts). */
const MAX_ATTEMPTS = 3;
/** A staff session idle this long is signed out at its next request (staff-session.ts) — not "signed in". */
const IDLE_SESSION_MS = 30 * MINUTE;
/** An `invite.end` entry written within this of an invitation's end is the one that ended it. */
const ENDED_SLACK_MS = 5 * MINUTE;

const TENANT_STATUSES: readonly TenantStatusKey[] = ["PROVISIONING", "ACTIVE", "SUSPENDED", "MIGRATING", "DEPROVISIONED"];
const OPEN_OR_MIGRATING = ["ACTIVE", "MIGRATING"] as const;
/** The platform's own leases are held under this tenant id (src/lib/platform/fanout.ts). */
const PLATFORM_LEASE = "platform";

const page1 = (page: number) => (Number.isInteger(page) && page >= 1 ? page : 1);
/** The page asked for, or the last one there is — a stale link past the end shows the end. */
const clampPage = (page: number, total: number, size: number) => Math.min(page1(page), Math.max(1, Math.ceil(total / size)));
const unique = <T>(values: T[]) => [...new Set(values)];

/** Not at the latest workspace migration: an older one, or none recorded. `NOT: { schemaVersion }` would drop the nulls. */
function behindWhere(latest: string | null): Prisma.TenantWhereInput {
  return latest ? { OR: [{ schemaVersion: null }, { schemaVersion: { not: latest } }] } : { id: { in: [] } };
}

export async function overview() {
  const control = controlDb();
  const version = latestMigrationName();
  const [byStatus, failedJobs, pendingJobs, drift, warm, grants, recent] = await Promise.all([
    control.tenant.groupBy({ by: ["status"], _count: { _all: true } }),
    control.provisioningJob.count({ where: { status: "FAILED" } }),
    control.provisioningJob.count({ where: { status: { in: ["PENDING", "RUNNING"] } } }),
    control.tenant.count({ where: { status: { in: [...OPEN_OR_MIGRATING] }, ...behindWhere(version) } }),
    control.warmDatabase.count({ where: { claimedAt: null } }),
    control.supportAccessGrant.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
    control.platformAuditLog.findMany({
      orderBy: { at: "desc" },
      take: 12,
      select: { id: true, at: true, actorKind: true, actor: true, action: true, tenantId: true, detail: true, tenant: { select: { slug: true } } },
    }),
  ]);
  return {
    version,
    workspaces: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])) as Partial<Record<string, number>>,
    failedJobs,
    pendingJobs,
    drift,
    warm,
    grants,
    recent,
  };
}

export async function listTenants(search: string) {
  const q = search.trim();
  return controlDb().tenant.findMany({
    where: q ? { OR: [{ slug: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }, { ownerEmail: { contains: q, mode: "insensitive" } }] } : undefined,
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true, slug: true, name: true, status: true, isDefault: true, country: true, schemaVersion: true, ownerEmail: true, createdAt: true },
  });
}

/** Every Invoice column — none is secret; spelled out so a new column is a decision, not a leak. */
const INVOICE_SELECT = {
  id: true,
  tenantId: true,
  gateway: true,
  externalId: true,
  number: true,
  status: true,
  currency: true,
  subtotal: true,
  tax: true,
  total: true,
  amountPaid: true,
  periodStart: true,
  periodEnd: true,
  issuedAt: true,
  paidAt: true,
  hostedUrl: true,
  pdfUrl: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.InvoiceSelect;

/**
 * One workspace, everything the legacy page shows — on the safe selects, so its sealed database
 * address and keys never leave the control plane. Kept for the old page until the Workspace 360
 * loaders (src/lib/platform/workspace-data.ts) replace it.
 */
export async function tenantDetail(slug: string) {
  const control = controlDb();
  const found = await control.tenant.findUnique({
    where: { slug: String(slug ?? "") },
    select: {
      ...TENANT_SAFE_SELECT,
      domains: { select: { id: true, host: true, kind: true, isPrimary: true, createdAt: true }, orderBy: { createdAt: "asc" } },
      deviceRoutes: { select: { serial: true, createdAt: true, lastSeenAt: true }, orderBy: { createdAt: "asc" } },
      provisioningJobs: { select: JOB_SAFE_SELECT, orderBy: { createdAt: "desc" }, take: 5 },
      migrationRuns: {
        select: { id: true, runId: true, target: true, startedAt: true, finishedAt: true, ok: true, fromVersion: true, toVersion: true, output: true },
        orderBy: { startedAt: "desc" },
        take: 10,
      },
      auditLog: { select: { id: true, at: true, actorKind: true, actor: true, action: true, detail: true }, orderBy: { at: "desc" }, take: 30 },
    },
  });
  if (!found) return null;
  const tenant = {
    ...found,
    provisioningJobs: found.provisioningJobs.map((j) => ({ ...j, error: redactSecrets(j.error) })),
    migrationRuns: found.migrationRuns.map((m) => ({ ...m, output: redactSecrets(m.output) })),
  };
  const [grant, grants, leases, subscriptions, overrides] = await Promise.all([
    activeSupportGrant(tenant.id, true),
    control.supportAccessGrant.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, tenantId: true, level: true, reason: true, grantedByUserId: true, grantedByName: true, createdAt: true, expiresAt: true, revokedAt: true },
    }),
    control.tenantJobLease.findMany({
      where: { tenantId: tenant.id },
      orderBy: { job: "asc" },
      select: { tenantId: true, job: true, leasedUntil: true, holder: true, lastStartedAt: true, lastFinishedAt: true, lastOk: true, lastError: true },
    }),
    control.subscription.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        tenantId: true,
        status: true,
        gateway: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
        cancelledAt: true,
        cancelAtPeriodEnd: true,
        pastDueSince: true,
        externalId: true,
        externalCustomerId: true,
        currency: true,
        interval: true,
        syncedAt: true,
        createdAt: true,
        updatedAt: true,
        items: {
          select: {
            id: true,
            subscriptionId: true,
            planId: true,
            quantity: true,
            priceId: true,
            externalId: true,
            createdAt: true,
            plan: { select: { key: true, name: true, kind: true, active: true } },
          },
        },
      },
    }),
    control.tenantModuleOverride.findMany({
      where: { tenantId: tenant.id },
      orderBy: { moduleKey: "asc" },
      select: { tenantId: true, moduleKey: true, granted: true, reason: true, byStaffId: true, createdAt: true },
    }),
  ]);
  const [invoicesOf, standing, usage] = await Promise.all([
    control.invoice.findMany({ where: { tenantId: tenant.id }, orderBy: { issuedAt: "desc" }, take: 12, select: INVOICE_SELECT }),
    billingStanding(tenant.id),
    control.tenantUsage.findFirst({
      where: { tenantId: tenant.id },
      orderBy: { day: "desc" },
      select: { tenantId: true, day: true, seatsUsed: true, seatsLimit: true, copilotTokens: true, recordedAt: true },
    }),
  ]);
  return {
    tenant,
    host: subdomainHost(tenant.slug),
    grant,
    grants,
    leases: leases.map((l) => ({ ...l, lastError: redactSecrets(l.lastError) })),
    latest: latestMigrationName(),
    subscriptions,
    overrides,
    entitlements: parseEntitlements(tenant.entitlements),
    invoices: invoicesOf,
    standing,
    usage,
  };
}

export async function provisioningQueue() {
  const control = controlDb();
  const [jobs, warm] = await Promise.all([
    control.provisioningJob.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { ...JOB_SAFE_SELECT, tenant: { select: { slug: true, name: true, status: true } } },
    }),
    control.warmDatabase.findMany({ orderBy: { createdAt: "desc" }, take: 50, select: WARM_SAFE_SELECT }),
  ]);
  return { jobs: jobs.map((j) => ({ ...j, error: redactSecrets(j.error) })), warm, version: latestMigrationName() };
}

export async function migrationRuns() {
  const control = controlDb();
  const version = latestMigrationName();
  const [runs, behind] = await Promise.all([
    control.tenantMigrationRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 80,
      select: { id: true, runId: true, target: true, tenantId: true, startedAt: true, finishedAt: true, ok: true, fromVersion: true, toVersion: true, output: true },
    }),
    control.tenant.findMany({
      where: { status: { in: [...OPEN_OR_MIGRATING] }, ...behindWhere(version) },
      select: { id: true, slug: true, name: true, status: true, schemaVersion: true },
      orderBy: { slug: "asc" },
    }),
  ]);
  return { version, runs: runs.map((r) => ({ ...r, output: redactSecrets(r.output) })), behind };
}

export async function deviceRoutes() {
  return controlDb().biometricDeviceRoute.findMany({
    orderBy: { createdAt: "desc" },
    take: 500,
    select: { serial: true, tenantId: true, createdAt: true, lastSeenAt: true, tenant: { select: { slug: true, name: true } } },
  });
}

/** The plans matching `where`, each with its modules, its prices, and how many workspaces are on it. */
async function planRows(where?: Prisma.PlanWhereInput) {
  const plans = await controlDb().plan.findMany({
    where,
    orderBy: [{ active: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
    include: {
      prices: { orderBy: [{ active: "desc" }, { createdAt: "desc" }] },
      modules: { select: { moduleKey: true } },
      items: { where: { subscription: { status: { in: [...LIVE_STATUSES] } } }, select: { subscription: { select: { tenantId: true } } } },
    },
  });
  return plans.map(({ items, modules, ...plan }) => ({
    ...plan,
    modules: modules.map((m) => m.moduleKey),
    workspaces: new Set(items.map((i) => i.subscription.tenantId)).size,
  }));
}

/** Every plan, with its modules, its prices, and how many workspaces are on it. */
export async function plansList() {
  return planRows();
}

export type PlanListRow = Awaited<ReturnType<typeof plansList>>[number];
export type PlanDetail = PlanListRow & { sample: { slug: string; name: string }[] };

/** One plan by its key, as the catalogue lists it, with a few of the workspaces on it; null when there is none. */
export async function planDetail(key: string): Promise<PlanDetail | null> {
  const wanted = String(key ?? "").trim();
  if (!wanted || wanted.length > 100) return null;
  const [plan] = await planRows({ key: wanted });
  if (!plan) return null;
  const sample = await controlDb().tenant.findMany({
    where: { subscriptions: { some: { status: { in: [...LIVE_STATUSES] }, items: { some: { planId: plan.id } } } } },
    orderBy: { slug: "asc" },
    take: 10,
    select: { slug: true, name: true },
  });
  return { ...plan, sample };
}

// ─── Billing ─────────────────────────────────────────────────────────────────────────────────────

/** Workspaces not closed that a gateway reports as unpaid. */
function pastDueCount(): Promise<number> {
  return controlDb().tenant.count({
    where: { status: { not: "DEPROVISIONED" }, subscriptions: { some: { gateway: { in: ["STRIPE", "RAZORPAY"] }, status: "PAST_DUE" } } },
  });
}

/** Workspaces not closed on a free trial — of those, the ones whose trial ends within `ending`. */
function trialCount(ending?: { after: Date; until: Date }): Promise<number> {
  return controlDb().tenant.count({
    where: {
      status: { not: "DEPROVISIONED" },
      subscriptions: { some: { gateway: "MANUAL", status: "TRIALING", ...(ending ? { trialEndsAt: { gt: ending.after, lte: ending.until } } : {}) } },
    },
  });
}

function heldForBillingCount(): Promise<number> {
  return controlDb().tenant.count({ where: { status: "SUSPENDED", suspendedFor: "BILLING" } });
}

/**
 * The console's Billing page: settings (secrets only as set or not, and each gateway's mode from its
 * key's prefix), webhook addresses, recent events and invoices, what is failing, and the last tick.
 */
export async function billingOverview() {
  const control = controlDb();
  const failingWhere = { processedAt: null, error: { not: null } } satisfies Prisma.BillingEventWhereInput;
  const [secrets, open, days, closeByItself, events, invoices, failing, modes, lastByGateway, failingByGatewayRows, pastDue, heldBilling, trials, tick] = await Promise.all([
    secretsSet(),
    signupOpen(),
    trialDays(),
    autoDeprovision(),
    control.billingEvent.findMany({
      orderBy: { receivedAt: "desc" },
      take: 50,
      select: { id: true, gateway: true, eventId: true, type: true, tenantId: true, receivedAt: true, processedAt: true, error: true },
    }),
    control.invoice.findMany({ orderBy: { issuedAt: "desc" }, take: 50, select: { ...INVOICE_SELECT, tenant: { select: { slug: true } } } }),
    control.billingEvent.count({ where: failingWhere }),
    gatewayModes(),
    control.billingEvent.groupBy({ by: ["gateway"], _max: { receivedAt: true } }),
    control.billingEvent.groupBy({ by: ["gateway"], where: failingWhere, _count: { _all: true } }),
    pastDueCount(),
    heldForBillingCount(),
    trialCount(),
    lastTick(),
  ]);
  const origin = consoleOrigin();
  const lastEventAt = (gateway: "STRIPE" | "RAZORPAY") => lastByGateway.find((r) => r.gateway === gateway)?._max.receivedAt ?? null;
  const failingAt = (gateway: "STRIPE" | "RAZORPAY") => failingByGatewayRows.find((r) => r.gateway === gateway)?._count._all ?? 0;
  return {
    secrets,
    signupOpen: open,
    trialDays: days,
    autoDeprovision: closeByItself,
    webhooks: { stripe: `${origin}/api/platform/billing/stripe`, razorpay: `${origin}/api/platform/billing/razorpay`, tick: `${origin}/api/platform/tick` },
    events: events.map((e) => ({ ...e, error: redactSecrets(e.error) })),
    invoices,
    failing,
    /** Test or live keys at each gateway — only the mode, never the key. */
    modes,
    lastEvent: { stripe: lastEventAt("STRIPE"), razorpay: lastEventAt("RAZORPAY") },
    failingByGateway: { stripe: failingAt("STRIPE"), razorpay: failingAt("RAZORPAY") },
    counts: { pastDue, heldBilling, trials },
    lastTick: tick,
  };
}

export type BillingOverviewData = Awaited<ReturnType<typeof billingOverview>>;

// ─── Invitations ─────────────────────────────────────────────────────────────────────────────────

/** Every SignupInvite column — the code itself is never kept, only its hash, which is the invitation's id. */
const INVITE_SELECT = { codeHash: true, note: true, maxUses: true, uses: true, expiresAt: true, createdBy: true, planKey: true, createdAt: true } as const satisfies Prisma.SignupInviteSelect;
type InviteRecord = Prisma.SignupInviteGetPayload<{ select: typeof INVITE_SELECT }>;
type InviteExtras = { state: InviteState; createdByName: string | null; planName: string | null; workspaces: { slug: string }[] };

/** What an invitation's audit entries call it: the first eight characters of its hash (never the code). */
const hashPrefix = (codeHash: string) => codeHash.slice(0, 8);

/**
 * Used up, expired, or still good — and, of the expired, the ones staff ended early: an `invite.end`
 * entry carrying its hash prefix, written when its end was set (an invitation extended after that
 * has a later end, and is not "ended"). Entries from before the prefix was recorded read as expired.
 */
function inviteState(invite: InviteRecord, endedAt: readonly Date[], now: Date): InviteState {
  if (invite.uses >= invite.maxUses) return "used";
  if (!invite.expiresAt || invite.expiresAt > now) return "live";
  const end = invite.expiresAt.getTime();
  return endedAt.some((at) => at.getTime() >= end - ENDED_SLACK_MS) ? "ended" : "expired";
}

/** Who made each invitation, its plan's name, its state, and the workspaces set up with it. */
async function inviteExtras(rows: InviteRecord[], now: Date): Promise<Map<string, InviteExtras>> {
  const control = controlDb();
  const hashes = rows.map((r) => r.codeHash);
  const creators = unique(rows.map((r) => r.createdBy).filter((by): by is string => !!by));
  const planKeys = unique(rows.map((r) => r.planKey).filter((key): key is string => !!key));
  const expiredPrefixes = unique(rows.filter((r) => r.uses < r.maxUses && r.expiresAt && r.expiresAt <= now).map((r) => hashPrefix(r.codeHash)));
  const [names, plans, signups, endings] = await Promise.all([
    creators.length ? staffNameMap(creators) : Promise.resolve(new Map<string, string>()),
    planKeys.length ? control.plan.findMany({ where: { key: { in: planKeys } }, select: { key: true, name: true } }) : Promise.resolve([]),
    hashes.length
      ? control.pendingSignup.findMany({ where: { inviteCodeHash: { in: hashes }, tenantId: { not: null } }, select: { inviteCodeHash: true, tenantId: true } })
      : Promise.resolve([]),
    expiredPrefixes.length
      ? control.platformAuditLog.findMany({
          where: { action: "invite.end", OR: expiredPrefixes.map((prefix) => ({ detail: { path: ["codeHashPrefix"], equals: prefix } })) },
          select: { at: true, detail: true },
        })
      : Promise.resolve([]),
  ]);
  const tenantIds = unique(signups.map((s) => s.tenantId).filter((id): id is string => !!id));
  const tenants = tenantIds.length ? await control.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, slug: true } }) : [];
  const slugOf = new Map(tenants.map((t) => [t.id, t.slug]));
  const planName = new Map(plans.map((p) => [p.key, p.name]));
  const endedAt = new Map<string, Date[]>();
  for (const e of endings) {
    const prefix = (e.detail as { codeHashPrefix?: unknown } | null)?.codeHashPrefix;
    if (typeof prefix === "string") endedAt.set(prefix, [...(endedAt.get(prefix) ?? []), e.at]);
  }
  const creatorName = (by: string | null) => {
    if (!by) return null;
    const name = names.get(by);
    if (name) return name;
    // Made from the server (`npm run platform:tenant -- invite`) rather than by a staff member.
    return by.includes(":") ? actorLabel("SCRIPT", by, names) : "A former staff member";
  };
  return new Map(
    rows.map((r) => {
      const slugs = signups
        .filter((s) => s.inviteCodeHash === r.codeHash && s.tenantId && slugOf.has(s.tenantId))
        .map((s) => slugOf.get(s.tenantId!)!)
        .sort();
      return [
        r.codeHash,
        {
          state: inviteState(r, endedAt.get(hashPrefix(r.codeHash)) ?? [], now),
          createdByName: creatorName(r.createdBy),
          planName: r.planKey ? (planName.get(r.planKey) ?? null) : null,
          workspaces: slugs.map((slug) => ({ slug })),
        },
      ];
    }),
  );
}

/** Each with whether it still works: not expired, and not used up. The platform's own only — a partner's codes are on its page. */
export async function invites() {
  const rows = await controlDb().signupInvite.findMany({ where: { partnerId: null }, orderBy: { createdAt: "desc" }, take: 100, select: INVITE_SELECT });
  const now = new Date();
  const extras = await inviteExtras(rows, now);
  return rows.map((i) => ({ ...i, live: (!i.expiresAt || i.expiresAt.getTime() > now.getTime()) && i.uses < i.maxUses, ...extras.get(i.codeHash)! }));
}

export type InviteRow = {
  codeHash: string;
  note: string | null;
  planKey: string | null;
  planName: string | null;
  uses: number;
  maxUses: number;
  expiresAt: Date | null;
  createdAt: Date;
  createdByName: string | null;
  state: InviteState;
  workspaces: { slug: string }[];
};
export type InvitesBoard = {
  rows: InviteRow[];
  total: number;
  page: number;
  pageSize: number;
  /** `expired` counts the ended ones too; the counts follow the search, not the tab. */
  counts: { live: number; used: number; expired: number; all: number };
  signupOpen: boolean;
  signupUrl: string;
  /** What a new invitation may start a workspace on: offered, and never an internal plan. */
  plans: { key: string; name: string }[];
};

const INVITES_PAGE = 50;

/**
 * The Invitations page: 50 a page, newest first, filtered by state and by note. The platform's own
 * invitations only: a partner's codes are listed on that partner's page (/partners/<slug>).
 */
export async function invitesBoard(f: InviteFilters, now = new Date()): Promise<InvitesBoard> {
  const control = controlDb();
  const maxUses = control.signupInvite.fields.maxUses;
  const q = f.q?.trim();
  // Every count and the page itself go through `search`, so none of them includes a partner's code.
  const search: Prisma.SignupInviteWhereInput = q ? { partnerId: null, note: { contains: q, mode: "insensitive" } } : { partnerId: null };
  const byState: Record<"live" | "used" | "expired", Prisma.SignupInviteWhereInput> = {
    live: { uses: { lt: maxUses }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    used: { uses: { gte: maxUses } },
    expired: { uses: { lt: maxUses }, expiresAt: { lte: now } },
  };
  const where: Prisma.SignupInviteWhereInput = f.status === "all" ? search : { AND: [search, byState[f.status]] };
  const [live, used, expired, all, open, offered] = await Promise.all([
    control.signupInvite.count({ where: { AND: [search, byState.live] } }),
    control.signupInvite.count({ where: { AND: [search, byState.used] } }),
    control.signupInvite.count({ where: { AND: [search, byState.expired] } }),
    control.signupInvite.count({ where: search }),
    signupOpen(),
    control.plan.findMany({ where: { active: true, kind: { not: "INTERNAL" } }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { key: true, name: true } }),
  ]);
  const total = f.status === "all" ? all : { live, used, expired }[f.status];
  const page = clampPage(f.page, total, INVITES_PAGE);
  const rows = total
    ? await control.signupInvite.findMany({ where, orderBy: [{ createdAt: "desc" }, { codeHash: "asc" }], skip: (page - 1) * INVITES_PAGE, take: INVITES_PAGE, select: INVITE_SELECT })
    : [];
  const extras = await inviteExtras(rows, now);
  // Where people sign up: the public site's own address (the same one the invitation message gives).
  const siteHost = `www.${PLATFORM_DOMAIN}${process.env.PLATFORM_PORT ? `:${process.env.PLATFORM_PORT}` : ""}`;
  return {
    rows: rows.map((r) => {
      const extra = extras.get(r.codeHash)!;
      return {
        codeHash: r.codeHash,
        note: r.note,
        planKey: r.planKey,
        planName: extra.planName,
        uses: r.uses,
        maxUses: r.maxUses,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
        createdByName: extra.createdByName,
        state: extra.state,
        workspaces: extra.workspaces,
      };
    }),
    total,
    page,
    pageSize: INVITES_PAGE,
    counts: { live, used, expired, all },
    signupOpen: open,
    signupUrl: `${protocolFor(siteHost)}://${siteHost}/signup`,
    plans: offered,
  };
}

// ─── Staff, audit ────────────────────────────────────────────────────────────────────────────────

/** `sessions`: the ones in use — not revoked, not expired, and seen within the idle limit. */
export async function staffMembers(now = new Date()) {
  return controlDb().platformUser.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      active: true,
      totpEnabledAt: true,
      lastSignInAt: true,
      sessions: { where: { revokedAt: null, expiresAt: { gt: now }, lastSeenAt: { gt: new Date(now.getTime() - IDLE_SESSION_MS) } }, select: { id: true } },
    },
  });
}

export async function auditLog(search: string) {
  const q = search.trim();
  return controlDb().platformAuditLog.findMany({
    where: q ? { OR: [{ action: { contains: q, mode: "insensitive" } }, { actor: { contains: q, mode: "insensitive" } }, { tenant: { slug: { contains: q, mode: "insensitive" } } }] } : undefined,
    orderBy: { at: "desc" },
    take: 200,
    include: { tenant: { select: { slug: true } } },
  });
}

/** Staff ids to names, for audit rows whose actor is a staff member. */
export async function staffNames(): Promise<Map<string, string>> {
  const rows = await controlDb().platformUser.findMany({ select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ─── Overview ────────────────────────────────────────────────────────────────────────────────────

type ReferenceSyncState = { status: string; stale: boolean; finishedAt: Date | null };

export type OverviewData = {
  asOf: Date;
  latest: string | null;
  counts: {
    byStatus: Record<TenantStatusKey, number>;
    total: number;
    /** Every workspace not closed. */
    open: number;
    heldStaff: number;
    heldBilling: number;
    trials: number;
    trialsEnding7d: number;
    pastDue: number;
    failedJobs: number;
    runningJobs: number;
    pendingJobs: number;
    /** Open or held mid-migration, and not at the latest schema. */
    drift: number;
    upToDate: number;
    /** Open or held mid-migration: the workspaces a migration run covers. */
    migratable: number;
    warm: number;
    warmTarget: number;
    grants: number;
    failingWebhooks: number;
  };
  /** 12 weeks, oldest first; weeks start on Monday, in India. */
  newByWeek: { weekStart: string; label: string; n: number }[];
  /** Workspaces not closed at each of those weeks' ends. */
  openByWeek: number[];
  createdThisWeek: number;
  liveGrants: { tenantId: string; slug: string; name: string; level: "READONLY" | "ADMIN"; expiresAt: Date; grantedByName: string }[];
  recent: ActivityItem[];
  tick: { lastStartedAt: Date | null; lastFinishedAt: Date | null; lastOk: boolean | null; lastError: string | null; runningNow: boolean };
  dailyRanOn: string | null;
  /** Null when the reference database could not be read — the Overview never fails for it. */
  reference: { pin: ReferenceSyncState | null; world: ReferenceSyncState | null };
  todayKey: string;
};

/** The last `count` weeks (Monday to Monday, India), oldest first — this week last. */
function mondayWeeks(now: Date, count: number): { start: Date; end: Date; key: string }[] {
  const { year, month, day } = istDateParts(now);
  const weekday = new Date(Date.UTC(year, month, day)).getUTCDay(); // 0 is Sunday
  const monday = day - ((weekday + 6) % 7);
  return Array.from({ length: count }, (_, i) => {
    const first = monday - 7 * (count - 1 - i);
    const start = istMidnight(year, month, first);
    return { start, end: istMidnight(year, month, first + 7), key: istDayKey(start) };
  });
}

/** A reference dataset's sync as the Overview lists it; null when the reference database cannot be read. */
async function referenceState(read: () => Promise<{ sync: { status: string; stale: boolean; finishedAt: string | null } }>): Promise<ReferenceSyncState | null> {
  try {
    const { sync } = await read();
    return { status: sync.status, stale: sync.stale, finishedAt: sync.finishedAt ? new Date(sync.finishedAt) : null };
  } catch {
    return null;
  }
}

/** The console's front page: how many of everything, the last 12 weeks, what just happened, and whether the platform's own chores run. */
export async function consoleOverview(now = new Date()): Promise<OverviewData> {
  const control = controlDb();
  const latest = latestMigrationName();
  const weeks = mondayWeeks(now, 12);
  const since = weeks[0].start;
  const liveGrant = { revokedAt: null, expiresAt: { gt: now } } satisfies Prisma.SupportAccessGrantWhereInput;
  const [
    byStatusRows,
    heldBilling,
    trials,
    trialsEnding7d,
    pastDue,
    jobRows,
    migratable,
    atLatest,
    warm,
    grants,
    grantRows,
    failingWebhooks,
    created,
    createdBefore,
    closed,
    closedBefore,
    recentRows,
    tickLease,
    dailyRanOn,
    pin,
    world,
  ] = await Promise.all([
    control.tenant.groupBy({ by: ["status"], _count: { _all: true } }),
    heldForBillingCount(),
    trialCount(),
    trialCount({ after: now, until: new Date(now.getTime() + 7 * DAY) }),
    pastDueCount(),
    control.provisioningJob.groupBy({ by: ["status"], _count: { _all: true } }),
    control.tenant.count({ where: { status: { in: [...OPEN_OR_MIGRATING] } } }),
    latest ? control.tenant.count({ where: { status: { in: [...OPEN_OR_MIGRATING] }, schemaVersion: latest } }) : Promise.resolve(null),
    control.warmDatabase.count({ where: { claimedAt: null } }),
    control.supportAccessGrant.count({ where: liveGrant }),
    control.supportAccessGrant.findMany({ where: liveGrant, orderBy: { expiresAt: "asc" }, take: 50, select: { tenantId: true, level: true, expiresAt: true, grantedByName: true } }),
    control.billingEvent.count({ where: { processedAt: null, error: { not: null } } }),
    control.tenant.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
    control.tenant.count({ where: { createdAt: { lt: since } } }),
    control.tenant.findMany({ where: { deprovisionedAt: { gte: since } }, select: { deprovisionedAt: true } }),
    control.tenant.count({ where: { deprovisionedAt: { lt: since } } }),
    control.platformAuditLog.findMany({
      orderBy: { at: "desc" },
      take: 12,
      select: { id: true, at: true, actorKind: true, actor: true, action: true, detail: true, tenant: { select: { slug: true } } },
    }),
    control.tenantJobLease.findUnique({
      where: { tenantId_job: { tenantId: PLATFORM_LEASE, job: "platform-tick" } },
      select: { leasedUntil: true, lastStartedAt: true, lastFinishedAt: true, lastOk: true, lastError: true },
    }),
    getSetting("billing.dailyRanOn"),
    referenceState(readPinDirectory),
    referenceState(readWorldPlaces),
  ]);

  const grantTenantIds = unique(grantRows.map((g) => g.tenantId));
  const [grantTenants, names] = await Promise.all([
    grantTenantIds.length ? control.tenant.findMany({ where: { id: { in: grantTenantIds } }, select: { id: true, slug: true, name: true } }) : Promise.resolve([]),
    staffNameMap(recentRows.filter((r) => r.actorKind === "STAFF").map((r) => r.actor)),
  ]);

  const byStatus = Object.fromEntries(TENANT_STATUSES.map((s) => [s, 0])) as Record<TenantStatusKey, number>;
  for (const row of byStatusRows) byStatus[row.status] = row._count._all;
  const total = TENANT_STATUSES.reduce((sum, s) => sum + byStatus[s], 0);
  const jobs = (status: "PENDING" | "RUNNING" | "FAILED") => jobRows.find((r) => r.status === status)?._count._all ?? 0;
  // Without migrations there is nothing to be behind.
  const upToDate = atLatest ?? migratable;

  const newByWeek = weeks.map((w) => ({
    weekStart: w.key,
    label: dayKeyLabel(w.key, false),
    n: created.filter((t) => t.createdAt >= w.start && t.createdAt < w.end).length,
  }));
  // Open at a week's end: made before it, less those closed before it (a workspace is closed after it is made).
  const openByWeek = weeks.map(
    (w) =>
      createdBefore +
      created.filter((t) => t.createdAt < w.end).length -
      (closedBefore + closed.filter((t) => t.deprovisionedAt !== null && t.deprovisionedAt < w.end).length),
  );

  const tenantOf = new Map(grantTenants.map((t) => [t.id, t]));
  const liveGrants = grantRows.flatMap((g) => {
    const t = tenantOf.get(g.tenantId);
    return t ? [{ tenantId: g.tenantId, slug: t.slug, name: t.name, level: g.level, expiresAt: g.expiresAt, grantedByName: g.grantedByName }] : [];
  });

  return {
    asOf: now,
    latest,
    counts: {
      byStatus,
      total,
      open: total - byStatus.DEPROVISIONED,
      heldStaff: Math.max(0, byStatus.SUSPENDED - heldBilling),
      heldBilling,
      trials,
      trialsEnding7d,
      pastDue,
      failedJobs: jobs("FAILED"),
      runningJobs: jobs("RUNNING"),
      pendingJobs: jobs("PENDING"),
      drift: Math.max(0, migratable - upToDate),
      upToDate,
      migratable,
      warm,
      warmTarget: WARM_POOL_SIZE,
      grants,
      failingWebhooks,
    },
    newByWeek,
    openByWeek,
    createdThisWeek: newByWeek[newByWeek.length - 1]?.n ?? 0,
    liveGrants,
    recent: toActivityItems(recentRows, names),
    tick: {
      lastStartedAt: tickLease?.lastStartedAt ?? null,
      lastFinishedAt: tickLease?.lastFinishedAt ?? null,
      lastOk: tickLease?.lastOk ?? null,
      lastError: redactSecrets(tickLease?.lastError),
      runningNow: !!tickLease && tickLease.leasedUntil > now,
    },
    dailyRanOn,
    reference: { pin, world },
    todayKey: istDayKey(now),
  };
}

// ─── Provisioning ────────────────────────────────────────────────────────────────────────────────

export type JobRow = {
  id: string;
  tenant: { slug: string; name: string; status: TenantStatusKey };
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
  step: string;
  attempts: number;
  maxAttempts: 3;
  runAfter: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** How long its last attempt took — or has taken so far, while it runs; null while it waits. */
  durationMs: number | null;
  /** Redacted. */
  error: string | null;
  ownerName: string;
  ownerEmail: string;
  companyName: string;
  country: string;
  planKey: string | null;
  createdAt: Date;
};
export type ProvisioningBoard = {
  asOf: Date;
  /** Something is waiting or running — the page refreshes itself while it is. */
  live: boolean;
  workerLastFinished: Date | null;
  /** Across every setup, whatever the filter and search. `doneToday`: finished in the last 24 hours. */
  counts: { running: number; waiting: number; failed: number; doneToday: number; all: number; attention: number; progress: number; done: number };
  rows: JobRow[];
  total: number;
  page: number;
  pageSize: number;
  warm: {
    target: number;
    ready: { id: string; dbName: string; schemaVersion: string | null; current: boolean; createdAt: Date }[];
    taken: { id: string; dbName: string; claimedAt: Date; tenant: { slug: string } | null }[];
  };
  /** 14 days in India, oldest first. */
  byDay: { day: string; succeeded: number; failed: number }[];
};

const JOBS_PAGE = 50;
const JOB_ROW_SELECT = { ...JOB_SAFE_SELECT, tenant: { select: { slug: true, name: true, status: true } } } as const satisfies Prisma.ProvisioningJobSelect;
type JobRecord = Prisma.ProvisioningJobGetPayload<{ select: typeof JOB_ROW_SELECT }>;
/** The order the board lists setups in: what needs somebody first, then what is moving, then what is done. */
const JOB_ORDER = ["FAILED", "RUNNING", "PENDING", "SUCCEEDED"] as const;

function jobFilterWhere(filter: ProvisioningFilters["filter"], now: Date): Prisma.ProvisioningJobWhereInput {
  switch (filter) {
    case "attention":
      return {
        OR: [
          { status: "FAILED" },
          { status: "RUNNING", startedAt: { lt: new Date(now.getTime() - STALE_RUNNING_MS) } },
          { status: "PENDING", runAfter: { lt: new Date(now.getTime() - LATE_PENDING_MS) } },
        ],
      };
    case "progress":
      return { status: { in: ["PENDING", "RUNNING"] } };
    case "done":
      return { status: "SUCCEEDED" };
    default:
      return {};
  }
}

/** The Provisioning page: setups failed first, then running, waiting and done (newest first in each), the warm pool, 14 days of outcomes. */
export async function provisioningBoard(f: ProvisioningFilters, now = new Date()): Promise<ProvisioningBoard> {
  const control = controlDb();
  const latest = latestMigrationName();
  const q = f.q?.trim();
  const search: Prisma.ProvisioningJobWhereInput = q
    ? { OR: [{ companyName: { contains: q, mode: "insensitive" } }, { tenant: { slug: { contains: q, mode: "insensitive" } } }, { tenant: { name: { contains: q, mode: "insensitive" } } }] }
    : {};
  const where: Prisma.ProvisioningJobWhereInput = { AND: [jobFilterWhere(f.filter, now), search] };
  const { year, month, day } = istDateParts(now);
  const firstDay = istMidnight(year, month, day - 13);
  const [everyStatus, staleRunning, latePending, doneToday, lastFinished, filteredStatus, ready, taken, finished] = await Promise.all([
    control.provisioningJob.groupBy({ by: ["status"], _count: { _all: true } }),
    control.provisioningJob.count({ where: { status: "RUNNING", startedAt: { lt: new Date(now.getTime() - STALE_RUNNING_MS) } } }),
    control.provisioningJob.count({ where: { status: "PENDING", runAfter: { lt: new Date(now.getTime() - LATE_PENDING_MS) } } }),
    control.provisioningJob.count({ where: { status: "SUCCEEDED", finishedAt: { gte: new Date(now.getTime() - DAY) } } }),
    control.provisioningJob.aggregate({ _max: { finishedAt: true } }),
    control.provisioningJob.groupBy({ by: ["status"], where, _count: { _all: true } }),
    control.warmDatabase.findMany({ where: { claimedAt: null }, orderBy: { createdAt: "asc" }, select: WARM_SAFE_SELECT }),
    control.warmDatabase.findMany({ where: { claimedAt: { not: null } }, orderBy: { claimedAt: "desc" }, take: 10, select: WARM_SAFE_SELECT }),
    control.provisioningJob.findMany({ where: { status: { in: ["SUCCEEDED", "FAILED"] }, finishedAt: { gte: firstDay } }, select: { status: true, finishedAt: true } }),
  ]);

  // Paged across the status groups in board order: each group is its own query, newest first, so
  // "failed first" holds on every page without sorting the whole table.
  const inFilter = (status: (typeof JOB_ORDER)[number]) => filteredStatus.find((r) => r.status === status)?._count._all ?? 0;
  const total = JOB_ORDER.reduce((sum, s) => sum + inFilter(s), 0);
  const page = clampPage(f.page, total, JOBS_PAGE);
  let skip = (page - 1) * JOBS_PAGE;
  let wanted = JOBS_PAGE;
  const slices: Promise<JobRecord[]>[] = [];
  for (const status of JOB_ORDER) {
    const n = inFilter(status);
    if (wanted === 0) break;
    if (skip >= n) {
      skip -= n;
      continue;
    }
    const take = Math.min(wanted, n - skip);
    slices.push(
      control.provisioningJob.findMany({
        where: { AND: [where, { status }] },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take,
        select: JOB_ROW_SELECT,
      }),
    );
    wanted -= take;
    skip = 0;
  }
  const claimedBy = unique(taken.map((w) => w.claimedByTenantId).filter((id): id is string => !!id));
  const [jobs, takers] = await Promise.all([
    Promise.all(slices).then((parts) => parts.flat()),
    claimedBy.length ? control.tenant.findMany({ where: { id: { in: claimedBy } }, select: { id: true, slug: true } }) : Promise.resolve([]),
  ]);

  const count = (status: (typeof JOB_ORDER)[number]) => everyStatus.find((r) => r.status === status)?._count._all ?? 0;
  const [failed, running, waiting, succeeded] = JOB_ORDER.map(count);
  const slugOf = new Map(takers.map((t) => [t.id, t.slug]));
  const days = Array.from({ length: 14 }, (_, i) => istDayKey(istMidnight(year, month, day - 13 + i)));
  const byDay = days.map((key) => ({ day: key, succeeded: 0, failed: 0 }));
  for (const job of finished) {
    const bucket = job.finishedAt ? byDay.find((d) => d.day === istDayKey(job.finishedAt!)) : undefined;
    if (bucket) bucket[job.status === "SUCCEEDED" ? "succeeded" : "failed"] += 1;
  }

  return {
    asOf: now,
    live: running + waiting > 0,
    workerLastFinished: lastFinished._max.finishedAt,
    counts: { running, waiting, failed, doneToday, all: failed + running + waiting + succeeded, attention: failed + staleRunning + latePending, progress: running + waiting, done: succeeded },
    rows: jobs.map((j) => ({
      id: j.id,
      tenant: { slug: j.tenant.slug, name: j.tenant.name, status: j.tenant.status },
      status: j.status,
      step: j.step,
      attempts: j.attempts,
      maxAttempts: MAX_ATTEMPTS,
      runAfter: j.runAfter,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      durationMs:
        j.status === "RUNNING" && j.startedAt
          ? Math.max(0, now.getTime() - j.startedAt.getTime())
          : (j.status === "SUCCEEDED" || j.status === "FAILED") && j.startedAt && j.finishedAt
            ? Math.max(0, j.finishedAt.getTime() - j.startedAt.getTime())
            : null,
      error: redactSecrets(j.error),
      ownerName: j.ownerName,
      ownerEmail: j.ownerEmail,
      companyName: j.companyName,
      country: j.country,
      planKey: j.planKey,
      createdAt: j.createdAt,
    })),
    total,
    page,
    pageSize: JOBS_PAGE,
    warm: {
      target: WARM_POOL_SIZE,
      ready: ready.map((w) => ({ id: w.id, dbName: w.dbName, schemaVersion: w.schemaVersion, current: latest !== null && w.schemaVersion === latest, createdAt: w.createdAt })),
      taken: taken.map((w) => ({
        id: w.id,
        dbName: w.dbName,
        claimedAt: w.claimedAt!,
        tenant: w.claimedByTenantId && slugOf.has(w.claimedByTenantId) ? { slug: slugOf.get(w.claimedByTenantId)! } : null,
      })),
    },
    byDay,
  };
}

// ─── Migrations ──────────────────────────────────────────────────────────────────────────────────

export type BehindRow = {
  id: string;
  slug: string;
  name: string;
  status: TenantStatusKey;
  schemaVersion: string | null;
  /** Migrations after its own; null when it has none recorded, or one this code does not carry. */
  behindBy: number | null;
  lastAttempt: { at: Date; ok: boolean | null } | null;
};
export type RunGroup = {
  runId: string;
  startedAt: Date;
  /** When its last database finished; null while any is still running. */
  finishedAt: Date | null;
  /** The staff member who started it from the console, or the script; null while a run nobody claimed is going. */
  by: string | null;
  targets: number;
  ok: number;
  failed: number;
  running: number;
  durationMs: number | null;
  /** Oldest first; `output` redacted. */
  rows: { id: string; target: string; fromVersion: string | null; toVersion: string | null; ok: boolean | null; startedAt: Date; finishedAt: Date | null; output: string | null }[];
};
export type MigrationsBoard = {
  asOf: Date;
  live: boolean;
  latest: string | null;
  counts: { total: number; upToDate: number; behind: number; held: number };
  behind: BehindRow[];
  runs: RunGroup[];
  runsTotal: number;
  page: number;
  lastFullRun: { runId: string; startedAt: Date; ok: boolean | null; by: string | null } | null;
};

const RUN_GROUPS_PAGE = 20;
const SCRIPT_RUN = "npm run tenants:migrate";

/**
 * Who started each run: a console migration writes `migrate.workspace` (or a batch `migrate.batch`)
 * with its run id; anything else came from the server's own `npm run tenants:migrate`.
 */
async function runStarters(runIds: string[]): Promise<Map<string, string>> {
  if (runIds.length === 0) return new Map();
  const rows = await controlDb().platformAuditLog.findMany({
    where: { action: { in: ["migrate.workspace", "migrate.batch"] }, OR: runIds.map((runId) => ({ detail: { path: ["runId"], equals: runId } })) },
    orderBy: { at: "asc" },
    select: { actorKind: true, actor: true, detail: true },
  });
  const names = await staffNameMap(rows.filter((r) => r.actorKind === "STAFF").map((r) => r.actor));
  const by = new Map<string, string>();
  for (const r of rows) {
    const runId = (r.detail as { runId?: unknown } | null)?.runId;
    if (typeof runId === "string" && !by.has(runId)) by.set(runId, actorLabel(r.actorKind, r.actor, names));
  }
  return by;
}

/** The Migrations page: who is behind the latest schema, and the runs, grouped, 20 a page. */
export async function migrationsBoard(f: MigrationFilters, now = new Date()): Promise<MigrationsBoard> {
  const control = controlDb();
  const latest = latestMigrationName();
  const names = workspaceMigrationNames();
  const q = f.q?.trim().toLowerCase();
  // A run is listed when it has a failure (outcome "failed") and a target matching the search.
  const filters: Prisma.Sql[] = [];
  if (f.outcome === "failed") filters.push(Prisma.sql`"runId" IN (SELECT "runId" FROM "tenant_migration_runs" WHERE "ok" = false)`);
  if (q) filters.push(Prisma.sql`"runId" IN (SELECT "runId" FROM "tenant_migration_runs" WHERE strpos(lower("target"), ${q}) > 0)`);
  const runWhere = filters.length ? Prisma.sql`WHERE ${Prisma.join(filters, " AND ")}` : Prisma.empty;

  const [total, held, behindTenants, runCount, liveRuns, lastFull] = await Promise.all([
    control.tenant.count({ where: { status: { in: [...OPEN_OR_MIGRATING] } } }),
    control.tenant.count({ where: { status: "MIGRATING" } }),
    // Behind: open and not at the latest schema — and every workspace held for a failed migration, which a run retries.
    control.tenant.findMany({
      where: { OR: [{ status: "MIGRATING" }, { status: "ACTIVE", ...behindWhere(latest) }] },
      select: { id: true, slug: true, name: true, status: true, schemaVersion: true },
    }),
    control.$queryRaw<{ n: bigint | number }[]>`SELECT COUNT(DISTINCT "runId") AS "n" FROM "tenant_migration_runs" ${runWhere}`,
    control.tenantMigrationRun.count({ where: { startedAt: { gte: new Date(now.getTime() - HOUR) }, finishedAt: null } }),
    // A full run always starts with the control plane; a run for named workspaces never does.
    control.tenantMigrationRun.findFirst({ where: { target: "control" }, orderBy: { startedAt: "desc" }, select: { runId: true, startedAt: true } }),
  ]);
  const runsTotal = Number(runCount[0]?.n ?? 0);
  const page = clampPage(f.page, runsTotal, RUN_GROUPS_PAGE);
  const offset = (page - 1) * RUN_GROUPS_PAGE;
  const behindIds = behindTenants.map((t) => t.id);

  const [pageRuns, attempts] = await Promise.all([
    runsTotal
      ? control.$queryRaw<{ runId: string; startedAt: Date }[]>`
          SELECT "runId", MIN("startedAt") AS "startedAt" FROM "tenant_migration_runs" ${runWhere}
          GROUP BY "runId" ORDER BY MIN("startedAt") DESC, "runId" DESC
          LIMIT ${Prisma.raw(String(RUN_GROUPS_PAGE))} OFFSET ${Prisma.raw(String(offset))}`
      : Promise.resolve([]),
    behindIds.length
      ? control.$queryRaw<{ tenantId: string; startedAt: Date; ok: boolean | null }[]>`
          SELECT DISTINCT ON ("tenantId") "tenantId", "startedAt", "ok" FROM "tenant_migration_runs"
          WHERE "tenantId" = ANY(${behindIds}::text[])
          ORDER BY "tenantId", "startedAt" DESC`
      : Promise.resolve([]),
  ]);
  const runIds = pageRuns.map((r) => r.runId);
  const [rows, fullRows, starters] = await Promise.all([
    runIds.length
      ? control.tenantMigrationRun.findMany({
          where: { runId: { in: runIds } },
          orderBy: [{ startedAt: "asc" }, { id: "asc" }],
          select: { id: true, runId: true, target: true, fromVersion: true, toVersion: true, ok: true, startedAt: true, finishedAt: true, output: true },
        })
      : Promise.resolve([]),
    lastFull ? control.tenantMigrationRun.findMany({ where: { runId: lastFull.runId }, select: { ok: true, finishedAt: true } }) : Promise.resolve([]),
    runStarters(unique([...runIds, ...(lastFull ? [lastFull.runId] : [])])),
  ]);

  // A run nobody from the console claimed is the script's — once it has finished; while it runs, the
  // console's own entry (written when its outcome is known) may be still to come.
  const starter = (runId: string, running: boolean) => starters.get(runId) ?? (running ? null : SCRIPT_RUN);
  const runs: RunGroup[] = pageRuns.map((group) => {
    const mine = rows.filter((r) => r.runId === group.runId);
    const running = mine.filter((r) => r.finishedAt === null).length;
    const finishedAt = running === 0 && mine.length ? new Date(Math.max(...mine.map((r) => r.finishedAt!.getTime()))) : null;
    const startedAt = mine.length ? mine[0].startedAt : group.startedAt;
    return {
      runId: group.runId,
      startedAt,
      finishedAt,
      by: starter(group.runId, running > 0),
      targets: mine.length,
      ok: mine.filter((r) => r.ok === true).length,
      failed: mine.filter((r) => r.ok === false).length,
      running,
      durationMs: finishedAt ? Math.max(0, finishedAt.getTime() - startedAt.getTime()) : null,
      rows: mine.map((r) => ({
        id: r.id,
        target: r.target,
        fromVersion: r.fromVersion,
        toVersion: r.toVersion,
        ok: r.ok,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        output: redactSecrets(r.output),
      })),
    };
  });

  const lastAttempt = new Map(attempts.map((a) => [a.tenantId, { at: a.startedAt, ok: a.ok }]));
  // Held for a failed migration first — those are the ones to look at — then by address.
  const behind: BehindRow[] = behindTenants
    .map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      status: t.status,
      schemaVersion: t.schemaVersion,
      behindBy: behindBy(t.schemaVersion, names),
      lastAttempt: lastAttempt.get(t.id) ?? null,
    }))
    .sort((a, b) => Number(b.status === "MIGRATING") - Number(a.status === "MIGRATING") || a.slug.localeCompare(b.slug));

  const fullRunning = fullRows.some((r) => r.finishedAt === null);
  return {
    asOf: now,
    live: liveRuns > 0,
    latest,
    counts: { total, upToDate: Math.max(0, total - behind.length), behind: behind.length, held },
    behind,
    runs,
    runsTotal,
    page,
    lastFullRun: lastFull
      ? {
          runId: lastFull.runId,
          startedAt: lastFull.startedAt,
          ok: fullRows.some((r) => r.ok === false) ? false : fullRunning ? null : true,
          by: starter(lastFull.runId, fullRunning),
        }
      : null,
  };
}

// ─── Terminals ───────────────────────────────────────────────────────────────────────────────────

export type TerminalRow = { serial: string; tenant: { slug: string; name: string }; createdAt: Date; lastSeenAt: Date | null; state: TerminalState };
export type TerminalsPage = {
  rows: TerminalRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Following the search and workspace, not the state filter. */
  counts: Record<TerminalState, number> & { total: number };
};

const TERMINALS_PAGE = 50;

/** Live: heard from in the last 24 hours; quiet: 1 to 7 days ago; stale: longer; never: not once since it was routed. */
function terminalState(lastSeenAt: Date | null, now: Date): TerminalState {
  if (!lastSeenAt) return "never";
  const since = now.getTime() - lastSeenAt.getTime();
  return since < DAY ? "live" : since <= 7 * DAY ? "quiet" : "stale";
}

function terminalStateWhere(state: TerminalState, now: Date): Prisma.BiometricDeviceRouteWhereInput {
  const dayAgo = new Date(now.getTime() - DAY);
  const weekAgo = new Date(now.getTime() - 7 * DAY);
  switch (state) {
    case "live":
      return { lastSeenAt: { gt: dayAgo } };
    case "quiet":
      return { lastSeenAt: { lte: dayAgo, gte: weekAgo } };
    case "stale":
      return { lastSeenAt: { lt: weekAgo } };
    case "never":
      return { lastSeenAt: null };
  }
}

/** The Terminals page: routed serials, newest first, found by serial or workspace, and how recently each was heard from. */
export async function terminals(f: TerminalFilters, now = new Date()): Promise<TerminalsPage> {
  const control = controlDb();
  const q = f.q?.trim();
  const base: Prisma.BiometricDeviceRouteWhereInput = {
    AND: [
      q
        ? {
            OR: [
              { serial: { startsWith: normaliseSerial(q) } },
              { tenant: { slug: { contains: q, mode: "insensitive" } } },
              { tenant: { name: { contains: q, mode: "insensitive" } } },
            ],
          }
        : {},
      f.tenant ? { tenant: { slug: f.tenant } } : {},
    ],
  };
  const [all, live, quiet, stale, never] = await Promise.all([
    control.biometricDeviceRoute.count({ where: base }),
    control.biometricDeviceRoute.count({ where: { AND: [base, terminalStateWhere("live", now)] } }),
    control.biometricDeviceRoute.count({ where: { AND: [base, terminalStateWhere("quiet", now)] } }),
    control.biometricDeviceRoute.count({ where: { AND: [base, terminalStateWhere("stale", now)] } }),
    control.biometricDeviceRoute.count({ where: { AND: [base, terminalStateWhere("never", now)] } }),
  ]);
  const counts = { live, quiet, stale, never, total: all };
  const total = f.state ? counts[f.state] : all;
  const page = clampPage(f.page, total, TERMINALS_PAGE);
  const rows = total
    ? await control.biometricDeviceRoute.findMany({
        where: f.state ? { AND: [base, terminalStateWhere(f.state, now)] } : base,
        orderBy: [{ createdAt: "desc" }, { serial: "asc" }],
        skip: (page - 1) * TERMINALS_PAGE,
        take: TERMINALS_PAGE,
        select: { serial: true, createdAt: true, lastSeenAt: true, tenant: { select: { slug: true, name: true } } },
      })
    : [];
  return {
    rows: rows.map((r) => ({ serial: r.serial, tenant: r.tenant, createdAt: r.createdAt, lastSeenAt: r.lastSeenAt, state: terminalState(r.lastSeenAt, now) })),
    total,
    page,
    pageSize: TERMINALS_PAGE,
    counts,
  };
}
