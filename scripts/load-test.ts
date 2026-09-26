/**
 * The 200-workspace load test — `npm run load:test [-- --workspaces 200 --requests 6000 --concurrency 32]`.
 *
 * What it answers: whether one app server can serve many workspaces at once through the tenancy
 * layer (src/lib/tenancy) — one shared client, a pool per workspace, a bounded number kept, ended and reopened —
 * without running the database server out of connections or the process out of memory, and how
 * fast it stays while doing so.
 *
 * On the local database server only, all made and dropped here, pass or fail:
 *
 *   1. a scratch control plane, and one workspace database made and migrated as provisioning makes
 *      them, with a little data in it — the template;
 *   2. N copies of it (CREATE DATABASE … TEMPLATE, quick), each registered as a workspace;
 *   3. for each setting under test, a fresh process runs the same workload: requests spread over
 *      the workspaces the way real traffic is (four in five to a fifth of them), each a request's
 *      worth of work — who the person is, what they may see, a list, a count, now and then a write —
 *      at a fixed concurrency, while this process samples the server's connections;
 *   4. a report: docs/reports/load-test.md.
 *
 * Nothing leaves the machine; no workspace that exists is touched.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { execSync } from "node:child_process";
import { directClient } from "../src/lib/tenancy/direct-client";

const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  const n = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const WORKSPACES = flag("workspaces", 200);
const REQUESTS = flag("requests", 6000);
const CONCURRENCY = flag("concurrency", 32);

/**
 * The settings compared: as shipped (a worst case within 70% of a stock server's connections); far
 * fewer pools kept, so most requests reopen one — what that costs now; and more kept, with a worst
 * case of all the server's connections.
 */
const SCENARIOS = [
  { name: "defaults", env: { TENANCY_MAX_CLIENTS: "35", TENANCY_CONNECTION_LIMIT: "2", TENANCY_IDLE_CONNECTION_S: "30" }, note: "35 workspace pools per process, 2 connections each, closed after 30 s unused — as shipped" },
  { name: "few kept", env: { TENANCY_MAX_CLIENTS: "10", TENANCY_CONNECTION_LIMIT: "2", TENANCY_IDLE_CONNECTION_S: "30" }, note: "10 pools, 2 connections each" },
  { name: "more kept", env: { TENANCY_MAX_CLIENTS: "50", TENANCY_CONNECTION_LIMIT: "2", TENANCY_IDLE_CONNECTION_S: "30" }, note: "50 pools, 2 connections each" },
];

type WorkerResult = {
  ops: number;
  errors: number;
  errorKinds: Record<string, number>;
  ms: number;
  latency: { p50: number; p95: number; p99: number; max: number };
  rss: { start: number; peak: number; end: number };
  clientsOpened: number;
  peakClients: number;
  /** Evicted but not yet closed — still holding connections and memory. */
  peakClosing: number;
  closingAtEnd: number;
  workspacesTouched: number;
  /** A workspace's first query on a new pool, and the next one on the same pool — ms, median. */
  coldMs: number;
  warmMs: number;
  /** Of the first query, how long the process's thread was busy — ms, median. */
  coldBusyMs: number;
  /** How much of the time the process's one thread was busy (0–1), and how late timers ran — ms. */
  loop: { utilization: number; delayP99: number; delayMax: number };
};

/** The most connections a scenario's settings allow one process: pools kept × connections each. */
const bound = (s: (typeof SCENARIOS)[number]) => Number(s.env.TENANCY_MAX_CLIENTS) * Number(s.env.TENANCY_CONNECTION_LIMIT);
const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

