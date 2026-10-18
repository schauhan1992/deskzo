/**
 * check:automate-limits — Deskzo Automate, Phase 7: its limits by plan (owner, 17 Oct 2026: "the plan's
 * limits as proposed", Automate Plus at ₹999 a month, connectors by plan). What each plan gives and how
 * a workspace's plans add up; the catalogue, the price book and the console's plan save; then, in a
 * scratch workspace, steps counted by the month with the admins told at four fifths and at all of them,
 * no new run once they are used, the workflows switched on held to the limit (two at once included),
 * connectors refused at publish, in the builder and at run time, and old runs pruned once a day.
 *
 * Builds a scratch workspace and control plane beside the real database, drives the real store, engine
 * and server actions, and drops both at the end. Nothing reaches the outside world.
 *
 *   npm run check:automate-limits
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { directClient } from "../src/lib/tenancy/direct-client";
import type { Definition } from "../src/lib/automate/definition";
import type { AutomationLimits } from "../src/lib/automate/limits";

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

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const limits = require("../src/lib/automate/limits") as typeof import("../src/lib/automate/limits");
  const ent = require("../src/lib/platform/entitlements") as typeof import("../src/lib/platform/entitlements");
  const entitlements = require("../src/lib/entitlements") as typeof import("../src/lib/entitlements");
  const plans = require("../src/lib/platform/plans") as typeof import("../src/lib/platform/plans");
  const catalogue = require("../src/lib/platform/product-plans") as typeof import("../src/lib/platform/product-plans");
  const priceBook = require("../src/lib/platform/price-book") as typeof import("../src/lib/platform/price-book");
  const products = require("../src/lib/products") as typeof import("../src/lib/products");
  const usage = require("../src/lib/automate/usage") as typeof import("../src/lib/automate/usage");
  const { clockFor } = require("../src/lib/time/zone") as typeof import("../src/lib/time/zone");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const { PLAN_LIMITS, NO_LIMITS } = limits;
  const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);

  // ─── What each plan gives, and how they add up ──────────────────────────────────────────────────
  section("How a workspace's plans add up");
  type Kind = "EDITION" | "BUNDLE" | "ADDON" | "INTERNAL";
  const columns = (l: AutomationLimits | null) =>
    l ? { automationWorkflows: l.workflows, automationSteps: l.steps, automationHistoryDays: l.historyDays, automationConnectors: l.connectors } : {};
  const item = (key: string, kind: Kind, automation: AutomationLimits | null, quantity = 1, extra: { perSeat?: boolean; trial?: boolean } = {}) => ({
    quantity,
    ...extra,
    plan: { key, kind, allModules: false, seats: null, copilotTokens: null, customDomains: null, modules: [], ...columns(automation) },
  });
  const nobody = { country: "IN", seatOverride: null, copilotTokenOverride: null, customDomainOverride: null };
  const automationOf = (items: ReturnType<typeof item>[], tenant: Record<string, unknown> = {}) => ent.entitlementsFrom({ ...nobody, ...tenant }, items, []).automation;
  const one = (people: number) => item("deskzo-one", "EDITION", PLAN_LIMITS.one, people, { perSeat: true });
  const crm = (people: number) => item("deskzo-crm", "EDITION", PLAN_LIMITS.edition, people, { perSeat: true });
  const plus = (units = 1) => item("addon-automate-plus", "ADDON", PLAN_LIMITS.plus, units);

  ok("Deskzo One for ten people: 100 workflows, 3,000 steps each — pooled — 90 days, up to Google Sheets", same(automationOf([one(10)]), { workflows: 100, steps: 30_000, historyDays: 90, connectors: 2 }), automationOf([one(10)]));
  ok("a product for four: 20 workflows, 4,000 steps, 30 days, up to Slack and Teams", same(automationOf([crm(4)]), { workflows: 20, steps: 4_000, historyDays: 30, connectors: 1 }));
  ok("  given by hand, with no per-person price: one unit's allowance", same(automationOf([item("deskzo-crm", "EDITION", PLAN_LIMITS.edition)]), { workflows: 20, steps: 1_000, historyDays: 30, connectors: 1 }));
  ok("two products: workflows and steps add up, the longest history and widest connectors", same(automationOf([crm(3), item("deskzo-books", "EDITION", { ...PLAN_LIMITS.edition, historyDays: 45 }, 2, { perSeat: true })]), { workflows: 40, steps: 5_000, historyDays: 45, connectors: 1 }));
  ok("One with Automate Plus: 200 workflows, 80,000 steps, a year, every connector", same(automationOf([one(10), plus()]), { workflows: 200, steps: 80_000, historyDays: 365, connectors: 3 }));
  ok("  Plus twice: twice what it adds", same(automationOf([one(10), plus(2)]), { workflows: 300, steps: 130_000, historyDays: 365, connectors: 3 }));
  const trialOne = item("deskzo-one", "EDITION", PLAN_LIMITS.one, 1, { trial: true });
  ok("a free trial gets a trial's, whatever it trials", same(automationOf([trialOne]), PLAN_LIMITS.trial), automationOf([trialOne]));
  ok("  two trials at once still one trial", same(automationOf([trialOne, item("deskzo-crm", "EDITION", PLAN_LIMITS.edition, 1, { trial: true })]), PLAN_LIMITS.trial));
  ok("  and Plus paid for on a trial comes on top", same(automationOf([trialOne, plus()]), { workflows: 105, steps: 51_000, historyDays: 365, connectors: 3 }));
  ok("  an internal plan on a trial subscription is no trial", same(automationOf([item("internal-everything", "INTERNAL", null, 1, { trial: true })]), NO_LIMITS));
  ok("an edition made before the limits (all empty): no limit", same(automationOf([item("old", "EDITION", null)]), NO_LIMITS));
  ok("  an add-on without them adds nothing", same(automationOf([crm(2), item("addon-more-people", "ADDON", NO_LIMITS, 5)]), { workflows: 20, steps: 2_000, historyDays: 30, connectors: 1 }));
  ok("  one empty limit on an edition: that one alone has no limit", same(automationOf([crm(2), item("x", "EDITION", { ...PLAN_LIMITS.edition, steps: null })]), { workflows: 40, steps: null, historyDays: 30, connectors: 1 }));
  ok("no plan at all: none on, no steps, a trial's history, webhooks", same(automationOf([]), { workflows: 0, steps: 0, historyDays: 7, connectors: 0 }));
  const overridden = automationOf([crm(2)], { automationStepOverride: 9, automationConnectorOverride: 3 });
  ok("a staff override replaces each it names, the plans the rest", same(overridden, { workflows: 20, steps: 9, historyDays: 30, connectors: 3 }), overridden);
  ok("  a trial overridden: the override wins", automationOf([trialOne], { automationWorkflowOverride: 50 })?.workflows === 50);

  section("Entitlements carry them");
  const parsed = entitlements.parseEntitlements(JSON.parse(JSON.stringify(ent.entitlementsFrom(nobody, [one(3)], []))));
  ok("written and read back whole", same(parsed.automation, { workflows: 100, steps: 9_000, historyDays: 90, connectors: 2 }));
  ok("  one unreadable: never worked out — no limit", entitlements.parseEntitlements({ v: 1, all: false, modules: [], seats: 1, copilotTokens: 0, customDomains: 0, plans: [], automation: { workflows: 1, steps: "lots", historyDays: 7, connectors: 0 } }).automation === undefined);
  ok("  worked out before them: none", entitlements.parseEntitlements({ v: 1, all: false, modules: [], seats: 1, copilotTokens: 0, customDomains: 0, plans: [] }).automation === undefined && same(limits.automationLimits({}), NO_LIMITS));
  ok("never worked out at all: fails closed — nothing on, no steps", same(entitlements.CORE_ONLY.automation, { workflows: 0, steps: 0, historyDays: 7, connectors: 0 }));
  ok("the installation's own workspace: no limit", same(limits.automationLimits(entitlements.UNRESTRICTED), NO_LIMITS));

  section("Connectors");
  ok("a webhook to an address is level 0; through a saved API, Slack or Teams 1; Sheets 2; WhatsApp 3", limits.connectorLevelOf("http.request", { url: "https://x.invalid" }) === 0 && limits.connectorLevelOf("http.request", { connectionId: "c" }) === 1 && limits.connectorLevelOf("slack.post", {}) === 1 && limits.connectorLevelOf("teams.post", {}) === 1 && limits.connectorLevelOf("sheets.append", {}) === 2 && limits.connectorLevelOf("whatsapp.send", {}) === 3);
  ok("  Deskzo's own actions need none", limits.connectorLevelOf("task.create", {}) === -1 && limits.connectorRefusal(-1, { ...NO_LIMITS, connectors: 0 }) === null);
  const refusal = limits.connectorRefusal(3, PLAN_LIMITS.one);
  ok("WhatsApp on Deskzo One: refused, saying where it comes", refusal === "Not on this workspace's plan. WhatsApp comes with the Automate Plus add-on.", refusal);
  ok("  up to the plan's level, and no limit: allowed", limits.connectorRefusal(2, PLAN_LIMITS.one) === null && limits.connectorRefusal(3, NO_LIMITS) === null);
  ok("a level as read", limits.connectorLevelText(0) === "Webhooks only" && limits.connectorLevelText(null) === "Every connector" && limits.connectorLevelText(3) === "Every connector");

  section("The month a step counts in");
  const india = clockFor("Asia/Kolkata");
  ok("half past one in the morning of 1 November in India is November there", usage.usageMonth(india, new Date("2026-10-31T20:00:00Z")).key === "2026-11");
  ok("  held as the first day, at midnight UTC", usage.usageMonth(india, new Date("2026-10-31T20:00:00Z")).date.toISOString() === "2026-11-01T00:00:00.000Z");
  ok("  half past four in the afternoon of 31 October in New York is still October there", usage.usageMonth(clockFor("America/New_York"), new Date("2026-10-31T20:30:00Z")).key === "2026-10");

  // ─── The catalogue, the price book, the plan save ────────────────────────────────────────────────
  section("Automate Plus, the catalogue and the price book");
  const made = catalogue.productCatalogue();
  const plusPlan = made.find((p) => p.key === "addon-automate-plus");
  ok("Automate Plus is an add-on of the catalogue, with Plus's limits and no module", plusPlan?.kind === "ADDON" && plusPlan.modules.length === 0 && same(plusPlan.automation, PLAN_LIMITS.plus) && products.ADD_ONS.some((a) => a.key === "automate_plus" && a.name === "Automate Plus"));
  ok("  Deskzo One with One's, every other product an edition's", made.filter((p) => p.kind === "EDITION").every((p) => same(p.automation, p.productKey === "one" ? PLAN_LIMITS.one : PLAN_LIMITS.edition)));
  ok("  the other add-ons add nothing to Automate", made.filter((p) => p.kind === "ADDON" && p.key !== "addon-automate-plus").every((p) => same(p.automation, NO_LIMITS)));
  const price = priceBook.INDIA_LAUNCH_PRICES.find((e) => e.planKey === "addon-automate-plus");
  ok("₹999 a month, ₹9,990 a year, for the workspace", price?.month === 999 && price.year === 9_990 && price.perSeat === false, price);

  const input = (automation?: unknown) =>
    ({ key: "zz-auto", name: "ZZ Auto", kind: "EDITION", modules: [], countries: [], seats: null, copilotTokens: null, ...(automation === undefined ? {} : { automation }) }) as import("../src/lib/platform/plans").PlanInput;
  const refusedWith = (fn: () => unknown) => {
    try {
      fn();
      return null;
    } catch (err) {
      return err instanceof plans.PlanRefused ? err.message : `not refused: ${String(err)}`;
    }
  };
  ok("a plan saved with a connector level past 3 is refused", refusedWith(() => plans.checkPlanInput(input({ workflows: 1, steps: 1, historyDays: 1, connectors: 4 }))) === "Connectors is a level from 0 to 3 — or empty for every one.");
  ok("  steps below nothing, or not whole", refusedWith(() => plans.checkPlanInput(input({ workflows: 1, steps: -1, historyDays: 1, connectors: 0 })))?.startsWith("Steps a month is a whole number") === true && refusedWith(() => plans.checkPlanInput(input({ workflows: 1.5, steps: 1, historyDays: 1, connectors: 0 })))?.startsWith("Workflows switched on") === true);
  ok("  typed in a form: numbers as text, empty as no limit", same(plans.checkPlanInput(input({ workflows: "12", steps: "", historyDays: "60", connectors: "2" })).automation, { workflows: 12, steps: null, historyDays: 60, connectors: 2 }));
  ok("  left out: not given", plans.checkPlanInput(input()).automation === undefined);
  const existing = { automationWorkflows: 7, automationSteps: 70, automationHistoryDays: 14, automationConnectors: 1 };
  ok("saved: as given; left out, the plan's own; a new edition an edition's; a new add-on nothing", same(plans.savedAutomation("EDITION", PLAN_LIMITS.plus, existing), PLAN_LIMITS.plus) && same(plans.savedAutomation("EDITION", undefined, existing), { workflows: 7, steps: 70, historyDays: 14, connectors: 1 }) && same(plans.savedAutomation("EDITION", undefined, null), PLAN_LIMITS.edition) && same(plans.savedAutomation("ADDON", undefined, null), NO_LIMITS));

  // ─── A scratch workspace and control plane ───────────────────────────────────────────────────────
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace and control plane");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so scratch databases may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const names = { a: `${realName}_autolim_a`, control: `${realName}_autolim_ctl` };
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
    process.env.TENANT_DB_ZZLIM_A = withDatabase(url, names.a);
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
    const { builderCatalog } = require("../src/lib/automate/catalog") as typeof import("../src/lib/automate/catalog");
    const { emitTask } = require("../src/lib/automate/emit-records") as typeof import("../src/lib/automate/emit-records");
    const actions = require("../src/actions/automate") as typeof import("../src/actions/automate");
    /* eslint-enable @typescript-eslint/no-require-imports */

    // ─── The control plane: the catalogue fills in what came before ───────────────────────────────
    section("The catalogue fills in plans made before the limits, once");
    const first = await catalogue.syncProductPlans({ actor: "script:check:automate-limits" });
    const row = (key: string) => controlDb().plan.findUniqueOrThrow({ where: { key }, select: { automationWorkflows: true, automationSteps: true, automationHistoryDays: true, automationConnectors: true } });
    ok("made: Automate Plus among them, with its limits", first.some((l) => l.key === "addon-automate-plus" && l.outcome === "created") && same(plans.automationOfPlan(await row("addon-automate-plus")), PLAN_LIMITS.plus));
    await controlDb().plan.update({ where: { key: "deskzo-crm" }, data: { automationWorkflows: null, automationSteps: null, automationHistoryDays: null, automationConnectors: null } });
    const second = await catalogue.syncProductPlans({ actor: "script:check:automate-limits" });
    ok("an edition with all four empty is filled in, and only it changes", second.find((l) => l.key === "deskzo-crm")?.changes.join() === "Automate limits" && second.filter((l) => l.outcome === "updated").length === 1 && same(plans.automationOfPlan(await row("deskzo-crm")), PLAN_LIMITS.edition), second.filter((l) => l.outcome !== "unchanged"));
    await plans.savePlan({ key: "deskzo-crm", name: "Deskzo CRM", kind: "EDITION", productKey: "crm", modules: (await controlDb().planModule.findMany({ where: { plan: { key: "deskzo-crm" } }, select: { moduleKey: true } })).map((m) => m.moduleKey), countries: [], seats: null, copilotTokens: 50, automation: { workflows: 33, steps: null, historyDays: 60, connectors: 2 } }, "staff:zz");
    const third = await catalogue.syncProductPlans({ actor: "script:check:automate-limits" });
    ok("staff's numbers after that are theirs: kept, nothing changes", third.every((l) => l.outcome === "unchanged") && same(plans.automationOfPlan(await row("deskzo-crm")), { workflows: 33, steps: null, historyDays: 60, connectors: 2 }), third.filter((l) => l.outcome !== "unchanged"));
    await plans.savePlan({ key: "deskzo-crm", name: "Deskzo CRM", kind: "EDITION", productKey: "crm", modules: (await controlDb().planModule.findMany({ where: { plan: { key: "deskzo-crm" } }, select: { moduleKey: true } })).map((m) => m.moduleKey), countries: [], seats: null, copilotTokens: 50 }, "staff:zz");
    ok("  a save that leaves them out keeps them", same(plans.automationOfPlan(await row("deskzo-crm")), { workflows: 33, steps: null, historyDays: 60, connectors: 2 }));

    // ─── The workspace ────────────────────────────────────────────────────────────────────────────
    const A = (await registry.tenantBySlug("zzlim-a"))!;
    ok("the registry knows the workspace", !!A);
    let current: AutomationLimits | null = null;
    /** The workspace as if its plans gave these limits; null: worked out before them. */
    const inA = <T,>(work: () => Promise<T>) => runAsTenant(current ? { ...A, entitlements: { ...A.entitlements, automation: current } } : A, work);
    const setLimits = (l: Partial<AutomationLimits> | null) => {
      current = l === null ? null : { ...NO_LIMITS, ...l };
    };
    const def = (d: unknown) => d as Definition;
    const person = (name: string, email: string, role: string, extra: Record<string, unknown> = {}) =>
      inA(() => db.user.create({ data: { name, email, passwordHash: "!", role, ...extra }, select: { id: true, name: true, email: true, role: true } }));
    const ownerUser = await person("ZZ Owner", "zzowner@zzlim.invalid", "ADMIN", { isSuperAdmin: true });
    const sellerUser = await person("ZZ Seller", "zzseller@zzlim.invalid", "SALES");
    const owner = ownerUser.id;
    actor = { id: owner, name: ownerUser.name, email: ownerUser.email!, role: ownerUser.role };

    const tell = (id: string, title: string) => ({ id, type: "action", action: "notify.person", input: { to: "owner", title } });
    const manual = (steps: unknown[]) => def({ schema: 1, trigger: { type: "manual" }, steps });
    const make = (name: string, d: Definition) => inA(() => store.createWorkflow({ name, ownerUserId: owner, createdById: owner, draft: d }));
    const publish = (id: string, options?: { converting?: boolean }) => inA(() => store.publishWorkflow(id, owner, null, options));
    const drain = () =>
      inA(async () => {
        for (let i = 0; i < 40; i++) {
          await engine.workTenant({ budgetMs: 15_000 });
          const due = (await db.automationRun.count({ where: { status: { in: ["QUEUED", "WAITING"] }, runAfter: { lte: new Date() } } })) + (await db.automationEvent.count({ where: { matchedAt: null } }));
          if (!due) break;
        }
      });
    const month = () => inA(() => db.automationUsage.findFirst({ orderBy: { month: "desc" } }));
    const notices = (userId: string) => inA(() => db.notification.findMany({ where: { userId, type: "AUTOMATE_STEPS" }, orderBy: { createdAt: "asc" }, select: { title: true } }).then((n) => n.map((x) => x.title)));

    // ─── Steps ────────────────────────────────────────────────────────────────────────────────────
    section("Steps, counted by the month");
    setLimits({ steps: 5 });
    const three = await make("ZZ three steps", manual([tell("a", "ZZ one"), tell("b", "ZZ two"), tell("c", "ZZ three")]));
    ok("published within the limits", (await publish(three.id)).ok);
    const tested = await inA(() => store.testDraft(three.id, owner, true));
    ok("a test — even a live one — counts nothing", tested.ok && (await month()) === null, tested.ok ? tested.data.status : tested.error);
    const run1 = await inA(() => store.startManualRun(three.id, owner));
    await drain();
    const after1 = await month();
    ok("a run of three steps: three, in this month's row", run1.ok && after1?.steps === 3 && after1.month.toISOString().slice(0, 7) === usage.usageMonth(india).key, after1);
    ok("  three of five is under four fifths: nobody told", (await notices(owner)).length === 0 && after1?.warned80At === null);
    const run2 = await inA(() => store.startManualRun(three.id, owner));
    await drain();
    const after2 = await month();
    ok("the next run carries on past the limit — a run going finishes — and every step counts", run2.ok && after2?.steps === 6 && (await inA(() => db.automationRun.findUnique({ where: { id: run2.ok ? run2.data.runId : "" }, select: { status: true } })))?.status === "SUCCEEDED", after2);
    ok("  the admins told once at four fifths and once at all of them", same(await notices(owner), ["Automate steps are running low", "Automate steps are used up"]) && !!after2?.warned80At && !!after2.warned100At, await notices(owner));
    ok("  not somebody who doesn't manage settings", (await notices(sellerUser.id)).length === 0);
    const refused = await inA(() => store.startManualRun(three.id, owner));
    ok("used up: a manual start is refused, saying when they come back", !refused.ok && refused.error.startsWith("This month's 5 Automate steps are used, so no new run starts until "), refused.ok ? "" : refused.error);
    const viaAction = await inA(() => actions.runAutomationWorkflowNow(three.id));
    ok("  through the server action too", !viaAction.ok, viaAction);

    const onTask = await make("ZZ on a task", def({ schema: 1, trigger: { type: "task.created" }, steps: [tell("t", "ZZ task seen")] }));
    await publish(onTask.id);
    await inA(() =>
      db.$transaction(async (tx) => {
        const task = await tx.task.create({ data: { title: "ZZ a task", createdByUserId: owner, assignedToUserId: owner }, select: { id: true } });
        await emitTask(tx, "task.created", task.id, owner);
      }),
    );
    await drain();
    ok("  an event starts no run — and is not kept waiting for next month", (await inA(() => db.automationRun.count({ where: { workflowId: onTask.id } }))) === 0 && (await inA(() => db.automationEvent.count({ where: { matchedAt: null } }))) === 0);
    const scheduled = await make("ZZ every hour", def({ schema: 1, trigger: { type: "schedule", schedule: { every: "hour" } }, steps: [tell("s", "ZZ tick")] }));
    const published = await publish(scheduled.id);
    ok("  (the schedule publishes)", published.ok, published.ok ? "" : published.error);
    await inA(() => db.automationTrigger.update({ where: { workflowId: scheduled.id }, data: { nextFireAt: new Date(Date.now() - 60_000) } }));
    await drain();
    const trigger = await inA(() => db.automationTrigger.findUnique({ where: { workflowId: scheduled.id }, select: { nextFireAt: true } }));
    ok("  a schedule that comes due moves on to its next time without a run", (await inA(() => db.automationRun.count({ where: { workflowId: scheduled.id } }))) === 0 && !!trigger?.nextFireAt && trigger.nextFireAt > new Date());
    const summary = await inA(() => actions.automateUsage());
    ok("the Workflows page's line: six of five steps, and the workflows on", summary.steps === 6 && summary.limits.steps === 5 && summary.active === 3, summary);
    setLimits({ steps: 100 });
    const moreRoom = await inA(() => store.startManualRun(three.id, owner));
    await drain();
    ok("a bigger allowance (Plus bought): runs start again, no new notice until the next month", moreRoom.ok && (await month())?.steps === 9 && (await notices(owner)).length === 2);
    setLimits({ steps: 9 });
    ok("exactly at the allowance — nine of nine — no new run starts", !!(await inA(() => usage.stepsRefusal(india))));
    setLimits({ steps: 10 });
    ok("  one short of it, one may", (await inA(() => usage.stepsRefusal(india))) === null);
    setLimits(null);
    ok("worked out before the limits: nothing refused", !(await inA(() => usage.stepsRefusal(india))) && (await inA(() => store.startManualRun(three.id, owner))).ok);
    await drain();

    section("Steps crossing at once tell the admins once");
    setLimits({ steps: 10 });
    await inA(() => db.automationUsage.deleteMany({}));
    await inA(() => db.notification.deleteMany({ where: { type: "AUTOMATE_STEPS" } }));
    const counted = await inA(() => Promise.all(Array.from({ length: 12 }, () => db.$transaction((tx) => usage.countStep(tx, india)))));
    await inA(() => Promise.all(counted.map((n) => usage.afterStepCounted(n, india))));
    ok("twelve steps counted at once: twelve, each its own number", (await month())?.steps === 12 && new Set(counted).size === 12);
    ok("  and each warning said once", same(((await notices(owner)) as string[]).sort(), ["Automate steps are running low", "Automate steps are used up"]), await notices(owner));

    // ─── Workflows switched on ────────────────────────────────────────────────────────────────────
    section("Workflows switched on");
    setLimits({ workflows: 3 });
    await inA(() => db.automationWorkflow.updateMany({ where: { status: "ACTIVE" }, data: { status: "PAUSED" } }));
    const wf = await Promise.all(["ZZ w1", "ZZ w2", "ZZ w3", "ZZ w4"].map((n) => make(n, manual([tell("x", n)]))));
    ok("three may be published — and so switched on", (await publish(wf[0]!.id)).ok && (await publish(wf[1]!.id)).ok && (await publish(wf[2]!.id)).ok);
    const fourth = await publish(wf[3]!.id);
    ok("the fourth is refused, saying why", !fourth.ok && fourth.error.startsWith("This workspace's plan allows 3 workflows switched on at once"), fourth.ok ? "" : fourth.error);
    ok("  and nothing of it was saved: no version, still off", (await inA(() => db.automationVersion.count({ where: { workflowId: wf[3]!.id } }))) === 0 && (await inA(() => db.automationWorkflow.findUnique({ where: { id: wf[3]!.id }, select: { status: true } })))?.status !== "ACTIVE");
    ok("publishing one already on again takes no new place", (await publish(wf[0]!.id)).ok);
    await inA(() => store.setWorkflowStatus(wf[0]!.id, "PAUSED"));
    ok("one switched off: the fourth publishes", (await publish(wf[3]!.id)).ok);
    const back = await inA(() => store.setWorkflowStatus(wf[0]!.id, "ACTIVE"));
    ok("  switching the first back on is refused now", !back.ok && back.error.includes("allows 3 workflows"), back.ok ? "" : back.error);
    const viaToggle = await inA(() => actions.setAutomationWorkflowStatus(wf[0]!.id, "ACTIVE"));
    ok("  through the server action too", !viaToggle.ok, viaToggle);
    await inA(() => store.setWorkflowStatus(wf[3]!.id, "PAUSED"));
    const both = await Promise.all([inA(() => store.setWorkflowStatus(wf[0]!.id, "ACTIVE")), inA(() => store.setWorkflowStatus(wf[3]!.id, "ACTIVE"))]);
    ok("one place left and two switched on at once: exactly one gets it", both.filter((r) => r.ok).length === 1 && (await inA(() => db.automationWorkflow.count({ where: { status: "ACTIVE" } }))) === 3, both);
    const pipelineMove = await make("ZZ moved from a pipeline", manual([tell("p", "ZZ moved")]));
    ok("a pipeline automation moved onto Automate stays on whatever the limit", (await publish(pipelineMove.id, { converting: true })).ok && (await inA(() => db.automationWorkflow.count({ where: { status: "ACTIVE" } }))) === 4);
    setLimits({ workflows: 1 });
    ok("  a plan that shrinks leaves the ones on, on", (await inA(() => db.automationWorkflow.count({ where: { status: "ACTIVE" } }))) === 4);
    setLimits({ workflows: 0 });
    // Whichever of the two lost the race above is off.
    const off = (await inA(() => db.automationWorkflow.findFirst({ where: { id: { in: [wf[0]!.id, wf[3]!.id] }, status: "PAUSED" }, select: { id: true } })))!;
    const none = await inA(() => store.setWorkflowStatus(off.id, "ACTIVE"));
    ok("  none allowed: said so", !none.ok && none.error === "This workspace's plan doesn't let workflows be switched on.", none.ok ? "" : none.error);

    // ─── Connectors ───────────────────────────────────────────────────────────────────────────────
    section("Connectors by plan");
    setLimits({ connectors: 0 });
    await inA(() => db.automationWorkflow.updateMany({ where: { status: "ACTIVE" }, data: { status: "PAUSED" } }));
    const slack = (id = "s") => ({ id, type: "action", action: "slack.post", input: { connectionId: "zz-conn", text: "ZZ hello" } });
    const toSlack = await make("ZZ to Slack", manual([slack()]));
    const slackRefused = await publish(toSlack.id);
    ok("webhooks only: a Slack step is refused at publish, on that step", !slackRefused.ok && slackRefused.problems?.[0]?.stepId === "s" && slackRefused.problems[0].message === "Not on this workspace's plan. Saved API connections, Slack and Teams come with every product's plan.", slackRefused);
    const toAddress = await make("ZZ to an address", manual([{ id: "h", type: "action", action: "http.request", input: { url: "https://hooks.zzlim.invalid/x", method: "POST" } }]));
    ok("  a webhook to an address is fine", (await publish(toAddress.id)).ok);
    const viaSaved = await make("ZZ through a saved API", manual([{ id: "h", type: "action", action: "http.request", input: { connectionId: "zz-conn", method: "POST" } }]));
    ok("  through a saved API is not", !(await publish(viaSaved.id)).ok);
    const catalog = await inA(() => builderCatalog(owner));
    const spec = (key: string) => catalog.actions.find((a) => a.key === key);
    ok("the builder marks Slack, Teams, Sheets and WhatsApp unavailable, saying why; the webhook call stays", spec("slack.post")?.available === false && spec("slack.post")?.why?.startsWith("Not on this workspace's plan.") === true && spec("teams.post")?.available === false && spec("sheets.append")?.available === false && spec("whatsapp.send")?.available === false && spec("http.request")?.available === true && spec("task.create")?.available === true);
    setLimits({ connectors: 1 });
    ok("  a plan with them: Slack publishes", (await publish(toSlack.id)).ok);
    const sheets = await make("ZZ to Sheets", manual([{ id: "g", type: "action", action: "sheets.append", input: { spreadsheet: "zz-sheet", values: ["a"] } }]));
    ok("  but not Sheets", !(await publish(sheets.id)).ok);
    await inA(() => db.automationWorkflow.update({ where: { id: toSlack.id }, data: { status: "PAUSED" } }));
    setLimits({ connectors: 0 });
    const offAgain = await inA(() => store.setWorkflowStatus(toSlack.id, "ACTIVE"));
    ok("the plan loses them: switching it on is refused", !offAgain.ok && offAgain.error.startsWith("Not on this workspace's plan."), offAgain.ok ? "" : offAgain.error);
    await inA(() => db.automationWorkflow.update({ where: { id: toSlack.id }, data: { status: "ACTIVE" } }));
    const slackRun = await inA(() => store.startManualRun(toSlack.id, owner));
    await drain();
    const slackAfter = await inA(() => db.automationRun.findUnique({ where: { id: slackRun.ok ? slackRun.data.runId : "" }, select: { status: true, error: true } }));
    const slackWorkflow = await inA(() => db.automationWorkflow.findUnique({ where: { id: toSlack.id }, select: { status: true, pausedReason: true } }));
    ok("  one on already: its step fails before anything is sent, and the workflow pauses", slackAfter?.status === "FAILED" && slackAfter.error?.startsWith("Not on this workspace's plan.") === true && slackWorkflow?.status === "PAUSED" && slackWorkflow.pausedReason?.startsWith("Not on this workspace's plan.") === true, { slackAfter, slackWorkflow });
    ok("  and its owner is told", (await inA(() => db.notification.count({ where: { userId: owner, type: "WORKFLOW_PAUSED" } }))) === 1);
    ok("  nothing was counted for it", (await month())?.steps === 12);

    // ─── History ──────────────────────────────────────────────────────────────────────────────────
    section("Run history");
    setLimits({ historyDays: 30 });
    const day = 86_400_000;
    const oldRun = (status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "NEEDS_ATTENTION", daysAgo: number, key: string) =>
      inA(() => db.automationRun.create({ data: { workflowId: three.id, idempotencyKey: `zz-old:${key}`, status, finishedAt: new Date(Date.now() - daysAgo * day), cursor: {}, contextCipher: "x" }, select: { id: true } }));
    const [old1, old2, old3, recent, waiting] = await Promise.all([oldRun("SUCCEEDED", 40, "a"), oldRun("FAILED", 31, "b"), oldRun("CANCELLED", 45, "c"), oldRun("SUCCEEDED", 10, "d"), oldRun("NEEDS_ATTENTION", 90, "e")]);
    await inA(() => db.automationRunStep.create({ data: { runId: old1.id, stepId: "zz", type: "action", status: "SUCCEEDED" } }));
    await inA(() => db.dailyJobRun.deleteMany({ where: { job: "automate-history" } }));
    const pruned = await inA(() => usage.pruneRunHistory(india));
    const left = new Set((await inA(() => db.automationRun.findMany({ where: { id: { in: [old1.id, old2.id, old3.id, recent.id, waiting.id] } }, select: { id: true } }))).map((r) => r.id));
    ok("finished runs older than 30 days go — succeeded, failed or stopped — with their steps", pruned === 3 && !left.has(old1.id) && !left.has(old2.id) && !left.has(old3.id) && (await inA(() => db.automationRunStep.count({ where: { runId: old1.id } }))) === 0, pruned);
    ok("  a recent one stays, and one waiting on a person stays whatever its age", left.has(recent.id) && left.has(waiting.id));
    ok("  once a day: asked again today, nothing", (await inA(() => usage.pruneRunHistory(india))) === null);
    setLimits({ historyDays: null });
    await inA(() => db.dailyJobRun.deleteMany({ where: { job: "automate-history" } }));
    ok("  kept for good: nothing deleted", (await inA(() => usage.pruneRunHistory(india))) === null && left.has(recent.id));

    // ─── The daily snapshot ───────────────────────────────────────────────────────────────────────
    section("The console's daily snapshot");
    setLimits({ steps: 10 });
    const snap = await inA(() => usage.automationSnapshot({ ...A, entitlements: { ...A.entitlements, automation: current! } }));
    const activeNow = await inA(() => db.automationWorkflow.count({ where: { status: "ACTIVE" } }));
    ok("steps this month against the allowance, and the workflows on", snap.automationSteps === 12 && snap.automationStepsLimit === 10 && snap.automationWorkflows === activeNow, snap);
  } finally {
    if (close) await close().catch(() => undefined);
    for (const name of Object.values(names)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch((err) => console.error(`could not drop ${name}`, err));
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM pg_database WHERE datname IN (${Object.values(names).map((n) => `'${n}'`).join(", ")})`);
    ok("every scratch database dropped", Number(left[0]!.n) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} Automate limit checks passed.\n` : `\n${failures} check(s) failed (${passes} passed).\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
