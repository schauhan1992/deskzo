/**
 * check:automate-actions — Deskzo Automate, Phase 2: the Deskzo triggers, the daily date checks and the
 * Deskzo actions (src/lib/automate/emit-*.ts, dates.ts, actions/*).
 *
 * Builds a scratch workspace from the migrations and a scratch control plane beside the real database,
 * runs everything through the real engine, and drops both at the end, pass or fail. The real workspace
 * is never written to. Mail goes to a stand-in provider this script registers, the PDF comes from a
 * stand-in renderer, and nothing reaches a real mailbox, calendar or mail server.
 *
 *   · what publishing refuses of the new actions' input, and which trigger fields exist;
 *   · a lead made by a workflow: through the website door's rules, its event caused by the run, a
 *     workflow on lead.created set off one level deeper, and a retried step making no second lead;
 *   · assigning (to a person, by rules, refused without the right), moving (a stage's meaning, a lost
 *     lead's reason, a win that makes a customer and sets off a workflow on the win), notes;
 *   · a workflow that moves the lead it started from doesn't start itself again;
 *   · tickets: made, assigned to support only, once however often the step is tried;
 *   · email: refused without a way to send, to a contact who has left, to a bounced address; sent
 *     through the company's mail server and logged; at most once, and a send cut off part way waits
 *     for a person;
 *   · a document emailed with its PDF and logged; a draft refused;
 *   · a meeting without a calendar connected: in Deskzo's own calendar, the contact invited through the
 *     company's mail server with the meeting attached — booking one in a real calendar isn't exercised here;
 *   · a report emailed to colleagues, each seeing only their own reach;
 *   · the date checks: overdue invoices, renewals, quiet leads — once a day, and only when listened for.
 *
 *   npm run check:automate-actions
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { directClient } from "../src/lib/tenancy/direct-client";
import type { Definition } from "../src/lib/automate/definition";
import { clockFor } from "../src/lib/time/zone";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
delete process.env.TRUST_PROXY;

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const DAY = 86_400_000;

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

async function main() {
  const india = clockFor("Asia/Kolkata");

  // ─── Scratch databases ──────────────────────────────────────────────────────────────────────
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const real = new URL(url).pathname.slice(1);
  section("A scratch workspace and control plane");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so scratch databases may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const names = { a: `${real}_autoact_a`, control: `${real}_autoact_ctl` };
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
    process.env.TENANT_DB_ZZACT_A = withDatabase(url, names.a);
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
    const { actionByKey } = require("../src/lib/automate/registry") as typeof import("../src/lib/automate/registry");
    const { emitDateEvents } = require("../src/lib/automate/dates") as typeof import("../src/lib/automate/dates");
    const { providerByKey } = require("../src/lib/marketing/providers") as typeof import("../src/lib/marketing/providers");
    const pdf = require("../src/lib/documents/pdf") as typeof import("../src/lib/documents/pdf");
    type Outbound = import("../src/lib/marketing/providers/types").OutboundMessage;

    const A = (await registry.tenantBySlug("zzact-a"))!;
    ok("the registry knows the workspace", !!A);
    const inA = <T,>(work: () => Promise<T>) => runAsTenant(A, work);

    // ─── Pure: the report periods ────────────────────────────────────────────────────────────────
    section("Report periods on the workspace's clock");
    const { periodDays } = require("../src/lib/automate/actions/report-email") as typeof import("../src/lib/automate/actions/report-email");
    const at = new Date("2026-10-17T10:00:00Z");
    const p = (period: Parameters<typeof periodDays>[1], when = at) => {
      const d = periodDays(india, period, when);
      return `${d.from}..${d.to}`;
    };
    ok("yesterday, and the last 7 days before today", p("yesterday") === "2026-10-16..2026-10-16" && p("last_7_days") === "2026-10-10..2026-10-16", p("last_7_days"));
    ok("  last month, and this quarter so far", p("last_month") === "2026-09-01..2026-09-30" && p("this_quarter") === "2026-10-01..2026-10-17", `${p("last_month")} ${p("this_quarter")}`);
    ok("  last quarter", p("last_quarter") === "2026-07-01..2026-09-30", p("last_quarter"));
    const january = new Date("2027-01-05T04:00:00Z");
    ok("  across a new year: last month is December, last quarter October to December", p("last_month", january) === "2026-12-01..2026-12-31" && p("last_quarter", january) === "2026-10-01..2026-12-31", `${p("last_month", january)} ${p("last_quarter", january)}`);
    // 18:00 UTC on the 31st is 23:30 in India, still October there; an hour later it is November.
    ok("  'this month' is India's month, not the server's", p("this_month", new Date("2026-10-31T18:00:00Z")) === "2026-10-01..2026-10-31" && p("this_month", new Date("2026-10-31T19:00:00Z")) === "2026-11-01..2026-11-01");


    // The stand-in mail provider: what the company's mail server would have sent.
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
    pdf.setTestPdfRenderer(async () => Buffer.from("%PDF-1.4\n% zzact stand-in\n%%EOF\n"));

    // ─── Fixtures ───────────────────────────────────────────────────────────────────────────────
    const person = (email: string, role: string, extra: Record<string, unknown> = {}) =>
      inA(() => db.user.create({ data: { name: email.split("@")[0]!, email, passwordHash: "!", role, ...extra }, select: { id: true } }).then((u) => u.id));
    const owner = await person("zzowner@zzact.invalid", "ADMIN");
    const colleague = await person("zzcolleague@zzact.invalid", "SALES");
    const seller = await person("zzseller@zzact.invalid", "SALES");
    const support = await inA(() => db.department.create({ data: { name: "ZZ Support", isSupportTeam: true }, select: { id: true } }));
    const agent = await person("zzagent@zzact.invalid", "SUPPORT", { departmentId: support.id });

    const company = (name: string, ownerUserId: string) =>
      inA(() =>
        db.company.create({
          data: { name, normalizedName: name.toLowerCase(), createdById: owner, ownerUserId, locations: { create: { label: "Head Office", isPrimary: true, isBilling: true, isShipping: true } } },
          select: { id: true, locations: { select: { id: true } } },
        }),
      );
    const acme = await company("ZZ Acme", owner);
    const gamma = await company("ZZ Gamma", colleague);
    const contact = (companyId: string, name: string, email: string, extra: Record<string, unknown> = {}) =>
      inA(() => db.contact.create({ data: { companyId, name, email, ...extra }, select: { id: true } }).then((c) => c.id));
    const asha = await contact(acme.id, "Asha ZZ", "asha@zzact.invalid", { receivesDocuments: true, isPrimary: true });
    const gone = await contact(acme.id, "Gone ZZ", "gone@zzact.invalid", { leftAt: new Date() });
    const bounced = await contact(acme.id, "Bounced ZZ", "bounced@zzact.invalid");
    await inA(() => db.suppression.create({ data: { scope: "EMAIL", value: "bounced@zzact.invalid", reason: "HARD_BOUNCE" } }));
    // Customers' own choices (owner, 18 Oct 2026): one unsubscribed from everything, one who unticked renewal
    // reminders on the preference page, one who did that on the page before it showed reminders honestly.
    const leaver = await contact(acme.id, "Unsubscribed ZZ", "unsub@zzact.invalid");
    await inA(() => db.suppression.create({ data: { scope: "EMAIL", value: "unsub@zzact.invalid", reason: "UNSUBSCRIBED" } }));
    const noRenewals = await contact(acme.id, "No renewals ZZ", "norenew@zzact.invalid");
    await inA(() => db.contactConsent.create({ data: { contactId: noRenewals, topic: "RENEWALS", status: "UNSUBSCRIBED", source: "PREFERENCE_CENTRE", withdrawnAt: new Date() } }));
    const oldPage = await contact(acme.id, "Old page ZZ", "oldpage@zzact.invalid");
    await inA(() => db.contactConsent.create({ data: { contactId: oldPage, topic: "RENEWALS", status: "UNSUBSCRIBED", source: "PREFERENCE_CENTRE", withdrawnAt: new Date("2026-10-01T00:00:00Z") } }));
    const lead = (companyId: string, title: string, ownerUserId: string | null, extra: Record<string, unknown> = {}) =>
      inA(() => db.lead.create({ data: { companyId, title, ownerUserId, createdByUserId: owner, source: "OTHER", ...extra }, select: { id: true } }).then((l) => l.id));
    const deal = await lead(acme.id, "ZZ deal", owner, { contactId: asha });
    const loop = await lead(acme.id, "ZZ loop", owner);

    const publish = (ownerId: string, name: string, d: unknown) =>
      inA(async () => {
        const w = await store.createWorkflow({ name, ownerUserId: ownerId, createdById: ownerId, draft: d as Definition });
        const published = await store.publishWorkflow(w.id, ownerId);
        if (!published.ok) throw new Error(`${name}: ${published.error} ${JSON.stringify(published.problems ?? [])}`);
        return w.id;
      });
    const drain = () =>
      inA(async () => {
        for (let i = 0; i < 40; i++) {
          await engine.workTenant({ budgetMs: 15_000 });
          const due = (await db.automationRun.count({ where: { status: "QUEUED", runAfter: { lte: new Date() } } })) + (await db.automationEvent.count({ where: { matchedAt: null } }));
          if (!due) break;
        }
      });
    const manual = (steps: unknown[]) => ({ schema: 1, trigger: { type: "manual" }, steps });
    /** Publishes a one-off manual workflow, runs it to the end, and says how it went. */
    const runOnce = async (name: string, steps: unknown[], by = owner) => {
      const id = await publish(by, name, manual(steps));
      const started = await inA(() => store.startManualRun(id, by));
      if (!started.ok) throw new Error(`${name}: ${started.error}`);
      await drain();
      const run = await inA(() => db.automationRun.findUnique({ where: { id: started.data.runId }, select: { id: true, status: true, error: true } }));
      const steps2 = await inA(() => db.automationRunStep.findMany({ where: { runId: started.data.runId }, orderBy: { startedAt: "asc" }, select: { stepId: true, status: true, outputSummary: true, error: true } }));
      return { workflowId: id, runId: run!.id, status: run!.status, error: run!.error ?? "", steps: steps2 };
    };
    const runsOf = (workflowId: string) => inA(() => db.automationRun.findMany({ where: { workflowId }, select: { id: true, status: true, depth: true, error: true } }));
    const notes = (userId: string, type: string) => inA(() => db.notification.findMany({ where: { userId, type: type as never }, select: { title: true, message: true } }));

    // ─── Publishing ─────────────────────────────────────────────────────────────────────────────
    section("What publishing refuses of the new actions");
    const problems = (d: unknown) => {
      const v = validateDefinition(d);
      return v.ok ? [] : v.problems.map((x) => x.message);
    };
    const onLead = (steps: unknown[]) => ({ schema: 1, trigger: { type: "lead.created" }, steps });
    ok("a lead step fed by the trigger passes", problems(onLead([{ id: "a", type: "action", action: "lead.assign", input: { leadId: "{{trigger.lead.id}}", to: "rules" } }])).length === 0);
    ok("  the trigger's own fields: lead, company, contact, via — not 'ticket'", problems(onLead([{ id: "n", type: "action", action: "notify.person", input: { title: "{{trigger.ticket.title}}" } }])).some((m) => m.includes('no field "ticket"')));
    ok("a move needs a stage or a meaning, not both", problems(manual([{ id: "m", type: "action", action: "lead.move", input: { leadId: "x", stageId: "s", status: "WON" } }])).length === 1);
    ok("an email to a contact needs the contact", problems(manual([{ id: "e", type: "action", action: "email.send", input: { to: "contact", subject: "Hi", body: "Hello" } }])).some((m) => m.includes("which contact")));
    ok("  and a two-line subject is refused", problems(manual([{ id: "e", type: "action", action: "email.send", input: { to: "person", userId: "owner", subject: "One\nTwo", body: "Hello" } }])).some((m) => m.includes("one line")));
    ok("a lead needs an email or a phone", problems(manual([{ id: "c", type: "action", action: "lead.create", input: { name: "Somebody" } }])).some((m) => m.includes("email or a phone")));
    ok("a meeting's time is HH:MM", problems(manual([{ id: "c", type: "action", action: "meeting.schedule", input: { recordId: "x", at: "9am" } }])).some((m) => m.includes("HH:MM")));
    ok("a report's period is one of the list", problems(manual([{ id: "r", type: "action", action: "report.email", input: { source: "leads", measure: "count", dimension: "owner", period: "forever" } }])).length === 1);

    // ─── Leads ──────────────────────────────────────────────────────────────────────────────────
    section("A lead made by a workflow");
    const onNew = await publish(owner, "ZZ on new lead", {
      schema: 1,
      trigger: { type: "lead.created", filter: { all: [{ ref: "trigger.via", op: "eq", value: "workflow" }] } },
      steps: [{ id: "tell", type: "action", action: "notify.person", input: { title: "ZZ new: {{trigger.lead.title}} ({{trigger.lead.ref}})" } }],
    });
    const made = await runOnce("ZZ make lead", [{ id: "make", type: "action", action: "lead.create", input: { name: "Ravi ZZ", email: "ravi@zzact.invalid", company: "ZZ Beta", interest: "Laptops", owner: colleague, value: 50000 } }]);
    const madeLead = await inA(() => db.lead.findFirst({ where: { company: { name: "ZZ Beta" } }, select: { id: true, ownerUserId: true, sourceDetail: true, estimatedValue: true, title: true, contact: { select: { email: true } } } }));
    ok("the run makes the company, the contact and the lead", made.status === "SUCCEEDED" && !!madeLead, `${made.status} ${made.error}`);
    ok("  the lead is the named person's, with its value, and says it came from the workflow", madeLead?.ownerUserId === colleague && Number(madeLead.estimatedValue) === 50000 && !!madeLead.sourceDetail?.includes("ZZ make lead"), madeLead?.sourceDetail);
    ok("  they are told it is theirs", (await notes(colleague, "LEAD_ASSIGNED")).some((n) => n.title.includes("workflow")));
    const createdEvent = await inA(() => db.automationEvent.findFirst({ where: { type: "lead.created", recordId: madeLead?.id }, select: { causedByRunId: true, depth: true, payload: true } }));
    ok("its lead.created event is caused by the run, one level deeper", createdEvent?.causedByRunId === made.runId && createdEvent.depth === 1);
    ok("  and carries no email address", !!createdEvent && !JSON.stringify(createdEvent.payload).includes("ravi@"), JSON.stringify(createdEvent?.payload).slice(0, 120));
    const onNewRuns = await runsOf(onNew);
    ok("a workflow on lead.created runs once, a level deeper, with the lead's title written in", onNewRuns.length === 1 && onNewRuns[0]!.depth === 1 && (await notes(owner, "WORKFLOW_MESSAGE")).some((n) => n.title.startsWith("ZZ new: Laptops — ZZ Beta (")), JSON.stringify(onNewRuns));
    const again = await runOnce("ZZ make lead again", [{ id: "make", type: "action", action: "lead.create", input: { name: "Ravi ZZ", email: "ravi@zzact.invalid", company: "ZZ Beta" } }]);
    ok("the same person again: no second company or contact, a second lead", again.status === "SUCCEEDED" && (await inA(() => db.company.count({ where: { name: "ZZ Beta" } }))) === 1 && (await inA(() => db.contact.count({ where: { email: "ravi@zzact.invalid" } }))) === 1 && (await inA(() => db.lead.count({ where: { company: { name: "ZZ Beta" } } }))) === 2);

    // A step tried twice — the worker died after the first try made the lead.
    const direct = await publish(owner, "ZZ direct", manual([{ id: "end", type: "stop", outcome: "succeeded" }]));
    const directRun = await inA(() => store.startManualRun(direct, owner));
    if (!directRun.ok) throw new Error(directRun.error);
    const ctxFor = (stepId: string) => ({ actorId: owner, workflowId: direct, workflowName: "ZZ direct", runId: directRun.data.runId, stepId, key: `${directRun.data.runId}:${stepId}`, depth: 0, clock: india });
    const createLead = actionByKey("lead.create")!;
    const leadInput = createLead.input.parse({ name: "Twice ZZ", phone: "+919800000001", company: "ZZ Twice" });
    const firstTry = (await inA(() => createLead.run(ctxFor("twice"), leadInput))) as { leadId?: string };
    const secondTry = (await inA(() => createLead.run(ctxFor("twice"), leadInput))) as { leadId?: string };
    ok("a lead step tried twice makes one lead, and both tries name it", !!firstTry.leadId && firstTry.leadId === secondTry.leadId && (await inA(() => db.lead.count({ where: { company: { name: "ZZ Twice" } } }))) === 1);

    section("Assigning, moving and noting a lead");
    const assigned = await runOnce("ZZ assign", [{ id: "give", type: "action", action: "lead.assign", input: { leadId: deal, to: colleague } }]);
    const dealNow = await inA(() => db.lead.findUnique({ where: { id: deal }, select: { ownerUserId: true, assignmentNote: true } }));
    ok("assigning gives the lead to the person, and says how", assigned.status === "SUCCEEDED" && dealNow?.ownerUserId === colleague && !!dealNow.assignmentNote?.includes("ZZ assign"), `${assigned.error} ${dealNow?.assignmentNote}`);
    ok("  the step's output says who has it, for the steps after", JSON.stringify(assigned.steps[0]?.outputSummary).includes(colleague));
    const byRules = await runOnce("ZZ assign by rules", [{ id: "give", type: "action", action: "lead.assign", input: { leadId: deal, to: "rules" } }]);
    ok("by the rules, with none set up: refused, and the lead stays", byRules.status === "FAILED" && byRules.error.includes("No assignment rule") && (await inA(() => db.lead.findUnique({ where: { id: deal }, select: { ownerUserId: true } })))?.ownerUserId === colleague, byRules.error);
    const notTheirs = await runOnce("ZZ seller assigns", [{ id: "give", type: "action", action: "lead.assign", input: { leadId: loop, to: seller } }], seller);
    ok("a salesperson's workflow can't hand on a lead that isn't theirs to give", notTheirs.status === "FAILED" && (await inA(() => db.lead.findUnique({ where: { id: loop }, select: { ownerUserId: true } })))?.ownerUserId === owner, notTheirs.error);

    const qualified = await runOnce("ZZ qualify", [{ id: "move", type: "action", action: "lead.move", input: { leadId: deal, status: "QUALIFIED" } }]);
    const movedEvent = await inA(() => db.automationEvent.findFirst({ where: { type: "lead.stage_changed", causedByRunId: qualified.runId }, select: { payload: true, depth: true } }));
    ok("moving by meaning puts it in that stage, with the stage-change note", qualified.status === "SUCCEEDED" && (await inA(() => db.lead.findUnique({ where: { id: deal }, select: { status: true } })))?.status === "QUALIFIED" && (await inA(() => db.activity.count({ where: { leadId: deal, type: "STAGE_CHANGE" } }))) === 1, qualified.error);
    ok("  and records lead.stage_changed, from and to, caused by the run", movedEvent?.depth === 1 && (movedEvent.payload as { to?: { status?: string } }).to?.status === "QUALIFIED");
    const lostNoReason = await runOnce("ZZ lose", [{ id: "move", type: "action", action: "lead.move", input: { leadId: deal, status: "LOST" } }]);
    ok("lost without a reason is refused, as on the board", lostNoReason.status === "FAILED" && lostNoReason.error.includes("reason is required"), lostNoReason.error);

    const onWin = await publish(owner, "ZZ on win", {
      schema: 1,
      trigger: { type: "lead.won" },
      steps: [{ id: "note", type: "action", action: "lead.note", input: { leadId: "{{trigger.lead.id}}", note: "ZZ won, kick-off next", type: "NOTE" } }],
    });
    const won = await runOnce("ZZ win", [{ id: "move", type: "action", action: "lead.move", input: { leadId: deal, status: "WON" } }]);
    ok("a win in the sales pipeline makes the company a customer", won.status === "SUCCEEDED" && (await inA(() => db.company.findUnique({ where: { id: acme.id }, select: { stage: true } })))?.stage === "CUSTOMER", won.error);
    const winRuns = await runsOf(onWin);
    const winNote = await inA(() => db.activity.findFirst({ where: { leadId: deal, type: "NOTE", notes: "ZZ won, kick-off next" }, select: { userId: true } }));
    ok("  a workflow on lead.won runs once and notes it on the lead, as its owner", winRuns.length === 1 && winRuns[0]!.status === "SUCCEEDED" && winNote?.userId === owner, JSON.stringify(winRuns));
    ok("  and the lead's owner is told of the note", (await notes(colleague, "LEAD_ACTIVITY")).some((n) => n.message?.includes("ZZ won")));

    const selfMover = await publish(owner, "ZZ self mover", {
      schema: 1,
      trigger: { type: "lead.stage_changed", filter: { all: [{ ref: "trigger.lead.title", op: "eq", value: "ZZ loop" }] } },
      steps: [{ id: "move", type: "action", action: "lead.move", input: { leadId: "{{trigger.lead.id}}", status: "CONTACTED" } }],
    });
    await runOnce("ZZ start the loop", [{ id: "move", type: "action", action: "lead.move", input: { leadId: loop, status: "QUALIFIED" } }]);
    const loopRuns = await runsOf(selfMover);
    const ownMove = await inA(() => db.automationEvent.findFirst({ where: { type: "lead.stage_changed", recordId: { startsWith: `${loop}>` }, payload: { path: ["to", "status"], equals: "CONTACTED" } }, select: { causedByRunId: true, depth: true } }));
    ok("a workflow's own move is recorded as caused by its run, a level deeper", !!ownMove && ownMove.causedByRunId === loopRuns[0]?.id && ownMove.depth === 2, JSON.stringify(ownMove));
    ok("  so a workflow that moves the lead it started from doesn't start itself again", loopRuns.length === 1 && (await inA(() => db.lead.findUnique({ where: { id: loop }, select: { status: true } })))?.status === "CONTACTED", JSON.stringify(loopRuns));
    await inA(() => db.automationWorkflow.updateMany({ where: { id: { in: [onNew, onWin, selfMover] } }, data: { status: "PAUSED" } }));

    // ─── Tickets ────────────────────────────────────────────────────────────────────────────────
    section("Tickets");
    const ticketed = await runOnce("ZZ ticket", [{ id: "open", type: "action", action: "ticket.create", input: { companyId: acme.id, contactId: asha, title: "ZZ printer jammed", priority: "HIGH", assignTo: agent } }]);
    const ticket = await inA(() => db.ticket.findFirst({ where: { title: "ZZ printer jammed" }, select: { id: true, createdByUserId: true, assignedToUserId: true, priority: true } }));
    ok("a ticket is opened as the owner, assigned to support", ticketed.status === "SUCCEEDED" && ticket?.createdByUserId === owner && ticket.assignedToUserId === agent && ticket.priority === "HIGH", ticketed.error);
    ok("  the agent is told, and ticket.created is recorded from the workflow", (await notes(agent, "TICKET_ASSIGNED")).length === 1 && (await inA(() => db.automationEvent.count({ where: { type: "ticket.created", recordId: ticket?.id, causedByRunId: ticketed.runId } }))) === 1);
    const wrongAgent = await runOnce("ZZ ticket to sales", [{ id: "open", type: "action", action: "ticket.create", input: { companyId: acme.id, title: "ZZ for sales", assignTo: colleague } }]);
    ok("assigning a ticket outside support is refused", wrongAgent.status === "FAILED" && wrongAgent.error.includes("Tech Support"), wrongAgent.error);
    const openTicket = actionByKey("ticket.create")!;
    const ticketInput = openTicket.input.parse({ companyId: acme.id, title: "ZZ twice ticket" });
    await inA(() => openTicket.run(ctxFor("ticket"), ticketInput));
    await inA(() => openTicket.run(ctxFor("ticket"), ticketInput));
    ok("a ticket step tried twice opens one ticket", (await inA(() => db.ticket.count({ where: { title: "ZZ twice ticket" } }))) === 1);

    // ─── Email ──────────────────────────────────────────────────────────────────────────────────
    section("Email");
    const fromCompany = (input: Record<string, unknown>) => [{ id: "send", type: "action", action: "email.send", input: { from: "company", subject: "ZZ hello", body: "Hello there.\n\nRegards", ...input } }];
    const noServer = await runOnce("ZZ mail, no server", fromCompany({ to: "lead_contact", leadId: deal }));
    ok("through the company's mail server, with none set up: refused, saying where to set one up", noServer.status === "FAILED" && noServer.error.includes("Mail & messaging"), noServer.error);
    const noMailbox = await runOnce("ZZ mail, no mailbox", [{ id: "send", type: "action", action: "email.send", input: { to: "lead_contact", leadId: deal, from: "owner", subject: "ZZ hi", body: "Hi" } }]);
    ok("from the owner's mailbox, with none connected: refused", noMailbox.status === "FAILED" && noMailbox.error.includes("mailbox"), noMailbox.error);

    await inA(() => db.messagingProvider.create({ data: { key: "zztest", label: "ZZ stand-in", kind: "EMAIL", enabled: true, priority: 1, classes: ["TRANSACTIONAL"], fromEmail: "crm@zzact.invalid" } }));
    const mailed = await runOnce("ZZ mail the contact", fromCompany({ to: "lead_contact", leadId: deal }));
    const toAsha = sent.find((m) => m.to === "asha@zzact.invalid");
    ok("sent to the lead's contact through the company's mail server", mailed.status === "SUCCEEDED" && !!toAsha, mailed.error);
    ok("  in the owner's name, replies to them, the body as paragraphs", toAsha?.replyTo === "zzowner@zzact.invalid" && !!toAsha.fromName?.includes("zzowner") && (toAsha.html.match(/<p>/g) ?? []).length === 3);
    const ashaLog = await inA(() => db.marketingMessage.findFirst({ where: { contactId: asha, messageClass: "TRANSACTIONAL" }, orderBy: { createdAt: "desc" }, select: { token: true } }));
    ok("  ending with the link to choose what they're sent — its own logged email's", !!ashaLog && !!toAsha?.text?.includes(`/preferences/${ashaLog.token}`) && !!toAsha.text.includes("Manage what we send you"), toAsha?.text?.split("Regards")[1]);
    ok("  on the contact's mail log and the lead's timeline", (await inA(() => db.marketingMessage.count({ where: { contactId: asha, status: "SENT", messageClass: "TRANSACTIONAL" } }))) === 1 && (await inA(() => db.activity.count({ where: { leadId: deal, type: "EMAIL" } }))) === 1);
    const toGone = await runOnce("ZZ mail the leaver", fromCompany({ to: "contact", contactId: gone }));
    ok("not to somebody who has left the company", toGone.status === "FAILED" && toGone.error.includes("has left"), toGone.error);
    const toBounced = await runOnce("ZZ mail the bounced", fromCompany({ to: "contact", contactId: bounced }));
    ok("not to an address that bounced", toBounced.status === "FAILED" && toBounced.error.toLowerCase().includes("bounced"), toBounced.error);
    const sentBeforeChoices = sent.length;
    const toLeaver = await runOnce("ZZ mail the unsubscribed", fromCompany({ to: "contact", contactId: leaver }));
    const leaverStep = toLeaver.steps.find((s) => s.stepId === "send");
    ok("not to somebody who unsubscribed from everything — and the run goes on, nothing wrong", toLeaver.status === "SUCCEEDED" && leaverStep?.status === "SUCCEEDED" && JSON.stringify(leaverStep.outputSummary).includes('"sent":false') && sent.length === sentBeforeChoices, JSON.stringify(leaverStep?.outputSummary));
    const renewalNote = await runOnce("ZZ renewal to the opted out", fromCompany({ to: "contact", contactId: noRenewals, topic: "RENEWALS" }));
    ok("a renewal reminder not to somebody who unticked renewal reminders", renewalNote.status === "SUCCEEDED" && sent.length === sentBeforeChoices && JSON.stringify(renewalNote.steps[0]?.outputSummary).includes("opted out"), JSON.stringify(renewalNote.steps[0]?.outputSummary));
    const serviceNote = await runOnce("ZZ service note to them", fromCompany({ to: "contact", contactId: noRenewals }));
    ok("  a service notice still reaches them", serviceNote.status === "SUCCEEDED" && sent.some((m) => m.to === "norenew@zzact.invalid"), serviceNote.error);
    const oldPageNote = await runOnce("ZZ renewal to the old page", fromCompany({ to: "contact", contactId: oldPage, topic: "RENEWALS" }));
    ok("  and one unticked on the page before it showed reminders honestly isn't held against them", oldPageNote.status === "SUCCEEDED" && sent.some((m) => m.to === "oldpage@zzact.invalid"), oldPageNote.error);
    const toColleague = await runOnce("ZZ mail a colleague", fromCompany({ to: "person", userId: colleague }));
    ok("to a colleague: sent, and not on any customer's log", toColleague.status === "SUCCEEDED" && sent.some((m) => m.to === "zzcolleague@zzact.invalid") && (await inA(() => db.marketingMessage.count({ where: { toEmail: "zzcolleague@zzact.invalid" } }))) === 0, toColleague.error);

    const mail = actionByKey("email.send")!;
    const mailInput = mail.input.parse({ to: "contact", contactId: asha, from: "company", subject: "ZZ once", body: "Once" });
    const before = sent.length;
    await inA(() => mail.run(ctxFor("once"), mailInput));
    await inA(() => mail.run(ctxFor("once"), mailInput));
    ok("an email step tried twice sends once", sent.length === before + 1, sent.length - before);

    const cutOff = await publish(owner, "ZZ cut off", manual(fromCompany({ to: "contact", contactId: asha, subject: "ZZ cut off" })));
    const cutRun = await inA(() => store.startManualRun(cutOff, owner));
    if (cutRun.ok) {
      // A worker that stopped after sending and before saying so leaves the step marked.
      await inA(() => db.automationEffect.create({ data: { key: `${cutRun.data.runId}:send`, runId: cutRun.data.runId, output: { $sending: true } } }));
      const was = sent.length;
      await drain();
      const row = await inA(() => db.automationRun.findUnique({ where: { id: cutRun.data.runId }, select: { status: true, error: true } }));
      ok("a send cut off part way isn't sent again: the run waits for a person", row?.status === "NEEDS_ATTENTION" && sent.length === was, `${row?.status} ${row?.error}`);
    }

    // ─── Documents ──────────────────────────────────────────────────────────────────────────────
    section("Documents");
    await inA(() => db.documentMailSettings.upsert({ where: { id: "global" }, create: { id: "global", sendFrom: "COMPANY", updatedById: owner }, update: { sendFrom: "COMPANY" } }));
    const invoice = await inA(() =>
      db.tradeDocument.create({
        data: { docNumber: "ZZ-INV-1", docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: acme.id, createdById: owner, issueDate: new Date(Date.now() - 2 * DAY), dueDate: new Date(Date.now() + 20 * DAY) },
        select: { id: true },
      }),
    );
    const draft = await inA(() => db.tradeDocument.create({ data: { docNumber: "ZZ-DRAFT", docType: "INVOICE", direction: "SALES", status: "DRAFT", companyId: acme.id, createdById: owner }, select: { id: true } }));
    const docMailed = await runOnce("ZZ email invoice", [{ id: "send", type: "action", action: "document.email", input: { documentId: invoice.id } }]);
    const withPdf = sent.find((m) => m.to === "asha@zzact.invalid" && (m.attachments?.length ?? 0) === 1);
    ok("an issued invoice goes to the contact who receives documents, with its PDF", docMailed.status === "SUCCEEDED" && !!withPdf && withPdf.attachments![0]!.contentType === "application/pdf", docMailed.error);
    ok("  in the workspace's wording, logged on the document", !!withPdf?.subject.includes("ZZ-INV-1") && (await inA(() => db.marketingMessage.count({ where: { tradeDocumentId: invoice.id, status: "SENT" } }))) === 1 && !!(await inA(() => db.tradeDocument.findUnique({ where: { id: invoice.id }, select: { lastEmailedAt: true } })))?.lastEmailedAt, withPdf?.subject);
    const draftMailed = await runOnce("ZZ email draft", [{ id: "send", type: "action", action: "document.email", input: { documentId: draft.id } }]);
    ok("a draft is refused", draftMailed.status === "FAILED" && draftMailed.error.includes("Issue it first"), draftMailed.error);

    // ─── Meetings ───────────────────────────────────────────────────────────────────────────────
    section("Meetings");
    const invitesBefore = sent.length;
    const meeting = await runOnce("ZZ meeting", [{ id: "book", type: "action", action: "meeting.schedule", input: { record: "lead", recordId: deal, inDays: 1, at: "11:00" } }]);
    const invite = sent.slice(invitesBefore).find((m) => m.calendar?.method === "REQUEST");
    const booked = await inA(() => db.calendarEvent.findFirst({ where: { leadId: deal, fromDeskzo: true }, select: { id: true, provider: true, userId: true, startsAt: true } }));
    ok("with no calendar connected: booked in Deskzo's own calendar, in the owner's name, on the lead", meeting.status === "SUCCEEDED" && !!booked && booked.provider === null && booked.userId === owner, meeting.error);
    ok("  the lead's contact invited through the company's mail server, the meeting attached", invite?.to === "asha@zzact.invalid" && invite.calendar!.content.includes(`UID:${booked?.id}@deskzo.com`) && invite.replyTo === "zzowner@zzact.invalid");
    ok("  at 11:00 tomorrow on the workspace's clock", !!booked && india.dateKey(booked.startsAt) === india.dateKey(new Date(Date.now() + 86_400_000)) && india.time(booked.startsAt) === "11:00 am", booked && india.dateTime(booked.startsAt));
    console.log("  (booking in a real calendar isn't exercised here: it needs Outlook, Google or Zoho)");

    // ─── Reports ────────────────────────────────────────────────────────────────────────────────
    section("Reports");
    await lead(gamma.id, "ZZ gamma deal", colleague);
    const mailsBefore = sent.length;
    const report = await runOnce("ZZ weekly report", [{ id: "mail", type: "action", action: "report.email", input: { source: "leads", measure: "count", dimension: "owner", period: "this_month", to: ["owner", colleague] } }]);
    const reports = sent.slice(mailsBefore);
    const ownersCopy = reports.find((m) => m.to === "zzowner@zzact.invalid");
    const colleaguesCopy = reports.find((m) => m.to === "zzcolleague@zzact.invalid");
    ok("a report goes to each person named", report.status === "SUCCEEDED" && !!ownersCopy && !!colleaguesCopy, `${report.error} ${reports.map((m) => m.to).join(", ")}`);
    ok("  the owner's has every lead: theirs and the colleague's", !!ownersCopy?.html.includes(">zzowner</td>") && !!ownersCopy.html.includes(">zzcolleague</td>"));
    ok("  the colleague's has only what they could see on the Reports page", !!colleaguesCopy?.html.includes(">zzcolleague</td>") && !colleaguesCopy.html.includes(">zzowner</td>"));
    const reportLog = await inA(() => db.activityLog.findFirst({ where: { kind: "SEARCH", userId: colleague }, select: { summary: true } }));
    ok("  the security log names who it was run for, and that a workflow ran it", !!reportLog?.summary.includes("run for zzcolleague by workflow"), reportLog?.summary);

    // ─── Date checks ────────────────────────────────────────────────────────────────────────────
    section("The date checks");
    const nobody = await inA(() => emitDateEvents(india));
    ok("nobody listening: nothing done, and the day left unclaimed", nobody === null && (await inA(() => db.dailyJobRun.count({ where: { job: "automate-dates" } }))) === 0);
    const todayKey = india.dateKey(new Date());
    const [y, m, d] = todayKey.split("-").map(Number);
    const typedDay = (offset: number) => new Date(Date.UTC(y!, m! - 1, d! + offset));
    await inA(() => db.tradeDocument.create({ data: { docNumber: "ZZ-OVERDUE", docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: acme.id, createdById: owner, issueDate: typedDay(-33), dueDate: typedDay(-3) } }));
    await lead(acme.id, "ZZ quiet", owner, { stageChangedAt: new Date(Date.now() - 5 * DAY - 3_600_000) });
    const plan = await inA(() => db.item.create({ data: { name: "ZZ Cloud plan", sku: "ZZ-CLOUD", type: "SUBSCRIPTION", sellingPrice: 1000, createdById: owner }, select: { id: true } }));
    await inA(() => db.companyProduct.create({ data: { companyId: acme.id, locationId: acme.locations[0]!.id, itemId: plan.id, addedByUserId: owner, quantity: 5, endDate: typedDay(30) } }));
    const tell = (title: string) => [{ id: "tell", type: "action", action: "notify.person", input: { title } }];
    await publish(owner, "ZZ overdue", { schema: 1, trigger: { type: "invoice.overdue", filter: { all: [{ ref: "trigger.daysOverdue", op: "eq", value: 3 }] } }, steps: tell("ZZ overdue {{trigger.document.number}}") });
    await publish(owner, "ZZ renewal", { schema: 1, trigger: { type: "renewal.due", filter: { all: [{ ref: "trigger.daysLeft", op: "eq", value: 30 }] } }, steps: tell("ZZ renewal {{trigger.order.itemName}}") });
    await publish(owner, "ZZ quiet", { schema: 1, trigger: { type: "lead.quiet", filter: { all: [{ ref: "trigger.lead.title", op: "eq", value: "ZZ quiet" }] } }, steps: tell("ZZ quiet for {{trigger.daysQuiet}} days") });
    const today = await inA(() => emitDateEvents(india));
    const dated = await inA(() => db.automationEvent.findMany({ where: { type: { in: ["invoice.overdue", "renewal.due", "lead.quiet"] } }, select: { type: true, recordId: true, payload: true } }));
    const overdue = dated.find((e) => e.type === "invoice.overdue" && (e.payload as { document?: { number?: string } }).document?.number === "ZZ-OVERDUE");
    ok("once listened for, the day's checks record their events", !!today && today.events >= 3 && !!overdue, JSON.stringify(today));
    ok("  each with how many days, and keyed by the day", (overdue?.payload as { daysOverdue?: number }).daysOverdue === 3 && !!overdue?.recordId?.endsWith(`@${todayKey}`), overdue?.recordId);
    ok("  run again the same day, nothing", (await inA(() => emitDateEvents(india))) === null);
    await drain();
    const told = (await notes(owner, "WORKFLOW_MESSAGE")).map((n) => n.title);
    ok("the workflows waiting on them run, with the day counts written in", told.includes("ZZ overdue ZZ-OVERDUE") && told.includes("ZZ renewal ZZ Cloud plan") && told.includes("ZZ quiet for 5 days"), told.filter((t) => t.startsWith("ZZ ") && !t.startsWith("ZZ new")).join(" | "));
  } finally {
    if (close) await close().catch(() => undefined);
    for (const name of Object.values(names)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch((err) => console.error(`could not drop ${name}`, err));
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM pg_database WHERE datname IN (${Object.values(names).map((n) => `'${n}'`).join(", ")})`);
    ok("every scratch database dropped", Number(left[0]!.n) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? "\nAll Automate action checks passed.\n" : `\n${failures} check(s) failed.\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
