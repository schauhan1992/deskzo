import { controlDb } from "@/lib/platform/control-db";
import { latestMigrationName } from "@/lib/platform/migrate";
import { activeSupportGrant } from "@/lib/platform/support";
import { parseEntitlements } from "@/lib/entitlements";
import { billingStanding } from "@/lib/billing/lifecycle";
import { consoleOrigin } from "@/lib/platform/staff";
import { autoDeprovision, secretsSet, signupOpen, trialDays } from "@/lib/platform/settings";
import { subdomainHost } from "@/lib/tenancy/registry";

/**
 * What the console shows — read from the control plane only. The console never opens a workspace's
 * database to look at it; staff who need to see inside one go in as support, on its grant.
 *
 * Every function here is called by a console page after `requireStaff` (src/lib/platform/
 * staff-session.ts); none is an action, so none can be called from a browser.
 */

export async function overview() {
  const control = controlDb();
  const version = latestMigrationName();
  const [byStatus, failedJobs, pendingJobs, drift, warm, grants, recent] = await Promise.all([
    control.tenant.groupBy({ by: ["status"], _count: { _all: true } }),
    control.provisioningJob.count({ where: { status: "FAILED" } }),
    control.provisioningJob.count({ where: { status: { in: ["PENDING", "RUNNING"] } } }),
    control.tenant.count({ where: { status: { in: ["ACTIVE", "MIGRATING"] }, NOT: { schemaVersion: version } } }),
    control.warmDatabase.count({ where: { claimedAt: null } }),
    control.supportAccessGrant.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
    control.platformAuditLog.findMany({ orderBy: { at: "desc" }, take: 12, include: { tenant: { select: { slug: true } } } }),
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

export async function tenantDetail(slug: string) {
  const control = controlDb();
  const tenant = await control.tenant.findUnique({
    where: { slug },
    include: {
      domains: { orderBy: { createdAt: "asc" } },
      deviceRoutes: { orderBy: { createdAt: "asc" } },
      provisioningJobs: { orderBy: { createdAt: "desc" }, take: 5 },
      migrationRuns: { orderBy: { startedAt: "desc" }, take: 10 },
      auditLog: { orderBy: { at: "desc" }, take: 30 },
    },
  });
  if (!tenant) return null;
  const [grant, grants, leases, subscriptions, overrides] = await Promise.all([
    activeSupportGrant(tenant.id, true),
    control.supportAccessGrant.findMany({ where: { tenantId: tenant.id }, orderBy: { createdAt: "desc" }, take: 10 }),
    control.tenantJobLease.findMany({ where: { tenantId: tenant.id }, orderBy: { job: "asc" } }),
    control.subscription.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: "desc" },
      include: { items: { include: { plan: { select: { key: true, name: true, kind: true, active: true } } } } },
    }),
    control.tenantModuleOverride.findMany({ where: { tenantId: tenant.id }, orderBy: { moduleKey: "asc" } }),
  ]);
  const [invoicesOf, standing, usage] = await Promise.all([
    control.invoice.findMany({ where: { tenantId: tenant.id }, orderBy: { issuedAt: "desc" }, take: 12 }),
    billingStanding(tenant.id),
    control.tenantUsage.findFirst({ where: { tenantId: tenant.id }, orderBy: { day: "desc" } }),
  ]);
  return {
    tenant,
    host: subdomainHost(tenant.slug),
    grant,
    grants,
    leases,
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
    control.provisioningJob.findMany({ orderBy: { createdAt: "desc" }, take: 50, include: { tenant: { select: { slug: true, name: true, status: true } } } }),
    control.warmDatabase.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  return { jobs, warm, version: latestMigrationName() };
}

export async function migrationRuns() {
  const control = controlDb();
  const version = latestMigrationName();
  const [runs, behind] = await Promise.all([
    control.tenantMigrationRun.findMany({ orderBy: { startedAt: "desc" }, take: 80 }),
    control.tenant.findMany({
      where: { status: { in: ["ACTIVE", "MIGRATING"] }, NOT: { schemaVersion: version } },
      select: { id: true, slug: true, name: true, status: true, schemaVersion: true },
      orderBy: { slug: "asc" },
    }),
  ]);
  return { version, runs, behind };
}

export async function deviceRoutes() {
  return controlDb().biometricDeviceRoute.findMany({ orderBy: { createdAt: "desc" }, take: 500, include: { tenant: { select: { slug: true, name: true } } } });
}

/** Each with whether it still works: not expired, and not used up. */
/** Every plan, with its modules, its prices, and how many workspaces are on it. */
export async function plansList() {
  const plans = await controlDb().plan.findMany({
    orderBy: [{ active: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
    include: { prices: { orderBy: [{ active: "desc" }, { createdAt: "desc" }] }, modules: { select: { moduleKey: true } }, items: { where: { subscription: { status: { in: ["TRIALING", "ACTIVE", "PAST_DUE"] } } }, select: { subscription: { select: { tenantId: true } } } } },
  });
  return plans.map(({ items, modules, ...plan }) => ({
    ...plan,
    modules: modules.map((m) => m.moduleKey),
    workspaces: new Set(items.map((i) => i.subscription.tenantId)).size,
  }));
}

/** The console's Billing page: settings (secrets only as set or not), webhook addresses, recent events and invoices. */
export async function billingOverview() {
  const control = controlDb();
  const [secrets, open, days, closeByItself, events, invoices, failing] = await Promise.all([
    secretsSet(),
    signupOpen(),
    trialDays(),
    autoDeprovision(),
    control.billingEvent.findMany({ orderBy: { receivedAt: "desc" }, take: 50, select: { id: true, gateway: true, eventId: true, type: true, tenantId: true, receivedAt: true, processedAt: true, error: true } }),
    control.invoice.findMany({ orderBy: { issuedAt: "desc" }, take: 50, include: { tenant: { select: { slug: true } } } }),
    control.billingEvent.count({ where: { processedAt: null, error: { not: null } } }),
  ]);
  const origin = consoleOrigin();
  return {
    secrets,
    signupOpen: open,
    trialDays: days,
    autoDeprovision: closeByItself,
    webhooks: { stripe: `${origin}/api/platform/billing/stripe`, razorpay: `${origin}/api/platform/billing/razorpay`, tick: `${origin}/api/platform/tick` },
    events,
    invoices,
    failing,
  };
}

export async function invites() {
  const rows = await controlDb().signupInvite.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  const now = Date.now();
  return rows.map((i) => ({ ...i, live: (!i.expiresAt || i.expiresAt.getTime() > now) && i.uses < i.maxUses }));
}

export async function staffMembers() {
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
      sessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } },
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
