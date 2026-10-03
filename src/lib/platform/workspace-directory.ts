import Papa from "papaparse";
import type { Prisma, SubscriptionStatus } from "@deskzo/control-client";
import { billingStandings, standingDate, type Standing } from "@/lib/billing/lifecycle";
import { csvFilename, daysBetween } from "@/lib/console-shared/format";
import { STANDING_KIND_LABEL, TENANT_STATUS, actorLabel } from "@/lib/console-shared/labels";
import type { DirectoryFilters, DirectorySort, DirectoryView } from "@/lib/console-shared/params";
import type { CsvExport, StandingKind, TenantStatusKey } from "@/lib/console-shared/types";
import { consoleClock } from "@/lib/platform/console-clock";
import { EXPORT_CAPS, staffNameMap } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import { LIVE_STATUSES } from "@/lib/platform/entitlements";
import { RETENTION_DAYS } from "@/lib/platform/lifecycle";
import { ConsoleRefused } from "@/lib/platform/refused";
import { behindBy, workspaceMigrationNames } from "@/lib/platform/schema-info";
import { latestUsage, type LatestUsage } from "@/lib/platform/usage";
import { protocolFor } from "@/lib/tenancy/host";
import { subdomainHost } from "@/lib/tenancy/registry";
import type { Clock } from "@/lib/time/zone";

/**
 * The console's list of workspaces (/workspaces): its filters and views, the counts beside them, the
 * CSV export of what is on screen, and the workspaces that have been closed.
 *
 * A list is worked out in one of two ways. When every filter and the sort are columns of the tenant
 * row, the database pages it (count + skip/take). When one needs each workspace's billing standing
 * or seats — the attention, trial and past-due views, the standing filter, and the seats, trial and
 * standing sorts — the matching ids are loaded (at most 10,000; the page says when there were more),
 * their standings come from `billingStandings` in two queries a thousand, and the filter, sort and
 * page happen here. Either way only the page's rows are then read in full.
 *
 * Read from the control plane only, with explicit selects: no key, database address or payload ever
 * leaves it. A closed workspace's keys are reported as kept or not by Postgres itself — the sealed
 * bundle is compared there and never read.
 */

export type { DirectoryFilters, DirectoryView, DirectorySort } from "@/lib/console-shared/params";

export type DirectoryRow = {
  id: string;
  slug: string;
  name: string;
  status: TenantStatusKey;
  suspendedFor: "STAFF" | "BILLING" | null;
  isDefault: boolean;
  /** Its primary domain, or its subdomain; `url` is that address with the right scheme. */
  host: string;
  url: string;
  country: string;
  ownerEmail: string | null;
  billingEmail: string | null;
  createdAt: Date;
  schemaVersion: string | null;
  /** Open (or held mid-migration) and not at the newest workspace migration — what "Migrate now" is for. */
  schemaBehind: boolean;
  /** Migrations after its own; null when it has none, or one this code does not carry. */
  behindBy: number | null;
  /** Its live subscriptions' plans, a plan on two of them added up. */
  plans: { key: string; name: string; quantity: number }[];
  standing: { kind: StandingKind; at: Date | null };
  /** The latest daily usage snapshot; null before the first. */
  seats: { used: number; limit: number | null; day: Date } | null;
  /** Support access its super admin has granted, while it lasts. */
  grant: { level: "READONLY" | "ADMIN"; expiresAt: Date } | null;
  tags: string[];
  domains: number;
};

export type DirectoryPage = {
  rows: DirectoryRow[];
  total: number;
  /** The page shown: the one asked for, or the last there is when it asked for more. */
  page: number;
  pageSize: number;
  /** More than 10,000 workspaces matched a filter or sort worked out here; only the newest 10,000 were considered. */
  capped: boolean;
  asOf: Date;
};

export type DirectoryFacets = {
  views: Record<DirectoryView, number>;
  byStatus: Record<TenantStatusKey, number>;
  heldBilling: number;
  heldStaff: number;
  behind: number;
  tags: { tag: string; n: number }[];
  countries: { country: string; n: number }[];
  plans: { key: string; name: string }[];
  asOf: Date;
};

