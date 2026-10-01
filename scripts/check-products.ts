/**
 * check:products — each product sold on its own, and Deskzo One as all of them (src/lib/products.ts).
 *
 * On a scratch control plane of its own (<db>_prodcheck_control, built from the migrations), with one
 * real workspace set up on the local server for the billing page — both dropped at the end, pass or
 * fail. `fetch` is a fake of the two gateways that answers from memory; any other address throws, so
 * nothing here leaves the machine. Fixtures are named zzprod-…; the catalogue's own plans are made
 * here with their real keys, on the scratch plane only.
 *
 *   · the catalogue (`npm run platform:plans -- products`): what it makes; run again, it changes
 *     nothing; what staff change afterwards survives; the fields it owns come back when they drift;
 *     a module workspaces have is not taken off unless asked; a dry run writes nothing;
 *   · a plan's product, checked as it is saved and previewed — Deskzo One is every module, only an
 *     edition sells a product, a module sold only in India goes only in a plan sold only there —
 *     products too (Books and People are India's);
 *   · checkout: each rule of what goes together, in its words, and the add-ons' needs;
 *   · plans given by hand: one plan for each product, Deskzo One alone — the preview says the same;
 *   · entitlements: one product, two (the basics once), Deskzo One, and abroad;
 *   · what the customer sees: the billing page's plan picker and the public pricing table, grouped by
 *     product; the console's plan cards, comparison, editor and a workspace's plans — rendered as
 *     server components with a stubbed session, and saved (CHECK_PRODUCTS_RENDERS, or the system's
 *     temporary folder).
 *
 * No mail leaves, no worker process is started, no password is typed anywhere.
 */
import "dotenv/config";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
// Emptied, not deleted: a Prisma client imported later reloads .env and would put a deleted value back.
process.env.TRUST_PROXY = "";
process.env.PLATFORM_CONSOLE_IP_ALLOWLIST = "";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (title: string) => console.log(`\n${title}`);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}
async function thrown(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ─── The two gateways, faked ─────────────────────────────────────────────────────────────────
type Call = { method: string; url: URL; body: string };
const calls: Call[] = [];
let seq = 0;
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  calls.push({ method, url, body: typeof init?.body === "string" ? init.body : "" });
  if (url.host === "api.stripe.com" && method === "POST" && url.pathname === "/v1/checkout/sessions") return answer(200, { id: `cs_zzprod${++seq}`, url: `https://checkout.stripe.test/cs_zzprod${seq}` });
  if (url.host === "api.razorpay.com" && method === "POST" && url.pathname === "/v1/subscriptions") {
    const id = `sub_zzprod${++seq}`;
    return answer(200, { id, entity: "subscription", status: "created", short_url: `https://rzp.test/${id}` });
  }
  throw new Error(`check:products makes no outside calls — ${method} ${url.href}`);
}) as typeof fetch;

// ─── A request, as the workspace and the console see one ────────────────────────────────────
const jar = new Map<string, string>();
const requestHeaders = new Headers({ host: "admin.localhost:3000", "user-agent": "check:products" });
let actor: { id: string; name: string; email: string; role: string } | null = null;
const internals = Module as unknown as { _load(request: string, parent: { filename?: string } | undefined, isMain: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: { filename?: string } | undefined, isMain: boolean) {
  if (request === "next/headers" || request.endsWith(`${path.sep}next${path.sep}headers.js`)) {
    return {
      headers: async () => requestHeaders,
      cookies: async () => ({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        has: (name: string) => jar.has(name),
        set: (name: string, value: string) => void jar.set(name, value),
        delete: (name: string) => void jar.delete(name),
      }),
    };
  }
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    return {
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      permanentRedirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      notFound: () => {
        throw new Error("notFound");
      },
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
      usePathname: () => "/",
      useSearchParams: () => new URLSearchParams(),
      useParams: () => ({}),
    };
  }
  // Whoever `actor` is is signed in to the workspace; everything after the sign-in is the real code.
  if (request === "@/lib/auth") {
    const session = async () => (actor ? { user: { ...actor, sid: null } } : null);
    return { auth: session, signIn: async () => {}, signOut: async () => {}, handlers: {} };
  }
  if ((request === "node:child_process" || request === "child_process") && (parent?.filename?.endsWith(`signup.ts`) || parent?.filename?.endsWith(`console.ts`))) {
    return { spawn: () => ({ unref() {} }) };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

async function resolveAsync(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: unknown }>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    return resolveAsync(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
  }
  if (el.props && "children" in el.props) {
    const kids = await resolveAsync(el.props.children);
    return Array.isArray(kids) ? cloneElement(el, undefined, ...(kids as ReactNode[])) : cloneElement(el, undefined, kids as ReactNode);
  }
  return el;
}
type Page = (props: never) => Promise<unknown>;
async function html(node: unknown): Promise<string> {
  return renderToStaticMarkup((await resolveAsync(node)) as ReactElement);
}
async function renderPage(page: Page, params: Record<string, unknown> = {}, searchParams: Record<string, string> = {}): Promise<string> {
  return html(await page({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams) } as never));
}
const textOf = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
/** Whether each string first appears after the one before it. */
const inOrder = (haystack: string, needles: string[]) => needles.every((n, i) => haystack.indexOf(n) >= 0 && (i === 0 || haystack.indexOf(n) > haystack.indexOf(needles[i - 1]!)));

