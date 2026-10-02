/**
 * check:pipeline — the workspace's own lead pipeline (owner, 2 Oct 2026): Settings → Pipeline, and leads
 * moving through its stages (src/lib/pipeline, src/actions/pipeline.ts, `updateLeadStatus`).
 *
 * The pure part needs no database: the stages every workspace starts with, which stage a lead shows,
 * the rules for shaping a pipeline, and the history a move leaves — still readable by the forecast,
 * which learns from it, and by the wins it finds.
 *
 * The rest builds a scratch workspace database beside the real one (as check:custom-fields does),
 * drives the real actions as a workspace pointed at it (`runAsTenant`), and drops it at the end:
 *
 *   · the migration: nine stages seeded, every lead placed in the one its status names and dated from
 *     its history;
 *   · settings: only `pipeline.manage` shapes it; where a new stage goes; names unique; the last stage
 *     for new, won or lost leads kept; a stage with leads changing meaning only within open ones, its
 *     leads following with a note; retiring with leads moved on (a won lead's date untouched); restore;
 *     delete only when empty;
 *   · leads: created in the first "new" stage; moved by stage, the status following its meaning; a
 *     move to where it already is changes nothing; the old status-only callers still landing right;
 *     qualified credit, a won stage making the company a customer, a reason for a lost one; out of
 *     scope refused; the bulk bar;
 *   · a workspace still waiting for the migration: everything works as before, on the old stages;
 *   · and the real workspace untouched.
 *
 *   npm run check:pipeline
 */
import "dotenv/config";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import {
  checkStage,
  defaultStages,
  mustKeep,
  readStageNote,
  rehomeTargets,
  stageChangeNote,
  stageOfLead,
  type LeadStageDef,
} from "../src/lib/pipeline/rules";
import { parseStageChange } from "../src/lib/forecast/stages";

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

const TAG = "ZZPIPE";

// ── Who the actions think is calling ────────────────────────────────────────────────────────────

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
const viewMode = { getViewMode: async () => "list" as const, setViewMode: async () => {} };
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/navigation", navigation],
  ["@/lib/session", session],
  ["@/lib/email", email],
  ["@/actions/view-mode", viewMode],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/navigation"), navigation],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("../src/lib/email"), email],
  [load.resolve("../src/actions/view-mode"), viewMode],
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

const stage = (id: string, label: string, status: LeadStageDef["status"], archived = false): LeadStageDef => ({ id, key: id, label, status, color: "default", archived });