export type ClosedWorkspace = {
  id: string;
  slug: string;
  name: string;
  deprovisionedAt: Date;
  /** When its keys and final backups may be purged (on the server — never from the console). */
  purgeDueAt: Date;
  /** Days until then; 0 or less once it is due. */
  daysLeft: number;
  /** Its key bundle is still there — its final backup can still be read. */
  keysKept: boolean;
  /** The final backup's file name, from the audit entry of the close; null when none was taken. */
  backup: string | null;
  closedBy: string | null;
  purgedAt: Date | null;
};

const DAY = 86_400_000;
/** Matches worked through in memory when a filter or sort needs standings or seats. */
const DIRECTORY_CAP = 10_000;
const LIVE: SubscriptionStatus[] = [...LIVE_STATUSES];
/** Matches nothing — a filter that cannot be satisfied (no migrations known to compare with). */
const NOTHING: Prisma.TenantWhereInput = { id: { in: [] } };

/** Standings that need someone: the attention view, with held, migration-held, failed setups and behind schema. */
const ATTENTION_STANDINGS: readonly StandingKind[] = ["past-due", "trial-over", "lapsed"];
/** The standing sort: what will be held or has lapsed first, those who pay last. */
const STANDING_ORDER: Record<StandingKind, number> = { lapsed: 0, "past-due": 1, "trial-over": 2, ending: 3, trial: 4, none: 5, paid: 6, exempt: 7 };
const NO_STANDING: Standing = { kind: "none" };

// ─── The where clause ────────────────────────────────────────────────────────────────────────────

/** The newest workspace migration this code carries; null when the folder could not be read. */
const latestOf = (names: string[]): string | null => names.at(-1) ?? null;

/** Open or held mid-migration, and not at the newest migration (none recorded counts as behind). */
function behindWhere(latest: string | null): Prisma.TenantWhereInput {
  if (!latest) return NOTHING;
  return { status: { in: ["ACTIVE", "MIGRATING"] }, OR: [{ schemaVersion: null }, { schemaVersion: { not: latest } }] };
}

/** The same test as `behindWhere`, on a row already read. */
function isBehind(t: { status: TenantStatusKey; schemaVersion: string | null }, latest: string | null): boolean {
  return latest !== null && (t.status === "ACTIVE" || t.status === "MIGRATING") && t.schemaVersion !== latest;
}

function gatewayWhere(gateway: NonNullable<DirectoryFilters["gateway"]>): Prisma.TenantWhereInput {
  switch (gateway) {
    case "STRIPE":
    case "RAZORPAY":
      return { subscriptions: { some: { gateway, status: { in: LIVE } } } };
    case "TRIAL":
      return { subscriptions: { some: { gateway: "MANUAL", status: "TRIALING" } } };
    case "GIVEN":
      return { subscriptions: { some: { gateway: "MANUAL", status: "ACTIVE" } } };
    default:
      return { subscriptions: { none: { status: { in: LIVE } } } };
  }
}

/** Name, address, owner or billing email, its id, a gateway customer id (spaces ignored), or one of its domains. */
function searchWhere(q: string): Prisma.TenantWhereInput {
  const compact = q.replace(/\s+/g, "");
  return {
    OR: [
      { slug: { contains: q, mode: "insensitive" } },
      { name: { contains: q, mode: "insensitive" } },
      { ownerEmail: { contains: q, mode: "insensitive" } },
      { billingEmail: { contains: q, mode: "insensitive" } },
      { id: q },
      ...(compact ? [{ stripeCustomerId: { startsWith: compact } }, { razorpayCustomerId: { startsWith: compact } }] : []),
      { domains: { some: { host: { contains: q, mode: "insensitive" } } } },
    ],
  };
}

/**
 * Every filter that is a column of the tenant row (or a join from it). The views that need a
 * standing add nothing here — they are applied to the matches afterwards. Closed workspaces are left
 * out unless the view or the status filter asks for them.
 */
