/**
 * check:site — the platform's public website and "find my workspaces".
 *
 * On a scratch control plane and four scratch workspace databases on the local server (all named
 * zzsite-…, all dropped at the end, pass or fail):
 *
 *   · every page renders for an anonymous visitor on the public host, with one h1, no leftover
 *     content tokens and no image files; metadata for each, signup kept out of search engines;
 *   · content is safe to take from an editor: links other than site paths and http(s) are not
 *     links, text is escaped, an unknown block is skipped; every module named is a real one;
 *   · pricing: only active, sellable plans, one currency per country, nothing converted, no
 *     gateway ids; an empty state where nothing is on sale;
 *   · "find my workspaces": the lookup finds active members and owners in workspaces that can be
 *     signed in to — not ones held by staff, not inactive or support accounts — skips a workspace
 *     that fails or does not answer; the action answers identically for a member, a stranger, a bad
 *     address and a bot, mails only the member and only their workspaces, and stops the fourth ask
 *     in an hour; no email address reaches the logs;
 *   · the contact form checks, limits and mails — and without PLATFORM_SALES_EMAIL mails nobody;
 *   · robots.txt and the sitemap open the public host and nothing else; the proxy marks the public
 *     site's pages indexable while signup, a query, a workspace and the console stay noindex;
 *   · AI search crawlers may read the public site (robots.txt and the proxy), AI training and SEO
 *     crawlers may not (owner decision S-D2);
 *   · metadata from the SEO engine's builders is what the site sent before, key for key, for every
 *     entity without keywords; keywords become one "a, b, c" meta line; each page type carries its
 *     JSON-LD (owner decision S-D1) in one script that no text can break out of; no public-site file
 *     imports the scoring engine;
 *   · the header's menus: every link in the server's HTML (no script needed to read them), each menu
 *     a disclosure (aria-expanded, aria-controls, its panel hidden), an accordion on a phone; settings
 *     saved with links only still render; the footer's six columns; the built-in pages' metadata and
 *     robots unchanged;
 *   · the comparison table (caption, headers, marks as words, sources nofollow, the as-of line and
 *     disclaimer), related links and the page map (pages on this site only); a nested page through
 *     the catch-all with its breadcrumb and BreadcrumbList, in the sitemap, served indexable;
 *   · the comparison pages the website seed publishes (scripts/site-content/compare.ts): each passes the
 *     CMS's validator and renders with one h1, a table whose every source is on the competitor's own
 *     website and linked nofollow, the as-of line and both disclaimers, an FAQ, and no price or superlative;
 *   · the products (src/lib/products.ts, their pages scripts/site-content/products.ts): every product has a
 *     published page at its path with one h1 naming it, no price or seat count, every link to a page the
 *     site has; its modules shown and linked to real module pages; the Product menu one link per product
 *     by its products.ts name and tagline, within NAV_LIMITS, and the footer's product columns within
 *     theirs; and every module page's line under its header naming the products it is in.
 *
 * No mail leaves: the platform mailer is replaced.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import Module from "node:module";
import net from "node:net";
import path from "node:path";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.WROFFY_TENANCY_FALLBACK = "legacy";
// Emptied, not deleted: a Prisma client imported later reloads .env and would put a deleted value back.
process.env.TRUST_PROXY = "";
process.env.TRUST_PROXY_HOPS = "";
process.env.TENANCY_LEGACY_HOSTS = "";
process.env.TENANCY_POOLER_URL = "";
process.env.REFERENCE_DATABASE_URL = "";
process.env.PLATFORM_SALES_EMAIL = "";

let failures = 0;
// Straight to stdout: console itself is under test (nothing logged may carry an address).
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  process.stdout.write(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}\n`);
  if (!pass) failures += 1;
};
const section = (title: string) => process.stdout.write(`\n${title}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  u.search = "";
  return u.toString();
}

// ─── Everything logged, kept to be searched for addresses ────────────────────────────────────────
const logged: string[] = [];
const realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  console[level] = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === "string" ? a : a instanceof Error ? `${a.name}: ${a.message}` : JSON.stringify(a))).join(" "));
    realConsole[level](...args);
  };
}

// ─── A request, as the site's pages and actions see one ──────────────────────────────────────────
let requestHeaders = new Headers({ host: "localhost:3000" });
const internals = Module as unknown as { _load(request: string, parent: { filename?: string } | undefined, isMain: boolean): unknown };
const originalLoad = internals._load;
class NotFound extends Error {}
internals._load = function (this: unknown, request: string, parent: { filename?: string } | undefined, isMain: boolean) {
  if (request === "next/headers" || request.endsWith(`${path.sep}next${path.sep}headers.js`)) {
    return {
      headers: async () => requestHeaders,
      cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }),
    };
  }
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new NotFound("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
      usePathname: () => "/",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

// ─── Rendering a server component tree ───────────────────────────────────────────────────────────
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
const html = async (node: unknown) => renderToStaticMarkup((await resolveAsync(node)) as ReactElement);
const textOf = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

async function until(done: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await sleep(50);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);
  section("Scratch databases");
  ok("the database server is a local one", local);
  if (!local) throw new Error("not a local database");

  const NAMES = { control: "zzsite-control", a: "zzsite-ws-a", b: "zzsite-ws-b", c: "zzsite-ws-c", d: "zzsite-ws-d" };
  const admin = directClient(withDatabase(url, "postgres"));
  const dropAll = async () => {
    for (const name of Object.values(NAMES)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  };
  let cleanup: (() => Promise<void>) | null = null;
  let hanging: net.Server | null = null;
  const sockets = new Set<net.Socket>();
  try {
    await dropAll();
    // ── The control plane ──
    await admin.$executeRawUnsafe(`CREATE DATABASE "${NAMES.control}"`);
    const controlUrl = withDatabase(url, NAMES.control);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;
    ok("a control plane, built from its migrations", true);
    // ── Four workspaces: one migrated, three copied from it before anything connects ──
    await admin.$executeRawUnsafe(`CREATE DATABASE "${NAMES.a}"`);
    const wsUrl = (name: string) => withDatabase(url, name);
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: wsUrl(NAMES.a) }, timeout: 10 * 60_000 });
    for (const name of [NAMES.b, NAMES.c, NAMES.d]) await admin.$executeRawUnsafe(`CREATE DATABASE "${name}" TEMPLATE "${NAMES.a}"`);
    ok("four workspace databases, migrated", true);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const keys = require("../src/lib/tenancy/keys") as typeof import("../src/lib/tenancy/keys");
    const { sealForTenant } = require("../src/lib/platform/kek") as typeof import("../src/lib/platform/kek");
    const { closeAllClients } = require("../src/lib/tenancy/clients") as typeof import("../src/lib/tenancy/clients");
    const { PLATFORM_DOMAIN } = require("../src/lib/tenancy/host") as typeof import("../src/lib/tenancy/host");
    const finder = require("../src/lib/platform/find-workspaces") as typeof import("../src/lib/platform/find-workspaces");
    const actions = require("../src/actions/platform/site") as typeof import("../src/actions/platform/site");
    const { publicOffer } = require("../src/lib/platform/public-offer") as typeof import("../src/lib/platform/public-offer");
    const links = require("../src/components/site/links") as typeof import("../src/components/site/links");
    const types = require("../src/components/site/blocks/types") as typeof import("../src/components/site/blocks/types");
    const { SiteBlocks } = require("../src/components/site/blocks/render") as typeof import("../src/components/site/blocks/render");
    const { DEFAULT_SITE_PAGES, DEFAULT_SITE_SETTINGS } = require("../src/components/site/defaults") as typeof import("../src/components/site/defaults");
    const { MODULE_REGISTRY } = require("../src/lib/modules") as typeof import("../src/lib/modules");
    cleanup = async () => {
      mailer.setTestPlatformMailer(null);
      await closeAllClients();
      await closeControlDb();
    };
    const control = controlDb();
    const mail: { to: string; subject: string; text: string }[] = [];
    mailer.setTestPlatformMailer(async (m) => void mail.push(m));
    const port = process.env.PLATFORM_PORT?.trim() ? `:${process.env.PLATFORM_PORT.trim()}` : "";
    const ROOT = `${PLATFORM_DOMAIN}${port}`;
    const at = (host: string, extra: Record<string, string> = {}) => (requestHeaders = new Headers({ host, "user-agent": "Mozilla/5.0 (check:site)", ...extra }));

    // ── Who is where ──
    const ASHA = "Asha.Zz@zzsite.example"; // a member of A, C (held for billing) and D (held by staff)
    const OWNER_B = "Owner.B@ZZsite.example"; // B's recorded owner, with no account in it
    const GONE = "gone.zz@zzsite.example"; // deactivated in B
    const SUPPORT = "support.zz@zzsite.example"; // the platform's support account in B
    const STRANGER = "nobody.zz@zzsite.example";
    const VISITOR = "visitor.zz@zzsite.example";
    const ADDRESSES = [ASHA, OWNER_B, GONE, SUPPORT, STRANGER, VISITOR, "sales-inbox.zz@zzsite.example"];
    const seed = async (name: string, users: { email: string; active?: boolean; kind?: "MEMBER" | "SUPPORT" }[]) => {
      const c = directClient(wsUrl(name));
      try {
        for (const u of users) await c.user.create({ data: { email: u.email, name: "Zz", role: "ADMIN", passwordHash: "x", active: u.active ?? true, kind: u.kind ?? "MEMBER" } });
      } finally {
        await c.$disconnect();
      }
    };
    await seed(NAMES.a, [{ email: ASHA }]);
    await seed(NAMES.b, [{ email: "ravi.zz@zzsite.example" }, { email: GONE, active: false }, { email: SUPPORT, kind: "SUPPORT" }]);
    await seed(NAMES.c, [{ email: ASHA }]);
    await seed(NAMES.d, [{ email: ASHA }]);
    const tenant = async (slug: string, name: string, dbUrl: string, extra: { status?: "ACTIVE" | "SUSPENDED"; suspendedFor?: "BILLING" | "STAFF"; ownerEmail?: string; isDefault?: boolean } = {}) => {
      const id = `zzsite-${randomUUID()}`;
      await control.tenant.create({
        data: {
          id,
          slug,
          name,
          status: extra.status ?? "ACTIVE",
          suspendedFor: extra.suspendedFor ?? null,
          ownerEmail: extra.ownerEmail ?? null,
          isDefault: extra.isDefault ?? false,
          keyBundleCipher: keys.sealKeyBundle(id, keys.newKeyBundle()),
          dbUrlCipher: sealForTenant(id, "db-url", dbUrl),
        },
      });
      return id;
    };
    // A is the default workspace, so the environment's own (DATABASE_URL — the real one) is never asked.
    await tenant("zzsite-a", "Zz Alpha", wsUrl(NAMES.a), { isDefault: true });
    await tenant("zzsite-b", "Zz Bravo", wsUrl(NAMES.b), { ownerEmail: OWNER_B });
    await tenant("zzsite-c", "Zz Charlie", wsUrl(NAMES.c), { status: "SUSPENDED", suspendedFor: "BILLING" });
    await tenant("zzsite-d", "Zz Delta", wsUrl(NAMES.d), { status: "SUSPENDED", suspendedFor: "STAFF" });
    await tenant("zzsite-x", "Zz Unreachable", "postgresql://nobody:none@127.0.0.1:1/zz_nowhere?schema=public");
    registry.forgetRegistry();

    // ── Plans ──
    const plan = (data: { key: string; name: string; kind: "EDITION" | "BUNDLE" | "ADDON" | "INTERNAL"; active?: boolean; countries?: string[]; seats?: number | null; modules?: string[]; prices: { gateway: "STRIPE" | "RAZORPAY"; currency: string; interval: "MONTH" | "YEAR"; amount: number; perSeat?: boolean; active?: boolean; externalId?: string }[] }) =>
      control.plan.create({
        data: {
          key: data.key,
          name: data.name,
          kind: data.kind,
          active: data.active ?? true,
          countries: data.countries ?? [],
          seats: data.seats ?? null,
          description: `${data.name}, for check:site`,
          modules: { create: (data.modules ?? []).map((moduleKey) => ({ moduleKey })) },
          prices: { create: data.prices.map((p) => ({ ...p, perSeat: p.perSeat ?? false, active: p.active ?? true })) },
        },
      });
    await plan({
      key: "zzsite-starter",
      name: "Zz Starter",
      kind: "EDITION",
      countries: ["IN", "US"],
      seats: 5,
      modules: ["helpdesk", "orders"],
      prices: [
        { gateway: "RAZORPAY", currency: "INR", interval: "MONTH", amount: 149_900, externalId: "plan_zzsite_secret_in" },
        { gateway: "RAZORPAY", currency: "INR", interval: "YEAR", amount: 1_499_000 },
        { gateway: "STRIPE", currency: "USD", interval: "MONTH", amount: 2_900, externalId: "price_zzsite_secret_us" },
      ],
    });
    await plan({ key: "zzsite-retired", name: "Zz Retired", kind: "EDITION", active: false, prices: [{ gateway: "RAZORPAY", currency: "INR", interval: "MONTH", amount: 99_900 }] });
    await plan({ key: "zzsite-internal", name: "Zz Internal", kind: "INTERNAL", prices: [{ gateway: "RAZORPAY", currency: "INR", interval: "MONTH", amount: 100 }] });
    await plan({ key: "zzsite-us-only", name: "Zz US Only", kind: "EDITION", countries: ["US"], prices: [{ gateway: "STRIPE", currency: "USD", interval: "MONTH", amount: 9_900 }] });
    await plan({ key: "zzsite-euro", name: "Zz Euro", kind: "EDITION", countries: ["US", "FR"], prices: [{ gateway: "STRIPE", currency: "EUR", interval: "MONTH", amount: 4_900 }] });
    await plan({ key: "zzsite-off", name: "Zz Price Off", kind: "ADDON", prices: [{ gateway: "RAZORPAY", currency: "INR", interval: "MONTH", amount: 5_000, active: false }] });
    await plan({ key: "zzsite-seats", name: "Zz More People", kind: "ADDON", countries: ["IN"], prices: [{ gateway: "RAZORPAY", currency: "INR", interval: "MONTH", amount: 49_900, perSeat: true }] });

    // ─── Content ────────────────────────────────────────────────────────────────────────────────
    section("Content an editor can be trusted with");
    ok(
      "a site path, an anchor, http(s) and a plain email address are links",
      links.safeHref("/pricing") === "/pricing" && links.safeHref("/#modules") === "/#modules" && !!links.safeHref("https://example.com/x") && !!links.safeHref("http://example.com") && links.safeHref("mailto:a@b.c") === "mailto:a@b.c",
    );
    // A mailto: is one plain address (the CMS allows those) — nothing may ride along with it.
    ok(
      "javascript:, data:, a mailto: carrying anything more, another host by //, and whitespace tricks are not",
      ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "mailto:a@b.c?bcc=x@y.z", "mailto:a@b.c,d@e.f?subject=x", "mailto:", "//evil.example", " /\\evil", "java\nscript:x"].every((h) => links.safeHref(h) === null),
    );
    ok("an image only from this site or https", links.safeSrc("/logo.png") === "/logo.png" && !!links.safeSrc("https://example.com/a.png") && links.safeSrc("http://example.com/a.png") === null);
    ok("tokens are filled; unknown ones left to be seen", links.fill("{siteName} · {trialDays} · {nope}", { settings: DEFAULT_SITE_SETTINGS, trialDays: 14 }) === `${DEFAULT_SITE_SETTINGS.siteName} · 14 · {nope}`);
    const allBlocks = DEFAULT_SITE_PAGES.flatMap((p) => p.blocks);
    ok("every default block is a known type", allBlocks.every((b) => (types.BLOCK_TYPES as readonly string[]).includes(b.type)));
    const namedModules = allBlocks.flatMap((b) => (b.type === "moduleGrid" ? b.props.groups.flatMap((g) => g.modules.map((m) => m.key)) : [])).filter((k): k is string => !!k);
    ok("every module the site names is one the product has", namedModules.length > 20 && namedModules.every((k) => MODULE_REGISTRY.some((m) => m.key === k)), namedModules.filter((k) => !MODULE_REGISTRY.some((m) => m.key === k)).join(", "));
    ok("no logos or testimonials in the default content", !allBlocks.some((b) => b.type === "logoCloud" || b.type === "testimonial"));
    ok(
      "the placeholders are placeholders",
      DEFAULT_SITE_SETTINGS.tagline === "Your tagline goes here" && DEFAULT_SITE_SETTINGS.displayDomain === "yourdomain.com" && DEFAULT_SITE_SETTINGS.salesEmail === "sales@yourdomain.com",
    );
    at(ROOT);
    const ctx = { settings: DEFAULT_SITE_SETTINGS, signupOpen: false, trialDays: 14, searchParams: {}, workspaceSuffix: `.${ROOT}` };
    const hostile = await html(
      createElement(SiteBlocks, {
        ctx,
        blocks: [
          { id: "x1", type: "richText", props: { content: [{ type: "paragraph", text: [{ text: "<script>alert(1)</script>" }, { text: "click", href: "javascript:alert(1)" }] }] } },
          { id: "x2", type: "cta", props: { heading: "Go", primary: { kind: "link", label: "Evil", href: "//evil.example" } } },
          { id: "x3", type: "noSuchBlock", props: {} } as never,
          { id: "x4", type: "logoCloud", props: { items: [{ name: "Zz Logo", imageUrl: "javascript:alert(1)" }] } },
        ],
      }),
    );
    ok("text from content is escaped, not markup", hostile.includes("&lt;script&gt;") && !hostile.includes("<script>"));
    ok("a link that fails the check is plain text", !/javascript:/i.test(hostile) && !hostile.includes("evil.example") && hostile.includes("click"));
    ok("an unknown block type is skipped, the rest render", hostile.includes("Go") && hostile.includes("Zz Logo"));

    // ─── Pages ──────────────────────────────────────────────────────────────────────────────────
    section("Every page, for an anonymous visitor on the public host");
    const Layout = (require("../src/app/platform-site/layout") as typeof import("../src/app/platform-site/layout")).default as (p: { children: ReactNode }) => ReactNode;
    const layoutMeta = (require("../src/app/platform-site/layout") as typeof import("../src/app/platform-site/layout")).generateMetadata;
    type RouteModule = { default: (props: never) => Promise<ReactNode>; generateMetadata: (props: never) => Promise<Record<string, unknown>> };
    const routes: Record<string, () => Promise<RouteModule>> = {
      "/": async () => require("../src/app/platform-site/page") as RouteModule,
      "/pricing": async () => require("../src/app/platform-site/pricing/page") as RouteModule,
      "/security": async () => require("../src/app/platform-site/security/page") as RouteModule,
      "/contact": async () => require("../src/app/platform-site/contact/page") as RouteModule,
      "/signin": async () => require("../src/app/platform-site/signin/page") as RouteModule,
      "/signup": async () => require("../src/app/platform-site/signup/page") as RouteModule,
      "/terms": async () => require("../src/app/platform-site/terms/page") as RouteModule,
      "/privacy": async () => require("../src/app/platform-site/privacy/page") as RouteModule,
    };
    const render = async (route: string, query: Record<string, string> = {}) => {
      const mod = await routes[route]!();
      const page = await mod.default({ params: Promise.resolve({}), searchParams: Promise.resolve(query) } as never);
      return html(Layout({ children: page }));
    };
    const pages: Record<string, string> = {};
    for (const route of Object.keys(routes)) {
      try {
        pages[route] = await render(route);
        ok(`${route} renders`, pages[route].length > 1000, `${pages[route].length} bytes`);
      } catch (err) {
        pages[route] = "";
        ok(`${route} renders`, false, err instanceof Error ? err.stack?.split("\n").slice(0, 3).join(" | ") : String(err));
      }
    }
    const everyPage = Object.entries(pages);
    ok("each has exactly one h1", everyPage.every(([, h]) => (h.match(/<h1[\s>]/g) ?? []).length === 1), everyPage.map(([r, h]) => `${r}:${(h.match(/<h1[\s>]/g) ?? []).length}`).join(" "));
    ok("no content token is left unfilled", everyPage.every(([, h]) => !/\{(siteName|tagline|displayDomain|salesEmail|trialDays)\}/.test(h)));
    ok("no image files: the product previews are drawn", everyPage.every(([, h]) => !h.includes("<img")));
    ok("the header and footer carry the site's name, links and the year", everyPage.every(([, h]) => h.includes(DEFAULT_SITE_SETTINGS.siteName) && h.includes('href="/pricing"') && h.includes('href="/security"') && /© 20\d\d/.test(h)));
    const home = textOf(pages["/"] ?? "");
    ok("home: the hero, modules, India and worldwide, security, a preview marked as sample data", ["Sales, accounts, people and support", "Everything a growing company runs on", "Built for India", "Works worldwide", "Each company's data, kept apart", "Sample data"].every((s) => home.includes(s)));
    ok("home: the tagline is the placeholder, the trial length the platform's", home.includes("Your tagline goes here") && home.includes("Free for 14 days") === false && home.includes("14 days"));
    ok("while signup is by invitation, the call to action says so", home.includes("Request an invitation") && !home.includes("Start free trial"));
    await control.platformSetting.upsert({ where: { key: "signup.open" }, create: { key: "signup.open", value: "1", updatedBy: "check:site" }, update: { value: "1" } });
    const openHome = textOf(await render("/"));
    ok("  and once signup is open, it offers the free trial", openHome.includes("Start free trial") && openHome.includes("Free for 14 days"));
    await control.platformSetting.update({ where: { key: "signup.open" }, data: { value: "0" } });
    ok("signin: both ways in, the workspace suffix, a hidden honeypot", (pages["/signin"] ?? "").includes("Find my workspaces") && (pages["/signin"] ?? "").includes(`.${ROOT}`) && /name="website"[^>]*tabindex="-1"|tabindex="-1"[^>]*name="website"/i.test(pages["/signin"] ?? ""));
    ok("signup: the existing flow, asking for an invitation", textOf(pages["/signup"] ?? "").includes("Invitation code") && textOf(pages["/signup"] ?? "").includes("Set up your workspace"));
    ok("terms and privacy are headed as drafts for counsel", ["/terms", "/privacy"].every((r) => textOf(pages[r] ?? "").includes("Draft — for review by counsel")));
    ok("security lists the sub-processors", ["Sub-processors", "Razorpay", "Stripe"].every((s) => textOf(pages["/security"] ?? "").includes(s)));
    const contactSupport = await render("/contact", { topic: "support" });
    ok("contact: ?topic= picks the topic", /<option value="support" selected="">/.test(contactSupport));

    const metas: Record<string, Record<string, unknown>> = {};
    for (const route of Object.keys(routes)) metas[route] = await (await routes[route]!()).generateMetadata({} as never);
    ok("every page has a title and a description", Object.values(metas).every((m) => !!m.title && typeof m.description === "string" && (m.description as string).length > 30));
    ok("signup is kept out of search engines; no other page is", JSON.stringify(metas["/signup"]?.robots) === JSON.stringify({ index: false, follow: false }) && Object.entries(metas).every(([r, m]) => r === "/signup" || m.robots === undefined));
    const lm = await layoutMeta();
    ok("the layout's title template", JSON.stringify(lm.title) === JSON.stringify({ template: `%s · ${DEFAULT_SITE_SETTINGS.siteName}`, default: DEFAULT_SITE_SETTINGS.siteName }), JSON.stringify(lm.title));

    const catchAll = require("../src/app/platform-site/[...slug]/page") as typeof import("../src/app/platform-site/[...slug]/page");
    const missing = await catchAll
      .default({ params: Promise.resolve({ slug: ["no-such-page"] }), searchParams: Promise.resolve({}) } as never)
      .then((el) => html(el))
      .then(() => "rendered", (e: Error) => (e instanceof NotFound ? "notFound" : e.message));
    ok("an address with no page is the site's not-found", missing === "notFound", missing);
    const notFoundPage = (require("../src/app/platform-site/not-found") as typeof import("../src/app/platform-site/not-found")).default;
    ok("  which says so, in the site's frame", textOf(await html(Layout({ children: await notFoundPage() }))).includes("We couldn't find that page"));

    // ─── Pricing ────────────────────────────────────────────────────────────────────────────────
    section("Pricing: what is on sale, in one currency");
    const inOffer = await publicOffer("IN");
    const usOffer = await publicOffer("US");
    const frOffer = await publicOffer("FR");
    const deOffer = await publicOffer("DE");
    const zz = (o: typeof inOffer) => o.plans.map((p) => p.key).filter((k) => k.startsWith("zzsite-")).sort().join(",");
    ok("India: Razorpay, in rupees", inOffer.gateway === "RAZORPAY" && inOffer.currency === "INR" && inOffer.plans.every((p) => p.prices.every((x) => x.currency === "INR")));
    ok("  only active, sellable plans with an active price there", zz(inOffer) === "zzsite-seats,zzsite-starter", zz(inOffer));
    ok("abroad: Stripe, in US dollars when prices are in several currencies", usOffer.gateway === "STRIPE" && usOffer.currency === "USD" && zz(usOffer) === "zzsite-starter,zzsite-us-only" && usOffer.plans.every((p) => p.prices.every((x) => x.currency === "USD")), zz(usOffer));
    ok("  in the one other currency when every price is in it", frOffer.currency === "EUR" && zz(frOffer) === "zzsite-euro", `${frOffer.currency} ${zz(frOffer)}`);
    ok("  and nothing where nothing is sold", zz(deOffer) === "");
    ok("no gateway ids leave the control plane", !JSON.stringify([inOffer, usOffer]).includes("secret") && !JSON.stringify([inOffer, usOffer]).includes("externalId"));
    ok("the trial length comes with it", inOffer.trialDays === 14);
    const pIN = textOf(await render("/pricing", { country: "IN" }));
    const pINyear = textOf(await render("/pricing", { country: "IN", interval: "YEAR" }));
    const pUS = textOf(await render("/pricing", { country: "US" }));
    const pDE = textOf(await render("/pricing", { country: "DE" }));
    ok("the page for India: the plan in rupees, per month, with its modules", pIN.includes("Zz Starter") && pIN.includes("₹1,499") && pIN.includes("/ month") && pIN.includes("Helpdesk") && pIN.includes("Items & Inventory"));
    ok("  never the retired, internal or foreign plans, nor another currency", !["Zz Retired", "Zz Internal", "Zz US Only", "Zz Euro", "Zz Price Off", "$", "€"].some((s) => pIN.includes(s)));
    ok("  a per-person add-on under add-ons", pIN.includes("Zz More People") && pIN.includes("per person"));
    ok("  yearly: the year's price and the saving against twelve months", pINyear.includes("₹14,990") && pINyear.includes("Save 17%"));
    ok("the page for the US: dollars only", pUS.includes("$29") && pUS.includes("Zz US Only") && !pUS.includes("₹") && !pUS.includes("Zz Euro"));
    ok("nothing on sale: says so and offers a conversation", pDE.includes("Nothing is on sale here yet") && pDE.includes("Talk to us"));
    ok("an unknown country falls back to India", textOf(await render("/pricing", { country: "ZZ" })).includes("₹1,499"));

    // ─── Find my workspaces ─────────────────────────────────────────────────────────────────────
    section("Find my workspaces: the lookup");
    const slugs = (list: { slug: string }[]) => list.map((w) => w.slug).join(",");
    const asha = await finder.findWorkspacesFor(ASHA.toLowerCase());
    ok("a member: active workspaces and those held for billing, not those held by staff", slugs(asha) === "zzsite-a,zzsite-c", slugs(asha));
    ok("  each with its own sign-in address", asha[0]?.loginUrl === `http://zzsite-a.${PLATFORM_DOMAIN}${port}/login` && asha.every((w) => w.loginUrl.endsWith("/login") && !w.loginUrl.includes("@")), asha[0]?.loginUrl);
    ok("  the address matched whatever its case", slugs(await finder.findWorkspacesFor("ASHA.ZZ@ZZSITE.EXAMPLE")) === "zzsite-a,zzsite-c");
    ok("the recorded owner, with no account inside", slugs(await finder.findWorkspacesFor(OWNER_B.toLowerCase())) === "zzsite-b");
    ok("not a deactivated account, nor the platform's support account", (await finder.findWorkspacesFor(GONE)).length === 0 && (await finder.findWorkspacesFor(SUPPORT)).length === 0);
    ok("a stranger: nothing", (await finder.findWorkspacesFor(STRANGER)).length === 0);
    ok("a workspace that fails is skipped and logged by name", logged.some((l) => /\[find-workspaces\] skipped zzsite-x: /.test(l)));
    // A database that accepts and never answers.
    hanging = net.createServer((socket) => void sockets.add(socket));
    await new Promise<void>((resolve) => hanging!.listen(0, "127.0.0.1", resolve));
    const slowPort = (hanging.address() as net.AddressInfo).port;
    const slowId = await tenant("zzsite-slow", "Zz Slow", `postgresql://nobody:none@127.0.0.1:${slowPort}/zz_slow?schema=public`);
    registry.forgetRegistry();
    const started = Date.now();
    const withSlow = await finder.findWorkspacesFor(ASHA, { timeoutMs: 400 });
    const took = Date.now() - started;
    ok("a workspace that does not answer is given up on, the rest still found", slugs(withSlow) === "zzsite-a,zzsite-c" && took < 5_000, `${took} ms`);
    ok("  and logged without the address", logged.some((l) => /skipped zzsite-slow: no answer within 0\.4 s/.test(l)));
    await control.tenant.delete({ where: { id: slowId } });
    registry.forgetRegistry();
    for (const s of sockets) s.destroy();

    section("Find my workspaces: the action");
    finder.resetSiteAllowances();
    mail.length = 0;
    const timed = async (input: { email: string; website?: string }) => {
      const t0 = performance.now();
      const answer = await actions.findMyWorkspaces(input);
      return { answer: JSON.stringify(answer), ms: performance.now() - t0 };
    };
    const answers = [await timed({ email: STRANGER }), await timed({ email: "not an address" }), await timed({ email: ASHA, website: "https://spam.example" }), await timed({ email: ASHA })];
    ok("the same answer for a stranger, a bad address, a bot and a member", answers.every((a) => a.answer === '{"ok":true}'), answers.map((a) => a.answer).join(" "));
    ok("  each at once — the lookup is not waited for", answers.every((a) => a.ms < 300), answers.map((a) => `${Math.round(a.ms)}ms`).join(" "));
    await until(() => mail.length >= 1, 15_000);
    await sleep(1_500);
    ok("one mail: to the member", mail.length === 1 && mail[0]?.to === ASHA.toLowerCase(), mail.map((m) => m.to).join(", "));
    const body = mail[0]?.text ?? "";
    ok("  listing their workspaces and their addresses", body.includes("Zz Alpha") && body.includes("Zz Charlie") && body.includes(`zzsite-a.${PLATFORM_DOMAIN}${port}/login`) && body.includes(`zzsite-c.${PLATFORM_DOMAIN}${port}/login`));
    ok("  and no other workspace", !["Zz Bravo", "Zz Delta", "Zz Unreachable", "zzsite-b.", "zzsite-d.", "zzsite-x."].some((s) => body.includes(s)));

    finder.resetSiteAllowances();
    mail.length = 0;
    for (const email of [ASHA, ASHA.toLowerCase(), ASHA, ASHA.toUpperCase()]) await actions.findMyWorkspaces({ email });
    await until(() => mail.length >= 3, 15_000);
    await sleep(1_500);
    ok("three asks an hour for one address; the fourth is answered the same and does nothing", mail.length === 3, `${mail.length} mails`);

    const limits = [{ key: "zzcheck|one", max: 2 }, { key: "zzcheck|all", max: 3 }];
    finder.resetSiteAllowances();
    const now = Date.now();
    const seq = [finder.siteAllowance(limits, finder.HOUR_MS, now), finder.siteAllowance(limits, finder.HOUR_MS, now), finder.siteAllowance(limits, finder.HOUR_MS, now)];
    const other = finder.siteAllowance([{ key: "zzcheck|two", max: 2 }, { key: "zzcheck|all", max: 3 }], finder.HOUR_MS, now);
    const full = finder.siteAllowance([{ key: "zzcheck|three", max: 2 }, { key: "zzcheck|all", max: 3 }], finder.HOUR_MS, now);
    const later = finder.siteAllowance(limits, finder.HOUR_MS, now + finder.HOUR_MS);
    ok("limits: per key, and one refused is counted against none", seq.join() === "true,true,false" && other && !full, `${seq.join()} ${other} ${full}`);
    ok("  a new hour, a new allowance", later);
    finder.resetSiteAllowances();

    // ─── Contact ────────────────────────────────────────────────────────────────────────────────
    section("The contact form");
    mail.length = 0;
    process.env.PLATFORM_SALES_EMAIL = "sales-inbox.zz@zzsite.example";
    const good = { name: "Zz Visitor", email: VISITOR, company: "Zz Visiting Ltd", phone: "+91 98765 43210", topic: "demo", message: "We would like to see the helpdesk and payroll." };
    const refusals = await Promise.all([
      actions.sendContactRequest({ ...good, name: "" }),
      actions.sendContactRequest({ ...good, email: "nope" }),
      actions.sendContactRequest({ ...good, company: "" }),
      actions.sendContactRequest({ ...good, phone: "call me" }),
      actions.sendContactRequest({ ...good, topic: "jobs" }),
      actions.sendContactRequest({ ...good, message: "hi" }),
      actions.sendContactRequest({ ...good, message: "x".repeat(4_001) }),
    ]);
    ok(
      "refused, each naming its field: no name, a bad address, no company, a bad phone, an unknown topic, too short, too long",
      refusals.map((r) => (r.ok ? "ok" : r.field)).join() === "name,email,company,phone,topic,message,message",
      refusals.map((r) => (r.ok ? "ok" : r.field)).join(),
    );
    ok("  and nothing mailed", mail.length === 0);
    ok("a bot (the honeypot) is thanked and nothing is sent", (await actions.sendContactRequest({ ...good, website: "https://spam.example" })).ok && mail.length === 0);
    const sent = await actions.sendContactRequest({ ...good, company: "Zz Visiting Ltd\nBcc: someone@zzsite.example" });
    ok("a real message is mailed to the sales inbox", sent.ok && mail.length === 1 && mail[0]?.to === "sales-inbox.zz@zzsite.example");
    ok("  with the visitor's address to reply to, and their message", (mail[0]?.text ?? "").includes(`Reply to: ${VISITOR}`) && (mail[0]?.text ?? "").includes(good.message));
    ok("  a subject that stays one line", !/[\r\n]/.test(mail[0]?.subject ?? "\n") && (mail[0]?.subject ?? "").includes("Demo"));
    await actions.sendContactRequest(good);
    await actions.sendContactRequest(good);
    const fourth = await actions.sendContactRequest(good);
    ok("three messages an hour from one address; the fourth is refused", !fourth.ok && mail.length === 3, fourth.ok ? "accepted" : fourth.error);
    finder.resetSiteAllowances();
    process.env.PLATFORM_SALES_EMAIL = "";
    mail.length = 0;
    const unset = await actions.sendContactRequest(good);
    ok("without PLATFORM_SALES_EMAIL: thanked, mailed to nobody, and the log says why", unset.ok && mail.length === 0 && logged.some((l) => l.includes("PLATFORM_SALES_EMAIL is not set")));

    // ─── Search engines ─────────────────────────────────────────────────────────────────────────
    section("robots.txt, the sitemap and the proxy");
    const robots = (require("../src/app/robots") as typeof import("../src/app/robots")).default;
    const sitemap = (require("../src/app/sitemap") as typeof import("../src/app/sitemap")).default;
    const { resolveRobots } = require("next/dist/build/webpack/loaders/metadata/resolve-route-data") as { resolveRobots: (r: unknown) => string };
    at(ROOT);
    const rootRobots = resolveRobots(await robots());
    at(`zzsite-a.${ROOT}`);
    const wsRobots = resolveRobots(await robots());
    at(`admin.${ROOT}`);
    const consoleRobots = resolveRobots(await robots());
    const group = (txt: string, agent: string) => txt.split(/\n\n/).find((g) => g.split("\n").some((l) => l.toLowerCase() === `user-agent: ${agent.toLowerCase()}`)) ?? "";
    ok("the public host: everyone may crawl, except signup", /Allow: \/\n/.test(group(rootRobots, "*")) && group(rootRobots, "*").includes("Disallow: /signup"), JSON.stringify(group(rootRobots, "*")));
    // Owner decision S-D2, written out here rather than read from src/lib/seo/crawlers.ts, so a change to the lists shows.
    const AI_SEARCH = ["OAI-SearchBot", "ChatGPT-User", "Claude-SearchBot", "Claude-User", "PerplexityBot", "Perplexity-User"];
    const AI_TRAINING = ["GPTBot", "ClaudeBot", "Claude-Web", "anthropic-ai", "CCBot", "Google-Extended", "Applebot-Extended", "Bytespider", "Amazonbot", "cohere-ai", "Meta-ExternalAgent"];
    const shut = (txt: string, agent: string) => /Disallow: \/(\n|$)/.test(group(txt, agent)) && !/Allow:/.test(group(txt, agent));
    const searchOpen = AI_SEARCH.filter((a) => /Allow: \/\n/.test(group(rootRobots, a)) && group(rootRobots, a).includes("Disallow: /signup") && !/Disallow: \/(\n|$)/.test(group(rootRobots, a)));
    ok("  the AI search crawlers, each named, may read it as search engines do — not signup", searchOpen.length === AI_SEARCH.length, AI_SEARCH.filter((a) => !searchOpen.includes(a)).join(", ") || JSON.stringify(group(rootRobots, "OAI-SearchBot")));
    ok("  the AI training crawlers (GPTBot, ClaudeBot, CCBot…) and the SEO crawlers stay shut out", [...AI_TRAINING, "AhrefsBot", "SemrushBot"].every((a) => shut(rootRobots, a)), [...AI_TRAINING, "AhrefsBot", "SemrushBot"].filter((a) => !shut(rootRobots, a)).join(", "));
    const crawlers = require("../src/lib/seo/crawlers") as typeof import("../src/lib/seo/crawlers");
    ok("  the SEO engine reads the same policy: AI search allowed there, and on no other host", crawlers.aiSearchCrawlersAllowed() && !crawlers.aiSearchCrawlersAllowed(crawlers.closedRobotsRules()));
    ok("  and the sitemap is named", rootRobots.includes(`Sitemap: http://${ROOT}/sitemap.xml`));
    ok("a workspace's host and the console's: everything disallowed, as before", [wsRobots, consoleRobots].every((r) => /Disallow: \/(\n|$)/.test(group(r, "*")) && !/Allow:/.test(r) && !r.includes("Sitemap")));
    ok("  the AI search crawlers too, by name", [wsRobots, consoleRobots].every((r) => [...AI_SEARCH, ...AI_TRAINING].every((a) => shut(r, a))));
    at(ROOT);
    const rootMap = await sitemap();
    at(`zzsite-a.${ROOT}`);
    const wsMap = await sitemap();
    const mapped = rootMap.map((e) => new URL(e.url).pathname).sort().join(" ");
    ok("the sitemap: the public pages, not signup", mapped === "/ /contact /partners /pricing /privacy /security /signin /terms", mapped);
    ok("  and nothing on a workspace's host", wsMap.length === 0);
    // The blog's archives: a category with a child, a tag and one live post (in the child); a category with only a draft, and a tag with no posts.
    const siteContent = require("../src/lib/platform/site-content") as typeof import("../src/lib/platform/site-content");
    const archiveAuthor = await control.cmsUser.create({ data: { email: "archive-author.zz@example.invalid", name: "Zz Archive Author", role: "EDITOR", createdBy: "script" } });
    const guides = await control.siteCategory.create({ data: { slug: "zz-guides", name: "Zz Guides", updatedBy: "script" } });
    const howTo = await control.siteCategory.create({ data: { slug: "zz-how-to", name: "Zz How-to", parentId: guides.id, updatedBy: "script" } });
    const draftsOnly = await control.siteCategory.create({ data: { slug: "zz-drafts-only", name: "Zz Drafts only", updatedBy: "script" } });
    const newsTag = await control.siteTag.create({ data: { slug: "zz-news", name: "Zz News", updatedBy: "script" } });
    await control.siteTag.create({ data: { slug: "zz-unused", name: "Zz Unused", updatedBy: "script" } });
    const liveAt = new Date(Date.now() - 60_000);
    await control.sitePost.create({
      data: { slug: "zz-archive-post", title: "Zz archive post", body: [], status: "PUBLISHED", publishAt: liveAt, publishedAt: liveAt, authorId: archiveAuthor.id, updatedBy: "script", categories: { create: [{ categoryId: howTo.id }] }, tagLinks: { create: [{ tagId: newsTag.id }] } },
    });
    await control.sitePost.create({ data: { slug: "zz-draft-post", title: "Zz draft post", body: [], authorId: archiveAuthor.id, updatedBy: "script", categories: { create: [{ categoryId: draftsOnly.id }] } } });
    siteContent.invalidateSiteContent();
    at(ROOT);
    const withArchives = (await sitemap()).map((e) => new URL(e.url).pathname).sort().join(" ");
    ok(
      "  a live post adds the blog, the post and the archives it is in (a child's post counts for its parent) — not a category with only a draft, nor an unused tag",
      withArchives === "/ /blog /blog/category/zz-guides /blog/category/zz-how-to /blog/tag/zz-news /blog/zz-archive-post /contact /partners /pricing /privacy /security /signin /terms",
      withArchives,
    );

    try {
      const { NextRequest } = require("next/server") as typeof import("next/server");
      const proxy = (require("../src/proxy") as { default: (req: unknown, ctx: unknown) => Promise<Response> }).default;
      const through = async (host: string, pathAndQuery: string) => {
        const res = await proxy(new NextRequest(`http://${host}${pathAndQuery}`, { headers: { host, "user-agent": "Mozilla/5.0 (check:site)" } }), {});
        return { robots: res.headers.get("x-robots-tag") ?? "", rewrite: res.headers.get("x-middleware-rewrite") ?? "" };
      };
      const [home2, pricing, signup, query, sitemapXml, workspace, consoleHome] = [
        await through(ROOT, "/"),
        await through(ROOT, "/pricing"),
        await through(ROOT, "/signup"),
        await through(ROOT, "/pricing?country=US"),
        await through(ROOT, "/sitemap.xml"),
        await through(`zzsite-a.${ROOT}`, "/login"),
        await through(`admin.${ROOT}`, "/"),
      ];
      ok("the proxy: the public site's pages may be indexed", home2.robots === "index, follow" && pricing.robots === "index, follow" && pricing.rewrite.includes("/platform-site/pricing"), `${home2.robots} | ${pricing.robots}`);
      ok("  but not signup, nor an address with a query", /noindex/.test(signup.robots) && /noindex/.test(query.robots));
      ok("  the sitemap is served from the root, not the folder", !sitemapXml.rewrite);
      ok("  a workspace and the console stay noindex", /noindex/.test(workspace.robots) && /noindex/.test(consoleHome.robots), `${workspace.robots} | ${consoleHome.robots}`);
      // The blog's pages of posts are real pages with canonicals of their own: a lone ?page=N there may be indexed.
      const [blogPage2, categoryPage2, tagPage3] = [await through(ROOT, "/blog?page=2"), await through(ROOT, "/blog/category/x?page=2"), await through(ROOT, "/blog/tag/x?page=3")];
      ok("a lone ?page=N on the blog and its archives may be indexed", [blogPage2, categoryPage2, tagPage3].every((r) => r.robots === "index, follow"), `${blogPage2.robots} | ${categoryPage2.robots} | ${tagPage3.robots}`);
      const [pageAndMore, pricingPage2, badPage, zeroPage] = [await through(ROOT, "/blog?page=2&x=1"), await through(ROOT, "/pricing?page=2"), await through(ROOT, "/blog?page=abc"), await through(ROOT, "/blog?page=0")];
      ok(
        "  but ?page= with anything else, on a page that isn't the blog's, or not a page number, stays noindex",
        [pageAndMore, pricingPage2, badPage, zeroPage].every((r) => /noindex/.test(r.robots)),
        `${pageAndMore.robots} | ${pricingPage2.robots} | ${badPage.robots} | ${zeroPage.robots}`,
      );
      // The proxy's user-agent block is a workspace's (it runs after the public site's branch has answered): an AI search
      // crawler robots.txt lets in must get the page, not "Not available to automated clients".
      const asAgent = async (agent: string) => {
        const res = await proxy(new NextRequest(`http://${ROOT}/pricing`, { headers: { host: ROOT, "user-agent": agent } }), {});
        return `${res.status} ${res.headers.get("x-robots-tag") ?? ""} ${res.headers.get("x-middleware-rewrite")?.includes("/platform-site/pricing") ? "rewritten" : "not rewritten"}`;
      };
      const searchAgents = [
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot",
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0)",
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0)",
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)",
      ];
      const agentAnswers = [];
      for (const agent of searchAgents) agentAnswers.push(await asAgent(agent));
      ok("the proxy lets each AI search crawler read the public site: the page itself, marked indexable", agentAnswers.every((a) => a === "200 index, follow rewritten"), agentAnswers.join(" | "));

      // The CMS's redirects, as the proxy applies them (src/lib/cms/redirects.ts).
      const redirects = require("../src/lib/cms/redirects") as typeof import("../src/lib/cms/redirects");
      const moved = await control.siteRedirect.create({ data: { fromPath: "/zz-old-page", toUrl: "/pricing", status: 301, updatedBy: "script" } });
      await control.siteRedirect.create({ data: { fromPath: "/zz-docs/*", toUrl: "/blog/*", match: "PREFIX", status: 308, updatedBy: "script" } });
      await control.siteRedirect.create({ data: { fromPath: "/zz-off", toUrl: "/pricing", enabled: false, updatedBy: "script" } });
      // Rows the CMS refuses to save, written straight to the database: the proxy must not apply them either.
      await control.siteRedirect.create({ data: { fromPath: "/signup", toUrl: "/pricing", updatedBy: "script" } });
      await control.siteRedirect.create({ data: { fromPath: "/api/zz", toUrl: "/pricing", updatedBy: "script" } });
      redirects.invalidateRedirects();
      await redirects.matchRedirect("/zz-old-page", { waitMs: 10_000 });
      const go = async (host: string, pathAndQuery: string, method = "GET") => {
        const res = await proxy(new NextRequest(`http://${host}${pathAndQuery}`, { method, headers: { host, "user-agent": "Mozilla/5.0 (check:site)" } }), {});
        return { status: res.status, location: res.headers.get("location") ?? "", cache: res.headers.get("cache-control") ?? "", rewrite: res.headers.get("x-middleware-rewrite") ?? "" };
      };
      const old = await go(ROOT, "/ZZ-Old-Page/?utm_source=zz");
      ok("a redirect answers on the public host: its status, its target on that host with the query kept, never cached", old.status === 301 && old.location === `http://${ROOT}/pricing?utm_source=zz` && old.cache === "no-store", `${old.status} ${old.location} ${old.cache}`);
      const splat = await go(ROOT, "/zz-docs/Guides/Start");
      ok("  a “starts with” one carries the rest of the path over", splat.status === 308 && splat.location === `http://${ROOT}/blog/Guides/Start`, `${splat.status} ${splat.location}`);
      const elsewhere = [await go(`zzsite-a.${ROOT}`, "/zz-old-page"), await go(`admin.${ROOT}`, "/zz-old-page"), await go(`cms.${ROOT}`, "/zz-old-page"), await go(`partners.${ROOT}`, "/zz-old-page")];
      ok("  and on no other host: not a workspace's, the console's, the CMS's or the partner portal's", elsewhere.every((r) => !r.location.includes("/pricing")), elsewhere.map((r) => `${r.status} ${r.location}`).join(" | "));
      const [apiPath, signupPath, off, posted] = [await go(ROOT, "/api/zz"), await go(ROOT, "/signup"), await go(ROOT, "/zz-off"), await go(ROOT, "/zz-old-page", "POST")];
      ok("  never /api or the site's own routes, even with such a row in the database", !apiPath.location && !signupPath.location && signupPath.rewrite.includes("/platform-site/signup"), `${apiPath.status} ${signupPath.status} ${signupPath.location}`);
      ok("  a disabled redirect does nothing, and a POST is never redirected", !off.location && off.rewrite.includes("/platform-site/zz-off") && !posted.location.includes("/pricing"));
      ok("  hits are counted in memory and written in one go per redirect", (await redirects.flushRedirectHits()) === 2 && (await control.siteRedirect.findUniqueOrThrow({ where: { id: moved.id } })).hits === 1);
      redirects.setTestRedirectLoader(async () => {
        throw new Error("zz: the database is down");
      });
      const down = await go(ROOT, "/zz-old-page");
      ok("  a database failure means no redirect: the page is served as usual", !down.location && down.rewrite.includes("/platform-site/zz-old-page"), `${down.status} ${down.location}`);
      redirects.setTestRedirectLoader(() => new Promise<never>(() => {}));
      const t0 = Date.now();
      const hung = await go(ROOT, "/zz-old-page");
      ok("  and one that never answers is waited for a moment only", !hung.location && hung.rewrite.includes("/platform-site/zz-old-page") && Date.now() - t0 < 2_000, `${Date.now() - t0} ms`);
      let loads = 0;
      redirects.setTestRedirectLoader(async () => {
        loads += 1;
        throw new Error("zz: the database is still down");
      });
      const whileDown = [await go(ROOT, "/zz-old-page"), await go(ROOT, "/zz-old-page"), await go(`www.${ROOT}`, "/zz-old-page")];
      ok("  after a failure the database is left alone for a while, not asked again by every request — and every one is served", loads === 1 && whileDown.every((r) => !r.location && r.rewrite.includes("/platform-site/zz-old-page")), `${loads} loads`);
      redirects.setTestRedirectLoader(null);

      // More of the proxy's rules for redirects: www., HEAD, another site's address, the machinery, and back after a failure.
      await control.siteRedirect.createMany({
        data: [
          { fromPath: "/zz-away", toUrl: "https://example.com/zz", status: 302, updatedBy: "script" },
          // Rows the CMS refuses to save, written straight to the database.
          { fromPath: "/_next/zz", toUrl: "/pricing", updatedBy: "script" },
          { fromPath: "/signup/zz", toUrl: "/pricing", updatedBy: "script" },
          { fromPath: "/zz-static.png", toUrl: "/pricing", updatedBy: "script" },
          { fromPath: "/api/zz/*", toUrl: "/pricing/*", match: "PREFIX", updatedBy: "script" },
        ],
      });
      redirects.invalidateRedirects();
      await redirects.matchRedirect("/zz-old-page", { waitMs: 10_000 });
      const back = await go(ROOT, "/zz-old-page");
      ok("  once the redirects load again, they apply", back.status === 301 && back.location === `http://${ROOT}/pricing`, `${back.status} ${back.location}`);
      const www = await go(`www.${ROOT}`, "/Zz-Old-Page?utm_source=zz");
      ok("the www. host is the public site too: redirected there, on that host, never cached", www.status === 301 && www.location === `http://www.${ROOT}/pricing?utm_source=zz` && www.cache === "no-store", `${www.status} ${www.location} ${www.cache}`);
      const head = await go(ROOT, "/zz-docs/a/b", "HEAD");
      ok("  a HEAD is answered as a GET is", head.status === 308 && head.location === `http://${ROOT}/blog/a/b` && head.cache === "no-store", `${head.status} ${head.location}`);
      const away = await go(ROOT, "/zz-away?ref=zz");
      ok("  another site's address is used as it is — the visitor's query never goes with it", away.status === 302 && away.location === "https://example.com/zz" && away.cache === "no-store", `${away.status} ${away.location}`);
      const machinery = [await go(ROOT, "/_next/zz"), await go(ROOT, "/signup/zz"), await go(ROOT, "/zz-static.png"), await go(ROOT, "/api/zz/x"), await go(`www.${ROOT}`, "/api/zz/x")];
      ok("  never /_next, a page under the site's own routes, a static file or anything under /api, whatever the database holds", machinery.every((r) => !r.location), machinery.map((r) => `${r.status} ${r.location}`).join(" | "));
      const prefixElsewhere = [await go(`zzsite-a.${ROOT}`, "/zz-docs/a"), await go(`admin.${ROOT}`, "/zz-docs/a"), await go(`cms.${ROOT}`, "/zz-docs/a"), await go(`partners.${ROOT}`, "/zz-docs/a"), await go(`zzsite-a.${ROOT}`, "/zz-away")];
      ok("  a “starts with” one, or one to another site, applies on no other host either", prefixElsewhere.every((r) => !r.location.includes("/blog/") && !r.location.includes("example.com")), prefixElsewhere.map((r) => `${r.status} ${r.location}`).join(" | "));
      await redirects.flushRedirectHits();
    } catch (err) {
      ok("the proxy can be called", false, err instanceof Error ? err.stack?.split("\n").slice(0, 4).join(" | ") : String(err));
    }

    // ─── Metadata and structured data ───────────────────────────────────────────────────────────
    section("Metadata and structured data: the SEO engine's builders on the public site");
    at(ROOT);
    type SiteSettings = typeof DEFAULT_SITE_SETTINGS;
    type SitePage = (typeof DEFAULT_SITE_PAGES)[number];
    type SitePost = import("../src/lib/platform/site-content").SitePost;
    type Archive = import("../src/app/platform-site/blog/archive-view").Archive;
    type Meta = Record<string, unknown>;
    type Route = { default: (props: never) => Promise<ReactNode>; generateMetadata: (props: never) => Promise<Meta> };
    /** URLs as their address, undefined kept apart from missing: two Metadata objects compared field for field, in order. */
    const canon = (v: unknown): unknown =>
      v instanceof URL ? { URL: v.href } : Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.entries(v).map(([k, x]) => [k, x === undefined ? "<undefined>" : canon(x)]) : v;
    const sameMeta = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
    const notIndexed = { index: false, follow: false };
    // Today's metadata, frozen: the bodies of page-view.tsx `sitePageMetadata`, blog/page.tsx, blog/[slug]/page.tsx and
    // archive-view.tsx `archiveMetadata` as they were written before the site moved onto src/lib/seo's builders. Every
    // entity without keywords must still get exactly this, key for key.
    const before = {
      page(page: SitePage | null, ctx: { settings: SiteSettings; trialDays: number }): Meta {
        if (!page) return { title: links.fill(ctx.settings.notFound.heading, ctx), robots: { index: false, follow: false } };
        const title = links.fill(page.seo.title, ctx);
        const description = links.fill(page.seo.description, ctx);
        const image = links.safeSrc(page.seo.ogImage ?? ctx.settings.seo.ogImage);
        const pagePath = siteContent.sitePath(page.slug);
        return {
          title: page.seo.absoluteTitle ? { absolute: title } : title,
          description,
          alternates: { canonical: pagePath },
          openGraph: {
            type: "website",
            siteName: ctx.settings.siteName,
            title: links.fill(page.seo.ogTitle, ctx) || title,
            description: links.fill(page.seo.ogDescription, ctx) || description,
            url: pagePath,
            images: image ? [image] : undefined,
          },
          twitter: { card: image ? "summary_large_image" : "summary", title, description },
          robots: page.seo.noindex ? { index: false, follow: false } : undefined,
        };
      },
      blogIndex(settings: SiteSettings): Meta {
        return { title: "Blog", description: `News, product updates and notes from ${settings.siteName}.`, alternates: { canonical: "/blog" }, openGraph: { type: "website", title: "Blog", url: "/blog" } };
      },
      post(post: SitePost | null): Meta {
        if (!post) return { title: "Not found", robots: notIndexed };
        const title = post.seo?.title || post.title;
        const description = post.seo?.description || post.excerpt || undefined;
        const image = links.safeSrc(post.seo?.ogImage ?? post.cover?.src);
        return {
          title,
          description,
          alternates: { canonical: post.path },
          openGraph: {
            type: "article",
            title,
            description,
            url: post.path,
            publishedTime: post.publishedAt.toISOString(),
            section: post.categories[0]?.name,
            tags: post.tagLinks.map((t) => t.name),
            images: image ? [image] : undefined,
          },
          twitter: { card: image ? "summary_large_image" : "summary", title, description },
          robots: post.seo?.noindex ? { index: false, follow: false } : undefined,
        };
      },
      archive(archive: Archive | null, settings: SiteSettings): Meta {
        if (!archive) return { title: "Not found", robots: notIndexed };
        const title = archive.page > 1 ? `${archive.seo.title} (page ${archive.page})` : archive.seo.title;
        const description = archive.seo.description ?? `${archive.kind === "category" ? "Posts in" : "Posts tagged"} ${archive.name}, from ${settings.siteName}.`;
        const own = archive.seo.image;
        const ownSrc = own ? links.safeSrc(own.src) : null;
        const siteImage = links.safeSrc(settings.seo.ogImage);
        const images = own && ownSrc ? [{ url: ownSrc, alt: own.alt || undefined, width: own.width ?? undefined, height: own.height ?? undefined }] : siteImage ? [siteImage] : undefined;
        return {
          title,
          description,
          alternates: { canonical: archive.canonical },
          openGraph: { type: "website", siteName: settings.siteName, title, description, url: archive.canonical, images },
          twitter: { card: images ? "summary_large_image" : "summary", title, description },
        };
      },
    };

    // Written straight to the database: a CMS page with keywords (one a repeat), an FAQ block and a heading that tries to
    // end the structured data's script; one whose FAQ has no complete question and whose keywords are blank; a post with
    // its own search title for the parity, a post with keywords, and keywords on the parent category.
    const HOSTILE = `Zz </script><script>alert("zz")</script> & <!-- the rest`;
    const cmsPage = (slug: string, title: string, seo: Record<string, unknown>, blocks: unknown[]) => {
      const doc = { title, seo, blocks };
      return control.sitePage.create({ data: { slug, title, status: "PUBLISHED", draft: doc as never, published: doc as never, publishedAt: new Date(), createdBy: "script", updatedBy: "script" } });
    };
    await cmsPage("zz-seo-page", "Zz SEO page", { title: "Zz SEO page", description: "A page with primary keywords and its questions answered, for check:site.", keywords: ["GST software", "  gst   SOFTWARE ", "Payroll India"] }, [
      { id: "zz-head", type: "pageHeader", props: { heading: HOSTILE, intro: "Zz: what the page is about." } },
      { id: "zz-faq", type: "faq", props: { heading: "Zz questions", items: [{ question: "Zz, is this a question?", answer: ["Yes, and this is its answer."] }, { question: "Zz, one more?", answer: ["Another answer."] }] } },
    ]);
    await cmsPage("zz-half-faq", "Zz half FAQ", { title: "Zz half FAQ", description: "A page whose questions have no answers yet, for check:site.", keywords: ["  ", ""] }, [
      { id: "zz-head", type: "pageHeader", props: { heading: "Zz questions without answers" } },
      { id: "zz-faq", type: "faq", props: { heading: "Zz questions", items: [{ question: "Zz, unanswered?", answer: [] }, { question: "", answer: ["An answer to no question."] }] } },
    ]);
    const livePost = (data: { slug: string; title: string; excerpt?: string; seo: { title?: string; description?: string; keywords?: string[] }; categoryId: string; tagId?: string }) =>
      control.sitePost.create({
        data: {
          slug: data.slug,
          title: data.title,
          excerpt: data.excerpt ?? null,
          body: [],
          seo: data.seo,
          status: "PUBLISHED",
          publishAt: liveAt,
          publishedAt: liveAt,
          authorId: archiveAuthor.id,
          updatedBy: "script",
          categories: { create: [{ categoryId: data.categoryId }] },
          ...(data.tagId ? { tagLinks: { create: [{ tagId: data.tagId }] } } : {}),
        },
      });
    await livePost({ slug: "zz-seo-post", title: "Zz SEO post", excerpt: "What the post is about, in a line.", seo: { title: "Zz SEO post, its search title", description: "Zz SEO post, its search description, for check:site." }, categoryId: howTo.id, tagId: newsTag.id });
    await livePost({ slug: "zz-keyword-post", title: "Zz keyword post", seo: { keywords: ["GST invoice numbering", "e-invoice"] }, categoryId: guides.id });
    await control.siteCategory.update({ where: { id: guides.id }, data: { seo: { keywords: ["Zz guides", "how-to"] } } });
    siteContent.invalidateSiteContent();

    const ctxNow = { settings: await siteContent.getSiteSettings(), trialDays: (await siteContent.siteStatus()).trialDays };
    const drift: string[] = [];
    for (const route of Object.keys(routes)) {
      const theirs = await (await routes[route]!()).generateMetadata({} as never);
      const expected = before.page(await siteContent.getSitePage(route === "/" ? "home" : route.slice(1)), ctxNow);
      if (!sameMeta(theirs, expected) || "keywords" in theirs) drift.push(`${route}: ${JSON.stringify(canon(theirs))} vs ${JSON.stringify(canon(expected))}`);
    }
    ok("parity: the eight built-in pages' metadata is exactly what it was, key for key, with no keywords", drift.length === 0, drift.join(" /// "));
    const blogRoute = require("../src/app/platform-site/blog/page") as Route;
    const postRoute = require("../src/app/platform-site/blog/[slug]/page") as Route;
    const categoryRoute = require("../src/app/platform-site/blog/category/[slug]/page") as Route;
    const tagRoute = require("../src/app/platform-site/blog/tag/[slug]/page") as Route;
    const archiveView = require("../src/app/platform-site/blog/archive-view") as typeof import("../src/app/platform-site/blog/archive-view");
    const blogMeta = await blogRoute.generateMetadata({} as never);
    ok("  the blog index's", sameMeta(blogMeta, before.blogIndex(ctxNow.settings)), JSON.stringify(canon(blogMeta)));
    const postMetaFor = (slug: string) => postRoute.generateMetadata({ params: Promise.resolve({ slug }) } as never);
    const seoPostMeta = await postMetaFor("zz-seo-post");
    ok("  a post's (its own search title and description)", sameMeta(seoPostMeta, before.post(await siteContent.getPublishedPost("zz-seo-post"))) && seoPostMeta.title === "Zz SEO post, its search title", JSON.stringify(canon(seoPostMeta)));
    ok("  a missing post's", sameMeta(await postMetaFor("zz-no-such-post"), before.post(null)));
    const archiveMetaFor = (route: Route, slug: string) => route.generateMetadata({ params: Promise.resolve({ slug }), searchParams: Promise.resolve({}) } as never);
    const howToArchive = await archiveView.loadArchive("category", "zz-how-to", {});
    const howToMeta = await archiveMetaFor(categoryRoute, "zz-how-to");
    ok(
      "  an archive's (a subcategory with no search details of its own)",
      !!howToArchive && JSON.stringify(howToArchive.seo) === JSON.stringify({ title: "Zz How-to", description: null, image: null }) && sameMeta(howToMeta, before.archive(howToArchive, ctxNow.settings)),
      JSON.stringify(canon(howToMeta)),
    );

    const seoPageMeta = (await catchAll.generateMetadata({ params: Promise.resolve({ slug: ["zz-seo-page"] }) } as never)) as Meta;
    ok("keywords: a page's are one meta line, comma and space between, a repeat dropped whatever its case and spacing", seoPageMeta.keywords === "GST software, Payroll India", String(seoPageMeta.keywords));
    // Next resolves `keywords` to an array and writes the tag's content joined by "," (next/dist/lib/metadata/resolve-metadata.js, metadata.js).
    const { resolveAsArrayOrUndefined } = require("next/dist/lib/metadata/generate/utils") as { resolveAsArrayOrUndefined: (v: unknown) => string[] | undefined };
    ok('  which Next writes as <meta name="keywords" content="GST software, Payroll India">', resolveAsArrayOrUndefined(seoPageMeta.keywords)?.join(",") === "GST software, Payroll India");
    ok("  the rest of that page's metadata as it would be without them", sameMeta(Object.fromEntries(Object.entries(seoPageMeta).filter(([k]) => k !== "keywords")), before.page(await siteContent.getSitePage("zz-seo-page"), ctxNow)));
    const [kwPostMeta, guidesMeta, newsMeta] = [await postMetaFor("zz-keyword-post"), await archiveMetaFor(categoryRoute, "zz-guides"), await archiveMetaFor(tagRoute, "zz-news")];
    ok("  a post's and a category's too", kwPostMeta.keywords === "GST invoice numbering, e-invoice" && guidesMeta.keywords === "Zz guides, how-to", `${String(kwPostMeta.keywords)} | ${String(guidesMeta.keywords)}`);
    const halfMeta = (await catchAll.generateMetadata({ params: Promise.resolve({ slug: ["zz-half-faq"] }) } as never)) as Meta;
    ok("  and no keywords where there are none, nor where the only ones are blank", [halfMeta, seoPostMeta, newsMeta, howToMeta, blogMeta].every((m) => !("keywords" in m)));

    const ldScripts = (markup: string) => [...markup.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    type Ld = { "@type": string; [key: string]: unknown };
    const ldOf = (markup: string): Ld[] | null => {
      const scripts = ldScripts(markup);
      if (scripts.length !== 1) return null;
      try {
        const parsed = JSON.parse(scripts[0]) as unknown;
        return Array.isArray(parsed) ? (parsed as Ld[]) : null;
      } catch {
        return null;
      }
    };
    const typesOf = (markup: string) => ldOf(markup)?.map((o) => o["@type"]).join("+") ?? `${ldScripts(markup).length} script(s), not one JSON array`;
    const crumbsOf = (markup: string) => ((ldOf(markup)?.find((o) => o["@type"] === "BreadcrumbList")?.itemListElement ?? []) as { name: string }[]).map((i) => i.name).join(" › ");
    const expectedTypes: Record<string, string> = { "/": "Organization+WebSite", "/pricing": "WebPage+BreadcrumbList+FAQPage" };
    const builtinTypes = Object.entries(pages).map(([route, markup]) => ({ route, got: typesOf(markup), want: expectedTypes[route] ?? "WebPage+BreadcrumbList" }));
    ok(
      "JSON-LD: one script on each built-in page, parsed back as JSON — home: Organization, WebSite; pricing: WebPage, BreadcrumbList and its FAQ's FAQPage; the rest (no FAQ block): WebPage, BreadcrumbList",
      builtinTypes.every((t) => t.got === t.want),
      builtinTypes.map((t) => `${t.route}:${t.got}`).join(" "),
    );
    const pricingLd = ldOf(pages["/pricing"] ?? "") ?? [];
    const pricingFaqBlock = DEFAULT_SITE_PAGES.find((p) => p.slug === "pricing")?.blocks.find((b) => b.type === "faq");
    const pricingFaq = pricingLd.find((o) => o["@type"] === "FAQPage")?.mainEntity as { name: string; acceptedAnswer: { text: string } }[] | undefined;
    ok(
      "  addresses absolute, on the host asked; the FAQPage the page's own questions and answers, tokens filled",
      pricingLd[0]?.url === `http://${ROOT}/pricing` && pricingFaqBlock?.type === "faq" && pricingFaq?.length === pricingFaqBlock.props.items.length && pricingFaq[0]?.name === pricingFaqBlock.props.items[0]?.question && !JSON.stringify(pricingLd).includes("{trialDays}"),
      `${String(pricingLd[0]?.url)} ${pricingFaq?.length ?? 0} questions`,
    );
    const homeLd = ldOf(pages["/"] ?? "") ?? [];
    ok("  home: the organisation and the site, by the site's name, at the site's address", homeLd.length === 2 && homeLd.every((o) => o.name === DEFAULT_SITE_SETTINGS.siteName && o.url === `http://${ROOT}/`));

    const renderRoute = async (mod: { default: (props: never) => Promise<ReactNode> }, params: Record<string, unknown>) =>
      html(Layout({ children: await mod.default({ params: Promise.resolve(params), searchParams: Promise.resolve({}) } as never) }));
    const seoPageHtml = await renderRoute(catchAll as unknown as Route, { slug: ["zz-seo-page"] });
    const seoPageLd = ldOf(seoPageHtml) ?? [];
    ok(
      "a CMS page with an FAQ block: WebPage, BreadcrumbList (Home › the page) and FAQPage with its two questions",
      typesOf(seoPageHtml) === "WebPage+BreadcrumbList+FAQPage" && crumbsOf(seoPageHtml) === `Home › ${HOSTILE}` && (seoPageLd[2]?.mainEntity as unknown[] | undefined)?.length === 2,
      `${typesOf(seoPageHtml)} ${crumbsOf(seoPageHtml)}`,
    );
    const [rawLd] = ldScripts(seoPageHtml);
    ok(
      "  a heading with “</script>” in it cannot end the script: one script on the page, no “<”, “>” or “&” inside it, the heading back whole from the JSON",
      (seoPageHtml.match(/<script/gi) ?? []).length === 1 && !/[<>&]/.test(rawLd ?? "<") && seoPageLd[0]?.name === HOSTILE,
      (rawLd ?? "").slice(0, 160),
    );
    const halfHtml = await renderRoute(catchAll as unknown as Route, { slug: ["zz-half-faq"] });
    ok("  an FAQ block with no complete question and answer: no FAQPage", typesOf(halfHtml) === "WebPage+BreadcrumbList", typesOf(halfHtml));
    const postHtml = await renderRoute(postRoute, { slug: "zz-seo-post" });
    const posting = ldOf(postHtml)?.[0] as { headline?: string; author?: { name?: string }; datePublished?: string; articleSection?: string; keywords?: string[]; image?: string; url?: string } | undefined;
    ok(
      "a post: BlogPosting and BreadcrumbList (Blog › its main category › it); headline, author, date, section and tags as it shows them, and no image it hasn't got",
      typesOf(postHtml) === "BlogPosting+BreadcrumbList" &&
        crumbsOf(postHtml) === "Blog › Zz How-to › Zz SEO post" &&
        posting?.headline === "Zz SEO post" &&
        posting.author?.name === "Zz Archive Author" &&
        posting.datePublished === liveAt.toISOString() &&
        posting.articleSection === "Zz How-to" &&
        JSON.stringify(posting.keywords) === JSON.stringify(["Zz News"]) &&
        posting.image === undefined &&
        posting.url === `http://${ROOT}/blog/zz-seo-post`,
      `${typesOf(postHtml)} ${crumbsOf(postHtml)} ${JSON.stringify(posting)}`,
    );
    const howToHtml = await renderRoute(categoryRoute, { slug: "zz-how-to" });
    const newsHtml = await renderRoute(tagRoute, { slug: "zz-news" });
    ok("a category's archive: CollectionPage and BreadcrumbList (Blog › its parent › it)", typesOf(howToHtml) === "CollectionPage+BreadcrumbList" && crumbsOf(howToHtml) === "Blog › Zz Guides › Zz How-to", `${typesOf(howToHtml)} ${crumbsOf(howToHtml)}`);
    ok("  a tag's: CollectionPage and BreadcrumbList (Blog › it)", typesOf(newsHtml) === "CollectionPage+BreadcrumbList" && crumbsOf(newsHtml) === "Blog › Zz News", `${typesOf(newsHtml)} ${crumbsOf(newsHtml)}`);
    const blogHtml = await renderRoute(blogRoute, {});
    const notFoundHtml = await html(Layout({ children: await notFoundPage() }));
    ok("the blog index and the not-found page: no structured data", ldScripts(blogHtml).length === 0 && !blogHtml.includes("application/ld+json") && ldScripts(notFoundHtml).length === 0);
    ok("  and every one of these pages still has exactly one h1", [seoPageHtml, halfHtml, postHtml, howToHtml, newsHtml, blogHtml].every((h) => (h.match(/<h1[\s>]/g) ?? []).length === 1));

    // ─── The header's menus, the new blocks, nested pages ───────────────────────────────────────
    section("The header's menus, the comparison table, related links, the page map, and nested pages");
    at(ROOT);
    const siteNav = require("../src/components/site/nav") as typeof import("../src/components/site/nav");
    const siteValidate = require("../src/lib/cms/validate") as typeof import("../src/lib/cms/validate");
    const publishSettings = async (settings: unknown) => {
      const doc = settings as never;
      await control.siteSettings.upsert({ where: { key: "site" }, create: { key: "site", draft: doc, published: doc, publishedAt: new Date(), updatedBy: "script" }, update: { draft: doc, published: doc, publishedAt: new Date() } });
      siteContent.invalidateSiteContent();
    };
    const headerOf = (markup: string) => markup.slice(markup.indexOf("<header"), markup.indexOf("</header>") + "</header>".length);
    const footerOf = (markup: string) => markup.slice(markup.indexOf("<footer"), markup.indexOf("</footer>") + "</footer>".length);
    const hrefCount = (markup: string, href: string) => markup.split(`href="${href}"`).length - 1;

    // Settings saved before menus existed: links only.
    const flatNav = [
      { label: "Zz Flat Pricing", href: "/pricing" },
      { label: "Zz {siteName} blog", href: "/blog" },
    ];
    await publishSettings({ ...DEFAULT_SITE_SETTINGS, nav: flatNav });
    const flatHeader = headerOf(await render("/pricing"));
    ok(
      "settings saved with links only still load and render: each link, tokens filled, and no menu buttons",
      (await siteContent.getSiteSettings()).nav.length === 2 &&
        hrefCount(flatHeader, "/blog") === 2 &&
        textOf(flatHeader).includes(`Zz ${DEFAULT_SITE_SETTINGS.siteName} blog`) &&
        !/aria-controls="[^"]*-panel-\d+"/.test(flatHeader),
      textOf(flatHeader).slice(0, 200),
    );
    ok("  and the validator still takes them, whole, to publish", siteValidate.checkSiteSettings({ ...DEFAULT_SITE_SETTINGS, nav: flatNav }, "publish").ok);

    // A mega-menu: two menus and a link; one of the menus' links is hostile, written straight to the database.
    const megaNav = [
      {
        label: "Zz Product",
        columns: [
          {
            title: "Zz Sell & serve",
            items: [
              { label: "Zz CRM", href: "/zz-product/zz-crm", description: "Zz companies, contacts and leads" },
              { label: "Zz Helpdesk", href: "/zz-product/zz-helpdesk" },
            ],
          },
          { title: "Zz Run the business", items: [{ label: "Zz Accounting", href: "/zz-product/zz-accounting", description: "Zz the ledger and {siteName} GST returns" }] },
        ],
        footer: { label: "Zz Every feature", href: "/zz-product" },
      },
      { label: "Zz Pricing", href: "/pricing" },
      {
        label: "Zz Resources",
        columns: [
          {
            title: "Zz Learn",
            items: [
              { label: "Zz Blog", href: "/blog" },
              { label: "Zz Evil", href: "javascript:alert(1)" },
            ],
          },
        ],
      },
    ];
    const sixColumns = Array.from({ length: 6 }, (_, i) => ({ title: `Zz Footer ${i + 1}`, links: [{ label: `Zz Footer link ${i + 1}`, href: `/zz-footer-${i + 1}` }] }));
    await publishSettings({ ...DEFAULT_SITE_SETTINGS, nav: megaNav, footer: { ...DEFAULT_SITE_SETTINGS.footer, columns: sixColumns } });
    const megaPage = await render("/pricing");
    const megaHeader = headerOf(megaPage);
    const safeLinks = siteNav.navLinks(siteNav.readNav(megaNav)).filter((l) => l.href.startsWith("/"));
    ok(
      "the mega-menu: every link of every menu is in the server's HTML — the desktop panel and the phone's accordion — with no script run",
      safeLinks.length === 6 && safeLinks.every((l) => hrefCount(megaHeader, l.href) >= 2),
      safeLinks.map((l) => `${l.href}:${hrefCount(megaHeader, l.href)}`).join(" "),
    );
    ok("  each link's line under it, tokens filled", textOf(megaHeader).includes("Zz companies, contacts and leads") && textOf(megaHeader).includes(`Zz the ledger and ${DEFAULT_SITE_SETTINGS.siteName} GST returns`));
    ok("  a javascript: link is plain text, never a link", !/javascript:/i.test(megaPage) && textOf(megaHeader).includes("Zz Evil"));
    {
      // A page switched off for now (the partner directory, until an owner turns it on) answers "not
      // found", so nothing links to it: the item goes, and a column or menu left empty goes with it.
      const { linkShown } = require("../src/components/site/links") as typeof import("../src/components/site/links");
      const hidden = { hiddenPaths: ["/partners/find"] };
      ok(
        "a link to a switched-off page is left out — with a query, an anchor or a trailing slash too; its neighbours stay",
        !linkShown("/partners/find", hidden) && !linkShown("/partners/find?country=IN", hidden) && !linkShown("/partners/find/", hidden) && !linkShown("/partners/find#list", hidden) &&
          linkShown("/partners", hidden) && linkShown("/partners/finder", hidden) && linkShown("https://example.com/partners/find", hidden) && linkShown("/partners/find", {}),
      );
      const partnerNav = [
        { label: "Zz Partners", columns: [{ title: "Zz Programme", items: [{ label: "Zz Become", href: "/partners" }, { label: "Zz Find", href: "/partners/find" }] }, { title: "Zz Only find", items: [{ label: "Zz Find again", href: "/partners/find?country=IN" }] }] },
        { label: "Zz Gone", columns: [{ title: "Zz Empty", items: [{ label: "Zz Find", href: "/partners/find" }] }] },
        { label: "Zz Plain", href: "/partners/find" },
      ];
      const filled = siteNav.fillNav(partnerNav, { settings: DEFAULT_SITE_SETTINGS, trialDays: 14, ...hidden });
      const kept = siteNav.navLinks(filled).map((l) => l.href);
      ok(
        "  the header drops it, then any column and menu it leaves empty",
        kept.join(" ") === "/partners" && filled.length === 1 && siteNav.isNavMenu(filled[0]!) && filled[0].columns.length === 1,
        kept.join(" "),
      );
      ok("  with nothing switched off, the header is as written", siteNav.navLinks(siteNav.fillNav(partnerNav, { settings: DEFAULT_SITE_SETTINGS, trialDays: 14 })).length === 5);
    }
    const menuButtons = [...megaHeader.matchAll(/<button[^>]*aria-controls="([^"]+-panel-\d+)"[^>]*>/g)];
    const panelsHidden = menuButtons.every((m) => /aria-expanded="false"/.test(m[0]) && new RegExp(`<div[^>]*id="${m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*hidden=""`).test(megaHeader));
    ok("  each menu a disclosure: a button with aria-expanded=false and aria-controls naming its panel, which is there and hidden", menuButtons.length === 2 && panelsHidden, `${menuButtons.length} buttons`);
    const accordions = [...megaHeader.matchAll(/<button[^>]*aria-controls="([^"]+-section-\d+)"[^>]*>/g)];
    ok("  on a phone, each menu an accordion of its own, closed", accordions.length === 2 && accordions.every((m) => /aria-expanded="false"/.test(m[0]) && megaHeader.includes(`id="${m[1]}" hidden=""`)));
    ok("  a column's title names its list (not a heading: the page's h1 stays its first heading)", !/<h[1-6][\s>]/.test(megaHeader) && /<ul aria-labelledby="[^"]+"/.test(megaHeader) && (megaPage.match(/<h1[\s>]/g) ?? []).length === 1);
    ok("  the link along the menu's foot, and Sign in and the call to action as before", hrefCount(megaHeader, "/zz-product") >= 2 && megaHeader.includes('href="/signin"') && textOf(megaHeader).includes("Request an invitation"));
    const megaFooter = footerOf(megaPage);
    ok("the footer takes six columns, laid out six across on a wide screen", sixColumns.every((c) => megaFooter.includes(`href="${c.links[0].href}"`)) && (megaFooter.match(/<nav aria-label="Zz Footer \d"/g) ?? []).length === 6 && megaFooter.includes("xl:grid-cols-6"));
    const metaDrift: string[] = [];
    const ctxMega = { settings: await siteContent.getSiteSettings(), trialDays: (await siteContent.siteStatus()).trialDays };
    for (const route of Object.keys(routes)) {
      const theirs = await (await routes[route]!()).generateMetadata({} as never);
      if (!sameMeta(theirs, before.page(await siteContent.getSitePage(route === "/" ? "home" : route.slice(1)), ctxMega)) || (route !== "/signup" && theirs.robots !== undefined)) metaDrift.push(route);
    }
    ok("  and the built-in pages' metadata and robots are as they were", metaDrift.length === 0, metaDrift.join(" "));

    // The new blocks on nested pages, through the catch-all route: a hub, a comparison under it, and a page whose parent level has no page.
    await cmsPage("zz-compare", "Zz Compare", { title: "Zz comparisons", description: "Every comparison on the site, for check:site's nested pages." }, [
      { id: "zz-hub-head", type: "pageHeader", props: { heading: "Zz comparisons" } },
      {
        id: "zz-map",
        type: "moduleHighlights",
        props: {
          heading: "Zz every comparison",
          groups: [
            {
              title: "Zz Suites",
              items: [
                { label: "Zz Rival", href: "/zz-compare/zz-rival", description: "Zz how the two compare." },
                { label: "Zz Out", href: "https://example.com/zz-out", description: "Zz not a page here." },
              ],
            },
          ],
        },
      },
    ]);
    await cmsPage("zz-compare/zz-rival", "Zz Rival compared", { title: "Zz Rival vs the site", description: "A comparison page nested under the hub, for check:site." }, [
      { id: "zz-rival-head", type: "pageHeader", props: { heading: "Zz {siteName} and Zz Rival" } },
      {
        id: "zz-table",
        type: "comparisonTable",
        props: {
          heading: "Zz feature by feature",
          competitor: "Zz Rival",
          asOf: "2026-09-29",
          rows: [
            { feature: "Zz GST e-invoicing", us: "yes", them: "yes", source: "https://www.zz-rival.example/e-invoicing" },
            { feature: "Zz Payroll", us: "yes", them: "partial", note: "Zz a separate app.", source: "https://zz-rival.example/payroll" },
            { feature: "Zz Price", us: "From ₹999 a month", them: "no" },
          ],
          disclaimer: "Zz product names and trademarks belong to their owners.",
        },
      },
      {
        id: "zz-related",
        type: "relatedLinks",
        props: {
          heading: "Zz related",
          links: [
            { label: "Zz the hub", href: "/zz-compare", description: "Zz every comparison." },
            { label: "Zz elsewhere", href: "https://example.com/zz-elsewhere" },
          ],
        },
      },
    ]);
    await cmsPage("zz-orphan/zz-child", "Zz Child", { title: "Zz child page", description: "A nested page with no page above it, for check:site." }, [{ id: "zz-child-head", type: "pageHeader", props: { heading: "Zz child" } }]);
    siteContent.invalidateSiteContent();
    const rivalHtml = await renderRoute(catchAll as unknown as Route, { slug: ["zz-compare", "zz-rival"] });
    const rivalMain = rivalHtml.slice(rivalHtml.indexOf("<main"), rivalHtml.indexOf("</main>"));
    ok(
      "a nested page renders through the catch-all: one h1, and its breadcrumb Home › the page above › it, visible and in BreadcrumbList",
      (rivalHtml.match(/<h1[\s>]/g) ?? []).length === 1 &&
        /<nav aria-label="Breadcrumb"/.test(rivalMain) &&
        rivalMain.includes('href="/zz-compare"') &&
        rivalMain.includes('aria-current="page"') &&
        textOf(rivalMain).includes("Home Zz Compare Zz Rival compared") &&
        typesOf(rivalHtml) === "WebPage+BreadcrumbList" &&
        crumbsOf(rivalHtml) === "Home › Zz Compare › Zz Rival compared",
      `${typesOf(rivalHtml)} ${crumbsOf(rivalHtml)}`,
    );
    const rivalLd = ldOf(rivalHtml)?.find((o) => o["@type"] === "BreadcrumbList")?.itemListElement as { item: string }[] | undefined;
    ok("  its trail's addresses absolute, the page above's included", rivalLd?.map((i) => i.item).join(" ") === `http://${ROOT}/ http://${ROOT}/zz-compare http://${ROOT}/zz-compare/zz-rival`, rivalLd?.map((i) => i.item).join(" "));
    ok(
      "the comparison table: a caption, a header per product, a header per feature, and each answer as a word",
      /<table role="table"/.test(rivalMain) &&
        /<caption[^>]*>/.test(rivalMain) &&
        (rivalMain.match(/scope="col"/g) ?? []).length === 3 &&
        (rivalMain.match(/scope="row"/g) ?? []).length === 3 &&
        [">Yes<", ">Partly<", ">No<", "From ₹999 a month"].every((s) => rivalMain.includes(s)),
    );
    const sourceAnchors = [...rivalMain.matchAll(/<a [^>]*href="https:\/\/(?:www\.)?zz-rival\.example[^"]*"[^>]*>/g)].map((m) => m[0]);
    ok("  each row's source a link to the other product's page, rel nofollow noopener noreferrer, named by its site", sourceAnchors.length === 2 && sourceAnchors.every((a) => a.includes('rel="nofollow noopener noreferrer"')) && textOf(rivalMain).includes("Source: zz-rival.example"), sourceAnchors.join(" | "));
    ok("  under it, the day that site was read and the disclaimer", textOf(rivalMain).includes("Information about Zz Rival from its public website as of 29 September 2026.") && textOf(rivalMain).includes("Zz product names and trademarks belong to their owners."));
    ok("related links: the page on this site, and not the one elsewhere", rivalMain.includes('href="/zz-compare"') && !rivalMain.includes("zz-elsewhere") && textOf(rivalMain).includes("Zz every comparison."));
    const hubHtml = await renderRoute(catchAll as unknown as Route, { slug: ["zz-compare"] });
    const hubMain = hubHtml.slice(hubHtml.indexOf("<main"), hubHtml.indexOf("</main>"));
    ok("the page map: its group a heading, its links to pages on this site — and a page one level down shows no breadcrumb", /<h3[^>]*>Zz Suites<\/h3>/.test(hubMain) && hubMain.includes('href="/zz-compare/zz-rival"') && !hubMain.includes("zz-out") && !hubMain.includes('aria-label="Breadcrumb"') && crumbsOf(hubHtml) === "Home › Zz comparisons");
    const childHtml = await renderRoute(catchAll as unknown as Route, { slug: ["zz-orphan", "zz-child"] });
    ok("a nested page with no page above it: Home › it (never a link to a page that isn't there)", crumbsOf(childHtml) === "Home › Zz Child" && !childHtml.includes('href="/zz-orphan"') && /<nav aria-label="Breadcrumb"/.test(childHtml), crumbsOf(childHtml));
    const rivalMeta = (await catchAll.generateMetadata({ params: Promise.resolve({ slug: ["zz-compare", "zz-rival"] }) } as never)) as Meta;
    ok("  its metadata: its own canonical, indexable, as any page's", sameMeta(rivalMeta, before.page(await siteContent.getSitePage("zz-compare/zz-rival"), ctxMega)) && rivalMeta.robots === undefined && JSON.stringify(rivalMeta.alternates) === JSON.stringify({ canonical: "/zz-compare/zz-rival" }));
    const nestedMap = (await sitemap()).map((e) => new URL(e.url).pathname);
    ok("the sitemap lists nested pages at their addresses", ["/zz-compare", "/zz-compare/zz-rival", "/zz-orphan/zz-child"].every((p) => nestedMap.includes(p)), nestedMap.filter((p) => p.startsWith("/zz-")).join(" "));
    try {
      const { NextRequest } = require("next/server") as typeof import("next/server");
      const proxy = (require("../src/proxy") as { default: (req: unknown, ctx: unknown) => Promise<Response> }).default;
      const res = await proxy(new NextRequest(`http://${ROOT}/zz-compare/zz-rival`, { headers: { host: ROOT, "user-agent": "Mozilla/5.0 (check:site)" } }), {});
      ok("  and the proxy serves them from the site's folder, indexable", (res.headers.get("x-middleware-rewrite") ?? "").includes("/platform-site/zz-compare/zz-rival") && res.headers.get("x-robots-tag") === "index, follow", `${res.headers.get("x-middleware-rewrite")} ${res.headers.get("x-robots-tag")}`);
    } catch (err) {
      ok("  and the proxy serves them", false, err instanceof Error ? err.message : String(err));
    }

    // ─── The comparison pages (scripts/site-content/compare.ts, W3), as the seed publishes them ────
    section("The comparison pages: /compare and one page per competitor");
    at(ROOT);
    const compareSection = (require("./site-content/compare") as typeof import("./site-content/compare")).section;
    const comparePages = compareSection.pages ?? [];
    // Each page's sources come from the competitor's own websites and nowhere else (the research rule).
    const OFFICIAL: Record<string, RegExp> = {
      "compare/zoho-one": /^https:\/\/([a-z0-9-]+\.)*zoho\.(com|in)\//,
      "compare/tally": /^https:\/\/([a-z0-9-]+\.)*tallysolutions\.com\//,
      "compare/odoo": /^https:\/\/([a-z0-9-]+\.)*odoo\.com\//,
      "compare/salesforce": /^https:\/\/([a-z0-9-]+\.)*salesforce\.com\//,
      "compare/hubspot": /^https:\/\/([a-z0-9-]+\.)*hubspot\.com\//,
      "compare/freshworks": /^https:\/\/([a-z0-9-]+\.)*(freshworks|freshdesk)\.com\//,
    };
    ok("seven pages: the hub and the six comparisons the owner chose", comparePages.map((p) => p.slug).sort().join(" ") === ["compare", ...Object.keys(OFFICIAL)].sort().join(" "), comparePages.map((p) => p.slug).join(" "));
    const refused = comparePages.map((p) => ({ slug: p.slug, checked: siteValidate.checkPageDocument(p.document, "publish") })).filter((r) => !r.checked.ok);
    ok("  the CMS's validator takes every one of them to publish", refused.length === 0, refused.map((r) => `${r.slug}: ${JSON.stringify(r.checked.ok ? [] : r.checked.issues.slice(0, 2))}`).join(" | "));
    for (const p of comparePages) {
      if (!(await control.sitePage.findUnique({ where: { slug: p.slug }, select: { id: true } }))) await cmsPage(p.slug, p.document.title, p.document.seo as never, p.document.blocks);
    }
    siteContent.invalidateSiteContent();
    const PRICE = /[₹$€£]|\bRs\.?\s?\d|\b(INR|USD|EUR)\b/;
    const SUPERLATIVE = /\b(best|#1|number one|leading|world-class|fastest|cheapest|easiest|unbeatable|unmatched)\b/i;
    const TOKEN = /\{(siteName|tagline|displayDomain|salesEmail|trialDays)\}/;
    for (const p of comparePages) {
      const markup = await renderRoute(catchAll as unknown as Route, { slug: p.slug.split("/") });
      const main = markup.slice(markup.indexOf("<main"), markup.indexOf("</main>"));
      const words = textOf(main);
      const table = p.document.blocks.find((b) => b.type === "comparisonTable");
      const where = `/${p.slug}`;
      ok(`${where}: one h1, no token left unfilled, nothing that reads as a price or a superlative`, (markup.match(/<h1[\s>]/g) ?? []).length === 1 && !TOKEN.test(markup) && !PRICE.test(words) && !SUPERLATIVE.test(words), `${(markup.match(/<h1[\s>]/g) ?? []).length} h1 ${TOKEN.exec(markup)?.[0] ?? ""} ${PRICE.exec(words)?.[0] ?? ""} ${SUPERLATIVE.exec(words)?.[0] ?? ""}`);
      if (p.slug === "compare") {
        const mapped = Object.keys(OFFICIAL).filter((s) => main.includes(`href="/${s}"`));
        ok("  the hub: a page map with a link to each comparison, and no breadcrumb one level down", mapped.length === 6 && /<h3[^>]*>/.test(main) && !main.includes('aria-label="Breadcrumb"'), mapped.join(" "));
        continue;
      }
      if (table?.type !== "comparisonTable") {
        ok(`${where}: has its comparison table`, false);
        continue;
      }
      const { rows, competitor } = table.props;
      ok(
        `  the table: 12–25 rows, a caption, a header per product and one per feature, each answer shown`,
        rows.length >= 12 && rows.length <= 25 && /<table role="table"/.test(main) && /<caption[^>]*>/.test(main) && (main.match(/scope="col"/g) ?? []).length === 3 && (main.match(/scope="row"/g) ?? []).length === rows.length,
        `${rows.length} rows, ${(main.match(/scope="row"/g) ?? []).length} row headers`,
      );
      const official = OFFICIAL[p.slug];
      const sources = rows.map((r) => r.source ?? "");
      const offSite = sources.filter((s) => !official?.test(s));
      ok(`  every ${competitor} cell has a source, and every source is on the vendor's own website`, offSite.length === 0, offSite.slice(0, 3).join(" "));
      const anchors = [...main.matchAll(/<a [^>]*href="(https:\/\/[^"]+)"[^>]*rel="nofollow noopener noreferrer"[^>]*>|<a [^>]*rel="nofollow noopener noreferrer"[^>]*href="(https:\/\/[^"]+)"[^>]*>/g)].map((m) => (m[1] ?? m[2]).replace(/&amp;/g, "&"));
      ok("  each source a link, rel nofollow noopener noreferrer", sources.every((s) => anchors.includes(s)), `${anchors.length} nofollow links for ${sources.length} rows`);
      const foot = words.lastIndexOf(`Information about ${competitor} on this page is from`);
      ok(
        "  the as-of line and the disclaimer under the table, and the page's own disclaimer at its foot",
        words.includes(`Information about ${competitor} from its public website as of 30 September 2026.`) &&
          words.includes("Product names and trademarks belong to their owners.") &&
          foot > words.lastIndexOf("Related pages") &&
          words.slice(foot).includes("30 September 2026") &&
          words.trimEnd().endsWith("Check their website for current details."),
        words.slice(foot, foot + 160),
      );
      ok("  the text says it compares (vs), so the table counts as the comparison; and an FAQ with its FAQPage", /\bvs\b/.test(words) && typesOf(markup) === "WebPage+BreadcrumbList+FAQPage", typesOf(markup));
      ok("  its breadcrumb: Home › Compare › it", crumbsOf(markup) === `Home › Compare › ${p.document.title}`, crumbsOf(markup));
      ok("  switching: a link to the import and migration page", main.includes('href="/product/import-migration"'));
    }

    // ─── The seeded pages and guides (scripts/site-content: product, solutions, resources, guides — W2) ───
    section("The seeded pages and guides: product, solutions, resources, the glossary and six guides");
    at(ROOT);
    {
      const seedSections = await (require("./site-content") as typeof import("./site-content")).loadSections(["product", "products", "solutions", "resources", "guides"]);
      const catalogue = require("./site-content/_catalog") as typeof import("./site-content/_catalog");
      const { siteNav: seedSiteNav } = require("./site-content/nav") as typeof import("./site-content/nav");
      const { PRODUCTS } = require("../src/lib/products") as typeof import("../src/lib/products");
      const cmsTypes = require("../src/lib/cms/types") as typeof import("../src/lib/cms/types");
      const seedPages = seedSections.flatMap((s) => s.pages ?? []);
      const seedPosts = seedSections.flatMap((s) => s.posts ?? []);
      const siteMap = [
        "product",
        "solutions",
        "resources",
        "resources/glossary",
        ...[...catalogue.PRODUCT_GROUPS, ...catalogue.SOLUTION_GROUPS].flatMap((g) => g.entries.map((e) => e.path.slice(1))),
        ...PRODUCTS.map((p) => p.path.slice(1)),
      ].sort();
      ok(
        `every page in the site map: the three hubs, 25 modules, 13 solutions and the glossary, a page for each of the ${PRODUCTS.length} products, and six guides`,
        seedPages.map((p) => p.slug).sort().join(" ") === siteMap.join(" ") && siteMap.length === 42 + PRODUCTS.length && seedPosts.length === 6,
        `${seedPages.length} pages, ${seedPosts.length} posts`,
      );
      const refusedPages = seedPages.map((p) => ({ slug: p.slug, checked: siteValidate.checkPageDocument(p.document, "publish") })).filter((r) => !r.checked.ok);
      const refusedPosts = seedPosts.filter((p) => !siteValidate.checkPostBody(p.body, "publish", cmsTypes.POST_BLOCK_TYPES).ok || !siteValidate.checkPostSeo(p.seo).ok);
      ok("  the CMS's validator takes every page and post to publish", refusedPages.length === 0 && refusedPosts.length === 0, [...refusedPages.map((r) => r.slug), ...refusedPosts.map((p) => p.slug)].join(" "));

      // Written straight to the database, as the seed leaves them: pages published, posts live in the Guides category.
      for (const p of seedPages) {
        const checked = siteValidate.checkPageDocument(p.document, "publish");
        if (checked.ok && !(await control.sitePage.findUnique({ where: { slug: p.slug }, select: { id: true } }))) await cmsPage(p.slug, checked.value.title, checked.value.seo as never, checked.value.blocks);
      }
      const guidesCategory = await control.siteCategory.upsert({ where: { slug: "guides" }, update: {}, create: { slug: "guides", name: "Guides", position: 99, updatedBy: "script" } });
      for (const post of seedPosts) {
        const body = siteValidate.checkPostBody(post.body, "publish", cmsTypes.POST_BLOCK_TYPES);
        await control.sitePost.create({
          data: {
            slug: post.slug,
            title: post.title,
            excerpt: post.excerpt,
            body: (body.ok ? body.value : []) as never,
            seo: post.seo as never,
            status: "PUBLISHED",
            publishAt: liveAt,
            publishedAt: liveAt,
            authorId: archiveAuthor.id,
            updatedBy: "script",
            categories: { create: [{ categoryId: guidesCategory.id }] },
          },
        });
      }
      siteContent.invalidateSiteContent();

      const SEED_TOKEN = /\{(siteName|tagline|displayDomain|salesEmail|trialDays)\}/;
      const titleOf = (m: Meta) => (typeof m.title === "string" ? m.title : String((m.title as { absolute?: string } | undefined)?.absolute ?? ""));
      const renderProblems: string[] = [];
      /** Internal links in each page's and post's own content (its <main>), to the other seeded pages and posts. */
      const linksFrom = new Map<string, Set<string>>();
      const mainOf = (markup: string) => markup.slice(markup.indexOf("<main"), markup.indexOf("</main>"));
      const hrefsIn = (main: string) => new Set([...main.matchAll(/href="(\/[^"#?]*)/g)].map((m) => (m[1] === "/" ? "/" : m[1].replace(/\/$/, ""))));
      for (const p of seedPages) {
        const segments = p.slug.split("/");
        const markup = await renderRoute(catchAll as unknown as Route, { slug: segments });
        const meta = (await catchAll.generateMetadata({ params: Promise.resolve({ slug: segments }) } as never)) as Meta;
        const h1s = (markup.match(/<h1[\s>]/g) ?? []).length;
        const unfilled = SEED_TOKEN.exec(markup)?.[0];
        if (h1s !== 1 || unfilled || !titleOf(meta).trim() || !String(meta.description ?? "").trim()) renderProblems.push(`/${p.slug}: ${h1s} h1 ${unfilled ?? ""} title "${titleOf(meta)}"`);
        linksFrom.set(`/${p.slug}`, hrefsIn(mainOf(markup)));
      }
      for (const post of seedPosts) {
        const markup = await renderRoute(postRoute, { slug: post.slug });
        const meta = await postRoute.generateMetadata({ params: Promise.resolve({ slug: post.slug }) } as never);
        const h1s = (markup.match(/<h1[\s>]/g) ?? []).length;
        const unfilled = SEED_TOKEN.exec(markup)?.[0];
        if (h1s !== 1 || unfilled || !titleOf(meta).trim() || !String(meta.description ?? "").trim() || !markup.includes("Last reviewed:")) renderProblems.push(`/blog/${post.slug}: ${h1s} h1 ${unfilled ?? ""}`);
        linksFrom.set(`/blog/${post.slug}`, hrefsIn(mainOf(markup)));
      }
      ok(`all ${seedPages.length + seedPosts.length} render for a visitor: one h1, no token left unfilled, a title and a description (the guides a "Last reviewed" date)`, renderProblems.length === 0, renderProblems.slice(0, 4).join(" | "));
      const glossary = await renderRoute(catchAll as unknown as Route, { slug: ["resources", "glossary"] });
      const questions = (glossary.match(/<h3[^>]*>What (is|are)\b|<h3[^>]*>Who must|<h3[^>]*>Which forms/g) ?? []).length;
      ok("  the glossary: 40 to 60 terms, each a question, with official sources linked", questions >= 40 && questions <= 60 && /href="https:\/\/(www\.)?(cbic-gst|einvoice\.gst|ewaybillgst)\.gov\.in/.test(glossary) && /href="https:\/\/www\.incometaxindia\.gov\.in/.test(glossary), `${questions} terms`);
      ok("  a module page's breadcrumb is Home › Product › it", crumbsOf(await renderRoute(catchAll as unknown as Route, { slug: ["product", "crm"] })) === "Home › Product › CRM");

      // At least three internal links in and out of each, counting only the seeded pages' and posts' own content.
      const seeded = [...linksFrom.keys()];
      const linksIn = new Map(seeded.map((to) => [to, seeded.filter((from) => from !== to && linksFrom.get(from)?.has(to)).length]));
      const fewIn = seeded.filter((to) => (linksIn.get(to) ?? 0) < 3);
      const fewOut = seeded.filter((from) => [...(linksFrom.get(from) ?? [])].filter((to) => to !== from).length < 3);
      ok("  every one links to at least three other pages, and at least three of them link to it", fewIn.length === 0 && fewOut.length === 0, `in: ${fewIn.map((p) => `${p}(${linksIn.get(p)})`).join(" ")} out: ${fewOut.join(" ")}`);

      // The header and footer the seed publishes: valid settings, and every link on this site goes to a page it has.
      const seedNav = seedSiteNav({ partnerPortal: "https://partners.example.com/" });
      const navChecked = siteValidate.checkSiteSettings({ ...DEFAULT_SITE_SETTINGS, ...seedNav }, "publish");
      const known = new Set([...seeded, ...catalogue.COMPARE_ENTRIES.map((e) => e.path), "/compare", "/", "/pricing", "/security", "/contact", "/signin", "/terms", "/privacy", "/partners", "/partners/find", "/blog", "/blog/category/guides"]);
      const navHrefs = [...siteNav.navLinks(seedNav.nav), ...seedNav.footer.columns.flatMap((c) => c.links)].map((l) => l.href);
      const dangling = navHrefs.filter((h) => h.startsWith("/") && !known.has(h.split(/[?#]/)[0]));
      ok(
        "the header's six menus and the footer's six columns: valid to publish, every site link to a page the site has, the partner portal on its own host",
        navChecked.ok && seedNav.nav.length === 6 && seedNav.footer.columns.length === 6 && dangling.length === 0 && navHrefs.includes("https://partners.example.com/"),
        `${navChecked.ok ? "" : JSON.stringify(navChecked.issues.slice(0, 2))} ${dangling.join(" ")}`,
      );

      // ─── The products (src/lib/products.ts): a page each, the Product menu, the module pages' lines ───
      section("The products: a page for each in products.ts, the Product menu and footer, and each module page's line");
      const productsLib = require("../src/lib/products") as typeof import("../src/lib/products");
      const placing = require("./site-content/_products") as typeof import("./site-content/_products");
      const { productMenu, productFooterColumns } = require("./site-content/nav") as typeof import("./site-content/nav");
      const productSection = (require("./site-content/products") as typeof import("./site-content/products")).section;
      const productPages = new Map((productSection.pages ?? []).map((p) => [p.slug, p]));
      const builtins = new Set(["/", "/pricing", "/security", "/contact", "/signin", "/terms", "/privacy", "/partners", "/partners/find", "/blog", "/blog/category/guides"]);
      const resolves = (href: string) => {
        const path = href.split(/[?#]/)[0]!.replace(/\/$/, "") || "/";
        return seeded.includes(path) || builtins.has(path) || catalogue.COMPARE_ENTRIES.some((e) => e.path === path) || path === "/compare";
      };

      // Each product's page: published at its path, one h1 naming it, every link on it to a page the site has, no price.
      const PRODUCT_PRICE = /[₹$€£]|\bRs\.?\s?\d|\b(INR|USD|EUR)\b|\bper (user|seat|month)\b|\b\d+\s+(seats?|users?)\b/i;
      const PRODUCT_SUPERLATIVE = /\b(best|#1|number one|leading|world-class|fastest|cheapest|easiest|unbeatable|unmatched)\b/i;
      const productProblems: string[] = [];
      const deadLinks: string[] = [];
      const productMarkup = new Map<string, string>();
      for (const p of productsLib.PRODUCTS) {
        const slug = p.path.slice(1);
        const row = await control.sitePage.findUnique({ where: { slug }, select: { status: true } });
        if (!productPages.has(slug) || row?.status !== "PUBLISHED") {
          productProblems.push(`${p.path}: ${productPages.has(slug) ? (row?.status ?? "not in the database") : "no page in products.ts"}`);
          continue;
        }
        const markup = await renderRoute(catchAll as unknown as Route, { slug: [slug] });
        productMarkup.set(p.path, markup);
        const main = mainOf(markup);
        const h1s = [...markup.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => textOf(m[1]!).trim());
        // The words are the page's own copy: the drawn previews beside a hero show sample figures, in rupees.
        const words = JSON.stringify(productPages.get(slug)!.document);
        if (h1s.length !== 1 || !h1s[0]!.includes(p.name)) productProblems.push(`${p.path}: ${h1s.length} h1 "${h1s[0] ?? ""}"`);
        if (PRODUCT_PRICE.test(words) || PRODUCT_SUPERLATIVE.test(words)) productProblems.push(`${p.path}: "${PRODUCT_PRICE.exec(words)?.[0] ?? PRODUCT_SUPERLATIVE.exec(words)?.[0]}"`);
        if (!main.includes('href="/pricing"') || !main.includes('href="/contact?topic=sales"')) productProblems.push(`${p.path}: no link to pricing, or no "talk to sales"`);
        for (const href of hrefsIn(main)) if (!resolves(href)) deadLinks.push(`${p.path} → ${href}`);
      }
      ok(
        `every product in products.ts (${productsLib.PRODUCTS.length}) has a published page at its path: one h1 naming it, no price, seat count or superlative, pricing linked and sales a click away`,
        productProblems.length === 0,
        productProblems.slice(0, 4).join(" | "),
      );
      ok("  every link on them goes to a page the site has", deadLinks.length === 0, deadLinks.slice(0, 4).join(" | "));
      const brandLeft = [...productPages.values()].filter((page) => {
        let text = JSON.stringify(page.document);
        // A tagline may open a sentence after the name ("Deskzo One: every Deskzo product…"), its first letter lowered.
        for (const p of productsLib.PRODUCTS) text = text.split(p.tagline).join("").split(p.tagline[0]!.toLowerCase() + p.tagline.slice(1)).join("").split(p.name).join("");
        return text.includes(productsLib.PRODUCT_FAMILY);
      });
      ok(`  the family's name ("${productsLib.PRODUCT_FAMILY}") only inside products.ts's names and taglines; the brand otherwise the {siteName} token`, brandLeft.length === 0, brandLeft.map((p) => p.slug).join(" "));
      const oneMain = mainOf(productMarkup.get(productsLib.productByKey("one")!.path) ?? "");
      ok("  the suite's page maps every other product, by group, and lists the add-ons", productsLib.PRODUCTS.filter((p) => p.key !== "one").every((p) => oneMain.includes(`href="${p.path}"`)) && productsLib.ADD_ONS.every((a) => textOf(oneMain).includes(a.name)));

      // "What's in it": each product's modules, linked to the module page that describes them, or listed without a link.
      const modulePages = new Set(catalogue.PRODUCT_GROUPS.flatMap((g) => g.entries.map((e) => e.path)));
      const unknownModules = productsLib.PRODUCTS.flatMap((p) => p.modules.filter((k) => !placing.MODULES[k] || !MODULE_REGISTRY.some((m) => m.key === k)).map((k) => `${p.key}:${k}`));
      const badModulePages = Object.entries(placing.MODULES).filter(([, m]) => m.page && !modulePages.has(m.page)).map(([k, m]) => `${k} → ${m.page}`);
      const missingCards = productsLib.PRODUCTS.flatMap((p) =>
        p.modules.filter((k) => {
          const m = placing.MODULES[k];
          const main = mainOf(productMarkup.get(p.path) ?? "");
          return !m || !textOf(main).includes(m.label) || (m.page && !main.includes(`href="${m.page}"`));
        }).map((k) => `${p.path}:${k}`),
      );
      ok(
        "module links resolve: every product's module is a real one the site describes, shown on its page, linked to a module page the site has (or listed without a link)",
        unknownModules.length === 0 && badModulePages.length === 0 && missingCards.length === 0,
        [...unknownModules, ...badModulePages, ...missingCards].slice(0, 5).join(" | "),
      );

      // The Product menu and the footer's product columns, built from products.ts.
      const menu = productMenu();
      const menuLinks = menu.columns.flatMap((c) => c.items);
      const productLinks = productsLib.PRODUCTS.map((p) => menuLinks.filter((l) => l.href === p.path));
      ok(
        "the Product menu: one link per product, its products.ts name with its tagline as the line under it",
        productLinks.every((ls, i) => ls.length === 1 && ls[0]!.label === productsLib.PRODUCTS[i]!.name && ls[0]!.description === productsLib.PRODUCTS[i]!.tagline),
        productsLib.PRODUCTS.filter((_, i) => productLinks[i]!.length !== 1).map((p) => p.name).join(", "),
      );
      const limitsKept =
        menu.columns.length <= types.NAV_LIMITS.columns &&
        menu.columns.every((c) => c.items.length <= types.NAV_LIMITS.columnItems) &&
        menuLinks.every((l) => !l.description || [...l.description].length <= types.NAV_LIMITS.description);
      ok(
        `  within NAV_LIMITS (${types.NAV_LIMITS.columns} columns, ${types.NAV_LIMITS.columnItems} links each, ${types.NAV_LIMITS.description}-character lines); the add-ons and capabilities to their module pages; "See every module" at its foot`,
        limitsKept &&
          menuLinks.filter((l) => !productsLib.PRODUCTS.some((p) => p.path === l.href)).every((l) => modulePages.has(l.href)) &&
          Object.values(placing.ADD_ON_PAGES).every((path) => menuLinks.some((l) => l.href === path)) &&
          placing.CAPABILITY_PAGES.every((path) => menuLinks.some((l) => l.href === path)) &&
          menu.footer?.href === "/product",
        menu.columns.map((c) => `${c.title}:${c.items.length}`).join(" "),
      );
      const footerColumns = productFooterColumns();
      ok(
        "the footer's product columns: every product by its name, within the footer's limits",
        productsLib.PRODUCTS.every((p) => footerColumns.some((c) => c.links.some((l) => l.href === p.path && l.label === p.name))) &&
          footerColumns.every((c) => c.links.length <= types.NAV_LIMITS.footerLinks) &&
          seedNav.footer.columns.length <= types.NAV_LIMITS.footerColumns,
        footerColumns.map((c) => `${c.title}:${c.links.length}`).join(" "),
      );
      await publishSettings({ ...DEFAULT_SITE_SETTINGS, ...seedNav });
      const productsHeaderPage = await render("/pricing");
      const productsHeader = headerOf(productsHeaderPage);
      const productsFooter = footerOf(productsHeaderPage);
      ok(
        "  published, the header has every product in the server's HTML (the desktop panel and the phone's accordion) and the footer links each",
        productsLib.PRODUCTS.every((p) => hrefCount(productsHeader, p.path) >= 2 && hrefCount(productsFooter, p.path) === 1 && textOf(productsHeader).includes(p.tagline)),
        productsLib.PRODUCTS.map((p) => `${p.path}:${hrefCount(productsHeader, p.path)}/${hrefCount(productsFooter, p.path)}`).join(" "),
      );

      // Each module page: one line under its header naming the products it is in, linked (productsOfModule through PAGE_PLACES).
      const unplaced = [...modulePages].filter((path) => !placing.PAGE_PLACES[path]);
      const strayPlaces = Object.keys(placing.PAGE_PLACES).filter((path) => !modulePages.has(path));
      const lineProblems: string[] = [];
      for (const path of modulePages) {
        if (!placing.PAGE_PLACES[path]) continue;
        const main = mainOf(await renderRoute(catchAll as unknown as Route, { slug: path.slice(1).split("/") }));
        const place = placing.PAGE_PLACES[path]!;
        const boughtWith = "addOn" in place ? productsLib.ADD_ONS.find((a) => a.key === place.addOn)?.onProduct : undefined;
        const named = "addOn" in place ? [productsLib.productByKey(boughtWith ?? "one")!] : [...placing.productsOfPage(path), productsLib.productByKey("one")!];
        const firstH2 = main.search(/<h2[\s>]/);
        const late = named.filter((p) => {
          const at = main.indexOf(`href="${p.path}"`);
          return at === -1 || (firstH2 !== -1 && at > firstH2);
        });
        if (late.length) lineProblems.push(`${path}: ${late.map((p) => p.path).join(",")}`);
      }
      ok(
        `every module page (${modulePages.size}) has its line under the header, linking the products it is in (productsOfModule over its modules), the add-ons' to the product they're bought with`,
        unplaced.length === 0 && strayPlaces.length === 0 && lineProblems.length === 0,
        [...unplaced.map((p) => `no place: ${p}`), ...strayPlaces.map((p) => `not a module page: ${p}`), ...lineProblems].slice(0, 4).join(" | "),
      );
      ok(
        "  the line's products are productsOfModule's: the CRM page names the CRM product alone, the item catalogue's page every product with items",
        placing.productsOfPage("/product/crm").map((p) => p.key).join(",") === "crm" && placing.productsOfPage("/product/inventory").map((p) => p.key).join(",") === "books,inventory,subscriptions",
        `${placing.productsOfPage("/product/crm").map((p) => p.key).join(",")} / ${placing.productsOfPage("/product/inventory").map((p) => p.key).join(",")}`,
      );
    }

    // The scoring engine never runs on a public request: nothing the public site is built from imports it — only the
    // builders (extract, schema, metadata), the crawler policy and the types.
    const REPO = path.join(__dirname, "..");
    const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
    const builtFrom = [
      ...sources(path.join(REPO, "src", "app", "platform-site")),
      ...sources(path.join(REPO, "src", "components", "site")),
      ...["robots.ts", "sitemap.ts"].map((f) => path.join(REPO, "src", "app", f)),
      ...["extract.ts", "schema.ts", "metadata.ts", "crawlers.ts", "keywords.ts", "text.ts", "types.ts"].map((f) => path.join(REPO, "src", "lib", "seo", f)),
    ];
    const engineImports = builtFrom.filter((f) => /from\s+["'](@\/lib\/seo|\.\.?\/(engine|site|index)|@\/lib\/seo\/(engine|site|index|checks\/[\w-]+)|\.\/checks\/[\w-]+)["']/.test(readFileSync(f, "utf8")));
    ok("no public-site file, nor a builder it uses, imports the scoring engine (the barrel, engine, site score or checks)", builtFrom.length > 30 && engineImports.length === 0, engineImports.map((f) => path.relative(REPO, f)).join(", "));

    // ─── The logs ───────────────────────────────────────────────────────────────────────────────
    section("What was logged");
    const leaked = logged.filter((l) => ADDRESSES.some((a) => l.toLowerCase().includes(a.toLowerCase())) || /[\w.+-]+@zzsite\.example/i.test(l));
    ok("no email address anywhere in the logs", leaked.length === 0, leaked.slice(0, 2).join(" / "));
  } finally {
    if (cleanup) await cleanup().catch(() => {});
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => (hanging ? hanging.close(() => resolve()) : resolve()));
    await dropAll().catch((e) => ok("scratch databases dropped", false, e));
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname like 'zzsite-%'`;
    ok("every database this check made is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  for (const level of Object.keys(realConsole) as (keyof typeof realConsole)[]) console[level] = realConsole[level];
  process.stdout.write(failures === 0 ? "\nAll site checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
