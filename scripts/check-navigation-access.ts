/**
 * Who sees which module — and that the menu, the pages and the actions answer the same way.
 *
 * The menu is built on the server from one rule (`decideModuleAccess`, src/lib/navigation.ts): the
 * workspace's plan, the company's switch, the module's view permission, the role's section. The same
 * rule is what `isModuleEnabled` answers for every page and action, so this suite checks both ends of
 * it for the scenarios the owner's brief lists:
 *
 *   1. a module outside the plan is hidden and refused, whatever the person holds;
 *   2. a module in the plan but not the person's is hidden and refused;
 *   3. a view permission shows the module and its page;
 *   4. view without create: the page, but no create — in the menu or by a hand-made call;
 *   5. a partial module shows only the links held, 6. and none held is no module at all;
 *   7. an admin sees everything the plan has, and nothing it doesn't;
 *   8. a page opened by its address is a 404, 9. an action called directly is refused, and nothing is
 *      read or written first;
 *  10. a person from another workspace opens nothing here.
 *
 * Plus the dashboard (only offered widgets' figures are read), the empty-menu state, a permission
 * taken away mid-session, and a static check that every page under a module's routes asks for it.
 *
 * Probe people are SALES with every key the checks rely on set on the person — a person's grant beats
 * their role — so roles configured in this database can't change the answers. Everything is named
 * ZZPROBE_NAV and removed in a finally.
 *
 *   npm run check:navigation-access
 */