async function directoryWhere(f: DirectoryFilters, latest: string | null, now: Date): Promise<Prisma.TenantWhereInput> {
  const and: Prisma.TenantWhereInput[] = [];
  if (f.status) and.push({ status: f.status });
  if (f.view === "closed") and.push({ status: "DEPROVISIONED" });
  else if (f.status !== "DEPROVISIONED") and.push({ status: { not: "DEPROVISIONED" } });
  if (f.view === "held") and.push({ status: "SUSPENDED" });
  if (f.view === "setting-up") and.push({ status: "PROVISIONING" });
  if (f.view === "behind" || f.schema === "behind") and.push(behindWhere(latest));
  if (f.schema === "current") and.push(latest ? { schemaVersion: latest } : NOTHING);
  if (f.heldFor) and.push({ status: "SUSPENDED", suspendedFor: f.heldFor });
  if (f.country) and.push({ country: f.country });
  if (f.tag) and.push({ tags: { has: f.tag } });
  if (f.plan) and.push({ subscriptions: { some: { status: { in: LIVE }, items: { some: { plan: { key: f.plan } } } } } });
  if (f.gateway) and.push(gatewayWhere(f.gateway));
  if (f.grant === "live") {
    const grants = await controlDb().supportAccessGrant.findMany({
      where: { revokedAt: null, expiresAt: { gt: now } },
      select: { tenantId: true },
      distinct: ["tenantId"],
    });
    and.push({ id: { in: grants.map((g) => g.tenantId) } });
  }
  // Made within whole days on the console's clock, half-open.
  const createdAt = f.from || f.to ? (await consoleClock()).dayRange(f.from, f.to) : null;
  if (createdAt) and.push({ createdAt });
  if (f.ids?.length) and.push({ id: { in: f.ids } });
  if (f.q) and.push(searchWhere(f.q));
  return { AND: and };
}

/** The sorts the database can do; the others start from newest first and are sorted here. */
function orderBy(sort: DirectorySort): Prisma.TenantOrderByWithRelationInput[] {
  if (sort === "created") return [{ createdAt: "asc" }, { id: "asc" }];
  if (sort === "name") return [{ name: "asc" }, { slug: "asc" }];
  return [{ createdAt: "desc" }, { id: "asc" }];
}

const needsStanding = (f: DirectoryFilters) =>
  f.view === "attention" || f.view === "trials" || f.view === "past-due" || f.standing !== undefined || f.sort === "trial" || f.sort === "standing";
const isComputed = (f: DirectoryFilters) => needsStanding(f) || f.sort === "-seats";

// ─── Worked out here: standing filters and sorts ─────────────────────────────────────────────────

type Candidate = { id: string; status: TenantStatusKey; schemaVersion: string | null };

/** Workspaces whose setup job has failed and not been retried. */
async function failedSetups(): Promise<Set<string>> {
  const jobs = await controlDb().provisioningJob.findMany({ where: { status: "FAILED" }, select: { tenantId: true }, distinct: ["tenantId"] });
  return new Set(jobs.map((j) => j.tenantId));
}

/** Held, held mid-migration, behind schema, a failed setup, or a standing that ends in a hold. */
function needsAttention(t: Candidate, standing: Standing, failed: ReadonlySet<string>, latest: string | null): boolean {
  return t.status === "SUSPENDED" || t.status === "MIGRATING" || failed.has(t.id) || isBehind(t, latest) || ATTENTION_STANDINGS.includes(standing.kind);
}

function keeps(f: DirectoryFilters, t: Candidate, standing: Standing, failed: ReadonlySet<string>, latest: string | null): boolean {
  if (f.standing && standing.kind !== f.standing) return false;
  if (f.view === "trials") return standing.kind === "trial";
  if (f.view === "past-due") return standing.kind === "past-due" || standing.kind === "trial-over";
  if (f.view === "attention") return needsAttention(t, standing, failed, latest);
  return true;
}

