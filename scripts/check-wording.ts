/**
 * check:wording — the workspace's own words (owner, 2 Oct 2026): Settings → Wording and the first wave of
 * places that use them — the menu, the create menu, the header search, the list pages' titles and
 * buttons, and an order's status names (src/lib/terms, src/actions/wording.ts).
 *
 * The pure part needs no database: the app's words unless renamed, the forms a word is said in, what a
 * stored choice may hold — and every place in the code that shows a word, read from the source, its
 * template said in the app's own word reading as its text always has.
 *
 * The rest builds a scratch workspace database beside the real one (as check:custom-fields does),
 * renders the real pages as a workspace pointed at it (`runAsTenant`), and drops it at the end:
 *
 *   · a workspace that renamed nothing reads exactly as before;
 *   · settings: only `settings.manage`; words checked; only what differs stored; audited; the screen
 *     opens on the workspace's words and refuses a rep;
 *   · the leads and orders pages, the search and the menu in the workspace's words — the module's own
 *     name untouched; back to the app's words;
 *   · a workspace still waiting for the migration reads the app's words;
 *   · and the real workspace untouched.
 *
 *   npm run check:wording
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  DEFAULT_TERMS,
  ORDER_STATUSES,
  ORDER_STATUS_DEFAULTS,
  TERM_KEYS,
  checkWord,
  renderTerm,
  resolveWording,
  slot,
  statusSlot,
  type Term,
  type TermKey,
} from "../src/lib/terms/dictionary";
import { MODULE_REGISTRY } from "../src/lib/modules";

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

const TAG = "ZZWORDS";

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

const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

/** Awaits every async server component in a tree — the settings page's gate is one — so a static render can take it. */
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

// ── The pure part ───────────────────────────────────────────────────────────────────────────────

const RENAMED = {
  terms: {
    lead: { one: "Enquiry", many: "Enquiries", a: "an" },
    order: { one: "Booking", many: "Bookings", a: "a" },
    customer: { one: "Buyer", many: "Buyers", a: "a" },
  },
  orderStatus: { FULFILLED: "Installed", PENDING_APPROVAL: "Awaiting sign-off" },
};

/**
 * Every place in the code that shows a word, found by reading the source: `slot(…, "canonical", "key",
 * "template")` calls, menu items' and create entries' terms, and search scopes'. Its template, said in
 * the app's own word, must read as its canonical text does — a wrong key or a typo in a template would
 * otherwise show only once a workspace renamed that word. A few say a renamed word differently on
 * purpose, and are listed.
 */
function placements(): { where: string; canonical: string; key: string; template: string }[] {
  const out: { where: string; canonical: string; key: string; template: string }[] = [];
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : []));
  for (const file of walk(join(process.cwd(), "src"))) {
    const s = readFileSync(file, "utf8");
    const where = relative(process.cwd(), file).replaceAll("\\", "/");
    for (const m of s.matchAll(/slot\([^,()]+(?:\([^()]*\))?,\s*"([^"]+)",\s*"([a-z]+)"(?:,\s*"([^"]+)")?\)/g)) {
      out.push({ where, canonical: m[1]!, key: m[2]!, template: m[3] ?? "{many}" });
    }
    for (const m of s.matchAll(/label: "([^"]+)", term: \{ key: "([a-z]+)"(?:, template: "([^"]+)")? \}/g)) {
      out.push({ where, canonical: m[1]!, key: m[2]!, template: m[3] ?? "{many}" });
    }
    for (const m of s.matchAll(/label: "([^"]+)", term: "([a-z]+)",/g)) out.push({ where, canonical: m[1]!, key: m[2]!, template: "{many}" });
  }
  return out;
}

/** Said differently once renamed, on purpose: the app's label is singular or carries a word of its own. */
const SAID_DIFFERENTLY = new Set(["Customer", "Field visits", "Field Visits"]);

