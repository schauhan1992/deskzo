/**
 * check:help-guides — Deskzo's Help Center (deskzo.com/help): one guide per module, on one outline,
 * naming only what exists, published from the website CMS and offered in the app's Help panel beside
 * — never mixed with — the company's own guides (src/lib/help/guides.ts).
 *
 * Over every guide draft in scripts/help-guides/ (what `npm run help:seed-guides` saves in the CMS for
 * staff to review):
 *
 *   · every module in MODULE_REGISTRY has a draft, named by its key, and none is for a module that
 *     isn't there; each at a help/<guide> address of its own, one per module;
 *   · each is a page the CMS would publish as it is (its validator in publish mode, and the Help
 *     Center's page rules): the outline's every section there;
 *   · it names only what exists — its module, its related guides, every permission it explains, any
 *     product it mentions, anything written like a permission key — and links only to guides there are;
 *   · it covers what gates and configures its module: its view permission, its menu section and every
 *     menu link's permission, and each of its settings screens in Settings;
 *   · the brand is the {siteName} token, never typed.
 *
 * Without a database, the rules themselves — each proved to refuse what it must:
 *
 *   · what a guide may name, and which pages may hold one (a guide only under help/, one to a page,
 *     no second title; the index only on /help); help/<guide> addresses allowed under the built-in
 *     /help and nothing deeper; /help itself never redirected, an old guide's address still can be;
 *   · which products include a module — every word from products.ts and modules.ts;
 *   · the page for a route in the app: every menu link and settings screen to its own module, and every
 *     section of the app to a module or to nothing on purpose;
 *   · the guide as the site draws it (the outline's headings in order, the permission's own names, the
 *     products), the Help Center's groups, what search engines and llms.txt are given;
 *   · the app's Help panel: the page's guide and the guides found by a search inside Deskzo's group
 *     only, the company's group as it was; a workspace given only its plan's modules' guides; the
 *     control plane failing or slow is nothing shown, never a throw.
 *
 *   npm run check:help-guides
 *   npm run check:help-guides -- --only leads,orders     just these drafts, and not "every module has one" (the rest still runs)
 */
import "dotenv/config";
import Module from "node:module";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Entitlements } from "../src/lib/entitlements";
import { checkPageDocument, pageSlugProblem } from "../src/lib/cms/validate";
import { reservedSource } from "../src/lib/cms/redirect-rules";
import { MODULE_REGISTRY, getModuleDefinition } from "../src/lib/modules";
import { getPermissionDefinition } from "../src/lib/permissions";
import { ADD_ONS, PRODUCT_FAMILY, PRODUCTS } from "../src/lib/products";
import {
  EXTRA_GUIDE_ROUTES,
  GUIDE_SECTIONS,
  NO_GUIDE_ROUTES,
  expectedGuidePermissions,
  expectedGuideSettings,
  guideCoversSetting,
  guidePageIssues,
  guideTexts,
  isGuideSlug,
  moduleAvailability,
  moduleForPath,
} from "../src/lib/help/guides";
import { guideDocument, loadGuides, type LoadedGuide } from "./help-guides";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";

