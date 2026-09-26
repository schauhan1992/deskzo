/**
 * check:entitlements — plans decide what a workspace may use, and the workspace obeys.
 *
 * On a scratch control plane, with one real workspace set up on the local server (both dropped at
 * the end, pass or fail):
 *
 *   · the rules: a module brings what it needs, taking one away takes what needs it, a malformed
 *     answer is the core only, India's modules and features are India's;
 *   · plans: what a plan may hold, one default, a new workspace starting on the default plan or its
 *     invitation's, limits added up, staff overrides, a workspace abroad;
 *   · inside the workspace: a module outside the plan refuses its actions, says so on its pages and
 *     in Settings, cannot be switched on, and is gone from the public tablet — while the pages that
 *     borrow from it (the company page, the dashboard, the layout) still render;
 *   · seats: every way an account becomes active is refused once they are taken, and support
 *     accounts take none;
 *   · the copilot's monthly allowance; e-way bills outside India;
 *   · the console: who may change plans, and its pages.
 *
 * No mail leaves, no worker process is started, no password is typed anywhere.
 */
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import Module from "node:module";
import path from "node:path";
import bcrypt from "bcryptjs";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";
import { MODULE_REGISTRY } from "../src/lib/modules";

process.env.WROFFY_TENANCY_FALLBACK = "legacy";
// Emptied, not deleted: a Prisma client imported later reloads .env and would put a deleted value back.
process.env.TRUST_PROXY = "";
process.env.PLATFORM_CONSOLE_IP_ALLOWLIST = "";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
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
    return err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
  }
}

