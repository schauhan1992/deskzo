/**
 * load:automate — Deskzo Automate under load (Phase 8: "the run backlog stays under 1 minute at 10× the
 * busiest pilot's volume"). There is no pilot yet, so the target is the stand-in agreed for it: 50
 * workflows and 20,000 steps a day in each workspace, 10 workspaces at once.
 *
 *   1. A scratch control plane and one workspace migrated as provisioning makes it, copied N times
 *      (CREATE DATABASE … TEMPLATE); each gets an owner and 50 workflows — 30 started by a task being
 *      made (each listening for its own title), 15 on an hourly schedule (all due at the start), 5 by
 *      hand. Every run is a condition and two notifications: two steps.
 *   2. Steady: tasks are made in every workspace at the rate asked (--steps a second, per workspace),
 *      for --minutes, while the platform worker's own loop (runAutomate, then a second's pause) works
 *      the wake list — in this process, as scripts/platform-worker.ts runs it.
 *   3. Burst: --burst tasks made at once in three workspaces (an import), then drained.
 *
 * Measured from the databases afterwards: how long each run waited — its event's time to the moment a
 * worker took it up — and, sampled every 5 seconds meanwhile, the oldest work due and not yet taken up
 * (the backlog). Written to docs/reports/automate-load-test.md. Never sweeps: the worker follows the
 * scratch control plane's wake list only, so no real workspace is touched.
 *
 *   npm run load:automate -- --workspaces 10 --minutes 3 --steps 2 --burst 1000
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { directClient } from "../src/lib/tenancy/direct-client";
import type { Definition } from "../src/lib/automate/definition";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
delete process.env.TRUST_PROXY;

const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  const n = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const WORKSPACES = flag("workspaces", 10);
const MINUTES = flag("minutes", 3);
const STEPS_PER_SECOND = flag("steps", 2);
const BURST = flag("burst", 1000);
const BURST_WORKSPACES = Math.min(3, WORKSPACES);
const STEPS_PER_RUN = 2;
const TARGET_STEPS_A_DAY = 20_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const withDatabase = (url: string, database: string) => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};
const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0);
const secs = (ms: number) => (ms / 1000).toFixed(1);

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host)) throw new Error("load:automate makes scratch databases: run it against a local database only.");
  const realName = new URL(url).pathname.slice(1);
  const prefix = `${realName}_autoload`;
  const names = { template: `${prefix}_tpl`, control: `${prefix}_ctl`, workspaces: Array.from({ length: WORKSPACES }, (_, i) => `${prefix}_${i}`) };
  const all = [names.template, names.control, ...names.workspaces];
  const admin = directClient(withDatabase(url, "postgres"));
  let close: (() => Promise<void>) | null = null;
  const started = new Date();
  try {
    console.log(`Setting up ${WORKSPACES} workspaces…`);
    for (const name of all) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${names.template}"`);
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, names.template) }, timeout: 10 * 60_000 });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${names.control}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: withDatabase(url, names.control) }, timeout: 5 * 60_000 });
    for (const [i, name] of names.workspaces.entries()) {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}" TEMPLATE "${names.template}"`);
      process.env[`TENANT_DB_ZZLOAD_${i}`] = withDatabase(url, name);
    }
    process.env.CONTROL_DATABASE_URL = withDatabase(url, names.control);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    const { closeAllClients } = require("../src/lib/tenancy/clients") as typeof import("../src/lib/tenancy/clients");
    const { closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    close = async () => {
      await closeAllClients();
      await closeControlDb();
    };
    const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const store = require("../src/lib/automate/store") as typeof import("../src/lib/automate/store");
    const { runAutomate } = require("../src/lib/automate/worker") as typeof import("../src/lib/automate/worker");
    const { emitTask } = require("../src/lib/automate/emit-records") as typeof import("../src/lib/automate/emit-records");
    /* eslint-enable @typescript-eslint/no-require-imports */

    type Tenant = NonNullable<Awaited<ReturnType<typeof registry.tenantBySlug>>>;
    const tenants: Tenant[] = [];
    for (let i = 0; i < WORKSPACES; i++) tenants.push((await registry.tenantBySlug(`zzload-${i}`))!);
    const owners = new Map<string, string>();
    const manual = new Map<string, string[]>();
    const notify = (id: string) => ({ id, type: "action", action: "notify.person", input: { to: "owner", title: "ZZ load {{trigger.task.title}}" } });
    const steps = [{ id: "check", type: "condition", if: { all: [{ ref: "trigger.task.title", op: "contains", value: "ZZ" }] } }, notify("one"), notify("two")];
    const tellPlain = (id: string) => ({ id, type: "action", action: "notify.person", input: { to: "owner", title: "ZZ load, on time" } });
    const plain = [tellPlain("one"), tellPlain("two")];
    for (const t of tenants) {
      await runAsTenant(t, async () => {
        const owner = await db.user.create({ data: { name: "ZZ Load Owner", email: `zzowner@${t.slug}.invalid`, passwordHash: "!", role: "ADMIN", isSuperAdmin: true }, select: { id: true } });
        owners.set(t.id, owner.id);
        const publish = async (name: string, d: unknown) => {
          const w = await store.createWorkflow({ name, ownerUserId: owner.id, createdById: owner.id, draft: d as Definition });
          const published = await store.publishWorkflow(w.id, owner.id);
          if (!published.ok) throw new Error(`${name}: ${published.error} ${JSON.stringify(published.problems ?? [])}`);
          return w.id;
        };
        for (let w = 0; w < 30; w++) await publish(`ZZ on W${w}`, { schema: 1, trigger: { type: "task.created", filter: { all: [{ ref: "trigger.task.title", op: "eq", value: `ZZ load W${w}` }] } }, steps });
        for (let w = 0; w < 15; w++) await publish(`ZZ hourly ${w}`, { schema: 1, trigger: { type: "schedule", schedule: { every: "hour" } }, steps: plain });
        const hand: string[] = [];
        for (let w = 0; w < 5; w++) hand.push(await publish(`ZZ by hand ${w}`, { schema: 1, trigger: { type: "manual" }, steps: plain }));
        manual.set(t.id, hand);
        // Every schedule due now: their runs land with the first events.
        await db.automationTrigger.updateMany({ where: { type: "schedule" }, data: { nextFireAt: new Date() } });
      });
    }
    console.log(`Set up in ${secs(Date.now() - started.getTime())} s. Steady load: ${STEPS_PER_SECOND} steps a second in each workspace for ${MINUTES} min.`);

    let made = 0;
    const makeTask = (t: Tenant, w: number) =>
      runAsTenant(t, () =>
        db.$transaction(async (tx) => {
          const task = await tx.task.create({ data: { title: `ZZ load W${w}`, createdByUserId: owners.get(t.id)!, assignedToUserId: owners.get(t.id)! }, select: { id: true } });
          await emitTask(tx, "task.created", task.id, owners.get(t.id)!);
          made += 1;
        }),
      );

    // ─── The worker, as the platform worker runs it ─────────────────────────────────────────────
    let stopWorker = false;
    let passes = 0;
    const worker = (async () => {
      while (!stopWorker) {
        await runAutomate().catch((err) => console.error("worker pass failed", err instanceof Error ? err.message : err));
        passes += 1;
        await sleep(1000);
      }
    })();

    // ─── Sampling the backlog ───────────────────────────────────────────────────────────────────
    const loop = monitorEventLoopDelay({ resolution: 20 });
    loop.enable();
    const samples: { at: number; phase: string; oldestMs: number; due: number; connections: number; rss: number }[] = [];
    let phase = "steady";
    let stopSampling = false;
    const sampler = (async () => {
      while (!stopSampling) {
        const now = Date.now();
        let oldest = 0;
        let due = 0;
        for (const t of tenants) {
          const [row] = await runAsTenant(t, () =>
            db.$queryRaw<{ ev: Date | null; run: Date | null; n: bigint }[]>`
              SELECT (SELECT min("occurredAt") FROM "automation_events" WHERE "matchedAt" IS NULL) AS ev,
                     (SELECT min("runAfter") FROM "automation_runs" WHERE "status" = 'QUEUED' AND "runAfter" <= now()) AS run,
                     (SELECT count(*) FROM "automation_runs" WHERE "status" = 'QUEUED' AND "runAfter" <= now())::bigint
                       + (SELECT count(*) FROM "automation_events" WHERE "matchedAt" IS NULL)::bigint AS n`,
          );
          const times = [row?.ev, row?.run].filter((d): d is Date => !!d).map((d) => now - d.getTime());
          oldest = Math.max(oldest, ...times, 0);
          due += Number(row?.n ?? 0);
        }
        const [conn] = await admin.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE datname LIKE '${prefix}%'`);
        samples.push({ at: now, phase, oldestMs: oldest, due, connections: Number(conn?.n ?? 0), rss: process.memoryUsage().rss });
        await sleep(5000);
      }
    })();

    // ─── Steady ─────────────────────────────────────────────────────────────────────────────────
    const steadyStart = new Date();
    const eventsPerSecond = STEPS_PER_SECOND / STEPS_PER_RUN;
    const steadyUntil = Date.now() + MINUTES * 60_000;
    await Promise.all(
      tenants.map(async (t, i) => {
        let k = i;
        let lastManual = Date.now();
        while (Date.now() < steadyUntil) {
          await makeTask(t, k++ % 30);
          if (Date.now() - lastManual > 10_000) {
            lastManual = Date.now();
            const hand = manual.get(t.id)!;
            await runAsTenant(t, () => store.startManualRun(hand[k % hand.length]!, owners.get(t.id)!));
          }
          await sleep(1000 / eventsPerSecond);
        }
      }),
    );
    const steadyEnd = new Date();
    const drainedBy = async (deadline: number) => {
      for (;;) {
        let left = 0;
        for (const t of tenants) {
          left += await runAsTenant(t, async () => (await db.automationEvent.count({ where: { matchedAt: null } })) + (await db.automationRun.count({ where: { status: { in: ["QUEUED", "RUNNING"] } } })));
        }
        if (!left || Date.now() > deadline) return left;
        await sleep(2000);
      }
    };
    const steadyLeft = await drainedBy(Date.now() + 5 * 60_000);
    console.log(`Steady over: ${made} tasks made, ${steadyLeft} left to do. Burst: ${BURST} tasks at once in ${BURST_WORKSPACES} workspaces.`);

    // ─── Burst ──────────────────────────────────────────────────────────────────────────────────
    phase = "burst";
    const burstStart = new Date();
    await Promise.all(
      tenants.slice(0, BURST_WORKSPACES).map(async (t) => {
        for (let n = 0; n < BURST; n += 50) await Promise.all(Array.from({ length: Math.min(50, BURST - n) }, (_, j) => makeTask(t, (n + j) % 30)));
      }),
    );
    const burstMade = new Date();
    const burstLeft = await drainedBy(Date.now() + 15 * 60_000);
    const burstEnd = new Date();
    stopWorker = true;
    stopSampling = true;
    await Promise.all([worker, sampler]);
    loop.disable();

    // ─── Measuring ──────────────────────────────────────────────────────────────────────────────
    const waits = { steady: [] as number[], burst: [] as number[] };
    const finished = { steady: [] as number[], burst: [] as number[] };
    let runs = 0;
    let failed = 0;
    let stepsDone = 0;
    for (const t of tenants) {
      const rows = await runAsTenant(t, () =>
        db.$queryRaw<{ occurred: Date; started: Date | null; finished: Date | null; status: string; steps: number }[]>`
          SELECT e."occurredAt" AS occurred, r."startedAt" AS started, r."finishedAt" AS finished, r."status"::text AS status, r."stepsUsed" AS steps
            FROM "automation_runs" r JOIN "automation_events" e ON e."id" = r."eventId"`,
      );
      const scheduled = await runAsTenant(t, () => db.automationRun.findMany({ where: { eventId: null }, select: { status: true, stepsUsed: true } }));
      for (const s of scheduled) {
        runs += 1;
        stepsDone += s.stepsUsed;
        if (s.status === "FAILED") failed += 1;
      }
      for (const r of rows) {
        runs += 1;
        stepsDone += r.steps;
        if (r.status === "FAILED") failed += 1;
        if (!r.started) continue;
        const which = r.occurred >= burstStart ? "burst" : "steady";
        waits[which].push(r.started.getTime() - r.occurred.getTime());
        if (r.finished) finished[which].push(r.finished.getTime() - r.occurred.getTime());
      }
    }
    for (const list of [waits.steady, waits.burst, finished.steady, finished.burst]) list.sort((a, b) => a - b);
    const steadySamples = samples.filter((s) => s.phase === "steady");
    const burstSamples = samples.filter((s) => s.phase === "burst");
    const maxOf = (list: typeof samples, f: (s: (typeof samples)[number]) => number) => list.reduce((m, s) => Math.max(m, f(s)), 0);
    const steadyBacklog = maxOf(steadySamples, (s) => s.oldestMs);
    const burstBacklog = maxOf(burstSamples, (s) => s.oldestMs);
    const steadySteps = (made - BURST * BURST_WORKSPACES) * STEPS_PER_RUN;
    const perDayPerWorkspace = Math.round((STEPS_PER_SECOND * 86_400) / 1);
    const multiple = (STEPS_PER_SECOND * 86_400) / TARGET_STEPS_A_DAY;
    const verdict = (ms: number) => (ms < 60_000 ? "under a minute" : "OVER a minute");

    const report = `# Load test — Deskzo Automate

Run ${started.toISOString().replace("T", " ").slice(0, 16)} UTC by \`npm run load:automate\` (scripts/load-automate.ts), on ${os.cpus().length} CPUs, Node ${process.version}, one process running both the load and the platform worker's loop.

## The target

The plan's acceptance for Phase 8: the run backlog stays under a minute at 10× the busiest pilot's volume. There is no pilot yet, so the stand-in agreed on 18 Oct 2026 is the target: **50 workflows and ${TARGET_STEPS_A_DAY.toLocaleString("en-IN")} steps a day in each workspace, ${WORKSPACES} workspaces at once**.

## Setup

- ${WORKSPACES} workspaces, each its own database (copies of one migrated as provisioning makes it), each with an owner and 50 workflows: 30 started by a task being made (each listening for its own title), 15 hourly schedules (all due at the start), 5 started by hand (one every 10 seconds). Every run is a condition and two notifications — ${STEPS_PER_RUN} steps.
- **Steady:** ${STEPS_PER_SECOND} steps a second in every workspace for ${MINUTES} minutes — ${perDayPerWorkspace.toLocaleString("en-IN")} a day each, **${multiple.toFixed(1)}× the target** — ${steadySteps.toLocaleString("en-IN")} steps in all.
- **Burst:** ${BURST.toLocaleString("en-IN")} tasks made at once in each of ${BURST_WORKSPACES} workspaces (an import), ${(BURST * BURST_WORKSPACES * STEPS_PER_RUN).toLocaleString("en-IN")} steps.
- The worker: \`runAutomate()\` then a second's pause, as scripts/platform-worker.ts runs it — four workspaces at a time, five runs at once in each, following the wake list.

## Results

| | Runs | Waited before a worker took it up (p50 / p95 / max) | Event to finished (p50 / p95 / max) | Oldest work due, at worst | Verdict |
|---|---|---|---|---|---|
| Steady | ${waits.steady.length} | ${secs(pct(waits.steady, 50))} / ${secs(pct(waits.steady, 95))} / ${secs(waits.steady.at(-1) ?? 0)} s | ${secs(pct(finished.steady, 50))} / ${secs(pct(finished.steady, 95))} / ${secs(finished.steady.at(-1) ?? 0)} s | ${secs(steadyBacklog)} s | ${verdict(steadyBacklog)} |
| Burst | ${waits.burst.length} | ${secs(pct(waits.burst, 50))} / ${secs(pct(waits.burst, 95))} / ${secs(waits.burst.at(-1) ?? 0)} s | ${secs(pct(finished.burst, 50))} / ${secs(pct(finished.burst, 95))} / ${secs(finished.burst.at(-1) ?? 0)} s | ${secs(burstBacklog)} s | ${verdict(burstBacklog)} |

- Runs in all: ${runs.toLocaleString("en-IN")} (${failed} failed); steps done: ${stepsDone.toLocaleString("en-IN")}. Left undone when the test stopped: ${steadyLeft} after the steady load, ${burstLeft} after the burst.
- The burst's ${(BURST * BURST_WORKSPACES).toLocaleString("en-IN")} tasks took ${secs(burstMade.getTime() - burstStart.getTime())} s to make, and everything was done ${secs(burstEnd.getTime() - burstStart.getTime())} s after the first.
- Worker passes: ${passes}. Connections to the workspaces' databases, at most: ${maxOf(samples, (s) => s.connections)}. Memory: ${Math.round((samples[0]?.rss ?? 0) / 1_048_576)} → ${Math.round(maxOf(samples, (s) => s.rss) / 1_048_576)} MB. Event loop delay p99: ${(loop.percentile(99) / 1e6).toFixed(0)} ms.
- Steady phase ${steadyStart.toISOString().slice(11, 19)}–${steadyEnd.toISOString().slice(11, 19)} UTC; burst ${burstStart.toISOString().slice(11, 19)}–${burstEnd.toISOString().slice(11, 19)} UTC.
`;
    mkdirSync("docs/reports", { recursive: true });
    writeFileSync("docs/reports/automate-load-test.md", report);
    console.log(report);
  } finally {
    if (close) await close().catch(() => undefined);
    for (const name of all) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch((err) => console.error(`could not drop ${name}`, err));
    await admin.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