// ─── Output ──────────────────────────────────────────────────────────────────────────────────────
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  const said = typeof detail === "string" ? detail : JSON.stringify(detail);
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${String(said).slice(0, 1500)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
async function part(title: string, work: () => Promise<void> | void) {
  section(title);
  try {
    await work();
  } catch (err) {
    ok("the section ran to its end", false, err instanceof Error ? `${err.message}\n${err.stack?.split("\n").slice(1, 5).join("\n")}` : String(err));
  }
}

const args = process.argv.slice(2);
const onlyArg = args.indexOf("--only") >= 0 ? args[args.indexOf("--only") + 1] : undefined;
const only = onlyArg ? onlyArg.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

// ─── Stand-ins for what a request has (the app's Help panel and actions load through these) ──────
// Installed before any app module that reaches them is required — a static import above would load
// the real ones first (memory: suite stubs miss a suite's own top-of-file imports).
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
class UnauthorizedError extends Error {}
const stubs = {
  "next/headers": { headers: async () => new Headers({ host: "acme.localhost:3000" }), cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {} }) },
  "next/cache": { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn },
  "next/navigation": {
    notFound: () => {
      throw new Error("notFound");
    },
    redirect: (to: string) => {
      throw new Error(`redirect ${to}`);
    },
    useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
    usePathname: () => "/leads",
    useSearchParams: () => new URLSearchParams(),
  },
  "@/lib/session": { requireUser: async () => ({ id: "u1", name: "Check", email: "check@acme.example", role: "ADMIN" }), currentUser: async () => null, viewAsContext: async () => null, UnauthorizedError },
  "@/lib/auth": { auth: async () => null, signIn: async () => {}, signOut: async () => {} },
} as const;
const byFile = new Map<string, unknown>([
  [load.resolve("next/headers"), stubs["next/headers"]],
  [load.resolve("next/cache"), stubs["next/cache"]],
  [load.resolve("next/navigation"), stubs["next/navigation"]],
  [load.resolve("../src/lib/session"), stubs["@/lib/session"]],
  [load.resolve("../src/lib/auth"), stubs["@/lib/auth"]],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request in stubs) return stubs[request as keyof typeof stubs];
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
  return realLoad.call(this, request, parent, isMain);
} as typeof realLoad;

const markup = (el: unknown) => renderToStaticMarkup(el as ReactElement);
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");
const tagTexts = (html: string, tag: string) => [...html.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => textOf(m[1]!).trim());
/** One source's group of the rail's Help panel — `data-source` marks them (rail-help.tsx). */
const group = (html: string, source: "deskzo" | "company") => html.match(new RegExp(`<section[^>]*data-source="${source}"[\\s\\S]*?</section>`))?.[0] ?? "";
const entitlements = (modules: string[]): Entitlements => ({ v: 1, all: false, modules, seats: null, copilotTokens: null, customDomains: null, plans: [] }) as Entitlements;

/** Literal brand words a draft must not type: the site writes its name through {siteName}. */
const BRAND = /\bDeskzo\b/;