/** A sort key per workspace: lower first. Ties keep the newest-first order the matches came in. */
function sortKey(sort: DirectorySort, standing: Standing | undefined, usage: LatestUsage | undefined): [number, number] {
  if (sort === "-seats") return [usage ? -usage.seatsUsed : 1, 0];
  const s = standing ?? NO_STANDING;
  if (sort === "trial") {
    if (s.kind === "trial") return [0, s.endsAt.getTime()];
    if (s.kind === "trial-over") return [1, s.holdAt.getTime()];
    return [2, 0];
  }
  if (sort === "standing") return [STANDING_ORDER[s.kind], standingDate(s)?.getTime() ?? Number.MAX_SAFE_INTEGER];
  return [0, 0];
}

type Matches = { ids: string[]; capped: boolean; standings: Map<string, Standing> | null; usage: Map<string, LatestUsage> | null };

/** Phase two: every match's id (newest 10,000), filtered and sorted by what the rows alone cannot say. */
async function computedMatches(f: DirectoryFilters, where: Prisma.TenantWhereInput, latest: string | null, now: Date): Promise<Matches> {
  const found = await controlDb().tenant.findMany({
    where,
    orderBy: orderBy(f.sort),
    take: DIRECTORY_CAP + 1,
    select: { id: true, status: true, schemaVersion: true },
  });
  const capped = found.length > DIRECTORY_CAP;
  const candidates: Candidate[] = capped ? found.slice(0, DIRECTORY_CAP) : found;
  const ids = candidates.map((c) => c.id);
  const [standings, usage, failed] = await Promise.all([
    needsStanding(f) ? billingStandings(ids, now) : null,
    f.sort === "-seats" ? latestUsage(ids) : null,
    f.view === "attention" ? failedSetups() : new Set<string>(),
  ]);
  let kept = standings ? candidates.filter((c) => keeps(f, c, standings.get(c.id) ?? NO_STANDING, failed, latest)) : candidates;
  if (f.sort === "-seats" || f.sort === "trial" || f.sort === "standing") {
    const keyed = kept.map((c, i) => ({ c, i, key: sortKey(f.sort, standings?.get(c.id), usage?.get(c.id)) }));
    keyed.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.i - b.i);
    kept = keyed.map((k) => k.c);
  }
  return { ids: kept.map((c) => c.id), capped, standings, usage };
}

function clampPage(page: number, total: number, pageSize: number): number {
  const last = Math.max(1, Math.ceil(total / pageSize));
  return Math.min(Math.max(1, Math.trunc(page) || 1), last);
}

// ─── The rows ────────────────────────────────────────────────────────────────────────────────────

/**
 * The rows for `ids`, in that order. Standings and usage already worked out for the matches are
 * reused rather than read again. An id whose workspace has gone in the meantime is left out.
 */
