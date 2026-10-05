import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { Prisma } from "@deskzo/control-client";
import { parseEntitlements } from "@/lib/entitlements";
import { platformBrandName } from "@/lib/platform/brand";
import { controlDb } from "@/lib/platform/control-db";
import {
  CHECK_EVERY_MS,
  DNS_LOOKUP_TIMEOUT_MS,
  DomainRefused,
  PENDING_EXPIRY_MS,
  allowanceLeft,
  allowanceRefusal,
  allowanceText,
  cnameMatches,
  dnsSkipped,
  domainMail,
  domainRecords,
  domainStatusText,
  hostRules,
  hostnameOf,
  isApex,
  judgeRecords,
  mailKind,
  nextDomainState,
  normaliseHost,
  problemsText,
  routingTarget,
  stopsAt,
  type CheckOutcome,
  type DomainRecord,
  type DomainStatusKey,
  type DomainTone,
  type Lookup,
  type Lookups,
  type RecordCheck,
} from "@/lib/platform/domain-rules";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { legacyHosts, protocolFor } from "@/lib/tenancy/host";
import { forgetRegistry, subdomainHost } from "@/lib/tenancy/registry";
import { clockOfTenant } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";

/**
 * Custom domains: a workspace reached at an address of its own (erp.acme.com) as well as its
 * subdomain. Control plane only; the rules — what an address may be, what the records must say, how
 * a check moves an address on, the words — are src/lib/platform/domain-rules.ts.
 *
 *   add      the owner (or staff) adds an address: checked against the plan's allowance and against
 *            every other workspace, and kept PENDING with a random token for its TXT record. Several
 *            workspaces may wait on the same address.
 *   check    DNS is asked (`checkRecords`). A PENDING address whose records check out becomes ACTIVE —
 *            served from then on — and every other workspace's PENDING row for it is deleted in the
 *            same transaction; a unique-index race is "taken". An ACTIVE one that fails is marked
 *            failing, and after 72 hours of failing is BROKEN: not served, links fall back to the
 *            subdomain. A BROKEN one that passes is ACTIVE again. Every check records when it ran and
 *            what it found wrong. A check never mails.
 *   primary  links in emails and documents use the primary address while it is ACTIVE.
 *   sweep    once a day (the platform tick): every live or stopped address is checked again, PENDING
 *            ones older than 14 days are removed, and the owner is mailed once when an address starts
 *            failing and once when it stops.
 *
 * Serving reads only ACTIVE addresses (src/lib/tenancy/registry.ts), so every change that affects
 * serving forgets the registry's remembered lookups. Whether workspaces may add addresses at all is
 * the platform switch `domains.offered` (src/lib/platform/settings.ts) — the workspace's own actions
 * check it; staff add and check from the console whatever it says.
 *
 * DNS goes through an injectable resolver: the system's, against public resolvers with a five-second
 * limit per question; check suites inject their own (`setTestDomainResolver`), so no check asks DNS.
 */

export { DomainRefused, normaliseHost };

const GONE = "That address no longer exists.";
const WORKSPACE_GONE = "That workspace no longer exists.";
const TAKEN = "That address is already used by another workspace.";
const ON_THIS = "That address is already on this workspace.";

// ─── DNS ─────────────────────────────────────────────────────────────────────────────────────────

/** The four questions a check asks. `node:dns/promises`' Resolver is one. */
export type DomainResolver = {
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname(name: string): Promise<string[]>;
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
};

let testResolver: DomainResolver | null = null;

/** Set only by check scripts: every lookup goes to it instead of DNS. */
export function setTestDomainResolver(resolver: DomainResolver | null) {
  testResolver = resolver;
}

/**
 * Public resolvers rather than the machine's own — a laptop's stub or a container's nothing would
 * read as "no records" (see src/lib/dns.ts, which Domain Intel shares). DNS_RESOLVERS overrides them.
 */