/** What the drafts' own rules find wrong with one guide, as "path: message" lines. */
function draftProblems({ file, guide }: LoadedGuide, slugs: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const g = guide.guide;
  if (file !== g.module) problems.push(`file: named ${file}.ts but is the guide for "${g.module}"`);
  if (!isGuideSlug(guide.slug)) problems.push(`slug: "${guide.slug}" isn't help/<guide>`);
  const slugProblem = pageSlugProblem(guide.slug);
  if (slugProblem) problems.push(`slug: ${slugProblem}`);
  const document = guideDocument(guide);
  const checked = checkPageDocument(document, "publish");
  if (!checked.ok) for (const i of checked.issues) problems.push(`${i.path}: ${i.message}`);
  for (const i of guidePageIssues(guide.slug, document.blocks)) problems.push(`${i.path}: ${i.message}`);
  const explained = new Set(g.permissions.map((p) => p.key));
  for (const key of expectedGuidePermissions(g.module)) {
    if (!explained.has(key)) problems.push(`permissions: "${getPermissionDefinition(key)?.label ?? key}" (${key}) gates this module and isn't explained`);
  }
  for (const item of expectedGuideSettings(g.module)) {
    if (!guideCoversSetting(g.settings, item)) problems.push(`settings: "${item.label}" (${item.href}) configures this module and isn't explained`);
  }
  for (const { path, text, hrefs } of guideTexts(g)) {
    if (BRAND.test(text)) problems.push(`${path}: types the brand — write {siteName}`);
    for (const href of hrefs) {
      if (href.startsWith("/help/") && !slugs.has(href.slice(1).split(/[?#]/)[0]!)) problems.push(`${path}: links to ${href}, which is no guide`);
    }
  }
  for (const text of [guide.title, guide.seo.title, guide.seo.description, ...guide.seo.keywords]) {
    if (BRAND.test(text)) problems.push(`seo: types the brand — write {siteName}`);
  }
  return problems;
}

/** A guide the rules can be tried on: a real draft, with one thing changed. */
const withGuide = (base: LoadedGuide, change: (g: LoadedGuide["guide"]["guide"]) => void) => {
  const copy = structuredClone(base);
  change(copy.guide.guide);
  return copy;
};

async function main() {
  const all = await loadGuides();
  const loaded = only ? all.filter((l) => only.includes(l.file)) : all;
  const slugs = new Set(all.map((l) => l.guide.slug));
  const example = all.find((l) => l.file === "notes") ?? all[0];
  if (!example) throw new Error("No guide drafts in scripts/help-guides/.");

  await part("Every module has its guide", () => {
    if (only) {
      console.log("  (skipped with --only)");
      return;
    }
    const files = new Set(all.map((l) => l.file));
    const missing = MODULE_REGISTRY.map((m) => m.key).filter((k) => !files.has(k));
    ok(`a draft for each of the ${MODULE_REGISTRY.length} modules in MODULE_REGISTRY`, missing.length === 0, `missing: ${missing.join(", ")}`);
    const strays = [...files].filter((f) => !getModuleDefinition(f));
    ok("no draft for a module that isn't there", strays.length === 0, strays);
    const bySlug = new Map<string, string[]>();
    for (const l of all) bySlug.set(l.guide.slug, [...(bySlug.get(l.guide.slug) ?? []), l.file]);
    const shared = [...bySlug.entries()].filter(([, f]) => f.length > 1);
    ok("each at an address of its own", shared.length === 0, shared);
    const byModule = new Map<string, number>();
    for (const l of all) byModule.set(l.guide.guide.module, (byModule.get(l.guide.guide.module) ?? 0) + 1);
    ok("one guide per module", [...byModule.values()].every((n) => n === 1), [...byModule.entries()].filter(([, n]) => n > 1));
  });

  await part("Each draft: the outline, what it names, what it covers", () => {
    for (const l of loaded) {
      const problems = draftProblems(l, slugs);
      ok(`${l.file} (${l.guide.slug})`, problems.length === 0, problems.join("\n        "));
    }
  });

  await part("The checks themselves catch what they must (on a copy of a real draft)", () => {
    const fails = (label: string, changed: LoadedGuide, needle: RegExp) => {
      const problems = draftProblems(changed, slugs);
      ok(label, problems.some((p) => needle.test(p)), problems);
    };
    fails("a module that isn't there", withGuide(example, (g) => (g.module = "teleport")), /no module "teleport"/);
    fails("a permission that isn't there", withGuide(example, (g) => g.permissions.push({ key: "notes.teleport", text: "x" })), /no permission "notes.teleport"/);
    fails("a permission explained twice", withGuide(example, (g) => g.permissions.push({ ...g.permissions[0]! })), /explained twice/);
    fails("a related guide that isn't there", withGuide(example, (g) => (g.related = ["teleport"])), /related\[0\].*no module/);
    fails("a guide sending readers on to itself", withGuide(example, (g) => (g.related = [g.module])), /to itself/);
    fails("a product that isn't one (“{siteName} Automate”)", withGuide(example, (g) => g.purpose.push({ type: "paragraph", text: "Try {siteName} Automate." })), /no product called "Deskzo Automate"/);
    fails("the brand typed", withGuide(example, (g) => g.purpose.push({ type: "paragraph", text: "Deskzo keeps it." })), /types the brand/);
    fails("a permission key written in the text that isn't one", withGuide(example, (g) => g.purpose.push({ type: "paragraph", text: "Needs leads.teleport first." })), /no permission "leads.teleport"/);
    fails("a link to a guide there isn't", withGuide(example, (g) => g.purpose.push({ type: "paragraph", text: [{ text: "See ", href: "/help/teleport" }] })), /no guide/);
    fails("a section left empty (no tasks)", withGuide(example, (g) => (g.tasks = [])), /tasks/);
    fails("a section left empty (no questions)", withGuide(example, (g) => (g.faq = [])), /faq/);
    fails("the module's menu section not explained", withGuide(example, (g) => (g.permissions = g.permissions.filter((p) => !p.key.startsWith("section.")))), /gates this module/);
    const settingsModule = all.find((l) => expectedGuideSettings(l.guide.guide.module).length > 0);
    if (settingsModule) fails(`a settings screen not explained (${settingsModule.file})`, withGuide(settingsModule, (g) => (g.settings = [])), /configures this module/);
    const ok1 = draftProblems(withGuide(example, (g) => g.purpose.push({ type: "paragraph", text: "It comes with {siteName} One." })), slugs);
    ok("a product that is one (“{siteName} One”) passes", !ok1.some((p) => /product/.test(p)), ok1);
  });

  await part("Which pages may hold a guide", () => {
    const doc = guideDocument(example.guide);
    ok("a guide under help/ passes", guidePageIssues(example.guide.slug, doc.blocks).length === 0, guidePageIssues(example.guide.slug, doc.blocks));
    ok("a guide on any other page is refused", guidePageIssues("about", doc.blocks).some((i) => /under help\//.test(i.message)));
    ok("a page under help/ without a guide is refused", guidePageIssues("help/x", [{ id: "t", type: "richText", props: {} }]).some((i) => /add the Module guide block/.test(i.message)));
    ok("two guides to a page are refused", guidePageIssues("help/x", [...doc.blocks, { ...doc.blocks[0]!, id: "two" }]).some((i) => /One module guide/.test(i.message)));
    ok("a page header beside a guide is refused", guidePageIssues("help/x", [{ id: "h", type: "pageHeader", props: { heading: "x" } }, ...doc.blocks]).some((i) => /main title/.test(i.message)));
    ok("the index on another page is refused", guidePageIssues("pricing", [{ id: "i", type: "helpIndex", props: {} }]).some((i) => /Help Center page/.test(i.message)));
    ok("the index on /help passes", guidePageIssues("help", [{ id: "i", type: "helpIndex", props: {} }]).length === 0);
    ok("help/<guide> is an address a page may have", pageSlugProblem("help/leads") === null, pageSlugProblem("help/leads"));
    ok("help itself is the built-in page's", /own pages/.test(pageSlugProblem("help") ?? ""), pageSlugProblem("help"));
    ok("nothing deeper than help/<guide>", /help\/ and one more part/.test(pageSlugProblem("help/leads/more") ?? ""), pageSlugProblem("help/leads/more"));
    ok("pages under the other built-in pages are still refused", /can't go under \/pricing/.test(pageSlugProblem("pricing/x") ?? ""), pageSlugProblem("pricing/x"));
    ok("/help can't be redirected away", reservedSource("/help") !== null && reservedSource("/help/*") !== null);
    ok("an old guide's address can still be sent on", reservedSource("/help/old-guide") === null, reservedSource("/help/old-guide"));
  });

  await part("Which products include a module — from products.ts and modules.ts", () => {
    const placed = MODULE_REGISTRY.filter((m) => {
      const a = moduleAvailability(m.key);
      return a && (a.everywhere || a.products.length > 0 || a.addOn);
    });
    ok("every module is in a product, every product, or an add-on", placed.length === MODULE_REGISTRY.length, MODULE_REGISTRY.filter((m) => !placed.includes(m)).map((m) => m.key));
    const one = PRODUCTS.find((p) => p.modules.length === 0)!;
    const crm = moduleAvailability("calls")!;
    ok("a product's module lists the products that hold it, and the suite last", crm.products.map((p) => p.key).join(",") === [...PRODUCTS.filter((p) => p.modules.includes("calls")).map((p) => p.key), one.key].join(","), crm.products.map((p) => p.key));
    const addOn = moduleAvailability("revenue_close")!;
    const rc = ADD_ONS.find((a) => a.modules.includes("revenue_close"))!;
    ok("an add-on's module names the add-on, what it is bought on and what includes it", addOn.addOn?.addOn.key === rc.key && addOn.addOn.on?.key === rc.onProduct && addOn.addOn.includedIn.map((p) => p.key).join() === rc.includedIn.join() && addOn.products.length === 0);
    ok("a module sold in one country says so", moduleAvailability("accounting")!.countries.join() === "IN" && moduleAvailability("payroll")!.countries.join() === "IN");
    ok("a module every product has says so", moduleAvailability("notes")!.everywhere && moduleAvailability("companies")!.everywhere && !moduleAvailability("leads")!.everywhere);
    ok("a module that needs another names it", moduleAvailability("orders")!.requires.map((m) => m.key).join() === "items");
    ok("a key the registry doesn't have is nothing", moduleAvailability("teleport") === null);
  });

  await part("The page for a route in the app", () => {
    const wrong: string[] = [];
    for (const m of MODULE_REGISTRY) for (const item of m.navItems) if (moduleForPath(item.href) !== m.key) wrong.push(`${item.href} → ${moduleForPath(item.href)} (want ${m.key})`);
    ok("every menu link is its own module's", wrong.length === 0, wrong);
    ok("a record page under a menu link is that module's", moduleForPath("/leads/acme-1") === "leads" && moduleForPath("/orders/ord-12/edit") === "orders");
    ok("the longest link wins", moduleForPath("/accounting/revenue/waterfall") === "revenue_close" && moduleForPath("/accounting/journal") === "accounting" && moduleForPath("/people/payroll/run") === "payroll");
    ok("whole segments only", moduleForPath("/leadsx") === null && moduleForPath("/lead") === null);
    ok("a settings screen is the module it configures", moduleForPath("/settings/lead-assignment") === "leads" && moduleForPath("/settings/chat") === "chat");
    ok("the dashboard and Settings' own index belong to no module", moduleForPath("/dashboard") === null && moduleForPath("/settings") === null && moduleForPath("/settings/users") === null);
    ok("the query and a trailing slash don't matter", moduleForPath("/leads/?view=board") === "leads" && moduleForPath("/tickets#x") === "helpdesk");
    ok("not a path, nothing", moduleForPath(undefined) === null && moduleForPath("leads") === null && moduleForPath(42) === null);
    const extraWrong = Object.entries(EXTRA_GUIDE_ROUTES).filter(([, key]) => !getModuleDefinition(key));
    ok("the extra routes name modules there are", extraWrong.length === 0, extraWrong);
    const dashboard = path.join(__dirname, "..", "src", "app", "(dashboard)");
    const sections = readdirSync(dashboard).filter((d) => !d.startsWith("[") && !d.startsWith("(") && statSync(path.join(dashboard, d)).isDirectory());
    const missingDirs = Object.keys(EXTRA_GUIDE_ROUTES).filter((r) => !sections.includes(r.slice(1)));
    ok("the extra routes are sections the app has", missingDirs.length === 0, missingDirs);
    const orphans = sections.filter((d) => moduleForPath(`/${d}`) === null && !NO_GUIDE_ROUTES.includes(`/${d}`));
    ok(`every section of the app (${sections.length}) has its module's guide, or none on purpose`, orphans.length === 0, orphans);
  });

  // The site's own blocks, loaded after the stand-ins.
  const { HelpGuideView } = load("../src/components/site/blocks/help-guide-view") as typeof import("../src/components/site/blocks/help-guide-view");
  const { helpIndexGroups } = load("../src/components/site/blocks/help-index") as typeof import("../src/components/site/blocks/help-index");
  const { DEFAULT_SITE_SETTINGS, DEFAULT_SITE_PAGES } = load("../src/components/site/defaults") as typeof import("../src/components/site/defaults");
  const ctx = { settings: DEFAULT_SITE_SETTINGS, signupOpen: true, trialDays: 14, searchParams: {}, workspaceSuffix: ".localhost" };

  await part("The guide as the site draws it", () => {
    const headings = GUIDE_SECTIONS.map((s) => s.heading);
    const bad: string[] = [];
    for (const l of loaded) {
      const g = l.guide.guide;
      const html = markup(createElement(HelpGuideView, { props: g, ctx, related: [] }));
      const text = textOf(html);
      const h1 = tagTexts(html, "h1");
      const h2 = tagTexts(html, "h2");
      const a = moduleAvailability(g.module)!;
      const productsShown = a.everywhere ? text.includes(`Every ${PRODUCT_FAMILY} product comes with it`) : a.addOn ? text.includes(a.addOn.addOn.name) : a.products.every((p) => text.includes(p.name));
      const permsShown = g.permissions.every((p) => text.includes(getPermissionDefinition(p.key)!.label));
      const problems = [
        h1.length === 1 && h1[0] === textOf(g.heading.replace(/\{siteName\}/g, DEFAULT_SITE_SETTINGS.siteName)).trim() ? "" : `h1: ${JSON.stringify(h1)}`,
        JSON.stringify(h2) === JSON.stringify(headings) ? "" : `h2s: ${JSON.stringify(h2)}`,
        productsShown ? "" : "products",
        permsShown ? "" : "permission names",
        text.includes("{siteName}") ? "an unfilled {siteName}" : "",
        a.countries.length && !text.includes("only.") ? "the country" : "",
      ].filter(Boolean);
      if (problems.length) bad.push(`${l.file}: ${problems.join(", ")}`);
    }
    ok(`each draft (${loaded.length}): one h1, the outline's headings in order, the permissions' own names, its products`, bad.length === 0, bad);
    const withRelated = markup(createElement(HelpGuideView, { props: example.guide.guide, ctx, related: [{ slug: "help/tasks", path: "/help/tasks", title: "Tasks", summary: "To-dos." }] }));
    ok("a published related guide is linked under Read next", /<h2[^>]*>Read next<\/h2>/.test(withRelated) && withRelated.includes('href="/help/tasks"'));
    const noSettings = markup(createElement(HelpGuideView, { props: { ...example.guide.guide, settings: [] }, ctx, related: [] }));
    ok("a guide with no settings says so", textOf(noSettings).includes("no settings of its own"));
  });

  await part("The Help Center's index", () => {
    // One published guide per module in the registry — the index's rules, whatever drafts there are.
    const published = MODULE_REGISTRY.map((m) => ({ slug: `help/zz-${m.key.replace(/_/g, "-")}`, path: `/help/zz-${m.key.replace(/_/g, "-")}`, module: m.key, title: m.label, summary: m.description, words: "" }));
    const groups = helpIndexGroups(published, "In every product");
    ok("the modules every product has come first", groups[0]?.key === "everywhere" && groups[0].guides.every((g) => moduleAvailability(g.module)!.everywhere));
    const productOrder = groups.filter((g) => PRODUCTS.some((p) => p.key === g.key)).map((g) => g.key);
    ok("then each product, in products.ts's order, never the suite", productOrder.join() === PRODUCTS.filter((p) => productOrder.includes(p.key)).map((p) => p.key).join() && !productOrder.includes(PRODUCTS.find((p) => p.modules.length === 0)!.key));
    const listed = new Set(groups.flatMap((g) => g.guides.map((x) => x.module)));
    ok("every guide is somewhere, and none under More", published.every((p) => listed.has(p.module)) && !groups.some((g) => g.key === "more"), groups.map((g) => g.key));
    const shared = groups.filter((g) => g.guides.some((x) => x.module === "orders")).map((g) => g.key);
    ok("a module two products share is under both", shared.length === PRODUCTS.filter((p) => p.modules.includes("orders")).length, shared);
    ok("an add-on's module is under the add-on", groups.some((g) => g.key === "addon-revenue_close" && g.guides.some((x) => x.module === "revenue_close")));
    ok("each group's title is the product's own name", groups.filter((g) => PRODUCTS.some((p) => p.key === g.key)).every((g) => g.title === PRODUCTS.find((p) => p.key === g.key)!.name));
    const help = DEFAULT_SITE_PAGES.find((p) => p.slug === "help");
    ok("the Help Center is a built-in page with its index", !!help && help.blocks.some((b) => b.type === "helpIndex") && checkPageDocument({ title: help.title, seo: help.seo, blocks: help.blocks }, "publish").ok);
  });

  await part("What search engines and AI are given", () => {
    const { inputFromPage, siteContextFrom } = load("../src/lib/seo/extract") as typeof import("../src/lib/seo/extract");
    const { buildLlmsTxt } = load("../src/lib/seo/llms") as typeof import("../src/lib/seo/llms");
    const site = siteContextFrom(DEFAULT_SITE_SETTINGS, { trialDays: 14, signupOpen: true, aiSearchCrawlersAllowed: true } as Parameters<typeof siteContextFrom>[1]);
    const doc = guideDocument(example.guide);
    const input = inputFromPage({ slug: example.guide.slug, title: doc.title, seo: doc.seo, blocks: doc.blocks }, site, new Date());
    ok("a guide page has one h1, its heading", input.content.h1s.length === 1 && input.content.h1s[0] === example.guide.guide.heading, input.content.h1s);
    ok("its questions are read as questions and answers", input.content.faqs.length === example.guide.guide.faq.length && input.content.faqs.every((f) => f.question && f.answer));
    const h2 = input.content.headings.filter((h) => h.level === 2).map((h) => h.text);
    ok("its sections' headings are the outline's", GUIDE_SECTIONS.every((s) => h2.includes(s.heading)), h2);
    const llms = buildLlmsTxt({
      siteName: "Deskzo",
      summary: "",
      origin: "https://deskzo.example",
      nav: [],
      pages: [
        { path: "/", title: "Home", description: "" },
        { path: "/help/leads", title: "Leads", description: "The pipeline." },
        { path: "/pricing", title: "Pricing", description: "" },
        { path: "/help", title: "Help Center", description: "Every guide." },
      ],
      posts: [],
    });
    const helpSection = llms.split("## Help Center")[1] ?? "";
    ok("llms.txt lists the Help Center and its guides in a section of their own, the index first", /^\s*- \[Help Center\]\(https:\/\/deskzo\.example\/help\)/.test(helpSection) && helpSection.includes("/help/leads") && !(llms.split("## Help Center")[0] ?? "").includes("/help"), llms);
  });

  await part("The app's Help panel: the page's guide, in Deskzo's group only", async () => {
    const rail = load("../src/components/layout/rail-help") as typeof import("../src/components/layout/rail-help");
    const guide = { module: "leads", title: "Zz Leads guide", summary: "The pipeline.", url: "https://deskzo.example/help/leads", words: "Add a lead" };
    const other = { module: "orders", title: "Zz Orders guide", summary: "Punching orders.", url: "https://deskzo.example/help/orders", words: "" };
    const dz = { ok: true, links: [{ id: "dz1", kind: "ARTICLE" as const, title: "Zz Deskzo article", url: "https://deskzo.example/a", description: null, external: true, youtubeId: null }] };
    const co = [{ id: "co1", kind: "ARTICLE" as const, title: "Zz Company SOP", url: "/orders/new", description: null, external: false, youtubeId: null }];
    const panel = markup(createElement(rail.RailHelpView, { desk: null, deskzo: dz, company: co, guides: { ok: true, current: guide, guides: [guide, other], helpCenterUrl: "https://deskzo.example/help" }, canManage: false }));
    ok("the page's guide is in Deskzo's group, said to be this page's", group(panel, "deskzo").includes("The guide for this page") && group(panel, "deskzo").includes(guide.title) && group(panel, "deskzo").includes('data-guide="leads"'));
    ok("  and nowhere in the company's", !group(panel, "company").includes(guide.title) && !group(panel, "company").includes("data-guide"));
    ok("  which still holds its own guide, apart", group(panel, "company").includes("Zz Company SOP") && !group(panel, "deskzo").includes("Zz Company SOP"));
    ok("  with the Help Center a link away, in Deskzo's group", group(panel, "deskzo").includes("https://deskzo.example/help") && group(panel, "deskzo").includes("Every guide, in the Help Center"));
    ok("  and it opens in a new tab", /<a[^>]*href="https:\/\/deskzo\.example\/help\/leads"[^>]*target="_blank"/.test(panel));
    const noGuide = markup(createElement(rail.RailHelpView, { desk: null, deskzo: dz, company: co, guides: { ok: true, current: null, guides: [guide], helpCenterUrl: "https://deskzo.example/help" }, canManage: false }));
    ok("a page without a module of its own offers no page guide", !noGuide.includes("The guide for this page") && group(noGuide, "deskzo").includes("Zz Deskzo article"));
    const before = markup(createElement(rail.RailHelpView, { desk: null, deskzo: dz, company: co, canManage: false }));
    ok("without guides, the panel is as it was", !before.includes("data-guide") && !before.includes("Help Center") && group(before, "deskzo").includes("Zz Deskzo article"));
    const failed = markup(createElement(rail.RailHelpView, { desk: null, deskzo: { ok: false, links: [] }, company: co, guides: { ok: false, current: null, guides: [], helpCenterUrl: "" }, canManage: false }));
    ok("Deskzo's side unreachable says so in its own group, the company's untouched", group(failed, "deskzo").includes("couldn") && group(failed, "company").includes("Zz Company SOP"));
  });

  await part("A workspace is given the guides for its plan's modules", async () => {
    const hg = load("../src/lib/platform/help-guides") as typeof import("../src/lib/platform/help-guides");
    const rows = [
      { slug: "help/people-hr", module: "hr", heading: "People (HR)", summary: "HR.", words: "Leave" },
      { slug: "help/zz-hr", module: "hr", heading: "A second HR guide", summary: "", words: "" },
      { slug: "help/leads", module: "leads", heading: "Leads", summary: "", words: "" },
      { slug: "help/sticky-notes", module: "notes", heading: "Sticky Notes", summary: "", words: "" },
      { slug: "about/hr", module: "hr", heading: "Not a guide address", summary: "", words: "" },
      { slug: "help/no-heading", module: "tasks", heading: "", summary: "", words: "" },
    ];
    const kept = hg.publishedGuides(rows);
    ok("one per module, the first by address; only guide addresses with a heading", kept.map((r) => `${r.module}@${r.slug}`).join() === "leads@help/leads,hr@help/people-hr,notes@help/sticky-notes", kept);
    const hrOnly = { country: "IN", entitlements: entitlements(["hr"]), source: "control" as const };
    const given = hg.guidesForWorkspace(kept, hrOnly, "https://deskzo.example");
    ok("only the plan's modules (and the every-plan ones)", given.map((g) => g.module).sort().join() === "hr,notes", given.map((g) => g.module));
    ok("each a link to the Help Center", given.every((g) => g.url.startsWith("https://deskzo.example/help/")));
    ok("a workspace abroad isn't given an India-only module's guide", !hg.guidesForWorkspace([{ slug: "help/payroll", module: "payroll", heading: "Payroll", summary: "", words: "" }], { country: "US", entitlements: entitlements(["hr", "payroll"]) }, "x").length);
    const viaLoader = await hg.deskzoGuidesFor(hrOnly, Date.now(), async () => rows);
    ok("read through the loader: ok, and the same guides", viaLoader.ok && viaLoader.guides.map((g) => g.module).sort().join() === "hr,notes", viaLoader);
    const failing = await hg.deskzoGuidesFor(hrOnly, Date.now(), async () => {
      throw new Error("connection refused");
    });
    ok("a control plane that refuses: nothing, said as a failure, never thrown", !failing.ok && failing.guides.length === 0);
    const started = Date.now();
    const slow = await hg.deskzoGuidesFor(hrOnly, Date.now(), () => new Promise((resolve) => setTimeout(() => resolve(rows), 4000)));
    ok("one that doesn't answer: nothing within about 1.5 s", !slow.ok && Date.now() - started < 2500, Date.now() - started);
    const fromEnv = await hg.deskzoGuidesFor({ ...hrOnly, source: "env" as never }, Date.now(), async () => rows);
    ok("a workspace from the environment is given none, and nothing failed", fromEnv.ok && fromEnv.guides.length === 0);
  });

  console.log(`\n${passes} passed, ${failures} failed.`);
  if (failures) process.exitCode = 1;
  // The slow loader's timer and the database clients would keep the process alive.
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
