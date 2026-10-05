/**
 * check:site-search — the public website's Search & AI settings (owner, 5 Oct 2026;
 * src/lib/cms/search-policy.ts), on a scratch control plane of its own (<db>_search_control, dropped
 * at the end, pass or fail):
 *
 *   · robots.txt's rules for each choice: S-D2 by default (AI search in, training out), either AI
 *     switch, and the whole site hidden — search engines may still fetch (to read the noindex), no AI
 *     crawler may, SEO crawlers never;
 *   · llms.txt as written (src/lib/seo/llms.ts): the name, the summary, pages grouped as the header's
 *     menus group them, the rest first, posts last, absolute links, one line each;
 *   · the stored policy: defaults with nothing stored, read tolerantly, saved by admins only, refused
 *     when malformed, live at once, audited without the summary's words; a staging installation is
 *     hidden whatever is stored; the CMS keeps up to 2,000 characters in a setting now;
 *   · robots.txt, the sitemap and /llms.txt as served, on the public host and elsewhere, as the choices
 *     move: llms.txt leaves out a noindex page, a page or post left out of it, and a redirected one;
 *   · the metadata: no `robots` on an indexable page or post (so the layout's can apply), noindex on
 *     every page through the layout while hidden; an archive kept out of search says noindex, scores as
 *     excluded, and leaves the sitemap;
 *   · the proxy: "index, follow" on the public site's pages, harden()'s noindex instead while hidden,
 *     and /llms.txt answered at the root, not in the site's folder;
 *   · the Search & AI page for an admin, "not found" for an editor; the dashboards' warning while hidden;
 *     the activity log in words.
 */
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import Module from "node:module";
import path from "node:path";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
// Emptied, not deleted: a Prisma client imported later reloads .env and would put a deleted value back.
process.env.TRUST_PROXY = "";
process.env.TRUST_PROXY_HOPS = "";
process.env.TENANCY_LEGACY_HOSTS = "";
process.env.PLATFORM_CONSOLE_IP_ALLOWLIST = "";
process.env.REFERENCE_DATABASE_URL = "";
process.env.PLATFORM_ENV = "";

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
  u.search = "";
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