function systemResolver(): DomainResolver {
  const resolver = new Resolver({ timeout: DNS_LOOKUP_TIMEOUT_MS, tries: 2 });
  resolver.setServers(
    (process.env.DNS_RESOLVERS ?? "1.1.1.1,8.8.8.8")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return resolver;
}

const activeResolver = (): DomainResolver => testResolver ?? systemResolver();

/** No data and no such name are answers ("nothing there"); anything else — a timeout, a failing server — is no answer. */
async function lookup(ask: () => Promise<string[]>): Promise<Lookup> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const found = await Promise.race([
      ask(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("timed out"), { code: "ETIMEOUT" })), DNS_LOOKUP_TIMEOUT_MS * 2 + 1_000);
      }),
    ]);
    return found.length ? { found } : { missing: true };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "ENODATA" || code === "ENOTFOUND" || code === "NXDOMAIN") return { missing: true };
    return { failed: code === "ETIMEOUT" ? "timed out" : typeof code === "string" ? code : "no answer" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Whether `host` proves itself with `token` and points at `target`, with every problem in words —
 * "No TXT record found at _domain-verify.erp.acme.com", "erp.acme.com points to x.y, not acme.<domain>".
 * In development an address under .localhost or .test is not looked up (`skipped`); never in production.
 */
export async function checkRecords(host: string, token: string | null, target: string, resolver: DomainResolver = activeResolver()): Promise<RecordCheck & { skipped: boolean }> {
  const hostname = hostnameOf(host);
  if (dnsSkipped(hostname, hostRules().production)) return { txtOk: true, routeOk: true, problems: [], skipped: true };
  const [txt, cname] = await Promise.all([
    token ? lookup(async () => (await resolver.resolveTxt(`_domain-verify.${hostname}`)).map((chunks) => chunks.join(""))) : Promise.resolve(undefined),
    lookup(() => resolver.resolveCname(hostname)),
  ]);
  const lookups: Lookups = { txt, cname };
  // A bare domain cannot have a CNAME: its addresses are compared with the target's instead.
  if (!cnameMatches(cname, target)) {
    const [a, aaaa, targetA, targetAaaa] = await Promise.all([
      lookup(() => resolver.resolve4(hostname)),
      lookup(() => resolver.resolve6(hostname)),
      lookup(() => resolver.resolve4(target)),
      lookup(() => resolver.resolve6(target)),
    ]);
    Object.assign(lookups, { a, aaaa, targetA, targetAaaa });
  }
  return { ...judgeRecords(hostname, token, target, lookups), skipped: false };
}

// ─── Rows ────────────────────────────────────────────────────────────────────────────────────────

const DOMAIN_SELECT = {
  id: true,
  tenantId: true,
  host: true,
  kind: true,
  status: true,
  isPrimary: true,
  verifyToken: true,
  verifiedAt: true,
  lastCheckedAt: true,
  lastCheckError: true,
  failingSince: true,
  addedBy: true,
  createdAt: true,
} as const satisfies Prisma.TenantDomainSelect;
export type DomainRow = Prisma.TenantDomainGetPayload<{ select: typeof DOMAIN_SELECT }>;

const isUniqueViolation = (err: unknown) =>
  (err instanceof Prisma.PrismaClientKnownRequestError || (err instanceof Error && err.name === "PrismaClientKnownRequestError")) && (err as { code?: unknown }).code === "P2002";

/**
 * A platform audit entry. `actor`: "staff:<id>" for staff, "script:<name>" for a script; anything else
 * is the platform itself under that name ("domain-sweep", "workspace:<user id>").
 */
async function audit(actor: string, action: string, detail: Record<string, unknown>, tenantId: string, tx: Prisma.TransactionClient = controlDb()) {
  const kind = actor.startsWith("staff:") ? "STAFF" : actor.startsWith("script:") ? "SCRIPT" : "SYSTEM";
  await tx.platformAuditLog.create({
    data: { actorKind: kind, actor: kind === "SYSTEM" ? actor : actor.replace(/^(staff|script):/, ""), action, tenantId, detail: detail as Prisma.InputJsonValue },
    select: { id: true },
  });
}

/** One address, in its workspace when `tenantId` says which — anything else "no longer exists". */
async function domainRow(id: string, tenantId?: string): Promise<DomainRow & { tenant: { slug: string; name: string; ownerEmail: string | null; status: string } }> {
  const row = typeof id === "string" && id ? await controlDb().tenantDomain.findUnique({ where: { id }, select: { ...DOMAIN_SELECT, tenant: { select: { slug: true, name: true, ownerEmail: true, status: true } } } }) : null;
  if (!row || (tenantId !== undefined && row.tenantId !== tenantId)) throw new DomainRefused(GONE);
  return row;
}

// ─── Adding ──────────────────────────────────────────────────────────────────────────────────────

/** How many custom domains a workspace may have, and has: every CUSTOM one counts, waiting, live or stopped. */
export async function domainAllowance(tenantId: string): Promise<{ limit: number | null; used: number }> {
  const control = controlDb();
  const [tenant, used] = await Promise.all([
    control.tenant.findUnique({ where: { id: tenantId }, select: { entitlements: true } }),
    control.tenantDomain.count({ where: { tenantId, kind: "CUSTOM" } }),
  ]);
  if (!tenant) throw new DomainRefused(WORKSPACE_GONE);
  return { limit: parseEntitlements(tenant.entitlements).customDomains, used };
}

/**
 * An address added to a workspace, waiting for its records: within its allowance, not on it already,
 * and not live (or stopped) on another workspace — though others may be waiting on it too. The token
 * is 192 random bits. `addedBy`: the person's email, or "staff:<email>".
 */
export async function addDomain(tenantId: string, input: unknown, addedBy: string): Promise<DomainRow> {
  const typed = normaliseHost(input);
  if (!typed.ok) throw new DomainRefused(typed.error);
  const { host } = typed;
  // An address from before workspaces, still reaching the first one from the environment.
  if (legacyHosts().includes(host)) throw new DomainRefused(TAKEN);
  const token = randomBytes(24).toString("base64url");
  try {
    return await controlDb().$transaction(async (tx) => {
      // Held until the end, so two adds at once still stop at the allowance.
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "tenants" WHERE "id" = ${tenantId} FOR UPDATE`;
      if (!locked.length) throw new DomainRefused(WORKSPACE_GONE);
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { status: true, entitlements: true } });
      if (tenant.status === "DEPROVISIONED") throw new DomainRefused("This workspace is closed.");
      const same = await tx.tenantDomain.findMany({ where: { host }, select: { tenantId: true, status: true } });
      if (same.some((d) => d.tenantId === tenantId)) throw new DomainRefused(ON_THIS);
      const used = await tx.tenantDomain.count({ where: { tenantId, kind: "CUSTOM" } });
      const refused = allowanceRefusal(parseEntitlements(tenant.entitlements).customDomains, used);
      if (refused) throw new DomainRefused(refused);
      if (same.some((d) => d.status !== "PENDING")) throw new DomainRefused(TAKEN);
      return tx.tenantDomain.create({
        data: { tenantId, host, kind: "CUSTOM", status: "PENDING", verifyToken: token, addedBy: String(addedBy ?? "").slice(0, 300) || null },
        select: DOMAIN_SELECT,
      });
    });
  } catch (err) {
    // Only (workspace, address) can clash for a waiting row: the same address added twice at once.
    if (isUniqueViolation(err)) throw new DomainRefused(ON_THIS);
    throw err;
  }
}

// ─── Checking ────────────────────────────────────────────────────────────────────────────────────

export type DomainCheck = {
  domain: DomainRow | null;
  /** "taken": another workspace proved the address first — this one's waiting row is gone. */
  outcome: CheckOutcome | "taken";
  passed: boolean;
  problems: string[];
  /** DNS was not asked: a development address (.localhost, .test). */
  skipped: boolean;
};

/**
 * Asks DNS about one address and moves it on (see the top of this file). `throttle`: at most once
 * every 30 seconds — what the people pressing "Check now" get; the sweep is not throttled. `actor`
 * names who asked, for the audit entries of a change in what is served. Never mails.
 */
export async function checkDomain(
  id: string,
  opts: { tenantId?: string; now?: Date; actor?: string; throttle?: boolean; resolver?: DomainResolver } = {},
): Promise<DomainCheck> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? "domain-check";
  const control = controlDb();
  const row = await domainRow(id, opts.tenantId);
  if (row.kind !== "CUSTOM") throw new DomainRefused("An address kept from before workspaces needs no records, so it isn't checked.");
  if (opts.throttle) {
    // Claimed in one statement, so two presses at once check once.
    const claimed = await control.tenantDomain.updateMany({
      where: { id: row.id, OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lte: new Date(now.getTime() - CHECK_EVERY_MS) } }] },
      data: { lastCheckedAt: now },
    });
    if (claimed.count === 0) {
      const last = (await control.tenantDomain.findUnique({ where: { id: row.id }, select: { lastCheckedAt: true } }))?.lastCheckedAt ?? now;
      const wait = Math.max(1, Math.ceil((last.getTime() + CHECK_EVERY_MS - now.getTime()) / 1000));
      throw new DomainRefused(`It was checked a moment ago — try again in ${wait} second${wait === 1 ? "" : "s"}.`);
    }
  }

  const records = await checkRecords(row.host, row.verifyToken, routingTarget(row.tenant.slug), opts.resolver ?? activeResolver());
  const passed = records.txtOk && records.routeOk;
  const next = nextDomainState({ status: row.status, failingSince: row.failingSince }, passed, now);
  const checked = { lastCheckedAt: now, lastCheckError: passed ? null : problemsText(records.problems) };
  const result = (domain: DomainRow | null, outcome: DomainCheck["outcome"]): DomainCheck => ({ domain, outcome, passed, problems: records.problems, skipped: records.skipped });
  const fresh = () => control.tenantDomain.findUnique({ where: { id: row.id }, select: DOMAIN_SELECT });
  /** Where a row changed meanwhile by somebody else stands now, without this check's verdict. */
  const standing = (d: DomainRow | null): DomainCheck => result(d, !d ? "taken" : d.status === "PENDING" ? "waiting" : d.status === "BROKEN" ? "still-stopped" : d.failingSince ? "failing" : "live");

  if (row.status === "PENDING" && passed) {
    // Whoever proves it first gets it: every other workspace waiting on it loses its row, at once.
    let verified: boolean;
    try {
      verified = await control.$transaction(async (tx) => {
        const others = await tx.tenantDomain.deleteMany({ where: { host: row.host, status: "PENDING", NOT: { tenantId: row.tenantId } } });
        const moved = await tx.tenantDomain.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "ACTIVE", verifiedAt: now, failingSince: null, ...checked } });
        if (moved.count === 0) return false;
        await audit(actor, "tenant.domain.verified", { host: row.host, othersRemoved: others.count }, row.tenantId, tx);
        return true;
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Another workspace's became live in the same moment: it is theirs, and this waiting row goes.
      await control.tenantDomain.deleteMany({ where: { id: row.id, status: "PENDING" } });
      forgetRegistry();
      return result(null, "taken");
    }
    forgetRegistry();
    return verified ? result(await fresh(), "verified") : standing(await fresh());
  }

  // Only from the state it was read in: a change meanwhile (removed, verified elsewhere) wins.
  const moved = await control.tenantDomain.updateMany({ where: { id: row.id, status: row.status }, data: { status: next.status, failingSince: next.failingSince, ...checked } });
  if (moved.count === 0) return standing(await fresh());
  if (next.outcome === "stopped" || (next.outcome === "recovered" && row.status === "BROKEN")) {
    await audit(actor, next.outcome === "stopped" ? "tenant.domain.broken" : "tenant.domain.recovered", { host: row.host, failingSince: row.failingSince?.toISOString() ?? null }, row.tenantId);
    forgetRegistry();
  }
  return result(await fresh(), next.outcome);
}

// ─── Primary, removing ───────────────────────────────────────────────────────────────────────────

/**
 * Links in emails and documents are built on this address from now on. Only a live one; the others
 * stop being primary in the same transaction (one primary per workspace is a unique index too).
 */
export async function makePrimary(id: string, tenantId?: string): Promise<DomainRow> {
  const row = await domainRow(id, tenantId);
  if (row.status !== "ACTIVE") throw new DomainRefused("Only a live address can be the primary one — check its records first.");
  const saved = await controlDb().$transaction(async (tx) => {
    await tx.tenantDomain.updateMany({ where: { tenantId: row.tenantId, isPrimary: true, NOT: { id: row.id } }, data: { isPrimary: false } });
    const moved = await tx.tenantDomain.updateMany({ where: { id: row.id, status: "ACTIVE" }, data: { isPrimary: true } });
    if (moved.count === 0) throw new DomainRefused("Only a live address can be the primary one — check its records first.");
    return tx.tenantDomain.findUniqueOrThrow({ where: { id: row.id }, select: DOMAIN_SELECT });
  });
  forgetRegistry();
  return saved;
}

/** Links go back to the workspace's own subdomain. Returns the address that was primary, if any. */
export async function clearPrimary(tenantId: string): Promise<string | null> {
  const control = controlDb();
  const was = await control.tenantDomain.findFirst({ where: { tenantId, isPrimary: true }, select: { host: true } });
  await control.tenantDomain.updateMany({ where: { tenantId, isPrimary: true }, data: { isPrimary: false } });
  forgetRegistry();
  return was?.host ?? null;
}

/**
 * Gone at once: it stops reaching the workspace, and a removed primary leaves links on the subdomain.
 * `customOnly`: an address kept from before workspaces is staff's to remove, not the owner's.
 */
export async function removeDomain(
  id: string,
  tenantId?: string,
  opts: { customOnly?: boolean } = {},
): Promise<{ id: string; tenantId: string; host: string; kind: "CUSTOM" | "LEGACY"; status: DomainStatusKey; isPrimary: boolean }> {
  const row = await domainRow(id, tenantId);
  if (opts.customOnly && row.kind !== "CUSTOM") throw new DomainRefused("That address is kept from before workspaces — the platform's staff remove it.");
  const removed = await controlDb().tenantDomain.deleteMany({ where: { id: row.id } });
  if (removed.count === 0) throw new DomainRefused(GONE);
  forgetRegistry();
  return { id: row.id, tenantId: row.tenantId, host: row.host, kind: row.kind, status: row.status, isPrimary: row.isPrimary };
}

// ─── The daily sweep ─────────────────────────────────────────────────────────────────────────────

export type DomainSweep = {
  /** Live or stopped addresses checked again. */
  checked: number;
  /** Of those: now failing (within the grace), newly stopped, working again. */
  failing: number;
  stopped: number;
  recovered: number;
  /** Waiting addresses removed after 14 days unproved. */
  expired: number;
  /** Owners told. */
  mailed: number;
  /** What went wrong, a line each — one address failing to check never stops the rest. */
  failed: string[];
};

const SWEEP_ACTOR = "domain-sweep";

/**
 * Once a day: every live or stopped address of an open workspace checked again; waiting ones older
 * than 14 days removed; and each owner told once when an address starts failing and once when it
 * stops (`tenant.domain.mail` entries say who was told about which episode, so a second run mails
 * nobody). `only` limits it to some workspaces — for a check suite running beside real ones.
 */
export async function domainSweep(now = new Date(), opts: { only?: string[]; resolver?: DomainResolver } = {}): Promise<DomainSweep> {
  const control = controlDb();
  const scope = opts.only ? { tenantId: { in: opts.only } } : {};
  const summary: DomainSweep = { checked: 0, failing: 0, stopped: 0, recovered: 0, expired: 0, mailed: 0, failed: [] };

  const stale = await control.tenantDomain.findMany({
    where: { ...scope, kind: "CUSTOM", status: "PENDING", createdAt: { lt: new Date(now.getTime() - PENDING_EXPIRY_MS) } },
    select: { id: true, tenantId: true, host: true, createdAt: true },
  });
  for (const d of stale) {
    const gone = await control.tenantDomain.deleteMany({ where: { id: d.id, status: "PENDING" } });
    if (gone.count === 0) continue;
    summary.expired += 1;
    await audit(SWEEP_ACTOR, "tenant.domain.expired", { host: d.host, addedAt: d.createdAt.toISOString() }, d.tenantId);
  }

  const rows = await control.tenantDomain.findMany({
    where: { ...scope, kind: "CUSTOM", status: { in: ["ACTIVE", "BROKEN"] }, tenant: { status: "ACTIVE" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, host: true },
  });
  const brand = rows.length ? await platformBrandName() : "";
  for (const d of rows) {
    try {
      const check = await checkDomain(d.id, { now, actor: SWEEP_ACTOR, resolver: opts.resolver });
      summary.checked += 1;
      if (check.outcome === "failing-started" || check.outcome === "failing") summary.failing += 1;
      else if (check.outcome === "stopped") summary.stopped += 1;
      else if (check.outcome === "recovered") summary.recovered += 1;
      if (check.domain && (await mailOwner(check.domain, check.problems, brand))) summary.mailed += 1;
    } catch (err) {
      summary.failed.push(`${d.host}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`.slice(0, 300));
    }
  }
  return summary;
}

/** Tells the owner about an address that is failing or has stopped — once for each episode. True when mailed. */
async function mailOwner(domain: DomainRow, problems: string[], brand: string): Promise<boolean> {
  const kind = mailKind(domain);
  if (!kind || !domain.failingSince) return false;
  const control = controlDb();
  const key = `${kind}:${domain.host}:${domain.failingSince.toISOString()}`;
  const told = await control.platformAuditLog.findFirst({ where: { tenantId: domain.tenantId, action: "tenant.domain.mail", detail: { path: ["key"], equals: key } }, select: { id: true } });
  if (told) return false;
  const tenant = await control.tenant.findUnique({ where: { id: domain.tenantId }, select: { slug: true, name: true, ownerEmail: true, timezone: true } });
  if (!tenant) return false;
  const to = tenant.ownerEmail?.trim() || null;
  if (to) {
    const own = subdomainHost(tenant.slug);
    // Its days on the workspace's own clock — the owner reads them there.
    const mail = domainMail(
      kind,
      {
        host: domain.host,
        workspace: tenant.name,
        ownAddress: own,
        failingSince: domain.failingSince,
        problems,
        settingsUrl: `${protocolFor(own)}://${own}/settings/domain`,
        brand,
      },
      clockOfTenant(tenant),
    );
    await sendPlatformMail({ type: "ALERTS", to, subject: mail.subject, text: mail.text });
  }
  // Written even without an owner's address, so the next day does not try again.
  await audit(SWEEP_ACTOR, "tenant.domain.mail", { key, host: domain.host, kind, failingSince: domain.failingSince.toISOString(), mailed: !!to }, domain.tenantId);
  return !!to;
}

// ─── Views ───────────────────────────────────────────────────────────────────────────────────────

export type DomainView = {
  id: string;
  host: string;
  kind: "CUSTOM" | "LEGACY";
  status: DomainStatusKey;
  isPrimary: boolean;
  /** "Live — records failing since 3 Oct, stops on 6 Oct". */
  statusText: string;
  tone: DomainTone;
  /** The records to create (none for a LEGACY address). */
  records: DomainRecord[];
  apex: boolean;
  url: string;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  /** What the last check found wrong, a problem a line. */
  problems: string[];
  failingSince: Date | null;
  stopsAt: Date | null;
  addedBy: string | null;
  createdAt: Date;
};

export type WorkspaceDomains = {
  /** The subdomain, always served. */
  ownHost: string;
  ownUrl: string;
  /** What links use now: a live primary, or the subdomain. */
  primaryHost: string;
  target: string;
  limit: number | null;
  used: number;
  canAdd: boolean;
  allowanceText: string;
  domains: DomainView[];
};

/** `clock`: the workspace's own — the status text names days as its Settings › Domain page reads them. */
export function domainView(row: DomainRow, slug: string, clock: Clock): DomainView {
  const state = { status: row.status, failingSince: row.failingSince };
  const words = domainStatusText(state, clock);
  return {
    id: row.id,
    host: row.host,
    kind: row.kind,
    status: row.status,
    isPrimary: row.isPrimary,
    statusText: row.kind === "LEGACY" ? "Live — kept from before workspaces" : words.label,
    tone: row.kind === "LEGACY" ? "live" : words.tone,
    records: row.kind === "CUSTOM" ? domainRecords(row.host, row.verifyToken, routingTarget(slug)) : [],
    apex: row.kind === "CUSTOM" && isApex(row.host),
    url: `${protocolFor(row.host)}://${row.host}`,
    verifiedAt: row.verifiedAt,
    lastCheckedAt: row.lastCheckedAt,
    problems: row.lastCheckError ? row.lastCheckError.split("\n").filter(Boolean) : [],
    failingSince: row.failingSince,
    stopsAt: row.status === "ACTIVE" && row.failingSince ? stopsAt(row.failingSince) : null,
    addedBy: row.addedBy,
    createdAt: row.createdAt,
  };
}

/**
 * A workspace's addresses as its Settings › Domain page and the console show them, oldest first. The
 * status text is on the workspace's clock; the console words it again on its own.
 */
export async function workspaceDomains(tenantId: string): Promise<WorkspaceDomains> {
  const control = controlDb();
  const [tenant, rows] = await Promise.all([
    control.tenant.findUnique({ where: { id: tenantId }, select: { slug: true, entitlements: true, timezone: true } }),
    control.tenantDomain.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" }, select: DOMAIN_SELECT }),
  ]);
  if (!tenant) throw new DomainRefused(WORKSPACE_GONE);
  const ownHost = subdomainHost(tenant.slug);
  const limit = parseEntitlements(tenant.entitlements).customDomains;
  const used = rows.filter((r) => r.kind === "CUSTOM").length;
  return {
    ownHost,
    ownUrl: `${protocolFor(ownHost)}://${ownHost}`,
    primaryHost: rows.find((r) => r.isPrimary && r.status === "ACTIVE")?.host ?? ownHost,
    target: routingTarget(tenant.slug),
    limit,
    used,
    canAdd: allowanceLeft(limit, used),
    allowanceText: allowanceText(limit, used),
    domains: rows.map((r) => domainView(r, tenant.slug, clockOfTenant(tenant))),
  };
}