import "dotenv/config";
import { readFileSync, readdirSync, statSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";
import { renderHtml } from "./lib/render-html";

let actorId = "";
class NotFound extends Error {}
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "SALES", name: "Zzprobe Nav", email: `actor${MAIL}` });
    return {
      requireUser: async () => user(),
      currentUser: async () => user(),
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    };
  }
  // A request on the installation's own address (TENANCY_LEGACY_HOSTS), so the workspace is the one
  // every other read here resolves to.
  if (request === "next/headers") {
    return {
      headers: async () => new Headers({ host: "localhost:3000" }),
      cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {}, getAll: () => [], has: () => false }),
    };
  }
  // Pages read the session through NextAuth too; it is the same acting person.
  if (request === "@/lib/auth" || request.endsWith("/lib/auth")) {
    return { auth: async () => ({ user: { id: actorId, role: "SALES", name: "Zzprobe Nav", email: `actor${MAIL}` } }), signOut: async () => {} };
  }
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new NotFound("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => "/dashboard",
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_NAV";
const MAIL = "@zzprobe-nav.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const companies = await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);
  await db.auditLog.deleteMany({ where: { OR: [{ entityId: { in: companyIds } }, { userId: { in: userIds } }] } });
  await db.notification.deleteMany({ where: { userId: { in: userIds } } });
  await db.ticket.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.companyLocation.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  const banks = await db.bankAccount.findMany({ where: { name: { startsWith: TAG } }, select: { ledgerAccountId: true } });
  await db.bankAccount.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.ledgerAccount.deleteMany({ where: { id: { in: banks.map((b) => b.ledgerAccountId) } } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

/** Sets one person's own answer for a key — a person's grant beats their role's. */
async function grant(userId: string, permission: string, allowed: boolean) {
  await db.userPermission.upsert({
    where: { user_permission: { userId, permission } },
    create: { userId, permission, allowed, reason: TAG },
    update: { allowed },
  });
}

/** What a page comes to once rendered: its HTML, or the 404 it asked for. */
async function outcome(page: unknown): Promise<string> {
  // React reports a component's throw on the console as well as rejecting; the 404s are expected.
  const quiet = console.error;
  console.error = () => {};
  try {
    return await renderHtml(page);
  } catch (err) {
    return err instanceof NotFound || String(err).includes("notFound") ? "notFound" : `error: ${String(err)}`;
  } finally {
    console.error = quiet;
  }
}

/** Every page under a module's own routes asks for that module before anything else. */
function staticPageGates() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { MODULE_REGISTRY } = require("../src/lib/modules") as typeof import("../src/lib/modules");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = path.join(process.cwd(), "src", "app", "(dashboard)");
  const pages: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "page.tsx") pages.push(full);
    }
  };
  walk(root);
  const owners = MODULE_REGISTRY.flatMap((m) => m.navItems.map((i) => ({ href: i.href, key: m.key })));
  const missing: string[] = [];
  let checked = 0;
  for (const file of pages) {
    const route = "/" + path.relative(root, path.dirname(file)).split(path.sep).join("/");
    // The most specific owner: /accounting/revenue is Revenue & Close's, /accounting the ledger's.
    const owner = owners
      .filter((o) => route === o.href || route.startsWith(`${o.href}/`))
      .sort((a, b) => b.href.length - a.href.length)[0];
    if (!owner) continue;
    checked += 1;
    const src = readFileSync(file, "utf8");
    const asks = [`isModuleEnabled("${owner.key}")`, `moduleAccess("${owner.key}")`, `ModuleDisabledNotice moduleKey="${owner.key}"`].some((s) => src.includes(s));
    if (!asks) missing.push(`${route} (${owner.key})`);
  }
  ok(`every page under a module's routes asks for its module — ${checked} pages`, missing.length === 0, missing.join(", "));
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { decideModuleAccess, buildNavigation, openModuleKeys, hasModuleNavigation } = require("../src/lib/navigation") as typeof import("../src/lib/navigation");
  const { MODULE_REGISTRY, getModuleDefinition } = require("../src/lib/modules") as typeof import("../src/lib/modules");
  const { PERMISSIONS, PERMISSION_KEYS, sectionPermission } = require("../src/lib/permissions") as typeof import("../src/lib/permissions");
  const { DEFAULT_BRANDING } = require("../src/lib/branding") as typeof import("../src/lib/branding");
  const { Sidebar } = require("../src/components/layout/sidebar") as typeof import("../src/components/layout/sidebar");
  const { CreateMenu } = require("../src/components/layout/create-menu") as typeof import("../src/components/layout/create-menu");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const SECTIONS = PERMISSIONS.filter((p) => p.everyone).map((p) => p.key as string);
  type Plan = { notEntitled?: string[]; off?: string[] };
  const menu = (holds: string[], plan: Plan = {}) =>
    buildNavigation({
      openModules: openModuleKeys((def) => ({ entitled: !plan.notEntitled?.includes(def.key), switchedOn: !plan.off?.includes(def.key) }), new Set(holds)),
      permissions: holds,
      country: "IN",
    });
  const hrefs = (nav: ReturnType<typeof menu>) => nav.flatMap((s) => s.items.map((i) => i.href));
  const groups = (nav: ReturnType<typeof menu>) => nav.map((s) => s.group);
  const facts = { entitled: true, switchedOn: true };
  const orders = getModuleDefinition("orders")!;

  section("The rule, and the menu built from it");

  // 1. Tenant module disabled — the person holds everything.
  ok("1. a module outside the plan is not-entitled, whatever the person holds", decideModuleAccess(orders, { entitled: false, switchedOn: true }, new Set(PERMISSION_KEYS)) === "not-entitled");
  ok("   and is not in their menu", !hrefs(menu([...PERMISSION_KEYS], { notEntitled: ["orders"] })).includes("/orders"));
  ok("   nor is one the company switched off", !hrefs(menu([...PERMISSION_KEYS], { off: ["orders"] })).includes("/orders"));

  // 2. In the plan, not the person's.
  const noView = SECTIONS;
  ok("2. a module in the plan without its view permission is no-permission", decideModuleAccess(orders, facts, new Set(noView)) === "no-permission");
  ok("   and is not in the menu", !hrefs(menu(noView)).includes("/orders"));
  const noSection = ["orders.view", ...SECTIONS.filter((k) => k !== sectionPermission("orders"))];
  ok("   nor is one whose section is unticked for the role, view permission or not", decideModuleAccess(orders, facts, new Set(noSection)) === "no-permission" && !hrefs(menu(noSection)).includes("/orders"));

  // 3. View permission held.
  const leadsMenu = menu(["leads.view", ...SECTIONS]);
  ok("3. with View leads the Sales group carries Leads", groups(leadsMenu).includes("Sales") && hrefs(leadsMenu).includes("/leads"));
  ok("   and without it, Leads alone goes", !hrefs(menu(SECTIONS)).includes("/leads") && hrefs(menu(SECTIONS)).includes("/companies"));

  // 5. Partial module: the ledger's reader, not the finance function.
  const reader = hrefs(menu(["ledger.viewReports", ...SECTIONS]));
  const shownToReader = ["/accounting", "/accounting/journal", "/accounting/accounts", "/accounting/trial-balance", "/accounting/books"];
  const hiddenFromReader = ["/accounting/banking", "/accounting/assets", "/accounting/gst", "/accounting/tds"];
  ok("5. a ledger reader sees the reports and the chart", shownToReader.every((h) => reader.includes(h)), shownToReader.filter((h) => !reader.includes(h)).join(", "));
  ok("   not Banking, Fixed Assets, GST or TDS, which are the finance function's", hiddenFromReader.every((h) => !reader.includes(h)), hiddenFromReader.filter((h) => reader.includes(h)).join(", "));
  const finance = hrefs(menu(["payments.manage", ...SECTIONS]));
  ok("   and the finance function sees those four, not the reports", hiddenFromReader.every((h) => finance.includes(h)) && !finance.includes("/accounting/journal"));

  // 6. Every child unauthorised: the module, open, has no link left — so no heading either.
  const bare = menu(SECTIONS);
  ok("6. with no accounting permission the Accounting group is gone entirely", !groups(bare).includes("Accounting") && !hrefs(bare).some((h) => h.startsWith("/accounting")));
  const allMenus = [bare, leadsMenu, menu([]), menu([...PERMISSION_KEYS]), menu(["ledger.viewReports", ...SECTIONS])];
  ok("   and no menu ever has an empty group", allMenus.every((nav) => nav.every((s) => s.items.length > 0)));

  // 7. An admin: everything the plan has.
  const everything = menu([...PERMISSION_KEYS]);
  const everyHref = MODULE_REGISTRY.flatMap((m) => m.navItems.filter((i) => !i.countries || i.countries.includes("IN")).map((i) => i.href));
  ok("7. holding everything, every module link is in the menu", everyHref.every((h) => hrefs(everything).includes(h)), everyHref.filter((h) => !hrefs(everything).includes(h)).join(", "));
  const smallPlan = menu([...PERMISSION_KEYS], { notEntitled: ["accounting", "revenue_close", "hr", "payroll"] });
  ok("   but not past the plan: no Accounting, no People (HR) for an admin on a plan without them", !groups(smallPlan).includes("Accounting") && !getModuleDefinition("hr")!.navItems.some((i) => hrefs(smallPlan).includes(i.href)));
  ok("   and the administration links come with their permissions", ["/settings", "/settings/access", "/settings/security", "/settings/data", "/performance"].every((h) => hrefs(everything).includes(h)));
  ok("   which nobody else gets", !["/settings", "/settings/access", "/settings/security", "/settings/data", "/performance"].some((h) => hrefs(bare).includes(h)));

  section("No modules assigned");
  const empty = menu([]);
  ok("holding nothing, the menu has no module", !hasModuleNavigation(empty));
  const drawn = (nav: ReturnType<typeof menu>) => renderToStaticMarkup(createElement(Sidebar, { navigation: nav, branding: DEFAULT_BRANDING }));
  ok("  and says so, with the dashboard still there", drawn(empty).includes("No modules assigned") && drawn(empty).includes("contact your administrator") && drawn(empty).includes('href="/dashboard"'));
  ok("  which nobody with a module is told", !drawn(menu(SECTIONS)).includes("No modules assigned"));
  ok("  and the Create menu isn't offered at all", renderToStaticMarkup(createElement(CreateMenu, { openModules: [], permissions: [], canBroadcastNotes: false })) === "");

  section("Every module page asks first");
  staticPageGates();

  /* eslint-disable @typescript-eslint/no-require-imports */
  const { accessContextFor, moduleAccessFor, moduleAvailableForTenant } = require("../src/lib/modules-access") as typeof import("../src/lib/modules-access");
  const companyActions = require("../src/actions/company") as typeof import("../src/actions/company");
  const ticketActions = require("../src/actions/ticket") as typeof import("../src/actions/ticket");
  const orderActions = require("../src/actions/order") as typeof import("../src/actions/order");
  const bankActions = require("../src/actions/bank") as typeof import("../src/actions/bank");
  const payableActions = require("../src/actions/payable") as typeof import("../src/actions/payable");
  const dashboardActions = require("../src/actions/dashboard") as typeof import("../src/actions/dashboard");
  const { searchScopesForMe } = require("../src/actions/search") as typeof import("../src/actions/search");
  const page = (p: string) => (require(`../src/app/(dashboard)/${p}/page`) as { default: (props: unknown) => Promise<unknown> }).default;
  /* eslint-enable @typescript-eslint/no-require-imports */
  const props = { params: Promise.resolve({}), searchParams: Promise.resolve({}) };

  await cleanup();
  try {
    section("The fixture");
    const person = (key: string, role: string) =>
      db.user.create({ data: { name: `Zzprobe ${key}`, email: `${key.toLowerCase()}${MAIL}`, role, passwordHash: "x".repeat(60) } });
    const clerk = await person("Clerk", "SALES");
    const admin = await person("Admin", "ADMIN");
    // Everything the clerk is checked against, on the person, so this database's roles don't matter.
    for (const key of SECTIONS) await grant(clerk.id, key, true);
    for (const key of ["leads.view", "orders.view", "tickets.view", "payments.view", "contacts.view"]) await grant(clerk.id, key, true);
    for (const key of ["tickets.create", "payments.manage", "payments.record", "projects.manage", "orders.approve"]) await grant(clerk.id, key, false);
    const vendor = await db.company.create({
      data: { name: `${TAG} Vendor`, normalizedName: `${TAG} vendor`.toLowerCase(), createdById: admin.id, ownerUserId: clerk.id, relationshipType: "VENDOR" },
    });
    const customer = await db.company.create({
      data: { name: `${TAG} Customer`, normalizedName: `${TAG} customer`.toLowerCase(), createdById: admin.id, ownerUserId: clerk.id, relationshipType: "CLIENT", stage: "CUSTOMER" },
    });
    const ledger = await db.ledgerAccount.create({ data: { code: `${TAG}-1`, name: `${TAG} Bank`, type: "ASSET" } });
    await db.bankAccount.create({ data: { name: `${TAG} Current account`, ledgerAccountId: ledger.id } });
    ok("a clerk (SALES, set on the person), an admin, a vendor, a customer and a bank account", true);

    section("The context the layout builds the menu from");
    const ctx = await accessContextFor(clerk.id);
    const expectedOpen = (await Promise.all(MODULE_REGISTRY.map(async (m) => ((await moduleAccessFor(clerk.id, m.key)) === "available" ? m.key : null)))).filter(Boolean);
    ok("the menu's modules are exactly those every page's gate says yes to", JSON.stringify(ctx.openModules) === JSON.stringify(expectedOpen), ctx.openModules.length);
    const adminCtx = await accessContextFor(admin.id);
    const planned = (await Promise.all(MODULE_REGISTRY.map(async (m) => ((await moduleAvailableForTenant(m.key)) ? m.key : null)))).filter(Boolean);
    ok("7. an admin opens every module this workspace has in its plan and switched on — no more", JSON.stringify(adminCtx.openModules) === JSON.stringify(planned), `${adminCtx.openModules.length} of ${MODULE_REGISTRY.length}`);
    const stranger = await accessContextFor("zzprobe-nav-another-workspaces-user");
    ok("10. somebody this workspace doesn't have — another workspace's account — opens nothing here", stranger.openModules.length === 0 && stranger.permissions.length === 0);

    section("An HR head, as the built-in role starts");
    // The role as migration 20261030130000 writes it — nothing set on the person.
    const hrHead = await person("HrHead", "HR_HEAD");
    const head = await accessContextFor(hrHead.id);
    const headMenu = buildNavigation(head);
    const peopleWork = ["hr", "payroll", "visitors", "engagement", "expenses", "it_assets", "vault", "tasks", "notes", "calendar", "notifications"];
    ok("their menu has the people work, payroll, expenses, assets and their own tools", peopleWork.every((k) => head.openModules.includes(k)), peopleWork.filter((k) => !head.openModules.includes(k)).join(", "));
    const notTheirs = ["companies", "orders", "items", "sales_documents", "payments", "accounting", "marketing", "vendors", "helpdesk", "reports"];
    ok("  and none of the customer, sales or finance modules", !notTheirs.some((k) => head.openModules.includes(k)), notTheirs.filter((k) => head.openModules.includes(k)).join(", "));
    ok("  hiring, biometric and celebrations among its People links", ["/people/hiring", "/people/devices", "/people/celebrations", "/people/payroll"].every((h) => hrefs(headMenu).includes(h)));
    ok("  every IT asset, and Staff & roles to read — but not Settings or Security", hrefs(headMenu).includes("/assets") && hrefs(headMenu).includes("/settings/access") && !hrefs(headMenu).includes("/settings") && !hrefs(headMenu).includes("/settings/security"));
    ok("  they hold payroll and anonymous feedback, and no customer view", head.permissions.includes("payroll.manage") && head.permissions.includes("engagement.readFeedback") && !head.permissions.some((k) => k === "leads.view" || k === "orders.view"));
    actorId = hrHead.id;
    ok("  and /customers by its address is a 404 for them", (await outcome(page("customers")(props))) === "notFound");
    const addStaff = await outcome(page("settings/access/new")(props));
    ok("  while Add a staff account opens for them, rather than saying they can't", !/^(notFound|error)/.test(addStaff) && !addStaff.includes("You can&#x27;t add staff") && !addStaff.includes("You can't add staff"), addStaff.slice(0, 80));

    section("A calling agent, as the role starts");
    // Nothing set on the person: the CALLING role's defaults, which hold no money views since 9 Oct 2026.
    const caller = await person("Caller", "CALLING");
    const calling = await accessContextFor(caller.id);
    const money = ["payments", "receivables", "payables", "sales_documents", "purchase_documents"];
    ok("their menu has no payments, receivables, payables, quotes or invoices", !money.some((k) => calling.openModules.includes(k)), money.filter((k) => calling.openModules.includes(k)).join(", "));
    ok("  but keeps the calls, the companies and the leads they work", ["calls", "companies"].every((k) => calling.openModules.includes(k)) && hrefs(buildNavigation(calling)).includes("/leads"));
    actorId = caller.id;
    ok("  and /payments by its address is a 404 for them", (await outcome(page("payments")(props))) === "notFound");

    section("3–4. View without create");
    actorId = clerk.id;
    const ticketsPage = await outcome(page("tickets")(props));
    ok("3. the clerk opens the Tickets page", !/^(notFound|error)/.test(ticketsPage), ticketsPage.slice(0, 80));
    ok("4. but New ticket's page is a 404", (await outcome(page("tickets/new")(props))) === "notFound");
    const ticketsBefore = await db.ticket.count({ where: { companyId: customer.id } });
    const made = await ticketActions.createTicket({ companyId: customer.id, title: `${TAG} ticket` });
    ok("   and creating one by calling the action is refused", !made.ok, made.ok ? "created" : made.error);
    ok("   with nothing written", (await db.ticket.count({ where: { companyId: customer.id } })) === ticketsBefore);
    await grant(clerk.id, "tickets.create", true);
    const allowed = await ticketActions.createTicket({ companyId: customer.id, title: `${TAG} ticket` });
    ok("   given Create tickets, the same call goes through", allowed.ok, allowed.ok ? "" : allowed.error);

    section("8–9. A section unticked: the address and the action");
    await grant(clerk.id, sectionPermission("companies"), false);
    ok("2. Companies & Leads is no-permission for the clerk", (await moduleAccessFor(clerk.id, "companies")) === "no-permission");
    ok("   not in their menu", !(await accessContextFor(clerk.id)).openModules.includes("companies"));
    for (const p of ["companies", "customers", "leads", "companies/new", "mail-log"]) {
      ok(`8. /${p} by its address is a 404`, (await outcome(page(p)(props))) === "notFound");
    }
    const companiesBefore = await db.company.count();
    const created = await companyActions.createCompany({ name: `${TAG} Sneaky`, relationshipType: "CLIENT" });
    ok("9. createCompany called directly is refused", !created.ok, created.ok ? "created" : created.error);
    ok("   and nothing was written", (await db.company.count()) === companiesBefore);
    const scopes = (await searchScopesForMe()).map((s) => s.key);
    ok("   the header search offers none of its lists", !scopes.some((k) => ["customers", "companies", "leads"].includes(k)), scopes.join(", "));
    const noCompanies = await dashboardActions.getDashboardSummary();
    ok("   the dashboard reads none of its figures", noCompanies.companies === null && noCompanies.customers === null && noCompanies.leads === null);
    await grant(clerk.id, sectionPermission("companies"), true);
    ok("given back, the next request has it again — nothing is held over from before", (await accessContextFor(clerk.id)).openModules.includes("companies") && !/^(notFound|error)/.test(await outcome(page("customers")(props))));

    section("8–9. Orders without View orders");
    await grant(clerk.id, "orders.view", false);
    const order = await orderActions.createOrder({ companyId: customer.id, locationId: "x", itemId: "x", quantity: 1 });
    ok("9. createOrder is refused before its input is even read", !order.ok && /access to Orders/.test(order.error), order.ok ? "created" : order.error);
    ok("8. /orders is a 404", (await outcome(page("orders")(props))) === "notFound");
    await grant(clerk.id, "orders.view", true);

    section("8–9. Banking and Payables");
    ok("8. Banking, without Manage finance records, is a 404", (await outcome(page("accounting/banking")(props))) === "notFound");
    ok("   so are Fixed Assets, GST and TDS", (await Promise.all(["accounting/assets", "accounting/gst", "accounting/tds"].map(async (p) => outcome(page(p)(props))))).every((o) => o === "notFound"));
    ok("9. listBankAccounts called directly returns nothing", (await bankActions.listBankAccounts()).length === 0);
    ok("   nor do the cheques waiting to clear, or a reconciliation", (await bankActions.unclearedCheques()).length === 0 && (await bankActions.reconciliationView({ bankAccountId: ledger.id })) === null);
    actorId = admin.id;
    ok("   while the finance function sees the account", (await bankActions.listBankAccounts()).some((b) => b.name === `${TAG} Current account`));
    ok("   and an admin's vendor statement is there", (await payableActions.vendorStatement(vendor.id)) !== null);
    actorId = clerk.id;
    await grant(clerk.id, "payments.view", false);
    ok("2. without View payments, Payables is no-permission", (await moduleAccessFor(clerk.id, "payables")) === "no-permission");
    ok("8. its page is a 404", (await outcome(page("payables")(props))) === "notFound");
    ok("9. and its reads called directly return nothing", (await payableActions.vendorStatement(vendor.id)) === null && (await payableActions.listOpenBills(vendor.id)).length === 0 && (await payableActions.payablesAging()).rows.length === 0);
    await grant(clerk.id, "payments.view", true);

    section("The dashboard reads only what it may show");
    const summary = await dashboardActions.getDashboardSummary();
    ok("without Record payments, the payments figures aren't read", summary.payments === null);
    ok("  nor the approval queue without Approve orders, nor projects without Manage projects", summary.orders === null && summary.projects === null);
    ok("  nor the books without Manage finance records", summary.finance === null);
    ok("  while what the clerk may see is", summary.companies !== null && summary.leads !== null && summary.tickets !== null);
    actorId = admin.id;
    const adminSummary = await dashboardActions.getDashboardSummary();
    ok("  and an admin's has the payments and the queue", adminSummary.payments !== null && adminSummary.orders !== null);
  } finally {
    await cleanup();
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll navigation access checks passed." : `\n${failures} navigation access check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
