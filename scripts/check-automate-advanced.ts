/**
 * check:automate-advanced — Deskzo Automate, Phase 6: approvals and the approvals inbox, waiting for an
 * event, for-each and parallel steps, and the onboarding templates (plan of 17 Oct 2026: "Approval
 * steps appear in the approvals inbox, time out to their chosen path, and refuse a decision from anyone
 * not named. Copilot proposals move onto the same inbox. Wait-for-event, for-each (100 items) and
 * parallel (3 paths) hold to their limits. The customer and employee onboarding templates run end to
 * end.").
 *
 * Builds a scratch workspace and control plane beside the real database, drives the real store,
 * engine, actions and server actions, and drops both at the end. Mail goes to a stand-in provider.
 *
 *   npm run check:automate-advanced
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { directClient } from "../src/lib/tenancy/direct-client";
import type { Definition } from "../src/lib/automate/definition";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
delete process.env.TRUST_PROXY;

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${String(detail)}` : ""}`);
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

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace and control plane");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so scratch databases may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const names = { a: `${realName}_autoadv_a`, control: `${realName}_autoadv_ctl` };
  const admin = directClient(withDatabase(url, "postgres"));
  let close: (() => Promise<void>) | null = null;
  try {
    for (const name of Object.values(names)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    const started = Date.now();
    await admin.$executeRawUnsafe(`CREATE DATABASE "${names.a}"`);
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, names.a) }, timeout: 10 * 60_000 });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${names.control}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: withDatabase(url, names.control) }, timeout: 5 * 60_000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);
    process.env.TENANT_DB_ZZADV_A = withDatabase(url, names.a);
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
    const engine = require("../src/lib/automate/engine") as typeof import("../src/lib/automate/engine");
    const store = require("../src/lib/automate/store") as typeof import("../src/lib/automate/store");
    const { validateDefinition } = require("../src/lib/automate/validate") as typeof import("../src/lib/automate/validate");
    const { TEMPLATES } = require("../src/lib/automate/templates") as typeof import("../src/lib/automate/templates");
    const { emitTask } = require("../src/lib/automate/emit-records") as typeof import("../src/lib/automate/emit-records");
    const { emitPersonJoined } = require("../src/lib/automate/emit-people") as typeof import("../src/lib/automate/emit-people");
    const actions = require("../src/actions/automate") as typeof import("../src/actions/automate");
    const { providerByKey } = require("../src/lib/marketing/providers") as typeof import("../src/lib/marketing/providers");
    type Outbound = import("../src/lib/marketing/providers/types").OutboundMessage;
    /* eslint-enable @typescript-eslint/no-require-imports */

    const A = (await registry.tenantBySlug("zzadv-a"))!;
    ok("the registry knows the workspace", !!A);
    const inA = <T,>(work: () => Promise<T>) => runAsTenant(A, work);
    const def = (d: unknown) => d as Definition;

    // ─── Fixtures ───────────────────────────────────────────────────────────────────────────────
    const person = (name: string, email: string, role: string, extra: Record<string, unknown> = {}) =>
      inA(() => db.user.create({ data: { name, email, passwordHash: "!", role, ...extra }, select: { id: true, name: true, email: true, role: true } }));
    const ownerUser = await person("ZZ Owner", "zzowner@zzadv.invalid", "ADMIN", { isSuperAdmin: true });
    const colleagueUser = await person("ZZ Colleague", "zzcolleague@zzadv.invalid", "ADMIN");
    const sellerUser = await person("ZZ Seller", "zzseller@zzadv.invalid", "SALES");
    const leftUser = await person("ZZ Left", "zzleft@zzadv.invalid", "SALES", { active: false });
    const owner = ownerUser.id;
    const colleague = colleagueUser.id;
    const as = (u: typeof ownerUser) => {
      actor = { id: u.id, name: u.name, email: u.email!, role: u.role };
    };
    as(ownerUser);
    const sent: Outbound[] = [];
    providerByKey.zztest = {
      key: "zztest",
      label: "ZZ stand-in",
      kind: "EMAIL",
      needs: [],
      send: async (message) => {
        sent.push(message);
        return { ok: true, providerMessageId: `zz-${sent.length}` };
      },
      verify: async () => ({ ok: true, detail: "stand-in" }),
    };
    await inA(() => db.messagingProvider.create({ data: { key: "zztest", label: "ZZ stand-in", kind: "EMAIL", enabled: true, priority: 1, classes: ["TRANSACTIONAL"], fromEmail: "crm@zzadv.invalid" } }));

    const publish = (ownerId: string, name: string, d: unknown) =>
      inA(async () => {
        const w = await store.createWorkflow({ name, ownerUserId: ownerId, createdById: ownerId, draft: def(d) });
        const published = await store.publishWorkflow(w.id, ownerId);
        if (!published.ok) throw new Error(`${name}: ${published.error} ${JSON.stringify(published.problems ?? [])}`);
        return w.id;
      });
    const drain = () =>
      inA(async () => {
        for (let i = 0; i < 60; i++) {
          await engine.workTenant({ budgetMs: 15_000 });
          const due = (await db.automationRun.count({ where: { status: { in: ["QUEUED", "WAITING"] }, runAfter: { lte: new Date() } } })) + (await db.automationEvent.count({ where: { matchedAt: null } }));
          if (!due) break;
        }
      });
    const manual = (steps: unknown[]) => ({ schema: 1, trigger: { type: "manual" }, steps });
    const start = async (name: string, steps: unknown[], data: Record<string, unknown> = {}) => {
      const id = await publish(owner, name, manual(steps));
      const run = await inA(() => store.startManualRun(id, owner, data));
      if (!run.ok) throw new Error(`${name}: ${run.error}`);
      await drain();
      return { workflowId: id, runId: run.data.runId };
    };
    const runOf = (id: string) => inA(() => db.automationRun.findUnique({ where: { id }, select: { status: true, error: true } }));
    const notes = (userId: string) => inA(() => db.notification.findMany({ where: { userId, type: "WORKFLOW_MESSAGE" }, select: { title: true } }).then((n) => n.map((x) => x.title)));
    const tell = (id: string, title: string, to = "owner") => ({ id, type: "action", action: "notify.person", input: { to, title } });
    const requestOf = (runId: string) => inA(() => db.approvalRequest.findFirst({ where: { runId }, orderBy: { createdAt: "desc" } }));
    const wakeNow = (runId: string) => inA(() => db.automationRun.update({ where: { id: runId }, data: { runAfter: new Date() } }));

    // ─── Publishing ─────────────────────────────────────────────────────────────────────────────
    section("What publishing refuses of the new steps");
    const problems = (steps: unknown[], trigger: unknown = { type: "manual" }) => {
      const v = validateDefinition({ schema: 1, trigger, steps });
      return v.ok ? [] : v.problems.map((p) => p.message);
    };
    const approval = (extra: Record<string, unknown> = {}) => ({ id: "ok", type: "approval", title: "Approve it", approvers: ["owner"], timeout: { days: 1 }, onTimeout: "rejected", ...extra });
    ok("an approval with nobody to decide", problems([approval({ approvers: [] })]).some((m) => m.includes("Choose who approves")));
    ok("  waiting more than 30 days, or no time at all", problems([approval({ timeout: { days: 31 } })]).some((m) => m.includes("30 days")) && problems([approval({ timeout: {} })]).some((m) => m.includes("time limit")));
    ok("  a role alone is enough", problems([approval({ approvers: [], role: "SALES" })]).length === 0);
    const wait = (extra: Record<string, unknown> = {}) => ({ id: "w", type: "waitForEvent", event: "task.completed", timeout: { days: 2 }, onTimeout: "continue", ...extra });
    ok("a wait for something that isn't an event, or a webhook", problems([wait({ event: "manual" })]).length === 1 && problems([wait({ event: "webhook" })]).length === 1);
    ok("  a rule that doesn't read the event, or a field it hasn't", problems([wait({ filter: { all: [{ ref: "trigger.task.id", op: "eq", value: "x" }] } })]).some((m) => m.includes("starts with event.")) && problems([wait({ filter: { all: [{ ref: "event.nope.id", op: "eq", value: "x" }] } })]).some((m) => m.includes('no field "nope"')));
    ok("  a value from a step not yet run", problems([wait({ filter: { all: [{ ref: "event.task.id", op: "eq", value: "{{steps.later.output.id}}" }] } }), tell("later", "x")]).some((m) => m.includes("hasn't run")));
    ok("a for-each without a list, an empty one, more than 100 items", problems([{ id: "e", type: "forEach", items: "just words", steps: [] }]).some((m) => m.includes("Name a list")) && problems([{ id: "e", type: "forEach", items: [], steps: [] }]).length === 1 && problems([{ id: "e", type: "forEach", items: Array.from({ length: 101 }, (_, i) => i), steps: [] }]).some((m) => m.includes("100")));
    ok("  a for-each inside another", problems([{ id: "e", type: "forEach", items: ["a"], steps: [{ id: "f", type: "forEach", items: ["b"], steps: [] }] }]).some((m) => m.includes("inside another")));
    ok("parallel: four paths, one path, a parallel inside another, a stop in a path", (() => {
      const four = problems([{ id: "p", type: "parallel", paths: [1, 2, 3, 4].map((n) => ({ name: `P${n}`, steps: [] })) }]);
      const one = problems([{ id: "p", type: "parallel", paths: [{ name: "P", steps: [] }] }]);
      const nested = problems([{ id: "p", type: "parallel", paths: [{ name: "A", steps: [{ id: "q", type: "parallel", paths: [{ name: "X", steps: [] }, { name: "Y", steps: [] }] }] }, { name: "B", steps: [] }] }]);
      const stop = problems([{ id: "p", type: "parallel", paths: [{ name: "A", steps: [{ id: "s", type: "stop", outcome: "succeeded" }] }, { name: "B", steps: [] }] }]);
      return four.some((m) => m.includes("At most 3")) && one.some((m) => m.includes("two paths")) && nested.some((m) => m.includes("inside another")) && stop.some((m) => m.includes("Leave Stop out"));
    })());
    ok("what a step may read: the item inside a for-each; the decision inside an approval's paths; every path's steps after a parallel step", problems([
      { id: "loop", type: "forEach", items: ["a"], steps: [tell("inloop", "{{steps.loop.output.item}}")] },
      approval({ id: "ap", approved: [tell("inap", "{{steps.ap.output.decision}}")] }),
      { id: "par", type: "parallel", paths: [{ name: "A", steps: [tell("pa", "a")] }, { name: "B", steps: [tell("pb", "b")] }] },
      tell("after", "{{steps.pa.output.notificationId}} {{steps.par.output.paths}}"),
    ]).length === 0);
    ok("  but not a step inside a for-each, after it", problems([{ id: "loop", type: "forEach", items: ["a"], steps: [tell("inloop", "x")] }, tell("after", "{{steps.inloop.output.x}}")]).some((m) => m.includes("hasn't run")));
    const templatesValid = TEMPLATES.every((t) => {
      const values = Object.fromEntries(t.blanks.map((b) => [b.key, b.kind === "person" ? "owner" : b.kind === "people" ? ["owner"] : undefined]));
      return t.build(values).every((made) => validateDefinition(made.definition).ok);
    });
    ok("every template publishes, the two onboarding ones among them", templatesValid && TEMPLATES.some((t) => t.key === "customer-onboarding") && TEMPLATES.some((t) => t.key === "employee-onboarding"));

    // ─── Approvals ──────────────────────────────────────────────────────────────────────────────
    section("Approvals");
    const asking = (title: string, extra: Record<string, unknown> = {}) => [
      approval({ id: "ask", title, approvers: [colleague], approved: [tell("yes", `${title}: approved {{steps.ask.output.decidedBy}}`)], rejected: [tell("no", `${title}: rejected`)], ...extra }),
      tell("after", `${title}: after`),
    ];
    const first = await start("ZZ approve", asking("ZZ first"));
    const req1 = await requestOf(first.runId);
    ok("the run waits; the request names the person, with a time limit", (await runOf(first.runId))?.status === "WAITING" && req1?.status === "PENDING" && JSON.stringify(req1.approverIds) === JSON.stringify([colleague]) && !!req1.expiresAt);
    ok("  they are told, with a link to their Approvals", (await notes(colleague)).includes("Approval needed: ZZ first"));
    as(colleagueUser);
    const inbox = await inA(() => actions.getApprovalsInbox());
    ok("  it is in their inbox, saying which workflow asks", inbox.waiting.some((w) => w.title === "ZZ first" && w.from === 'The workflow "ZZ approve"'));
    as(ownerUser);
    const notMine = await inA(() => actions.decideApproval(req1!.id, "approved", null));
    ok("anybody not named is refused — the workflow's owner too", !notMine.ok && notMine.error.includes("aren't one of the people"), notMine.ok ? "" : notMine.error);
    ok("  and it isn't in their inbox", !(await inA(() => actions.getApprovalsInbox())).waiting.some((w) => w.id === req1!.id));
    as(colleagueUser);
    const approved = await inA(() => actions.decideApproval(req1!.id, "approved", "Looks right"));
    await drain();
    ok("approved: the run takes the approved steps, then goes on", approved.ok && (await runOf(first.runId))?.status === "SUCCEEDED" && (await notes(owner)).includes("ZZ first: approved ZZ Colleague") && (await notes(owner)).includes("ZZ first: after") && !(await notes(owner)).includes("ZZ first: rejected"));
    const again = await inA(() => actions.decideApproval(req1!.id, "rejected", null));
    ok("  a second decision is refused", !again.ok && again.error.includes("already decided"));
    ok("  and it is in their decided list, with their word", (await inA(() => actions.getApprovalsInbox())).decided.some((d) => d.id === req1!.id && d.status === "APPROVED" && d.comment === "Looks right" && d.decidedBy === "ZZ Colleague"));
    as(ownerUser);

    const second = await start("ZZ reject", asking("ZZ second"));
    const req2 = await requestOf(second.runId);
    as(colleagueUser);
    await inA(() => actions.decideApproval(req2!.id, "rejected", "Not this time"));
    as(ownerUser);
    await drain();
    ok("rejected: the rejected steps, then on", (await runOf(second.runId))?.status === "SUCCEEDED" && (await notes(owner)).includes("ZZ second: rejected") && (await notes(owner)).includes("ZZ second: after"));

    const third = await start("ZZ time out", asking("ZZ third", { onTimeout: "approved" }));
    const req3 = await requestOf(third.runId);
    await inA(() => db.approvalRequest.update({ where: { id: req3!.id }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    await wakeNow(third.runId);
    await drain();
    const req3after = await inA(() => db.approvalRequest.findUnique({ where: { id: req3!.id }, select: { status: true } }));
    ok("nobody deciding in time: it goes the way it was set to — here, approved", req3after?.status === "TIMED_OUT" && (await notes(owner)).includes("ZZ third: approved") && (await runOf(third.runId))?.status === "SUCCEEDED");
    as(colleagueUser);
    const late = await inA(() => actions.decideApproval(req3!.id, "rejected", null));
    as(ownerUser);
    ok("  deciding after that is refused", !late.ok);

    const byRole = await start("ZZ by role", asking("ZZ fourth", { approvers: [], role: "SALES" }));
    const req4 = await requestOf(byRole.runId);
    ok("a role: its holders are told", (await notes(sellerUser.id)).includes("Approval needed: ZZ fourth") && !(await notes(colleague)).includes("Approval needed: ZZ fourth"));
    as(colleagueUser);
    const notTheRole = await inA(() => actions.decideApproval(req4!.id, "approved", null));
    as(sellerUser);
    const theRole = await inA(() => actions.decideApproval(req4!.id, "approved", null));
    as(ownerUser);
    await drain();
    ok("  anybody holding it may decide; nobody else", !notTheRole.ok && theRole.ok && (await runOf(byRole.runId))?.status === "SUCCEEDED");

    const nobody = await start("ZZ nobody", asking("ZZ fifth", { approvers: [leftUser.id] }));
    ok("nobody left to ask (the one named has left): the run fails, saying so", (await runOf(nobody.runId))?.status === "FAILED" && !!(await runOf(nobody.runId))?.error?.includes("Nobody is left"));

    const stopped = await start("ZZ cancelled", asking("ZZ sixth"));
    const cancelled = await inA(() => store.cancelRun(stopped.runId));
    ok("a run cancelled while it waits cancels its request, and it leaves the inbox", cancelled.ok && (await requestOf(stopped.runId))?.status === "CANCELLED");

    const conversation = await inA(() => db.copilotConversation.create({ data: { userId: colleague, title: "ZZ chat" }, select: { id: true } }));
    await inA(() => db.copilotProposal.create({ data: { conversationId: conversation.id, userId: colleague, kind: "TASK", payload: { title: "ZZ call Acme" }, summary: "Call Acme about the renewal" } }));
    as(colleagueUser);
    const withCopilot = await inA(() => actions.getApprovalsInbox());
    as(ownerUser);
    ok("the copilot's drafts waiting on a person are in the same inbox", withCopilot.waiting.some((w) => w.source === "copilot" && w.title === "A task: Call Acme about the renewal"));

    const looped = await start("ZZ approvals in a loop", [{ id: "each", type: "forEach", items: ["one", "two"], steps: [approval({ id: "ask", title: "ZZ loop {{steps.each.output.item}}", approvers: [colleague] })] }]);
    const firstRound = await inA(() => db.approvalRequest.findMany({ where: { runId: looped.runId }, select: { id: true, stepKey: true, title: true } }));
    as(colleagueUser);
    await inA(() => actions.decideApproval(firstRound[0]!.id, "approved", null));
    await drain();
    const secondRound = await inA(() => db.approvalRequest.findMany({ where: { runId: looped.runId }, orderBy: { createdAt: "asc" }, select: { id: true, stepKey: true, title: true, status: true } }));
    await inA(() => actions.decideApproval(secondRound[1]!.id, "approved", null));
    as(ownerUser);
    await drain();
    ok("an approval in a for-each asks once per item, each under its own key", secondRound.map((r) => `${r.stepKey}=${r.title}`).join(",") === "ask#0=ZZ loop one,ask#1=ZZ loop two" && (await runOf(looped.runId))?.status === "SUCCEEDED", secondRound.map((r) => r.stepKey).join(","));

    const testedId = await inA(async () => (await store.createWorkflow({ name: "ZZ test approval", ownerUserId: owner, createdById: owner, draft: def(manual(asking("ZZ test"))) })).id);
    const tested = await inA(() => store.testDraft(testedId, owner, true));
    ok("a test run asks nobody and goes on as approved", tested.ok && tested.data.status === "SUCCEEDED" && (await inA(() => db.approvalRequest.count({ where: { runId: tested.data.runId } }))) === 0);

    // ─── Waiting for an event ───────────────────────────────────────────────────────────────────
    section("Waiting for an event");
    const waitFor = (onTimeout: "continue" | "stop", title: string) => [
      { id: "make", type: "action", action: "task.create", input: { title, assignTo: "owner" } },
      wait({ id: "done", filter: { all: [{ ref: "event.task.id", op: "eq", value: "{{steps.make.output.taskId}}" }] }, onTimeout }),
      tell("after", `${title}: {{steps.done.output.timedOut}} {{steps.done.output.event.task.title}}`),
    ];
    const complete = (taskId: string) =>
      inA(() =>
        db.$transaction(async (tx) => {
          await tx.task.update({ where: { id: taskId }, data: { status: "DONE" } });
          await emitTask(tx, "task.completed", taskId, owner);
        }),
      );
    const waiting = await start("ZZ wait", waitFor("continue", "ZZ wait task"));
    const madeTask = await inA(() => db.task.findFirst({ where: { title: "ZZ wait task" }, select: { id: true } }));
    const waitRow = await inA(() => db.automationEventWait.findFirst({ where: { runId: waiting.runId }, select: { rules: true, eventType: true } }));
    ok("the run waits, its rule's value fixed to the task it made", (await runOf(waiting.runId))?.status === "WAITING" && waitRow?.eventType === "task.completed" && JSON.stringify(waitRow.rules).includes(madeTask!.id));
    const other = await inA(() => db.task.create({ data: { title: "ZZ other task", createdByUserId: owner, assignedToUserId: owner }, select: { id: true } }));
    await complete(other.id);
    await drain();
    ok("  another task done doesn't wake it", (await runOf(waiting.runId))?.status === "WAITING");
    await complete(madeTask!.id);
    await drain();
    ok("  its own task done does, and the event's data is there to read", (await runOf(waiting.runId))?.status === "SUCCEEDED" && (await notes(owner)).includes("ZZ wait task: false ZZ wait task"), (await notes(owner)).filter((n) => n.startsWith("ZZ wait task")).join(" | "));

    const early = await inA(() => db.task.create({ data: { title: "ZZ done already", createdByUserId: owner, assignedToUserId: owner }, select: { id: true } }));
    const tooLate = await start("ZZ wait for the past", [wait({ id: "done", filter: { all: [{ ref: "event.task.id", op: "eq", value: early.id }] } }), tell("after", "ZZ past: after")]);
    // The matcher running behind: an event from before the wait began, still to be looked at once it has.
    const began = (await inA(() => db.automationEventWait.findFirst({ where: { runId: tooLate.runId }, select: { createdAt: true } })))!.createdAt;
    await inA(() => db.automationEvent.create({ data: { type: "task.completed", recordType: "task", recordId: early.id, payload: { task: { id: early.id, title: "ZZ done already" } }, occurredAt: new Date(began.getTime() - 60_000) } }));
    await drain();
    ok("an event from before the wait began doesn't count, even looked at after", (await runOf(tooLate.runId))?.status === "WAITING");

    const timedOut = await start("ZZ wait times out", waitFor("continue", "ZZ timeout task"));
    await inA(() => db.automationEventWait.updateMany({ where: { runId: timedOut.runId }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    await wakeNow(timedOut.runId);
    await drain();
    ok("nothing in time, 'carry on': it goes on, saying it timed out", (await runOf(timedOut.runId))?.status === "SUCCEEDED" && (await notes(owner)).includes("ZZ timeout task: true"));
    const timedStop = await start("ZZ wait then stop", waitFor("stop", "ZZ stop task"));
    await inA(() => db.automationEventWait.updateMany({ where: { runId: timedStop.runId }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    await wakeNow(timedStop.runId);
    await drain();
    ok("  'end the run here': it ends, the step after never runs", (await runOf(timedStop.runId))?.status === "SUCCEEDED" && !(await notes(owner)).some((n) => n.startsWith("ZZ stop task:")));
    await inA(() => store.cancelRun(tooLate.runId));
    ok("a run cancelled while it waits leaves no wait behind", (await inA(() => db.automationEventWait.count({ where: { runId: tooLate.runId } }))) === 0);

    // ─── For each ───────────────────────────────────────────────────────────────────────────────
    section("For each");
    const each = await start("ZZ each", [{ id: "loop", type: "forEach", items: ["red", "green", "blue"], steps: [{ id: "make", type: "action", action: "task.create", input: { title: "ZZ each {{steps.loop.output.item}} #{{steps.loop.output.index}}", assignTo: "owner" } }] }, tell("after", "ZZ each: {{steps.loop.output.count}} done")]);
    const eachTasks = await inA(() => db.task.findMany({ where: { title: { startsWith: "ZZ each " } }, orderBy: { createdAt: "asc" }, select: { title: true } }));
    ok("its steps once per item, in turn, each reading its item", (await runOf(each.runId))?.status === "SUCCEEDED" && eachTasks.map((t) => t.title).join("|") === "ZZ each red #0|ZZ each green #1|ZZ each blue #2" && (await notes(owner)).includes("ZZ each: 3 done"), eachTasks.map((t) => t.title).join("|"));
    const effects = await inA(() => db.automationEffect.findMany({ where: { runId: each.runId }, select: { key: true } }));
    ok("  each time round is its own, under the step's key and its round", effects.map((e) => e.key.split(":")[1]).filter((k) => k?.startsWith("make")).sort().join(",") === "make#0,make#1,make#2", effects.map((e) => e.key).join(","));
    await inA(() => db.automationRun.update({ where: { id: each.runId }, data: { status: "QUEUED", runAfter: new Date(), finishedAt: null, cursor: { frames: [{ index: 0 }] } } }));
    await drain();
    ok("  gone round again from the start, as after a worker dies: no task made twice", (await inA(() => db.task.count({ where: { title: { startsWith: "ZZ each " } } }))) === 3);
    const fromData = await start("ZZ each from data", [{ id: "loop", type: "forEach", items: "{{trigger.data.names}}", steps: [tell("hi", "ZZ hello {{steps.loop.output.item}}")] }], { names: ["Asha", "Ravi"] });
    ok("a list from the data", (await runOf(fromData.runId))?.status === "SUCCEEDED" && (await notes(owner)).includes("ZZ hello Asha") && (await notes(owner)).includes("ZZ hello Ravi"));
    const tooMany = await start("ZZ each too many", [{ id: "loop", type: "forEach", items: "{{trigger.data.names}}", steps: [tell("hi", "x")] }], { names: Array.from({ length: 101 }, (_, i) => `n${i}`) });
    ok("more than 100 items: refused when it runs", (await runOf(tooMany.runId))?.status === "FAILED" && !!(await runOf(tooMany.runId))?.error?.includes("at most 100"));
    const notList = await start("ZZ each not a list", [{ id: "loop", type: "forEach", items: "{{trigger.data.names}}", steps: [tell("hi", "x")] }], { names: "Asha" });
    ok("  not a list: refused", (await runOf(notList.runId))?.status === "FAILED" && !!(await runOf(notList.runId))?.error?.includes("isn't a list"));
    const none = await start("ZZ each none", [{ id: "loop", type: "forEach", items: "{{trigger.data.names}}", steps: [tell("hi", "x")] }, tell("after", "ZZ none: after")], { names: [] });
    ok("  an empty list: nothing inside runs, the run goes on", (await runOf(none.runId))?.status === "SUCCEEDED" && (await notes(owner)).includes("ZZ none: after"));

    // ─── Parallel ───────────────────────────────────────────────────────────────────────────────
    section("Paths at the same time");
    const together = await start("ZZ together", [
      {
        id: "par",
        type: "parallel",
        paths: [
          { name: "Quick", steps: [{ id: "quick", type: "action", action: "task.create", input: { title: "ZZ quick path", assignTo: "owner" } }] },
          { name: "Slow", steps: [{ id: "nap", type: "delay", for: { hours: 1 } }, tell("slow", "ZZ slow path")] },
          { name: "Asks", steps: [approval({ id: "permit", title: "ZZ path approval", approvers: [colleague] }), tell("asked", "ZZ asking path")] },
        ],
      },
      tell("joined", "ZZ joined {{steps.quick.output.taskId}} {{steps.permit.output.decision}}"),
    ]);
    const paths = await inA(() => db.automationRun.findMany({ where: { parentRunId: together.runId }, orderBy: { runSeq: "asc" }, select: { id: true, status: true, parentStepKey: true } }));
    ok("each path runs as a run of its own, belonging to the run", paths.length === 3 && paths.every((p) => p.parentStepKey === "par"), paths.map((p) => p.status).join(","));
    ok("  the quick one is done while the others wait — they don't hold each other up", paths[0]?.status === "SUCCEEDED" && paths[1]?.status === "WAITING" && paths[2]?.status === "WAITING" && (await runOf(together.runId))?.status === "WAITING");
    as(colleagueUser);
    await inA(async () => actions.decideApproval((await inA(() => db.approvalRequest.findFirst({ where: { runId: paths[2]!.id } })))!.id, "approved", null));
    as(ownerUser);
    await drain();
    ok("  the approval path finishes; the run still waits for the slow one", (await runOf(paths[2]!.id))?.status === "SUCCEEDED" && (await runOf(together.runId))?.status === "WAITING");
    await wakeNow(paths[1]!.id);
    await drain();
    const quickTask = await inA(() => db.task.findFirst({ where: { title: "ZZ quick path" }, select: { id: true } }));
    ok("the last done, the run goes on, reading every path's outputs", (await runOf(together.runId))?.status === "SUCCEEDED" && (await notes(owner)).includes(`ZZ joined ${quickTask?.id} approved`), (await notes(owner)).filter((n) => n.startsWith("ZZ joined")).join(" | "));

    const failing = await start("ZZ a path fails", [
      { id: "par", type: "parallel", paths: [{ name: "Fine", steps: [tell("fine", "ZZ fine path")] }, { name: "Broken", steps: [{ id: "bad", type: "action", action: "task.create", input: { title: "ZZ broken", assignTo: leftUser.id } }] }] },
      tell("joined", "ZZ should not run"),
    ]);
    ok("a path failing fails the run, naming the path", (await runOf(failing.runId))?.status === "FAILED" && !!(await runOf(failing.runId))?.error?.startsWith("Broken failed") && !(await notes(owner)).includes("ZZ should not run"), (await runOf(failing.runId))?.error);

    const halted = await start("ZZ cancel paths", [{ id: "par", type: "parallel", paths: [{ name: "A", steps: [{ id: "nap1", type: "delay", for: { hours: 1 } }] }, { name: "B", steps: [approval({ id: "permit", title: "ZZ halted approval", approvers: [colleague] })] }] }]);
    const haltedPaths = await inA(() => db.automationRun.findMany({ where: { parentRunId: halted.runId }, select: { id: true } }));
    await inA(() => store.cancelRun(halted.runId));
    const afterCancel = await inA(() => db.automationRun.findMany({ where: { parentRunId: halted.runId }, select: { status: true } }));
    ok("the run cancelled: its paths stop, and their approvals with them", afterCancel.every((p) => p.status === "CANCELLED") && (await inA(() => db.approvalRequest.count({ where: { runId: { in: haltedPaths.map((p) => p.id) }, status: "PENDING" } }))) === 0);

    const reentered = await start("ZZ re-entered", [{ id: "par", type: "parallel", paths: [{ name: "A", steps: [{ id: "napa", type: "delay", for: { hours: 1 } }] }, { name: "B", steps: [{ id: "napb", type: "delay", for: { hours: 1 } }] }] }]);
    await wakeNow(reentered.runId);
    await drain();
    ok("the run woken early, as after a worker dies, starts no path twice", (await inA(() => db.automationRun.count({ where: { parentRunId: reentered.runId } }))) === 2 && (await runOf(reentered.runId))?.status === "WAITING");
    // The worker died after making one path and before the other: the run, woken, makes the missing one only.
    const madePaths = await inA(() => db.automationRun.findMany({ where: { parentRunId: reentered.runId }, orderBy: { runSeq: "asc" }, select: { id: true } }));
    await inA(() => db.automationRun.delete({ where: { id: madePaths[1]!.id } }));
    await wakeNow(reentered.runId);
    await drain();
    const remade = await inA(() => db.automationRun.findMany({ where: { parentRunId: reentered.runId }, select: { id: true } }));
    ok("  a path never made, as when a worker died part way, is made when the run is woken — and only that one", remade.length === 2 && remade.some((r) => r.id === madePaths[0]!.id) && !remade.some((r) => r.id === madePaths[1]!.id));

    const testParId = await inA(async () => (await store.createWorkflow({ name: "ZZ test parallel", ownerUserId: owner, createdById: owner, draft: def(manual([{ id: "par", type: "parallel", paths: [{ name: "A", steps: [tell("ta", "ZZ test A")] }, { name: "B", steps: [tell("tb", "ZZ test B")] }] }])) })).id);
    const testPar = await inA(() => store.testDraft(testParId, owner, false));
    const testSteps = testPar.ok ? await inA(() => db.automationRunStep.findMany({ where: { runId: testPar.data.runId }, select: { stepId: true } })) : [];
    ok("a test runs the paths one after another, in itself", testPar.ok && testPar.data.status === "SUCCEEDED" && ["ta", "tb"].every((id) => testSteps.some((s) => s.stepId === id)) && (await inA(() => db.automationRun.count({ where: { parentRunId: testPar.data.runId } }))) === 0);

    // ─── The onboarding templates ───────────────────────────────────────────────────────────────
    section("Customer onboarding after a won deal");
    const acme = await inA(() => db.company.create({ data: { name: "ZZ Acme", normalizedName: "zz acme", createdById: owner, ownerUserId: owner, locations: { create: { label: "Head Office", isPrimary: true } } }, select: { id: true } }));
    const asha = await inA(() => db.contact.create({ data: { companyId: acme.id, name: "Asha ZZ", email: "asha@zzadv.invalid" }, select: { id: true } }));
    const deal = await inA(() => db.lead.create({ data: { companyId: acme.id, contactId: asha.id, title: "ZZ big deal", ownerUserId: owner, createdByUserId: owner, source: "OTHER" }, select: { id: true } }));
    const onboarding = await inA(() => store.createFromTemplate("customer-onboarding", { approver: colleague, days: 7, from: "company" }, owner));
    if (!onboarding.ok) throw new Error(onboarding.error);
    const onboardingId = onboarding.data.ids[0]!;
    const published = await inA(() => store.publishWorkflow(onboardingId, owner));
    ok("it is made from the template and publishes", published.ok, published.ok ? "" : published.error);
    await start("ZZ win the deal", [{ id: "win", type: "action", action: "lead.move", input: { leadId: deal.id, status: "WON" } }]);
    const onboardRun = await inA(() => db.automationRun.findFirst({ where: { workflowId: onboardingId }, select: { id: true, status: true } }));
    const kickoff = await inA(() => db.task.findFirst({ where: { leadId: deal.id, title: { startsWith: "Kick-off call" } }, select: { id: true } }));
    ok("the deal won: a kick-off call for its owner, a welcome to the contact, and it waits for the call", onboardRun?.status === "WAITING" && !!kickoff && sent.some((m) => m.to === "asha@zzadv.invalid" && m.subject === "Welcome aboard"), onboardRun?.status);
    await complete(kickoff!.id);
    await drain();
    const handover = await inA(() => db.approvalRequest.findFirst({ where: { runId: onboardRun!.id }, select: { id: true, title: true, approverIds: true } }));
    ok("  the call done: the hand-over is asked of the person chosen", handover?.title === "Hand ZZ Acme over to support?" && handover.approverIds.includes(colleague));
    as(colleagueUser);
    await inA(() => actions.decideApproval(handover!.id, "approved", null));
    as(ownerUser);
    await drain();
    ok("  approved: an onboarding ticket for support, and the run is done", (await inA(() => db.ticket.count({ where: { companyId: acme.id, title: "Onboarding: ZZ Acme" } }))) === 1 && (await runOf(onboardRun!.id))?.status === "SUCCEEDED");

    section("Employee onboarding checklist");
    const hiring = await inA(() => store.createFromTemplate("employee-onboarding", { hr: owner, it: colleague }, owner));
    if (!hiring.ok) throw new Error(hiring.error);
    const hiringId = hiring.data.ids[0]!;
    const hiringPublished = await inA(() => store.publishWorkflow(hiringId, owner));
    ok("it is made from the template and publishes", hiringPublished.ok, hiringPublished.ok ? "" : hiringPublished.error);
    const joiner = await inA(() =>
      db.$transaction(async (tx) => {
        const made = await tx.user.create({ data: { name: "ZZ New Joiner", email: "zzjoiner@zzadv.invalid", passwordHash: "!", role: "SALES" }, select: { id: true } });
        await tx.employeeProfile.create({ data: { userId: made.id, designation: "Account executive" } });
        await emitPersonJoined(tx, made.id, owner);
        return made;
      }),
    );
    await drain();
    const hiringRun = await inA(() => db.automationRun.findFirst({ where: { workflowId: hiringId, parentRunId: null }, select: { id: true, status: true } }));
    const checklist = await inA(() => db.task.findMany({ where: { title: { endsWith: "— ZZ New Joiner" } }, select: { title: true, assignedToUserId: true } }));
    ok("somebody joins: a task for each of the five checklist items, for HR", checklist.length === 5 && checklist.every((t) => t.assignedToUserId === owner), checklist.map((t) => t.title).join(" | "));
    ok("  at the same time, a welcome for them and a heads-up for IT", (await notes(joiner.id)).includes("Welcome to the team, ZZ New Joiner") && (await notes(colleague)).includes("Set up a laptop and accounts for ZZ New Joiner"));
    const confirm = await inA(() => db.approvalRequest.findFirst({ where: { runId: hiringRun!.id }, select: { id: true, approverIds: true, title: true } }));
    ok("  then HR is asked to confirm it's done", hiringRun?.status === "WAITING" && confirm?.title === "Is ZZ New Joiner's onboarding done?" && confirm.approverIds.includes(owner));
    await inA(() => actions.decideApproval(confirm!.id, "approved", null));
    await drain();
    ok("  confirmed: their manager — no manager, so HR — is told, and the run is done", (await notes(owner)).includes("ZZ New Joiner is fully onboarded") && (await runOf(hiringRun!.id))?.status === "SUCCEEDED");
  } finally {
    if (close) await close().catch(() => undefined);
    for (const name of Object.values(names)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch((err) => console.error(`could not drop ${name}`, err));
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM pg_database WHERE datname IN (${Object.values(names).map((n) => `'${n}'`).join(", ")})`);
    ok("every scratch database dropped", Number(left[0]!.n) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} Automate advanced-step checks passed.\n` : `\n${failures} check(s) failed (${passes} passed).\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
