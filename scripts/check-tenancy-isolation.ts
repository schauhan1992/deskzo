/**
 * check:tenancy-isolation — two workspaces served by one process never see each other.
 *
 * Builds two scratch databases beside the real one (migrated once, the second copied from the
 * first), registers them as workspaces the way the static registry reads them (TENANT_DB_<SLUG>),
 * and then works both at once through the real `db`:
 *
 *   · which host reaches which workspace, and which reach none;
 *   · every query, raw query and transaction lands in the workspace it was run for — also with a
 *     hundred-odd of them interleaved in parallel, across timers and nested runAsTenant calls;
 *   · what the process remembers between requests (security settings, maintenance, the company
 *     lock, IP rules) is remembered per workspace;
 *   · with no workspace named, resolution fails closed inside the server;
 *   · the pool of clients stays bounded, and a client evicted mid-use finishes its work;
 *   · roughly what one more workspace's client costs in memory — which sizes TENANCY_MAX_CLIENTS.
 *
 * Maintenance and the company lock are switched on only in the scratch databases, never the real
 * one. Both scratch databases are dropped at the end, pass or fail.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

// Read when src/lib/tenancy/clients.ts loads, so set before anything under src is required.
const MAX_CLIENTS = 6;
process.env.TENANCY_MAX_CLIENTS = String(MAX_CLIENTS);
process.env.WROFFY_TENANCY_FALLBACK = "legacy";
delete process.env.TRUST_PROXY;

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (title: string) => console.log(`\n${title}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rejects = async (p: Promise<unknown>, kind: new (...args: never[]) => Error) => {
  try {
    await p;
    return false;
  } catch (err) {
    return err instanceof kind;
  }
};

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const TAG = "ZZISO";
/** Extra workspaces pointing at scratch A — each is still a client of its own, which is the point. */
const EXTRA = ["R1", "R2", "R3", "R4", "R5", "R6", "R7"];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);

  section("Two scratch workspaces");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so scratch databases may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const nameA = `${realName}_tenancy_a`;
  const nameB = `${realName}_tenancy_b`;
  const urlA = withDatabase(url, nameA);
  const urlB = withDatabase(url, nameB);
  ok("  and neither is the real one", ![nameA, nameB].includes(realName));

  const admin = new PrismaClient({ datasourceUrl: withDatabase(url, "postgres") });
  let closeAll: (() => Promise<void>) | null = null;
  try {
    for (const name of [nameA, nameB]) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${nameA}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: urlA }, timeout: 10 * 60 * 1000 });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${nameB}" TEMPLATE "${nameA}"`);
    ok("both built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);

    process.env.TENANT_DB_ZZISO_A = urlA;
    process.env.TENANT_DB_ZZISO_B = urlB;
    for (const r of EXTRA) process.env[`TENANT_DB_ZZISO_${r}`] = urlA;

    // Only now: everything under src reads the environment set above.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db, getTenantDb } = require("../src/lib/db") as typeof import("../src/lib/db");
    closeAll = () => db.$disconnect();
    const resolve = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const { runAsTenant, currentTenant, tenantOrigin, TenantNotResolved } = resolve;
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const hostRules = require("../src/lib/tenancy/host") as typeof import("../src/lib/tenancy/host");
    const { tenancyState } = require("../src/lib/tenancy/state") as typeof import("../src/lib/tenancy/state");
    const { tenantKey } = require("../src/lib/tenancy/cache") as typeof import("../src/lib/tenancy/cache");
    const security = require("../src/lib/security-settings") as typeof import("../src/lib/security-settings");
    const maintenance = require("../src/lib/maintenance") as typeof import("../src/lib/maintenance");
    const lock = require("../src/lib/access/lock") as typeof import("../src/lib/access/lock");
    const gate = require("../src/lib/access/gate") as typeof import("../src/lib/access/gate");

    const A = registry.tenantBySlug("zziso-a");
    const B = registry.tenantBySlug("zziso-b");
    const legacy = registry.legacyTenant();
    ok("the registry knows both, and the first workspace", !!A && !!B && !!legacy, [A?.slug, B?.slug, legacy?.slug].join(", "));
    if (!A || !B || !legacy) throw new Error("registry");
    const dbName = async () => (await db.$queryRaw<{ name: string }[]>`select current_database() as name`)[0].name;

    section("Which host reaches which workspace");
    const port = process.env.PLATFORM_PORT ? `:${process.env.PLATFORM_PORT}` : "";
    const domain = hostRules.PLATFORM_DOMAIN;
    ok("its subdomain reaches each", registry.tenantForHost(`zziso-a.${domain}${port}`)?.id === A.id && registry.tenantForHost(`zziso-b.${domain}${port}`)?.id === B.id);
    ok("  a name nobody has reaches none", registry.tenantForHost(`zziso-nobody.${domain}${port}`) === null);
    const bare = `${domain}${port}`;
    const bareIsLegacy = hostRules.legacyHosts().includes(bare);
    ok("  nor does the console or a reserved name", [`admin.${domain}${port}`, `www.${domain}${port}`, `billing.${domain}${port}`].every((h) => registry.tenantForHost(h) === null));
    ok(
      bareIsLegacy ? "  the bare domain is an old address kept for the first workspace, and reaches only that" : "  nor the bare domain, which is the public site",
      bareIsLegacy ? registry.tenantForHost(bare)?.id === legacy.id : registry.tenantForHost(bare) === null,
    );
    ok("  and the first workspace's old addresses reach nobody else", hostRules.legacyHosts().every((h) => registry.tenantForHost(h)?.id === legacy.id));
    ok("  nor a sub-subdomain", registry.tenantForHost(`x.zziso-a.${domain}${port}`) === null);
    const twoNames = new Headers({ host: `zziso-a.${domain}${port}`, "x-forwarded-host": `zziso-b.${domain}${port}` });
    ok("a request naming two workspaces is refused, not guessed", hostRules.requestHost(twoNames) === hostRules.HOST_MISMATCH);
    const sameName = new Headers({ host: `zziso-a.${domain}${port}`, "x-forwarded-host": `zziso-a.${domain}${port}` });
    ok("  one naming the same workspace twice is fine", hostRules.requestHost(sameName) === `zziso-a.${domain}${port}`);
    const forwardedOnly = new Headers({ host: `zziso-a.${domain}${port}`, "x-forwarded-host": `${domain}${port}` });
    ok("  as is one naming a workspace and the bare domain", hostRules.requestHost(forwardedOnly) === hostRules.HOST_MISMATCH);

    section("Every query goes to the workspace it was run for");
    ok("a query run as A reads A's database", (await runAsTenant(A, dbName)) === nameA);
    ok("  as B, B's", (await runAsTenant(B, dbName)) === nameB);
    ok("  and outside a workspace, in a script, the first one's", (await dbName()) === realName);

    await runAsTenant(A, () => db.department.create({ data: { name: `${TAG} only in A` } }));
    const seenIn = async (t: typeof A) => runAsTenant(t, () => db.department.count({ where: { name: `${TAG} only in A` } }));
    ok("a row written in A is in A", (await seenIn(A)) === 1);
    ok("  and not in B", (await seenIn(B)) === 0);
    ok("  nor in the first workspace", (await seenIn(legacy)) === 0);

    await runAsTenant(B, () =>
      db.$transaction(async (tx) => {
        await tx.department.create({ data: { name: `${TAG} tx in B` } });
        await tx.department.create({ data: { name: `${TAG} tx in B, second` } });
      }),
    );
    const txIn = async (t: typeof A) => runAsTenant(t, () => db.department.count({ where: { name: { startsWith: `${TAG} tx in B` } } }));
    ok("a transaction run as B writes both rows to B", (await txIn(B)) === 2);
    ok("  and nothing to A", (await txIn(A)) === 0);
    await runAsTenant(A, () => db.$executeRaw`update departments set "isSupportTeam" = true where name like ${`${TAG}%`}`);
    const flagged = async (t: typeof A) => runAsTenant(t, () => db.department.count({ where: { name: { startsWith: TAG }, isSupportTeam: true } }));
    ok("raw SQL run as A changes A only", (await flagged(A)) === 1 && (await flagged(B)) === 0, `${await flagged(A)} / ${await flagged(B)}`);

    section("Interleaved, in parallel");
    const N = 120;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const t = i % 2 === 0 ? A : B;
        return runAsTenant(t, async () => {
          await sleep(i % 7);
          const before = await dbName();
          await sleep((i * 3) % 5);
          await db.department.create({ data: { name: `${TAG} ${t.slug} #${i}` } });
          const after = await new Promise<string>((res, rej) => setTimeout(() => dbName().then(res, rej), i % 3));
          return { want: t === A ? nameA : nameB, before, after };
        });
      }),
    );
    const crossed = results.filter((r) => r.before !== r.want || r.after !== r.want);
    ok(`${N} requests at once, half each, across timers: none read the other's database`, crossed.length === 0, `${crossed.length} crossed`);
    const count = (t: typeof A, slug: string) => runAsTenant(t, () => db.department.count({ where: { name: { startsWith: `${TAG} ${slug} #` } } }));
    const [aOwn, aForeign, bOwn, bForeign] = await Promise.all([count(A, "zziso-a"), count(A, "zziso-b"), count(B, "zziso-b"), count(B, "zziso-a")]);
    ok("  and each database holds exactly its own writes", aOwn === N / 2 && bOwn === N / 2 && aForeign === 0 && bForeign === 0, `A ${aOwn}+${aForeign}, B ${bOwn}+${bForeign}`);

    const nested = await runAsTenant(A, async () => {
      const inner = await runAsTenant(B, dbName);
      const outer = await dbName();
      return { inner, outer };
    });
    ok("a workspace run inside another is itself, and the outer one is itself again afterwards", nested.inner === nameB && nested.outer === nameA);

    section("What the process remembers, it remembers per workspace");
    ok("each has its own cache key", (await runAsTenant(A, tenantKey)) === A.id && (await runAsTenant(B, tenantKey)) === B.id && A.id !== B.id);

    await runAsTenant(A, () => db.securitySettings.upsert({ where: { id: "global" }, create: { id: "global", ssoEnabled: true }, update: { ssoEnabled: true } }));
    security.invalidateSecuritySettingsCache();
    const ssoA = (await runAsTenant(A, security.getCachedSecuritySettings))?.ssoEnabled === true;
    const ssoB = (await runAsTenant(B, security.getCachedSecuritySettings))?.ssoEnabled === true;
    ok("security settings: A's single sign-on, read first and cached, does not answer for B", ssoA && !ssoB, `A ${ssoA}, B ${ssoB}`);

    await runAsTenant(A, () =>
      db.maintenanceMode.upsert({ where: { id: "global" }, create: { id: "global", enabled: true, message: `${TAG} down` }, update: { enabled: true, message: `${TAG} down` } }),
    );
    maintenance.forgetMaintenanceCache();
    const downA = (await runAsTenant(A, () => maintenance.currentMaintenance())).phase;
    const downB = (await runAsTenant(B, () => maintenance.currentMaintenance())).phase;
    ok("maintenance: A down (scratch only) leaves B up", downA === "on" && downB === "off", `A ${downA}, B ${downB}`);

    await runAsTenant(A, () =>
      db.companyLock.upsert({ where: { id: "global" }, create: { id: "global", enabled: true, message: `${TAG} locked` }, update: { enabled: true } }),
    );
    lock.forgetCompanyLock();
    const lockA = (await runAsTenant(A, lock.companyLock))?.enabled === true;
    const lockB = (await runAsTenant(B, lock.companyLock))?.enabled === true;
    ok("company lock: A locked (scratch only) leaves B open", lockA && !lockB, `A ${lockA}, B ${lockB}`);

    await runAsTenant(A, () => db.ipRule.create({ data: { cidr: "10.0.0.0/8", action: "BLOCK", label: `${TAG} block` } }));
    gate.clearAccessCache();
    const rulesA = (await runAsTenant(A, gate.activeIpRules)).length;
    const rulesB = (await runAsTenant(B, gate.activeIpRules)).length;
    ok("IP rules: A's block rule is not B's", rulesA === 1 && rulesB === 0, `A ${rulesA}, B ${rulesB}`);

    ok("links are built on each workspace's own address", (await runAsTenant(A, () => tenantOrigin())) === `http://zziso-a.${domain}${port}` && (await runAsTenant(B, () => tenantOrigin())) === `http://zziso-b.${domain}${port}`);

    section("With no workspace named, inside the server, nothing is guessed");
    const g = globalThis as { __wroffyInNext?: boolean };
    g.__wroffyInNext = true;
    try {
      ok("resolution fails", await rejects(currentTenant(), TenantNotResolved));
      ok("  and so does a query", await rejects(db.department.count(), TenantNotResolved));
    } finally {
      delete g.__wroffyInNext;
    }
    process.env.WROFFY_TENANCY_FALLBACK = "";
    try {
      ok("a script that has not asked for the first workspace gets none either", await rejects(currentTenant(), TenantNotResolved));
    } finally {
      process.env.WROFFY_TENANCY_FALLBACK = "legacy";
    }

    section("A bounded pool of clients");
    const extras = EXTRA.map((r) => registry.tenantBySlug(`zziso-${r.toLowerCase()}`)!);
    const { clients } = tenancyState();
    // Measured before the pool is full, so nothing has been evicted yet.
    const room = MAX_CLIENTS - clients.size;
    const measured = extras.slice(0, Math.max(1, Math.min(room, 3)));
    const rss0 = process.memoryUsage().rss;
    for (const t of measured) await runAsTenant(t, dbName);
    const rss1 = process.memoryUsage().rss;
    const perClient = (rss1 - rss0) / measured.length / 1024 / 1024;
    ok("one more workspace's client costs a bounded amount of memory", perClient < 150, `${perClient.toFixed(1)} MB each over ${measured.length} (resident, rough)`);
    const conns = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_stat_activity where datname = ${nameA}`;
    ok("  and a handful of connections", Number(conns[0].n) <= 5 * (measured.length + 1), `${conns[0].n} open to scratch A for ${measured.length + 1} workspaces on it`);

    // A request picks up its client, then enough other workspaces are used to push it out.
    const held = await runAsTenant(extras[0], getTenantDb);
    const recent = [...extras.slice(measured.length), A, B].slice(-MAX_CLIENTS);
    for (const t of recent) await runAsTenant(t, dbName);
    ok(`never more than ${MAX_CLIENTS} clients at once`, clients.size <= MAX_CLIENTS, `${clients.size}`);
    const kept = [...clients.keys()].sort().join(",");
    const expected = recent.map((t) => t.id).sort().join(",");
    ok("  and the ones kept are the most recently used", kept === expected, kept);
    const late = await held.$queryRaw<{ name: string }[]>`select current_database() as name`;
    ok("  and a request still holding it finishes on it", late[0].name === nameA);
    const fresh = await runAsTenant(extras[0], getTenantDb);
    ok("  the next request gets a new one", fresh !== held && (await runAsTenant(extras[0], dbName)) === nameA);
  } finally {
    if (closeAll) await closeAll().catch(() => {});
    for (const name of [nameA, nameB]) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname in (${nameA}, ${nameB})`;
    ok("both scratch databases dropped", Number(left[0].n) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? "\nAll tenancy isolation checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