// ─── A request: the console's cookie, and whoever is signed in to the workspace ────────────────
const jar = new Map<string, string>();
const requestHeaders = new Headers({ host: "admin.localhost:3000", "user-agent": "check:entitlements" });
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
  // The workspace's sign-in: whoever `actor` is. Everything after it — the gate, view-as, the
  // permission resolver — is the real code.
  if (request === "@/lib/auth") {
    const session = async () => (actor ? { user: { ...actor, sid: null } } : null);
    return { auth: session, signIn: async () => {}, signOut: async () => {}, handlers: {} };
  }
  if ((request === "node:child_process" || request === "child_process") && parent?.filename?.endsWith(`console.ts`)) {
    return { spawn: () => ({ unref() {} }) };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

type Page = (props: never) => Promise<unknown>;
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
async function render(page: Page, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<string> {
  const el = await page({ params: Promise.resolve(params), searchParams: Promise.resolve({}), ...extra } as never);
  return renderToStaticMarkup((await resolveAsync(el)) as ReactElement);
}
/** Rendered, or why not — for a list of pages that must all render. */
const attempt = (page: Page, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => render(page, params, extra).catch((err: Error) => `FAILED ${err.message.split("\n")[0]}`);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const realName = new URL(url).pathname.slice(1);
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);

  section("The rules");
  /* eslint-disable @typescript-eslint/no-require-imports */
  const rules = require("../src/lib/entitlements") as typeof import("../src/lib/entitlements");
  const deps = rules.withDependencies(["renewals"]);
  ok("a module brings what it needs, and what that needs", deps.has("orders") && deps.has("items"), [...deps].join(", "));
  const takes = rules.dependentsOf("items");
  ok("taking one away takes what needs it", takes.has("orders") && takes.has("renewals") && takes.has("sales_documents"), [...takes].join(", "));
  ok("a malformed or missing answer is the core only", rules.parseEntitlements({ v: 2 }).all === false && rules.parseEntitlements(null).modules.length === 0 && rules.parseEntitlements("x").seats === 1);
  const everything = { v: 1 as const, all: true, modules: [], seats: null, copilotTokens: null, plans: [] };
  ok("India's modules are India's, even on a plan of everything", rules.moduleEntitled(everything, "IN", "accounting") && !rules.moduleEntitled(everything, "AE", "accounting") && !rules.moduleEntitled(everything, "AE", "payroll"));
  ok("  and so are e-way bills and e-invoices", rules.featureAvailable("IN", "eway") && !rules.featureAvailable("AE", "eway") && !rules.featureAvailable("AE", "einvoice"));
  const nothing = rules.CORE_ONLY;
  ok("the core and the basics are in every plan, nothing else", rules.moduleEntitled(nothing, "AE", "companies") && rules.moduleEntitled(nothing, "AE", "tasks") && !rules.moduleEntitled(nothing, "IN", "helpdesk"));
  ok("an unknown module is never in a plan", !rules.moduleEntitled(everything, "IN", "no-such-module"));

  section("A scratch control plane");
  ok("the database server is a local one", local);
  if (!local) throw new Error("not a local database");
  const controlName = `${realName}_entcheck_control`;
  const controlUrl = withDatabase(url, controlName);
  const admin = directClient(withDatabase(url, "postgres"));
  const made = new Set<string>();
  let cleanup: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${controlName}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;
    ok("built from its migrations, the internal plan among them", true);

    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    const plans = require("../src/lib/platform/plans") as typeof import("../src/lib/platform/plans");
    const ent = require("../src/lib/platform/entitlements") as typeof import("../src/lib/platform/entitlements");
    const provisioning = require("../src/lib/platform/provisioning") as typeof import("../src/lib/platform/provisioning");
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const access = require("../src/lib/modules-access") as typeof import("../src/lib/modules-access");
    const moduleActions = require("../src/actions/module") as typeof import("../src/actions/module");
    const ticketActions = require("../src/actions/ticket") as typeof import("../src/actions/ticket");
    const userActions = require("../src/actions/user") as typeof import("../src/actions/user");
    const visitorPublic = require("../src/actions/visitor-public") as typeof import("../src/actions/visitor-public");
    const eway = require("../src/actions/eway") as typeof import("../src/actions/eway");
    const seats = require("../src/lib/seats") as typeof import("../src/lib/seats");
    const copilot = require("../src/lib/copilot/settings") as typeof import("../src/lib/copilot/settings");
    const staffLib = require("../src/lib/platform/staff") as typeof import("../src/lib/platform/staff");
    const consoleActions = require("../src/actions/platform/console") as typeof import("../src/actions/platform/console");
    const { formatCompanyId } = require("../src/lib/order-id") as typeof import("../src/lib/order-id");
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    cleanup = async () => {
      await db.$disconnect();
      await closeControlDb();
    };
    const control = controlDb();
    mailer.setTestPlatformMailer(async () => {});
    const refused = async (work: () => Promise<unknown>) => (await thrown(work)).replace(/^\w+: /, "");

    section("What a plan may hold");
    const base = { kind: "EDITION" as const, countries: [] as string[], seats: null, copilotTokens: null, modules: [] as string[] };
    ok("India's modules only in a plan sold only in India", /sold only in IN/.test(await refused(() => plans.savePlan({ ...base, key: "zz-books", name: "Books", modules: ["accounting"] }, "script:check"))));
    ok("  and not in one sold in India and elsewhere", /sold only in IN/.test(await refused(() => plans.savePlan({ ...base, key: "zz-books", name: "Books", modules: ["payroll"], countries: ["IN", "AE"] }, "script:check"))));
    ok("every module is for internal plans only", /internal plan/.test(await refused(() => plans.savePlan({ ...base, key: "zz-all", name: "All", allModules: true }, "script:check"))));
    ok("new workspaces never start on an internal plan", /internal plan/.test(await refused(() => plans.savePlan({ ...base, kind: "INTERNAL", key: "zz-int", name: "Int", isDefault: true }, "script:check"))));
    ok("a key is a key", /key/.test(await refused(() => plans.savePlan({ ...base, key: "Not A Key", name: "X" }, "script:check"))));
    await plans.savePlan({ ...base, key: "zz-crm", name: "CRM", modules: ["workspace"], seats: 2, copilotTokens: 0, isDefault: true }, "script:check");
    await plans.savePlan({ ...base, key: "zz-sales-in", name: "Sales (India)", modules: ["renewals", "accounting"], countries: ["IN"], seats: 10 }, "script:check");
    await plans.savePlan({ ...base, kind: "ADDON", key: "zz-seats", name: "Three more people", seats: 3 }, "script:check");
    await plans.savePlan({ ...base, key: "zz-other", name: "Other", modules: ["domains"], isDefault: true }, "script:check");
    const defaults = await control.plan.findMany({ where: { isDefault: true }, select: { key: true } });
    ok("one default at a time: marking another moves it", defaults.length === 1 && defaults[0]!.key === "zz-other", defaults.map((d) => d.key).join(","));
    await plans.savePlan({ ...base, key: "zz-crm", name: "CRM", modules: ["workspace"], seats: 2, copilotTokens: 0, isDefault: true }, "script:check");
    await plans.savePlan({ ...base, key: "zz-retired", name: "Retired", modules: ["calls"], active: false }, "script:check");

    section("A new workspace starts on a plan");
    ok("  an invitation's retired plan is refused", /no longer offered/.test(await refused(() => provisioning.startProvisioning({ slug: "zzent-x", companyName: "X", ownerName: "X", ownerEmail: "x@zzent.example", ownerPasswordHash: "x", country: "IN", planKey: "zz-retired" }))));
    ok("  and India's plan is not offered abroad", /not offered in AE/.test(await refused(() => provisioning.startProvisioning({ slug: "zzent-y", companyName: "Y", ownerName: "Y", ownerEmail: "y@zzent.example", ownerPasswordHash: "y", country: "AE", planKey: "zz-sales-in" }))));
    const PASSWORD = `zz-${randomBytes(12).toString("base64url")}`;
    const started = await provisioning.startProvisioning({ slug: "zzent-a", companyName: "Zz Entitled Ltd", ownerName: "Asha Zz", ownerEmail: "asha@zzent.example", ownerPasswordHash: await bcrypt.hash(PASSWORD, 10), country: "IN" });
    const job = await provisioning.runNextJob();
    for (const t of await control.tenant.findMany({ select: { dbName: true } })) if (t.dbName) made.add(t.dbName);
    for (const w of await control.warmDatabase.findMany({ select: { dbName: true } })) made.add(w.dbName);
    const row = await control.tenant.findUniqueOrThrow({ where: { id: started.tenantId } });
    const first = rules.parseEntitlements(row.entitlements);
    ok("without an invitation's plan, on the default one", job?.ok === true && first.plans.join() === "zz-crm", job?.error ?? first.plans.join());
    ok("  its entitlements written before it opens: the plan's modules, its seats, no copilot", first.modules.includes("workspace") && !first.modules.includes("helpdesk") && first.seats === 2 && first.copilotTokens === 0, JSON.stringify(first));
    const TID = started.tenantId;

    section("Working entitlements out");
    await plans.setWorkspacePlans(TID, [{ planKey: "zz-sales-in", quantity: 1 }], "script:check");
    let e = await ent.computeEntitlements(TID);
    ok("a plan's modules with everything they need", ["renewals", "orders", "items", "accounting"].every((m) => e.modules.includes(m)), e.modules.join(","));
    await control.tenant.update({ where: { id: TID }, data: { country: "AE" } });
    e = await ent.computeEntitlements(TID);
    ok("abroad, India's modules are left out whatever the plan says", !e.modules.includes("accounting") && e.modules.includes("renewals"));
    await control.tenant.update({ where: { id: TID }, data: { country: "IN" } });
    await plans.setModuleOverride(TID, "items", false, "zz dispute", "zz-staff");
    e = await ent.computeEntitlements(TID);
    ok("a module taken away takes what needs it", !e.modules.includes("items") && !e.modules.includes("orders") && !e.modules.includes("renewals") && e.modules.includes("accounting"), e.modules.join(","));
    await plans.setModuleOverride(TID, "items", null, "", "zz-staff");
    await plans.setModuleOverride(TID, "helpdesk", true, "zz pilot", "zz-staff");
    e = await ent.computeEntitlements(TID);
    ok("a module added comes with what it needs", e.modules.includes("helpdesk") && e.modules.includes("items"));
    ok("  and adding India's module abroad is refused", /sold only in IN/.test(await refused(async () => {
      await control.tenant.update({ where: { id: TID }, data: { country: "AE" } });
      try {
        await plans.setModuleOverride(TID, "payroll", true, "zz pilot", "zz-staff");
      } finally {
        await control.tenant.update({ where: { id: TID }, data: { country: "IN" } });
      }
    })));
    await plans.setModuleOverride(TID, "helpdesk", null, "", "zz-staff");
    await plans.setWorkspacePlans(TID, [{ planKey: "zz-crm", quantity: 1 }, { planKey: "zz-seats", quantity: 2 }], "script:check");
    e = await ent.computeEntitlements(TID);
    ok("limits add up: an edition's seats and an add-on's, times its quantity", e.seats === 2 + 3 * 2, e.seats);
    await plans.setLimitOverrides(TID, { seats: 5, copilotTokens: null }, "script:check");
    ok("  a staff override replaces the sum", (await ent.computeEntitlements(TID)).seats === 5);
    await plans.setLimitOverrides(TID, { seats: null, copilotTokens: null }, "script:check");
    await plans.setWorkspacePlans(TID, [{ planKey: plans.INTERNAL_PLAN_KEY, quantity: 1 }], "script:check");
    e = await ent.computeEntitlements(TID);
    ok("the internal plan: every module, no limits", e.all && e.seats === null && e.copilotTokens === null);
    await plans.setModuleOverride(TID, "vault", false, "zz not for them", "zz-staff");
    e = await ent.computeEntitlements(TID);
    ok("  until something is taken away — then the list says exactly what is left", !e.all && !e.modules.includes("vault") && e.modules.includes("helpdesk"));
    await plans.setModuleOverride(TID, "vault", null, "", "zz-staff");
    ok("a retired plan is not given to another workspace", /retired/.test(await refused(() => plans.setWorkspacePlans(TID, [{ planKey: "zz-retired", quantity: 1 }], "script:check"))));
    await plans.setWorkspacePlans(TID, [{ planKey: "zz-crm", quantity: 1 }], "script:check");
    const audit = await control.platformAuditLog.count({ where: { tenantId: TID, action: { in: ["tenant.plans", "tenant.module-override", "tenant.limit-override"] } } });
    ok("every change is in the platform's audit log", audit >= 8, audit);

    // ─── Inside the workspace ──────────────────────────────────────────────────────────────────
    const SLUG = "zzent-a";
    /** The workspace as a request would find it now — its entitlements read afresh. */
    const inWs = async <T>(work: () => Promise<T>): Promise<T> => {
      registry.forgetRegistry();
      const tenant = (await registry.tenantBySlug(SLUG))!;
      return runAsTenant(tenant, work);
    };
    const owner = await inWs(() => db.user.findFirstOrThrow({ where: { isSuperAdmin: true } }));
    actor = { id: owner.id, name: owner.name, email: owner.email, role: owner.role };

    section("A module outside the plan, inside the workspace");
    const ticketRefusal = await thrown(() => inWs(() => ticketActions.listTickets()));
    ok("its actions refuse — whatever a page shows", /^ModuleNotInPlan: Helpdesk/.test(ticketRefusal), ticketRefusal);
    ok("its access says why", (await inWs(() => moduleActions.moduleAccess("helpdesk"))) === "not-entitled" && !(await inWs(() => moduleActions.isModuleEnabled("helpdesk"))));
    const states = await inWs(() => moduleActions.getModuleStates());
    const helpdesk = states.find((s) => s.key === "helpdesk")!;
    const tasks = states.find((s) => s.key === "tasks")!;
    ok("Settings lists it as outside the plan; the basics are in", !helpdesk.entitled && !helpdesk.enabled && tasks.entitled && tasks.enabled);
    const switchOn = await inWs(() => moduleActions.setModuleEnabled("helpdesk", true));
    ok("  and it cannot be switched on", !switchOn.ok && /plan/.test(switchOn.error));
    const offAndOn = [await inWs(() => moduleActions.setModuleEnabled("workspace", false)), await inWs(() => moduleActions.setModuleEnabled("workspace", true))];
    ok("  a module in the plan still switches off and on", offAndOn.every((r) => r.ok));
    await plans.setModuleOverride(TID, "helpdesk", true, "zz pilot", "zz-staff");
    ok("given the module, its actions answer", Array.isArray(await inWs(() => ticketActions.listTickets())));
    await plans.setModuleOverride(TID, "helpdesk", null, "", "zz-staff");

    section("Public pages go with it");
    const kioskToken = randomBytes(16).toString("hex");
    await inWs(() => db.visitorKiosk.create({ data: { name: "Zz reception", token: kioskToken } }));
    ok("outside the plan, the visitor tablet is a tablet never set up", (await inWs(() => visitorPublic.kioskDirectory(kioskToken))) === null);
    await plans.setModuleOverride(TID, "visitors", true, "zz front desk", "zz-staff");
    ok("  in it, the tablet works", (await inWs(() => visitorPublic.kioskDirectory(kioskToken))) !== null);
    await plans.setModuleOverride(TID, "visitors", null, "", "zz-staff");
    const iclock = require("../src/app/api/biometric/iclock/[[...path]]/route") as typeof import("../src/app/api/biometric/iclock/[[...path]]/route");
    const knock = () =>
      iclock.GET(new Request(`http://zzent-a.localhost:3000/iclock/cdata?SN=ZZENT1&options=all`, { headers: { host: "zzent-a.localhost:3000" } }), {
        params: Promise.resolve({ path: ["cdata"] }),
      });
    const noHr = await knock();
    ok("outside the plan, attendance terminals are turned away to try again later", noHr.status === 503, noHr.status);
    await plans.setModuleOverride(TID, "hr", true, "zz attendance", "zz-staff");
    registry.forgetRegistry();
    const withHr = await knock();
    ok("  in it, they are answered as ever (an unknown terminal is told so)", withHr.status === 401, withHr.status);
    await plans.setModuleOverride(TID, "hr", null, "", "zz-staff");

    section("Pages still render, with what the plan has");
    const company = await inWs(() =>
      db.company.create({ data: { name: "Zz Plan Customer", normalizedName: "zz plan customer", createdById: owner.id, ownerUserId: owner.id, relationshipType: "CLIENT", stage: "CUSTOMER" } as never }),
    );
    const D = "../src/app/(dashboard)";
    const pages: [string, Page, Record<string, unknown>?][] = [
      ["the company page (it borrows from ~20 modules)", (require(`${D}/companies/[id]/page`) as { default: Page }).default, { id: formatCompanyId((company as { companySeq: number }).companySeq) }],
      ["the dashboard", (require(`${D}/dashboard/page`) as { default: Page }).default],
      ["Settings", (require(`${D}/settings/page`) as { default: Page }).default],
      ["Settings → Lists", (require(`${D}/settings/lists/page`) as { default: Page }).default],
    ];
    const broken: string[] = [];
    const html: Record<string, string> = {};
    for (const [name, page, params] of pages) {
      const out = await inWs(() => attempt(page, params ?? {}));
      html[name] = out;
      if (out.startsWith("FAILED")) broken.push(`${name}: ${out}`);
    }
    const Layout = (require(`${D}/layout`) as { default: Page }).default;
    const layout = await inWs(() => attempt(Layout, {}, { children: createElement("main", null, "zz-page") }));
    if (layout.startsWith("FAILED")) broken.push(`the layout: ${layout}`);
    ok("the company page, the dashboard, the layout and Settings render on a CRM-only plan", broken.length === 0, broken.join(" | "));
    // Groups render collapsed, so their headings are what is always there: Workspace sits under
    // Prospecting; the Helpdesk under Support, sales documents under Quotes & Invoices.
    const sidebarGroups = [...layout.matchAll(/>(Prospecting|Support|Quotes &amp; Invoices|My work)</g)].map((m) => m[1]);
    ok("  the sidebar has the plan's modules and not the others", sidebarGroups.includes("Prospecting") && sidebarGroups.includes("My work") && !sidebarGroups.includes("Support") && !sidebarGroups.includes("Quotes &amp; Invoices"), sidebarGroups.join(", "));
    ok("  Settings → Lists leaves out the vault's and projects' lists", !/Credential vault tags|Project types/.test(html["Settings → Lists"]!));
    const Tickets = (require(`${D}/tickets/page`) as { default: Page }).default;
    const Portal = (require(`${D}/settings/portal/page`) as { default: Page }).default;
    const ModulesPage = (require(`${D}/settings/modules/page`) as { default: Page }).default;
    const ticketsPage = text(await inWs(() => attempt(Tickets)));
    ok("the Helpdesk's own page says it is not in the plan", /isn't part of this workspace's plan/.test(ticketsPage), ticketsPage.slice(0, 120));
    ok("  and so does its settings page", /isn't part of this workspace's plan/.test(text(await inWs(() => attempt(Portal)))));
    ok("  and Settings → Modules marks it", /Not in your plan/.test(text(await inWs(() => attempt(ModulesPage)))));

    section("Every module on its own — the pages that borrow still render");
    // One plan per module: it and what it needs, nothing else. A page that shows module B only when
    // module A is on breaks exactly here, with A in the plan and B out of it.
    const sweep = MODULE_REGISTRY.filter((m) => !m.core && !m.inEveryPlan && (!m.countries || m.countries.includes("IN")));
    const sweepBroken: string[] = [];
    const hubs: [string, Page, Record<string, unknown>, Record<string, unknown>?][] = [
      ["company page", pages[0]![1], pages[0]![2]!],
      ["dashboard", pages[1]![1], {}],
      ["layout", Layout, {}, { children: createElement("main", null, "zz-page") }],
    ];
    for (const mod of sweep) {
      const only = [...rules.withDependencies([mod.key])];
      await control.tenant.update({ where: { id: TID }, data: { entitlements: { v: 1, all: false, modules: only, seats: null, copilotTokens: null, plans: [`only-${mod.key}`] } } });
      for (const [name, page, params, extra] of hubs) {
        const out = await inWs(() => attempt(page, params, extra ?? {}));
        if (out.startsWith("FAILED")) sweepBroken.push(`${mod.key} → ${name}: ${out.slice(7, 140)}`);
      }
    }
    await ent.refreshEntitlements(TID);
    ok(`with each of ${sweep.length} modules alone, the company page, the dashboard and the layout render`, sweepBroken.length === 0, sweepBroken.length ? `\n    ${sweepBroken.join("\n    ")}` : "");

    section("Seats");
    await plans.setLimitOverrides(TID, { seats: 2, copilotTokens: null }, "script:check");
    const newUser = (n: number) => ({ name: `Zz Person ${n}`, email: `person${n}@zzent.example`, role: "SALES", temporaryPassword: `zz-${randomBytes(9).toString("base64url")}` });
    const second = await inWs(() => userActions.createUser(newUser(2)));
    const third = await inWs(() => userActions.createUser(newUser(3)));
    ok("with two seats, the owner and one more", second.ok && !third.ok && /every seat is taken/.test(third.ok ? "" : third.error), third.ok ? "third was made" : third.error);
    await inWs(() =>
      db.user.create({ data: { email: "support.zz@platform.invalid", name: "Zz support", role: "SUPPORT_READONLY", kind: "SUPPORT", passwordHash: "x" } }),
    );
    ok("  a support account takes no seat", (await inWs(() => seats.seatsInUse())) === 2);
    const off = second.ok ? await inWs(() => userActions.setUserActive(second.data.id, false)) : { ok: false };
    const thirdAgain = await inWs(() => userActions.createUser(newUser(3)));
    ok("switching somebody off frees their seat", off.ok && thirdAgain.ok);
    const backOn = second.ok ? await inWs(() => userActions.setUserActive(second.data.id, true)) : { ok: true, error: "" };
    ok("  and switching them back on needs one", !backOn.ok && /seat/.test("error" in backOn ? String(backOn.error) : ""));
    await plans.setLimitOverrides(TID, { seats: null, copilotTokens: null }, "script:check");

    section("The copilot's monthly allowance");
    ok("a plan without the copilot stops it", /isn't part of this workspace's plan/.test((await inWs(() => copilot.planStopsCopilot())) ?? ""));
    await plans.setLimitOverrides(TID, { seats: null, copilotTokens: 1000 }, "script:check");
    ok("  with an allowance left, it runs", (await inWs(() => copilot.planStopsCopilot())) === null);
    await inWs(() => db.copilotUsage.create({ data: { userId: owner.id, day: copilot.usageMonthStart(), inputTokens: 700, outputTokens: 400 } }));
    ok("  spent across everybody this month, it stops", /used this month's copilot allowance/.test((await inWs(() => copilot.planStopsCopilot())) ?? ""));
    await plans.setLimitOverrides(TID, { seats: null, copilotTokens: null }, "script:check");

    section("A workspace abroad");
    await plans.setModuleOverride(TID, "sales_documents", true, "zz documents", "zz-staff");
    await control.tenant.update({ where: { id: TID }, data: { country: "AE" } });
    await ent.refreshEntitlements(TID);
    ok("e-way bills are not offered", !(await inWs(() => access.countryFeatureAvailable("eway"))));
    const ewayAbroad = await inWs(() => eway.ewaySettings());
    ok("  their actions say why", !ewayAbroad.ok && /India's/.test(ewayAbroad.ok ? "" : ewayAbroad.error));
    const docsAbroad = (await inWs(() => moduleActions.getModuleStates())).find((s) => s.key === "sales_documents")!;
    ok("  and the sidebar has no e-way register", docsAbroad.enabled && !docsAbroad.navItems.some((i) => i.href === "/sales/eway-bills"));
    await control.tenant.update({ where: { id: TID }, data: { country: "IN" } });
    await plans.setModuleOverride(TID, "sales_documents", null, "", "zz-staff");
    const docsHome = (await inWs(() => moduleActions.getModuleStates())).find((s) => s.key === "sales_documents")!;
    ok("  (at home, with documents in its plan, they are there)", !docsHome.entitled || docsHome.navItems.some((i) => i.href === "/sales/eway-bills"));

    section("The console");
    actor = null;
    const addStaff = async (email: string, role: "OWNER" | "ADMIN" | "BILLING" | "SUPPORT") => (await staffLib.createStaff({ email, name: email.split("@")[0]!, role }, "script:check")).id;
    const actAs = async (userId: string) => {
      const token = randomBytes(32).toString("base64url");
      await control.platformSession.create({ data: { id: sha256(token), userId, expiresAt: new Date(Date.now() + 3_600_000), mfaAt: new Date() } });
      jar.set("wroffy-console", token);
    };
    const ownerStaff = await addStaff("owner@zzent.example", "OWNER");
    const adminStaff = await addStaff("admin@zzent.example", "ADMIN");
    const billingStaff = await addStaff("billing@zzent.example", "BILLING");
    const supportStaff = await addStaff("support@zzent.example", "SUPPORT");
    await actAs(billingStaff);
    const byBilling = await consoleActions.consoleSavePlan({ ...base, key: "zz-billing", name: "Billing's", modules: ["calls"] });
    ok("billing staff make plans", byBilling.ok, byBilling.ok ? "" : byBilling.error);
    await actAs(adminStaff);
    const internalByAdmin = await consoleActions.consoleSavePlan({ ...base, kind: "INTERNAL", key: "zz-internal-2", name: "Internal 2" });
    const onInternal = await consoleActions.consoleSetWorkspacePlans(TID, [{ planKey: plans.INTERNAL_PLAN_KEY, quantity: 1 }]);
    const inviteInternal = await consoleActions.consoleCreateInvite({ note: "zz", uses: 1, days: 1, planKey: plans.INTERNAL_PLAN_KEY });
    ok("an internal plan is an owner's: not made, given or invited to by an admin", !internalByAdmin.ok && !onInternal.ok && !inviteInternal.ok);
    const override = await consoleActions.consoleSetModuleOverride(TID, "calls", true, "zz trial of calls");
    ok("admins override a module", override.ok && (await ent.computeEntitlements(TID)).modules.includes("calls"));
    await actAs(supportStaff);
    const bySupport = await consoleActions.consoleSetWorkspacePlans(TID, [{ planKey: "zz-crm", quantity: 1 }]);
    ok("support staff change no plans", !bySupport.ok);
    await actAs(ownerStaff);
    const PlansPage = (require("../src/app/platform-console/(console)/plans/page") as { default: Page }).default;
    const WorkspacePage = (require("../src/app/platform-console/(console)/workspaces/[slug]/page") as { default: Page }).default;
    const plansHtml = text(await attempt(PlansPage));
    ok("the Plans page lists them, with which new workspaces start on", plansHtml.includes("Sales (India)") && plansHtml.includes("new workspaces") && !plansHtml.startsWith("FAILED"), plansHtml.slice(0, 120));
    const wsHtml = text(await attempt(WorkspacePage, { slug: SLUG }));
    ok("a workspace's page shows its plan, its overrides and the forms to change them", wsHtml.includes("CRM") && wsHtml.includes("added") && wsHtml.includes("Save plans"), wsHtml.slice(0, 160));
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
    await admin.$disconnect();
  }

  console.log(failures === 0 ? "\nAll entitlement checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