// ─── The worker: runs the workload in a process of its own, with the scenario's settings ────
async function worker() {
  process.env.WROFFY_TENANCY_FALLBACK = "legacy";
  /* eslint-disable @typescript-eslint/no-require-imports */
  const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
  const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const { clientStats, closeAllClients } = require("../src/lib/tenancy/clients") as typeof import("../src/lib/tenancy/clients");
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const authz = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
  const { closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
  const fixture = JSON.parse(process.env.LOAD_FIXTURE!) as { slugs: string[]; ownerId: string; companyIds: string[] };

  const tenants: NonNullable<Awaited<ReturnType<typeof registry.tenantBySlug>>>[] = [];
  for (const slug of fixture.slugs) tenants.push((await registry.tenantBySlug(slug))!);
  const hot = tenants.slice(0, Math.max(1, Math.floor(tenants.length / 5)));
  const pick = () => (Math.random() < 0.8 ? hot[Math.floor(Math.random() * hot.length)] : tenants[Math.floor(Math.random() * tenants.length)])!;

  // What opening a workspace costs: a first query on a new pool, then one on the same, ten times —
  // after one first, so the shared client's own start is not counted.
  await runAsTenant(tenants[0]!, () => db.company.count());
  const cold: number[] = [];
  const coldBusy: number[] = [];
  const warm: number[] = [];
  for (const t of tenants.slice(-10)) {
    const busy0 = performance.eventLoopUtilization();
    let t0 = performance.now();
    await runAsTenant(t, () => db.company.count());
    cold.push(performance.now() - t0);
    coldBusy.push(performance.eventLoopUtilization(busy0).active);
    t0 = performance.now();
    await runAsTenant(t, () => db.company.count());
    warm.push(performance.now() - t0);
  }
  await closeAllClients();
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

  let peakClients = 0;
  let peakClosing = 0;
  const touched = new Set<string>();
  const latencies: number[] = [];
  const errorKinds: Record<string, number> = {};
  let errors = 0;
  const openedBefore = clientStats().opened;
  const rss = { start: process.memoryUsage().rss, peak: 0, end: 0 };
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const elu0 = performance.eventLoopUtilization();
  const sampler = setInterval(() => {
    rss.peak = Math.max(rss.peak, process.memoryUsage().rss);
    const stats = clientStats();
    peakClients = Math.max(peakClients, stats.kept);
    peakClosing = Math.max(peakClosing, stats.closing);
  }, 200);

  let issued = 0;
  const started = Date.now();
  const request = async () => {
    const tenant = pick();
    touched.add(tenant.id);
    const t0 = performance.now();
    try {
      await runAsTenant(tenant, async () => {
        await db.user.findUnique({ where: { id: fixture.ownerId }, select: { id: true, name: true, role: true, active: true } });
        await authz.can(fixture.ownerId, "leads.view");
        await db.company.findMany({ take: 20, orderBy: { name: "asc" }, select: { id: true, name: true, stage: true, updatedAt: true } });
        await db.company.count();
        if (Math.random() < 0.1) {
          // In a transaction, which may well be running when its pool is evicted.
          const id = fixture.companyIds[Math.floor(Math.random() * fixture.companyIds.length)]!;
          await db.$transaction(async (tx) => {
            await tx.company.update({ where: { id }, data: { website: `https://load-${Date.now()}.example` } });
            await tx.company.count({ where: { stage: "CUSTOMER" } });
          });
        }
      });
      latencies.push(performance.now() - t0);
    } catch (err) {
      errors += 1;
      const kind = err instanceof Error ? (err.message.match(/too many (clients|connections)|Timed out fetching a new connection|remaining connection slots|connection limit/i)?.[0] ?? err.message.split("\n").slice(-1)[0]!.slice(0, 80)) : String(err);
      errorKinds[kind] = (errorKinds[kind] ?? 0) + 1;
    }
  };
  const lane = async () => {
    while (issued < REQUESTS) {
      issued += 1;
      await request();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, lane));
  const ms = Date.now() - started;
  clearInterval(sampler);
  delay.disable();
  const elu = performance.eventLoopUtilization(elu0);
  rss.end = process.memoryUsage().rss;
  rss.peak = Math.max(rss.peak, rss.end);
  // Once the last request is done, nothing runs on an evicted pool: every one should be ended.
  await new Promise((r) => setTimeout(r, 500));
  const closingAtEnd = clientStats().closing;
  const sorted = [...latencies].sort((a, b) => a - b);
  const result: WorkerResult = {
    ops: latencies.length + errors,
    errors,
    errorKinds,
    ms,
    latency: { p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted.at(-1) ?? 0 },
    rss,
    clientsOpened: clientStats().opened - openedBefore,
    peakClients,
    peakClosing,
    closingAtEnd,
    workspacesTouched: touched.size,
    loop: { utilization: elu.utilization, delayP99: delay.percentile(99) / 1e6, delayMax: delay.max / 1e6 },
    coldMs: median(cold),
    warmMs: median(warm),
    coldBusyMs: median(coldBusy),
  };
  await closeAllClients();
  await closeControlDb();
  process.stdout.write(`\nRESULT ${JSON.stringify(result)}\n`);
}

// ─── The orchestrator ────────────────────────────────────────────────────────────────────────
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  if (!["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname)) throw new Error("The load test runs against a local database server only.");
  const realName = new URL(url).pathname.slice(1);
  const controlName = `${realName}_loadtest_control`;
  const controlUrl = withDatabase(url, controlName);
  const admin = directClient(withDatabase(url, "postgres"));
  const made: string[] = [];
  let templateRole: string | null = null;
  const log = (line: string) => console.log(`[load-test] ${line}`);

  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${controlName}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;
    process.env.REFERENCE_DATABASE_URL = "";
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const provisioner = require("../src/lib/platform/provisioner") as typeof import("../src/lib/platform/provisioner");
    const { migrateDeploy } = require("../src/lib/platform/migrate") as typeof import("../src/lib/platform/migrate");
    const keys = require("../src/lib/tenancy/keys") as typeof import("../src/lib/tenancy/keys");
    const { sealForTenant } = require("../src/lib/platform/kek") as typeof import("../src/lib/platform/kek");
    const control = controlDb();

    // 1. The template: a workspace database as provisioning makes one, with a little in it.
    log("making and migrating the template workspace…");
    const template = await provisioner.createWorkspaceDatabase();
    made.push(template.dbName);
    templateRole = template.dbRole;
    await migrateDeploy(template.url);
    const seed = directClient(template.url);
    const owner = await seed.user.create({ data: { email: "owner@load.example", name: "Load Owner", role: "ADMIN", isSuperAdmin: true, passwordHash: "x" } });
    const companies = await seed.company.createManyAndReturn({
      data: Array.from({ length: 200 }, (_, i) => ({ name: `Load Company ${String(i).padStart(3, "0")}`, normalizedName: `load company ${i}`, createdById: owner.id, ownerUserId: owner.id, relationshipType: "CLIENT" as const, stage: "CUSTOMER" as const })),
      select: { id: true },
    });
    await seed.$disconnect();
    const [size] = await admin.$queryRawUnsafe<{ bytes: bigint }[]>(`select pg_database_size('${template.dbName}') as bytes`);
    const templateMb = mb(Number(size!.bytes));
    log(`template: ${templateMb} MB; ${WORKSPACES} copies ≈ ${Math.round((templateMb * WORKSPACES) / 1024)} GB`);
    if (templateMb * WORKSPACES > 12 * 1024) throw new Error("The copies would take more than 12 GB — run with fewer --workspaces.");
    // Every copy shares the template's role, so its own connection cap would be one cap for all of
    // them; a real workspace has a role, and a cap, of its own.
    await admin.$executeRawUnsafe(`ALTER ROLE "${template.dbRole}" CONNECTION LIMIT -1`);

    // 2. The copies, each a workspace in the control plane.
    log(`copying it ${WORKSPACES} times…`);
    const copyStarted = Date.now();
    const slugs: string[] = [];
    for (let i = 0; i < WORKSPACES; i++) {
      const dbName = `w_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}" TEMPLATE "${template.dbName}" OWNER "${template.dbRole}"`);
      made.push(dbName);
      await admin.$executeRawUnsafe(`REVOKE CONNECT, TEMPORARY ON DATABASE "${dbName}" FROM PUBLIC`);
      const id = randomUUID();
      const slug = `lt-${String(i).padStart(3, "0")}`;
      const dbUrl = withDatabase(template.url, dbName).replace(/\?.*$/, "?schema=public");
      await control.tenant.create({
        data: {
          id,
          slug,
          name: `Load ${i}`,
          status: "ACTIVE",
          dbName,
          dbRole: template.dbRole,
          dbUrlCipher: sealForTenant(id, "db-url", dbUrl),
          keyBundleCipher: keys.sealKeyBundle(id, keys.newKeyBundle()),
          entitlements: { v: 1, all: true, modules: [], seats: null, copilotTokens: null, plans: ["load"] },
        },
      });
      slugs.push(slug);
      if ((i + 1) % 50 === 0) log(`  ${i + 1} made`);
    }
    const copySeconds = Math.round((Date.now() - copyStarted) / 1000);
    await closeControlDb();

    // 3. Each scenario in a process of its own, sampled from here.
    const [pg] = await admin.$queryRaw<{ version: string; max: string }[]>`select current_setting('server_version') as version, current_setting('max_connections') as max`;
    const results: { scenario: (typeof SCENARIOS)[number]; result: WorkerResult | null; peakPg: number; peakAll: number; output: string }[] = [];
    const fixture = JSON.stringify({ slugs, ownerId: owner.id, companyIds: companies.map((c) => c.id) });
    const runWorker = (env: Record<string, string>, requests: number) =>
      new Promise<string>((resolve) => {
        const tsx = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
        const child = spawn(process.execPath, [tsx, __filename, "--worker", "--requests", String(requests), "--concurrency", String(CONCURRENCY)], {
          env: { ...process.env, ...env, LOAD_FIXTURE: fixture },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let text = "";
        child.stdout.on("data", (c) => (text += String(c)));
        child.stderr.on("data", (c) => (text += String(c)));
        child.on("close", () => resolve(text));
      });
    // Untimed, so the first scenario does not pay for the server's cold caches alone.
    log("warming the server up…");
    await runWorker(SCENARIOS[0]!.env, Math.max(200, Math.round(REQUESTS / 5)));
    for (const scenario of SCENARIOS) {
      log(`scenario "${scenario.name}": ${REQUESTS} requests, ${CONCURRENCY} at a time…`);
      let peakPg = 0;
      let peakAll = 0;
      const sampling = setInterval(async () => {
        try {
          const [row] = await admin.$queryRaw<{ ws: bigint; all: bigint }[]>`select count(*) filter (where datname like 'w\\_%') as ws, count(*) as all from pg_stat_activity where backend_type = 'client backend'`;
          peakPg = Math.max(peakPg, Number(row!.ws));
          peakAll = Math.max(peakAll, Number(row!.all));
        } catch {
          // A sample missed while the server is full is itself the finding; the next one reads it.
        }
      }, 300);
      const output = await runWorker(scenario.env, REQUESTS);
      clearInterval(sampling);
      const line = output.split("\n").find((l) => l.startsWith("RESULT "));
      const result = line ? (JSON.parse(line.slice(7)) as WorkerResult) : null;
      results.push({ scenario, result, peakPg, peakAll, output: result ? "" : output.slice(-1500) });
      log(result ? `  ${result.ops} requests in ${(result.ms / 1000).toFixed(1)} s, ${result.errors} failed, p95 ${result.latency.p95.toFixed(1)} ms, peak ${peakPg} workspace connections` : "  the worker gave no result");
    }

    // 4. The report.
    const rows = results.map(({ scenario, result, peakPg, peakAll }) =>
      result
        ? `| ${scenario.name} | ${scenario.note} | ${result.ops} | ${(result.ops / (result.ms / 1000)).toFixed(0)} | ${result.latency.p50.toFixed(1)} / ${result.latency.p95.toFixed(1)} / ${result.latency.p99.toFixed(1)} / ${result.latency.max.toFixed(0)} | ${result.errors}${result.errors ? ` (${((result.errors / result.ops) * 100).toFixed(1)}%)` : ""} | ${peakPg} of ${bound(scenario)} (${peakAll} in all) | ${result.peakClients} / ${result.peakClosing} / ${result.clientsOpened} | ${mb(result.rss.start)} → ${mb(result.rss.peak)} |`
        : `| ${scenario.name} | ${scenario.note} | — | — | — | the worker failed | ${peakPg} | — | — |`,
    );
    const errorLines = results.flatMap(({ scenario, result }) => (result ? Object.entries(result.errorKinds).map(([k, n]) => `- ${scenario.name}: ${n} × ${k}`) : []));
    const done = results.filter((r): r is typeof r & { result: WorkerResult } => r.result !== null);
    const failed = done.filter((r) => r.result.errors > 0);
    const perClientMb = done.map((r) => (mb(r.result.rss.peak) - mb(r.result.rss.start)) / Math.max(1, r.result.peakClients + r.result.peakClosing));
    const fastest = [...done].sort((a, b) => a.result.latency.p95 - b.result.latency.p95)[0];
    const findings = [
      failed.length === 0
        ? `- **No request failed.** The server's connections were never exhausted: at most ${Math.max(...done.map((r) => r.peakAll))} of its ${pg!.max} in use, everything included.`
        : `- **Requests failed** in ${failed.map((r) => `"${r.scenario.name}" (${r.result.errors})`).join(", ")} — see the failures above.`,
      `- **Connections follow the work, not the workspaces.** Peak connections to workspace databases, against the most the settings allow one process (pools kept × connections each): ${done.map((r) => `${r.peakPg} of ${bound(r.scenario)} for "${r.scenario.name}"`).join(", ")}. An evicted pool is ended as soon as its last query ends (at most ${Math.max(...done.map((r) => r.result.peakClosing))} evicted and still finishing at any moment; ${done.reduce((n, r) => n + r.result.closingAtEnd, 0)} left open once the work stopped), and a connection unused for TENANCY_IDLE_CONNECTION_S is closed.${done.some((r) => r.peakPg > bound(r.scenario)) ? ` Above the most allowed only where every kept pool was busy at once: the cap gives way rather than end a pool with work on it, by at most the requests running (${CONCURRENCY} here).` : ""}`,
      `- **Reopening is cheap.** Pools opened per 100 requests: ${done.map((r) => `${((r.result.clientsOpened / r.result.ops) * 100).toFixed(1)} for "${r.scenario.name}"`).join(", ")}. A workspace's first query on a new pool took ${Math.round(Math.max(...done.map((r) => r.result.coldMs)))} ms — of which the process's thread was busy ${Math.max(...done.map((r) => r.result.coldBusyMs)).toFixed(1)} ms, the rest waiting on the server for a connection — against ${Math.max(...done.map((r) => r.result.warmMs)).toFixed(1)} ms on a warm one (median, measured alone)${fastest ? `; the fastest here at p95 was "${fastest.scenario.name}" (${fastest.result.latency.p95.toFixed(1)} ms)` : ""}.`,
      `- **The process's thread.** Busy ${done.map((r) => `${Math.round(r.result.loop.utilization * 100)}% of the time for "${r.scenario.name}"`).join(", ")}, with timers up to ${Math.round(Math.max(...done.map((r) => r.result.loop.delayMax)))} ms late. Opening pools, at their measured busy time, accounts for ${done.map((r) => `${Math.round(((r.result.clientsOpened * r.result.coldBusyMs) / r.result.ms) * 100)}% of the run for "${r.scenario.name}"`).join(", ")}; the rest is compiling and answering the queries themselves.`,
      `- **Memory:** ${perClientMb.length ? `about ${Math.max(...perClientMb).toFixed(1)} MB per open pool at most (the peak's growth over the pools open at the peak, evicted ones included)` : "not measured"}.`,
    ];
    const report = `# Load test — ${WORKSPACES} workspaces

Run ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC by \`npm run load:test\` (scripts/load-test.ts).

## Setup

- ${WORKSPACES} workspaces, each its own database: copies of one made and migrated as provisioning makes them (${templateMb} MB, 200 companies, its owner); copied in ${copySeconds} s.
- Traffic spread as real traffic is: four requests in five to the busiest fifth of the workspaces, the rest to any.
- Each request: who the person is, what they may see, a page of companies, a count; one in ten also writes.
- ${REQUESTS} requests per scenario, ${CONCURRENCY} at a time, after an untimed warm-up, one app process (the tenancy layer in src/lib/tenancy, as the server runs it), on ${os.cpus().length} CPUs, Node ${process.version}.
- PostgreSQL ${pg!.version}, max_connections ${pg!.max}, on the same machine.

## Results

| Scenario | Settings | Requests | Per second | Latency ms (p50 / p95 / p99 / max) | Failed | Peak connections to workspaces (of the most allowed) | Pools (peak kept / peak evicted, finishing / opened) | Memory MB (start → peak) |
|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}

${errorLines.length ? `Failures:\n\n${errorLines.join("\n")}\n` : "No request failed."}

## What it shows

${findings.join("\n")}

## Found by this test

Three faults in how workspaces reached their databases, all found at 200 workspaces on 2026-09-26 and fixed in src/lib/tenancy/clients.ts:

1. **Evicted clients lingered.** An evicted client was closed two minutes later, whatever it was doing; with more busy workspaces than clients kept, thousands sat open at once with their connections and engines. The first run failed 98% of its requests ("remaining connection slots are reserved") and reached 14–20 GB. Now what is retired while work runs on it closes the moment that work ends, and a connection unused for half a minute closes.
2. **Busy clients were evicted.** With more workspaces in flight than clients kept, the least recently used client was often one a request was still using, and its next query opened a second client for the same workspace. The second run opened 9,379 clients for 6,000 requests, at 15 requests a second. Now eviction skips one with work running on it, and the process goes over the cap — by at most the work running at once — until it finishes.
3. **A client per workspace was the wrong unit.** With both fixed, the process still spent nearly all its time opening clients: each Prisma client parsed the whole schema on the process's one thread, about 45 ms during which every other request waited, and held about 29 MB — 57 requests a second at the defaults. Now one Prisma client serves every workspace (the Rust-free engine, through Prisma's pg driver adapter) and routes each query to its workspace's own pool; a workspace costs a pool. Sharing one client needed a guard: Prisma merges same-shaped lookups made in the same tick into one query, which would have answered one workspace from another's database — that merging is confined to one transaction's queries, and check:hardening proves the two workspaces apart.

This report is from the run after all three.

## Recommendations for production

1. TENANCY_MAX_CLIENTS is now pools kept, and pools are cheap to reopen: size it by connections (below), not by memory.
2. With more than one app process, routing each workspace to the same process (by host, at the load balancer) keeps its pool warm — useful, no longer essential.
3. Run PgBouncer in transaction mode in front of the workspace databases and set TENANCY_POOLER_URL (docs/runbook.md). Without it, keep TENANCY_MAX_CLIENTS × TENANCY_CONNECTION_LIMIT × app processes under about 70% of max_connections — or accept that the product is a worst case the idle timeout keeps you from.
4. Raise max_connections only with the memory to back it: every connection is a Postgres process.
5. Keep each workspace role's own cap (TENANCY_ROLE_CONNECTION_LIMIT, 20) so one busy workspace cannot take the server's connections from the rest.
6. Re-run this after changing any of those, and before a large onboarding.

Not covered here: the HTTP layer and page rendering (Next's own cost, the same with one workspace or many); PgBouncer itself (none on this machine); many app processes at once.
`;
    const outDir = path.join(process.cwd(), "docs", "reports");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "load-test.md"), report, "utf8");
    writeFileSync(path.join(outDir, "load-test.json"), JSON.stringify({ workspaces: WORKSPACES, requests: REQUESTS, concurrency: CONCURRENCY, templateMb, copySeconds, postgres: pg, results }, null, 2), "utf8");
    log("report written to docs/reports/load-test.md");
    for (const r of results) if (!r.result) console.log(r.output);
  } finally {
    log(`dropping ${made.length} database(s)…`);
    for (const name of made.slice().reverse()) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    if (templateRole) await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${templateRole}"`).catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname = any(${[...made, controlName]})`;
    log(`left behind: ${Number(left[0]!.n)}`);
    await admin.$disconnect();
  }
}

(args.includes("--worker") ? worker() : main()).catch((err) => {
  console.error(err);
  process.exit(1);
});
