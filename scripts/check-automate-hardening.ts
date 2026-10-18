/**
 * check:automate-hardening — Deskzo Automate, Phase 8: "a workspace restored from a backup taken mid-run
 * resumes without duplicate effects" (plan of 17 Oct 2026), and the worker leaving a workspace alone
 * while its database is put back.
 *
 * A backup here is a copy of the scratch workspace's database (CREATE DATABASE … TEMPLATE), and a
 * restore puts that copy back in its place — the same point in time a pg_dump restore returns to, and
 * what the restore worker then does for Automate (`afterRestore`). Outside calls go to a stand-in on
 * this machine, which counts them.
 *
 *   npm run check:automate-hardening
 */
import "dotenv/config";
import http from "node:http";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import Module from "node:module";
import { execSync } from "node:child_process";
import { directClient } from "../src/lib/tenancy/direct-client";
import { cidrContains, parseCidr } from "../src/lib/access/ip";
import type { Definition } from "../src/lib/automate/definition";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
delete process.env.TRUST_PROXY;

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

// ─── Who the server actions think is calling ────────────────────────────────────────────────────

let actor: { id: string; name: string; email: string; role: string } | null = null;
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
class UnauthorizedError extends Error {}
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
  UnauthorizedError,
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["@/lib/session", session],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("../src/lib/session"), session],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (byName.has(request)) return byName.get(request);
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

// ─── The stand-in outside world ─────────────────────────────────────────────────────────────────