// ─── A request, as the site, the CMS and the routes see one ──────────────────────────────────────
const jar = new Map<string, string>();
let requestHeaders = new Headers({ host: "localhost:3000" });
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
      notFound: () => {
        throw new Error("notFound");
      },
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
      usePathname: () => "/",
      useSearchParams: () => new URLSearchParams(),
    };
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
async function renderPage(page: Page, searchParams: Record<string, string> = {}): Promise<string> {
  const el = await page({ params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) } as never);
  return renderToStaticMarkup((await resolveAsync(el)) as ReactElement);
}
const textOf = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const realName = new URL(url).pathname.slice(1);
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);

  /* eslint-disable @typescript-eslint/no-require-imports */
  const crawlers = require("../src/lib/seo/crawlers") as typeof import("../src/lib/seo/crawlers");
  const llms = require("../src/lib/seo/llms") as typeof import("../src/lib/seo/llms");

  section("robots.txt's rules, for each choice");
  const group = (rules: ReturnType<typeof crawlers.publicSiteRobotsRules>, agent: string) =>
    rules.find((r) => (Array.isArray(r.userAgent) ? r.userAgent : [r.userAgent]).includes(agent));
  const shut = (rules: ReturnType<typeof crawlers.publicSiteRobotsRules>, agent: string) => {
    const g = group(rules, agent);
    return !!g && g.disallow === "/" && g.allow === undefined;
  };
  const S_D2 = crawlers.publicSiteRobotsRules();
  ok("by default, S-D2: AI search in, AI training out", crawlers.aiSearchCrawlersAllowed(S_D2) && !crawlers.aiTrainingCrawlersAllowed(S_D2) && shut(S_D2, "GPTBot"));
  ok("  search engines may read everything but signup", JSON.stringify(group(S_D2, "*")) === JSON.stringify({ userAgent: "*", allow: "/", disallow: ["/signup"] }));
  ok("  the default policy is spelled out the same", JSON.stringify(crawlers.publicSiteRobotsRules(crawlers.DEFAULT_CRAWLER_POLICY)) === JSON.stringify(S_D2));
  const noSearch = crawlers.publicSiteRobotsRules({ hidden: false, aiSearch: false, aiTraining: false });
  ok("AI search switched off: every AI search crawler shut out, by name", !crawlers.aiSearchCrawlersAllowed(noSearch) && crawlers.AI_SEARCH_AGENTS.every((a) => shut(noSearch, a)));
  const training = crawlers.publicSiteRobotsRules({ hidden: false, aiSearch: true, aiTraining: true });
  ok("AI training switched on: they may read it as search engines do — not signup", crawlers.aiTrainingCrawlersAllowed(training) && JSON.stringify(group(training, "GPTBot")?.disallow) === JSON.stringify(["/signup"]));
  const hidden = crawlers.publicSiteRobotsRules({ hidden: true, aiSearch: true, aiTraining: true });
  ok("hidden: no AI crawler at all, whatever the switches say", !crawlers.aiSearchCrawlersAllowed(hidden) && !crawlers.aiTrainingCrawlersAllowed(hidden));
  ok("  but search engines may still fetch pages, to read their noindex", JSON.stringify(group(hidden, "*")) === JSON.stringify(group(S_D2, "*")));
  ok("SEO crawlers are shut out under every choice", [S_D2, noSearch, training, hidden].every((rules) => crawlers.SEO_AGENTS.every((a) => shut(rules, a))));

  section("llms.txt, as written");
  const nav = [
    { label: "Product", columns: [{ title: "Sell", items: [{ label: "CRM", href: "/product/crm" }, { label: "Nowhere", href: "/not-a-page" }] }, { title: "Run", items: [{ label: "HR", href: "/product/hr#top" }] }], footer: { label: "All", href: "/product" } },
    { label: "Pricing", href: "/pricing" },
    { label: "Solutions", columns: [{ title: "By size", items: [{ label: "Elsewhere", href: "https://example.com/x" }] }] },
  ];
  const text = llms.buildLlmsTxt({
    siteName: "Zz Site",
    summary: "Zz does\nthings.",
    origin: "https://zz.example",
    nav: nav as never,
    pages: [
      { path: "/", title: "Home", description: "The front." },
      { path: "/product", title: "Product", description: "" },
      { path: "/product/hr", title: "HR", description: "People." },
      { path: "/pricing", title: "Pricing", description: "Plans." },
      { path: "/product/crm", title: "CRM [beta]", description: "Leads\nand deals." },
      { path: "/orphan", title: "Orphan", description: "No menu." },
      { path: "/product/extra/deep", title: "Deep", description: "Under a menu's page." },
      { path: "/orphan/child", title: "Child", description: "Under no menu's page." },
    ],
    posts: [{ path: "/blog/zz-post", title: "Zz post", description: "Newest." }],
  });
  const lines = text.split("\n");
  ok("the site's name as the heading, the summary on one line as a quote", lines[0] === "# Zz Site" && lines[2] === "> Zz does things.", JSON.stringify(lines.slice(0, 3)));
  const headings = lines.filter((l) => l.startsWith("## "));
  ok("pages no menu holds first, then each menu with pages, then the blog", JSON.stringify(headings) === JSON.stringify(["## Pages", "## Product", "## Blog"]), JSON.stringify(headings));
  const under = (heading: string) => {
    const at = lines.indexOf(heading);
    const rest = lines.slice(at + 2);
    return rest.slice(0, rest.indexOf("")).join("\n");
  };
  ok(
    "  Pages: in the order given, absolute links — a page under one of them too",
    under("## Pages") === "- [Home](https://zz.example/): The front.\n- [Pricing](https://zz.example/pricing): Plans.\n- [Orphan](https://zz.example/orphan): No menu.\n- [Child](https://zz.example/orphan/child): Under no menu's page.",
    JSON.stringify(under("## Pages")),
  );
  ok(
    "  a menu's pages in its order, its footer link last, then a page under one of them; a link to no page or off the site skipped; brackets out of link text; no colon without a description",
    under("## Product") === "- [CRM beta](https://zz.example/product/crm): Leads and deals.\n- [HR](https://zz.example/product/hr): People.\n- [Product](https://zz.example/product)\n- [Deep](https://zz.example/product/extra/deep): Under a menu's page.",
    JSON.stringify(under("## Product")),
  );
  ok("  the blog's posts last", under("## Blog") === "- [Zz post](https://zz.example/blog/zz-post): Newest.");
  ok("one trailing newline; no summary, no quote", text.endsWith(".\n") && !text.endsWith("\n\n") && !llms.buildLlmsTxt({ siteName: "Zz", summary: " ", origin: "https://zz.example", nav: [], pages: [], posts: [] }).includes(">"));

  section("A scratch control plane");
  ok("the database server is a local one", local);
  if (!local) throw new Error("not a local database");
  const controlName = `${realName}_search_control`;
  const controlUrl = withDatabase(url, controlName);
  const admin = directClient(withDatabase(url, "postgres"));
  let cleanup: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${controlName}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;
    ok("built from its migrations", true);

    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const policyLib = require("../src/lib/cms/search-policy") as typeof import("../src/lib/cms/search-policy");
    const types = require("../src/lib/cms/types") as typeof import("../src/lib/cms/types");
    const siteContent = require("../src/lib/platform/site-content") as typeof import("../src/lib/platform/site-content");
    const { PLATFORM_DOMAIN } = require("../src/lib/tenancy/host") as typeof import("../src/lib/tenancy/host");
    const { DEFAULT_SITE_SETTINGS } = require("../src/components/site/defaults") as typeof import("../src/components/site/defaults");
    cleanup = async () => {
      await closeControlDb();
    };
    const control = controlDb();
    const port = process.env.PLATFORM_PORT?.trim() ? `:${process.env.PLATFORM_PORT.trim()}` : "";
    const ROOT = `${PLATFORM_DOMAIN}${port}`;
    const CMS = `cms.${ROOT}`;
    const at = (host: string) => (requestHeaders = new Headers({ host, "user-agent": "Mozilla/5.0 (check:site-search)" }));
    const SCRIPT = { kind: "script" } as const;

    section("The stored policy");
    ok("nothing stored: the defaults", JSON.stringify(await policyLib.searchPolicy()) === JSON.stringify({ ...types.DEFAULT_SEARCH_POLICY, hidden: false, forcedHidden: false }));
    ok(
      "read tolerantly: garbage is the defaults, a missing switch keeps its default, a long summary is cut",
      JSON.stringify(policyLib.parseSearchPolicy("{not json")) === JSON.stringify(types.DEFAULT_SEARCH_POLICY) &&
        policyLib.parseSearchPolicy(JSON.stringify({ hideSite: true, aiSearch: "yes" })).aiSearch === true &&
        policyLib.parseSearchPolicy(JSON.stringify({ hideSite: true })).hideSite === true &&
        policyLib.parseSearchPolicy(JSON.stringify({ llmsSummary: "x".repeat(900) })).llmsSummary.length === types.LLMS_SUMMARY_MAX,
    );
    const base = { hideSite: false, aiSearch: true, aiTraining: false, llmsTxt: true, llmsSummary: "" };
    ok("a switch that isn't on or off is refused", (await thrown(() => policyLib.saveSearchPolicy({ ...base, aiTraining: "yes" }, SCRIPT))) === "Every switch is on or off.");
    ok("a summary over 500 characters is refused", /500 characters/.test(await thrown(() => policyLib.saveSearchPolicy({ ...base, llmsSummary: "x".repeat(501) }, SCRIPT))));
    ok("nothing was stored by either", (await control.cmsSetting.count({ where: { key: "search" } })) === 0);
    await policyLib.searchPolicy(); // a copy held in this process, then changed under it
    const saved = await policyLib.saveSearchPolicy({ ...base, aiTraining: true, llmsSummary: "  Zz sells\nsoftware.\u0007  " }, SCRIPT);
    ok("saved: one line of plain text, and live at once — not after the cache's 30 seconds", saved.policy.llmsSummary === "Zz sells software." && (await policyLib.searchPolicy()).aiTraining === true, JSON.stringify(saved.policy));
    const audit = await control.cmsAuditLog.findFirst({ where: { action: "settings.search" }, orderBy: { at: "desc" } });
    ok("audited: which switches moved and to what — never the summary's words", JSON.stringify(audit?.detail) === JSON.stringify({ fields: ["aiTraining", "llmsSummary"], aiTraining: true }), JSON.stringify(audit?.detail));
    const auditsBefore = await control.cmsAuditLog.count({ where: { action: "settings.search" } });
    await policyLib.saveSearchPolicy({ ...base, aiTraining: true, llmsSummary: "Zz sells software." }, SCRIPT);
    ok("saving it unchanged writes nothing", (await control.cmsAuditLog.count({ where: { action: "settings.search" } })) === auditsBefore);
    const longer = await thrown(() => control.cmsSetting.update({ where: { key: "search" }, data: { value: JSON.stringify({ ...base, llmsSummary: "y".repeat(500) }) } }));
    ok("the CMS keeps a setting of more than 200 characters now (its CHECK allows 2,000)", longer === "", longer.slice(0, 80));
    await thrown(() => control.cmsSetting.update({ where: { key: "search" }, data: { value: "z".repeat(2001) } })).then((m) => ok("  and refuses one over 2,000", /cms_settings_value_length|check constraint/i.test(m), m.slice(0, 80)));
    policyLib.invalidateSearchPolicy();
    process.env.PLATFORM_ENV = "staging";
    const staging = await policyLib.searchPolicy();
    ok("a staging installation is hidden, whatever is stored", staging.hidden && staging.forcedHidden && !staging.hideSite);
    process.env.PLATFORM_ENV = "";
    ok("  production, as stored", !(await policyLib.searchPolicy()).hidden);

    // ─── Content to list: a CMS page left out of llms.txt, one kept out of search, a live post, a redirect ───
    const cmsPage = (slug: string, title: string, seo: Record<string, unknown>) => {
      const doc = { title, seo: { title, description: `${title}, about {siteName}.`, ...seo }, blocks: [] };
      return control.sitePage.create({ data: { slug, title, status: "PUBLISHED", draft: doc, published: doc, publishedAt: new Date(), createdBy: "script", updatedBy: "script" } });
    };
    await cmsPage("zz-listed", "Zz listed", {});
    await cmsPage("zz-no-llms", "Zz no llms", { noLlms: true });
    await cmsPage("zz-noindex", "Zz noindex", { noindex: true });
    await cmsPage("zz-moved", "Zz moved", {});
    await control.siteRedirect.create({ data: { fromPath: "/zz-moved", toUrl: "/zz-listed", match: "EXACT", status: 301, enabled: true, updatedBy: "script" } });
    const author = await control.cmsUser.create({ data: { email: "author.zz@example.invalid", name: "Zz Author", role: "EDITOR", createdBy: "script" } });
    const liveAt = new Date(Date.now() - 60_000);
    const post = (slug: string, seo: { [key: string]: string | boolean } | null, extra: Record<string, unknown> = {}) =>
      control.sitePost.create({ data: { slug, title: `Post ${slug}`, excerpt: `Excerpt of ${slug}.`, body: [], status: "PUBLISHED", publishAt: liveAt, publishedAt: liveAt, authorId: author.id, updatedBy: "script", ...(seo ? { seo } : {}), ...extra } });
    const shown = await control.siteCategory.create({ data: { slug: "zz-shown", name: "Zz shown", updatedBy: "script" } });
    const kept = await control.siteCategory.create({ data: { slug: "zz-kept", name: "Zz kept", updatedBy: "script", seo: { noindex: true } } });
    const keptTag = await control.siteTag.create({ data: { slug: "zz-kept-tag", name: "Zz kept tag", updatedBy: "script", seo: { noindex: true } } });
    await post("zz-post-in", { description: "Its own description." }, { categories: { create: [{ categoryId: shown.id }, { categoryId: kept.id }] }, tagLinks: { create: [{ tagId: keptTag.id }] } });
    await post("zz-post-out", { noLlms: true });
    siteContent.invalidateSiteContent();

    section("Served: robots.txt, the sitemap and /llms.txt");
    const robots = (require("../src/app/robots") as typeof import("../src/app/robots")).default;
    const sitemap = (require("../src/app/sitemap") as typeof import("../src/app/sitemap")).default;
    const { GET: llmsGet } = require("../src/app/llms.txt/route") as typeof import("../src/app/llms.txt/route");
    const { resolveRobots } = require("next/dist/build/webpack/loaders/metadata/resolve-route-data") as { resolveRobots: (r: unknown) => string };
    const blockOf = (txt: string, agent: string) => txt.split(/\n\n/).find((g) => g.split("\n").some((l) => l.toLowerCase() === `user-agent: ${agent.toLowerCase()}`)) ?? "";
    const setPolicy = async (p: Partial<typeof base>) => {
      await policyLib.saveSearchPolicy({ ...base, ...p }, SCRIPT);
      siteContent.invalidateSiteContent();
    };
    await setPolicy({ llmsSummary: "Zz sells software." });
    at(ROOT);
    const openRobots = resolveRobots(await robots());
    ok("robots.txt as S-D2, naming the sitemap", /Allow: \//.test(blockOf(openRobots, "OAI-SearchBot")) && /Disallow: \/\n?$/.test(blockOf(openRobots, "GPTBot")) && openRobots.includes(`Sitemap: http://${ROOT}/sitemap.xml`));
    const mapped = (await sitemap()).map((e) => new URL(e.url).pathname);
    ok(
      "the sitemap: the listed and llms-less pages and both posts — not the noindex page, not the redirected one, not the kept-out archives",
      ["/zz-listed", "/zz-no-llms", "/blog/zz-post-in", "/blog/zz-post-out", "/blog/category/zz-shown"].every((p) => mapped.includes(p)) &&
        !["/zz-noindex", "/zz-moved", "/blog/category/zz-kept", "/blog/tag/zz-kept-tag"].some((p) => mapped.includes(p)),
      mapped.filter((p) => p.includes("zz")).join(" "),
    );
    const served = await llmsGet();
    const body = await served.text();
    ok("/llms.txt: 200, plain text", served.status === 200 && (served.headers.get("content-type") ?? "").startsWith("text/plain"), served.status);
    ok("  the site's name and the summary", body.startsWith(`# ${DEFAULT_SITE_SETTINGS.siteName}\n\n> Zz sells software.\n`), body.slice(0, 120));
    ok("  a listed page, its tokens filled", body.includes(`- [Zz listed](http://${ROOT}/zz-listed): Zz listed, about `) && !body.includes("{siteName}"));
    ok("  not a page left out of it, nor one kept out of search, nor one a redirect took over", !body.includes("/zz-no-llms") && !body.includes("/zz-noindex") && !body.includes("/zz-moved)"));
    ok("  a post with its own description; not one left out", body.includes(`- [Post zz-post-in](http://${ROOT}/blog/zz-post-in): Its own description.`) && !body.includes("zz-post-out"));
    ok("  the built-in signup page is not in it (it is noindex)", !body.includes("/signup"));
    await setPolicy({ llmsSummary: "" });
    const fallback = await (await llmsGet()).text();
    ok("an empty summary: the site's search description instead", fallback.split("\n")[2] === `> ${DEFAULT_SITE_SETTINGS.seo.description}`, fallback.split("\n")[2]);
    await setPolicy({ llmsTxt: false });
    ok("llms.txt switched off: not found", (await llmsGet()).status === 404);
    await setPolicy({});
    at(`admin.${ROOT}`);
    ok("on the console's host: not found", (await llmsGet()).status === 404);
    at(`zzsearch.${ROOT}`);
    ok("on a workspace's: not found, an empty sitemap, robots.txt closed", (await llmsGet()).status === 404 && (await sitemap()).length === 0 && !resolveRobots(await robots()).includes("Allow:"));

    await setPolicy({ hideSite: true, aiTraining: true });
    at(ROOT);
    const hiddenRobots = resolveRobots(await robots());
    ok("hidden: robots.txt names no sitemap and lets no AI crawler in", !hiddenRobots.includes("Sitemap") && ["OAI-SearchBot", "GPTBot", "ClaudeBot"].every((a) => /Disallow: \/\n?$/.test(blockOf(hiddenRobots, a))), hiddenRobots.slice(0, 200));
    ok("  search engines may still fetch pages", /Allow: \//.test(blockOf(hiddenRobots, "*")));
    ok("  the sitemap is empty, /llms.txt not found", (await sitemap()).length === 0 && (await llmsGet()).status === 404);

    section("The metadata");
    const meta = require("../src/lib/seo/metadata") as typeof import("../src/lib/seo/metadata");
    const ctx = { settings: DEFAULT_SITE_SETTINGS, trialDays: 14 };
    const pageSeo = { title: "T", description: "D" };
    ok("an indexable page names no robots at all — so the layout's applies", !("robots" in meta.buildPageMetadata({ slug: "zz", seo: pageSeo }, ctx)));
    ok("  one kept out of search, noindex", JSON.stringify(meta.buildPageMetadata({ slug: "zz", seo: { ...pageSeo, noindex: true } }, ctx).robots) === JSON.stringify({ index: false, follow: false }));
    const postSource = { title: "P", path: "/blog/p", excerpt: null, cover: null, publishedAt: new Date(), categories: [], tagLinks: [] };
    ok("a post the same", !("robots" in meta.buildPostMetadata({ ...postSource, seo: null })) && meta.buildPostMetadata({ ...postSource, seo: { noindex: true } }).robots !== undefined);
    const archiveView = meta.archiveSeoView({ noindex: true }, "Zz", null, null);
    ok(
      "an archive kept out of search: noindex; any other, no robots",
      archiveView.noindex === true &&
        JSON.stringify(meta.buildArchiveMetadata({ kind: "category", name: "Zz", page: 1, canonical: "/blog/category/zz", seo: archiveView }, DEFAULT_SITE_SETTINGS).robots) === JSON.stringify({ index: false, follow: false }) &&
        !("robots" in meta.buildArchiveMetadata({ kind: "tag", name: "Zz", page: 1, canonical: "/blog/tag/zz", seo: meta.archiveSeoView(null, "Zz", null, null) }, DEFAULT_SITE_SETTINGS)),
    );
    const extract = require("../src/lib/seo/extract") as typeof import("../src/lib/seo/extract");
    const util = require("../src/lib/seo/checks/util") as typeof import("../src/lib/seo/checks/util");
    const seoSite = extract.siteContextFrom(DEFAULT_SITE_SETTINGS, { trialDays: 14, signupOpen: false, origin: "https://zz.example", aiSearchCrawlersAllowed: true });
    const archiveInput = extract.inputFromArchive({ kind: "category", id: "zz", slug: "zz", name: "Zz", description: null, seo: { noindex: true }, image: null, posts: [], total: 0 }, seoSite, new Date());
    ok("  the SEO engine scores it as excluded, and points at its checkbox", util.isExcluded(archiveInput) && util.seoField(archiveInput, "noindex") === "seo.noindex");
    const pageView = require("../src/components/site/page-view") as typeof import("../src/components/site/page-view");
    at(ROOT);
    ok("hidden: the site's layout says noindex, which every page inherits", JSON.stringify((await pageView.siteLayoutMetadata()).robots) === JSON.stringify({ index: false, follow: false }));
    await setPolicy({});
    ok("  visible: the layout names no robots", (await pageView.siteLayoutMetadata()).robots === undefined);

    section("The proxy");
    const { NextRequest } = require("next/server") as typeof import("next/server");
    const proxy = (require("../src/proxy") as { default: (req: unknown, ctx: unknown) => Promise<Response> }).default;
    const through = async (pathAndQuery: string) => {
      const res = await proxy(new NextRequest(`http://${ROOT}${pathAndQuery}`, { headers: { host: ROOT, "user-agent": "Mozilla/5.0 (check:site-search)" } }), {});
      return { robots: res.headers.get("x-robots-tag") ?? "", rewrite: res.headers.get("x-middleware-rewrite") ?? "", next: res.headers.get("x-middleware-next") ?? "" };
    };
    const visible = await through("/pricing");
    ok("visible: the public site's pages may be indexed", visible.robots === "index, follow" && visible.rewrite.includes("/platform-site/pricing"), visible.robots);
    const llmsThrough = await through("/llms.txt");
    ok("/llms.txt is answered at the root, not looked for in the site's folder", llmsThrough.next === "1" && !llmsThrough.rewrite, JSON.stringify(llmsThrough));
    await setPolicy({ hideSite: true });
    const hiddenPricing = await through("/pricing");
    ok("hidden: every page keeps harden()'s noindex", /noindex/.test(hiddenPricing.robots) && hiddenPricing.rewrite.includes("/platform-site/pricing"), hiddenPricing.robots);
    process.env.PLATFORM_ENV = "staging";
    await setPolicy({});
    ok("  and on staging, whatever is stored", /noindex/.test((await through("/")).robots));
    process.env.PLATFORM_ENV = "";
    policyLib.invalidateSearchPolicy();
    ok("  production again: indexable", (await through("/")).robots === "index, follow");

    section("The CMS");
    const COOKIE = "deskzo-cms";
    const signedInAs = async (role: "ADMIN" | "EDITOR") => {
      const user = await control.cmsUser.upsert({ where: { email: `${role.toLowerCase()}.zz@example.invalid` }, create: { email: `${role.toLowerCase()}.zz@example.invalid`, name: `Zz ${role}`, role, createdBy: "script" }, update: {} });
      const token = randomBytes(32).toString("base64url");
      await control.cmsSession.create({ data: { id: sha256(token), userId: user.id, expiresAt: new Date(Date.now() + 3_600_000), lastSeenAt: new Date(), mfaAt: new Date() } });
      jar.clear();
      jar.set(COOKIE, token);
      at(CMS);
      return user;
    };
    const SearchScreen = (require("../src/app/platform-cms/(cms)/settings/search/page") as { default: Page }).default;
    const Dashboard = (require("../src/app/platform-cms/(cms)/page") as { default: Page }).default;
    const SeoScreen = (require("../src/app/platform-cms/(cms)/seo/page") as { default: Page }).default;
    const actions = require("../src/actions/cms/settings") as typeof import("../src/actions/cms/settings");

    await signedInAs("EDITOR");
    ok("an editor: Search & AI is 'not found', and saving is refused", (await thrown(() => renderPage(SearchScreen))) === "notFound" && !(await actions.cmsSaveSearchPolicy({ ...base, hideSite: true })).ok);
    ok("  nothing changed", !(await policyLib.searchPolicy()).hideSite);
    await signedInAs("ADMIN");
    const screen = textOf(await renderPage(SearchScreen));
    ok(
      "an admin sees the page: the two choices, the AI switches, llms.txt with the search description as its placeholder's source",
      ["Search & AI", "Visible in search", "Hidden from search", "Let AI search assistants read the site", "Let AI training crawlers read the site", "Publish llms.txt", "What crawlers read"].every((s) => screen.includes(s)),
      screen.slice(0, 300),
    );
    ok("  the tab is there for an admin", screen.includes("Search & AI") && screen.includes("Security"));
    const viaAction = await actions.cmsSaveSearchPolicy({ ...base, hideSite: true });
    ok("an admin's save is live", viaAction.ok && (await policyLib.searchPolicy()).hidden);
    const dash = textOf(await renderPage(Dashboard));
    const seoDash = textOf(await renderPage(SeoScreen));
    ok("hidden: the dashboard and SEO Intelligence say so", dash.includes("The website is hidden from search") && seoDash.includes("The website is hidden from search"));
    await actions.cmsSaveSearchPolicy({ ...base });
    ok("  and stop saying it once it isn't", !textOf(await renderPage(Dashboard)).includes("The website is hidden from search"));
    const activity = require("../src/components/cms/common/activity") as typeof import("../src/components/cms/common/activity");
    const row = await control.cmsAuditLog.findFirstOrThrow({ where: { action: "settings.search", actorId: { not: null } }, orderBy: { at: "desc" } });
    ok("the activity log in words, linking admins to the page", activity.actionLabel(row.action).label === "Changed the search & AI settings" && activity.entityHref(row, { canOpenUsers: true, canOpenSecurity: true }) === "/settings/search" && activity.entityHref(row, { canOpenUsers: false, canOpenSecurity: false }) === null);
  } finally {
    process.env.PLATFORM_ENV = "";
    if (cleanup) await cleanup().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM pg_database WHERE datname = '${controlName}'`);
    ok("the scratch control plane is dropped", Number(left[0].n) === 0);
    await admin.$disconnect();
  }

  console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll site search checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