function pure() {
  section("The app's own words, unless renamed");
  const plain = resolveWording({});
  ok("an empty choice is the app's words, nothing renamed", plain.renamed.length === 0 && plain.statusRenamed.length === 0 && plain.terms.lead.one === "Lead");
  ok("  and every place shows exactly what it always did", slot(plain, "Lead pipeline", "lead", "{one} pipeline") === "Lead pipeline" && statusSlot(plain, "FULFILLED", "FULFILLED") === "FULFILLED");
  // The places a renamed word is said differently show why the text, not the template, is what shows.
  ok("  even where a renamed word would be said differently", slot(plain, "Customer", "customer") === "Customer" && slot(plain, "Field visits", "visit") === "Field visits");
  const w = resolveWording(RENAMED);
  ok("a renamed word is said in the workspace's own", slot(w, "New lead", "lead", "New {one:lower}") === "New enquiry" && slot(w, "Leads", "lead") === "Enquiries");
  ok("  with its article", renderTerm("Add {a}", w.terms.lead) === "Add an enquiry" && renderTerm("Add {a}", w.terms.order) === "Add a booking");
  ok("  and a word it didn't rename stays the app's", slot(w, "Tickets", "ticket") === "Tickets" && !w.renamed.includes("ticket"));
  ok("a renamed status replaces the text it had, an unrenamed one keeps it", statusSlot(w, "FULFILLED", "FULFILLED") === "Installed" && statusSlot(w, "APPROVED", "APPROVED") === "APPROVED");
  const same = resolveWording({ terms: { lead: { one: "Lead", many: "Leads", a: "a" } }, orderStatus: { APPROVED: "Approved" } });
  ok("a word set back to the app's own counts as not renamed", same.renamed.length === 0 && same.statusRenamed.length === 0);
  const junk = resolveWording({ terms: { lead: { one: "<b>x</b>", many: "x", a: "the" }, nope: { one: "A", many: "B" } }, orderStatus: { FULFILLED: "", NOPE: "x" } });
  ok("anything malformed is the app's word again", junk.renamed.length === 0 && junk.statusRenamed.length === 0);
  ok("a word is checked: required, short, no < > { }", checkWord("it", " ") !== null && checkWord("it", "x".repeat(31)) !== null && checkWord("it", "a{b}") !== null && checkWord("it", "Enquiry") === null);

  section("Every place a word shows");
  const found = placements();
  const keys = new Set<string>(TERM_KEYS);
  const unknown = found.filter((p) => !keys.has(p.key));
  ok("found in the menu, the create menu, search and the pages", found.length >= 30, found.length);
  ok("  each names a word the app has", unknown.length === 0, unknown.map((p) => `${p.where}: ${p.key}`).join(", "));
  const mismatched = found.filter(
    (p) => keys.has(p.key) && !SAID_DIFFERENTLY.has(p.canonical) && renderTerm(p.template, DEFAULT_TERMS[p.key as TermKey]).toLowerCase() !== p.canonical.toLowerCase(),
  );
  ok("  and its template, in the app's word, reads as it always has", mismatched.length === 0, mismatched.map((p) => `${p.where}: "${p.canonical}" vs ${p.template}`).join("; "));
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
  const scratchName = `${realName}_wording`;
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
  ok("its wording and companies are as they were", realAfter.counts === realBefore.counts, realAfter.counts);
  ok("  and nothing of this suite's is in it", realAfter.tagged === 0 && realBefore.tagged === 0, realAfter.tagged);

  console.log(failures === 0 ? `\nAll ${passes} wording checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** What the suite must never change in the real workspace. Read-only. */
async function snapshot(client: PrismaClient) {
  const [wording, companies, tagged] = await Promise.all([
    client.terminologySettings.findUnique({ where: { id: "global" }, select: { overrides: true } }),
    client.company.count(),
    client.company.count({ where: { name: { startsWith: TAG } } }),
  ]);
  return { counts: JSON.stringify({ wording: wording?.overrides ?? null, companies }), tagged };
}

// ── The suite ───────────────────────────────────────────────────────────────────────────────────

async function run(scratchUrl: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const settings = require("../src/actions/wording") as typeof import("../src/actions/wording");
  const search = require("../src/actions/search") as typeof import("../src/actions/search");
  const LeadsPage = (require("../src/app/(dashboard)/leads/page") as { default: (p: unknown) => Promise<ReactElement> }).default;
  const OrdersPage = (require("../src/app/(dashboard)/orders/page") as { default: (p: unknown) => Promise<ReactElement> }).default;
  const WordingPage = (require("../src/app/(dashboard)/settings/wording/page") as { default: () => Promise<ReactElement> }).default;
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const tenant = {
    id: randomUUID(),
    slug: "zzwording",
    name: "zzwording",
    status: "ACTIVE" as const,
    dbUrl: scratchUrl,
    primaryHost: "zzwording.localhost",
    hosts: ["zzwording.localhost"],
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
    const admin = await user("Admin", { "settings.manage": true, "leads.view": true, "orders.view": true, "companies.viewAll": true });
    const rep = await user("Rep", { "settings.manage": false, "leads.view": true, "orders.view": true, "companies.viewAll": true });
    const as = (u: { id: string; name: string; email: string; role: string }) => {
      actor = u;
    };
    const company = await db.company.create({
      data: { name: `${TAG} Sunrise Towers`, normalizedName: `${TAG} sunrise towers`.toLowerCase(), createdById: owner.id, ownerUserId: rep.id, stage: "CUSTOMER" },
      select: { id: true },
    });
    const location = await db.companyLocation.create({ data: { companyId: company.id, label: "Site office", isPrimary: true }, select: { id: true } });
    const item = await db.item.create({ data: { name: `${TAG} 2 BHK, Tower B`, sku: `${TAG}-2BHK`, type: "GOOD", sellingPrice: 6500000, createdById: owner.id }, select: { id: true } });
    await db.companyProduct.create({
      data: { companyId: company.id, locationId: location.id, itemId: item.id, quantity: 1, unitPrice: 6500000, orderStatus: "FULFILLED", addedByUserId: rep.id },
    });
    ok("an administrator who manages settings, a rep, a customer with a fulfilled order", !!admin.id && !!company.id);
    const render = async (Page: (p: unknown) => Promise<ReactElement>, params: Record<string, string> = {}) =>
      textOf(renderToStaticMarkup(await Page({ searchParams: Promise.resolve(params) })));

    // ── Before anything is renamed ─────────────────────────────────────────────────────────────
    section("A workspace that renamed nothing");
    as(rep);
    const leadsBefore = await render(LeadsPage);
    const ordersBefore = await render(OrdersPage);
    ok("the leads page reads as it always has", leadsBefore.includes("Lead pipeline") && leadsBefore.includes("New lead"));
    ok("  the orders page too, statuses included", ordersBefore.includes("Orders") && ordersBefore.includes("Punch order") && ordersBefore.includes("FULFILLED") && ordersBefore.includes("Pending Approval"));

    // ── Settings ───────────────────────────────────────────────────────────────────────────────
    section("Settings → Wording");
    // Every word on the screen, as the form sends them: the given ones, the app's elsewhere.
    const all = (over: { terms: Record<string, { one: string; many: string; a: string }>; orderStatus: Record<string, string> }) => ({
      terms: Object.fromEntries(TERM_KEYS.map((k) => [k, (over.terms as Record<string, Term>)[k] ?? DEFAULT_TERMS[k]])),
      orderStatus: Object.fromEntries(ORDER_STATUSES.map((s) => [s, (over.orderStatus as Record<string, string>)[s] ?? ORDER_STATUS_DEFAULTS[s]])),
    });
    ok("a rep can't open it", (await settings.wordingForManage()) === null && !(await settings.saveWording(all(RENAMED))).ok);
    as(admin);
    const empty = await settings.saveWording(all({ terms: { lead: { one: " ", many: "Enquiries", a: "an" } }, orderStatus: {} }));
    ok("an empty word is refused", !empty.ok, errorOf(empty));
    const angle = await settings.saveWording(all({ terms: {}, orderStatus: { FULFILLED: "<b>Done</b>" } }));
    ok("  and so is one with < >", !angle.ok, errorOf(angle));
    const savedNow = await settings.saveWording(all(RENAMED));
    const stored = (await db.terminologySettings.findUniqueOrThrow({ where: { id: "global" }, select: { overrides: true } })).overrides as { terms: Record<string, unknown>; orderStatus: Record<string, unknown> };
    ok(
      "saved, keeping only what differs from the app's words",
      savedNow.ok && Object.keys(stored.terms).sort().join() === "customer,lead,order" && Object.keys(stored.orderStatus).sort().join() === "FULFILLED,PENDING_APPROVAL",
      `${errorOf(savedNow)} ${JSON.stringify(stored)}`,
    );
    const audited = await db.auditLog.findFirst({ where: { entityType: "TerminologySettings" }, orderBy: { createdAt: "desc" }, select: { entityLabel: true } });
    ok("  and audited, word by word", !!audited?.entityLabel.includes("Lead → Enquiry") && audited.entityLabel.includes("Fulfilled → Installed"), audited?.entityLabel);
    const screen = renderToStaticMarkup((await resolveAsync(await WordingPage())) as ReactElement);
    ok(
      "the screen opens with the workspace's words in it, and how each reads",
      screen.includes('value="Enquiry"') && screen.includes('value="Installed"') && screen.includes('value="Tickets"') && textOf(screen).includes("New enquiry · All enquiries · an"),
      textOf(screen).slice(0, 300),
    );
    as(rep);
    // The 404 page (owner, 8 Oct 2026), as for an address the app doesn't have.
    const refused = await resolveAsync(await WordingPage()).then(
      () => "rendered",
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    ok("  a rep opening it gets the 404 page", refused === "NOT_FOUND_CALLED", refused);
    as(admin);

    // ── What people see ────────────────────────────────────────────────────────────────────────
    section("Pages in the workspace's words");
    as(rep);
    const leadsAfter = await render(LeadsPage);
    ok("the leads page: Enquiry pipeline, New enquiry", leadsAfter.includes("Enquiry pipeline") && leadsAfter.includes("New enquiry") && !leadsAfter.includes("Lead pipeline"));
    const ordersAfter = await render(OrdersPage);
    ok(
      "the orders page: Bookings, Punch booking, a fulfilled one Installed, the tab Awaiting sign-off",
      ordersAfter.includes("Bookings") && ordersAfter.includes("Punch booking") && ordersAfter.includes("Installed") && ordersAfter.includes("Awaiting sign-off"),
    );
    const scopes = await search.searchScopesForMe();
    ok("search offers Enquiries and Buyers", scopes.some((s) => s.label === "Enquiries") && scopes.some((s) => s.label === "Buyers"), scopes.map((s) => s.label).join(", "));
    const wording = resolveWording(stored);
    const leadsNav = MODULE_REGISTRY.flatMap((m) => m.navItems).find((i) => i.href === "/leads")!;
    const customersNav = MODULE_REGISTRY.flatMap((m) => m.navItems).find((i) => i.href === "/customers")!;
    ok(
      "the menu says Enquiries and Buyers",
      slot(wording, leadsNav.label, leadsNav.term!.key, leadsNav.term!.template) === "Enquiries" && slot(wording, customersNav.label, customersNav.term!.key, customersNav.term!.template) === "Buyers",
    );
    ok("  while the module's own name — which plans and billing share — stays the app's", MODULE_REGISTRY.find((m) => m.key === "companies")!.label === "Companies & Leads");

    as(admin);
    const back = await settings.saveWording(all({ terms: {}, orderStatus: {} }));
    const cleared = (await db.terminologySettings.findUniqueOrThrow({ where: { id: "global" }, select: { overrides: true } })).overrides as { terms: object; orderStatus: object };
    ok("back to the app's words: nothing stored", back.ok && Object.keys(cleared.terms).length === 0 && Object.keys(cleared.orderStatus).length === 0, JSON.stringify(cleared));
    as(rep);
    ok("  and the pages read as they always did", (await render(LeadsPage)).includes("Lead pipeline"));

    // ── Before the migration ───────────────────────────────────────────────────────────────────
    section("A workspace still waiting for the migration");
    await db.$executeRawUnsafe(`DROP TABLE "terminology_settings"`);
    const leadsWaiting = await render(LeadsPage);
    ok("its pages open, in the app's words", leadsWaiting.includes("Lead pipeline") && leadsWaiting.includes("New lead"));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
