/**
 * check:automate — Deskzo Automate, Phase 1: the core engine (plan of 17 Oct 2026; src/lib/automate).
 *
 * Builds scratch databases beside the real one — workspaces A and B from the migrations, C empty (a
 * workspace not migrated yet) — and a scratch control plane for the wake list and the platform's
 * switch. Registers the workspaces the way the static registry reads them (TENANT_DB_<SLUG>), runs
 * everything through the real code, and drops every scratch database at the end, pass or fail. The
 * real workspace is never written to.
 *
 *   · the pure parts: definitions and what publishing refuses, references, conditions, the cursor,
 *     schedules across a daylight-saving change, transforms, redaction;
 *   · a workspace without the tables: the worker skips it and a business write that records an event
 *     still commits;
 *   · publishing, schedules firing once (and once after a gap), manual runs, delays;
 *   · a worker that dies after an action but before saving: the run resumes with exactly one task;
 *   · the same event twice makes one run, and one record makes one run a minute;
 *   · workflows feeding workflows stop three deep, and never set themselves off;
 *   · twenty failures pause a workflow and tell its owner; an owner who leaves pauses it;
 *   · a network-type failure is tried again later; retry from the failed step keeps what went before;
 *   · cancelling, test runs, run history redaction, immutable versions;
 *   · the workspace's and the platform's kill switches;
 *   · two workspaces: the wake list and the worker touch only the one due, and nothing crosses.
 *
 *   npm run check:automate
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { directClient } from "../src/lib/tenancy/direct-client";
import { definitionSchema, type Definition } from "../src/lib/automate/definition";
import { readPath, resolveValue } from "../src/lib/automate/references";
import { filterHolds } from "../src/lib/automate/conditions";
import { advance, currentStep, enterBranch, startCursor } from "../src/lib/automate/cursor";
import { delayUntil, nextFire } from "../src/lib/automate/schedule";
import { applyTransform } from "../src/lib/automate/transform";
import { summarize } from "../src/lib/automate/redact";
import { parseRunRef, runRef } from "../src/lib/automate/refs";
import { clockFor } from "../src/lib/time/zone";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
delete process.env.TRUST_PROXY;

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const def = (d: unknown) => definitionSchema.parse(d) as Definition;

async function main() {
  // ─── The pure parts ─────────────────────────────────────────────────────────────────────────
  section("References, conditions and transforms");
  const ctx = { trigger: { task: { id: "t1", title: "Call Acme", n: "5", tags: ["vip", "north"] } }, steps: { make: { output: { taskId: "t9", when: "2026-10-20" } } } };
  ok("a reference that is the whole string keeps its type", resolveValue("{{trigger.task.tags}}", ctx) === ctx.trigger.task.tags);
  ok("  one inside text is written in", resolveValue("Re: {{ trigger.task.title }} ({{steps.make.output.taskId}})", ctx) === "Re: Call Acme (t9)");
  ok("  nothing found writes nothing", resolveValue("[{{trigger.task.missing}}]", ctx) === "[]");
  ok("  and __proto__ is never read", readPath(ctx, "trigger.__proto__") === undefined && readPath(ctx, "steps.make.constructor") === undefined);
  ok("  a step reference must go through .output", readPath(ctx, "steps.make.taskId") === undefined);
  const holds = (rules: unknown) => filterHolds(rules as never, ctx);
  ok("eq is forgiving: \"5\" equals 5, and text ignores case", holds({ all: [{ ref: "trigger.task.n", op: "eq", value: 5 }, { ref: "trigger.task.title", op: "eq", value: "call acme" }] }));
  ok("  gt compares numbers, lte dates", holds({ all: [{ ref: "trigger.task.n", op: "gt", value: 4 }, { ref: "steps.make.output.when", op: "lte", value: "2026-10-21" }] }));
  ok("  in, contains, isEmpty", holds({ all: [{ ref: "trigger.task.tags", op: "contains", value: "VIP" }, { ref: "trigger.task.title", op: "in", value: ["x", "Call Acme"] }, { ref: "trigger.task.missing", op: "isEmpty" }] }));
  ok("  any needs one; all needs every", holds({ any: [{ ref: "trigger.task.n", op: "eq", value: 9 }, { ref: "trigger.task.n", op: "eq", value: 5 }] }) && !holds({ all: [{ ref: "trigger.task.n", op: "eq", value: 9 }, { ref: "trigger.task.n", op: "eq", value: 5 }] }));
  const india = clockFor("Asia/Kolkata");
  ok("transforms: text, numbers, dates, defaults", applyTransform({ fn: "text.upper", args: ["{{trigger.task.title}}"] }, ctx, india) === "CALL ACME" && applyTransform({ fn: "number.add", args: ["{{trigger.task.n}}", 2] }, ctx, india) === 7 && applyTransform({ fn: "value.default", args: ["{{trigger.task.missing}}", "none"] }, ctx, india) === "none" && applyTransform({ fn: "date.day", args: ["2026-10-19T20:00:00Z"] }, ctx, india) === "2026-10-20");

  section("The cursor through branches");
  const branchy = def({
    schema: 1,
    trigger: { type: "manual" },
    steps: [
      { id: "a", type: "transform", set: {} },
      { id: "b", type: "branch", paths: [{ name: "big", if: { all: [] }, steps: [{ id: "b1", type: "transform", set: {} }, { id: "b2", type: "transform", set: {} }] }], else: [{ id: "e1", type: "transform", set: {} }] },
      { id: "c", type: "stop", outcome: "succeeded" },
    ],
  });
  let cursor = startCursor();
  const at = () => currentStep(branchy, cursor);
  ok("starts at the first step", at().step?.id === "a");
  cursor = advance(cursor);
  ok("  then the branch", at().step?.id === "b");
  cursor = enterBranch(at().cursor, "b", 0);
  ok("  into its path", at().step?.id === "b1");
  cursor = advance(cursor);
  cursor = advance(at().cursor);
  const out = at();
  ok("  and out of it, to the step after the branch", out.step?.id === "c" && out.cursor.frames.length === 1, JSON.stringify(out.cursor));
  cursor = enterBranch({ frames: [{ index: 1 }] }, "b", -1);
  ok("  else is path -1", at().step?.id === "e1");
  ok("  past the end is nothing left", currentStep(branchy, { frames: [{ index: 3 }] }).step === null);

  section("Schedules on the workspace's clock, across a clock change");
  const london = clockFor("Europe/London");
  const daily9 = { every: "day" as const, at: "09:00" };
  const before = nextFire(daily9, london, new Date("2026-10-23T09:30:00Z"));
  const across = nextFire(daily9, london, before);
  ok("every day at 09:00 in London: 08:00 UTC in summer time", before.toISOString() === "2026-10-24T08:00:00.000Z", before.toISOString());
  ok("  and 09:00 UTC the day the clocks go back", across.toISOString() === "2026-10-25T09:00:00.000Z", across.toISOString());
  const skipped = nextFire({ every: "day", at: "01:30" }, london, new Date("2027-03-27T12:00:00Z"));
  ok("a time the spring change skips moves forward by the gap", skipped.toISOString() === "2027-03-28T01:30:00.000Z", skipped.toISOString());
  ok("every week on a Monday", nextFire({ every: "week", weekday: 1, at: "10:00" }, india, new Date("2026-10-17T00:00:00Z")).toISOString() === "2026-10-19T04:30:00.000Z");
  ok("every month on the 5th", nextFire({ every: "month", dayOfMonth: 5, at: "09:00" }, india, new Date("2026-10-17T00:00:00Z")).toISOString() === "2026-11-05T03:30:00.000Z");
  // 17 Oct 2026 is a Saturday: the next weekday hour is Monday 00:15 in India.
  const hourly = nextFire({ every: "hour", minute: 15, days: [1, 2, 3, 4, 5] }, india, new Date("2026-10-17T10:00:00Z"));
  ok("every hour at :15, weekdays only", hourly.toISOString() === "2026-10-18T18:45:00.000Z", hourly.toISOString());
  ok("a delay for two hours, and one until 09:00 next", delayUntil({ id: "d", type: "delay", for: { hours: 2 } }, india, new Date("2026-10-17T10:00:00Z")).toISOString() === "2026-10-17T12:00:00.000Z" && delayUntil({ id: "d", type: "delay", until: { at: "09:00" } }, india, new Date("2026-10-17T10:00:00Z")).toISOString() === "2026-10-18T03:30:00.000Z");

  section("Redaction and run references");
  const shown = summarize({ password: "hunter2", note: "login with password=hunter2 please", long: "x".repeat(400), list: Array.from({ length: 14 }, (_, i) => i) }) as Record<string, unknown>;
  ok("a secret-named field shows as ••••", shown.password === "••••");
  ok("  credentials inside text are masked", !String(shown.note).includes("hunter2"), String(shown.note));
  ok("  long text is cut, long lists folded", String(shown.long).length <= 161 && (shown.list as unknown[]).length === 11);
  ok("RUN-000123 and 123 both name run 123", runRef(123) === "RUN-000123" && parseRunRef("RUN-000123") === 123 && parseRunRef("123") === 123 && parseRunRef("RUN-x") === null);

  // ─── Scratch databases ──────────────────────────────────────────────────────────────────────
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const real = new URL(url).pathname.slice(1);
  section("Scratch workspaces and control plane");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so scratch databases may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const names = { a: `${real}_automate_a`, b: `${real}_automate_b`, c: `${real}_automate_c`, control: `${real}_automate_ctl` };
  const admin = directClient(withDatabase(url, "postgres"));
  let close: (() => Promise<void>) | null = null;
  try {
    for (const name of Object.values(names)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    const started = Date.now();
    await admin.$executeRawUnsafe(`CREATE DATABASE "${names.a}"`);
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, names.a) }, timeout: 10 * 60_000 });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${names.b}" TEMPLATE "${names.a}"`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${names.c}"`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${names.control}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: withDatabase(url, names.control) }, timeout: 5 * 60_000 });
    ok("A and B built from the migrations, C empty, a control plane beside them", true, `${Math.round((Date.now() - started) / 1000)} s`);

    process.env.TENANT_DB_ZZAUTO_A = withDatabase(url, names.a);
    process.env.TENANT_DB_ZZAUTO_B = withDatabase(url, names.b);
    process.env.TENANT_DB_ZZAUTO_C = withDatabase(url, names.c);
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
    const { tenantAfter } = require("../src/lib/tenancy/after") as typeof import("../src/lib/tenancy/after");
    const engine = require("../src/lib/automate/engine") as typeof import("../src/lib/automate/engine");
    const store = require("../src/lib/automate/store") as typeof import("../src/lib/automate/store");
    const switches = require("../src/lib/automate/switches") as typeof import("../src/lib/automate/switches");
    const wake = require("../src/lib/automate/wake") as typeof import("../src/lib/automate/wake");
    const worker = require("../src/lib/automate/worker") as typeof import("../src/lib/automate/worker");
    const { emitEvent } = require("../src/lib/automate/events") as typeof import("../src/lib/automate/events");
    const { validateDefinition } = require("../src/lib/automate/validate") as typeof import("../src/lib/automate/validate");
    const { actionByKey } = require("../src/lib/automate/registry") as typeof import("../src/lib/automate/registry");

    const A = (await registry.tenantBySlug("zzauto-a"))!;
    const B = (await registry.tenantBySlug("zzauto-b"))!;
    const C = (await registry.tenantBySlug("zzauto-c"))!;
    ok("the registry knows all three", !!A && !!B && !!C, [A?.id, B?.id, C?.id].join(", "));

    // ─── Publishing refuses what can't run ────────────────────────────────────────────────────
    section("What publishing refuses");
    const problems = (d: unknown) => {
      const v = validateDefinition(d);
      return v.ok ? [] : v.problems.map((p) => p.message);
    };
    const good = { schema: 1, trigger: { type: "task.created", filter: { all: [{ ref: "trigger.task.title", op: "contains", value: "x" }] } }, steps: [{ id: "make", type: "action", action: "task.create", input: { title: "Follow up: {{trigger.task.title}}" } }, { id: "tell", type: "action", action: "notify.person", input: { title: "Made {{steps.make.output.taskId}}" } }] };
    ok("a good definition passes", problems(good).length === 0, problems(good).join("; "));
    ok("an unknown action", problems({ ...good, steps: [{ id: "x", type: "action", action: "lead.delete", input: {} }] }).some((m) => m.includes("isn't an action")));
    ok("a reference to a later step", problems({ ...good, steps: [{ id: "tell", type: "action", action: "notify.person", input: { title: "{{steps.make.output.taskId}}" } }, good.steps[0]] }).some((m) => m.includes("hasn't run")));
    ok("a reference into a branch from after it", problems({ schema: 1, trigger: { type: "manual" }, steps: [{ id: "b", type: "branch", paths: [{ name: "p", if: { all: [] }, steps: [{ id: "in", type: "transform", set: {} }] }] }, { id: "after", type: "action", action: "notify.person", input: { title: "{{steps.in.output.x}}" } }] }).some((m) => m.includes("hasn't run")));
    ok("a trigger field the trigger doesn't have", problems({ ...good, steps: [{ id: "t", type: "action", action: "notify.person", input: { title: "{{trigger.lead.title}}" } }] }).some((m) => m.includes('no field "lead"')));
    ok("input the action refuses — but not a field holding a reference", problems({ ...good, steps: [{ id: "t", type: "action", action: "task.create", input: { title: "", dueInDays: 999 } }] }).length === 2 && problems({ ...good, steps: [{ id: "t", type: "action", action: "task.create", input: { title: "x", dueInDays: "{{trigger.task.title}}" } }] }).length === 0);
    const many = Array.from({ length: 51 }, (_, i) => ({ id: `s${i}`, type: "transform", set: {} }));
    ok("more than 50 steps", problems({ schema: 1, trigger: { type: "manual" }, steps: many }).some((m) => m.includes("at most 50")));
    const deep = (n: number): unknown => (n === 0 ? { id: "leaf", type: "transform", set: {} } : { id: `b${n}`, type: "branch", paths: [{ name: "p", if: { all: [] }, steps: [deep(n - 1)] }] });
    ok("branches four deep", problems({ schema: 1, trigger: { type: "manual" }, steps: [deep(4)] }).some((m) => m.includes("3 deep")));
    ok("six paths in a branch", problems({ schema: 1, trigger: { type: "manual" }, steps: [{ id: "b", type: "branch", paths: Array.from({ length: 5 }, (_, i) => ({ name: `p${i}`, if: { all: [] }, steps: [] })), else: [] }] }).some((m) => m.includes("at most 5 paths")));
    ok("a delay over 90 days, and two steps with one id", problems({ schema: 1, trigger: { type: "manual" }, steps: [{ id: "d", type: "delay", for: { days: 91 } }, { id: "d", type: "stop", outcome: "succeeded" }] }).length === 2);
    ok("a schedule without its timing; code is not a field at all", problems({ schema: 1, trigger: { type: "schedule" }, steps: [{ id: "s", type: "stop", outcome: "succeeded" }] }).some((m) => m.includes("timing")) && problems({ ...good, steps: [{ id: "s", type: "action", action: "notify.person", input: { title: "x" }, code: "process.exit()" }] }).length > 0);

    // ─── A workspace not migrated yet ─────────────────────────────────────────────────────────
    section("A workspace without the tables yet");
    const skippedC = await runAsTenant(C, () => engine.workTenant());
    ok("the worker skips it", skippedC.skipped === "not-migrated");
    await runAsTenant(C, async () => {
      await db.$executeRawUnsafe(`CREATE TABLE "zz_probe" ("id" text PRIMARY KEY)`);
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`INSERT INTO "zz_probe" ("id") VALUES ('kept')`);
        await emitEvent(tx, { type: "task.created", payload: {} });
        await tx.$executeRawUnsafe(`INSERT INTO "zz_probe" ("id") VALUES ('after')`);
      });
    });
    const probe = await runAsTenant(C, () => db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM "zz_probe"`));
    ok("  and a change that records an event there still commits, whole", Number(probe[0]!.n) === 2);

    // ─── Fixtures in A ──────────────────────────────────────────────────────────────────────────
    const person = (t: typeof A, email: string, role: string, active = true) =>
      runAsTenant(t, () => db.user.create({ data: { name: email.split("@")[0]!, email, passwordHash: "!", role, active }, select: { id: true } }).then((u) => u.id));
    const owner = await person(A, "zzowner@zzauto.invalid", "ADMIN");
    const colleague = await person(A, "zzcolleague@zzauto.invalid", "SALES");
    const leaver = await person(A, "zzleaver@zzauto.invalid", "SALES", false);
    const publish = (t: typeof A, ownerId: string, name: string, d: unknown) =>
      runAsTenant(t, async () => {
        const w = await store.createWorkflow({ name, ownerUserId: ownerId, createdById: ownerId, draft: d as Definition });
        const p = await store.publishWorkflow(w.id, ownerId);
        if (!p.ok) throw new Error(`${name}: ${p.error} ${JSON.stringify(p.problems ?? [])}`);
        return w.id;
      });
    const drain = (t: typeof A) =>
      runAsTenant(t, async () => {
        let turns = 0;
        for (let i = 0; i < 40; i++) {
          const w = await engine.workTenant({ budgetMs: 15_000 });
          turns += w.turns;
          const due = (await db.automationRun.count({ where: { status: "QUEUED", runAfter: { lte: new Date() } } })) + (await db.automationEvent.count({ where: { matchedAt: null } }));
          if (!due) break;
        }
        return turns;
      });
    const inA = <T,>(work: () => Promise<T>) => runAsTenant(A, work);
    const tasksTitled = (t: typeof A, title: string) => runAsTenant(t, () => db.task.count({ where: { title } }));
    const manual = (steps: unknown[]) => ({ schema: 1, trigger: { type: "manual" }, steps });

    // ─── Manual runs, steps, delays ─────────────────────────────────────────────────────────────
    section("Publishing and running");
    const hello = await publish(A, owner, "ZZ hello", manual([
      { id: "make", type: "action", action: "task.create", input: { title: "ZZHELLO", assignTo: colleague, dueInDays: 2 } },
      { id: "check", type: "condition", if: { all: [{ ref: "steps.make.output.taskId", op: "isNotEmpty" }] } },
      { id: "tell", type: "action", action: "notify.person", input: { title: "Made {{steps.make.output.taskId}}" } },
    ]));
    const helloVersion = await inA(() => db.automationVersion.findFirst({ where: { workflowId: hello }, select: { id: true, number: true } }));
    ok("publishing makes version 1 and switches it on", helloVersion?.number === 1 && (await inA(() => db.automationWorkflow.findUnique({ where: { id: hello }, select: { status: true } })))?.status === "ACTIVE");
    const first = await inA(() => store.startManualRun(hello, owner));
    await drain(A);
    const firstRun = first.ok ? await inA(() => db.automationRun.findUnique({ where: { id: first.data.runId }, select: { status: true, stepsUsed: true, error: true } })) : null;
    ok("a manual run goes through every step", firstRun?.status === "SUCCEEDED" && firstRun.stepsUsed === 2, `${firstRun?.status} ${firstRun?.error ?? ""}`);
    const made = await inA(() => db.task.findFirst({ where: { title: "ZZHELLO" }, select: { assignedToUserId: true, createdByUserId: true, dueDate: true } }));
    ok("  the task is the owner's, for the colleague, due in two days", made?.createdByUserId === owner && made?.assignedToUserId === colleague && !!made?.dueDate && made.dueDate.toISOString().endsWith("T00:00:00.000Z"));
    const told = await inA(() => db.notification.findFirst({ where: { userId: owner, type: "WORKFLOW_MESSAGE" }, select: { title: true } }));
    ok("  the owner is told, with the task's id written in", !!told && told.title.startsWith("Made ") && told.title.length > 6, told?.title);
    ok("  the colleague is told the task is theirs", (await inA(() => db.notification.count({ where: { userId: colleague, type: "TASK_ASSIGNED" } }))) === 1);
    let immutable = false;
    try {
      await inA(() => db.automationVersion.update({ where: { id: helloVersion!.id }, data: { note: "changed" } }));
    } catch {
      immutable = true;
    }
    ok("a published version can't be changed", immutable);

    const waits = await publish(A, owner, "ZZ waits", manual([{ id: "wait", type: "delay", for: { hours: 1 } }, { id: "tell", type: "action", action: "notify.person", input: { title: "ZZ waited" } }]));
    const waiting = await inA(() => store.startManualRun(waits, owner));
    await drain(A);
    const waitRow = waiting.ok ? await inA(() => db.automationRun.findUnique({ where: { id: waiting.data.runId }, select: { status: true, runAfter: true } })) : null;
    ok("a delay puts the run to wait, an hour on", waitRow?.status === "WAITING" && Math.abs(waitRow.runAfter.getTime() - Date.now() - 3_600_000) < 60_000);
    const cancelled = waiting.ok ? await inA(() => store.cancelRun(waiting.data.runId)) : null;
    ok("  and cancelling a waiting run ends it at once", cancelled?.ok === true && (await inA(() => db.automationRun.findUnique({ where: { id: waiting.ok ? waiting.data.runId : "" }, select: { status: true } })))?.status === "CANCELLED");

    const held = await inA(() => store.startManualRun(waits, owner));
    if (held.ok) {
      await inA(() => engine.claimRuns());
      await inA(() => store.cancelRun(held.data.runId));
      const ended = await inA(() => engine.advanceRun(held.data.runId, india));
      ok("a run a worker holds is cancelled at its next step", ended === "CANCELLED");
    }

    // ─── Schedules ──────────────────────────────────────────────────────────────────────────────
    section("Schedules fire once, and once after a gap");
    const daily = await publish(A, owner, "ZZ daily", { schema: 1, trigger: { type: "schedule", schedule: { every: "day", at: "09:00" } }, steps: [{ id: "tell", type: "action", action: "notify.person", input: { title: "ZZ morning" } }] });
    const trigger = await inA(() => db.automationTrigger.findUnique({ where: { workflowId: daily }, select: { nextFireAt: true } }));
    const expected = nextFire({ every: "day", at: "09:00" }, india, new Date());
    ok("publishing sets the next 09:00 on the workspace's clock", trigger?.nextFireAt?.getTime() === expected.getTime(), trigger?.nextFireAt?.toISOString());
    await inA(() => db.automationTrigger.update({ where: { workflowId: daily }, data: { nextFireAt: new Date(Date.now() - 3 * 86_400_000) } }));
    const firedOnce = await inA(() => engine.fireSchedules(india));
    const firedAgain = await inA(() => engine.fireSchedules(india));
    const after = await inA(() => db.automationTrigger.findUnique({ where: { workflowId: daily }, select: { nextFireAt: true } }));
    ok("three days missed fire one run, not three", firedOnce === 1 && firedAgain === 0, `${firedOnce} then ${firedAgain}`);
    ok("  and the next one is in the future", !!after?.nextFireAt && after.nextFireAt.getTime() > Date.now());
    await drain(A);
    ok("  which runs", (await inA(() => db.automationRun.count({ where: { workflowId: daily, status: "SUCCEEDED" } }))) === 1);

    // ─── A worker that dies after the action ────────────────────────────────────────────────────
    section("A worker that dies after an action, before saving");
    const crash = await publish(A, owner, "ZZ crash", manual([{ id: "make", type: "action", action: "task.create", input: { title: "ZZCRASH" } }]));
    const crashRun = await inA(() => store.startManualRun(crash, owner));
    if (crashRun.ok) {
      const runId = crashRun.data.runId;
      await inA(() => engine.claimRuns());
      // The first worker took the action — and died before it could save the step.
      await inA(() => actionByKey("task.create")!.run({ actorId: owner, workflowId: crash, workflowName: "ZZ crash", runId, stepId: "make", key: `${runId}:make`, depth: 0, clock: india }, { title: "ZZCRASH", assignTo: "owner" }));
      await inA(() => db.automationRun.update({ where: { id: runId }, data: { lockedBy: "dead-worker:1", lockedUntil: new Date(Date.now() - 1_000) } }));
      await drain(A);
      const crashed = await inA(() => db.automationRun.findUnique({ where: { id: runId }, select: { status: true } }));
      ok("another worker takes the run over and finishes it", crashed?.status === "SUCCEEDED", crashed?.status);
      ok("  with exactly one task made", (await tasksTitled(A, "ZZCRASH")) === 1, await tasksTitled(A, "ZZCRASH"));
    }

    // ─── Events ─────────────────────────────────────────────────────────────────────────────────
    section("Events: once each, once a minute per record");
    const dup = await publish(A, owner, "ZZ dup", { schema: 1, trigger: { type: "task.created", filter: { all: [{ ref: "trigger.task.title", op: "contains", value: "ZZDUP" }] } }, steps: [{ id: "tell", type: "action", action: "notify.person", input: { title: "ZZ dup seen" } }] });
    const emit = (recordId: string, title: string, extra: { causedByRunId?: string; depth?: number } = {}) =>
      inA(() => db.$transaction((tx) => emitEvent(tx, { type: "task.created", recordType: "task", recordId, payload: { task: { id: recordId, title } }, ...extra })));
    await emit("dup-1", "ZZDUP one");
    await inA(() => engine.matchEvents());
    await inA(() => db.automationEvent.updateMany({ data: { matchedAt: null } }));
    await inA(() => engine.matchEvents());
    ok("the same event matched twice makes one run", (await inA(() => db.automationRun.count({ where: { workflowId: dup } }))) === 1);
    await emit("dup-1", "ZZDUP again");
    await emit("dup-2", "ZZDUP other");
    await inA(() => engine.matchEvents());
    ok("  the same record within a minute makes none; another record makes one", (await inA(() => db.automationRun.count({ where: { workflowId: dup } }))) === 2);
    await emit("dup-3", "something else");
    await inA(() => engine.matchEvents());
    ok("  an event the trigger's filter rules out makes none", (await inA(() => db.automationRun.count({ where: { workflowId: dup } }))) === 2);
    await inA(() => db.automationWorkflow.update({ where: { id: dup }, data: { status: "PAUSED" } }));
    await drain(A);

    // ─── Workflows feeding workflows ────────────────────────────────────────────────────────────
    section("Workflows feeding workflows");
    const chain = (n: string) => ({ schema: 1, trigger: { type: "task.created", filter: { all: [{ ref: "trigger.task.title", op: "contains", value: "ZZCHAIN" }] } }, steps: [{ id: "make", type: "action", action: "task.create", input: { title: `ZZCHAIN from ${n}` } }] });
    const w1 = await publish(A, owner, "ZZ chain 1", chain("1"));
    const w2 = await publish(A, owner, "ZZ chain 2", chain("2"));
    await emit("seed-1", "ZZCHAIN seed");
    await drain(A);
    const chainRuns = await inA(() => db.automationRun.findMany({ where: { workflowId: { in: [w1, w2] } }, select: { depth: true, workflowId: true, status: true } }));
    const deepest = Math.max(...chainRuns.map((r) => r.depth));
    ok("each workflow sets the other off, three deep, then it stops", chainRuns.length === 6 && deepest === 2 && chainRuns.every((r) => r.status === "SUCCEEDED"), `${chainRuns.length} runs, deepest ${deepest}`);
    const unanswered = await inA(() => db.automationEvent.count({ where: { type: "task.created", depth: 3 } }));
    ok("  the events three deep start nothing", unanswered === 2, `${unanswered}`);
    const self = await inA(() => db.automationRun.findMany({ where: { workflowId: w1 }, select: { eventId: true } }));
    const selfFed = await inA(async () => {
      const events = await db.automationEvent.findMany({ where: { id: { in: self.map((r) => r.eventId).filter((e): e is string => !!e) } }, select: { causedByRunId: true } });
      const causes = await db.automationRun.findMany({ where: { id: { in: events.map((e) => e.causedByRunId).filter((c): c is string => !!c) } }, select: { workflowId: true } });
      return causes.some((c) => c.workflowId === w1);
    });
    ok("  and no workflow ever sets itself off", !selfFed);
    await inA(() => db.automationWorkflow.updateMany({ where: { id: { in: [w1, w2] } }, data: { status: "PAUSED" } }));

    // ─── Failures ───────────────────────────────────────────────────────────────────────────────
    section("Failures: retried, paused, resumed from the step");
    const flaky = await publish(A, owner, "ZZ flaky", manual([{ id: "tell", type: "action", action: "notify.person", input: { title: "ZZ flaky" } }]));
    const notify = actionByKey("notify.person")!;
    const realRun = notify.run;
    notify.run = async () => {
      throw new Error("socket hang up");
    };
    const flakyRun = await inA(() => store.startManualRun(flaky, owner));
    await drain(A);
    notify.run = realRun;
    if (flakyRun.ok) {
      const row = await inA(() => db.automationRun.findUnique({ where: { id: flakyRun.data.runId }, select: { status: true, attempts: true, runAfter: true } }));
      const stepRow = await inA(() => db.automationRunStep.findFirst({ where: { runId: flakyRun.data.runId }, select: { errorKind: true, retryAt: true } }));
      ok("a network-type failure is tried again in a minute", row?.status === "QUEUED" && row.attempts === 1 && Math.abs(row.runAfter.getTime() - Date.now() - 60_000) < 15_000 && stepRow?.errorKind === "TRANSIENT", `${row?.status} ${row?.attempts}`);
      await inA(() => db.automationRun.update({ where: { id: flakyRun.data.runId }, data: { runAfter: new Date() } }));
      await drain(A);
      const tries = await inA(() => db.automationRunStep.findMany({ where: { runId: flakyRun.data.runId }, orderBy: { startedAt: "asc" }, select: { attempt: true, status: true } }));
      ok("  and succeeds on the second try, both tries recorded", tries.map((t) => `${t.attempt}:${t.status}`).join(",") === "1:FAILED,2:SUCCEEDED", tries.map((t) => `${t.attempt}:${t.status}`).join(","));
    }

    const retry = await publish(A, owner, "ZZ retry", manual([
      { id: "make", type: "action", action: "task.create", input: { title: "ZZRETRY" } },
      { id: "tell", type: "action", action: "notify.person", input: { to: leaver, title: "ZZ for the leaver" } },
    ]));
    const retryRun = await inA(() => store.startManualRun(retry, owner));
    await drain(A);
    if (retryRun.ok) {
      const failed = await inA(() => db.automationRun.findUnique({ where: { id: retryRun.data.runId }, select: { status: true, error: true } }));
      ok("a step that can't succeed fails the run at once", failed?.status === "FAILED" && !!failed.error?.includes("isn't an active user"), failed?.error);
      await inA(() => db.user.update({ where: { id: leaver }, data: { active: true } }));
      const retried = await inA(() => store.retryRun(retryRun.data.runId));
      await drain(A);
      const done = await inA(() => db.automationRun.findUnique({ where: { id: retryRun.data.runId }, select: { status: true } }));
      ok("  retried once the cause is fixed, it finishes", retried.ok && done?.status === "SUCCEEDED", done?.status);
      ok("  from the failed step: the task before it is not made again", (await tasksTitled(A, "ZZRETRY")) === 1);
      await inA(() => db.user.update({ where: { id: leaver }, data: { active: false } }));
    }

    const doomed = await publish(A, owner, "ZZ doomed", manual([{ id: "tell", type: "action", action: "notify.person", input: { to: leaver, title: "never" } }]));
    for (let i = 0; i < 20; i++) await inA(() => store.startManualRun(doomed, owner));
    await drain(A);
    const doomedRow = await inA(() => db.automationWorkflow.findUnique({ where: { id: doomed }, select: { status: true, failureStreak: true, pausedReason: true } }));
    ok("twenty failures in a row pause the workflow", doomedRow?.status === "PAUSED" && doomedRow.failureStreak === 20, `${doomedRow?.status} after ${doomedRow?.failureStreak}`);
    ok("  and tell its owner", (await inA(() => db.notification.count({ where: { userId: owner, type: "WORKFLOW_PAUSED" } }))) === 1);
    ok("  a paused workflow starts nothing more by hand", !(await inA(() => store.startManualRun(doomed, owner))).ok);
    const resumed = await inA(() => store.setWorkflowStatus(doomed, "ACTIVE"));
    ok("  switching it back on clears the count", resumed.ok && (await inA(() => db.automationWorkflow.findUnique({ where: { id: doomed }, select: { failureStreak: true } })))?.failureStreak === 0);

    const departing = await person(A, "zzdeparting@zzauto.invalid", "ADMIN");
    const theirs = await publish(A, departing, "ZZ theirs", manual([{ id: "tell", type: "action", action: "notify.person", input: { title: "ZZ theirs" } }]));
    await inA(() => db.user.update({ where: { id: departing }, data: { active: false } }));
    await inA(() => store.startManualRun(theirs, owner));
    await drain(A);
    const theirsRow = await inA(() => db.automationWorkflow.findUnique({ where: { id: theirs }, select: { status: true, pausedReason: true } }));
    ok("a workflow whose owner has left pauses at its first step, and says why", theirsRow?.status === "PAUSED" && !!theirsRow.pausedReason?.includes("no longer an active user"), theirsRow?.pausedReason);

    // ─── Test runs and run history ──────────────────────────────────────────────────────────────
    section("Test runs and what run history shows");
    const preview = await inA(() => engine.createRun({ workflowId: hello, versionId: helloVersion!.id, idempotencyKey: "zz-test-1", trigger: {}, isTest: true }));
    await drain(A);
    const previewSteps = await inA(() => db.automationRunStep.findMany({ where: { runId: preview! }, select: { outputSummary: true } }));
    ok("a test run says what it would do and does none of it", JSON.stringify(previewSteps[0]?.outputSummary ?? "").includes("Would create") && (await tasksTitled(A, "ZZHELLO")) === 1);
    const secret = await publish(A, owner, "ZZ secret", manual([{ id: "tell", type: "action", action: "notify.person", input: { title: "Reset", message: "login with password=hunter2 now" } }]));
    const secretRun = await inA(() => store.startManualRun(secret, owner));
    await drain(A);
    if (secretRun.ok) {
      const stored = await inA(() => db.automationRun.findUnique({ where: { id: secretRun.data.runId }, select: { contextCipher: true, steps: { select: { inputSummary: true } } } }));
      ok("run history masks a password in what went in", !JSON.stringify(stored?.steps ?? []).includes("hunter2"), JSON.stringify(stored?.steps[0]?.inputSummary));
      ok("  and the run's own record of it is encrypted", !!stored && !stored.contextCipher.includes("hunter2") && !stored.contextCipher.includes("Reset"));
    }

    // ─── Kill switches ──────────────────────────────────────────────────────────────────────────
    section("Kill switches");
    await inA(() => switches.setWorkspacePaused(true, owner));
    const pausedRun = await inA(() => store.startManualRun(hello, owner));
    const pausedTurn = await inA(() => engine.workTenant());
    const stillQueued = pausedRun.ok ? (await inA(() => db.automationRun.findUnique({ where: { id: pausedRun.data.runId }, select: { status: true } })))?.status : null;
    ok("the workspace's switch: nothing moves", pausedTurn.skipped === "paused" && stillQueued === "QUEUED");
    await inA(() => switches.setWorkspacePaused(false, owner));
    await drain(A);
    ok("  lifted, the run carries on", pausedRun.ok && (await inA(() => db.automationRun.findUnique({ where: { id: pausedRun.data.runId }, select: { status: true } })))?.status === "SUCCEEDED");
    await switches.setPlatformPaused(true, "check:automate");
    const platformTurn = await worker.runAutomate();
    ok("the platform's switch: the worker does nothing at all", platformTurn.paused && platformTurn.workspaces === 0);
    await switches.setPlatformPaused(false, "check:automate");

    // ─── Two workspaces ─────────────────────────────────────────────────────────────────────────
    section("Two workspaces");
    const ownerB = await person(B, "zzowner@zzauto.invalid", "ADMIN");
    const inB = await publish(B, ownerB, "ZZ in B", manual([{ id: "make", type: "action", action: "task.create", input: { title: "ZZ only in B" } }]));
    await controlDb().automationWake.deleteMany({});
    await runAsTenant(B, () => store.startManualRun(inB, ownerB));
    const dueNow = await wake.dueWakes(new Date(Date.now() + 1_000));
    ok("starting a run in B puts only B on the wake list", dueNow?.length === 1 && dueNow[0]!.tenantId === B.id, JSON.stringify(dueNow));
    const turn = await worker.runAutomate();
    const touched = turn.outcomes.map((o) => o.slug);
    ok("  the worker opens only B", touched.length === 1 && touched[0] === B.slug, touched.join(", "));
    ok("  B's task is in B, and not in A", (await tasksTitled(B, "ZZ only in B")) === 1 && (await tasksTitled(A, "ZZ only in B")) === 0);
    // The task B's run made is an event of its own; the next pass deals with it, then B is off the list.
    let leftOver = await controlDb().automationWake.findUnique({ where: { tenantId: B.id } });
    for (let pass = 0; leftOver && pass < 3; pass++) {
      await sleep(3_100);
      await worker.runAutomate();
      leftOver = await controlDb().automationWake.findUnique({ where: { tenantId: B.id } });
    }
    ok("  and B's wake is settled away once nothing is due", leftOver === null, JSON.stringify(leftOver));
    const aInB = await runAsTenant(B, async () => ({
      workflows: await db.automationWorkflow.count({ where: { ownerUserId: owner } }),
      events: await db.automationEvent.count({ where: { payload: { path: ["task", "title"], string_contains: "ZZCHAIN" } } }),
      runs: await db.automationRun.count({ where: { workflowId: { in: [hello, crash, w1, w2] } } }),
    }));
    ok("A's workflows, runs and events are not in B", aInB.workflows === 0 && aInB.events === 0 && aInB.runs === 0, JSON.stringify(aInB));

    let ranLater = false;
    await runAsTenant(A, () =>
      tenantAfter(async () => {
        ranLater = true;
      }),
    );
    await sleep(100);
    ok("tenantAfter outside a request runs at once, in its workspace", ranLater);
  } finally {
    if (close) await close().catch(() => undefined);
    for (const name of Object.values(names)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch((err) => console.error(`could not drop ${name}`, err));
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM pg_database WHERE datname IN (${Object.values(names).map((n) => `'${n}'`).join(", ")})`);
    ok("every scratch database dropped", Number(left[0]!.n) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? "\nAll Automate checks passed.\n" : `\n${failures} check(s) failed.\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