const calls: string[] = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const p = new URL(req.url ?? "/", "http://stand-in").pathname;
    calls.push(p);
    if (p === "/api/gzipstall") {
      // Compressed, one piece of it, and then nothing: the read must still end at the deadline.
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.write(gzipSync(JSON.stringify({ ok: true, pad: "x".repeat(5000) })).subarray(0, 40));
      return;
    }
    if (p === "/api/gone") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    if (p === "/api/deep") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[".repeat(5000) + "]".repeat(5000));
      return;
    }
    res.writeHead(p.startsWith("/api/fail") ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: !p.startsWith("/api/fail") }));
  });
});
const callsTo = (p: string) => calls.filter((c) => c === p).length;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace and control plane");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so scratch databases may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const names = { a: `${realName}_autohard_a`, control: `${realName}_autohard_ctl`, snap: `${realName}_autohard_snap` };
  const admin = directClient(withDatabase(url, "postgres"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  let close: (() => Promise<void>) | null = null;
  try {
    for (const name of Object.values(names)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    const started = Date.now();
    await admin.$executeRawUnsafe(`CREATE DATABASE "${names.a}"`);
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, names.a) }, timeout: 10 * 60_000 });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${names.control}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: withDatabase(url, names.control) }, timeout: 5 * 60_000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);
    process.env.TENANT_DB_ZZHARD_A = withDatabase(url, names.a);
    process.env.CONTROL_DATABASE_URL = withDatabase(url, names.control);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    const { closeAllClients } = require("../src/lib/tenancy/clients") as typeof import("../src/lib/tenancy/clients");
    const { closeControlDb, controlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    close = async () => {
      await closeAllClients();
      await closeControlDb();
    };
    const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const engine = require("../src/lib/automate/engine") as typeof import("../src/lib/automate/engine");
    const store = require("../src/lib/automate/store") as typeof import("../src/lib/automate/store");
    const outbound = require("../src/lib/automate/outbound") as typeof import("../src/lib/automate/outbound");
    const { afterRestore } = require("../src/lib/automate/restore") as typeof import("../src/lib/automate/restore");
    const sent = require("../src/lib/automate/sent") as typeof import("../src/lib/automate/sent");
    const maintenance = require("../src/lib/backup/maintenance") as typeof import("../src/lib/backup/maintenance");
    const { emitTask } = require("../src/lib/automate/emit-records") as typeof import("../src/lib/automate/emit-records");
    const { isBlockedAddress } = require("../src/lib/net/safe-fetch") as typeof import("../src/lib/net/safe-fetch");
    /* eslint-enable @typescript-eslint/no-require-imports */

    const A = (await registry.tenantBySlug("zzhard-a"))!;
    const inA = <T,>(work: () => Promise<T>) => runAsTenant(A, work);
    const loopback = parseCidr("127.0.0.1/32")!;
    outbound.setTestOutbound({
      protocols: ["http:"],
      ports: [port],
      timeoutMs: 1_500,
      resolve: async () => ["127.0.0.1"],
      blocked: (ip) => !cidrContains(loopback, ip) && isBlockedAddress(ip),
      rewrite: (u: string) => u.replace(/^https:\/\/api\.zzhard\.test\//, `http://127.0.0.1:${port}/`),
    });

    const ownerUser = await inA(() => db.user.create({ data: { name: "ZZ Owner", email: "zzowner@zzhard.invalid", passwordHash: "!", role: "ADMIN", isSuperAdmin: true }, select: { id: true, name: true, email: true, role: true } }));
    const owner = ownerUser.id;
    actor = { id: owner, name: ownerUser.name, email: ownerUser.email!, role: ownerUser.role };

    const call = (id: string, path: string) => ({ id, type: "action", action: "http.request", input: { url: `https://api.zzhard.test/api/${path}`, method: "POST", body: { step: id } } });
    const publish = async (name: string, d: unknown) => {
      const w = await inA(() => store.createWorkflow({ name, ownerUserId: owner, createdById: owner, draft: d as Definition }));
      const published = await inA(() => store.publishWorkflow(w.id, owner));
      if (!published.ok) throw new Error(`${name}: ${published.error} ${JSON.stringify(published.problems ?? [])}`);
      return w.id;
    };
    const manual = (steps: unknown[]) => ({ schema: 1, trigger: { type: "manual" }, steps });
    const drain = () =>
      inA(async () => {
        for (let i = 0; i < 30; i++) {
          await engine.workTenant({ budgetMs: 10_000 });
          const due = (await db.automationRun.count({ where: { status: { in: ["QUEUED", "WAITING"] }, runAfter: { lte: new Date() } } })) + (await db.automationEvent.count({ where: { matchedAt: null } }));
          if (!due) break;
        }
      });
    const runOf = (id: string) => inA(() => db.automationRun.findUniqueOrThrow({ where: { id }, select: { status: true, error: true, lockedBy: true, runAfter: true } }));
    const sentRows = () => controlDb().automationSentStep.count({ where: { tenantId: A.id } });

    /** The workspace's database as it is now, kept aside — a backup. */
    const backup = async () => {
      await closeAllClients();
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${names.snap}" WITH (FORCE)`);
      await admin.$executeRawUnsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${names.a}' AND pid <> pg_backend_pid()`);
      await admin.$executeRawUnsafe(`CREATE DATABASE "${names.snap}" TEMPLATE "${names.a}"`);
    };
    /** The backup put back in its place, then what the restore worker does for Automate. */
    const restore = async () => {
      await closeAllClients();
      await admin.$executeRawUnsafe(`DROP DATABASE "${names.a}" WITH (FORCE)`);
      await admin.$executeRawUnsafe(`CREATE DATABASE "${names.a}" TEMPLATE "${names.snap}"`);
      return inA(() => afterRestore());
    };

    // ─── A run that hadn't started ────────────────────────────────────────────────────────────────
    section("A run queued when the backup was taken, finished after it");
    const w1 = await publish("ZZ one call", manual([call("c1", "one")]));
    const r1 = await inA(() => store.startManualRun(w1, owner));
    if (!r1.ok) throw new Error(r1.error);
    await backup();
    await drain();
    ok("the call goes out once and the run finishes", callsTo("/api/one") === 1 && (await runOf(r1.data.runId)).status === "SUCCEEDED", calls);
    ok("  recorded outside the workspace's database", (await sentRows()) === 1);
    await restore();
    ok("restored: the run is queued again, as it was", (await runOf(r1.data.runId)).status === "QUEUED");
    await drain();
    const r1after = await runOf(r1.data.runId);
    ok("  it comes to the call again — and doesn't make it twice: it waits for a person, saying why", callsTo("/api/one") === 1 && r1after.status === "NEEDS_ATTENTION" && r1after.error?.startsWith("This step went out before the workspace was restored from a backup") === true, r1after);
    const retried = await inA(() => store.retryRun(r1.data.runId));
    await drain();
    ok("a person says to send it again: it goes, once more", retried.ok && callsTo("/api/one") === 2 && (await runOf(r1.data.runId)).status === "SUCCEEDED");

    // ─── Half way through ─────────────────────────────────────────────────────────────────────────
    section("A run half way through when the backup was taken");
    const w2 = await publish("ZZ two calls", manual([call("first", "first"), { id: "wait", type: "delay", for: { hours: 1 } }, call("second", "second")]));
    const r2 = await inA(() => store.startManualRun(w2, owner));
    if (!r2.ok) throw new Error(r2.error);
    await drain();
    ok("the first call out, then the hour's wait", callsTo("/api/first") === 1 && (await runOf(r2.data.runId)).status === "WAITING");
    await backup();
    await inA(() => db.automationRun.update({ where: { id: r2.data.runId }, data: { runAfter: new Date() } }));
    await drain();
    ok("the wait over: the second call out, the run done", callsTo("/api/second") === 1 && (await runOf(r2.data.runId)).status === "SUCCEEDED");
    await restore();
    const r2restored = await runOf(r2.data.runId);
    ok("restored: waiting again, with the time it had — a restore doesn't cut a wait short", r2restored.status === "WAITING" && r2restored.runAfter.getTime() > Date.now() + 30 * 60_000);
    await inA(() => db.automationRun.update({ where: { id: r2.data.runId }, data: { runAfter: new Date() } }));
    await drain();
    const r2after = await runOf(r2.data.runId);
    ok("  the first call isn't made again (the restored database remembers it), nor the second (recorded outside it)", callsTo("/api/first") === 1 && callsTo("/api/second") === 1 && r2after.status === "NEEDS_ATTENTION", r2after);

    // ─── Held by a worker ─────────────────────────────────────────────────────────────────────────
    section("A run a worker was carrying when the backup was taken");
    const w3 = await publish("ZZ held", manual([call("c3", "held")]));
    const r3 = await inA(() => store.startManualRun(w3, owner));
    if (!r3.ok) throw new Error(r3.error);
    await inA(() => db.automationRun.update({ where: { id: r3.data.runId }, data: { status: "RUNNING", lockedBy: "an-old-worker:1:zz", lockedUntil: new Date(Date.now() + 60 * 60_000) } }));
    await backup();
    // None on the list before: the one after is the restore's own.
    await controlDb().automationWake.deleteMany({ where: { tenantId: A.id } });
    const released = await restore();
    const r3restored = await runOf(r3.data.runId);
    ok("restored: let go and queued now, not left held for the old worker's lease", released.released >= 1 && r3restored.status === "QUEUED" && r3restored.lockedBy === null && r3restored.runAfter.getTime() <= Date.now(), { released, r3restored });
    ok("  and the workspace is woken, so it goes on without waiting for a sweep", !!(await controlDb().automationWake.findUnique({ where: { tenantId: A.id } })));
    await drain();
    ok("  it goes on, and its call is made once", callsTo("/api/held") === 1 && (await runOf(r3.data.runId)).status === "SUCCEEDED");

    // ─── Made again after a restore ───────────────────────────────────────────────────────────────
    section("Runs the restored workspace makes again");
    const w4 = await publish("ZZ every hour", { schema: 1, trigger: { type: "schedule", schedule: { every: "hour" } }, steps: [call("tick", "tick")] });
    await inA(() => db.automationTrigger.update({ where: { workflowId: w4 }, data: { nextFireAt: new Date(Date.now() - 60_000) } }));
    await backup();
    await drain();
    ok("a schedule's slot comes due after the backup: its run calls out once", callsTo("/api/tick") === 1);
    await restore();
    await drain();
    const ticks = await inA(() => db.automationRun.findMany({ where: { workflowId: w4 }, select: { status: true } }));
    ok("  restored, the same slot comes due again — its run waits for a person rather than call twice", callsTo("/api/tick") === 1 && ticks.length === 1 && ticks[0]!.status === "NEEDS_ATTENTION", ticks);

    const w5 = await publish("ZZ on a task", { schema: 1, trigger: { type: "task.created" }, steps: [call("seen", "seen")] });
    await inA(() =>
      db.$transaction(async (tx) => {
        const task = await tx.task.create({ data: { title: "ZZ a task", createdByUserId: owner, assignedToUserId: owner }, select: { id: true } });
        await emitTask(tx, "task.created", task.id, owner);
      }),
    );
    await backup();
    await drain();
    ok("an event recorded before the backup, acted on after it: called out once", callsTo("/api/seen") === 1);
    await restore();
    await drain();
    const seenRuns = await inA(() => db.automationRun.findMany({ where: { workflowId: w5 }, select: { status: true } }));
    ok("  restored, the event is acted on again — and the call isn't made twice", callsTo("/api/seen") === 1 && seenRuns.length === 1 && seenRuns[0]!.status === "NEEDS_ATTENTION", seenRuns);

    // ─── What isn't kept ──────────────────────────────────────────────────────────────────────────
    section("What the record outside keeps, and for how long");
    const w6 = await publish("ZZ refused", manual([call("no", "fail")]));
    const r6 = await inA(() => store.startManualRun(w6, owner));
    if (!r6.ok) throw new Error(r6.error);
    const before6 = await sentRows();
    await drain();
    ok("a call answered with a failure did nothing: nothing kept for it, so the retry may call again", callsTo("/api/fail") === 1 && (await sentRows()) === before6 && (await runOf(r6.data.runId)).status === "QUEUED");
    await controlDb().automationSentStep.create({ data: { tenantId: A.id, key: "zz-old", sentAt: new Date(Date.now() - 121 * 86_400_000) } });
    const keptBefore = await sentRows();
    const pruned = await sent.pruneSent();
    ok("older than any run may live: pruned; the rest kept", pruned === 1 && (await sentRows()) === keptBefore - 1);

    // ─── The worker during a restore ──────────────────────────────────────────────────────────────
    section("The worker leaves a workspace alone while it is restored");
    const w7 = await publish("ZZ during a restore", manual([call("c7", "during")]));
    const r7 = await inA(() => store.startManualRun(w7, owner));
    if (!r7.ok) throw new Error(r7.error);
    await inA(() => maintenance.takeLock("zz-restore"));
    const skipped = await inA(() => engine.workTenant({ budgetMs: 2_000 }));
    ok("a restore under way: nothing is touched", skipped.skipped === "restoring" && callsTo("/api/during") === 0 && (await runOf(r7.data.runId)).status === "QUEUED", skipped);
    await inA(() => maintenance.releaseLock());
    await drain();
    ok("  over: the work goes on", callsTo("/api/during") === 1 && (await runOf(r7.data.runId)).status === "SUCCEEDED");

    section("Failed runs retried together");
    const gone = await publish("ZZ to a gone address", manual([call("g", "gone")]));
    const failedRuns: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await inA(() => store.startManualRun(gone, owner));
      if (!r.ok) throw new Error(r.error);
      failedRuns.push(r.data.runId);
    }
    await drain();
    const statuses = await Promise.all(failedRuns.map(async (id) => (await runOf(id)).status));
    const goneBefore = callsTo("/api/gone");
    const { retryFailedAutomationRuns } = require("../src/actions/automate") as typeof import("../src/actions/automate"); // eslint-disable-line @typescript-eslint/no-require-imports
    const retriedAll = await inA(() => retryFailedAutomationRuns(gone));
    await drain();
    ok("three runs failed for good; retried together, each goes back to its step, once", statuses.every((x) => x === "FAILED") && retriedAll.ok && retriedAll.data.retried === 3 && retriedAll.data.left === 0 && callsTo("/api/gone") === goneBefore + 3, retriedAll);
    ok("  and it is on the record", (await inA(() => db.auditLog.count({ where: { entityId: gone, entityLabel: { contains: "3 failed runs tried again" } } }))) === 1);

    section("The console's alarm when the worker falls behind");
    const { alerts } = require("../src/lib/platform/alerts") as typeof import("../src/lib/platform/alerts"); // eslint-disable-line @typescript-eslint/no-require-imports
    const late = (minutes: number) => controlDb().automationWake.upsert({ where: { tenantId: "zz-late" }, create: { tenantId: "zz-late", nextDueAt: new Date(Date.now() - minutes * 60_000) }, update: { nextDueAt: new Date(Date.now() - minutes * 60_000) } });
    // Only this check's own wake on the list: the earlier sections' were never settled by a worker.
    await controlDb().automationWake.deleteMany({});
    await late(10);
    const behind = (await alerts("OWNER")).open.filter((x) => x.kind.startsWith("automate."));
    await late(120);
    const stalled = (await alerts("OWNER")).open.filter((x) => x.kind.startsWith("automate."));
    await controlDb().automationWake.delete({ where: { tenantId: "zz-late" } });
    const clear = (await alerts("OWNER")).open.filter((x) => x.kind.startsWith("automate."));
    ok("work waiting past five minutes: a warning; past an hour: critical; none once it is done", behind[0]?.kind === "automate.backlog" && behind[0].severity === "warning" && stalled[0]?.kind === "automate.stalled" && stalled[0].severity === "critical" && clear.length === 0, [behind, stalled, clear].map((l) => l.map((x) => x.kind)));

    // ═══ The security review (Phase 8) ════════════════════════════════════════════════════════════
    /* eslint-disable @typescript-eslint/no-require-imports */
    const actions = require("../src/actions/automate") as typeof import("../src/actions/automate");
    const webhooks = require("../src/lib/automate/webhooks") as typeof import("../src/lib/automate/webhooks");
    const { signature } = require("../src/lib/automate/outbound") as typeof import("../src/lib/automate/outbound");
    const { maskStepText, summarize } = require("../src/lib/automate/redact") as typeof import("../src/lib/automate/redact");
    const { nestsDeeperThan, safeText } = require("../src/lib/automate/safe-text") as typeof import("../src/lib/automate/safe-text");
    const { compare } = require("../src/lib/automate/conditions") as typeof import("../src/lib/automate/conditions");
    const { emitLeadCreated } = require("../src/lib/automate/emit-leads") as typeof import("../src/lib/automate/emit-leads");
    const { mayAccess } = require("../src/lib/authz/access") as typeof import("../src/lib/authz/access");
    const { setWorkspacePaused } = require("../src/lib/automate/switches") as typeof import("../src/lib/automate/switches");
    const { NO_LIMITS } = require("../src/lib/automate/limits") as typeof import("../src/lib/automate/limits");
    const route = require("../src/app/api/automate/hooks/[token]/route") as typeof import("../src/app/api/automate/hooks/[token]/route");
    const { NextRequest } = require("next/server") as typeof import("next/server");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const as = (u: { id: string; name: string; email: string | null; role: string }) => {
      actor = { id: u.id, name: u.name, email: u.email ?? "", role: u.role };
    };
    const person = (name: string, email: string, role: string) =>
      inA(() => db.user.create({ data: { name, email, passwordHash: "!", role }, select: { id: true, name: true, email: true, role: true } }));
    const colleagueUser = await person("ZZ Colleague", "zzcolleague@zzhard.invalid", "ADMIN");
    const sellerUser = await person("ZZ Seller", "zzseller@zzhard.invalid", "SALES");
    const colleague = colleagueUser.id;
    const seller = sellerUser.id;

    section("Outside data can't stop a workspace");
    ok("text from anything, never throwing: {toString} and data nested deeper than JSON can write", safeText({ toString: 0 }) === '{"toString":0}' && safeText(JSON.parse("[".repeat(20_000) + "]".repeat(20_000))) === "[data too deeply nested to show]");
    ok("  a comparison with such a value just doesn't hold", compare("eq", { toString: 0 }, "paid") === false && compare("contains", "abc", { toString: 0 }) === false);
    ok("  how deep data nests, counted without recursion", nestsDeeperThan(JSON.parse("[".repeat(65) + "]".repeat(65))) && !nestsDeeperThan(JSON.parse("[".repeat(64) + "]".repeat(64))));
    const hooked = await publish("ZZ on a payment call", { schema: 1, trigger: { type: "webhook", filter: { all: [{ ref: "trigger.body.event", op: "eq", value: "paid" }] } }, steps: [call("paid", "paid")] });
    const hook = await inA(() => actions.workflowWebhook(hooked));
    if (!hook.ok) throw new Error(hook.error);
    const token = hook.data.address.split("/").pop()!;
    const callHook = (t: string, body: string, headers: Record<string, string> = {}, now?: Date) =>
      inA(() => webhooks.receiveWebhook({ token: t, body, contentType: "application/json", headers: new Headers(headers), query: new URLSearchParams(), now }));
    const poison = await callHook(token, JSON.stringify({ event: { toString: 0 } }));
    const alongside = await publish("ZZ alongside", manual([call("along", "alongside")]));
    const alongRun = await inA(() => store.startManualRun(alongside, owner));
    if (!alongRun.ok) throw new Error(alongRun.error);
    await drain();
    ok("a call whose value would have broken a condition is taken, matched, and stops nothing", poison.status === 202 && (await inA(() => db.automationEvent.count({ where: { matchedAt: null } }))) === 0 && (await runOf(alongRun.data.runId)).status === "SUCCEEDED" && callsTo("/api/paid") === 0);
    const deep = await callHook(token, "[".repeat(100) + "]".repeat(100));
    const nul = await callHook(token, JSON.stringify({ name: "a\u0000b" }));
    ok("  a body nested past 64, or holding a NUL, is refused 400 — not a 500 that senders retry", deep.status === 400 && nul.status === 400, [deep.status, nul.status]);

    // Whatever the cause: a malformed wait no rule can read, a step whose record can't be written.
    const someRun = (await inA(() => db.automationRun.findFirstOrThrow({ select: { id: true } }))).id;
    await inA(() => db.automationEventWait.create({ data: { runId: someRun, stepKey: "zz-odd", eventType: "zz.odd", rules: "not a list of rules", expiresAt: new Date(Date.now() + 3_600_000), createdAt: new Date(Date.now() - 60_000) } }));
    await inA(() => db.automationEvent.create({ data: { type: "zz.odd", payload: {} } }));
    const besideOdd = await inA(() => store.startManualRun(alongside, owner));
    if (!besideOdd.ok) throw new Error(besideOdd.error);
    let oddThrew = false;
    await inA(() => engine.workTenant({ budgetMs: 5_000 })).catch(() => {
      oddThrew = true;
    });
    ok("an event that can't be matched, whatever the reason, is passed over — and the turn goes on", !oddThrew && (await inA(() => db.automationEvent.count({ where: { type: "zz.odd", matchedAt: null } }))) === 0 && (await runOf(besideOdd.data.runId)).status === "SUCCEEDED");
    const nulChar = String.fromCharCode(0);
    const unwritable = await publish("ZZ an unwritable step", manual([{ id: "say", type: "action", action: "notify.person", input: { to: "owner", title: "ZZ {{trigger.data.x}}" } }]));
    const unwritableRun = await inA(() => store.startManualRun(unwritable, owner, { x: `a${nulChar}b` }));
    if (!unwritableRun.ok) throw new Error(unwritableRun.error);
    let stepThrewOut = false;
    await inA(() => engine.workTenant({ budgetMs: 5_000 })).catch(() => {
      stepThrewOut = true;
    });
    const held = await runOf(unwritableRun.data.runId);
    ok("  a step that throws (its record can't be written) fails or waits to retry — never left held", !stepThrewOut && held.status !== "RUNNING" && held.lockedBy === null, held);

    section("Answers from outside can't hang or break a run");
    const before = calls.length;
    const hangs = await publish("ZZ compressed and stalled", manual([call("stall", "gzipstall")]));
    const hangRun = await inA(() => store.startManualRun(hangs, owner));
    if (!hangRun.ok) throw new Error(hangRun.error);
    const timedOut = await Promise.race([drain().then(() => "done"), new Promise((resolve) => setTimeout(() => resolve("hung"), 30_000))]);
    const hangAfter = await runOf(hangRun.data.runId);
    ok("a compressed answer that stalls ends at the deadline — the turn doesn't hang", timedOut === "done" && calls.length > before && hangAfter.status !== "RUNNING", { timedOut, hangAfter });
    const deepAnswer = await publish("ZZ nested answer", manual([call("deep", "deep")]));
    const deepRun = await inA(() => store.startManualRun(deepAnswer, owner));
    if (!deepRun.ok) throw new Error(deepRun.error);
    await drain();
    const deepStep = await inA(() => db.automationRunStep.findFirst({ where: { runId: deepRun.data.runId }, select: { status: true, outputSummary: true } }));
    ok("  an answer nested thousands deep is kept as text, and the run goes on", (await runOf(deepRun.data.runId)).status === "SUCCEEDED" && deepStep?.status === "SUCCEEDED");

    section("Webhooks");
    const tellOwner = { id: "n", type: "action", action: "notify.person", input: { to: "owner", title: "ZZ called" } };
    const burstHook = await publish("ZZ burst", { schema: 1, trigger: { type: "webhook" }, steps: [tellOwner] });
    const burst = await inA(() => actions.workflowWebhook(burstHook));
    if (!burst.ok) throw new Error(burst.error);
    const burstToken = burst.data.address.split("/").pop()!;
    const answers = await Promise.all(Array.from({ length: 70 }, (_, i) => callHook(burstToken, JSON.stringify({ i }))));
    ok("seventy calls at once: sixty taken, ten told to wait — the limit holds under a burst", answers.filter((a) => a.status === 202).length === 60 && answers.filter((a) => a.status === 429).length === 10, answers.map((a) => a.status).join(","));
    const signedHook = await publish("ZZ signed", { schema: 1, trigger: { type: "webhook" }, steps: [tellOwner] });
    const signedView = await inA(() => actions.workflowWebhook(signedHook));
    if (!signedView.ok) throw new Error(signedView.error);
    await inA(() => actions.setWorkflowWebhookSigned(signedHook, true));
    const signedToken = signedView.data.address.split("/").pop()!;
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ order: 1 });
    const sig = signature(signedView.data.secret, ts, body);
    const firstSigned = await callHook(signedToken, body, { "x-deskzo-timestamp": ts, "x-deskzo-signature": sig, "idempotency-key": "order-1" });
    const replayed = await callHook(signedToken, body, { "x-deskzo-timestamp": ts, "x-deskzo-signature": sig, "idempotency-key": "order-2" });
    ok("a signed call taken once is refused again, even under another Idempotency-Key", firstSigned.status === 202 && replayed.status === 409, [firstSigned.status, replayed.status]);
    ok("  turning signing on is on the record", (await inA(() => db.auditLog.count({ where: { entityId: signedHook, entityLabel: { contains: "takes only signed calls" } } }))) === 1);
    const busyHook = await publish("ZZ a day's worth", { schema: 1, trigger: { type: "webhook" }, steps: [tellOwner] });
    const busy = await inA(() => actions.workflowWebhook(busyHook));
    if (!busy.ok) throw new Error(busy.error);
    await inA(() => db.automationEvent.createMany({ data: Array.from({ length: webhooks.HOOK_LIMITS.perDay }, (_, i) => ({ type: "webhook", recordType: "webhook", recordId: `${busy.data.id}:zz-${i}`, payload: {}, occurredAt: new Date(Date.now() - 2 * 3_600_000), matchedAt: new Date() })) }));
    const overDay = await callHook(busy.data.address.split("/").pop()!, "{}");
    ok(`a day's ${webhooks.HOOK_LIMITS.perDay.toLocaleString("en-IN")} calls taken: the next is refused until tomorrow`, overDay.status === 429 && String(overDay.body.error).includes("in a day"), overDay);
    const twice = await publish("ZZ two clicks", { schema: 1, trigger: { type: "webhook" }, steps: [tellOwner] });
    await Promise.all([inA(() => webhooks.ensureWebhook(twice)), inA(() => webhooks.ensureWebhook(twice))]);
    ok("making an address twice at once leaves one", (await inA(() => db.automationWebhook.count({ where: { workflowId: twice } }))) === 1);
    ok("the hook addresses are outside the proxy, so no body is held before the route's 256 KB cap", /api\/automate\/hooks/.test(readFileSync("src/proxy.ts", "utf8").match(/matcher: \[[^\]]*\]/)?.[0] ?? ""));
    const viaRoute = (t: string) => route.POST(new NextRequest(`http://zzhard-a.localhost:3000/api/automate/hooks/${t}`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), { params: Promise.resolve({ token: t }) });
    await inA(() => maintenance.takeLock("zz-route"));
    const whileRestoring = await inA(() => viaRoute(burstToken));
    await inA(() => maintenance.releaseLock());
    const routeOk = await inA(() => viaRoute(token));
    ok("  the route holds the workspace itself: 503 while it is restored, taken otherwise", whileRestoring.status === 503 && routeOk.status === 202, [whileRestoring.status, routeOk.status]);

    section("A workflow runs as its owner — only they change it");
    const theirs = await publish("ZZ the owner's", manual([call("o", "owners")]));
    as(colleagueUser);
    const refusedSave = await inA(() => actions.saveWorkflowDraft(theirs, { schema: 1, trigger: { type: "manual" }, steps: [] }));
    const refusedPublish = await inA(() => actions.publishAutomationWorkflow(theirs));
    const refusedTest = await inA(() => actions.testWorkflowDraft(theirs, false));
    const refusedHook = await inA(() => actions.workflowWebhook(theirs));
    const refusedArchive = await inA(() => actions.setAutomationWorkflowStatus(theirs, "ARCHIVED"));
    const versionId = (await inA(() => db.automationVersion.findFirstOrThrow({ where: { workflowId: theirs }, select: { id: true } }))).id;
    const refusedRestore = await inA(() => actions.restoreAutomationVersion(theirs, versionId));
    ok(
      "another admin can't save, publish, test, restore, make its address or archive it",
      [refusedSave, refusedPublish, refusedTest, refusedHook, refusedArchive, refusedRestore].every((r) => !r.ok && r.error.startsWith("Only the workflow's owner")),
      [refusedSave, refusedPublish, refusedTest, refusedHook, refusedArchive, refusedRestore].map((r) => (r.ok ? "ok" : r.error.slice(0, 40))),
    );
    const paused = await inA(() => actions.setAutomationWorkflowStatus(theirs, "PAUSED"));
    const resumed = await inA(() => actions.setAutomationWorkflowStatus(theirs, "ACTIVE"));
    const ranIt = await inA(() => actions.runAutomationWorkflowNow(theirs));
    const copy = await inA(() => actions.duplicateAutomationWorkflow(theirs));
    ok("  but may pause it, switch it on, run it, and duplicate it — the copy theirs", paused.ok && resumed.ok && ranIt.ok && copy.ok && (await inA(() => db.automationWorkflow.count({ where: { ownerUserId: colleague, name: { contains: "ZZ the owner's" } } }))) === 1);
    const hookedSeq = (await inA(() => db.automationWorkflow.findUniqueOrThrow({ where: { id: hooked }, select: { workflowSeq: true } }))).workflowSeq;
    const looked = await inA(() => actions.getWorkflowForBuilder(String(hookedSeq)));
    ok("  the builder is read-only for them, without the address or its secret", looked?.mine === false && looked.webhook?.address === "" && looked.webhook?.secret === "");
    await drain();
    const ranRun = await inA(() => db.automationRun.findFirstOrThrow({ where: { workflowId: theirs, status: "SUCCEEDED" }, select: { runSeq: true } }));
    const seenByColleague = await inA(() => actions.getAutomationRun(String(ranRun.runSeq)));
    ok("  its runs show them steps, statuses and errors — not the owner's data", seenByColleague?.dataShown === false && seenByColleague.steps.every((s) => s.input === null && s.output === null) && seenByColleague.steps.length > 0);
    as(ownerUser);
    const seenByOwner = await inA(() => actions.getAutomationRun(String(ranRun.runSeq)));
    ok("  its owner sees the data", seenByOwner?.dataShown === true && seenByOwner.steps.some((s) => s.input !== null));
    as(colleagueUser);
    const taken = await inA(() => actions.takeOverAutomationWorkflow(theirs));
    const after = await inA(() => db.automationWorkflow.findUniqueOrThrow({ where: { id: theirs }, select: { ownerUserId: true, status: true, activeVersionId: true } }));
    ok("taken over: theirs now, off, its published version let go", taken.ok && after.ownerUserId === colleague && after.status === "DRAFT" && after.activeVersionId === null, after);
    ok("  the owner before is told, and it is on the record", (await inA(() => db.notification.count({ where: { userId: owner, title: { contains: "took over" } } }))) === 1 && (await inA(() => db.auditLog.count({ where: { entityId: theirs, entityLabel: { contains: "taken over" } } }))) === 1);
    const theirPublish = await inA(() => actions.publishAutomationWorkflow(theirs));
    ok("  and they can publish it — as themselves", theirPublish.ok);
    as(ownerUser);
    const colleagueRunSeq = await inA(async () => {
      const started = await store.startManualRun(theirs, colleague);
      if (!started.ok) throw new Error(started.error);
      await engine.workTenant({ budgetMs: 5_000 });
      return (await db.automationRun.findUniqueOrThrow({ where: { id: started.data.runId }, select: { runSeq: true } })).runSeq;
    });
    ok("the super admin sees the data of anyone's runs", (await inA(() => actions.getAutomationRun(String(colleagueRunSeq))))?.dataShown === true);

    section("A trigger tells a workflow only what its owner may see");
    const company = (name: string, ownerUserId: string) =>
      inA(() =>
        db.company.create({
          data: { name, normalizedName: name.toLowerCase(), createdById: owner, ownerUserId, locations: { create: { label: "Head Office", isPrimary: true, isBilling: true, isShipping: true } } },
          select: { id: true },
        }),
      );
    const theirCompany = await company("ZZ Their Co", colleague);
    const ownCompany = await company("ZZ Own Co", seller);
    const lead = (companyId: string, title: string, ownerUserId: string) => inA(() => db.lead.create({ data: { companyId, title, ownerUserId, createdByUserId: owner, source: "OTHER" }, select: { id: true } }).then((l) => l.id));
    const theirLead = await lead(theirCompany.id, "ZZ their lead", colleague);
    const ownLead = await lead(ownCompany.id, "ZZ own lead", seller);
    ok("(a seller sees their own leads, not a colleague's)", !(await inA(() => mayAccess(seller, "leads", "view", theirLead))) && (await inA(() => mayAccess(seller, "leads", "view", ownLead))));
    const sellerFlow = await inA(async () => {
      const w = await store.createWorkflow({ name: "ZZ the seller's", ownerUserId: seller, createdById: seller, draft: { schema: 1, trigger: { type: "lead.created" }, steps: [{ id: "n", type: "action", action: "notify.person", input: { to: "owner", title: "ZZ new lead {{trigger.lead.title}}" } }] } as unknown as Definition });
      const published = await store.publishWorkflow(w.id, seller);
      if (!published.ok) throw new Error(published.error);
      return w.id;
    });
    await inA(() =>
      db.$transaction(async (tx) => {
        await emitLeadCreated(tx, theirLead, colleague, "person");
        await emitLeadCreated(tx, ownLead, seller, "person");
      }),
    );
    await drain();
    const sellerRuns = await inA(() => db.automationRun.findMany({ where: { workflowId: sellerFlow }, select: { recordKey: true } }));
    ok("a lead its owner can't see starts nothing; their own does", sellerRuns.length === 1 && sellerRuns[0]!.recordKey === `lead:${ownLead}`, sellerRuns);

    section("What leaves in a file, what run history shows, how long things are kept");
    const withKeys = await publish("ZZ with keys", manual([{ id: "k", type: "action", action: "http.request", input: { url: "https://api.zzhard.test/api/x?token=abc123", method: "POST", headers: { Authorization: "Bearer sk_live_zz" } } }]));
    const file = await inA(() => actions.exportAutomationWorkflow(withKeys));
    ok("an exported file leaves out the address and the headers' values", file.ok && !file.data.text.includes("abc123") && !file.data.text.includes("sk_live_zz") && file.data.text.includes('"Authorization": ""') && file.data.cleared.some((c) => c.includes("address")), file.ok ? file.data.cleared : file);
    ok(
      "run history masks secret query values, hook addresses and secret-named fields",
      maskStepText("GET https://x.test/a?token=abc&page=2&sig=zz") === "GET https://x.test/a?token=•••&page=2&sig=•••" &&
        maskStepText("https://hooks.slack.com/services/T0/B0/XYZ").endsWith("services/•••") &&
        JSON.stringify(summarize({ key: "k1", cookie: "c", signature: "s", page: 1 })) === '{"key":"••••","cookie":"••••","signature":"••••","page":1}',
    );
    const DAY = 86_400_000;
    await inA(() => setWorkspacePaused(true, owner));
    await inA(() =>
      db.automationEvent.createMany({
        data: [
          { type: "lead.created", recordType: "lead", recordId: "zz-old", payload: {}, occurredAt: new Date(Date.now() - 31 * DAY) },
          { type: "webhook", recordType: "webhook", recordId: "zz-hook:old", payload: {}, occurredAt: new Date(Date.now() - 8 * DAY), matchedAt: new Date() },
          { type: "webhook", recordType: "webhook", recordId: "zz-hook:recent", payload: {}, occurredAt: new Date(Date.now() - 2 * DAY), matchedAt: new Date() },
        ],
      }),
    );
    const pausedTurn = await inA(() => engine.workTenant({ budgetMs: 2_000 }));
    const left = await inA(() => db.automationEvent.findMany({ where: { recordId: { in: ["zz-old", "zz-hook:old", "zz-hook:recent"] } }, select: { recordId: true } }));
    ok("paused, still tidied: an event a month old goes, acted on or not; a webhook's call a week old", pausedTurn.skipped === "paused" && left.length === 1 && left[0]!.recordId === "zz-hook:recent", left);
    await inA(() => setWorkspacePaused(false, owner));
    const oldRun = await inA(() => db.automationRun.create({ data: { workflowId: alongside, idempotencyKey: "zz-approval-old", status: "SUCCEEDED", finishedAt: new Date(Date.now() - 40 * DAY), cursor: {}, contextCipher: "x" }, select: { id: true } }));
    await inA(() => db.approvalRequest.create({ data: { workflowId: alongside, runId: oldRun.id, stepKey: "ask", title: "ZZ old approval", approverIds: [owner], expiresAt: new Date(), onTimeout: "rejected" } }));
    await inA(() => db.dailyJobRun.deleteMany({ where: { job: "automate-history" } }));
    await runAsTenant({ ...A, entitlements: { ...A.entitlements, automation: { ...NO_LIMITS, historyDays: 30 } } }, () => engine.workTenant({ budgetMs: 2_000 }));
    ok("an old run's approval request goes with it", (await inA(() => db.automationRun.count({ where: { id: oldRun.id } }))) === 0 && (await inA(() => db.approvalRequest.count({ where: { title: "ZZ old approval" } }))) === 0);
  } finally {
    (require("../src/lib/automate/outbound") as typeof import("../src/lib/automate/outbound")).setTestOutbound(null); // eslint-disable-line @typescript-eslint/no-require-imports
    if (close) await close().catch(() => undefined);
    server.close();
    for (const name of Object.values(names)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch((err) => console.error(`could not drop ${name}`, err));
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM pg_database WHERE datname IN (${Object.values(names).map((n) => `'${n}'`).join(", ")})`);
    ok("every scratch database dropped", Number(left[0]!.n) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} Automate hardening checks passed.\n` : `\n${failures} check(s) failed (${passes} passed).\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
