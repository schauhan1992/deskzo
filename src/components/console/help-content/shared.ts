import type { PublicationState } from "@/lib/platform/help-content";
import type { Tone } from "@/lib/console-shared/types";
import { MODULE_REGISTRY, navGroupRank } from "@/lib/modules";
import { BASE_MODULES, PRODUCTS } from "@/lib/products";

/**
 * What the Help and What's new pages (src/app/platform-console/(console)/help-content) and their
 * client pieces share: the tabs, the state labels, the shapes the server hands over, and how a row's
 * modules and countries are put into words. Pure and client-safe — the rules themselves live in
 * src/lib/platform/help-content.ts, which only the server reaches.
 */

export type HelpTab = "articles" | "videos" | "updates";
export const HELP_TABS: readonly HelpTab[] = ["articles", "videos", "updates"];
export const HELP_TAB_LABEL: Record<HelpTab, string> = { articles: "Articles", videos: "Videos", updates: "What's new" };

/** An article or a video (PlatformHelpLink), or a What's new post (PlatformUpdate). */
export type HelpItemKind = "ARTICLE" | "VIDEO" | "POST";
/** Which table an item lives in, as the actions name it. */
export type HelpItemTable = "link" | "post";

export const tableOf = (kind: HelpItemKind): HelpItemTable => (kind === "POST" ? "post" : "link");
export const tabOf = (kind: HelpItemKind): HelpTab => (kind === "ARTICLE" ? "articles" : kind === "VIDEO" ? "videos" : "updates");

/** "article", "video", "post" — for sentences. */
export const KIND_WORD: Record<HelpItemKind, string> = { ARTICLE: "article", VIDEO: "video", POST: "post" };
/** "Article", "Video", "What's new post" — for headings. */
export const KIND_TITLE: Record<HelpItemKind, string> = { ARTICLE: "Article", VIDEO: "Video", POST: "What's new post" };

export const HELP_STATE: Record<PublicationState, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  scheduled: { label: "Scheduled", tone: "info" },
  live: { label: "Live", tone: "success" },
  archived: { label: "Archived", tone: "neutral" },
};

/** One row of the list, and the read-only view of one item. */
export type HelpListItem = {
  id: string;
  kind: HelpItemKind;
  title: string;
  /** An article's or video's link; a post's "read more", or null. */
  url: string | null;
  /** An article's or video's line under the title, or a post's body. */
  text: string | null;
  pinned: boolean;
  modules: string[];
  countries: string[];
  publishedAt: Date | null;
  state: PublicationState;
  updatedAt: Date;
  updatedByName: string;
  /** Open workspaces it reaches now — whatever its state; null when not worked out (archived). */
  reach: number | null;
};

/** What the editor starts from: an existing item, as saved. */
export type HelpEditorItem = {
  id: string;
  kind: HelpItemKind;
  title: string;
  url: string;
  description: string;
  body: string;
  pinned: boolean;
  modules: string[];
  countries: string[];
  publishedAt: Date | null;
  state: PublicationState;
};

/** The limits a save is held to — the database's CHECKs, handed over by the page so they are written once. */
export type HelpLimits = { titleMin: number; titleMax: number; description: number; body: number; url: number; modules: number; countries: number };

/** What the editor offers and checks early: the countries open workspaces are in, and where a link may point. */
export type HelpEditorChoices = { countries: string[]; linkHosts: string[]; linkDomain: string; limits: HelpLimits; openWorkspaces: number };

// ─── Modules and products ────────────────────────────────────────────────────────────────────────

export type TargetModule = { key: string; label: string; group: string; countries: readonly string[] | null };
export type TargetProduct = { key: string; name: string; modules: string[] };

/**
 * The modules a row may be narrowed to: every one but those every workspace has (core, the ones in
 * every plan, and the basics every product's plan comes with — `BASE_MODULES`) — a row reaches a
 * workspace whose plan has any chosen module, so one of those would make it reach everybody. The save
 * refuses them too. In the sidebar's group order.
 */
export const TARGET_MODULES: readonly TargetModule[] = MODULE_REGISTRY.filter((m) => !m.core && !m.inEveryPlan && !BASE_MODULES.includes(m.key))
  .map((m) => ({ key: m.key, label: m.label, group: m.navGroup, countries: m.countries ?? null }))
  .sort((a, b) => navGroupRank(a.group) - navGroupRank(b.group) || a.group.localeCompare(b.group) || a.label.localeCompare(b.label));

const TARGETABLE = new Set(TARGET_MODULES.map((m) => m.key));
const LABELS = new Map(TARGET_MODULES.map((m) => [m.key, m.label]));

/**
 * The products as chips (src/lib/products.ts): each stands for its own modules, without the basics
 * every product comes with. Deskzo One is every module — choosing no modules says that already.
 */
export const TARGET_PRODUCTS: readonly TargetProduct[] = PRODUCTS.filter((p) => p.key !== "one")
  .map((p) => ({ key: p.key, name: p.name, modules: [...new Set(p.modules)].filter((k) => TARGETABLE.has(k)) }))
  .filter((p) => p.modules.length > 0);

export const moduleLabel = (key: string) => LABELS.get(key) ?? key;

/** A product is chosen when every one of its modules is. */
export const productChosen = (product: TargetProduct, chosen: ReadonlySet<string>) => product.modules.every((k) => chosen.has(k));

/** "Deskzo CRM, Payroll" — whole products by name, the modules left over by theirs. */
export function moduleNames(modules: readonly string[]): string[] {
  const chosen = new Set(modules);
  const named: string[] = [];
  const covered = new Set<string>();
  for (const product of TARGET_PRODUCTS) {
    if (!productChosen(product, chosen)) continue;
    named.push(product.name);
    for (const k of product.modules) covered.add(k);
  }
  for (const key of modules) if (!covered.has(key)) named.push(moduleLabel(key));
  return named;
}

/** "IN, AE, US +2" — the first few, then how many more. */
export function listed(items: readonly string[], max = 3): string {
  return items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} +${items.length - max}`;
}

/** Who a row is for, in a line: "Every workspace", "Deskzo CRM, Payroll", "Every workspace in IN, AE", "Deskzo Books · in IN". */
export function targetingText(modules: readonly string[], countries: readonly string[], max = 2): string {
  const names = moduleNames(modules);
  const where = countries.length ? `in ${listed(countries, 3)}` : "";
  if (names.length === 0) return where ? `Every workspace ${where}` : "Every workspace";
  return where ? `${listed(names, max)} · ${where}` : listed(names, max);
}

/** "Showing in 12 open workspaces", "Reaches 12 open workspaces today", "Would reach 12 open workspaces"; null for none worked out. */
export function reachLine(state: PublicationState, reach: number | null): string | null {
  if (reach === null || state === "archived") return null;
  const n = `${reach.toLocaleString("en-IN")} open workspace${reach === 1 ? "" : "s"}`;
  return state === "live" ? `Showing in ${n}` : state === "scheduled" ? `Reaches ${n} today` : `Would reach ${n}`;
}

/** No module and no country chosen: every workspace, which only an owner — or "publish" typed — puts live. */
export const isEverywhere = (row: { modules: readonly string[]; countries: readonly string[] }) => row.modules.length === 0 && row.countries.length === 0;

/** Where a link opens, shortly: "youtube.com/watch?v=…", or the path in the app. */
export function linkText(url: string | null): string {
  if (!url) return "";
  if (url.startsWith("/")) return url;
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
