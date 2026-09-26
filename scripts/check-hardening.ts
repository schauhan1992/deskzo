/**
 * check:hardening — what keeps many workspaces on one server from getting in each other's way.
 *
 *   · the address the app's queries use: a small pool per workspace, idle connections closed, and
 *     PgBouncer when TENANCY_POOLER_URL is set — as the workspace's own role; what the driver is given;
 *   · pools: a few kept, the least recently used idle one ended — never one that is busy; one retired
 *     while work runs on it ended the moment that work ends, not under it;
 *   · one client for every workspace: each query answered from its own workspace's database — the
 *     same lookup from two workspaces in the same tick too, which Prisma would otherwise merge; nothing
 *     outside a workspace; a client handed out whole bound to its workspace; transactions interleaved;
 *   · each workspace role's limits: set when it is made, picked up by its sessions, lifted for a
 *     migration and put back after;
 *   · the forwarded host: believed only behind a trusted proxy, and never when it and the Host name
 *     different places on the platform;
 *   · log lines labelled with their workspace, once, and a request's error named by it.
 *
 * Two scratch workspace databases on the local server, made and migrated as provisioning does it,
 * dropped at the end, pass or fail. The other workspaces here are never connected to.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { directClient, poolSettings } from "../src/lib/tenancy/direct-client";
import type { Tenant } from "../src/lib/tenancy/state";

process.env.WROFFY_TENANCY_FALLBACK = "legacy";
process.env.TENANCY_MAX_CLIENTS = "3";
// Emptied, not deleted: a Prisma client imported later reloads .env and would put a deleted value back.
process.env.TENANCY_POOLER_URL = "";
process.env.TENANCY_CONNECTION_LIMIT = "";
process.env.TENANCY_IDLE_CONNECTION_S = "";
process.env.TRUST_PROXY = "";

let failures = 0;
// Straight to stdout: console itself is under test below.
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  process.stdout.write(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}\n`);
  if (!pass) failures += 1;
};
const section = (title: string) => process.stdout.write(`\n${title}\n`);

async function main() {
  const { appUrl, withClient, clientFor, clientStats, closeAllClients, sharedClient } = await import("../src/lib/tenancy/clients");
  const { runAsTenant } = await import("../src/lib/tenancy/resolve");
  const { UNRESTRICTED } = await import("../src/lib/entitlements");
  const { PLATFORM_DOMAIN } = await import("../src/lib/tenancy/host");
  const provisioner = await import("../src/lib/platform/provisioner");
  const { migrateDeploy } = await import("../src/lib/platform/migrate");
  const { db } = await import("../src/lib/db");

  const tenant = (slug: string, dbUrl: string): Tenant => ({
    id: `zz-${slug}-${randomUUID().slice(0, 8)}`,
    slug,
    name: slug,
    status: "ACTIVE",
    dbUrl,
    primaryHost: `${slug}.${PLATFORM_DOMAIN}`,
    hosts: [`${slug}.${PLATFORM_DOMAIN}`],
    source: "env",
    isDefault: false,
    keyBundleCipher: null,
    country: "IN",
    entitlements: UNRESTRICTED,
    holdReason: null,
  });
  // Workspaces whose pools are made and ended but never asked anything: nothing listens there.
  const nowhere = (n: number) => tenant(`zz-idle-${n}`, `postgresql://nobody:none@127.0.0.1:1/zz_idle_${n}?schema=public`);

  // ─── The address ────────────────────────────────────────────────────────────────────────────
  section("The address the app's queries use");
  const base = "postgresql://w_0123456789ab:s3cret@127.0.0.1:5432/w_0123456789ab?schema=public";
  const direct = new URL(appUrl(base));
  ok("a small pool per workspace", direct.searchParams.get("connection_limit") === "2", direct.searchParams.get("connection_limit"));
  ok("waits at most ten seconds for a connection", direct.searchParams.get("pool_timeout") === "10");
  ok("closes a connection unused for half a minute", direct.searchParams.get("max_idle_connection_lifetime") === "30");
  ok(
    "keeps the workspace's server, role, password, database and schema",
    direct.host === "127.0.0.1:5432" && direct.username === "w_0123456789ab" && direct.password === "s3cret" && direct.pathname === "/w_0123456789ab" && direct.searchParams.get("schema") === "public" && !direct.searchParams.has("pgbouncer"),
  );
  ok("leaves a limit the address already has", new URL(appUrl(`${base}&connection_limit=9`)).searchParams.get("connection_limit") === "9");
  process.env.TENANCY_CONNECTION_LIMIT = "4";
  ok("TENANCY_CONNECTION_LIMIT sets the pool", new URL(appUrl(base)).searchParams.get("connection_limit") === "4");
  process.env.TENANCY_CONNECTION_LIMIT = "";
  process.env.TENANCY_POOLER_URL = "postgresql://pooler.internal:6432";
  const pooled = new URL(appUrl(base));
  process.env.TENANCY_POOLER_URL = "";
  ok("with TENANCY_POOLER_URL: PgBouncer's host and port", pooled.hostname === "pooler.internal" && pooled.port === "6432", pooled.host);
  ok("…as the workspace's own role, password and database — its limits still apply", pooled.username === "w_0123456789ab" && pooled.password === "s3cret" && pooled.pathname === "/w_0123456789ab");
  ok("…with no flag for it: node-postgres's unnamed statements suit transaction pooling as they are", !pooled.searchParams.has("pgbouncer"));

  section("What the database driver is given");
  const given = poolSettings(appUrl(base), { max: 7 });
  const sent = new URL(given.pool.connectionString);
  ok("the pool's size, idle close and wait, read from the address", given.pool.max === 2 && given.pool.idleTimeoutMillis === 30_000 && given.pool.connectionTimeoutMillis === 10_000, JSON.stringify({ ...given.pool, connectionString: "…" }));
  ok("the schema, for Prisma", given.schema === "public");
  ok("none of Prisma's own settings sent to the server", ["schema", "connection_limit", "pool_timeout", "max_idle_connection_lifetime", "pgbouncer"].every((k) => !sent.searchParams.has(k)), sent.search);
  ok("…but the server, role, password and database are", sent.host === "127.0.0.1:5432" && sent.username === "w_0123456789ab" && sent.password === "s3cret" && sent.pathname === "/w_0123456789ab");
  ok("SSL settings stay in the address, for the driver", new URL(poolSettings(`${base}&sslmode=require`, { max: 1 }).pool.connectionString).searchParams.get("sslmode") === "require");
  ok("an address that says nothing gets the caller's pool size", poolSettings("postgresql://u:p@127.0.0.1:5432/d", { max: 7 }).pool.max === 7);

  // ─── Clients ────────────────────────────────────────────────────────────────────────────────
  section("Pools: three kept, never one that is busy, ended as soon as the work on them ends");
  let n = 0;
  const touch = async (count: number) => {
    for (let i = 0; i < count; i++) await withClient(nowhere(n++), async () => {});
  };
  const pending = (t: Tenant) => {
    let finish!: () => void;
    let fail!: (e: Error) => void;
    const done = withClient(t, () => new Promise<void>((resolve, reject) => ((finish = resolve), (fail = reject))));
    return { done, finish, fail };
  };
  const base0 = clientStats();
  const busy = nowhere(n++);
  const one = pending(busy);
  await touch(3);
  ok("a pool with work running on it is not evicted — idle ones go first", clientStats().closing === base0.closing && clientStats().kept === 3, JSON.stringify(clientStats()));
  one.finish();
  await one.done;
  const openedBefore = clientStats().opened;
  await withClient(busy, async () => {});
  ok("…so the same request's next query finds the same pool", clientStats().opened === openedBefore, JSON.stringify(clientStats()));

  const all = [pending(nowhere(n++)), pending(nowhere(n++)), pending(nowhere(n++)), pending(nowhere(n++))];
  ok("with every kept pool busy, the process goes over the cap rather than evict one", clientStats().kept === 4 && clientStats().closing === base0.closing, JSON.stringify(clientStats()));
  for (const p of all) p.finish();
  await Promise.all(all.map((p) => p.done));
  await touch(1);
  ok("…and comes back under it once they finish", clientStats().kept <= 3, JSON.stringify(clientStats()));

  // A workspace moved to another database while a query ran on the old one.
  const moving = nowhere(n++);
  const onOld = pending(moving);
  await withClient({ ...moving, dbUrl: `${moving.dbUrl}&application_name=moved` }, async () => {});
  ok("a pool replaced while work runs on it is not ended under that work", clientStats().closing === base0.closing + 1, JSON.stringify(clientStats()));
  onOld.fail(new Error("zz"));
  const failed = await onOld.done.then(() => "", (e: Error) => e.message);
  ok("…and is ended the moment the work ends — failed or not — with the failure reaching its caller", failed === "zz" && clientStats().closing === base0.closing, JSON.stringify(clientStats()));

  await touch(3);
  ok("never more than three kept when idle", clientStats().kept <= 3, clientStats().kept);
  await closeAllClients();

  // ─── A real workspace database ──────────────────────────────────────────────────────────────
  let ws: { dbName: string; dbRole: string; url: string } | null = null;
  let wsB: { dbName: string; dbRole: string; url: string } | null = null;
  try {
    section("A workspace role's limits");
    ws = await provisioner.createWorkspaceDatabase();
    const setting = (settings: string[], name: string) => settings.find((s) => s.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
    const made = await provisioner.roleLimits(ws.dbRole);
    ok("a new workspace's role has a statement timeout", setting(made?.settings ?? [], "statement_timeout") === "30000", made?.settings.join(", "));
    ok("…a lock timeout", setting(made?.settings ?? [], "lock_timeout") === "10000");
    ok("…an idle-in-transaction timeout", setting(made?.settings ?? [], "idle_in_transaction_session_timeout") === "60000");
    ok("…and a connection cap", made?.connections === 20, made?.connections);

    let during: string[] = [];
    await provisioner.withoutRoleLimits(ws.dbRole, async () => {
      during = (await provisioner.roleLimits(ws!.dbRole))?.settings ?? [];
    });
    const after = await provisioner.roleLimits(ws.dbRole);
    ok("lifted for a migration", ["statement_timeout", "lock_timeout", "idle_in_transaction_session_timeout"].every((s) => setting(during, s) === "0"), during.join(", "));
    ok("…and put back after it", setting(after?.settings ?? [], "statement_timeout") === "30000" && after?.connections === 20, after?.settings.join(", "));
    const failedWork = await provisioner
      .withoutRoleLimits(ws.dbRole, async () => {
        throw new Error("migration failed");
      })
      .then(() => "", (e: Error) => e.message);
    const afterFailure = await provisioner.roleLimits(ws.dbRole);
    ok("…put back even when the migration fails", failedWork === "migration failed" && setting(afterFailure?.settings ?? [], "statement_timeout") === "30000");

    await migrateDeploy(ws.url);
    const migrated = await provisioner.roleLimits(ws.dbRole);
    ok("migrating the workspace leaves its limits as they were", setting(migrated?.settings ?? [], "statement_timeout") === "30000" && migrated?.connections === 20, migrated?.settings.join(", "));
    const session = directClient(ws.url);
    try {
      const show = async (name: string) => ((await session.$queryRawUnsafe<Record<string, string>[]>(`show ${name}`))[0] ?? {})[name];
      const seen = { statement: await show("statement_timeout"), lock: await show("lock_timeout"), idle: await show("idle_in_transaction_session_timeout") };
      ok("the role's sessions run under them", seen.statement === "30s" && seen.lock === "10s" && seen.idle === "1min", JSON.stringify(seen));
    } finally {
      await session.$disconnect();
    }

    section("One client for every workspace, each query answered from its own");
    wsB = await provisioner.createWorkspaceDatabase();
    await migrateDeploy(wsB.url);
    const email = "same@zzhardening.example";
    for (const [url, name] of [[ws.url, "Workspace A"], [wsB.url, "Workspace B"]] as const) {
      const seed = directClient(url);
      await seed.user.create({ data: { email, name, role: "ADMIN", passwordHash: "x" } });
      await seed.$disconnect();
    }
    const tA = tenant("zz-hard-a", ws.url);
    const tB = tenant("zz-hard-b", wsB.url);
    const lookup = (t: Tenant) => withClient(t, (c) => c.user.findUnique({ where: { email }, select: { name: true } }));
    const [a1, b1] = await Promise.all([lookup(tA), lookup(tB)]);
    ok("the same lookup from two workspaces in the same tick — each from its own database", a1?.name === "Workspace A" && b1?.name === "Workspace B", `${a1?.name} / ${b1?.name}`);
    // The test can tell: with Prisma's merging put back as it ships, the same two lookups are mixed.
    type Loader = { batchBy: (r: { transaction?: { id?: string }; protocolQuery?: { action?: string } }) => string | undefined };
    const loader = (sharedClient() as unknown as { _requestHandler: { dataloader: { options: Loader } } })._requestHandler.dataloader.options;
    const guard = loader.batchBy;
    loader.batchBy = (r) => (r.transaction?.id ? `transaction-${r.transaction.id}` : r.protocolQuery?.action === "findUnique" ? "merged" : undefined);
    const [a2, b2] = await Promise.all([lookup(tA), lookup(tB)]);
    loader.batchBy = guard;
    ok("…which Prisma's own merging would answer from one (so this test would see it)", a2?.name === b2?.name, `${a2?.name} / ${b2?.name}`);
    const [a3, b3] = await Promise.all([lookup(tA), lookup(tB)]);
    ok("…and with the guard back, apart again", a3?.name === "Workspace A" && b3?.name === "Workspace B");
    const outside = await sharedClient()
      .user.count()
      .then(() => "answered", (e: Error) => e.message);
    ok("a query outside any workspace is refused, never sent to a default", /outside any workspace/.test(outside), outside.split("\n").slice(-1)[0]);
    const viewA = clientFor(tA);
    ok("a client handed out whole answers as its workspace, wherever it is called", (await viewA.user.findUnique({ where: { email }, select: { name: true } }))?.name === "Workspace A");
    ok("…including inside another workspace's work", (await withClient(tB, async () => (await viewA.user.findUnique({ where: { email }, select: { name: true } }))?.name)) === "Workspace A");
    const dbName = (u: string) => new URL(u).pathname.slice(1);
    const landed = await Promise.all(
      Array.from({ length: 24 }, (_, i) => {
        const t = i % 2 ? tB : tA;
        return withClient(t, (c) =>
          c.$transaction(async (tx) => {
            const [row] = await tx.$queryRaw<{ db: string }[]>`select current_database()::text as db`;
            await tx.user.update({ where: { email }, data: { phone: String(i) } });
            return row?.db === dbName(t.dbUrl);
          }),
        );
      }),
    );
    ok("transactions from both, interleaved — each on its own database", landed.every(Boolean), `${landed.filter(Boolean).length}/24`);

    section("A transaction whose pool is replaced mid-way");
    const real = tenant("zz-hardening", ws.url);
    const before = clientStats();
    const counted = await runAsTenant(real, () =>
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`create table zz_hardening (n int)`);
        await tx.$executeRawUnsafe(`insert into zz_hardening values (1)`);
        // Other workspaces come and go: this one's pool is busy, so it stays.
        await touch(3);
        const kept = clientStats().closing === before.closing;
        // The workspace moves to another address: its old pool is retired, with this transaction on it.
        await withClient({ ...real, dbUrl: `${real.dbUrl}&application_name=moved` }, async () => {});
        const retired = clientStats().closing === before.closing + 1;
        await tx.$executeRawUnsafe(`insert into zz_hardening values (2)`);
        const [row] = await tx.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from zz_hardening`);
        return { kept, retired, rows: Number(row!.n) };
      }),
    );
    ok("kept while its transaction ran, other workspaces coming and going", counted.kept);
    ok("retired mid-transaction when the workspace moved", counted.retired);
    ok("…and the transaction still finished on it", counted.rows === 2, counted.rows);
    ok("the retired pool ended once the transaction did", clientStats().closing === before.closing, JSON.stringify(clientStats()));
    const [committed] = await runAsTenant({ ...real, dbUrl: `${real.dbUrl}&application_name=moved` }, () => db.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from zz_hardening`));
    ok("…with what it wrote committed, read through the new pool", Number(committed!.n) === 2, Number(committed!.n));
    await closeAllClients();
  } finally {
    await closeAllClients();
    if (ws) await provisioner.dropWorkspaceDatabase(ws.dbName, ws.dbRole).catch((e) => ok("scratch workspace dropped", false, e));
    if (wsB) await provisioner.dropWorkspaceDatabase(wsB.dbName, wsB.dbRole).catch((e) => ok("second scratch workspace dropped", false, e));
  }

  // ─── Host routing behind a proxy ────────────────────────────────────────────────────────────
  section("The forwarded host, with and without a trusted proxy");
  const { requestHost, HOST_MISMATCH } = await import("../src/lib/tenancy/host");
  const at = (host: string, forwarded?: string) => requestHost(new Headers(forwarded ? { host, "x-forwarded-host": forwarded } : { host }));
  const [acmeHost, betaHost, consoleHost] = [`zz-acme.${PLATFORM_DOMAIN}:3000`, `zz-beta.${PLATFORM_DOMAIN}:3000`, `admin.${PLATFORM_DOMAIN}:3000`];
  ok("no proxy: the Host is the address", at(acmeHost) === acmeHost);
  ok("no proxy: a forwarded host naming another workspace is refused (421)", at(acmeHost, betaHost) === HOST_MISMATCH);
  process.env.TRUST_PROXY = "1";
  const trusted = {
    upstream: at("127.0.0.1:3000", acmeHost),
    passedOn: at(acmeHost, acmeHost),
    custom: at("wroffy-app:3000", "crm.example.org"),
    spoofed: at(acmeHost, betaHost),
    spoofedConsole: at(acmeHost, consoleHost),
  };
  process.env.TRUST_PROXY = "";
  ok("behind a proxy: its upstream Host and the forwarded workspace → the workspace", trusted.upstream === acmeHost, String(trusted.upstream));
  ok("…the same host passed on in both → that host", trusted.passedOn === acmeHost);
  ok("…a custom domain forwarded → the custom domain", trusted.custom === "crm.example.org", String(trusted.custom));
  ok("…Host one workspace, forwarded another: not the proxy's header — refused (421)", trusted.spoofed === HOST_MISMATCH, String(trusted.spoofed));
  ok("…Host a workspace, forwarded the console: refused too", trusted.spoofedConsole === HOST_MISMATCH, String(trusted.spoofedConsole));

  // ─── Log lines ──────────────────────────────────────────────────────────────────────────────
  section("Log lines name their workspace");
  const lines: string[] = [];
  const realWarn = console.warn;
  const realError = console.error;
  console.warn = (...args: unknown[]) => void lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  console.error = console.warn;
  const { installLogLabels, labelForHost } = await import("../src/lib/tenancy/log-labels");
  installLogLabels();
  installLogLabels();
  const acme = nowhere(900);
  acme.slug = "zz-acme";
  runAsTenant(acme, () => console.warn("hello"));
  runAsTenant(acme, () => console.warn("[zz-acme] said already"));
  runAsTenant(acme, () => console.warn({ at: 1 }));
  console.warn("outside");
  process.env.NEXT_RUNTIME = "nodejs";
  const { onRequestError } = await import("../src/instrumentation");
  const failure = Object.assign(new Error("boom\nstack"), { digest: "123" });
  await onRequestError(failure, { path: "/leads", method: "GET", headers: { host: `zz-acme.${PLATFORM_DOMAIN}` } }, { routePath: "/leads/page", routeType: "render" });
  await runAsTenant(acme, () => onRequestError(failure, { path: "/leads", method: "GET", headers: { host: `zz-acme.${PLATFORM_DOMAIN}` } }, { routePath: "/leads/page", routeType: "render" }));
  process.env.NEXT_RUNTIME = "";
  console.warn = realWarn;
  console.error = realError;
  ok("a line written as a workspace is labelled with it", lines[0] === "[zz-acme] hello", lines[0]);
  ok("…once, when its writer labelled it already", lines[1] === "[zz-acme] said already", lines[1]);
  ok("…before anything that is not text", lines[2] === '[zz-acme] {"at":1}', lines[2]);
  ok("a line about no workspace is left alone", lines[3] === "outside", lines[3]);
  ok("installing twice labels once", !lines.some((l) => l.startsWith("[zz-acme] [zz-acme]")));
  ok("a request's error names its workspace, route and digest", lines[4] === "[zz-acme] render error on GET /leads (/leads/page) digest=123: boom", lines[4]);
  ok("…once, inside the workspace too", lines[5] === lines[4], lines[5]);
  ok("a workspace's address → its slug", labelForHost(`zz-acme.${PLATFORM_DOMAIN}:3000`) === "zz-acme", labelForHost(`zz-acme.${PLATFORM_DOMAIN}:3000`));
  ok("the platform's own addresses → platform", labelForHost(PLATFORM_DOMAIN) === "platform" && labelForHost(`admin.${PLATFORM_DOMAIN}`) === "platform");
  ok("a custom domain → itself; none → no label", labelForHost("crm.example.org") === "crm.example.org" && labelForHost(null) === null);

  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll hardening checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