async function directoryRows(
  ids: string[],
  names: string[],
  now: Date,
  known: { standings: Map<string, Standing> | null; usage: Map<string, LatestUsage> | null },
): Promise<DirectoryRow[]> {
  if (!ids.length) return [];
  const control = controlDb();
  const latest = latestOf(names);
  const [tenants, standings, usage, grants, items] = await Promise.all([
    control.tenant.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        suspendedFor: true,
        isDefault: true,
        country: true,
        ownerEmail: true,
        billingEmail: true,
        createdAt: true,
        schemaVersion: true,
        tags: true,
        // The address links use: a primary that is live (one waiting or stopped is not served).
        domains: { where: { isPrimary: true, status: "ACTIVE" }, select: { host: true }, orderBy: { createdAt: "asc" } },
        _count: { select: { domains: true } },
      },
    }),
    known.standings ?? billingStandings(ids, now),
    known.usage ?? latestUsage(ids),
    control.supportAccessGrant.findMany({
      where: { tenantId: { in: ids }, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
      select: { tenantId: true, level: true, expiresAt: true },
    }),
    control.subscriptionItem.findMany({
      where: { subscription: { tenantId: { in: ids }, status: { in: LIVE } } },
      select: { quantity: true, subscription: { select: { tenantId: true } }, plan: { select: { key: true, name: true } } },
    }),
  ]);

  // One grant is live at a time; should two overlap, the newest is the one that counts.
  const grantOf = new Map<string, DirectoryRow["grant"]>();
  for (const g of grants) if (!grantOf.has(g.tenantId)) grantOf.set(g.tenantId, { level: g.level, expiresAt: g.expiresAt });

  const plansOf = new Map<string, Map<string, DirectoryRow["plans"][number]>>();
  for (const item of items) {
    const tenantId = item.subscription.tenantId;
    const plans = plansOf.get(tenantId) ?? new Map<string, DirectoryRow["plans"][number]>();
    plansOf.set(tenantId, plans);
    const had = plans.get(item.plan.key);
    plans.set(item.plan.key, { key: item.plan.key, name: item.plan.name, quantity: (had?.quantity ?? 0) + item.quantity });
  }

  const byId = new Map(tenants.map((t) => [t.id, t]));
  return ids.flatMap((id): DirectoryRow[] => {
    const t = byId.get(id);
    if (!t) return [];
    const host = t.domains[0]?.host ?? subdomainHost(t.slug);
    const standing = standings.get(id) ?? NO_STANDING;
    const use = usage.get(id);
    return [
      {
        id: t.id,
        slug: t.slug,
        name: t.name,
        status: t.status,
        suspendedFor: t.suspendedFor,
        isDefault: t.isDefault,
        host,
        url: `${protocolFor(host)}://${host}`,
        country: t.country,
        ownerEmail: t.ownerEmail,
        billingEmail: t.billingEmail,
        createdAt: t.createdAt,
        schemaVersion: t.schemaVersion,
        schemaBehind: isBehind(t, latest),
        behindBy: behindBy(t.schemaVersion, names),
        plans: [...(plansOf.get(id)?.values() ?? [])].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key)),
        standing: { kind: standing.kind, at: standingDate(standing) },
        seats: use ? { used: use.seatsUsed, limit: use.seatsLimit, day: use.day } : null,
        grant: grantOf.get(id) ?? null,
        tags: t.tags,
        domains: t._count.domains,
      },
    ];
  });
}

// ─── Loaders ─────────────────────────────────────────────────────────────────────────────────────

/** One page of the directory, as the filters, view and sort say. */
export async function workspaceDirectory(f: DirectoryFilters, now = new Date()): Promise<DirectoryPage> {
  const names = workspaceMigrationNames();
  const where = await directoryWhere(f, latestOf(names), now);
  const size = f.pageSize;

  if (!isComputed(f)) {
    const control = controlDb();
    const total = await control.tenant.count({ where });
    const page = clampPage(f.page, total, size);
    const found = total ? await control.tenant.findMany({ where, orderBy: orderBy(f.sort), skip: (page - 1) * size, take: size, select: { id: true } }) : [];
    const rows = await directoryRows(found.map((r) => r.id), names, now, { standings: null, usage: null });
    return { rows, total, page, pageSize: size, capped: false, asOf: now };
  }

  const matches = await computedMatches(f, where, latestOf(names), now);
  const total = matches.ids.length;
  const page = clampPage(f.page, total, size);
  const rows = await directoryRows(matches.ids.slice((page - 1) * size, page * size), names, now, matches);
  return { rows, total, page, pageSize: size, capped: matches.capped, asOf: now };
}

/**
 * The counts beside the views and filters. The views that depend on a standing are counted over the
 * newest 10,000 open workspaces — the same ones the directory itself works through.
 */
