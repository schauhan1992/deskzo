/**
 * check:industry-templates — a workspace set up for how its kind of business works, in one go (owner,
 * 2 Oct 2026): src/lib/industry-templates, src/actions/industry-templates.ts, Settings → Industry
 * templates, and the choice at signup (src/lib/platform/provisioning.ts).
 *
 * The pure part needs no database: every template is one the settings screens would accept (stage, step,
 * word and field rules, NEW/WON/LOST kept, modules that exist), and the plan — stages matched by meaning
 * and renamed, the ones nobody's lead is in retired, the ones with leads kept and ordered among their
 * kind, a template's stage that would share a name with one that stays giving way; steps and fields
 * already there left alone and retired ones brought back; the wording merged, not replaced.
 *
 * The rest builds a scratch workspace database beside the real one and runs the real actions in it:
 * preview, apply, apply again (nothing), a second template on top, what a workspace without Orders or
 * Products gets, the modules a template switches on, who may, the audit and the page — and the signup
 * worker's own path, through a client of the new database, run twice as a retried job would.
 *
 *   npm run check:industry-templates
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import { renderHtml } from "./lib/render-html";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
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

const TAG = "ZZTEMPLATES";

// ── Who the code thinks is calling ──────────────────────────────────────────────────────────────

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
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/settings/industry-templates",
  useSearchParams: () => new URLSearchParams(),
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const nextHeaders = {
  headers: async () => new Headers({ host: "zztemplates.localhost:3000" }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {}, getAll: () => [] }),
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/navigation", navigation],
  ["next/headers", nextHeaders],
  ["@/lib/session", session],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/navigation"), navigation],
  [load.resolve("next/headers"), nextHeaders],
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

const textOf = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");

/* eslint-disable @typescript-eslint/no-require-imports */
const { INDUSTRY_TEMPLATES, templateOf } = require("../src/lib/industry-templates/catalogue") as typeof import("../src/lib/industry-templates/catalogue");
const plans = require("../src/lib/industry-templates/plan") as typeof import("../src/lib/industry-templates/plan");
const { checkStage, defaultStages, REQUIRED_MEANINGS, PIPELINE_LIMITS } = require("../src/lib/pipeline/rules") as typeof import("../src/lib/pipeline/rules");
const { checkStep, STEP_LIMITS } = require("../src/lib/pipeline/order-steps") as typeof import("../src/lib/pipeline/order-steps");
const { checkWord, TERM_KEYS, resolveWording } = require("../src/lib/terms/dictionary") as typeof import("../src/lib/terms/dictionary");
const { CUSTOM_FIELD_LIMITS, hasOptions } = require("../src/lib/custom-fields/rules") as typeof import("../src/lib/custom-fields/rules");
const { MODULE_REGISTRY } = require("../src/lib/modules") as typeof import("../src/lib/modules");
/* eslint-enable @typescript-eslint/no-require-imports */

// ── The pure part ───────────────────────────────────────────────────────────────────────────────

