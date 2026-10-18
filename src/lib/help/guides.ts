import type { HelpGuideProps, RichInline, RichNode } from "@/components/site/blocks/types";
import { MODULE_REGISTRY, getModuleDefinition, navPermissionKeys, type ModuleDefinition } from "@/lib/modules";
import { getPermissionDefinition, isPermissionKey, PERMISSION_KEYS, sectionPermission } from "@/lib/permissions";
import { ADD_ONS, BASE_MODULES, PRODUCT_FAMILY, PRODUCTS, productByKey, type AddOn, type Product } from "@/lib/products";
import { SETTINGS, type SettingsItem } from "@/lib/settings/catalogue";

/**
 * Deskzo's Help Center: one guide per module, published on the public website at /help/<slug> from
 * the website CMS (cms.<domain>) — a guide is a CMS page whose address is under help/ and whose
 * content is one `helpGuide` block (src/components/site/blocks/types.ts HelpGuideProps). /help itself
 * is a built-in page with the `helpIndex` block, which lists every published guide.
 *
 * Guides are Deskzo's, never a workspace's (owner, 2 Oct 2026): written and published once on the
 * platform side, read-only everywhere. A workspace's own guides are its HelpLink rows, shown apart.
 *
 * Pure and client-safe: the CMS's editor, the site's blocks, the app's Help panel and check:help-guides
 * all read the same rules from here —
 *
 *   · the outline every guide follows (`GUIDE_SECTIONS`), whose headings the block writes itself;
 *   · where a module comes from (`moduleAvailability`) — read from src/lib/products.ts and
 *     src/lib/modules.ts, so a product's name is never typed into a guide;
 *   · what a guide may name (`guideReferenceIssues`): only modules, permissions and products that exist;
 *   · what a guide must cover (`expectedGuidePermissions`, `expectedGuideSettings`): the permissions
 *     that gate its module and the settings that configure it, so a guide falls behind the code loudly.
 */

/** The Help Center's own address on the site. */
export const HELP_PATH = "/help";
/** A guide's address is help/<one segment>: "help/leads". */
export const GUIDE_SLUG = /^help\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const GUIDE_SLUG_MAX = 120;

export function isGuideSlug(slug: unknown): slug is string {
  return typeof slug === "string" && slug.length <= GUIDE_SLUG_MAX && GUIDE_SLUG.test(slug);
}

/** A guide page's path on the site, from its slug: "help/leads" → "/help/leads". */
export const guidePath = (slug: string) => `/${slug}`;

/**
 * The outline, in order. The block writes these headings itself, so every guide reads the same way;
 * the last is never written by anybody — it is read from the product list.
 */
export const GUIDE_SECTIONS = [
  { key: "purpose", heading: "What it's for", anchor: "what-its-for" },
  { key: "access", heading: "Who can use it", anchor: "who-can-use-it" },
  { key: "setup", heading: "Setting it up", anchor: "setting-it-up" },
  { key: "tasks", heading: "Everyday tasks", anchor: "everyday-tasks" },
  { key: "settings", heading: "Settings", anchor: "settings" },
  { key: "faq", heading: "Questions and troubleshooting", anchor: "questions" },
  { key: "products", heading: "Which products include it", anchor: "products" },
] as const;

export type GuideSectionKey = (typeof GUIDE_SECTIONS)[number]["key"];

/** The modules every guide may be about: every key in the registry. */
export const GUIDE_MODULE_KEYS: readonly string[] = MODULE_REGISTRY.map((m) => m.key);

// ─── Where a module comes from ───────────────────────────────────────────────────────────────────

export type ModuleAvailability = {
  module: ModuleDefinition;
  /** Comes with every product: the workspace's own furniture (BASE_MODULES), a core module, or one in every plan. */
  everywhere: boolean;
  /** The products that list it, in products.ts's order — Deskzo One last, since it holds everything. Empty for an add-on's module. */
  products: Product[];
  /** The add-on that sells it, when one does, with the product it is bought on and the ones that already include it. */
  addOn: { addOn: AddOn; on: Product | null; includedIn: Product[] } | null;
  /** Sold only in these countries (ISO 3166-1 alpha-2): the module's own limit, else every product's that holds it. Empty: everywhere. */
  countries: readonly string[];
  /** Modules it can't work without, which come with it. */
  requires: ModuleDefinition[];
};

const suite = () => PRODUCTS.find((p) => p.modules.length === 0) ?? productByKey("one");