const RENDERS = process.env.CHECK_PRODUCTS_RENDERS || path.join(os.tmpdir(), "check-products-renders");
function save(name: string, markup: string) {
  mkdirSync(RENDERS, { recursive: true });
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${name}</title><link rel="stylesheet" href="http://localhost:3000/_next/static/css/app/layout.css"></head><body>${markup}</body></html>`;
  writeFileSync(path.join(RENDERS, `${name}.html`), page);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const realName = new URL(url).pathname.slice(1);
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);

  section("A scratch control plane");
  ok("the database server is a local one", local);
  if (!local) throw new Error("not a local database");
  const controlName = `${realName}_prodcheck_control`;
  const controlUrl = withDatabase(url, controlName);
  const admin = directClient(withDatabase(url, "postgres"));
  const made = new Set<string>();
  let cleanup: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${controlName}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;
    ok("built from its migrations", true);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    const settings = require("../src/lib/platform/settings") as typeof import("../src/lib/platform/settings");
    const products = require("../src/lib/products") as typeof import("../src/lib/products");
    const modules = require("../src/lib/modules") as typeof import("../src/lib/modules");
    const rules = require("../src/lib/entitlements") as typeof import("../src/lib/entitlements");
    const choice = require("../src/lib/billing/plan-choice") as typeof import("../src/lib/billing/plan-choice");
    const plans = require("../src/lib/platform/plans") as typeof import("../src/lib/platform/plans");
    const catalogue = require("../src/lib/platform/product-plans") as typeof import("../src/lib/platform/product-plans");
    const ent = require("../src/lib/platform/entitlements") as typeof import("../src/lib/platform/entitlements");
    const preview = require("../src/lib/platform/entitlement-preview") as typeof import("../src/lib/platform/entitlement-preview");
    const checkout = require("../src/lib/billing/checkout") as typeof import("../src/lib/billing/checkout");
    const publicOffer = require("../src/lib/platform/public-offer") as typeof import("../src/lib/platform/public-offer");
    const keys = require("../src/lib/tenancy/keys") as typeof import("../src/lib/tenancy/keys");
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const provisioning = require("../src/lib/platform/provisioning") as typeof import("../src/lib/platform/provisioning");
    const billingActions = require("../src/actions/billing") as typeof import("../src/actions/billing");
    const staffLib = require("../src/lib/platform/staff") as typeof import("../src/lib/platform/staff");
    const consoleActions = require("../src/actions/platform/console") as typeof import("../src/actions/platform/console");
    const consoleBilling = require("../src/actions/platform/console-billing") as typeof import("../src/actions/platform/console-billing");
    const { PlanPicker } = require("../src/components/settings/billing-forms") as typeof import("../src/components/settings/billing-forms");
    const { PricingTableBlock } = require("../src/components/site/blocks/pricing-table") as typeof import("../src/components/site/blocks/pricing-table");
    const siteDefaults = require("../src/components/site/defaults") as typeof import("../src/components/site/defaults");
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    cleanup = async () => {
      await db.$disconnect();
      await closeControlDb();
    };
    const control = controlDb();
    mailer.setTestPlatformMailer(async () => {});
    const refused = (work: () => Promise<unknown>) => thrown(work);
    const R = choice.CHOICE_REFUSALS;
    const P = plans.PLAN_REFUSALS;
    const product = (key: string) => products.productByKey(key)!;
    const label = (key: string) => modules.getModuleDefinition(key)!.label;
    const ACTOR = "script:check:products";

    // ─── The catalogue ──────────────────────────────────────────────────────────────────────
    section("The catalogue: the products as plans");
    const internalBefore = await control.plan.findUniqueOrThrow({ where: { key: plans.INTERNAL_PLAN_KEY } });
    const wanted = catalogue.productCatalogue();
    const dry = await catalogue.syncProductPlans({ actor: ACTOR, dryRun: true });
    ok("a dry run says what it would make, and makes nothing", dry.length === wanted.length && dry.every((l) => l.outcome === "created") && (await control.plan.count()) === 1, dry.map((l) => `${l.key}:${l.outcome}`).join(" "));
    const first = await catalogue.syncProductPlans({ actor: ACTOR });
    ok("the first run makes every plan", first.every((l) => l.outcome === "created") && (await control.plan.count({ where: { key: { in: wanted.map((w) => w.key) } } })) === wanted.length, first.map((l) => `${l.key}:${l.outcome}${l.note ? ` (${l.note})` : ""}`).join(" "));
    const keysMade = wanted.map((w) => w.key);
    ok(
      "  Deskzo One, a plan for each other product, and the three add-ons",
      keysMade.join(",") === [...products.PRODUCTS.map((p) => `deskzo-${p.key}`), "addon-revenue-close", "addon-ai-copilot", "addon-more-people"].join(","),
      keysMade.join(","),
    );
    const row = (key: string) => control.plan.findUniqueOrThrow({ where: { key }, include: { modules: { select: { moduleKey: true } }, prices: true } });
    const one = await row("deskzo-one");
    ok(
      "deskzo-one: an edition of every module, product one, the default, named and described from products.ts",
      one.kind === "EDITION" && one.allModules && one.productKey === "one" && one.isDefault && one.active && one.modules.length === 0 && one.name === product("one").name && one.description === product("one").tagline,
      one,
    );
    ok("  sold everywhere, no limit on people, no copilot (the add-on sells it), no custom domain, no price", one.countries.length === 0 && one.seats === null && one.copilotTokens === 0 && one.customDomains === 0 && one.prices.length === 0);
    const crm = await row("deskzo-crm");
    const crmWanted = [...new Set([...products.BASE_MODULES, ...product("crm").modules])].sort();
    ok("deskzo-crm: the basics and the product's modules, product crm", crm.kind === "EDITION" && crm.productKey === "crm" && !crm.allModules && crm.modules.map((m) => m.moduleKey).sort().join() === crmWanted.join() && crm.name === "Deskzo CRM", crm.modules.map((m) => m.moduleKey).sort().join());
    let everyProductRight = true;
    for (const p of products.PRODUCTS.filter((x) => x.key !== "one")) {
      const r = await row(`deskzo-${p.key}`);
      const want = [...new Set([...products.BASE_MODULES, ...p.modules])].sort().join();
      if (r.productKey !== p.key || r.name !== p.name || r.description !== p.tagline || r.modules.map((m) => m.moduleKey).sort().join() !== want || r.seats !== null) everyProductRight = false;
    }
    ok("  and so for every product: its name, tagline, modules and no seat limit", everyProductRight);
    const books = await row("deskzo-books");
    const people = await row("deskzo-people");
    ok("Books and People are sold in India only — their accounting and payroll are India's — and every other product everywhere", books.countries.join() === "IN" && people.countries.join() === "IN" && (await control.plan.count({ where: { key: { in: keysMade.filter((k) => k.startsWith("deskzo-") && k !== "deskzo-books" && k !== "deskzo-people") }, NOT: { countries: { isEmpty: true } } } })) === 0);
    ok("  People holds payroll, and is sold where payroll is", people.countries.join() === "IN" && people.modules.some((m) => m.moduleKey === "payroll"));
    const rc = await row("addon-revenue-close");
    const copilot = await row("addon-ai-copilot");
    const seats = await row("addon-more-people");
    ok("Revenue & Close: an add-on of its module, India only, no product", rc.kind === "ADDON" && rc.productKey === null && rc.modules.map((m) => m.moduleKey).join() === "revenue_close" && rc.countries.join() === "IN" && rc.name === "Revenue & Close");
    ok("AI Copilot: an add-on of 1,000,000 tokens a month for each unit", copilot.kind === "ADDON" && copilot.copilotTokens === 1_000_000 && copilot.modules.length === 0 && copilot.name === "AI Copilot");
    ok("More people: an add-on of one seat for each unit", seats.kind === "ADDON" && seats.seats === 1 && seats.modules.length === 0 && seats.name === "More people");
    const internalAfter = await control.plan.findUniqueOrThrow({ where: { key: plans.INTERNAL_PLAN_KEY } });
    ok("the internal plan is left alone", internalAfter.updatedAt.getTime() === internalBefore.updatedAt.getTime() && !internalAfter.isDefault && internalAfter.productKey === null);
    ok("each is in the audit log as a script's", (await control.platformAuditLog.count({ where: { action: "plan.create", actorKind: "SCRIPT" } })) === wanted.length);
    ok("a new workspace anywhere starts on Deskzo One", (await plans.planForNewWorkspace(null, "AE"))?.key === "deskzo-one" && (await plans.planForNewWorkspace(null, "IN"))?.key === "deskzo-one");
    ok("nothing is on sale until staff add prices", (await publicOffer.publicOffer("IN")).plans.length === 0 && (await publicOffer.publicOffer("US")).plans.length === 0);

    section("The catalogue: run again");
    const snapshot = async () =>
      JSON.stringify(
        await control.plan.findMany({ orderBy: { key: "asc" }, include: { modules: { orderBy: { moduleKey: "asc" }, select: { moduleKey: true } } } }),
      );
    const auditCount = () => control.platformAuditLog.count();
    const before = await snapshot();
    const auditsBefore = await auditCount();
    const again = await catalogue.syncProductPlans({ actor: ACTOR });
    ok("run again, every plan is unchanged — nothing written, nothing audited", again.every((l) => l.outcome === "unchanged") && (await snapshot()) === before && (await auditCount()) === auditsBefore, again.filter((l) => l.outcome !== "unchanged"));

    // Staff change what is theirs: name, description, where it is sold, limits, order, retired, default.
    const analytics = await row("deskzo-analytics");
    await plans.savePlan(
      {
        key: "deskzo-analytics",
        name: "Analytics Plus",
        kind: "EDITION",
        description: "Our own words",
        modules: analytics.modules.map((m) => m.moduleKey),
        countries: ["IN", "AE"],
        seats: 7,
        copilotTokens: 5000,
        customDomains: 2,
        sortOrder: 95,
        active: false,
      },
      "staff:zz",
    );
    await plans.savePlan({ key: "addon-ai-copilot", name: "Copilot, more", kind: "ADDON", description: copilot.description, modules: [], countries: [], seats: null, copilotTokens: 250_000, sortOrder: 210 }, "staff:zz");
    const staffEdited = await snapshot();
    const third = await catalogue.syncProductPlans({ actor: ACTOR });
    const analyticsAfter = await row("deskzo-analytics");
    ok("what staff change afterwards survives the next run", third.every((l) => l.outcome === "unchanged") && (await snapshot()) === staffEdited, third.filter((l) => l.outcome !== "unchanged"));
    ok(
      "  its name, description, countries, seats, copilot, domains, order and retirement — and its product, kept though left out",
      analyticsAfter.name === "Analytics Plus" && analyticsAfter.description === "Our own words" && analyticsAfter.countries.join() === "IN,AE" && analyticsAfter.seats === 7 && analyticsAfter.copilotTokens === 5000 && analyticsAfter.customDomains === 2 && analyticsAfter.sortOrder === 95 && !analyticsAfter.active && analyticsAfter.productKey === "analytics",
      analyticsAfter,
    );
    ok("  the add-on's allowance as staff set it", (await row("addon-ai-copilot")).copilotTokens === 250_000);
    // Its name back for what follows; the allowance stays as staff set it.
    await plans.savePlan({ key: "addon-ai-copilot", name: "AI Copilot", kind: "ADDON", description: copilot.description, modules: [], countries: [], seats: null, copilotTokens: 250_000, sortOrder: 210 }, "staff:zz");

    // What the catalogue owns drifts: a module taken off, the product cleared — the next run brings them back.
    const projects = await row("deskzo-projects");
    await plans.savePlan({ key: "deskzo-projects", name: "Projects (ours)", kind: "EDITION", productKey: null, modules: ["tasks"], countries: [], seats: 3, copilotTokens: 0, sortOrder: projects.sortOrder }, "staff:zz");
    const drift = await catalogue.syncProductPlans({ actor: ACTOR });
    const projectsAfter = await row("deskzo-projects");
    const driftLine = drift.find((l) => l.key === "deskzo-projects");
    ok("what the catalogue owns comes back: the product and the modules", driftLine?.outcome === "updated" && projectsAfter.productKey === "projects" && projectsAfter.modules.map((m) => m.moduleKey).sort().join() === [...new Set([...products.BASE_MODULES, ...product("projects").modules])].sort().join(), driftLine);
    ok("  and only that: the name and seats staff set stay", projectsAfter.name === "Projects (ours)" && projectsAfter.seats === 3);
    ok("  the run says what it changed", !!driftLine && driftLine.changes.some((c) => c.includes("product none → projects")) && driftLine.changes.some((c) => c.startsWith("modules +")), driftLine?.changes);
    ok("  and every other plan was left as it was", drift.filter((l) => l.key !== "deskzo-projects").every((l) => l.outcome === "unchanged"));

    // A module staff added: taken off when nobody is on the plan; kept while workspaces are, unless asked.
    const vault = await row("deskzo-vault");
    const vaultModules = vault.modules.map((m) => m.moduleKey);
    await plans.savePlan({ key: "deskzo-vault", name: vault.name, kind: "EDITION", modules: [...vaultModules, "helpdesk"], countries: [], seats: null, copilotTokens: 0, sortOrder: vault.sortOrder }, "staff:zz");
    const offVault = await catalogue.syncProductPlans({ actor: ACTOR });
    ok("a module the product does not have is taken off a plan nobody is on", offVault.find((l) => l.key === "deskzo-vault")?.outcome === "updated" && !(await row("deskzo-vault")).modules.some((m) => m.moduleKey === "helpdesk"));
    const makeTenant = async (slug: string, country: string, currency: string) => {
      const id = randomUUID();
      await control.tenant.create({ data: { id, slug, name: `Zz ${slug}`, status: "ACTIVE", keyBundleCipher: keys.sealKeyBundle(id, keys.newKeyBundle()), country, currency, ownerEmail: `owner@${slug}.example` } });
      return id;
    };
    const onVault = await makeTenant("zzprod-vault", "IN", "INR");
    await plans.savePlan({ key: "deskzo-vault", name: vault.name, kind: "EDITION", modules: [...vaultModules, "helpdesk"], countries: [], seats: null, copilotTokens: 0, sortOrder: vault.sortOrder }, "staff:zz");
    await plans.setWorkspacePlans(onVault, [{ planKey: "deskzo-vault", quantity: 1 }], ACTOR);
    const keptVault = await catalogue.syncProductPlans({ actor: ACTOR });
    const keptLine = keptVault.find((l) => l.key === "deskzo-vault");
    ok("  but kept while a workspace is on it — the run says so", keptLine?.outcome === "unchanged" && /kept helpdesk: 1 workspace is on it/.test(keptLine.note ?? "") && (await row("deskzo-vault")).modules.some((m) => m.moduleKey === "helpdesk"), keptLine);
    const allowed = await catalogue.syncProductPlans({ actor: ACTOR, allowRemovals: true });
    ok("  and taken off when asked, the workspace worked out again", allowed.find((l) => l.key === "deskzo-vault")?.outcome === "updated" && !(await ent.computeEntitlements(onVault)).modules.includes("helpdesk") && !rules.parseEntitlements((await control.tenant.findUniqueOrThrow({ where: { id: onVault } })).entitlements).modules.includes("helpdesk"));
    await plans.setWorkspacePlans(onVault, [], ACTOR);

    // An internal plan holding one of the catalogue's keys is never turned into a product.
    await control.plan.delete({ where: { key: "deskzo-campaigns" } });
    await plans.savePlan({ key: "deskzo-campaigns", name: "Zz internal", kind: "INTERNAL", modules: [], countries: [], seats: null, copilotTokens: null }, "staff:zz");
    const internalKey = await catalogue.syncProductPlans({ actor: ACTOR });
    ok("an internal plan with a catalogue key is left alone", internalKey.find((l) => l.key === "deskzo-campaigns")?.outcome === "left alone" && (await row("deskzo-campaigns")).kind === "INTERNAL");
    await control.plan.delete({ where: { key: "deskzo-campaigns" } });
    const remade = await catalogue.syncProductPlans({ actor: ACTOR, dryRun: true });
    ok("  and a missing one is made again — a dry run first, which writes nothing", remade.find((l) => l.key === "deskzo-campaigns")?.outcome === "created" && !(await control.plan.findUnique({ where: { key: "deskzo-campaigns" } })));
    await catalogue.syncProductPlans({ actor: ACTOR });
    ok("  then for real", (await row("deskzo-campaigns")).productKey === "campaigns");
    // Analytics back on sale for what follows.
    await plans.savePlan({ key: "deskzo-analytics", name: "Deskzo Analytics", kind: "EDITION", description: product("analytics").tagline, modules: analyticsAfter.modules.map((m) => m.moduleKey), countries: [], seats: null, copilotTokens: 0, sortOrder: analytics.sortOrder }, "staff:zz");

    // ─── A plan's product ───────────────────────────────────────────────────────────────────
    section("A plan's product, as it is saved");
    const base = { kind: "EDITION" as const, countries: [] as string[], seats: null, copilotTokens: null, modules: [] as string[] };
    ok("only a product products.ts has", (await refused(() => plans.savePlan({ ...base, key: "zzprod-x", name: "Zz X", productKey: "nope" }, ACTOR))) === P.noSuchProduct("nope"));
    ok("only an edition sells one", (await refused(() => plans.savePlan({ ...base, kind: "ADDON", key: "zzprod-x", name: "Zz X", productKey: "crm" }, ACTOR))) === P.productOnEdition);
    ok("every module: an internal plan, or Deskzo One — no other sold plan", (await refused(() => plans.savePlan({ ...base, key: "zzprod-x", name: "Zz X", allModules: true }, ACTOR))) === P.everyModule && /internal plan/.test(P.everyModule));
    ok("  and Deskzo One is every module, never a list", (await refused(() => plans.savePlan({ ...base, key: "zzprod-x", name: "Zz X", productKey: "one", modules: ["helpdesk"] }, ACTOR))) === P.suiteIsEverything);
    ok("India's module in a plan of no product sold everywhere is refused, as before", /Payroll is sold only in IN/.test(await refused(() => plans.savePlan({ ...base, key: "zzprod-x", name: "Zz X", modules: ["payroll"] }, ACTOR))));
    ok("  and in a product's plan too: People with payroll, sold everywhere, is refused", /Payroll is sold only in IN/.test(await refused(() => plans.savePlan({ ...base, key: "zzprod-people-lite", name: "Zz People Lite", productKey: "people", modules: ["hr", "payroll"] }, ACTOR))));
    await plans.savePlan({ ...base, key: "zzprod-people-lite", name: "Zz People Lite", productKey: "people", modules: ["hr", "payroll"], countries: ["IN"] }, ACTOR);
    ok("  sold in India, it is saved", (await row("zzprod-people-lite")).productKey === "people");
    ok("the preview refuses in the same words", (await refused(() => preview.previewPlanSave({ ...base, kind: "BUNDLE", key: "zzprod-x", name: "Zz X", productKey: "books" }))) === P.productOnEdition);
    await plans.savePlan({ ...base, key: "zzprod-crm-pro", name: "Zz CRM Pro", productKey: "crm", modules: [...crmWanted, "forecast"], sortOrder: 15 }, ACTOR);
    await plans.savePlan({ ...base, key: "zzprod-crm-pro", name: "Zz CRM Pro", modules: [...crmWanted, "forecast"], sortOrder: 15 }, ACTOR);
    ok("a product left out of a save is kept", (await row("zzprod-crm-pro")).productKey === "crm");
    await plans.savePlan({ ...base, key: "zzprod-crm-pro", name: "Zz CRM Pro", productKey: null, modules: [...crmWanted, "forecast"], sortOrder: 15 }, ACTOR);
    ok("  and null clears it", (await row("zzprod-crm-pro")).productKey === null);
    await plans.savePlan({ ...base, key: "zzprod-crm-pro", name: "Zz CRM Pro", productKey: "crm", modules: [...crmWanted, "forecast"], sortOrder: 15 }, ACTOR);
    const lastUpdate = await control.platformAuditLog.findFirst({ where: { action: "plan.update" }, orderBy: { at: "desc" } });
    ok("the audit entry names the product", JSON.stringify(lastUpdate?.detail ?? null).includes('"productKey":"crm"'), lastUpdate?.detail);
    await plans.savePlan({ ...base, key: "zzprod-own", name: "Zz Own Edition", modules: ["helpdesk"], sortOrder: 150 }, ACTOR);
    await plans.savePlan({ ...base, kind: "BUNDLE", key: "zzprod-bundle", name: "Zz Close Bundle", modules: ["revenue_close", "accounting"], countries: ["IN"], sortOrder: 230 }, ACTOR);

    // ─── Prices, straight into the scratch plane: no gateway is called to make them ─────────────
    let ext = 0;
    const price = async (key: string, gateway: "STRIPE" | "RAZORPAY", currency: string, amount: number, interval: "MONTH" | "YEAR" = "MONTH") => {
      const plan = await control.plan.findUniqueOrThrow({ where: { key }, select: { id: true } });
      await control.planPrice.create({ data: { planId: plan.id, gateway, currency, interval, amount, externalId: `${gateway === "STRIPE" ? "price" : "plan"}_zzprod${++ext}` } });
    };
    const inr: [string, number][] = [
      ["deskzo-one", 499900],
      ["deskzo-crm", 149900],
      ["zzprod-crm-pro", 249900],
      ["deskzo-books", 199900],
      ["deskzo-people", 99900],
      ["deskzo-desk", 79900],
      ["zzprod-own", 99900],
      ["addon-revenue-close", 149900],
      ["addon-ai-copilot", 49900],
      ["addon-more-people", 19900],
    ];
    for (const [key, amount] of inr) await price(key, "RAZORPAY", "INR", amount);
    await price("deskzo-crm", "RAZORPAY", "INR", 1499000, "YEAR");
    const usd: [string, number][] = [
      ["deskzo-one", 9900],
      ["deskzo-crm", 2900],
      ["deskzo-people", 1900],
      ["deskzo-desk", 1900],
      ["addon-ai-copilot", 900],
      ["addon-more-people", 500],
    ];
    for (const [key, amount] of usd) await price(key, "STRIPE", "USD", amount);
    await settings.setSecret("stripe.secretKey", "sk_test_zz_check_products", "check");
    await settings.setSecret("razorpay.keyId", "rzp_test_zzprod", "check");
    await settings.setSecret("razorpay.keySecret", "rzp_secret_zzprod", "check");

    // ─── Checkout ───────────────────────────────────────────────────────────────────────────
    section("Checkout: what goes together");
    const IN = await makeTenant("zzprod-in", "IN", "INR");
    const US = await makeTenant("zzprod-us", "US", "USD");
    const buy = (tenant: string, items: [string, number][]) =>
      checkout.startCheckout(tenant, { interval: "MONTH", items: items.map(([planKey, quantity]) => ({ planKey, quantity })) }, "https://zzprod.test/settings/billing");
    const inOffer = await checkout.offerFor(IN);
    ok("the offer carries each plan's product", inOffer.plans.find((p) => p.key === "deskzo-crm")?.productKey === "crm" && inOffer.plans.find((p) => p.key === "deskzo-one")?.productKey === "one" && inOffer.plans.find((p) => p.key === "addon-revenue-close")?.productKey === null);
    ok("an add-on alone: a plan first", (await refused(() => buy(IN, [["addon-ai-copilot", 1]]))) === R.noEdition);
    ok("an edition of its own comes alone, as before", (await refused(() => buy(IN, [["zzprod-own", 1], ["deskzo-crm", 1]]))) === R.editionAlone("Zz Own Edition"));
    const suiteWords = await refused(() => buy(IN, [["deskzo-one", 1], ["deskzo-crm", 1]]));
    ok("Deskzo One comes alone among editions", suiteWords === R.suiteAlone && suiteWords.startsWith("Deskzo One already includes every product"), suiteWords);
    const twoCrm = await refused(() => buy(IN, [["deskzo-crm", 1], ["zzprod-crm-pro", 1]]));
    ok("one plan for each product", twoCrm === "Choose one plan for each product — Deskzo CRM and Zz CRM Pro are both Deskzo CRM.", twoCrm);
    const rcWords = await refused(() => buy(IN, [["deskzo-crm", 1], ["addon-revenue-close", 1]]));
    ok("Revenue & Close needs Books or One — it never brings accounting with it", rcWords === "Revenue & Close needs Deskzo Books or Deskzo One.", rcWords);
    const oneRc = await refused(() => buy(IN, [["deskzo-one", 1], ["addon-revenue-close", 1]]));
    ok("  and is included in Deskzo One: bought on top of it, refused as nothing to add", oneRc === "Revenue & Close is already included in Deskzo One — there's nothing to add.", oneRc);
    ok("  an allowance is never 'included': Deskzo One with AI Copilot is allowed", choice.includedRefusal({ key: "addon-ai-copilot", name: "AI Copilot", kind: "ADDON", productKey: null, modules: [] }, [{ key: "deskzo-one", name: "Deskzo One", kind: "EDITION", productKey: "one", allModules: true, modules: ["all"] }]) === null);
    ok("  and nothing was started at a gateway for any of them", calls.length === 0, calls.length);
    const withBooks = await buy(IN, [["deskzo-books", 1], ["addon-revenue-close", 1]]);
    ok("Books with Revenue & Close: bought — a Razorpay page for each", withBooks.gateway === "RAZORPAY" && withBooks.authorisations.length === 2);
    const withOne = await buy(IN, [["deskzo-one", 1], ["addon-ai-copilot", 2]]);
    ok("Deskzo One (Revenue & Close included) with the copilot ×2: bought", withOne.gateway === "RAZORPAY" && withOne.authorisations.length === 2);
    const three = await buy(IN, [["deskzo-crm", 1], ["deskzo-books", 1], ["deskzo-people", 1], ["addon-more-people", 3]]);
    ok("three products and more people: bought, one plan each", three.gateway === "RAZORPAY" && three.authorisations.map((a) => a.plan).join(", ") === "Deskzo CRM, Deskzo Books, Deskzo People, More people", three.gateway === "RAZORPAY" ? three.authorisations.map((a) => a.plan) : three);
    const usBuy = await buy(US, [["deskzo-crm", 1], ["deskzo-desk", 1], ["addon-ai-copilot", 1]]);
    const session = new URLSearchParams(calls.filter((c) => c.url.pathname === "/v1/checkout/sessions").at(-1)?.body ?? "");
    ok("abroad, CRM and Desk with the copilot: one Stripe Checkout of three lines", usBuy.gateway === "STRIPE" && !!session.get("line_items[2][price]") && !session.get("line_items[3][price]"));
    ok("  Deskzo One with another product, refused there too", (await refused(() => buy(US, [["deskzo-one", 1], ["deskzo-desk", 1]]))) === R.suiteAlone);
    ok("  and Books is not on sale abroad at all", /not on sale/.test(await refused(() => buy(US, [["deskzo-books", 1]]))));
    const asChoice = (key: string, kind: "EDITION" | "BUNDLE" | "ADDON", productKey: string | null, mods: string[]) => ({ key, name: key, kind, productKey, modules: mods });
    ok(
      "a bundle that lists accounting itself brings it on purpose",
      choice.choiceRefusal([asChoice("crm", "EDITION", "crm", ["companies"]), asChoice("Zz Close Bundle", "BUNDLE", null, ["revenue_close", "accounting"])]) === null,
    );
    ok(
      "an add-on needing two products names both, and Deskzo One",
      choice.needsRefusal(asChoice("Zz Mixed", "ADDON", null, ["payroll", "revenue_close"]), [asChoice("crm", "EDITION", "crm", ["companies"])]) === "Zz Mixed needs Deskzo People and Deskzo Books, or Deskzo One.",
      choice.needsRefusal(asChoice("Zz Mixed", "ADDON", null, ["payroll", "revenue_close"]), [asChoice("crm", "EDITION", "crm", ["companies"])]),
    );
    ok("  and none with Deskzo One", choice.needsRefusal(asChoice("Zz Mixed", "ADDON", null, ["payroll", "revenue_close"]), [asChoice("one", "EDITION", "one", ["all"])]) === null);

    // ─── By hand ────────────────────────────────────────────────────────────────────────────
    section("Plans given by hand: the product rules hold");
    const HAND = await makeTenant("zzprod-hand", "IN", "INR");
    const byHand = (items: [string, number][]) => plans.setWorkspacePlans(HAND, items.map(([planKey, quantity]) => ({ planKey, quantity })), ACTOR);
    const handPreview = async (items: [string, number][]) => (await preview.previewEntitlements(HAND, { plans: items.map(([planKey, quantity]) => ({ planKey, quantity })) })).refusal;
    const handTwo = await refused(() => byHand([["deskzo-crm", 1], ["zzprod-crm-pro", 1]]));
    ok("two plans of one product: refused, and the preview says the same", handTwo === "Choose one plan for each product — Deskzo CRM and Zz CRM Pro are both Deskzo CRM." && (await handPreview([["deskzo-crm", 1], ["zzprod-crm-pro", 1]])) === handTwo, handTwo);
    const handSuite = await refused(() => byHand([["deskzo-one", 1], ["deskzo-crm", 1]]));
    ok("Deskzo One with another product: refused, the preview the same", handSuite === R.suiteAlone && (await handPreview([["deskzo-one", 1], ["deskzo-crm", 1]])) === R.suiteAlone);
    await byHand([["deskzo-crm", 1], ["deskzo-books", 1], ["addon-more-people", 2]]);
    ok("several products and an add-on: given", (await ent.computeEntitlements(HAND)).plans.join() === "addon-more-people,deskzo-books,deskzo-crm");
    ok("  the internal plan beside a product, and an edition of its own beside one: staff's to judge", (await thrown(() => byHand([[plans.INTERNAL_PLAN_KEY, 1], ["deskzo-crm", 1]]))) === "" && (await thrown(() => byHand([["zzprod-own", 1], ["deskzo-crm", 1]]))) === "");

    // ─── Entitlements ───────────────────────────────────────────────────────────────────────
    section("Entitlements: one product, two, and Deskzo One");
    const expected = (keysWanted: string[], country: string) => [...rules.withDependencies(keysWanted)].filter((k) => rules.soldIn(modules.getModuleDefinition(k)!, country)).sort();
    const E1 = await makeTenant("zzprod-e1", "IN", "INR");
    await plans.setWorkspacePlans(E1, [{ planKey: "deskzo-crm", quantity: 1 }], ACTOR);
    const e1 = await ent.computeEntitlements(E1);
    ok("one product: its modules and the basics, nothing else", e1.modules.join() === expected(crmWanted, "IN").join() && !e1.modules.includes("accounting") && !e1.all, e1.modules.join());
    const E2 = await makeTenant("zzprod-e2", "IN", "INR");
    await plans.setWorkspacePlans(E2, [{ planKey: "deskzo-crm", quantity: 1 }, { planKey: "deskzo-books", quantity: 1 }, { planKey: "addon-ai-copilot", quantity: 2 }], ACTOR);
    const e2 = await ent.computeEntitlements(E2);
    const booksWanted = [...products.BASE_MODULES, ...product("books").modules];
    ok("CRM and Books: both products' modules", e2.modules.join() === expected([...crmWanted, ...booksWanted], "IN").join() && ["calls", "accounting", "sales_documents", "receivables"].every((m) => e2.modules.includes(m)), e2.modules.join());
    ok("  the basics once", new Set(e2.modules).size === e2.modules.length && products.BASE_MODULES.every((m) => e2.modules.filter((x) => x === m).length === 1));
    ok("  no limit on people; the copilot only as bought", e2.seats === null && e2.copilotTokens === 2 * 250_000 && e2.plans.join() === "addon-ai-copilot,deskzo-books,deskzo-crm", e2);
    const E3 = await makeTenant("zzprod-e3", "IN", "INR");
    await plans.setWorkspacePlans(E3, [{ planKey: "deskzo-one", quantity: 1 }], ACTOR);
    const e3 = await ent.computeEntitlements(E3);
    ok("Deskzo One: every module", e3.all && rules.entitledModuleKeys(e3, "IN").length === modules.MODULE_REGISTRY.length);
    const E4 = await makeTenant("zzprod-e4", "AE", "AED");
    await plans.setWorkspacePlans(E4, [{ planKey: "deskzo-one", quantity: 1 }], ACTOR);
    const e4 = await ent.computeEntitlements(E4);
    ok("  abroad, every module sold there — not India's", e4.all && !rules.moduleEntitled(e4, "AE", "accounting") && !rules.moduleEntitled(e4, "AE", "payroll") && rules.moduleEntitled(e4, "AE", "helpdesk"));
    const E5 = await makeTenant("zzprod-e5", "AE", "AED");
    const e5Words = await refused(() => plans.setWorkspacePlans(E5, [{ planKey: "deskzo-people", quantity: 1 }], ACTOR));
    ok("People abroad: not offered — staff can't give it to a workspace in the UAE", /Deskzo People/.test(e5Words) && /AE/.test(e5Words), e5Words);
    await control.tenant.update({ where: { id: E5 }, data: { country: "IN" } });
    await plans.setWorkspacePlans(E5, [{ planKey: "deskzo-people", quantity: 1 }], ACTOR);
    ok("  and in India with it", (await ent.computeEntitlements(E5)).modules.includes("payroll"));

    // ─── The billing page ───────────────────────────────────────────────────────────────────
    section("A new workspace, and its billing page");
    await provisioning.startProvisioning({ slug: "zzprod-ws", companyName: "Zz Products Ltd", ownerName: "Asha Zz", ownerEmail: "asha@zzprod.example", ownerPasswordHash: await bcrypt.hash(randomBytes(9).toString("hex"), 10), country: "IN" });
    const job = await provisioning.runNextJob();
    for (const t of await control.tenant.findMany({ select: { dbName: true } })) if (t.dbName) made.add(t.dbName);
    for (const w of await control.warmDatabase.findMany({ select: { dbName: true } })) made.add(w.dbName);
    const WS = (await control.tenant.findUniqueOrThrow({ where: { slug: "zzprod-ws" } })).id;
    const trial = await control.subscription.findFirstOrThrow({ where: { tenantId: WS }, include: { items: { include: { plan: true } } } });
    const wsEnt = rules.parseEntitlements((await control.tenant.findUniqueOrThrow({ where: { id: WS } })).entitlements);
    ok("it starts on Deskzo One, on a free trial, with every module", job?.ok === true && trial.status === "TRIALING" && trial.items.map((i) => i.plan.key).join() === "deskzo-one" && wsEnt.all, job?.error ?? trial.items.map((i) => i.plan.key));
    const inWs = async <T>(work: () => Promise<T>) => {
      registry.forgetRegistry();
      return runAsTenant((await registry.tenantBySlug("zzprod-ws"))!, work);
    };
    const owner = await inWs(() => db.user.findFirstOrThrow({ where: { isSuperAdmin: true } }));
    actor = { id: owner.id, name: owner.name, email: owner.email, role: owner.role };
    const view = await inWs(() => billingActions.getBilling());
    ok("its owner is offered the products, each with its product", !!view && view.offer.some((p) => p.key === "deskzo-one" && p.productKey === "one") && view.offer.some((p) => p.key === "deskzo-books" && p.productKey === "books"));
    const BillingPage = (require("../src/app/(dashboard)/settings/billing/page") as { default: Page }).default;
    const billingHtml = await inWs(() => renderPage(BillingPage));
    save("billing-page-in", billingHtml);
    const billingText = textOf(billingHtml);
    ok(
      "the plan picker: Deskzo One first, then the products in products.ts's order, then editions of their own, then add-ons",
      inOrder(billingHtml, ["<legend", ">Deskzo One</legend>", ">Deskzo CRM</legend>", ">Deskzo Books</legend>", ">Deskzo People</legend>", ">Deskzo Desk</legend>", ">Editions</legend>", ">Add-ons"]),
      billingText.slice(0, 400),
    );
    ok("  each product with its tagline, and both CRM plans under Deskzo CRM", billingText.includes(product("crm").tagline) && billingText.includes(product("one").tagline) && inOrder(billingHtml, [">Deskzo CRM</legend>", "Zz CRM Pro", ">Deskzo Books</legend>"]));
    ok("  a box for each edition, Deskzo One ticked to start, and the running total", (billingHtml.match(/type="checkbox"/g) ?? []).length === 7 && /Total ₹4,999\.00 a month, before tax — Deskzo One\./.test(billingText), billingText.match(/Total[^.]*\./)?.[0]);
    ok("  and Revenue & Close says it needs nothing more while Deskzo One is chosen", billingText.includes("Revenue & Close") && !billingText.includes("Revenue & Close needs"));
    actor = null;

    // The picker on its own, abroad: no Books, no Revenue & Close; CRM chosen, so its add-on's need shows.
    const usOffer = await checkout.offerFor(US);
    const usPicker = await html(createElement(PlanPicker, { plans: usOffer.plans, currency: usOffer.currency, gateway: usOffer.gateway }));
    save("plan-picker-us", usPicker);
    ok("abroad: in dollars, through Stripe, without Books, People or Revenue & Close", textOf(usPicker).includes("$99.00") && !usPicker.includes("Deskzo Books") && !usPicker.includes("Deskzo People") && !usPicker.includes("Revenue & Close") && /Stripe/.test(usPicker));
    const crmOnly = [...inOffer.plans.filter((p) => p.key !== "deskzo-one")];
    const crmPicker = textOf(await html(createElement(PlanPicker, { plans: crmOnly, currency: "INR", gateway: "RAZORPAY" })));
    ok("  with Deskzo CRM chosen first, Revenue & Close says what it needs", crmPicker.includes("Revenue & Close needs Deskzo Books or Deskzo One.") && /Total ₹1,499\.00 a month/.test(crmPicker), crmPicker.match(/Total[^.]*\./)?.[0]);

    // ─── The public pricing table ───────────────────────────────────────────────────────────
    section("The public pricing table");
    const pricingProps = siteDefaults.DEFAULT_SITE_PAGES.find((p) => p.slug === "pricing")!.blocks.find((b) => b.type === "pricingTable")!.props as import("../src/components/site/blocks/types").PricingTableProps;
    const table = async (searchParams: Record<string, string>) =>
      html(await PricingTableBlock({ props: pricingProps, ctx: { settings: siteDefaults.DEFAULT_SITE_SETTINGS, signupOpen: false, trialDays: 14, searchParams, workspaceSuffix: ".localhost:3000" } }));
    const tIN = await table({ country: "IN" });
    const tUS = await table({ country: "US" });
    const tYear = await table({ country: "IN", interval: "YEAR" });
    save("pricing-in", tIN);
    save("pricing-us", tUS);
    save("pricing-in-yearly", tYear);
    const txIN = textOf(tIN);
    const txUS = textOf(tUS);
    ok("India: the CMS's words — the plans heading, the extras, the trial note", txIN.includes(pricingProps.editionsHeading) && txIN.includes(pricingProps.extrasHeading) && txIN.includes("14-day free trial"));
    ok(
      "  products in order, each under its own name: Deskzo One, CRM, Books, People, Desk — then an edition of its own",
      inOrder(tIN, ["<h3", ">Deskzo One</h3>", ">Deskzo CRM</h3>", ">Deskzo Books</h3>", ">Deskzo People</h3>", ">Deskzo Desk</h3>", ">Zz Own Edition</h3>"]),
    );
    ok("  with each product's tagline from products.ts", ["one", "crm", "books", "people", "desk"].every((k) => txIN.includes(product(k).tagline)));
    ok("  a product with two plans: its name over a card for each", inOrder(tIN, [">Deskzo CRM</h3>", ">Deskzo CRM</h4>", ">Zz CRM Pro</h4>", ">Deskzo Books</h3>"]));
    ok("  Deskzo One says it is every product", txIN.includes("Every product, in one workspace"));
    ok("  People in India includes payroll", inOrder(tIN, [">Deskzo People</h3>", label("payroll"), ">Deskzo Desk</h3>"]));
    ok("  and the add-ons, Revenue & Close among them", inOrder(tIN, [pricingProps.extrasHeading, "Revenue &amp; Close", "AI Copilot", "More people"]));
    const rcRow = textOf(tIN.slice(tIN.indexOf("Revenue &amp; Close<"), tIN.indexOf("AI Copilot<")));
    ok("  Revenue & Close says what it is an add-on to, that Deskzo One includes it, and lists only its own module — never accounting as if it came with it", rcRow.includes("Revenue & Close is an add-on to Deskzo Books, and included in Deskzo One.") && !rcRow.includes(label("accounting")) && rcRow.includes(label("revenue_close")), rcRow);
    const crmCard = textOf(tIN.slice(tIN.indexOf(">Deskzo CRM</h4>"), tIN.indexOf(">Zz CRM Pro</h4>")));
    ok("  a product's card names the basics every product comes with once, under Always", crmCard.includes(`Always: `) && crmCard.includes(label("workspace")) && crmCard.indexOf(label("workspace")) > crmCard.indexOf("Always: "), crmCard);
    ok("the US: dollars, and no Books, People or Revenue & Close — India's", txUS.includes("$29") && !txUS.includes("Deskzo Books") && !txUS.includes("Deskzo People") && !txUS.includes("Revenue & Close") && txUS.includes("Deskzo Desk"));
    ok("yearly: the CRM's year, with its saving", textOf(tYear).includes("₹14,990") && textOf(tYear).includes("Save 17%"));

    // ─── The console ────────────────────────────────────────────────────────────────────────
    section("The console: plans know their product");
    const actAs = async (userId: string) => {
      const token = randomBytes(32).toString("base64url");
      await control.platformSession.create({ data: { id: sha256(token), userId, expiresAt: new Date(Date.now() + 3_600_000), mfaAt: new Date() } });
      jar.set("deskzo-console", token);
    };
    const ownerStaff = (await staffLib.createStaff({ email: "owner@zzprod.example", name: "Zz Owner", role: "OWNER" }, ACTOR)).id;
    await actAs(ownerStaff);
    const viaConsole = await consoleBilling.consolePreviewPlanSave({ ...base, kind: "ADDON", key: "zzprod-y", name: "Zz Y", productKey: "crm" });
    ok("the console's preview passes the product on, and refuses in the save's words", !viaConsole.ok && viaConsole.error === P.productOnEdition, viaConsole);
    const savedViaConsole = await consoleActions.consoleSavePlan({ ...base, key: "zzprod-desk-plus", name: "Zz Desk Plus", productKey: "desk", modules: ["helpdesk", "feedback"], sortOrder: 45 });
    ok("  and its save keeps it", savedViaConsole.ok && (await row("zzprod-desk-plus")).productKey === "desk");
    const PlansPage = (require("../src/app/platform-console/(console)/plans/page") as { default: Page }).default;
    const PlanPage = (require("../src/app/platform-console/(console)/plans/[key]/page") as { default: Page }).default;
    const WorkspacePage = (require("../src/app/platform-console/(console)/workspaces/[slug]/page") as { default: Page }).default;
    const cards = await renderPage(PlansPage);
    const compare = await renderPage(PlansPage, {}, { view: "compare" });
    const editorOne = await renderPage(PlanPage, { key: "deskzo-one" });
    const editorCrm = await renderPage(PlanPage, { key: "zzprod-crm-pro" });
    const wsConsole = await renderPage(WorkspacePage, { slug: "zzprod-e2" });
    const planPanel = wsConsole.slice(wsConsole.indexOf('id="ws-panel-plan"'));
    save("console-plans-cards", cards);
    save("console-plans-compare", compare);
    save("console-plan-deskzo-one", editorOne);
    save("console-plan-crm-pro", editorCrm);
    save("console-workspace-plans", wsConsole);
    ok("the cards: each edition with its product, in product order", inOrder(textOf(cards), ["Deskzo One — every product", "Deskzo CRM", "Deskzo Books", "No product — an edition of its own"]));
    ok("the comparison: a Product row", /<th scope="row"[^>]*>Product<\/th>/.test(compare) && textOf(compare).includes("Deskzo One — every product"));
    ok("the editor: a Product select, Deskzo One chosen, every module", /<select[^>]*id="plan-field-product"/.test(editorOne) && /<option value="one" selected="">/.test(editorOne) && textOf(editorOne).includes("Deskzo One is every product"));
    ok("  and for another product's plan, that product, with its modules a click away", /<option value="crm" selected="">/.test(editorCrm) && textOf(editorCrm).includes("Use Deskzo CRM's modules"));
    ok("a workspace's plans, grouped by product", wsConsole.includes('id="ws-panel-plan"') && inOrder(textOf(planPanel), ["Deskzo One", "Deskzo CRM", "Zz CRM Pro", "Deskzo Books", "Editions of their own", "Bundles and add-ons", "AI Copilot", "Internal"]), textOf(planPanel).slice(0, 600));
    jar.clear();
  } finally {
    try {
      (require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer")).setTestPlatformMailer(null);
    } catch {
      // Never loaded.
    }
    if (cleanup) await cleanup().catch(() => {});
    for (const name of made) {
      if (/^w_[0-9a-f]{12}$/.test(name)) {
        await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
        await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${name}"`).catch(() => {});
      }
    }
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname = any(${[...made, controlName]})`;
    ok("every database this check made is dropped", Number(left[0].n) === 0, `${made.size + 1} made`);
    ok("and not one request left the machine", calls.every((c) => c.url.host === "api.stripe.com" || c.url.host === "api.razorpay.com"), `${calls.length} faked`);
    await admin.$disconnect();
  }

  console.log(`\nRenders: ${RENDERS}`);
  console.log(failures === 0 ? "\nAll product checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