export async function directoryFacets(now = new Date()): Promise<DirectoryFacets> {
  const control = controlDb();
  const latest = latestOf(workspaceMigrationNames());
  const [grouped, behind, tags, countries, plans, open, failed] = await Promise.all([
    control.tenant.groupBy({ by: ["status", "suspendedFor"], _count: { _all: true } }),
    control.tenant.count({ where: behindWhere(latest) }),
    control.$queryRaw<{ tag: string; n: number }[]>`
      SELECT t.tag, count(*)::int AS n
      FROM "tenants", unnest("tags") AS t(tag)
      WHERE "status" <> 'DEPROVISIONED'
      GROUP BY t.tag ORDER BY t.tag`,
    control.tenant.groupBy({ by: ["country"], where: { status: { not: "DEPROVISIONED" } }, _count: { _all: true } }),
    control.plan.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { key: true, name: true } }),
    control.tenant.findMany({
      where: { status: { not: "DEPROVISIONED" } },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: DIRECTORY_CAP,
      select: { id: true, status: true, schemaVersion: true },
    }),
    failedSetups(),
  ]);
  const standings = await billingStandings(open.map((t) => t.id), now);

  const byStatus: Record<TenantStatusKey, number> = { PROVISIONING: 0, ACTIVE: 0, SUSPENDED: 0, MIGRATING: 0, DEPROVISIONED: 0 };
  let heldBilling = 0;
  let heldStaff = 0;
  for (const g of grouped) {
    byStatus[g.status] += g._count._all;
    if (g.status === "SUSPENDED" && g.suspendedFor === "BILLING") heldBilling += g._count._all;
    if (g.status === "SUSPENDED" && g.suspendedFor === "STAFF") heldStaff += g._count._all;
  }

  let attention = 0;
  let trials = 0;
  let pastDue = 0;
  for (const t of open) {
    const standing = standings.get(t.id) ?? NO_STANDING;
    if (needsAttention(t, standing, failed, latest)) attention += 1;
    if (standing.kind === "trial") trials += 1;
    if (standing.kind === "past-due" || standing.kind === "trial-over") pastDue += 1;
  }

  return {
    views: {
      all: byStatus.PROVISIONING + byStatus.ACTIVE + byStatus.SUSPENDED + byStatus.MIGRATING,
      attention,
      trials,
      "past-due": pastDue,
      held: byStatus.SUSPENDED,
      "setting-up": byStatus.PROVISIONING,
      behind,
      closed: byStatus.DEPROVISIONED,
    },
    byStatus,
    heldBilling,
    heldStaff,
    behind,
    tags: tags.map((t) => ({ tag: t.tag, n: Number(t.n) })),
    countries: countries.map((c) => ({ country: c.country, n: c._count._all })).sort((a, b) => b.n - a.n || a.country.localeCompare(b.country)),
    plans,
    asOf: now,
  };
}

/** The columns: dates are on the console's clock, and their headings say which zone. */
const csvFields = (clock: Clock) => [
  "Slug",
  "Name",
  "Status",
  "Held for",
  "Country",
  "Plans",
  "Standing",
  `Standing date (${clock.zone})`,
  "Seats used",
  "Seat limit",
  "Owner email",
  "Billing email",
  "Tax ID",
  `Created (${clock.zone})`,
  "Schema current",
  "Tags",
];

/**
 * The directory as the filters say, as CSV — every match, not a page; more than 5,000 is refused.
 * A cell that a spreadsheet would read as a formula is escaped (`escapeFormulae`): a workspace named
 * `=HYPERLINK(…)` comes out as text. The browser adds the byte-order mark when it saves the file.
 */
export async function workspacesCsv(f: DirectoryFilters, now = new Date()): Promise<CsvExport> {
  const names = workspaceMigrationNames();
  const latest = latestOf(names);
  const clock = await consoleClock();
  const where = await directoryWhere(f, latest, now);
  const cap = EXPORT_CAPS.workspaces;
  const tooMany = () => new ConsoleRefused(`Narrow it down — at most ${new Intl.NumberFormat("en-IN").format(cap)} rows.`);

  let matches: Matches;
  if (isComputed(f)) {
    matches = await computedMatches(f, where, latest, now);
    if (matches.capped) throw tooMany();
  } else {
    const found = await controlDb().tenant.findMany({ where, orderBy: orderBy(f.sort), take: cap + 1, select: { id: true } });
    matches = { ids: found.map((r) => r.id), capped: false, standings: null, usage: null };
  }
  if (matches.ids.length > cap) throw tooMany();

  const [rows, taxIds] = await Promise.all([
    directoryRows(matches.ids, names, now, matches),
    matches.ids.length ? controlDb().tenant.findMany({ where: { id: { in: matches.ids } }, select: { id: true, taxId: true } }) : [],
  ]);
  const taxIdOf = new Map(taxIds.map((t) => [t.id, t.taxId]));
  const data = rows.map((r) => [
    r.slug,
    r.name,
    TENANT_STATUS[r.status].label,
    r.suspendedFor === "BILLING" ? "Billing" : r.suspendedFor === "STAFF" ? "Staff" : "",
    r.country,
    r.plans.map((p) => (p.quantity > 1 ? `${p.name} ×${p.quantity}` : p.name)).join("; "),
    STANDING_KIND_LABEL[r.standing.kind],
    r.standing.at ? clock.dateKey(r.standing.at) : "",
    r.seats ? r.seats.used : "",
    r.seats?.limit ?? "",
    r.ownerEmail ?? "",
    r.billingEmail ?? "",
    taxIdOf.get(r.id) ?? "",
    clock.input(r.createdAt).replace("T", " "),
    latest && r.schemaVersion === latest ? "yes" : "no",
    r.tags.join("; "),
  ]);
  const csv = Papa.unparse({ fields: csvFields(clock), data }, { escapeFormulae: true });
  return { filename: csvFilename("workspaces", now, clock), csv, rows: rows.length };
}