function pure() {
  section("Every template is one the settings screens would accept");
  ok("five of them, each with its own key", INDUSTRY_TEMPLATES.length === 5 && new Set(INDUSTRY_TEMPLATES.map((t) => t.key)).size === 5);
  for (const t of INDUSTRY_TEMPLATES) {
    const stageProblems = t.stages.map((s, i) => checkStage({ label: s.label, status: s.status, color: "default" }, t.stages.slice(0, i).map((o, j) => ({ id: String(j), key: `k${j}`, label: o.label, status: o.status, color: "default", archived: false }))));
    const stepProblems = t.steps.map((s, i) => checkStep({ label: s.label, status: s.status, color: "default" }, t.steps.slice(0, i).map((o, j) => ({ id: String(j), key: `k${j}`, label: o.label, status: o.status, color: "default", archived: false }))));
    const perStatus = Math.max(...["APPROVED", "PROCESSING", "FULFILLED"].map((st) => t.steps.filter((s) => s.status === st).length));
    const wordProblems = Object.entries(t.terms).flatMap(([key, term]) => [(TERM_KEYS as readonly string[]).includes(key) ? null : `no word ${key}`, checkWord(key, term!.one), checkWord(key, term!.many)]);
    const fieldProblems = t.fields.flatMap((f) => [
      f.label.length > CUSTOM_FIELD_LIMITS.label ? `${f.label}: too long` : null,
      hasOptions(f.type) && !(f.options && f.options.length) ? `${f.label}: no options` : null,
      f.options && new Set(f.options.map((o) => o.toLowerCase())).size !== f.options.length ? `${f.label}: options repeat` : null,
      t.fields.filter((o) => o.entity === f.entity && o.label.toLowerCase() === f.label.toLowerCase()).length > 1 ? `${f.label}: twice` : null,
    ]);
    ok(
      `${t.name}: stages, steps, words and fields all valid`,
      stageProblems.every((p) => p === null) && stepProblems.every((p) => p === null) && perStatus <= STEP_LIMITS.perStatus && wordProblems.every((p) => p === null) && fieldProblems.every((p) => p === null),
      { stageProblems, stepProblems, wordProblems, fieldProblems },
    );
    ok(`  keeps a new, a won and a lost stage, each meaning once`, REQUIRED_MEANINGS.every((m) => t.stages.some((s) => s.status === m)) && new Set(t.stages.map((s) => s.status)).size === t.stages.length);
    ok(`  switches on only modules that exist`, t.modules.every((m) => MODULE_REGISTRY.some((r) => r.key === m)));
  }
  ok("found by key, and nothing else is one", templateOf("real_estate")?.name === "Real estate" && templateOf("crm") === null && templateOf(undefined) === null);

  section("The pipeline, matched by meaning");
  const si = templateOf("system_integrators")!;
  const fresh = defaultStages().map((s) => ({ id: s.id, label: s.label, status: s.status, archived: false, leads: 0 }));
  const p1 = plans.planPipeline(si.stages, fresh);
  const kinds = (ops: { kind: string }[], kind: string) => ops.filter((o) => o.kind === kind).length;
  ok("a fresh pipeline: each stage renamed to the template's (Negotiation and Lost already are), the one it has no use for retired", kinds(p1.stages, "rename") === 6 && kinds(p1.stages, "keep") === 2 && kinds(p1.stages, "retire") === 1 && kinds(p1.stages, "add") === 0, p1.stages.map((s) => `${s.kind}:${s.label}`));
  ok("  in the template's order", p1.pipeline.map((s) => s.label).join(" > ") === si.stages.map((s) => s.label).join(" > "));
  const withLeads = fresh.map((s) => (s.status === "QUALIFIED" ? { ...s, leads: 3 } : s));
  const p2 = plans.planPipeline(si.stages, withLeads);
  const stayAt = p2.pipeline.findIndex((s) => s.label === "Qualified");
  ok("a stage somebody's leads are in stays — among the open ones, before the closed", p2.stages.some((s) => s.kind === "stay" && s.label === "Qualified") && stayAt === 5 && p2.pipeline[6]!.label === "PO received", p2.pipeline.map((s) => s.label));
  const clash = fresh.map((s) => (s.status === "QUALIFIED" ? { ...s, label: "Site survey", leads: 2 } : s));
  const p3 = plans.planPipeline(si.stages, clash);
  ok("  and a template stage that would share its name gives way, saying why", p3.stages.some((s) => s.kind === "keep" && s.status === "CONTACTED" && s.label === "Contacted") && !p3.pipeline.some((s) => s.kind === "rename" && s.label === "Site survey"));
  const p4 = plans.planPipeline(si.stages, []);
  ok("a workspace with no stages yet gets them all", kinds(p4.stages, "add") === 8 && p4.pipeline.length === 8);
  const twoNew = [{ id: "a", label: "Fresh", status: "NEW" as const, archived: false, leads: 0 }, { id: "b", label: "Inbound", status: "NEW" as const, archived: false, leads: 4 }, ...fresh.filter((s) => s.status !== "NEW")];
  const p5 = plans.planPipeline(si.stages, twoNew);
  ok("two stages meaning the same: the first renamed, the other kept for its leads", p5.stages.some((s) => s.kind === "rename" && s.id === "a" && s.label === "Enquiry") && p5.stages.some((s) => s.kind === "stay" && s.id === "b"));
  // Twenty-eight stages, twenty-five of them in use: the template's four new ones would take it past thirty.
  const crowded = Array.from({ length: 25 }, (_, i) => ({ id: `x${i}`, label: `Open ${i}`, status: "CONTACTED" as const, archived: false, leads: 1 }));
  const p6 = plans.planPipeline(si.stages, [...fresh.filter((s) => ["NEW", "WON", "LOST"].includes(s.status)), ...crowded]);
  ok("never more than the most stages a pipeline may have: what would go past it is skipped, saying why", p6.pipeline.length <= PIPELINE_LIMITS.stages && p6.stages.filter((s) => s.kind === "skip").length === 4, p6.pipeline.length);

  section("Steps, words and fields beside what is there");
  const steps = plans.planSteps(si.steps, [{ id: "s1", label: "installation", status: "PROCESSING", archived: false }, { id: "s2", label: "Handed over", status: "FULFILLED", archived: true }], true);
  ok("a step already there by name is left alone; one retired under it brought back", steps.find((s) => s.label === "Installation")?.kind === "exists" && steps.find((s) => s.label === "Handed over")?.kind === "restore" && steps.filter((s) => s.kind === "add").length === 3);
  ok("  without Orders, no steps", plans.planSteps(si.steps, [], false).every((s) => s.kind === "skip"));
  const words = plans.planWords(si.terms, { terms: { contact: { one: "Person", many: "People", a: "a" }, ticket: { one: "Case", many: "Cases", a: "a" } }, orderStatus: { FULFILLED: "Installed" } });
  ok("words merged: the template's set, the workspace's others kept", words.overrides.terms?.contact?.one === "Person" && words.overrides.terms?.lead?.one === "Enquiry" && words.overrides.terms?.ticket?.one === "Service call" && words.overrides.orderStatus?.FULFILLED === "Installed");
  ok("  and said as from → to", words.words.find((w) => w.key === "ticket")?.from === "Case" && words.words.every((w) => w.kind === "set"));
  const back = plans.planWords({ lead: { one: "Lead", many: "Leads", a: "a" } }, { terms: { lead: { one: "Enquiry", many: "Enquiries", a: "an" } } });
  ok("  a template's word that is the app's own is not stored", back.overrides.terms?.lead === undefined && resolveWording(back.overrides).terms.lead.one === "Lead");
  const fields = plans.planFields(si.fields, [{ id: "f1", entity: "ORDER", key: "site_code", label: "Site Code", archived: false }, { id: "f2", entity: "LEAD", key: "survey_date", label: "Survey date", archived: true }], { orders: true, items: true });
  ok("a field there by name is left alone; one retired brought back", fields.find((f) => f.field.label === "Site code")?.kind === "exists" && fields.find((f) => f.field.label === "Survey date")?.kind === "restore");
  ok("  without Orders, no order fields", plans.planFields(si.fields, [], { orders: false, items: true }).filter((f) => f.field.entity === "ORDER").every((f) => f.kind === "skip"));
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
  const scratchName = `${realName}_templates`;
  const scratchUrl = withDatabase(realUrl, scratchName);
  const real = directClient(realUrl, { max: 1 });
  const realBefore = await snapshot(real);
  const admin = directClient(withDatabase(realUrl, "postgres"), { max: 1 });
  let closeAll: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60 * 1000 });
    ok("built from the migrations", true);
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = "";
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    /* eslint-enable @typescript-eslint/no-require-imports */
    closeAll = () => db.$disconnect();
    await run(scratchUrl, withDatabase(realUrl, `${realName}_templates_signup`), admin);
  } finally {
    await closeAll?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${realName}_templates_signup" WITH (FORCE)`).catch(() => {});
    const gone = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname in ('${scratchName}', '${realName}_templates_signup')`);
    ok("the scratch databases are dropped", Number(gone[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  section("The real workspace was not touched");
  const realAfter = await snapshot(real);
  await real.$disconnect();
  ok("its pipeline, steps, words and fields are as they were", realAfter === realBefore, realAfter);
  console.log(failures === 0 ? `\nAll ${passes} industry template checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

async function snapshot(client: PrismaClient): Promise<string> {
  const [stages, steps, words, fields] = await Promise.all([
    client.leadStage.findMany({ select: { id: true, label: true, status: true, sortOrder: true, archivedAt: true }, orderBy: { id: "asc" } }),
    client.orderStep.findMany({ select: { id: true, label: true, archivedAt: true }, orderBy: { id: "asc" } }),
    client.terminologySettings.findUnique({ where: { id: "global" }, select: { overrides: true } }),
    client.customFieldDefinition.count(),
  ]);
  return JSON.stringify({ stages, steps, words, fields });
}

// ── The suite ───────────────────────────────────────────────────────────────────────────────────

async function run(scratchUrl: string, signupUrl: string, admin: PrismaClient) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const actions = require("../src/actions/industry-templates") as typeof import("../src/actions/industry-templates");
  const { applyTemplate, previewTemplate } = require("../src/lib/industry-templates/apply") as typeof import("../src/lib/industry-templates/apply");
  const { IndustryTemplatesManager } = require("../src/components/settings/industry-templates-manager") as typeof import("../src/components/settings/industry-templates-manager");
  const { ClockProvider } = require("../src/components/time/clock-provider") as typeof import("../src/components/time/clock-provider");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const tenant = {
    id: randomUUID(),
    slug: "zztemplates",
    name: "zztemplates",
    status: "ACTIVE" as const,
    dbUrl: scratchUrl,
    primaryHost: "zztemplates.localhost",
    hosts: ["zztemplates.localhost"],
    source: "env" as const,
    isDefault: false,
    keyBundleCipher: null,
    country: "IN",
    timezone: "Asia/Kolkata",
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
    const rep = await user("Rep", {}, { role: "SALES" });
    const halfway = await user("Halfway", { "settings.manage": true, "fields.manage": true, "pipeline.manage": false });
    const as = (u: typeof owner) => {
      actor = u;
    };
    const company = await db.company.create({ data: { name: `${TAG} Acme`, normalizedName: `${TAG} acme`.toLowerCase(), createdById: owner.id, ownerUserId: owner.id }, select: { id: true } });
    const qualified = await db.leadStage.findFirstOrThrow({ where: { status: "QUALIFIED" }, select: { id: true } });
    const contacted = await db.leadStage.findFirstOrThrow({ where: { status: "CONTACTED" }, select: { id: true } });
    const leadIn = await db.lead.create({ data: { companyId: company.id, title: `${TAG} In qualified`, status: "QUALIFIED", stageId: qualified.id }, select: { id: true } });
    const leadContacted = await db.lead.create({ data: { companyId: company.id, title: `${TAG} Contacted`, status: "CONTACTED", stageId: contacted.id }, select: { id: true } });
    await db.customFieldDefinition.create({ data: { entity: "ORDER", key: "site_code", label: "Site Code", type: "TEXT", sortOrder: 0 } });
    await db.orderStep.create({ data: { key: "installation", label: "Installation", status: "PROCESSING", color: "default", sortOrder: 1, archivedAt: new Date() } });
    await db.terminologySettings.create({ data: { id: "global", overrides: { terms: { contact: { one: "Person", many: "People", a: "a" } } } } });
    ok("the starting pipeline, a lead in Qualified and one in Contacted, a field and a retired step already there, a word of the workspace's own", !!leadIn.id && !!leadContacted.id);

    section("Who may");
    as(rep);
    ok("a rep sees none of it", (await actions.industryTemplatesForManage()) === null && !(await actions.previewIndustryTemplate("system_integrators")).ok);
    as(halfway);
    const before = await snapshot(db as unknown as PrismaClient);
    const halfPage = await actions.industryTemplatesForManage();
    const halfApply = await actions.applyIndustryTemplate("system_integrators");
    ok("somebody who can't change the pipeline may look, and is told why they can't apply", !halfApply.ok && (await snapshot(db as unknown as PrismaClient)) === before && (halfPage === null || halfPage.missing.includes("pipeline.manage")), { error: errorOf(halfApply), missing: halfPage?.missing });

    section("System integrators: the preview");
    as(owner);
    const page = await actions.industryTemplatesForManage();
    ok("the owner sees all five, and may apply", page?.templates.length === 5 && page.missing.length === 0);
    const preview = await actions.previewIndustryTemplate("system_integrators");
    const plan = preview.ok ? preview.data : null;
    ok("each stage renamed by meaning; Qualified stays, for its lead", !!plan && plan.stages.filter((s) => s.kind === "rename").length === 6 && plan.stages.some((s) => s.kind === "stay" && s.label === "Qualified" && s.leads === 1), plan?.stages.map((s) => `${s.kind}:${s.label}`));
    ok("  the step retired under its name brought back, the field there left alone", plan?.steps.find((s) => s.label === "Installation")?.kind === "restore" && plan.fields.find((f) => f.field.label === "Site code")?.kind === "exists");
    ok("  and nothing written by looking", (await snapshot(db as unknown as PrismaClient)) === before);
    const unknown = await actions.previewIndustryTemplate("crm");
    ok("only a template from the list", !unknown.ok);

    section("Applied");
    const applied = await actions.applyIndustryTemplate("system_integrators");
    ok("applied, said area by area", applied.ok && applied.data.changes.length >= 4, applied.ok ? applied.data.changes : errorOf(applied));
    const stages = await db.leadStage.findMany({ where: { archivedAt: null }, orderBy: { sortOrder: "asc" }, select: { id: true, label: true, status: true } });
    ok("the pipeline reads as the template's, Qualified among the open stages", stages.map((s) => s.label).join(" > ") === "Enquiry > Site survey > Solution design > Quotation sent > Negotiation > Qualified > PO received > Lost > Not a fit", stages.map((s) => s.label));
    const movedLead = await db.lead.findUniqueOrThrow({ where: { id: leadContacted.id }, select: { stageId: true, status: true } });
    ok("  a lead in Contacted is in Site survey without moving", movedLead.stageId === contacted.id && movedLead.status === "CONTACTED" && stages.find((s) => s.id === contacted.id)?.label === "Site survey");
    ok("  and no lead's history written", (await db.activity.count({ where: { type: "STAGE_CHANGE" } })) === 0);
    const steps = await db.orderStep.findMany({ where: { archivedAt: null }, orderBy: [{ status: "asc" }, { sortOrder: "asc" }], select: { label: true, status: true } });
    ok("order steps added under their statuses in the template's order, Installation back in its place", steps.filter((s) => s.status === "PROCESSING").map((s) => s.label).join(",") === "Material ordered,Material received,Installation,Testing and commissioning" && steps.some((s) => s.label === "Handed over" && s.status === "FULFILLED"), steps);
    const words = await db.terminologySettings.findUniqueOrThrow({ where: { id: "global" }, select: { overrides: true } });
    const w = words.overrides as { terms?: Record<string, { one: string }> };
    ok("words set, the workspace's own kept", w.terms?.lead?.one === "Enquiry" && w.terms?.order?.one === "Project" && w.terms?.ticket?.one === "Service call" && w.terms?.contact?.one === "Person", w);
    const fields = await db.customFieldDefinition.findMany({ where: { archivedAt: null }, select: { entity: true, key: true, label: true, type: true, options: true, showInList: true, createdById: true } });
    const solution = fields.find((f) => f.label === "Solution type");
    ok("fields added with keys, options and columns; the one there not twice", fields.filter((f) => f.label.toLowerCase() === "site code").length === 1 && solution?.type === "MULTI_SELECT" && solution.key === "solution_type" && (solution.options as { value: string }[]).map((o) => o.value).join() === "cctv,networking,av,access_control,fire" && solution.showInList && solution.createdById === owner.id, solution);
    ok("  audited", (await db.auditLog.count({ where: { entityType: "IndustryTemplate", entityId: "system_integrators" } })) === 1);

    const again = await actions.applyIndustryTemplate("system_integrators");
    ok("applied again: nothing to change, nothing logged", again.ok && again.data.changes.length === 0 && (await db.auditLog.count({ where: { entityType: "IndustryTemplate" } })) === 1);
    const againPreview = await actions.previewIndustryTemplate("system_integrators");
    ok("  and the preview says so", againPreview.ok && againPreview.data.nothingToDo);

    section("Another on top");
    await db.lead.update({ where: { id: leadIn.id }, data: { stageId: contacted.id, status: "CONTACTED" } });
    await db.systemModule.create({ data: { key: "renewals", enabled: false } });
    const resellers = await actions.applyIndustryTemplate("software_resellers");
    const after = await db.leadStage.findMany({ where: { archivedAt: null }, orderBy: { sortOrder: "asc" }, select: { label: true, status: true } });
    ok("renamed again by meaning; Qualified, empty now, becomes the deal registration", resellers.ok && after.map((s) => s.label).join(" > ") === "Lead > Requirement captured > OEM deal registered > Quotation sent > Negotiation > Site survey > PO received > Lost > Not a fit", after.map((s) => s.label));
    ok("  the module it needs switched on", (await db.systemModule.findUniqueOrThrow({ where: { key: "renewals" } })).enabled);
    ok("  a company field added beside the others", (await db.customFieldDefinition.count({ where: { entity: "COMPANY", label: "Tenant / domain" } })) === 1);
    const wordsAfter = (await db.terminologySettings.findUniqueOrThrow({ where: { id: "global" } })).overrides as { terms?: Record<string, { one: string }> };
    ok("  its words as they are: the last template's stay", wordsAfter.terms?.lead?.one === "Enquiry");

    section("A workspace without Orders or Products");
    const withoutOrders = await previewTemplate(db as unknown as PrismaClient, templateOf("manufacturing")!, (key) => key !== "orders" && key !== "items");
    ok("no steps, no order or product fields — each says why", withoutOrders.steps.every((s) => s.kind === "skip") && withoutOrders.fields.filter((f) => f.field.entity !== "LEAD").every((f) => f.kind === "skip"));
    const notInPlan = await previewTemplate(db as unknown as PrismaClient, templateOf("software_resellers")!, (key) => key !== "renewals");
    ok("  a module outside the plan isn't switched on", notInPlan.modules.find((m) => m.key === "renewals")?.kind === "not-in-plan");

    section("The page");
    const shown = await actions.industryTemplatesForManage();
    const html = textOf(await renderHtml(createElement(ClockProvider, { zone: "Asia/Kolkata" }, createElement(IndustryTemplatesManager, { page: shown! }))));
    ok("every template, its pipeline, and what has been applied here", INDUSTRY_TEMPLATES.every((t) => html.includes(t.name)) && html.includes("Enquiry → Site survey") && html.includes("Applied here") && html.includes(TAG), html.slice(0, 300));
  });

  section("At signup: the worker's own path");
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${new URL(signupUrl).pathname.slice(1)}" WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${new URL(signupUrl).pathname.slice(1)}"`);
  execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: signupUrl }, timeout: 10 * 60 * 1000 });
  const workspace = directClient(signupUrl, { max: 2 });
  try {
    const ownerRow = await workspace.user.create({ data: { name: "New Owner", email: "owner@new.example", passwordHash: "!", role: "ADMIN", isSuperAdmin: true }, select: { id: true } });
    const re = templateOf("real_estate")!;
    const first = await applyTemplate(workspace, re, () => true, ownerRow.id);
    const second = await applyTemplate(workspace, re, () => true, ownerRow.id);
    const pipeline = await workspace.leadStage.findMany({ where: { archivedAt: null }, orderBy: { sortOrder: "asc" }, select: { label: true } });
    ok("a fresh workspace set up for real estate, through a client of its own database", first.changes.length >= 4 && pipeline.map((s) => s.label).join(" > ") === re.stages.map((s) => s.label).join(" > "), pipeline.map((s) => s.label));
    ok("  a retried job applies it once", second.changes.length === 0 && (await workspace.customFieldDefinition.count()) === re.fields.length && (await workspace.orderStep.count()) === re.steps.length);
    const reWords = (await workspace.terminologySettings.findUniqueOrThrow({ where: { id: "global" } })).overrides as { terms?: Record<string, { one: string }> };
    ok("  its words: Buyer, Booking, Unit", reWords.terms?.customer?.one === "Buyer" && reWords.terms?.order?.one === "Booking" && reWords.terms?.item?.one === "Unit");
  } finally {
    await workspace.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