/** Where this module is sold, read only from products.ts and modules.ts. Null for a key the registry doesn't have. */
export function moduleAvailability(key: string): ModuleAvailability | null {
  const def = getModuleDefinition(key);
  if (!def) return null;
  const everywhere = def.core === true || def.inEveryPlan === true || BASE_MODULES.includes(key);
  const addOn = ADD_ONS.find((a) => a.modules.includes(key)) ?? null;
  const listing = PRODUCTS.filter((p) => p.modules.length > 0 && p.modules.includes(key));
  const one = suite();
  const products = addOn && listing.length === 0 ? [] : [...listing, ...(one ? [one] : [])];
  // A product sold in one country makes its modules that country's too — unless another product sells them everywhere.
  const productCountries = listing.length > 0 && listing.every((p) => p.soldOnlyIn?.length) ? [...new Set(listing.flatMap((p) => p.soldOnlyIn ?? []))] : [];
  const countries = def.countries?.length ? def.countries : productCountries;
  return {
    module: def,
    everywhere,
    products,
    addOn: addOn
      ? {
          addOn,
          on: addOn.onProduct ? productByKey(addOn.onProduct) : null,
          includedIn: addOn.includedIn.map((k) => productByKey(k)).filter((p): p is Product => !!p),
        }
      : null,
    countries,
    requires: (def.requires ?? []).map((k) => getModuleDefinition(k)).filter((m): m is ModuleDefinition => !!m),
  };
}

// ─── What a guide must cover ─────────────────────────────────────────────────────────────────────

/**
 * The permissions a module's guide must explain: the one that shows its records at all
 * (`viewPermission`), the one that shows its section in the menu, and every one its menu links are
 * gated on. A guide may explain more; it may not leave these out.
 */
export function expectedGuidePermissions(moduleKey: string): string[] {
  const def = getModuleDefinition(moduleKey);
  if (!def) return [];
  const keys = new Set<string>();
  if (def.viewPermission) keys.add(def.viewPermission);
  const section = sectionPermission(moduleKey);
  if (isPermissionKey(section)) keys.add(section);
  for (const item of def.navItems) for (const k of navPermissionKeys(item)) keys.add(k);
  return [...keys].filter((k) => isPermissionKey(k));
}

const modulesOfSetting = (item: SettingsItem): readonly string[] => (item.module === undefined ? [] : typeof item.module === "string" ? [item.module] : item.module);

/** The settings screens (src/lib/settings/catalogue.ts) that configure this module: each must be explained in its guide's Settings. */
export function expectedGuideSettings(moduleKey: string): SettingsItem[] {
  return SETTINGS.flatMap((section) => section.groups.flatMap((group) => group.items)).filter((item) => modulesOfSetting(item).includes(moduleKey));
}

/**
 * Whether a guide's Settings section covers this settings screen: an entry names it by its label, in its name or
 * its "where". A guide writes the brand as {siteName}, which a label like "Deskzo app" says as the family's name.
 */
export function guideCoversSetting(settings: HelpGuideProps["settings"] | undefined, item: Pick<SettingsItem, "label">): boolean {
  const label = item.label.toLowerCase();
  return (settings ?? []).some((s) => `${s.name ?? ""} ${s.where ?? ""}`.replace(/\{siteName\}/g, PRODUCT_FAMILY).toLowerCase().includes(label));
}

// ─── What a guide may name ───────────────────────────────────────────────────────────────────────