type ClosedRow = { id: string; slug: string; name: string; deprovisionedAt: Date; keysKept: boolean };

/**
 * Closed workspaces, most recently closed first (200 at most): when, by whom, the final backup, and
 * where they stand with the 90 days their keys are kept. Purging stays a server command.
 */
export async function closedWorkspaces(now = new Date()): Promise<ClosedWorkspace[]> {
  const control = controlDb();
  // The key bundle is compared in Postgres — only whether it is still there comes back. A workspace
  // closed before the date was recorded falls back to when its row last changed.
  const rows = await control.$queryRaw<ClosedRow[]>`
    SELECT "id", "slug", "name", COALESCE("deprovisionedAt", "updatedAt") AS "deprovisionedAt", ("keyBundleCipher" <> '') AS "keysKept"
    FROM "tenants"
    WHERE "status" = 'DEPROVISIONED'
    ORDER BY COALESCE("deprovisionedAt", "updatedAt") DESC
    LIMIT 200`;
  if (!rows.length) return [];

  const audit = await control.platformAuditLog.findMany({
    where: { tenantId: { in: rows.map((r) => r.id) }, action: { in: ["tenant.deprovision", "tenant.purge"] } },
    orderBy: { at: "desc" },
    select: { tenantId: true, action: true, actor: true, actorKind: true, at: true, detail: true },
  });
  const staffNames = await staffNameMap([...new Set(audit.filter((a) => a.actorKind === "STAFF").map((a) => a.actor))]);
  // Newest first: the first entry of each kind is the one that counts.
  const closedEntry = new Map<string, (typeof audit)[number]>();
  const purgedAt = new Map<string, Date>();
  for (const a of audit) {
    if (!a.tenantId) continue;
    if (a.action === "tenant.deprovision" && !closedEntry.has(a.tenantId)) closedEntry.set(a.tenantId, a);
    if (a.action === "tenant.purge" && !purgedAt.has(a.tenantId)) purgedAt.set(a.tenantId, a.at);
  }

  return rows.map((r) => {
    const deprovisionedAt = r.deprovisionedAt instanceof Date ? r.deprovisionedAt : new Date(r.deprovisionedAt);
    const purgeDueAt = new Date(deprovisionedAt.getTime() + RETENTION_DAYS * DAY);
    const entry = closedEntry.get(r.id);
    const detail = entry?.detail && typeof entry.detail === "object" && !Array.isArray(entry.detail) ? (entry.detail as Record<string, unknown>) : {};
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      deprovisionedAt,
      purgeDueAt,
      daysLeft: daysBetween(now, purgeDueAt),
      keysKept: r.keysKept === true,
      backup: typeof detail.backup === "string" && detail.backup ? detail.backup : null,
      closedBy: entry ? actorLabel(entry.actorKind, entry.actor, staffNames) : null,
      purgedAt: purgedAt.get(r.id) ?? null,
    };
  });
}