function pure() {
  section("The stages every workspace starts with");
  const d = defaultStages();
  ok(
    "the nine it always had, in order, under the ids the migration seeds",
    d.map((s) => s.id).join() === "lstg_new,lstg_contacted,lstg_qualifying,lstg_qualified,lstg_proposal_sent,lstg_negotiation,lstg_won,lstg_lost,lstg_disqualified",
  );
  ok("  each counting as what it is called", d.every((s) => s.key === s.status.toLowerCase()) && d[4]!.label === "Proposal sent");

  section("Which stage a lead shows");
  const enquiry = stage("s1", "Enquiry", "NEW");
  const site = stage("s2", "Site visit", "QUALIFYING");
  const demo = stage("s3", "Demo", "QUALIFYING");
  const quotation = stage("s4", "Quotation", "PROPOSAL_SENT");
  const booked = stage("s5", "Booked", "WON");
  const lost = stage("s6", "Lost", "LOST");
  const old = stage("s7", "Old qualifying", "QUALIFYING", true);
  const custom = [enquiry, site, demo, quotation, booked, lost, old];
  ok("its own, while that still means the lead's status", stageOfLead(custom, { status: "QUALIFYING", stageId: "s3" }).id === "s3");
  ok(
    "  otherwise the first stage in use with the status's meaning",
    stageOfLead(custom, { status: "QUALIFYING", stageId: null }).id === "s2" && stageOfLead(custom, { status: "QUALIFYING", stageId: "s5" }).id === "s2",
  );
  ok("  and a stand-in named for the status where the pipeline has none", stageOfLead(custom, { status: "NEGOTIATION" }).label === "Negotiation");

  section("Shaping a pipeline");
  const input = (label: string) => ({ label, status: "QUALIFYING" as const, color: "blue" as const });
  ok(
    "a stage needs a name, short enough, not one already in use",
    checkStage(input(" "), custom) !== null && checkStage(input("x".repeat(41)), custom) !== null && checkStage(input("site VISIT"), custom) !== null && checkStage(input("Survey"), custom) === null,
  );
  ok("  a retired stage's name is free again", checkStage(input("Old qualifying"), custom) === null);
  ok(
    "the only stage for new, won or lost leads has to stay; one of two may go",
    mustKeep(enquiry, custom) !== null && mustKeep(booked, custom) !== null && mustKeep(lost, custom) !== null && mustKeep(site, custom) === null,
  );
  ok(
    "a retired stage's leads go to one of the same kind, never closing or reopening a deal",
    rehomeTargets(site, custom).map((s) => s.id).join() === "s1,s3,s4" && rehomeTargets(booked, custom).length === 0,
  );

  section("The history a move leaves");
  const note = stageChangeNote(site, quotation, null);
  const parsed = parseStageChange(note);
  ok("begins as a stage change always has, so the forecast still learns from it", parsed?.from === "QUALIFYING" && parsed.to === "PROPOSAL_SENT", note);
  ok("  and a win is still found by its “ to WON”", stageChangeNote(quotation, booked).includes(" to WON"));
  ok("reads as the stages' own names", readStageNote(note, custom) === "Moved from Site visit to Quotation");
  ok("  with the reason after it", readStageNote(stageChangeNote(quotation, lost, "Went with a cheaper quote"), custom) === "Moved from Quotation to Lost: Went with a cheaper quote");
  ok(
    "an older note reads with the workspace's names for its meanings",
    readStageNote("Status changed from NEW to PROPOSAL_SENT: budget", custom) === "Moved from Enquiry to Quotation: budget",
  );
  ok("  anything else as written", readStageNote("Called back, wants a demo", custom) === "Called back, wants a demo");
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
  const scratchName = `${realName}_pipeline`;
  const scratchUrl = withDatabase(realUrl, scratchName);
  ok("  and it is not the real one", scratchName !== realName, scratchName);

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

  console.log(failures === 0 ? `\nAll ${passes} pipeline checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
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
  const server = require("../src/lib/pipeline/server") as typeof import("../src/lib/pipeline/server");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const tenant = {
    id: randomUUID(),
    slug: "zzpipe",
    name: "zzpipe",
    status: "ACTIVE" as const,
    dbUrl: scratchUrl,
    primaryHost: "zzpipe.localhost",
    hosts: ["zzpipe.localhost"],
    source: "env" as const,
    isDefault: false,
    keyBundleCipher: null,
    country: "IN",
    entitlements: { v: 1 as const, all: true, modules: [], seats: null, copilotTokens: null, customDomains: null, plans: [] },
    holdReason: null,
  };

  await runAsTenant(tenant, async () => {
    // ── Fixture ────────────────────────────────────────────────────────────────────────────────
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
    const manager = await user("Manager", { "pipeline.manage": true, "leads.view": true, "companies.viewAll": true });
    const rep = await user("Rep", { "pipeline.manage": false, "leads.view": true, "companies.viewAll": false });
    const outsider = await user("Outsider", { "pipeline.manage": false, "leads.view": true, "companies.viewAll": false });
    const as = (u: { id: string; name: string; email: string; role: string }) => {
      actor = u;
    };
    const company = await db.company.create({
      data: { name: `${TAG} Acme Builders`, normalizedName: `${TAG} acme builders`.toLowerCase(), createdById: owner.id, ownerUserId: rep.id },
      select: { id: true },
    });
    ok("a manager who shapes the pipeline, a rep whose account it is, and an outsider", !!owner && !!company.id);
    const leadNow = (id: string) =>
      db.lead.findUniqueOrThrow({ where: { id }, select: { status: true, stageId: true, stageChangedAt: true, lostReason: true, qualifiedByUserId: true } });
    const notesOf = async (id: string) => (await db.activity.findMany({ where: { leadId: id, type: "STAGE_CHANGE" }, orderBy: { createdAt: "asc" }, select: { notes: true } })).map((a) => a.notes);

    // ── The migration ──────────────────────────────────────────────────────────────────────────
    section("The migration");
    const seeded = await db.leadStage.findMany({ orderBy: { sortOrder: "asc" } });
    ok("seeds the nine stages, under the ids the code knows", seeded.map((s) => s.id).join() === defaultStages().map((s) => s.id).join(), seeded.map((s) => s.label).join(", "));
    // Leads written as before stages existed, then the migration's own backfill run over them.
    const moved = new Date("2026-06-10T09:30:00.000Z");
    const before1 = await db.lead.create({ data: { companyId: company.id, title: `${TAG} Older qualified`, status: "QUALIFIED", createdAt: new Date("2026-05-01T09:30:00.000Z") }, select: { id: true } });
    await db.activity.create({ data: { leadId: before1.id, userId: rep.id, type: "STAGE_CHANGE", notes: "Status changed from NEW to QUALIFIED", occurredAt: moved } });
    const before2 = await db.lead.create({ data: { companyId: company.id, title: `${TAG} Older new`, status: "NEW", createdAt: new Date("2026-05-02T09:30:00.000Z") }, select: { id: true } });
    const sql = readFileSync(join(process.cwd(), "prisma/migrations/20261015100000_lead_pipeline/migration.sql"), "utf8");
    const backfill = sql.slice(sql.indexOf('UPDATE "leads" SET "stageId"'));
    for (const statement of backfill.split(";").map((s) => s.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
    const b1 = await leadNow(before1.id);
    const b2 = await leadNow(before2.id);
    ok("places every lead in the stage its status names", b1.stageId === "lstg_qualified" && b2.stageId === "lstg_new", `${b1.stageId} ${b2.stageId}`);
    ok(
      "  dated from the last move in its history, or from when it was made",
      b1.stageChangedAt?.toISOString() === moved.toISOString() && b2.stageChangedAt?.toISOString() === "2026-05-02T09:30:00.000Z",
      `${b1.stageChangedAt?.toISOString()} ${b2.stageChangedAt?.toISOString()}`,
    );

    // ── Settings ───────────────────────────────────────────────────────────────────────────────
    section("Settings → Pipeline");
    as(rep);
    ok("a rep can't open it", (await settings.listPipelineForManage()) === null);
    const repAdd = await settings.saveLeadStage({ label: "Site visit", status: "QUALIFYING", color: "blue" });
    ok("  nor add a stage", !repAdd.ok, errorOf(repAdd));
    as(manager);
    const idOf = (r: Awaited<ReturnType<typeof settings.saveLeadStage>>) => (r.ok ? r.data.id : "");
    const order = async () => (await server.leadStages()).stages.filter((s) => !s.archived).map((s) => s.label);
    const siteVisit = idOf(await settings.saveLeadStage({ label: "Site visit", status: "QUALIFYING", color: "blue" }));
    let labels = await order();
    ok("a new open stage goes in before the won and lost ones", labels.indexOf("Site visit") === labels.indexOf("Won") - 1, labels.join(" → "));
    const booked = idOf(await settings.saveLeadStage({ label: "Booked", status: "WON", color: "green" }));
    labels = await order();
    ok("  a new won stage at the end", labels.at(-1) === "Booked", labels.join(" → "));
    const twice = await settings.saveLeadStage({ label: "site VISIT", status: "QUALIFIED", color: "amber" });
    ok("a name already in use is refused", !twice.ok, errorOf(twice));
    const renamed = await settings.saveLeadStage({ id: "lstg_new", label: "Enquiry", status: "NEW", color: "brand" });
    ok("a stage renamed and recoloured", renamed.ok && (await server.leadStages()).stages.find((s) => s.id === "lstg_new")?.label === "Enquiry", errorOf(renamed));
    await settings.moveLeadStage(siteVisit, "up");
    await settings.moveLeadStage(siteVisit, "up");
    labels = await order();
    ok("  moved up twice, it sits after Qualified", labels.indexOf("Site visit") === labels.indexOf("Qualified") + 1, labels.join(" → "));
    const lastLost = await settings.retireLeadStage("lstg_lost", null);
    ok("the only stage for lost leads can't be retired", !lastLost.ok && lastLost.error.includes("only stage for lost leads"), errorOf(lastLost));
    const lostToOpen = await settings.saveLeadStage({ id: "lstg_lost", label: "Lost", status: "NEGOTIATION", color: "red" });
    ok("  nor turned into something else", !lostToOpen.ok, errorOf(lostToOpen));

    // A stage with a lead in it changes meaning: within open ones only, the lead following with a note.
    const inQualifying = await db.lead.create({ data: { companyId: company.id, title: `${TAG} In qualifying`, status: "QUALIFYING", stageId: "lstg_qualifying" }, select: { id: true } });
    const toWon = await settings.saveLeadStage({ id: "lstg_qualifying", label: "Qualifying", status: "WON", color: "blue" });
    ok("a stage with leads can't become a won one — that would close deals in bulk", !toWon.ok, errorOf(toWon));
    const toNegotiation = await settings.saveLeadStage({ id: "lstg_qualifying", label: "Discovery", status: "NEGOTIATION", color: "blue" });
    const followed = await leadNow(inQualifying.id);
    const followedNotes = await notesOf(inQualifying.id);
    ok(
      "  but may count as another open meaning, its leads following with a note",
      toNegotiation.ok && followed.status === "NEGOTIATION" && followedNotes.length === 1 && parseStageChange(followedNotes[0]!)?.to === "NEGOTIATION",
      `${errorOf(toNegotiation)} ${followed.status} ${followedNotes.join(" | ")}`,
    );

    // Retiring: leads moved on first, a closed one's date untouched.
    const inContacted = await db.lead.create({ data: { companyId: company.id, title: `${TAG} In contacted`, status: "CONTACTED", stageId: "lstg_contacted" }, select: { id: true } });
    const wonAt = new Date("2026-07-01T06:30:00.000Z");
    const inWon = await db.lead.create({ data: { companyId: company.id, title: `${TAG} In won`, status: "WON", stageId: "lstg_won", stageChangedAt: wonAt }, select: { id: true } });
    const noTarget = await settings.retireLeadStage("lstg_contacted", null);
    ok("a stage with leads is retired only once you say where they go", !noTarget.ok, errorOf(noTarget));
    const wrongKind = await settings.retireLeadStage("lstg_contacted", booked);
    ok("  never to a closed stage", !wrongKind.ok, errorOf(wrongKind));
    const retired = await settings.retireLeadStage("lstg_contacted", siteVisit);
    const rehomed = await leadNow(inContacted.id);
    ok(
      "  to an open stage with another meaning: the lead moves and counts as it, with a note",
      retired.ok && rehomed.stageId === siteVisit && rehomed.status === "QUALIFYING" && (await notesOf(inContacted.id)).some((n) => n.includes("Contacted was retired")),
      `${errorOf(retired)} ${JSON.stringify(rehomed)}`,
    );
    const retiredWon = await settings.retireLeadStage("lstg_won", booked);
    const wonLead = await leadNow(inWon.id);
    ok(
      "retiring a won stage moves its deals to another won one, when they were won untouched and nothing logged",
      retiredWon.ok && wonLead.stageId === booked && wonLead.status === "WON" && wonLead.stageChangedAt?.toISOString() === wonAt.toISOString() && (await notesOf(inWon.id)).length === 0,
      `${errorOf(retiredWon)} ${JSON.stringify(wonLead)}`,
    );
    ok("  and the retired stages are no longer offered", !(await order()).includes("Contacted") && !(await order()).includes("Won"));
    const restored = await settings.restoreLeadStage("lstg_contacted");
    labels = await order();
    ok("a retired stage restored among the open ones", restored.ok && labels.indexOf("Contacted") < labels.indexOf("Booked"), `${errorOf(restored)} ${labels.join(" → ")}`);
    const deletedEmpty = await settings.deleteLeadStage("lstg_contacted");
    const deleteFull = await settings.deleteLeadStage(booked);
    ok("an empty stage can be deleted; one with leads can't", deletedEmpty.ok && !deleteFull.ok, `${errorOf(deletedEmpty)} / ${errorOf(deleteFull)}`);
    const listed = await settings.listPipelineForManage();
    ok("the screen counts each stage's leads", listed?.stages.find((s) => s.id === booked)?.leads === 1, JSON.stringify(listed?.stages.map((s) => `${s.label}:${s.leads}`)));

    // ── Leads moving through it ────────────────────────────────────────────────────────────────
    section("Leads moving through the workspace's stages");
    as(rep);
    const created = await leads.createLead({ companyId: company.id, title: `${TAG} Tower B fit-out` });
    const leadId = created.ok ? created.data.id : "";
    const fresh = await leadNow(leadId);
    ok(
      "a new lead starts in the first stage that means new, dated now",
      created.ok && fresh.status === "NEW" && fresh.stageId === "lstg_new" && !!fresh.stageChangedAt && Date.now() - fresh.stageChangedAt.getTime() < 60_000,
      `${errorOf(created)} ${JSON.stringify(fresh)}`,
    );
    const toSite = await leads.updateLeadStatus({ leadId, stageId: siteVisit });
    const atSite = await leadNow(leadId);
    const siteNotes = await notesOf(leadId);
    ok("moved to Site visit, it counts as qualifying", toSite.ok && atSite.stageId === siteVisit && atSite.status === "QUALIFYING", `${errorOf(toSite)} ${JSON.stringify(atSite)}`);
    ok(
      "  its history says so in the stages' names, and still in the words the forecast reads",
      readStageNote(siteNotes.at(-1) ?? "", (await server.leadStages()).stages) === "Moved from Enquiry to Site visit" && parseStageChange(siteNotes.at(-1) ?? "")?.to === "QUALIFYING",
      siteNotes.at(-1),
    );
    const again = await leads.updateLeadStatus({ leadId, stageId: siteVisit });
    ok("  moved there again: nothing happens, nothing is logged", again.ok && (await notesOf(leadId)).length === siteNotes.length);
    const byStatus = await leads.updateLeadStatus({ leadId, status: "PROPOSAL_SENT" });
    ok("a caller that still names a status lands in the first stage with that meaning", byStatus.ok && (await leadNow(leadId)).stageId === "lstg_proposal_sent", errorOf(byStatus));
    const toQualified = await leads.updateLeadStatus({ leadId, stageId: "lstg_qualified" });
    ok("reaching a stage that counts as qualified credits whoever moved it", toQualified.ok && (await leadNow(leadId)).qualifiedByUserId === rep.id, errorOf(toQualified));
    const noReason = await leads.updateLeadStatus({ leadId, stageId: "lstg_lost" });
    ok("a lost stage asks for the reason", !noReason.ok, errorOf(noReason));
    const retiredStage = await leads.updateLeadStatus({ leadId, stageId: "lstg_won" });
    ok("  a retired stage can't be moved to", !retiredStage.ok, errorOf(retiredStage));
    as(outsider);
    const outside = await leads.updateLeadStatus({ leadId, stageId: booked });
    ok("somebody outside the account can't move it", !outside.ok && outside.error === "Lead not found.", errorOf(outside));
    as(rep);
    const won = await leads.updateLeadStatus({ leadId, stageId: booked });
    const wonNow = await leadNow(leadId);
    const companyNow = await db.company.findUniqueOrThrow({ where: { id: company.id }, select: { stage: true } });
    ok(
      "Booked counts as won: the company becomes a customer, the win is dated now and found by its note",
      won.ok && wonNow.status === "WON" && companyNow.stage === "CUSTOMER" && Date.now() - (wonNow.stageChangedAt?.getTime() ?? 0) < 60_000 && (await notesOf(leadId)).at(-1)!.includes(" to WON"),
      `${errorOf(won)} ${JSON.stringify(wonNow)} ${companyNow.stage}`,
    );
    const second = await leads.createLead({ companyId: company.id, title: `${TAG} Lobby refresh` });
    const third = await leads.createLead({ companyId: company.id, title: `${TAG} Parking signage` });
    const ids = [second, third].map((r) => (r.ok ? r.data.id : ""));
    const bulk = await leads.bulkUpdateLeads({ leadIds: ids, stageId: siteVisit });
    const bulked = await Promise.all(ids.map(leadNow));
    ok("the bulk bar moves several leads to a stage", bulk.ok && bulked.every((l) => l.stageId === siteVisit && l.status === "QUALIFYING"), `${errorOf(bulk)} ${JSON.stringify(bulked)}`);
    const shown = await server.stagesOfLeads([{ id: leadId, status: "WON" }, { id: ids[0]!, status: "QUALIFYING" }, { id: before2.id, status: "NEW" }]);
    ok(
      "lists show each lead's own stage",
      shown.get(leadId)?.label === "Booked" && shown.get(ids[0]!)?.label === "Site visit" && shown.get(before2.id)?.label === "Enquiry",
      JSON.stringify([...shown.values()].map((s) => s.label)),
    );

    // ── Dated by when they moved ───────────────────────────────────────────────────────────────
    section("Won in September, opened today");
    // Won in India's September; `updatedAt` is today, as opening the lead (its score rewritten) makes it.
    const september = { gte: new Date("2026-09-01T00:00:00+05:30"), lt: new Date("2026-10-01T00:00:00+05:30") };
    const sinceOctober = { gte: new Date("2026-10-01T00:00:00+05:30") };
    const septemberWin = await db.lead.create({
      data: { companyId: company.id, title: `${TAG} September win`, status: "WON", stageId: booked, stageChangedAt: new Date("2026-09-30T23:30:00+05:30") },
      select: { id: true },
    });
    const wonIn = (range: { gte: Date; lt?: Date }) =>
      server.byStageDate((moved) => db.lead.count({ where: { id: septemberWin.id, status: "WON", ...moved(range) } }));
    ok("counts as September's win — the last hour of September in India — however recently it was opened", (await wonIn(september)) === 1 && (await wonIn(sinceOctober)) === 0);

    // ── Before the migration ───────────────────────────────────────────────────────────────────
    section("A workspace still waiting for the migration");
    await db.$executeRawUnsafe(`ALTER TABLE "leads" DROP CONSTRAINT "leads_stageId_fkey"`);
    await db.$executeRawUnsafe(`ALTER TABLE "leads" DROP COLUMN "stageId", DROP COLUMN "stageChangedAt"`);
    await db.$executeRawUnsafe(`DROP TABLE "lead_stages"`);
    const waiting = await server.leadStages();
    ok("it is shown the stages it always had", !waiting.stored && waiting.stages.length === 9);
    const oldCreate = await leads.createLead({ companyId: company.id, title: `${TAG} During the deploy` });
    ok("  a lead can still be added", oldCreate.ok, errorOf(oldCreate));
    const oldMove = oldCreate.ok ? await leads.updateLeadStatus({ leadId: oldCreate.data.id, stageId: "lstg_contacted" }) : oldCreate;
    const oldStatus = oldCreate.ok ? (await db.lead.findUniqueOrThrow({ where: { id: oldCreate.data.id }, select: { status: true } })).status : null;
    ok("  and moved, by status as before", oldMove.ok && oldStatus === "CONTACTED", `${errorOf(oldMove)} ${oldStatus}`);
    as(manager);
    const screen = await settings.listPipelineForManage();
    const blocked = await settings.saveLeadStage({ label: "Survey", status: "QUALIFYING", color: "blue" });
    ok("  the settings screen says to come back, and changes nothing", screen?.stored === false && !blocked.ok, errorOf(blocked));
    ok("  and a win is dated as it always was there, by when the lead last changed", (await wonIn(sinceOctober)) === 1 && (await wonIn(september)) === 0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