export type GuideIssue = { path: string; message: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Plain text of a run of rich text. */
export function inlineText(value: RichInline | undefined): string {
  if (typeof value === "string") return value;
  return arr<{ text?: unknown }>(value)
    .map((s) => (isObj(s) && typeof s.text === "string" ? s.text : ""))
    .join("");
}

/** Every piece of text in rich content, each with its path — for the checks below. */
export function richTexts(nodes: unknown, path: string): { path: string; text: string; hrefs: string[] }[] {
  const out: { path: string; text: string; hrefs: string[] }[] = [];
  const hrefsOf = (v: unknown) =>
    typeof v === "string"
      ? []
      : arr(v)
          .map((s) => (isObj(s) && typeof s.href === "string" ? s.href : ""))
          .filter(Boolean);
  arr<RichNode>(nodes).forEach((node, i) => {
    const p = `${path}[${i}]`;
    if (!isObj(node)) return;
    const n = node as Record<string, unknown>;
    if (n.type === "heading") out.push({ path: p, text: String(n.text ?? ""), hrefs: [] });
    else if (n.type === "paragraph" || n.type === "note") out.push({ path: p, text: inlineText(n.text as RichInline), hrefs: hrefsOf(n.text) });
    else if (n.type === "list") arr<RichInline>(n.items).forEach((item, j) => out.push({ path: `${p}.items[${j}]`, text: inlineText(item), hrefs: hrefsOf(item) }));
    else if (n.type === "table") {
      out.push({ path: `${p}.columns`, text: arr(n.columns).map(String).join(" "), hrefs: [] });
      arr<RichInline[]>(n.rows).forEach((row, j) => arr<RichInline>(row).forEach((cell, k) => out.push({ path: `${p}.rows[${j}][${k}]`, text: inlineText(cell), hrefs: hrefsOf(cell) })));
    }
  });
  return out;
}

/** Every piece of text in a guide's props, with its path ("purpose[2]", "tasks[0].title"…). */
export function guideTexts(props: unknown): { path: string; text: string; hrefs: string[] }[] {
  if (!isObj(props)) return [];
  const p = props as Partial<HelpGuideProps>;
  const plain = (path: string, text: unknown) => (typeof text === "string" ? [{ path, text, hrefs: [] }] : []);
  return [
    ...plain("heading", p.heading),
    ...plain("summary", p.summary),
    ...richTexts(p.purpose, "purpose"),
    ...richTexts(p.access, "access"),
    ...arr<{ text?: unknown }>(p.permissions).flatMap((perm, i) => plain(`permissions[${i}].text`, isObj(perm) ? perm.text : undefined)),
    ...richTexts(p.setup, "setup"),
    ...arr<Record<string, unknown>>(p.tasks).flatMap((t, i) => (isObj(t) ? [...plain(`tasks[${i}].title`, t.title), ...richTexts(t.body, `tasks[${i}].body`)] : [])),
    ...arr<Record<string, unknown>>(p.settings).flatMap((s, i) =>
      isObj(s) ? [...plain(`settings[${i}].name`, s.name), ...plain(`settings[${i}].where`, s.where), ...richTexts(s.body, `settings[${i}].body`)] : [],
    ),
    ...arr<Record<string, unknown>>(p.faq).flatMap((q, i) => (isObj(q) ? [...plain(`faq[${i}].question`, q.question), ...richTexts(q.answer, `faq[${i}].answer`)] : [])),
  ];
}

/** Every product and add-on name, and the family's own name ("Deskzo") — what a mention "Deskzo X" may be. */
const PRODUCT_NAMES = new Set([...PRODUCTS.map((p) => p.name), ...ADD_ONS.map((a) => `${PRODUCT_FAMILY} ${a.name}`)]);
/** "Deskzo Books", "{siteName} Books": the family's name or the site's token, then a capitalised word. */
const PRODUCT_MENTION = new RegExp(`(?:\\b${PRODUCT_FAMILY}|\\{siteName\\})\\s+([A-Z][A-Za-z]+)`, "g");
/** "Deskzo Revenue" for the add-on "Revenue & Close" is a name somebody would type: an add-on's first word counts. */
const ADD_ON_FIRST_WORDS = new Set(ADD_ONS.map((a) => `${PRODUCT_FAMILY} ${a.name.split(/\s+/)[0]}`));
/** The rest of each add-on's name, by its first word: "Automate" → " Plus". */
const ADD_ON_RESTS = new Map<string, string[]>();
for (const a of ADD_ONS) {
  const [first, ...rest] = a.name.split(/\s+/);
  if (first && rest.length) ADD_ON_RESTS.set(first, [...(ADD_ON_RESTS.get(first) ?? []), ` ${rest.join(" ")}`]);
}
/** A module's own name: "Deskzo Automate" isn't the add-on Automate Plus cut short — it needs its whole name. */
const MODULE_LABELS = new Set(MODULE_REGISTRY.map((m) => m.label));
/** A word that may follow "{siteName}" without naming a product: a sentence going on ("{siteName} Help Center"…). */
const NOT_A_PRODUCT = new Set(["Help"]);
/** "leads.view": a lower-case namespace, a dot, a camel-case verb — how every permission key is written. */
const KEY_LIKE = /\b([a-z]+)\.([a-z][A-Za-z]+)\b/g;
/** The part of every permission key before its dot — only a word with one of these is read as a key. */
const PERMISSION_NAMESPACES = new Set(PERMISSION_KEYS.map((key) => key.split(".")[0]!));

/**
 * What a guide names that doesn't exist — each with the path to it, in the block's props:
 *
 *   · its module, and every guide it sends readers on to (`related`), must be modules in the registry
 *     (and not itself, nor twice);
 *   · every permission it explains must be a key in src/lib/permissions.ts, once each;
 *   · a product it mentions — "Deskzo X" or "{siteName} X" — must be a product or add-on in
 *     src/lib/products.ts: there is no "Deskzo Automate" to buy;
 *   · something written like a permission key ("leads.view") in its text must be one.
 *
 * Pure: the CMS refuses a guide page with any of these (src/lib/cms/content.ts), and check:help-guides
 * runs it over every draft in the repository.
 */
export function guideReferenceIssues(props: unknown): GuideIssue[] {
  const issues: GuideIssue[] = [];
  if (!isObj(props)) return [{ path: "", message: "Not a guide." }];
  const p = props as Partial<HelpGuideProps>;
  const own = typeof p.module === "string" ? p.module : "";
  if (!own) issues.push({ path: "module", message: "Choose the module this guide is for." });
  else if (!getModuleDefinition(own)) issues.push({ path: "module", message: `There's no module "${own}".` });

  const seenPerm = new Set<string>();
  arr<{ key?: unknown }>(p.permissions).forEach((perm, i) => {
    const key = isObj(perm) && typeof perm.key === "string" ? perm.key : "";
    if (!key) return;
    if (!isPermissionKey(key)) issues.push({ path: `permissions[${i}].key`, message: `There's no permission "${key}".` });
    else if (seenPerm.has(key)) issues.push({ path: `permissions[${i}].key`, message: `"${getPermissionDefinition(key)?.label ?? key}" is explained twice.` });
    seenPerm.add(key);
  });

  const seenRelated = new Set<string>();
  arr(p.related).forEach((key, i) => {
    if (typeof key !== "string" || !key) return;
    if (!getModuleDefinition(key)) issues.push({ path: `related[${i}]`, message: `There's no module "${key}".` });
    else if (key === own) issues.push({ path: `related[${i}]`, message: "A guide doesn't send readers on to itself." });
    else if (seenRelated.has(key)) issues.push({ path: `related[${i}]`, message: "That guide is listed twice." });
    seenRelated.add(key);
  });

  for (const { path, text } of guideTexts(p)) {
    for (const m of text.matchAll(PRODUCT_MENTION)) {
      const word = m[1]!;
      if (NOT_A_PRODUCT.has(word)) continue;
      const name = `${PRODUCT_FAMILY} ${word}`;
      const after = text.slice((m.index ?? 0) + m[0].length);
      const wholeAddOn = (ADD_ON_RESTS.get(word) ?? []).some((rest) => after.startsWith(rest));
      const shortAddOn = ADD_ON_FIRST_WORDS.has(name) && !MODULE_LABELS.has(word);
      if (!PRODUCT_NAMES.has(name) && !wholeAddOn && !shortAddOn) issues.push({ path, message: `There's no product called "${name}" — the products are in the list under "Which products include it".` });
    }
    for (const m of text.matchAll(KEY_LIKE)) {
      if (!PERMISSION_NAMESPACES.has(m[1]!)) continue;
      const key = `${m[1]}.${m[2]}`;
      if (!isPermissionKey(key)) issues.push({ path, message: `There's no permission "${key}".` });
    }
  }
  return issues;
}

// ─── Which pages may hold a guide ────────────────────────────────────────────────────────────────

/** An issue on a page, as the CMS shows one beside its field (src/lib/cms/types.ts CmsIssue). */
export type GuidePageIssue = { path: string; message: string; blockId?: string };

/** The Help Center's own page, which the index block is for. */
const HELP_PAGE_SLUG = HELP_PATH.slice(1);
/** Blocks that are a page's main title — a guide's heading is its page's. */
const PAGE_TOP_BLOCKS = new Set(["hero", "pageHeader"]);

/**
 * What stops a page from being published as it is, in the Help Center's terms (the CMS's validator has
 * checked the shapes already):
 *
 *   · a module guide goes on a page under help/ and nowhere else, and a page under help/ is exactly one
 *     guide — its heading the page's main title, so no hero or page header beside it;
 *   · the Help Center's index goes on the Help Center page;
 *   · a guide names only what exists (`guideReferenceIssues`).
 *
 * Whether another published page already has the module's guide needs the database:
 * src/lib/cms/content.ts asks that on publishing. Pure.
 */
export function guidePageIssues(slug: string, blocks: readonly { id?: string; type?: unknown; props?: unknown }[]): GuidePageIssue[] {
  const issues: GuidePageIssue[] = [];
  const list = Array.isArray(blocks) ? blocks : [];
  const at = (i: number) => (typeof list[i]?.id === "string" ? { blockId: list[i]!.id as string } : {});
  const guides = list.map((b, i) => ({ b, i })).filter(({ b }) => b?.type === "helpGuide");
  list.forEach((b, i) => {
    if (b?.type === "helpIndex" && slug !== HELP_PAGE_SLUG) issues.push({ path: `blocks[${i}].type`, message: `The Help Center index goes on the Help Center page (${HELP_PATH}).`, ...at(i) });
  });
  if (!isGuideSlug(slug)) {
    for (const { i } of guides) issues.push({ path: `blocks[${i}].type`, message: "A module guide goes on a page under help/, like help/leads.", ...at(i) });
    return issues;
  }
  if (guides.length === 0) issues.push({ path: "blocks", message: "A page under help/ is a module's guide: add the Module guide block." });
  for (const { i } of guides.slice(1)) issues.push({ path: `blocks[${i}].type`, message: "One module guide to a page.", ...at(i) });
  list.forEach((b, i) => {
    if (PAGE_TOP_BLOCKS.has(String(b?.type))) issues.push({ path: `blocks[${i}].type`, message: "The guide's heading is this page's main title — take this block out.", ...at(i) });
  });
  for (const { b, i } of guides) {
    for (const issue of guideReferenceIssues(b.props)) issues.push({ path: `blocks[${i}].props${issue.path ? `.${issue.path}` : ""}`, message: issue.message, ...at(i) });
  }
  return issues;
}

/** The module a page's guide is for, when the page is a guide: its first guide block's. */
export function guideModuleOf(blocks: unknown): string | null {
  const block = arr<{ type?: unknown; props?: unknown }>(blocks).find((b) => isObj(b) && b.type === "helpGuide");
  const props = block && isObj(block.props) ? block.props : null;
  return props && typeof props.module === "string" && props.module ? props.module : null;
}

// ─── The page for a route in the app ─────────────────────────────────────────────────────────────

/**
 * Pages of the app that belong to a module but aren't one of its menu links — besides every menu link
 * (src/lib/modules.ts navItems) and every settings screen of one module (src/lib/settings/catalogue.ts).
 */
export const EXTRA_GUIDE_ROUTES: Readonly<Record<string, string>> = {
  // A trade document opened from anywhere — proposals and invoices are sales documents.
  "/documents": "sales_documents",
  // Awards and the performance board sit with the targets they are measured against.
  "/performance": "targets",
  "/sales": "sales_documents",
  "/purchase": "purchase_documents",
  // Automate's own address; its menu links are all under it.
  "/automate": "automate",
};

/** App pages that belong to no one module, so have no guide of their own. */
export const NO_GUIDE_ROUTES: readonly string[] = ["/dashboard", "/activity", "/profile", "/settings"];

type RouteEntry = { prefix: string; module: string };

let routes: RouteEntry[] | null = null;

function routeTable(): RouteEntry[] {
  if (routes) return routes;
  const out = new Map<string, string>();
  const add = (href: string, key: string) => {
    const prefix = href.split(/[?#]/)[0]!.replace(/\/+$/, "") || "/";
    if (!out.has(prefix)) out.set(prefix, key);
  };
  for (const def of MODULE_REGISTRY) for (const item of def.navItems) add(item.href, def.key);
  for (const [href, key] of Object.entries(EXTRA_GUIDE_ROUTES)) add(href, key);
  for (const item of SETTINGS.flatMap((s) => s.groups.flatMap((g) => g.items))) {
    const modules = modulesOfSetting(item);
    // A settings screen shared by several modules (the pipeline's stages and an order's steps) is the first one's.
    if (modules.length) add(item.href, modules[0]!);
  }
  routes = [...out.entries()].map(([prefix, key]) => ({ prefix, module: key })).sort((a, b) => b.prefix.length - a.prefix.length);
  return routes;
}

/**
 * The module whose guide answers for this page of the app — the longest menu link, settings screen or
 * extra route the path starts with, whole segments only ("/leads/acme-1" is Leads, "/leadsx" nothing).
 * Null for a page that belongs to no one module (the dashboard, Settings' own index).
 */
export function moduleForPath(pathname: unknown): string | null {
  if (typeof pathname !== "string") return null;
  const path = (pathname.split(/[?#]/)[0] ?? "").replace(/\/+$/, "") || "/";
  if (!path.startsWith("/")) return null;
  for (const { prefix, module: key } of routeTable()) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return key;
  }
  return null;
}
