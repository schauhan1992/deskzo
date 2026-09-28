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
 *     site's pages indexable while signup, a query, a workspace and the console stay noindex.
 *
 * No mail leaves: the platform mailer is replaced.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
    ok("  the AI and SEO crawlers stay shut out there too", /Disallow: \/(\n|$)/.test(group(rootRobots, "GPTBot")) && /Disallow: \/(\n|$)/.test(group(rootRobots, "AhrefsBot")));
    ok("  and the sitemap is named", rootRobots.includes(`Sitemap: http://${ROOT}/sitemap.xml`));
    ok("a workspace's host and the console's: everything disallowed, as before", [wsRobots, consoleRobots].every((r) => /Disallow: \/(\n|$)/.test(group(r, "*")) && !/Allow:/.test(r) && !r.includes("Sitemap")));
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
