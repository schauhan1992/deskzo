/**
 * check:automate-drafting — Deskzo Automate, Phase 5: AI drafting, workflow files and company
 * templates (plan of 17 Oct 2026: "A check proves no customer record is in what is sent to the model.
 * draftWithAI never creates a version.").
 *
 * Builds a scratch workspace and control plane beside the real database, drives the real library and
 * server actions, and drops both at the end. The AI is a stand-in provider that records every request
 * and answers from a script: nothing reaches Anthropic, OpenAI or Google, and nothing is spent.
 *
 *   · blanks: what an export, an import or a draft clears — people, records, connections, stages, the
 *     ids a rule compares with — emptied so publishing asks for them; what is kept;
 *   · files: an export carries no id or secret of the workspace; import refuses what isn't a workflow
 *     or names what Deskzo doesn't have, says where it would send, and lands as a draft; a round trip
 *     gives back what went out;
 *   · company templates: saved cleared, listed, used, removed;
 *   · drafting: the copilot's gates; marker strings planted in every kind of record never reach the
 *     model; a draft saved as a draft of the person's, notes on its steps, invented people cleared;
 *     one repair round with the problems listed; a reply in words asked once more; a draft never
 *     usable refused; never a version; tokens counted.
 *
 *   npm run check:automate-drafting
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { directClient } from "../src/lib/tenancy/direct-client";
import type { Definition } from "../src/lib/automate/definition";
import type { ToolCall, TurnOutcome, TurnRequest } from "../src/lib/copilot/types";

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

// ─── The stand-in AI provider ───────────────────────────────────────────────────────────────────

type Answer = (req: TurnRequest) => Partial<TurnOutcome> | Error;
const requests: { system: string; history: unknown; tools: unknown; text: string }[] = [];
let script: Answer[] = [];
const standInProvider = {
  runTurn: async (req: TurnRequest): Promise<TurnOutcome> => {
    requests.push({ system: req.system, history: req.history, tools: req.tools, text: JSON.stringify({ system: req.system, history: req.history, tools: req.tools }) });
    const next = script.shift();
    if (!next) throw Object.assign(new Error("the script ran out"), { status: 500 });
    const out = next(req);
    if (out instanceof Error) throw out;
    return { text: "", toolCalls: [], native: null, usage: { input: 1000, output: 400 }, stop: "tools", model: "zz-model", ...out };
  },
  listModels: async () => ["zz-model"],
};
let callSeq = 0;
const propose = (input: Record<string, unknown>): Answer => () => ({ toolCalls: [{ id: `call_${++callSeq}`, name: "propose_workflow", input } satisfies ToolCall], stop: "tools" });

async function main() {
  // ─── Scratch databases ──────────────────────────────────────────────────────────────────────
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace and control plane");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so scratch databases may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const names = { a: `${realName}_autodraft_a`, control: `${realName}_autodraft_ctl` };
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
    process.env.TENANT_DB_ZZDRAFT_A = withDatabase(url, names.a);
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
    const blanks = require("../src/lib/automate/blanks") as typeof import("../src/lib/automate/blanks");
    const { validateDefinition } = require("../src/lib/automate/validate") as typeof import("../src/lib/automate/validate");
    const { TEMPLATES } = require("../src/lib/automate/templates") as typeof import("../src/lib/automate/templates");
    const { draftWithAI } = require("../src/lib/automate/ai/draft") as typeof import("../src/lib/automate/ai/draft");
    const { draftingSystemPrompt } = require("../src/lib/automate/ai/prompt") as typeof import("../src/lib/automate/ai/prompt");
    const { DraftingRefusal } = require("../src/lib/automate/ai/model") as typeof import("../src/lib/automate/ai/model");
    const actions = require("../src/actions/automate") as typeof import("../src/actions/automate");
    const copilotSettings = require("../src/lib/copilot/settings") as typeof import("../src/lib/copilot/settings");
    const copilotProviders = require("../src/lib/copilot/providers") as typeof import("../src/lib/copilot/providers");
    const { encryptSecret } = require("../src/lib/crypto") as typeof import("../src/lib/crypto");
    /* eslint-enable @typescript-eslint/no-require-imports */

    const A = (await registry.tenantBySlug("zzdraft-a"))!;
    ok("the registry knows the workspace", !!A);
    const inA = <T,>(work: () => Promise<T>) => runAsTenant(A, work);
    const def = (d: unknown) => d as Definition;

    // ─── Fixtures: every kind of record, each carrying a marker that must never reach the model ──
    const MARK = "ZZMARK";
    const person = (name: string, email: string, role: string, extra: Record<string, unknown> = {}) =>
      inA(() => db.user.create({ data: { name, email, passwordHash: "!", role, ...extra }, select: { id: true, name: true, email: true, role: true } }));
    const ownerUser = await person(`${MARK} Owner Person`, "zzmark-owner@zzdraft.invalid", "ADMIN", { isSuperAdmin: true });
    const colleague = await person(`${MARK} Colleague Person`, "zzmark-colleague@zzdraft.invalid", "ADMIN");
    const owner = ownerUser.id;
    const as = (u: typeof ownerUser) => {
      actor = { id: u.id, name: u.name, email: u.email!, role: u.role };
    };
    as(ownerUser);
    const company = await inA(() => db.company.create({ data: { name: `${MARK} Acme Industries`, normalizedName: "zzmark acme industries", createdById: owner, ownerUserId: owner }, select: { id: true } }));
    const contact = await inA(() => db.contact.create({ data: { companyId: company.id, name: `${MARK} Asha Contact`, email: "zzmark-asha@acme.invalid", phone: "+91 98000 77777" }, select: { id: true } }));
    const lead = await inA(() => db.lead.create({ data: { companyId: company.id, contactId: contact.id, title: `${MARK} Laptop deal`, ownerUserId: owner, createdByUserId: owner, source: "OTHER" }, select: { id: true } }));
    await inA(() => db.ticket.create({ data: { companyId: company.id, title: `${MARK} Printer jammed`, createdByUserId: owner } }));
    const connection = await inA(async () =>
      db.automationConnection.create({
        data: { provider: "slack", name: `${MARK} Quokka room`, ownerUserId: owner, sharedWithWorkspace: true, credentialsCipher: await encryptSecret(JSON.stringify({ url: "https://hooks.slack.com/services/T0/B0/zzmarksecret" })), scopes: ["hooks.slack.com"], status: "ACTIVE" },
        select: { id: true },
      }),
    );
    await inA(() => store.createWorkflow({ name: `${MARK} existing workflow`, ownerUserId: owner, createdById: owner }));
    const markers = [MARK, "zzmark", "Acme Industries", "Asha Contact", "98000 77777", "Laptop deal", "Printer jammed", "Owner Person", "Colleague Person", "zzmarksecret", "Quokka room", owner, colleague.id, company.id, contact.id, lead.id, connection.id];

    // ─── Blanks ─────────────────────────────────────────────────────────────────────────────────
    section("Blanks: what doesn't carry over to another workspace");
    const FOREIGN = "cmforeignpersonid00000001";
    const rich = def({
      schema: 1,
      trigger: { type: "lead.created", filter: { all: [{ ref: "trigger.lead.ownerUserId", op: "eq", value: FOREIGN }, { ref: "trigger.lead.source", op: "eq", value: "WEBSITE" }, { ref: "trigger.lead.pipelineId", op: "eq", value: "lpip_sales" }] } },
      steps: [
        { id: "give", name: "Give it to Ravi", type: "action", action: "lead.assign", input: { leadId: "{{trigger.lead.id}}", to: FOREIGN } },
        { id: "byrules", type: "action", action: "lead.assign", input: { leadId: "{{trigger.lead.id}}", to: "rules" } },
        { id: "note", type: "action", action: "notify.person", input: { to: "lead_owner", title: "New lead", leadId: "cmforeignleadid000000001" } },
        { id: "report", type: "action", action: "report.email", input: { source: "leads", measure: "count", dimension: "owner", period: "yesterday", to: ["owner", FOREIGN] } },
        { id: "slack", type: "action", action: "slack.post", input: { connectionId: "cmforeignconnection00001", text: "A new lead" } },
        { id: "make", type: "action", action: "lead.create", input: { name: "Somebody", email: "a@b.invalid", pipelineId: "lpip_sales" } },
        { id: "move", type: "action", action: "lead.move", input: { leadId: "{{trigger.lead.id}}", stageId: "lstg_custom_x" } },
        { id: "check", type: "condition", if: { any: [{ ref: "trigger.lead.ownerUserId", op: "in", value: [FOREIGN, "{{trigger.company.ownerUserId}}"] }] } },
      ],
    });
    const { definition: clearedDef, cleared } = blanks.clearWorkspaceValues(rich);
    const stepOf = (d: Definition, id: string) => d.steps.find((s) => s.id === id) as { input: Record<string, unknown> } & { if?: { any?: { value: unknown }[] } };
    ok("a person picked by id is emptied — not removed, so it can't fall back to 'rules' unnoticed", stepOf(clearedDef, "give").input.to === "");
    ok("  a special value stays ('rules', 'lead_owner', 'owner')", stepOf(clearedDef, "byrules").input.to === "rules" && stepOf(clearedDef, "note").input.to === "lead_owner");
    ok("  a reference stays ({{trigger.lead.id}})", stepOf(clearedDef, "give").input.leadId === "{{trigger.lead.id}}");
    ok("  a record named by id is emptied", stepOf(clearedDef, "note").input.leadId === "");
    ok("  a list keeps its special values and drops the ids", JSON.stringify(stepOf(clearedDef, "report").input.to) === JSON.stringify(["owner"]));
    ok("  a connection is emptied, and a stage", stepOf(clearedDef, "slack").input.connectionId === "" && stepOf(clearedDef, "move").input.stageId === "");
    ok("  the main pipeline, which every workspace has, stays", stepOf(clearedDef, "make").input.pipelineId === "lpip_sales");
    const triggerRules = (clearedDef.trigger.filter as { all: { ref: string; value: unknown }[] }).all;
    ok("a rule comparing an owner's id is emptied; one on the source, or on the main pipeline, stays", triggerRules[0]!.value === "" && triggerRules[1]!.value === "WEBSITE" && triggerRules[2]!.value === "lpip_sales");
    ok("  a list in a rule keeps its references", JSON.stringify(stepOf(clearedDef, "check").if?.any?.[0]?.value) === JSON.stringify(["{{trigger.company.ownerUserId}}"]));
    ok("each is listed, by step and field, in words", cleared.length === 7 && cleared.some((c) => c.label === "Give it to Ravi › Give it to" || c.label.startsWith("Give it to Ravi ›")), cleared.map((c) => c.label).join(" | "));
    ok("  clearing twice changes nothing more", blanks.clearWorkspaceValues(clearedDef).cleared.length === 0);
    const checked = validateDefinition(clearedDef);
    const split = blanks.splitProblems(clearedDef, checked.ok ? [] : checked.problems);
    ok("publishing refuses the cleared workflow until each is chosen", !checked.ok && split.blanks.length >= 5, split.blanks.map((p) => `${p.stepId}/${p.field}`).join(" "));
    ok("  the emptied trigger rule is one of them, in words", split.blanks.some((p) => p.stepId === null && p.field === "trigger.filter" && p.message === blanks.NOTHING_CHOSEN));
    ok("  and none of them is counted as a mistake", split.others.length === 0, split.others.map((p) => p.message).join(" | "));
    ok("  a person field says what to choose, not 'too small'", split.blanks.some((p) => p.stepId === "give" && p.message === "Choose who."), split.blanks.find((p) => p.stepId === "give")?.message);
    const templatesStillValid = TEMPLATES.every((t) => {
      const values = Object.fromEntries(t.blanks.map((b) => [b.key, b.kind === "person" ? "owner" : b.kind === "people" ? ["owner"] : undefined]));
      return t.build(values).every((made) => validateDefinition(made.definition).ok);
    });
    ok("Deskzo's own templates still publish — the new rule leaves them alone", templatesStillValid);

    // ─── Files ──────────────────────────────────────────────────────────────────────────────────
    section("Exporting and importing a workflow");
    const exportable = def({
      schema: 1,
      trigger: { type: "lead.created", filter: { all: [{ ref: "trigger.lead.ownerUserId", op: "eq", value: colleague.id }] } },
      steps: [
        { id: "give", name: "Give it to the colleague", note: "They handle these.", type: "action", action: "lead.assign", input: { leadId: "{{trigger.lead.id}}", to: colleague.id } },
        { id: "slack", name: "Post it", type: "action", action: "slack.post", input: { connectionId: connection.id, text: "New lead {{trigger.lead.title}}" } },
        { id: "call", name: "Tell our ERP", type: "action", action: "http.request", input: { url: "https://api.example.com/v1/orders", body: { lead: "{{trigger.lead.id}}" } } },
      ],
    });
    const original = await inA(() => store.createWorkflow({ name: "ZZ export me", description: "Leads for the colleague", ownerUserId: owner, createdById: owner, draft: exportable }));
    const exported = await inA(() => actions.exportAutomationWorkflow(original.id));
    if (!exported.ok) throw new Error(exported.error);
    const file = JSON.parse(exported.data.text) as { deskzo: string; version: number; definition: Definition; name: string };
    ok("the file says what it is, and is named after the workflow", file.deskzo === "automate-workflow" && file.version === 1 && /^WF-\d{4}-zz-export-me\.json$/.test(exported.data.fileName), exported.data.fileName);
    ok("  no id of this workspace's is in it — person, connection, record", ![colleague.id, connection.id, owner, company.id].some((id) => exported.data.text.includes(id)));
    ok("  nor a secret, nor a connection's name", !exported.data.text.includes("zzmarksecret") && !exported.data.text.includes("Quokka room"));
    ok("  what it cleared is said", exported.data.cleared.length === 3, exported.data.cleared.join(" | "));
    ok("  the step's note goes with it", exported.data.text.includes("They handle these."));
    const preview = await inA(() => actions.previewWorkflowImport(exported.data.text));
    if (!preview.ok) throw new Error(preview.error);
    ok("importing it says what starts it and its steps", preview.data.trigger === "A lead is created" && preview.data.steps.join("|") === "Give it to the colleague|Post it|Tell our ERP", preview.data.steps.join("|"));
    ok("  every outside place it would send to: the API's host, and Slack", preview.data.calls.includes("api.example.com") && preview.data.calls.includes("Slack"), preview.data.calls.join(", "));
    ok("  and what's left to choose: the person, the channel, the rule", preview.data.blanks.length === 3 && preview.data.others.length === 0, preview.data.blanks.map((b) => `${b.stepId}/${b.field}`).join(" "));
    const before = await inA(() => db.automationWorkflow.count());
    ok("a preview makes nothing", (await inA(() => db.automationWorkflow.count())) === before);
    const imported = await inA(() => actions.importAutomationWorkflow(exported.data.text));
    if (!imported.ok) throw new Error(imported.error);
    const importedRow = await inA(() => db.automationWorkflow.findFirst({ where: { name: "ZZ export me", id: { not: original.id } }, select: { id: true, status: true, source: true, draft: true, ownerUserId: true, activeVersionId: true } }));
    ok("it lands as a draft of the importer's, never published", importedRow?.status === "DRAFT" && importedRow.ownerUserId === owner && importedRow.activeVersionId === null && (await inA(() => db.automationVersion.count({ where: { workflowId: importedRow.id } }))) === 0);
    ok("  the draft is what went out: a round trip changes nothing", isDeepStrictEqual(importedRow?.draft, file.definition));
    ok("  and it opens in the builder at its own address", /^\/automate\/workflows\/WF-\d{4}$/.test(imported.data.path), imported.data.path);

    const refusal = async (text: string) => {
      const r = await inA(() => actions.previewWorkflowImport(text));
      return r.ok ? "taken" : r.error;
    };
    ok("refused: a file that isn't JSON", (await refusal("not json")).includes("isn't JSON"));
    ok("  one that isn't a workflow", (await refusal(JSON.stringify({ hello: 1 }))).includes("isn't a Deskzo Automate workflow"));
    ok("  one from a newer Deskzo", (await refusal(JSON.stringify({ ...file, version: 99 }))).includes("newer Deskzo"));
    ok("  a broken workflow", (await refusal(JSON.stringify({ ...file, definition: { schema: 1, trigger: { type: "manual" } } }))).includes("isn't one Deskzo can read"));
    const strange = await refusal(JSON.stringify({ ...file, definition: { ...file.definition, steps: [{ id: "x", type: "action", action: "zz.explode", input: {} }] } }));
    ok("  one using an action Deskzo doesn't have, naming it", strange.includes("zz.explode"), strange);
    ok("  one starting from something unknown", (await refusal(JSON.stringify({ ...file, definition: { ...file.definition, trigger: { type: "zz.whenever" } } }))).includes("zz.whenever"));
    ok("  one over 512 KB", (await refusal(JSON.stringify({ ...file, padding: "x".repeat(600 * 1024) }))).includes("512 KB"));
    const edited = await inA(() => actions.previewWorkflowImport(JSON.stringify({ ...file, definition: exportable })));
    ok("a file edited to name records again is cleared again on import", edited.ok && edited.data.cleared.length === 3 && !JSON.stringify(edited.data).includes(colleague.id));
    const editedImport = await inA(() => actions.importAutomationWorkflow(JSON.stringify({ ...file, name: "ZZ edited file", definition: exportable })));
    const editedRow = await inA(() => db.automationWorkflow.findFirst({ where: { name: "ZZ edited file" }, select: { draft: true } }));
    ok("  and the draft it makes names none of them", editedImport.ok && !!editedRow && ![colleague.id, connection.id].some((id) => JSON.stringify(editedRow.draft).includes(id)));

    // ─── Company templates ──────────────────────────────────────────────────────────────────────
    section("A company's own templates");
    const saved = await inA(() => actions.saveAsCompanyTemplate(original.id));
    ok("a workflow is saved as a template, cleared as an export is", saved.ok && saved.data.cleared.length === 3);
    const row = await inA(() => db.automationTemplate.findFirst({ select: { id: true, definition: true, name: true } }));
    ok("  nothing of this workspace's is kept in it", !!row && ![colleague.id, connection.id].some((id) => JSON.stringify(row.definition).includes(id)));
    const listed = await inA(() => actions.listAutomationCompanyTemplates());
    ok("it is listed with its steps, what starts it and who saved it", listed?.length === 1 && listed[0]!.steps.length === 3 && listed[0]!.trigger === "A lead is created" && listed[0]!.by === ownerUser.name);
    const used = await inA(() => actions.startFromCompanyTemplate(row!.id));
    const usedRow = used.ok ? await inA(() => db.automationWorkflow.findFirst({ where: { templateKey: `company:${row!.id}` }, select: { status: true, source: true } })) : null;
    ok("using it makes a draft from it", used.ok && usedRow?.status === "DRAFT" && usedRow.source === "TEMPLATE");
    const unfinished = await inA(() => store.createWorkflow({ name: "ZZ unfinished", ownerUserId: owner, createdById: owner }));
    await inA(() => db.automationWorkflow.update({ where: { id: unfinished.id }, data: { draft: { schema: 1, steps: [] } } }));
    const notWhole = await inA(() => actions.saveAsCompanyTemplate(unfinished.id));
    const notWholeExport = await inA(() => actions.exportAutomationWorkflow(unfinished.id));
    ok("a draft that isn't a whole workflow is neither saved as a template nor exported", !notWhole.ok && !notWholeExport.ok);
    const removed = await inA(() => actions.deleteAutomationCompanyTemplate(row!.id));
    const again = await inA(() => actions.deleteAutomationCompanyTemplate(row!.id));
    ok("removing it takes it out of the list; twice is refused", removed.ok && !again.ok && (await inA(() => actions.listAutomationCompanyTemplates()))?.length === 0);

    // ─── Drafting ───────────────────────────────────────────────────────────────────────────────
    section("Drafting with AI: the copilot's gates");
    copilotProviders.setTestProvider(standInProvider);
    const config = (over: Partial<import("../src/lib/copilot/settings").CopilotConfig> = {}) =>
      copilotSettings.setTestSettings({ config: { enabled: true, provider: "ANTHROPIC", model: "zz-model", dailyTokenLimit: 1_000_000, hasKey: { ANTHROPIC: true, OPENAI: false, GEMINI: false }, ...over }, keys: { ANTHROPIC: "zz-not-a-real-key" } });
    const DESCRIPTION = "When a new lead comes in from the website, let the assignment rules give it to someone, tell the sales manager, and after 3 days remind the owner to call if it's still new.";
    const workflowsNow = () => inA(() => db.automationWorkflow.count());

    config({ enabled: false });
    let count = await workflowsNow();
    const off = await inA(() => actions.draftWorkflowWithAI(DESCRIPTION));
    ok("with the copilot switched off: refused, saying so; nothing sent, nothing made", !off.ok && off.error.includes("switched off") && requests.length === 0 && (await workflowsNow()) === count, off.ok ? "" : off.error);
    const availability = await inA(() => actions.getDraftingAvailability());
    ok("  and 'Describe it' says why it can't", !availability.available && !!availability.reason?.includes("switched off"));
    config({ hasKey: { ANTHROPIC: false, OPENAI: false, GEMINI: false } });
    const noKey = await inA(() => actions.draftWorkflowWithAI(DESCRIPTION));
    ok("without a key: refused", !noKey.ok && noKey.error.includes("API key") && requests.length === 0);
    config({ dailyTokenLimit: 1 });
    await inA(() => copilotSettings.recordUsage(owner, { input: 5, output: 5 }));
    const spent = await inA(() => actions.draftWorkflowWithAI(DESCRIPTION));
    ok("with today's allowance used: refused", !spent.ok && spent.error.includes("allowance") && requests.length === 0, spent.ok ? "" : spent.error);
    config();
    const short = await inA(() => actions.draftWorkflowWithAI("a flow"));
    ok("a description too short to draft from: asked for more, nothing sent", !short.ok && short.error.includes("Say a little more") && requests.length === 0);
    ok("'Describe it' is available, naming the AI service the words go to", (await inA(() => actions.getDraftingAvailability())).provider === "Claude (Anthropic)");

    section("Drafting with AI: a draft");
    const goodDefinition = {
      schema: 1,
      trigger: { type: "lead.created", filter: { all: [{ ref: "trigger.lead.source", op: "eq", value: "WEBSITE" }] } },
      steps: [
        { id: "assign", name: "Give it to the rules", note: "The assignment rules choose who gets it.", type: "action", action: "lead.assign", input: { leadId: "{{trigger.lead.id}}", to: "rules" } },
        { id: "tell", name: "Tell the sales manager", note: "So they know a website lead is in.", type: "action", action: "notify.person", input: { to: "the sales manager", title: "New website lead: {{trigger.lead.title}}" } },
        { id: "wait", name: "Three days", note: "Time for the owner to make contact.", type: "delay", for: { days: 3 } },
        { id: "now", name: "Read the lead again", type: "action", action: "lead.get", input: { leadId: "{{trigger.lead.id}}" } },
        { id: "still", name: "Only if still new", type: "condition", if: { all: [{ ref: "steps.now.output.status", op: "eq", value: "NEW" }] } },
        { id: "remind", name: "Remind the owner", note: "A task to call, due today.", type: "action", action: "task.create", input: { title: "Call about {{trigger.lead.title}}", assignTo: "lead_owner", dueInDays: 0, leadId: "{{trigger.lead.id}}" } },
      ],
    };
    count = await workflowsNow();
    const versionsBefore = await inA(() => db.automationVersion.count());
    script = [propose({ name: "Website leads: assign, tell, remind", description: "Assigns website leads, tells the manager, and reminds the owner after 3 days.", definition: goodDefinition, questions: ["Who is the sales manager? I left it for you to choose."] })];
    const drafted = await inA(() => actions.draftWorkflowWithAI(DESCRIPTION));
    if (!drafted.ok) throw new Error(drafted.error);
    const made = await inA(() => db.automationWorkflow.findFirst({ where: { name: "Website leads: assign, tell, remind" }, select: { id: true, status: true, source: true, ownerUserId: true, draft: true, activeVersionId: true } }));
    ok("the draft is saved as a workflow of the person's, marked as drafted by AI, not published", made?.status === "DRAFT" && made.source === "AI" && made.ownerUserId === owner && made.activeVersionId === null && (await workflowsNow()) === count + 1);
    ok("  no version was made, and nothing listens for it yet", (await inA(() => db.automationVersion.count())) === versionsBefore && (await inA(() => db.automationTrigger.count({ where: { workflowId: made!.id } }))) === 0);
    const madeDraft = made!.draft as Definition;
    ok("  each step keeps its one-line note", madeDraft.steps[0]!.note === "The assignment rules choose who gets it." && madeDraft.steps[2]!.note === "Time for the owner to make contact.");
    ok("  a person it made up ('the sales manager') is emptied, for the person to choose", (madeDraft.steps[1] as { input: Record<string, unknown> }).input.to === "");
    ok("  and the answer says what to choose and what it asked", drafted.data.steps === 6 && drafted.data.blanks.includes("Choose who to tell.") && drafted.data.questions[0] === "Who is the sales manager? I left it for you to choose." && drafted.data.others === 0, JSON.stringify(drafted.data));
    ok("  it opens in the builder", /^\/automate\/workflows\/WF-\d{4}$/.test(drafted.data.path));
    const usage = await inA(() => db.copilotUsage.findMany({ where: { userId: owner }, select: { inputTokens: true, outputTokens: true, requests: true } }));
    ok("its tokens are counted to the person, as the copilot's are", usage.reduce((n, u) => n + u.inputTokens, 0) >= 1000 && usage.reduce((n, u) => n + u.outputTokens, 0) >= 400);

    section("What the model was sent");
    const sent = requests[0]!;
    ok("one request, with the description and the propose_workflow tool only", requests.length === 1 && sent.text.includes(DESCRIPTION) && JSON.stringify(sent.tools).includes("propose_workflow") && (sent.tools as unknown[]).length === 1);
    ok("  the instructions name the triggers and actions it may use", sent.system.includes("lead.created") && sent.system.includes("lead.assign") && sent.system.includes("{{trigger.lead.id}}"));
    const leaked = markers.filter((m) => sent.text.includes(m));
    ok("  no customer, contact, lead, ticket, colleague, connection or workflow of the workspace's is in it", leaked.length === 0, leaked.join(", "));
    ok("  nor any person's email address", !/[a-z0-9._-]+@[a-z0-9-]+\.invalid/i.test(sent.text));
    ok("  the instructions are a fixed size, whatever the workspace holds", sent.system.length < 60_000, `${sent.system.length} characters`);
    ok("only the actions the owner may use are offered", draftingSystemPrompt(new Set(["task.create"])).includes("- task.create:") && !draftingSystemPrompt(new Set(["task.create"])).includes("- lead.assign:"));

    section("Drafting with AI: a draft with mistakes, repaired once");
    requests.length = 0;
    const broken = { ...goodDefinition, steps: [...goodDefinition.steps.slice(0, 2), { id: "assign", type: "action", action: "lead.explode", input: {} }] };
    script = [propose({ name: "Broken first", definition: broken }), propose({ name: "Fixed second", definition: goodDefinition })];
    const repaired = await inA(() => actions.draftWorkflowWithAI(DESCRIPTION));
    const repairTurn = JSON.stringify(requests[1]?.history ?? []);
    ok("the problems go back to the model, once, naming the step", requests.length === 2 && repairTurn.includes("lead.explode") && repairTurn.includes("Two steps are called"), repairTurn.slice(-300));
    ok("  and the fixed draft is the one kept", repaired.ok && repaired.data.name === "Fixed second" && repaired.data.others === 0);
    requests.length = 0;
    script = [propose({ name: "Broken first", definition: broken }), propose({ name: "Broken again", definition: broken })];
    const stillBroken = await inA(() => actions.draftWorkflowWithAI(DESCRIPTION));
    ok("still wrong after the repair: no third try; the draft is kept with its mistakes marked", requests.length === 2 && stillBroken.ok && stillBroken.data.others > 0);

    section("Drafting with AI: replies that aren't a draft");
    requests.length = 0;
    script = [() => ({ text: "Sure — here's what I'd do…", stop: "done" }), propose({ name: "After a nudge", definition: JSON.stringify(goodDefinition) })];
    const nudged = await inA(() => actions.draftWorkflowWithAI(DESCRIPTION));
    ok("an answer in words is asked once more for the draft; a draft sent as a string of JSON is read", nudged.ok && nudged.data.name === "After a nudge" && JSON.stringify(requests[1]?.history).includes("Call propose_workflow with the whole draft"));
    count = await workflowsNow();
    requests.length = 0;
    script = [propose({ name: "No steps", definition: { schema: 1, trigger: { type: "manual" } } }), propose({ name: "Still none", definition: "not json" })];
    const unusable = await inA(() => actions.draftWorkflowWithAI(DESCRIPTION));
    ok("never a workflow Deskzo can read: refused, and nothing made", !unusable.ok && unusable.error.includes("didn't come back with a workflow") && (await workflowsNow()) === count);
    script = [() => ({ stop: "refused" })];
    const declined = await inA(() => actions.draftWorkflowWithAI(DESCRIPTION));
    ok("the provider declining: said so", !declined.ok && declined.error.includes("declined"));
    script = [() => Object.assign(new Error("401"), { status: 401 })];
    const badKey = await inA(() => actions.draftWorkflowWithAI(DESCRIPTION));
    ok("the provider refusing the key: said in words for an admin", !badKey.ok && badKey.error.includes("refused the API key"), badKey.ok ? "" : badKey.error);
    const long = { ...goodDefinition, steps: goodDefinition.steps.map((s) => ({ ...s, name: `${s.name} `.repeat(20), note: "word ".repeat(100) })) };
    script = [propose({ name: "Long words", definition: long })];
    const trimmed = await inA(() => actions.draftWorkflowWithAI(DESCRIPTION));
    ok("names and notes too long are cut, not counted as mistakes", trimmed.ok && trimmed.data.others === 0);

    const complete = { ...goodDefinition, steps: goodDefinition.steps.map((s) => (s.id === "tell" ? { ...s, input: { ...(s as { input: Record<string, unknown> }).input, to: "owner" } } : s)) };
    script = [propose({ name: "Nothing to choose", definition: complete })];
    const whole = await inA(() => actions.draftWorkflowWithAI(DESCRIPTION));
    const wholeRow = whole.ok ? await inA(() => db.automationWorkflow.findFirst({ where: { name: "Nothing to choose" }, select: { id: true, status: true, activeVersionId: true } })) : null;
    ok(
      "even a draft with nothing left to choose waits for a person to publish it",
      whole.ok && whole.data.blanks.length === 0 && whole.data.others === 0 && wholeRow?.status === "DRAFT" && wholeRow.activeVersionId === null && (await inA(() => db.automationVersion.count({ where: { workflowId: wholeRow.id } }))) === 0,
    );

    section("draftWithAI itself makes nothing");
    const [w0, v0] = [await workflowsNow(), await inA(() => db.automationVersion.count())];
    script = [propose({ name: "Library only", definition: goodDefinition })];
    const libraryDraft = await inA(() => draftWithAI({ userId: owner, description: DESCRIPTION }));
    ok("it returns the draft and creates neither a workflow nor a version", libraryDraft.definition.steps.length === 6 && (await workflowsNow()) === w0 && (await inA(() => db.automationVersion.count())) === v0);
    script = [];
    const refused = await inA(() => draftWithAI({ userId: owner, description: "x" }).then(() => "drafted", (err: unknown) => (err instanceof DraftingRefusal ? "refused" : String(err))));
    ok("  and refuses in words, as a DraftingRefusal", refused === "refused");

    section("A step's note doesn't change how it runs");
    const noted = await publishAndRun(owner);
    ok("a workflow with notes on its steps publishes and runs", noted === "SUCCEEDED", noted);

    async function publishAndRun(by: string): Promise<string> {
      return inA(async () => {
        const w = await store.createWorkflow({ name: "ZZ noted", ownerUserId: by, createdById: by, draft: def({ schema: 1, trigger: { type: "manual" }, steps: [{ id: "tell", note: "Says hello.", type: "action", action: "notify.person", input: { title: "ZZ hello" } }] }) });
        const published = await store.publishWorkflow(w.id, by);
        if (!published.ok) return `publish: ${published.error}`;
        const run = await store.startManualRun(w.id, by);
        if (!run.ok) return `run: ${run.error}`;
        for (let i = 0; i < 10; i++) await engine.workTenant({ budgetMs: 10_000 });
        return (await db.automationRun.findUnique({ where: { id: run.data.runId }, select: { status: true } }))?.status ?? "missing";
      });
    }
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const providers = require("../src/lib/copilot/providers") as typeof import("../src/lib/copilot/providers");
    providers.setTestProvider(null);
    if (close) await close().catch(() => undefined);
    for (const name of Object.values(names)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch((err) => console.error(`could not drop ${name}`, err));
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM pg_database WHERE datname IN (${Object.values(names).map((n) => `'${n}'`).join(", ")})`);
    ok("every scratch database dropped", Number(left[0]!.n) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} Automate drafting checks passed.\n` : `\n${failures} check(s) failed (${passes} passed).\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
