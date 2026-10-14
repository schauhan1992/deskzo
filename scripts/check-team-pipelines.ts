/**
 * check:team-pipelines — Deskzo Pipeline, the Bigin-like product (owner, 14 Oct 2026): several pipelines
 * per workspace, connected pipelines, a stage's rule, simple automations and booking pages, and the
 * product itself — sold apart from Deskzo CRM, never with it, with its simple menu.
 *
 * The pure part needs no database: the rules for pipelines and their stages, what a stage asks for, what
 * an automation may say, the times a booking page offers in the workspace's zone, who a booking goes
 * to, the plan rule and the menu.
 *
 * The rest builds a scratch workspace database beside the real one, drives the real actions as a
 * workspace pointed at it (`runAsTenant`), and drops it at the end. Nothing leaves the machine: a
 * meeting is made by a stand-in for the calendar (src/lib/calendar/meetings.ts), and the one email an
 * automation tries finds no mailbox connected.
 *
 *   · the migration: the main pipeline made, every stage in it;
 *   · pipelines: only `pipeline.manage` shapes them; a new one starts with stages; names unique; the
 *     main one always sales; connecting without going round in a circle; retired only when empty of
 *     open leads, and whatever carried on into it stops;
 *   · leads: made in a pipeline; moved within it only; a stage's rule stopping a move until the lead has
 *     what it asks for, edited from the lead; moved to another pipeline with a note;
 *   · connected: a lead won in Sales carries on into Onboarding once, with its company, contact, owner and
 *     value; a lead done in a pipeline that isn't sales makes nobody a customer and counts as no sale;
 *   · automations: on arriving and on entering a stage — a task, an assignment, a notification, and an
 *     email that can't be sent noted on the automation, never undoing the move;
 *   · booking pages: only hosts with a calendar; times from their hours less what is busy; a booking
 *     opening a lead in the page's pipeline, owned by the host, and a meeting with the customer invited;
 *     the same time never taken twice; too many from one place refused;
 *   · and the real workspace untouched.
 *
 *   npm run check:team-pipelines
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import {
  MAIN_PIPELINE_ID,
  checkPipeline,
  checkStage,
  meaningsFor,
  missingForStage,
  mustKeep,
  ruleRefusal,
  stageForStatus,
  stageOfLead,
  type LeadStageDef,
  type PipelineDef,
} from "../src/lib/pipeline/rules";
import { describeAction, mergeText, parseActions, storedActions, textToHtml } from "../src/lib/pipeline/automation-rules";
import { checkBookingPage, defaultHours, openSlots, pageSlots, parseHours, pickHost } from "../src/lib/booking/rules";
import { clockFor } from "../src/lib/time/zone";
import { productRefusal, type ChoicePlan } from "../src/lib/billing/plan-choice";
import { buildNavigation, simpleMenuFor } from "../src/lib/navigation";
import { productByKey } from "../src/lib/products";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : r.error);

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const TAG = "ZZTEAM";

// ── Who the actions think is calling, and a calendar that answers without the internet ─────────────

let actor: { id: string; name: string; email: string; role: string } | null = null;
const meetings: { userId: string; title: string; attendees: { email: string }[]; startsAt: Date; links: unknown }[] = [];

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
const navigation = {
  notFound: () => {
    throw new Error("NOT_FOUND_CALLED");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
  permanentRedirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/leads",
  useSearchParams: () => new URLSearchParams(),
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const email = { sendEmailNotification: async () => {} };
const fakeMeetings = {
  scheduleMeeting: async (userId: string, draft: { title: string; attendees: { email: string }[]; startsAt: Date }, links: unknown) => {
    meetings.push({ userId, title: draft.title, attendees: draft.attendees, startsAt: draft.startsAt, links });
    return { ok: true as const, eventId: `zz-event-${meetings.length}` };
  },
  rescheduleMeeting: async () => ({ ok: false as const, error: "not in this check" }),
  cancelMeeting: async () => ({ ok: false as const, error: "not in this check" }),
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/navigation", navigation],
  ["@/lib/session", session],
  ["@/lib/email", email],
  ["@/lib/calendar/meetings", fakeMeetings],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/navigation"), navigation],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("../src/lib/email"), email],
  [load.resolve("../src/lib/calendar/meetings"), fakeMeetings],
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

// ── The pure part ───────────────────────────────────────────────────────────────────────────────

const ONB = "pip_onb";
const stage = (id: string, pipelineId: string, label: string, status: LeadStageDef["status"], archived = false, requiredFields: string[] = []): LeadStageDef => ({
  id,
  pipelineId,
  key: id,
  label,
  status,
  color: "default",
  archived,
  requiredFields,
});
const pipe = (id: string, name: string, sales: boolean, nextPipelineId: string | null = null, archived = false): PipelineDef => ({ id, key: id, name, sales, nextPipelineId, archived });

function pure() {
  section("Pipelines and their stages");
  const pipelines = [pipe(MAIN_PIPELINE_ID, "Sales", true, ONB), pipe(ONB, "Onboarding", false), pipe("pip_old", "Old", false, null, true)];
  ok("a pipeline needs a name, one not already used", checkPipeline({ name: " ", sales: false, nextPipelineId: null }, null, pipelines) !== null && /already a pipeline/.test(checkPipeline({ name: "onboarding", sales: false, nextPipelineId: null }, null, pipelines) ?? ""));
  ok("  the main one always counts as sales", /always counts as sales/.test(checkPipeline({ name: "Sales", sales: false, nextPipelineId: null }, MAIN_PIPELINE_ID, pipelines) ?? ""));
  ok("  carries on only into one in use, never itself", /in use/.test(checkPipeline({ name: "X", sales: true, nextPipelineId: "pip_old" }, null, pipelines) ?? "") && /itself/.test(checkPipeline({ name: "Onboarding", sales: false, nextPipelineId: ONB }, ONB, pipelines) ?? ""));
  ok("  and never round in a circle", /circle/.test(checkPipeline({ name: "Onboarding", sales: false, nextPipelineId: MAIN_PIPELINE_ID }, ONB, pipelines) ?? ""), checkPipeline({ name: "Onboarding", sales: false, nextPipelineId: MAIN_PIPELINE_ID }, ONB, pipelines));
  ok("a process offers four meanings — start, under way, done, dropped", meaningsFor(false).map((m) => `${m.status}:${m.label}`).join() === "NEW:Start,CONTACTED:Under way,WON:Done,LOST:Dropped");
  ok("  and refuses a sales meaning", checkStage({ label: "Proposal", status: "PROPOSAL_SENT", color: "default" }, [], false) !== null && checkStage({ label: "Proposal", status: "PROPOSAL_SENT", color: "default" }, [], true) === null);
  const stages = [
    stage("s_new", MAIN_PIPELINE_ID, "New", "NEW"),
    stage("s_won", MAIN_PIPELINE_ID, "Won", "WON"),
    stage("o_new", ONB, "Start", "NEW"),
    stage("o_won", ONB, "Done", "WON"),
  ];
  ok("the stage for a meaning is looked up in one pipeline — the main one unless named", stageForStatus(stages, "NEW")?.id === "s_new" && stageForStatus(stages, "NEW", ONB)?.id === "o_new");
  ok("a lead with no stage shows its own pipeline's", stageOfLead(stages, { status: "WON", pipelineId: ONB }).id === "o_won" && stageOfLead(stages, { status: "WON" }).id === "s_won");
  ok("each pipeline keeps its own won stage", mustKeep(stages[1]!, stages) !== null && mustKeep(stages[3]!, stages, false)?.includes("finished") === true, mustKeep(stages[3]!, stages, false));

  section("A stage's rule");
  const proposal = stage("s_prop", MAIN_PIPELINE_ID, "Proposal sent", "PROPOSAL_SENT", false, ["estimatedValue", "expectedCloseDate", "cf:po_number"]);
  const bare = { estimatedValue: null, expectedCloseDate: null, contactId: null, ownerUserId: "u", description: null, customFields: {} };
  ok("a lead without what it asks for is missing each", missingForStage(proposal, bare).join() === "estimatedValue,expectedCloseDate,cf:po_number");
  ok("  a value of nothing is no value", missingForStage(proposal, { ...bare, estimatedValue: "0" }).includes("estimatedValue"));
  ok("  and with them, nothing", missingForStage(proposal, { ...bare, estimatedValue: "1200", expectedCloseDate: new Date(), customFields: { po_number: "PO-7" } }).length === 0);
  ok("the refusal says what to fill in", ruleRefusal("Proposal sent", ["Value", "Expected close date"]) === "Before Proposal sent, fill in Value and Expected close date.");

  section("What an automation may say");
  const people = new Set(["user_aaaaaaaa"]);
  const good = parseActions(
    [
      { type: "TASK", title: " Call {{contact}} ", dueInDays: 2, assignTo: "OWNER" },
      { type: "EMAIL", subject: "Hello", body: "Hi {{contact}}" },
      { type: "ASSIGN", userId: "RULES" },
      { type: "NOTIFY", to: "user_aaaaaaaa", message: "{{lead}} moved" },
    ],
    people,
  );
  ok("tasks, emails, assignments and notifications, checked and trimmed", good.ok && good.actions.length === 4 && good.actions[0]!.type === "TASK" && (good.actions[0] as { title: string }).title === "Call {{contact}}");
  ok("  nothing to do, too much, an unknown person, a negative due date: refused", [
    parseActions([], people),
    parseActions(Array.from({ length: 11 }, () => ({ type: "NOTIFY", to: "OWNER", message: "x" })), people),
    parseActions([{ type: "ASSIGN", userId: "user_zzzzzzzz" }], people),
    parseActions([{ type: "TASK", title: "x", dueInDays: -1, assignTo: "OWNER" }], people),
    parseActions([{ type: "SMS", to: "x" }], people),
  ].every((r) => !r.ok));
  ok("stored actions read back leniently — garbage runs nothing", storedActions("nope").length === 0 && storedActions([{ type: "NOTIFY", to: "OWNER", message: "hi" }]).length === 1);
  ok("merge fields filled, an unknown one left showing", mergeText("{{ contact }} at {{company}} {{nope}}", { lead: "L", company: "Acme", contact: "Ravi", owner: "", stage: "", pipeline: "", value: "" }) === "Ravi at Acme {{nope}}");
  ok("an email's text made safe HTML", textToHtml("a < b\n\nnew <p>") === "<p>a &lt; b</p>\n<p>new &lt;p&gt;</p>");
  ok("an action described in words", describeAction({ type: "TASK", title: "Call", dueInDays: 2, assignTo: "OWNER" }, () => "") === "Task “Call” for the owner, due in 2 days");

  section("Booking pages: the times offered");
  const india = clockFor("Asia/Kolkata");
  ok("hours are checked: a span ending before it starts, overlapping spans, a closed week", [
    parseHours({ "1": [["10:00", "09:00"]] }),
    parseHours({ "1": [["09:00", "12:00"], ["11:00", "13:00"]] }),
    parseHours({ "1": [] }),
    parseHours("nope"),
  ].every((r) => !r.ok) && parseHours(defaultHours()).ok);
  ok("a page needs an address, a title, a length it offers and a host", checkBookingPage({ slug: "ab", title: "Demo", description: "", durationMinutes: 30, hostUserIds: ["u"], daysAhead: 14, minNoticeHours: 4, bufferMinutes: 0 }) !== null && checkBookingPage({ slug: "demo", title: "Demo", description: "", durationMinutes: 25, hostUserIds: ["u"], daysAhead: 14, minNoticeHours: 4, bufferMinutes: 0 }) !== null && checkBookingPage({ slug: "demo", title: "Demo", description: "", durationMinutes: 30, hostUserIds: ["u"], daysAhead: 14, minNoticeHours: 4, bufferMinutes: 0 }) === null);
  // Monday 12 Oct 2026, 09:00 in India.
  const monday = new Date("2026-10-12T03:30:00.000Z");
  const rules = { hours: defaultHours(), durationMinutes: 30, bufferMinutes: 0, minNoticeHours: 2, daysAhead: 1 };
  const free = openSlots(rules, [], india, monday);
  ok("Monday from two hours on, every half hour to the last that ends by five; Tuesday from nine", free.length === 12 + 16 && india.dateTime(free[0]!).includes("11:00") && free[0]!.toISOString() === "2026-10-12T05:30:00.000Z", `${free.length} ${free[0]?.toISOString()}`);
  const busy = [{ start: new Date("2026-10-12T07:30:00.000Z"), end: new Date("2026-10-12T08:30:00.000Z") }]; // 13:00–14:00 IST
  const around = openSlots(rules, busy, india, monday).filter((s) => india.dateKey(s) === "2026-10-12").map((s) => india.parts(s).hour * 60 + india.parts(s).minute);
  ok("  less what the calendar shows busy", !around.includes(13 * 60) && !around.includes(13 * 60 + 30) && around.includes(12 * 60 + 30) && around.includes(14 * 60));
  const buffered = openSlots({ ...rules, bufferMinutes: 15 }, busy, india, monday).filter((s) => india.dateKey(s) === "2026-10-12").map((s) => india.parts(s).hour * 60 + india.parts(s).minute);
  ok("  and the gap asked for kept clear either side", !buffered.includes(12 * 60 + 30) && !buffered.includes(14 * 60) && buffered.includes(14 * 60 + 30));
  const friday = new Date("2026-10-16T03:30:00.000Z");
  ok("  never on a closed day", openSlots({ ...rules, daysAhead: 3 }, [], india, friday).every((s) => ![0, 6].includes(india.parts(s).weekday)));
  const a = new Date("2026-10-13T04:30:00.000Z");
  ok("a booking goes to the host free then with fewest coming up", pickHost(a, [{ id: "x", slots: [a], upcoming: 3 }, { id: "y", slots: [a], upcoming: 1 }, { id: "z", slots: [], upcoming: 0 }]) === "y" && pickHost(new Date(0), [{ id: "x", slots: [a], upcoming: 0 }]) === null);
  ok("  and a page offers each time once", pageSlots([{ slots: [a, free[0]!] }, { slots: [a] }]).length === 2);

  section("The product");
  const plan = (key: string, productKey: string): ChoicePlan => ({ key, name: productByKey(productKey as "crm")!.name, kind: "EDITION", productKey, modules: [] });
  ok("Deskzo Pipeline is sold on its own", productRefusal([plan("deskzo-pipeline", "pipeline")]) === null);
  ok("  never with Deskzo CRM, which holds all of it", productRefusal([plan("deskzo-crm", "crm"), plan("deskzo-pipeline", "pipeline")]) === "Deskzo CRM already includes everything in Deskzo Pipeline — choose one of them.");
  ok("  and beside another product it doesn't overlap", productRefusal([plan("deskzo-pipeline", "pipeline"), plan("deskzo-desk", "desk")]) === null);
  const pipelineModules = productByKey("pipeline")!.modules;
  ok(
    "a workspace on its plan, with only what it sells, gets the simple menu",
    simpleMenuFor([...pipelineModules, "tasks", "notes"], ["deskzo-pipeline"]) && !simpleMenuFor([...pipelineModules, "visits"], ["deskzo-pipeline", "deskzo-crm"]) && !simpleMenuFor(["workspace"], ["zz-crm"]),
  );
  const simpleNav = buildNavigation({ openModules: ["companies", "contacts_library", "calls", "forms", "booking", "workspace"], permissions: ["leads.view", "contacts.view", "calls.view", "booking.manage"], country: "IN", simple: true });
  ok("  one short list, the pipeline first", simpleNav.filter((s) => !s.system).length === 1 && simpleNav[0]!.items[0]!.href === "/leads", simpleNav[0]?.items.map((i) => i.href).join(" "));
  const fullNav = buildNavigation({ openModules: ["companies", "contacts_library", "calls", "forms", "booking", "workspace"], permissions: ["leads.view", "contacts.view", "calls.view", "booking.manage"], country: "IN" });
  ok("  while everybody else's is as it was", fullNav.filter((s) => !s.system).length > 1);
}

// ── The scratch database ────────────────────────────────────────────────────────────────────────

async function main() {
  pure();

  const realUrl = process.env.DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);

  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_teampipes`;
  const scratchUrl = withDatabase(realUrl, scratchName);

  const real = directClient(realUrl, { max: 1 });
  const realBefore = await snapshot(real);

  const admin = directClient(withDatabase(realUrl, "postgres"), { max: 1 });
  let closeAll: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60 * 1000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);

    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = "";

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    closeAll = () => db.$disconnect();
    /* eslint-enable @typescript-eslint/no-require-imports */
    await run(scratchUrl);
  } finally {
    await closeAll?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const gone = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratchName}'`);
    ok("the scratch database is dropped", Number(gone[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  section("The real workspace was not touched");
  const realAfter = await snapshot(real);
  await real.$disconnect();
  ok("its leads and companies are as they were", realAfter.counts === realBefore.counts, realAfter.counts);
  ok("  and nothing of this suite's is in it", realAfter.tagged === 0 && realBefore.tagged === 0, realAfter.tagged);

  console.log(failures === 0 ? `\nAll ${passes} team pipeline checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** What the suite must never change in the real workspace. Read-only. */
async function snapshot(client: PrismaClient) {
  const [leads, companies, tagged] = await Promise.all([client.lead.count(), client.company.count(), client.company.count({ where: { name: { startsWith: TAG } } })]);
  return { counts: JSON.stringify({ leads, companies }), tagged };
}

// ── The suite ───────────────────────────────────────────────────────────────────────────────────

async function run(scratchUrl: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const leads = require("../src/actions/lead") as typeof import("../src/actions/lead");
  const settings = require("../src/actions/pipeline") as typeof import("../src/actions/pipeline");
  const automationsActions = require("../src/actions/pipeline-automations") as typeof import("../src/actions/pipeline-automations");
  const booking = require("../src/actions/booking") as typeof import("../src/actions/booking");
  const bookingPublic = require("../src/actions/booking-public") as typeof import("../src/actions/booking-public");
  const bookingServer = require("../src/lib/booking/server") as typeof import("../src/lib/booking/server");
  const server = require("../src/lib/pipeline/server") as typeof import("../src/lib/pipeline/server");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const tenant = {
    id: randomUUID(),
    slug: "zzteam",
    name: "zzteam",
    status: "ACTIVE" as const,
    dbUrl: scratchUrl,
    primaryHost: "zzteam.localhost",
    hosts: ["zzteam.localhost"],
    source: "env" as const,
    isDefault: false,
    keyBundleCipher: null,
    country: "IN",
    entitlements: { v: 1 as const, all: true, modules: [], seats: null, copilotTokens: null, customDomains: null, plans: [] },
    holdReason: null,
  };

  await runAsTenant(tenant, async () => {
    section("Fixture");
    const user = (key: string, grants: Record<string, boolean>, extra: { isSuperAdmin?: boolean; role?: string } = {}) =>
      db.user.create({
        data: {
          name: `${TAG} ${key}`,
          email: `${TAG.toLowerCase()}-${key.toLowerCase()}@example.test`,
          passwordHash: "!",
          role: extra.role ?? "PROFILE",
          isSuperAdmin: extra.isSuperAdmin ?? false,
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
        select: { id: true, name: true, email: true, role: true },
      });
    const owner = await user("Owner", {}, { isSuperAdmin: true, role: "ADMIN" });
    const manager = await user("Manager", { "pipeline.manage": true, "booking.manage": true, "leads.view": true, "companies.viewAll": true });
    const rep = await user("Rep", { "pipeline.manage": false, "booking.manage": false, "leads.view": true, "companies.viewAll": true });
    const onboarder = await user("Onboarder", { "leads.view": true, "companies.viewAll": true });
    const as = (u: { id: string; name: string; email: string; role: string }) => {
      actor = u;
    };
    const acme = await db.company.create({
      data: { name: `${TAG} Acme Builders`, normalizedName: `${TAG} acme builders`.toLowerCase(), createdById: owner.id, ownerUserId: rep.id, stage: "PROSPECT" },
      select: { id: true },
    });
    const ravi = await db.contact.create({ data: { companyId: acme.id, name: `${TAG} Ravi`, email: "ravi@acme.example", createdByUserId: owner.id }, select: { id: true } });
    ok("a manager who shapes the pipelines, a rep, an onboarding lead and a customer to sell to", !!manager && !!acme.id && !!ravi.id);

    section("The migration");
    const main = await db.leadPipeline.findUnique({ where: { id: MAIN_PIPELINE_ID } });
    ok("makes the main pipeline, sales", main?.key === "sales" && main.sales && main.archivedAt === null);
    ok("  and puts every stage in it", (await db.leadStage.count({ where: { pipelineId: { not: MAIN_PIPELINE_ID } } })) === 0 && (await db.leadStage.count()) === 9);

    section("Pipelines");
    as(rep);
    ok("only somebody who may shape the pipeline adds one", !(await settings.savePipeline({ name: "Onboarding", sales: false })).ok);
    as(manager);
    const made = await settings.savePipeline({ name: "Onboarding", sales: false });
    ok("a pipeline that isn't sales is added", made.ok, errorOf(made));
    const onboardingId = made.ok ? made.data.id : "";
    const onbStages = await db.leadStage.findMany({ where: { pipelineId: onboardingId }, orderBy: { sortOrder: "asc" }, select: { id: true, label: true, status: true } });
    ok("  starting with a process's four stages", onbStages.map((s) => `${s.label}:${s.status}`).join() === "Start:NEW,Under way:CONTACTED,Done:WON,Dropped:LOST", onbStages.map((s) => s.label).join(", "));
    ok("  its name unique", !(await settings.savePipeline({ name: "onboarding", sales: true })).ok);
    ok("  a sales meaning refused on its stages", !(await settings.saveLeadStage({ pipelineId: onboardingId, label: "Quote", status: "PROPOSAL_SENT", color: "blue" })).ok);
    const connect = await settings.savePipeline({ id: MAIN_PIPELINE_ID, name: "Sales", sales: true, nextPipelineId: onboardingId });
    ok("Sales carries its won leads on into Onboarding", connect.ok && (await db.leadPipeline.findUnique({ where: { id: MAIN_PIPELINE_ID } }))?.nextPipelineId === onboardingId, errorOf(connect));
    ok("  and Onboarding can't carry back into Sales", /circle/.test(errorOf(await settings.savePipeline({ id: onboardingId, name: "Onboarding", sales: false, nextPipelineId: MAIN_PIPELINE_ID })) ?? ""));
    ok("  the main one never stops being sales", !(await settings.savePipeline({ id: MAIN_PIPELINE_ID, name: "Sales", sales: false })).ok);

    section("A stage's rule");
    const proposal = await db.leadStage.findFirstOrThrow({ where: { pipelineId: MAIN_PIPELINE_ID, status: "PROPOSAL_SENT" }, select: { id: true, label: true, status: true, color: true } });
    const rule = await settings.saveLeadStage({ id: proposal.id, label: proposal.label, status: proposal.status, color: proposal.color, requiredFields: ["estimatedValue", "expectedCloseDate"] });
    ok("Proposal sent asks for a value and a close date first", rule.ok && (await db.leadStage.findUniqueOrThrow({ where: { id: proposal.id }, select: { requiredFields: true } })).requiredFields.join() === "estimatedValue,expectedCloseDate", errorOf(rule));
    ok("  only the fields there are", !(await settings.saveLeadStage({ id: proposal.id, label: proposal.label, status: proposal.status, color: proposal.color, requiredFields: ["cf:nothing_here"] })).ok);

    section("Automations");
    const wonStage = await db.leadStage.findFirstOrThrow({ where: { pipelineId: MAIN_PIPELINE_ID, status: "WON" }, select: { id: true } });
    const onWin = await automationsActions.saveAutomation({
      pipelineId: MAIN_PIPELINE_ID,
      name: "Won: kick-off",
      trigger: "STAGE_ENTERED",
      stageId: wonStage.id,
      actions: [
        { type: "TASK", title: "Kick-off with {{company}}", dueInDays: 2, assignTo: "OWNER" },
        { type: "NOTIFY", to: "OWNER", message: "{{lead}} is won" },
      ],
    });
    const onArrive = await automationsActions.saveAutomation({
      pipelineId: onboardingId,
      name: "Onboard",
      trigger: "LEAD_CREATED",
      actions: [
        { type: "ASSIGN", userId: onboarder.id },
        { type: "TASK", title: "Onboard {{company}} ({{pipeline}})", dueInDays: 0, assignTo: "OWNER" },
        { type: "EMAIL", subject: "Welcome, {{contact}}", body: "Hello {{contact}}" },
      ],
    });
    ok("an automation on entering a stage, and one on arriving", onWin.ok && onArrive.ok, `${errorOf(onWin)} ${errorOf(onArrive)}`);
    ok("  a stage of another pipeline refused", !(await automationsActions.saveAutomation({ pipelineId: onboardingId, name: "x", trigger: "STAGE_ENTERED", stageId: wonStage.id, actions: [{ type: "NOTIFY", to: "OWNER", message: "x" }] })).ok);
    as(rep);
    ok("  only a pipeline manager makes them", !(await automationsActions.saveAutomation({ pipelineId: onboardingId, name: "x", trigger: "LEAD_CREATED", actions: [{ type: "NOTIFY", to: "OWNER", message: "x" }] })).ok);

    section("A lead moving through Sales");
    as(rep);
    const created = await leads.createLead({ companyId: acme.id, contactId: ravi.id, title: `${TAG} Office fit-out`, ownerUserId: rep.id });
    ok("made in the main pipeline, at its first stage", created.ok, errorOf(created));
    const leadId = created.ok ? created.data.id : "";
    const place = await db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { pipelineId: true, stageId: true, status: true } });
    ok("  written with its pipeline", place.pipelineId === MAIN_PIPELINE_ID && place.stageId === "lstg_new" && place.status === "NEW");
    const blocked = await leads.updateLeadStatus({ leadId, stageId: proposal.id });
    ok("Proposal sent refuses it until it has a value and a close date", !blocked.ok && errorOf(blocked) === "Before Proposal sent, fill in Value and Expected close date.", errorOf(blocked));
    const edited = await leads.updateLeadDetails({ leadId, title: `${TAG} Office fit-out`, estimatedValue: 250000, expectedCloseDate: "2026-12-15", contactId: ravi.id });
    ok("  edited from the lead", edited.ok && Number((await db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { estimatedValue: true } })).estimatedValue) === 250000, errorOf(edited));
    ok("  then it moves", (await leads.updateLeadStatus({ leadId, stageId: proposal.id })).ok && (await db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { status: true } })).status === "PROPOSAL_SENT");
    ok("another pipeline's stage is a move between pipelines, refused here", /stage of Onboarding/.test(errorOf(await leads.updateLeadStatus({ leadId, stageId: onbStages[1]!.id })) ?? ""));

    section("Won in Sales, carried on into Onboarding");
    const won = await leads.updateLeadStatus({ leadId, stageId: wonStage.id });
    ok("won", won.ok, errorOf(won));
    ok("  its company a customer — Sales counts as sales", (await db.company.findUniqueOrThrow({ where: { id: acme.id }, select: { stage: true } })).stage === "CUSTOMER");
    const next = await db.lead.findFirst({ where: { fromLeadId: leadId }, select: { id: true, pipelineId: true, stageId: true, status: true, companyId: true, contactId: true, estimatedValue: true, ownerUserId: true } });
    ok("a new lead in Onboarding, at Start", next?.pipelineId === onboardingId && next.stageId === onbStages[0]!.id && next.status === "NEW", JSON.stringify(next));
    ok("  with the same company, contact and value", next?.companyId === acme.id && next.contactId === ravi.id && Number(next.estimatedValue) === 250000);
    ok("  the won lead noting where it went", (await db.activity.count({ where: { leadId, type: "NOTE", notes: { contains: "Carried on into Onboarding" } } })) === 1);
    const kickOff = await db.task.findFirst({ where: { leadId, title: `Kick-off with ${TAG} Acme Builders` }, select: { assignedToUserId: true } });
    ok("Won's automation: a task for the owner, named for the company", kickOff?.assignedToUserId === rep.id, JSON.stringify(kickOff));
    ok("  and a notification", (await db.notification.count({ where: { userId: rep.id, type: "LEAD_ACTIVITY", title: "Won: kick-off" } })) === 1);
    const handed = await db.lead.findUniqueOrThrow({ where: { id: next!.id }, select: { ownerUserId: true, assignmentNote: true } });
    ok("Onboarding's automation on arriving: given to the onboarder", handed.ownerUserId === onboarder.id && /Automation: Onboard/.test(handed.assignmentNote ?? ""), handed.assignmentNote);
    ok("  a task for them, the pipeline's name filled in", (await db.task.count({ where: { leadId: next?.id, title: `Onboard ${TAG} Acme Builders (Onboarding)`, assignedToUserId: onboarder.id } })) === 1);
    const arriveRow = await db.pipelineAutomation.findFirstOrThrow({ where: { pipelineId: onboardingId, name: "Onboard" }, select: { runs: true, lastError: true } });
    ok("  and the email it couldn't send noted on it — nobody's mailbox is connected", arriveRow.runs === 1 && /No email/.test(arriveRow.lastError ?? ""), arriveRow.lastError);
    // Reopened and won again: no second onboarding.
    const negotiation = await db.leadStage.findFirstOrThrow({ where: { pipelineId: MAIN_PIPELINE_ID, status: "NEGOTIATION" }, select: { id: true } });
    await leads.updateLeadStatus({ leadId, stageId: negotiation.id });
    await leads.updateLeadStatus({ leadId, stageId: wonStage.id });
    ok("won again after reopening: carried on only once", (await db.lead.count({ where: { fromLeadId: leadId } })) === 1);
    as(onboarder);
    const done = await leads.updateLeadStatus({ leadId: next!.id, stageId: onbStages[2]!.id });
    ok("done in Onboarding", done.ok, errorOf(done));
    const sales = await server.salesLeads();
    ok("  which counts as no sale: only the Sales win is a won sale", (await db.lead.count({ where: { AND: [{ status: "WON" }, sales] } })) === 1 && (await db.lead.count({ where: { status: "WON" } })) === 2);
    as(rep);
    const connections = await leads.leadConnections(leadId);
    ok("the lead's page names where it carried on to", connections?.into.length === 1 && connections.into[0]!.pipeline === "Onboarding" && connections.multi);

    section("Moving between pipelines, and the board");
    const prospect = await db.company.create({ data: { name: `${TAG} Beta Traders`, normalizedName: `${TAG} beta traders`.toLowerCase(), createdById: owner.id, ownerUserId: rep.id, stage: "PROSPECT" }, select: { id: true } });
    const other = await leads.createLead({ companyId: prospect.id, title: `${TAG} Partner enquiry`, ownerUserId: rep.id });
    const otherId = other.ok ? other.data.id : "";
    const moved = await leads.moveLeadToPipeline({ leadId: otherId, pipelineId: onboardingId, stageId: onbStages[1]!.id });
    const after = await db.lead.findUniqueOrThrow({ where: { id: otherId }, select: { pipelineId: true, status: true, stageId: true } });
    ok("an open lead moved to another pipeline's stage", moved.ok && after.pipelineId === onboardingId && after.status === "CONTACTED" && after.stageId === onbStages[1]!.id, errorOf(moved));
    ok("  with a note naming both", (await db.activity.count({ where: { leadId: otherId, type: "STAGE_CHANGE", notes: { contains: "moved from Sales to Onboarding" } } })) === 1);
    ok("  a won lead stays where it closed", !(await leads.moveLeadToPipeline({ leadId, pipelineId: onboardingId })).ok);
    const legacy = await db.lead.create({ data: { companyId: prospect.id, title: `${TAG} Written before pipelines`, status: "NEW" }, select: { id: true } });
    const salesBoard = await leads.listLeadsPaged({ pipeline: "sales", page: 1, pageSize: 50 });
    const onbBoard = await leads.listLeadsPaged({ pipeline: "onboarding", page: 1, pageSize: 50 });
    ok("the board shows one pipeline: Sales holds leads written before there were several", salesBoard.rows.some((r) => r.id === legacy.id) && salesBoard.rows.some((r) => r.id === leadId) && !salesBoard.rows.some((r) => r.id === otherId));
    ok("  Onboarding its own", onbBoard.rows.length === 2 && onbBoard.rows.some((r) => r.id === otherId) && onbBoard.rows.some((r) => r.id === next!.id));
    ok("  a pipeline that isn't there shows nothing", (await leads.listLeadsPaged({ pipeline: "nope", page: 1, pageSize: 50 })).total === 0);

    section("Retiring a pipeline");
    as(manager);
    ok("not while it holds open leads", /open lead/.test(errorOf(await settings.retirePipeline(onboardingId)) ?? ""));
    as(rep);
    const finished = await leads.updateLeadStatus({ leadId: otherId, stageId: onbStages[2]!.id });
    ok("done in a pipeline that isn't sales makes nobody a customer", finished.ok && (await db.company.findUniqueOrThrow({ where: { id: prospect.id }, select: { stage: true } })).stage !== "CUSTOMER", errorOf(finished));
    as(manager);
    const retired = await settings.retirePipeline(onboardingId);
    ok("retired once they are closed", retired.ok, errorOf(retired));
    ok("  Sales no longer carries on into it, and its automations are off", (await db.leadPipeline.findUniqueOrThrow({ where: { id: MAIN_PIPELINE_ID } })).nextPipelineId === null && (await db.pipelineAutomation.count({ where: { pipelineId: onboardingId, active: true } })) === 0);
    ok("  a lead can't be made in it", !(await leads.createLead({ companyId: prospect.id, title: `${TAG} late`, pipelineId: onboardingId })).ok);
    ok("  the main one can't be retired", !(await settings.retirePipeline(MAIN_PIPELINE_ID)).ok);
    ok("  and it comes back when restored", (await settings.restorePipeline(onboardingId)).ok);

    section("Booking pages");
    const hostUser = await user("Host", { "leads.view": true });
    await db.calendarAccount.create({ data: { userId: hostUser.id, provider: "MICROSOFT" } });
    const page = {
      slug: "zz-demo",
      title: "Product demo",
      description: "Half an hour, on your screen.",
      durationMinutes: 30,
      hostUserIds: [hostUser.id],
      hours: { "1": [["09:00", "17:00"]], "2": [["09:00", "17:00"]], "3": [["09:00", "17:00"]], "4": [["09:00", "17:00"]], "5": [["09:00", "17:00"]], "6": [], "7": [] },
      daysAhead: 7,
      minNoticeHours: 2,
      bufferMinutes: 0,
      online: true,
      pipelineId: MAIN_PIPELINE_ID,
      active: true,
    };
    as(rep);
    ok("only somebody who may manage booking pages makes one", !(await booking.saveBookingPage(page)).ok);
    as(manager);
    ok("  a host must have a calendar connected", !(await booking.saveBookingPage({ ...page, hostUserIds: [rep.id] })).ok);
    const saved = await booking.saveBookingPage(page);
    ok("a page made", saved.ok, errorOf(saved));
    ok("  its address can't be taken twice", !(await booking.saveBookingPage({ ...page, title: "Another" })).ok);
    // Monday 2 Nov 2026, 09:00 in India — ahead of the real clock, so what the staff page lists (from yesterday on) includes it.
    const monday = new Date("2026-11-02T03:30:00.000Z");
    // The host is busy 13:00–14:00 on Monday in their calendar.
    await db.calendarEvent.create({ data: { userId: hostUser.id, provider: "MICROSOFT", externalId: "zz-busy", title: "Busy", startsAt: new Date("2026-11-02T07:30:00.000Z"), endsAt: new Date("2026-11-02T08:30:00.000Z") } });
    const open = await bookingServer.publicBookingPage("zz-demo", monday);
    const mondayTimes = open?.days.find((d) => d.day === "2026-11-02")?.slots ?? [];
    ok("the public page offers its hours less what the calendar shows busy", !!open && mondayTimes.length === 10 && !mondayTimes.includes("2026-11-02T07:30:00.000Z") && mondayTimes[0] === "2026-11-02T05:30:00.000Z", `${mondayTimes.length} ${mondayTimes[0]}`);
    ok("  and not a page there isn't", (await bookingServer.publicBookingPage("zz-nope", monday)) === null);
    const slot = "2026-11-03T04:30:00.000Z"; // Tuesday 10:00 IST
    const booked = await bookingServer.bookSlot("zz-demo", { start: slot, name: "Meera Shah", email: "Meera@Gamma.example", company: `${TAG} Gamma Labs`, notes: "About the CRM" }, "198.51.100.7", monday);
    ok("a time booked", booked.ok && booked.host === `${TAG} Host`, JSON.stringify(booked));
    const row = await db.booking.findFirst({ where: { pageId: saved.ok ? saved.data.id : "" }, select: { hostUserId: true, email: true, leadId: true, calendarEventId: true, status: true } });
    const bookedLead = row?.leadId ? await db.lead.findUnique({ where: { id: row.leadId }, select: { ownerUserId: true, pipelineId: true, title: true, company: { select: { name: true } } } }) : null;
    ok("  kept, its email in lower case, the meeting's id with it", row?.status === "CONFIRMED" && row.email === "meera@gamma.example" && row.calendarEventId === "zz-event-1");
    ok("  a lead opened in the page's pipeline, owned by the host", bookedLead?.ownerUserId === hostUser.id && bookedLead.pipelineId === MAIN_PIPELINE_ID && bookedLead.company.name === `${TAG} Gamma Labs`, JSON.stringify(bookedLead));
    ok("  a meeting in the host's calendar with the customer invited", meetings.length === 1 && meetings[0]!.userId === hostUser.id && meetings[0]!.attendees[0]?.email === "meera@gamma.example" && meetings[0]!.startsAt.toISOString() === slot);
    ok("the same time can't be taken twice", !(await bookingServer.bookSlot("zz-demo", { start: slot, name: "Late", email: "late@example.test" }, "203.0.113.9", monday)).ok);
    ok("  nor one the page doesn't offer", !(await bookingServer.bookSlot("zz-demo", { start: "2026-11-07T04:30:00.000Z", name: "Saturday", email: "sat@example.test" }, "203.0.113.9", monday)).ok);
    const later = ["2026-11-03T05:30:00.000Z", "2026-11-03T06:00:00.000Z", "2026-11-03T06:30:00.000Z", "2026-11-03T07:00:00.000Z", "2026-11-03T07:30:00.000Z"];
    const results = [];
    for (const [i, start] of later.entries()) results.push(await bookingServer.bookSlot("zz-demo", { start, name: `Repeat ${i}`, email: `repeat${i}@example.test` }, "198.51.100.7", monday));
    ok("one place booking again and again is told to wait", results.slice(0, 4).every((r) => r.ok) && !results[4]!.ok && /Too many/.test(results[4]!.ok ? "" : results[4]!.error), results.map((r) => (r.ok ? "ok" : r.error)).join(" | "));
    ok("a robot filling the field nobody sees is thanked and dropped", (await bookingPublic.makeBooking("zz-demo", { start: "2026-11-04T04:30:00.000Z", name: "Bot", email: "bot@example.test", website: "http://spam" })).ok && (await db.booking.count({ where: { email: "bot@example.test" } })) === 0);
    const listed = await booking.listBookingPages();
    ok("the staff page lists the page and its bookings", !!listed && listed.pages.length === 1 && listed.bookings.length === 5 && listed.hosts.some((h) => h.id === hostUser.id));

    // ── Between the deploy and tenants:migrate ─────────────────────────────────────────────────
    section("A workspace still waiting for the team pipelines");
    await db.$executeRawUnsafe(`DROP TABLE "pipeline_automations", "bookings", "booking_pages"`);
    await db.$executeRawUnsafe(`ALTER TABLE "leads" DROP COLUMN "pipelineId", DROP COLUMN "fromLeadId"`);
    await db.$executeRawUnsafe(`ALTER TABLE "lead_stages" DROP COLUMN "pipelineId", DROP COLUMN "requiredFields"`);
    await db.$executeRawUnsafe(`DROP TABLE "lead_pipelines"`);
    await db.$executeRawUnsafe(`CREATE UNIQUE INDEX "lead_stages_key_key" ON "lead_stages"("key")`).catch(() => {});
    const waiting = await server.leadStages();
    ok("it has the one pipeline, its stages as they were", !waiting.multi && waiting.stored && waiting.pipelines.length === 1 && waiting.stages.every((s) => s.pipelineId === MAIN_PIPELINE_ID));
    as(rep);
    const during = await leads.createLead({ companyId: prospect.id, title: `${TAG} During the deploy` });
    ok("  a lead is added, with no automation to run", during.ok, errorOf(during));
    const duringMove = during.ok ? await leads.updateLeadStatus({ leadId: during.data.id, status: "CONTACTED" }) : during;
    ok("  and moved, as before", duringMove.ok, errorOf(duringMove));
    ok("  the board still lists the main pipeline", (await leads.listLeadsPaged({ pipeline: "sales", page: 1, pageSize: 50 })).rows.some((r) => during.ok && r.id === during.data.id));
    as(manager);
    const screen = await settings.listPipelineForManage();
    ok("  settings show the stages, and adding a pipeline says to wait", screen?.multi === false && !(await settings.savePipeline({ name: "Later", sales: true })).ok);
    ok("  automations and booking pages say to wait too", (await automationsActions.listAutomationsForManage())?.ready === false && (await booking.listBookingPages())?.ready === false);
    ok("  and a booking page is simply not there", (await bookingServer.publicBookingPage("zz-demo")) === null);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
