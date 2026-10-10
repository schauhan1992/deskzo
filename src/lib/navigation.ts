import type { LucideIcon } from "lucide-react";
import { BarChart3, FileSpreadsheet, LayoutDashboard, ScrollText, Settings as SettingsIcon, ShieldCheck, UserCog } from "lucide-react";
import { MODULE_REGISTRY, navGroupRank, navPermissionKeys, type ModuleDefinition, type NavFact, type NavItem } from "@/lib/modules";
import { PERMISSION_KEYS, isPermissionKey, sectionPermission } from "@/lib/permissions";

/**
 * What somebody may open, and the menu built from it — one rule for every surface.
 *
 * A plain module with no server imports: the server decides with it (src/lib/modules-access.ts, the
 * layout), and the sidebar imports it only for the icons. The menu is never worked out in the
 * browser — the layout builds it from the access context it resolved for this request and hands the
 * sidebar the result, so the first paint after sign-in is already the person's own menu, and a
 * permission taken away is gone on their next page.
 *
 * Showing a link is never the security. Every page a link opens and every action behind it asks the
 * same question again on the server (`isModuleEnabled`, `requireModuleUser`, `can`); this file exists
 * so the menu asks it with the same rule rather than a copy that drifts.
 */

/**
 * Whether a module is there for this workspace, and for this person. From the hardest boundary to the
 * softest — see src/lib/modules-access.ts for what each means to a page and an action.
 */
export type ModuleAccess = "available" | "not-entitled" | "switched-off" | "no-permission";

/**
 * The rule, given the facts: in the plan, switched on (a core module always is), its view permission
 * held, its section not unticked for the person's role. `moduleAccessFor` gathers the facts for one
 * module; `accessContextFor` for all of them at once, for the menus.
 */
export function decideModuleAccess(
  def: Pick<ModuleDefinition, "key" | "core" | "viewPermission">,
  facts: { entitled: boolean; switchedOn: boolean },
  holds: ReadonlySet<string>,
): ModuleAccess {
  if (!facts.entitled) return "not-entitled";
  if (!def.core && !facts.switchedOn) return "switched-off";
  if (def.viewPermission && !holds.has(def.viewPermission)) return "no-permission";
  // The section itself, untickable per role (owner, 8 Oct 2026): hidden from the menu, and its pages
  // say there's no access — as for a missing view permission.
  const section = sectionPermission(def.key);
  if (isPermissionKey(section) && !holds.has(section)) return "no-permission";
  return "available";
}

/** Every module `decideModuleAccess` lets this person open, given each module's plan and switch. */
export function openModuleKeys(facts: (def: ModuleDefinition) => { entitled: boolean; switchedOn: boolean }, holds: ReadonlySet<string>): string[] {
  return MODULE_REGISTRY.filter((def) => decideModuleAccess(def, facts(def), holds) === "available").map((def) => def.key);
}

/** What the menus are built from: the modules this person may open, what they hold, and where. */
export type NavAccess = {
  /** Module keys `decideModuleAccess` answered "available" for. */
  openModules: readonly string[];
  permissions: readonly string[];
  /** The workspace's, for links that only exist in some countries (the e-way bill register). */
  country: string;
  /** What is true of this person for `NavItem.onlyFor` — they hold a live digital card. */
  facts?: readonly NavFact[];
};

/** Every export permission: any one of them opens Import & export. */
const DATA_PERMISSIONS = PERMISSION_KEYS.filter((k) => k.startsWith("data."));

type SystemNavItem = Pick<NavItem, "href" | "label" | "icon" | "permission"> & { exact?: boolean };

/**
 * The links that belong to no module: the app's own reports and its administration.
 *
 * Each administration link is gated on the key its own page requires, not on a blanket "is an admin"
 * flag. The two must agree: a link whose page then refuses you is the invitation-to-a-locked-door
 * problem, and gating the group as a whole would hide Staff & roles from an auditor who holds
 * permissions.view and nothing else.
 */
export const SYSTEM_NAV: { group: string; items: SystemNavItem[] }[] = [
  {
    group: "Reports",
    items: [
      { href: "/performance", label: "Performance", icon: BarChart3, permission: "performance.view" },
      // No permission gate: everybody can see their own activity, and should. A log that is secret
      // from the people in it is surveillance; one they can check is also the fastest way somebody
      // notices a sign-in that was not them. The action narrows the rows.
      { href: "/activity", label: "Activity log", icon: ScrollText },
    ],
  },
  {
    group: "Administration",
    items: [
      // Exact: `/settings` is a prefix of the two below, and would otherwise light up on both.
      { href: "/settings", label: "Settings", icon: SettingsIcon, permission: "settings.manage", exact: true },
      { href: "/settings/access", label: "Staff & roles", icon: UserCog, permission: "permissions.view" },
      { href: "/settings/security", label: "Security & DLP", icon: ShieldCheck, permission: "security.manage" },
      // Any export permission opens it. Deliberately not gated on being an admin: an accountant who
      // exports statements is not an administrator, and hiding it from them defeats the point.
      { href: "/settings/data", label: "Import & export", icon: FileSpreadsheet, permission: DATA_PERMISSIONS },
    ],
  },
];

export const DASHBOARD_HREF = "/dashboard";

/** One link as the sidebar draws it. Plain data: it crosses from the server to the browser. */
export type VisibleNavItem = {
  href: string;
  label: string;
  /** The word the label is built from, for a workspace that renamed it (Settings → Wording). */
  term?: NavItem["term"];
  /** Active only on this very address, never on one below it. */
  exact?: boolean;
};

export type VisibleNavSection = {
  group: string;
  items: VisibleNavItem[];
  /** Reports and Administration — what is left when somebody has no module at all. */
  system?: boolean;
};

/** Whether a link is for this person: in their country, true of them, and — if it names permissions — holding one. */
function linkAllowed(
  item: Pick<NavItem, "permission" | "countries" | "onlyFor">,
  access: { held: ReadonlySet<string>; country: string; facts?: ReadonlySet<NavFact> },
) {
  if (item.countries && !item.countries.includes(access.country)) return false;
  if (item.onlyFor && !access.facts?.has(item.onlyFor)) return false;
  const keys = navPermissionKeys(item);
  // An array means any one of them will do — the same rule the settings catalogue uses.
  return keys.length === 0 || keys.some((k) => access.held.has(k));
}

/**
 * The menu this person sees, in the order it is drawn.
 *
 * A module appears only when `decideModuleAccess` lets them open it, and then only with the links
 * whose own permission they hold. A group whose every link is filtered out is dropped rather than
 * drawn as a bare heading over nothing — never an empty module.
 */
export function buildNavigation(access: NavAccess): VisibleNavSection[] {
  const open = new Set(access.openModules);
  const held = new Set(access.permissions);
  const ctx = { held, country: access.country, facts: new Set(access.facts ?? []) };

  const groups = new Map<string, VisibleNavItem[]>();
  for (const mod of MODULE_REGISTRY) {
    if (!open.has(mod.key)) continue;
    const items = mod.navItems
      .filter((i) => linkAllowed(i, ctx))
      .map((i): VisibleNavItem => ({ href: i.href, label: i.label, ...(i.term ? { term: i.term } : {}) }));
    if (items.length === 0) continue;
    groups.set(mod.navGroup, [...(groups.get(mod.navGroup) ?? []), ...items]);
  }

  const modules: VisibleNavSection[] = Array.from(groups.entries())
    // Explicit order rather than the order the registry happens to declare them in.
    .sort(([a], [b]) => navGroupRank(a) - navGroupRank(b))
    .map(([group, items]) => ({ group, items }));

  const system: VisibleNavSection[] = SYSTEM_NAV.map(({ group, items }) => ({
    group,
    system: true,
    items: items
      .filter((i) => linkAllowed(i, ctx))
      .map((i): VisibleNavItem => ({ href: i.href, label: i.label, ...(i.exact ? { exact: true } : {}) })),
  })).filter((s) => s.items.length > 0);

  return [...modules, ...system];
}

/** Whether the menu holds any module at all — false is the "no modules assigned" state. */
export function hasModuleNavigation(sections: readonly VisibleNavSection[]): boolean {
  return sections.some((s) => !s.system);
}

const ICONS = new Map<string, LucideIcon>([
  [DASHBOARD_HREF, LayoutDashboard],
  ...MODULE_REGISTRY.flatMap((m) => m.navItems.map((i): [string, LucideIcon] => [i.href, i.icon])),
  ...SYSTEM_NAV.flatMap((s) => s.items.map((i): [string, LucideIcon] => [i.href, i.icon])),
]);

/** A link's icon. Looked up in the browser, since a component can't travel from the server as data. */
export function navIcon(href: string): LucideIcon {
  return ICONS.get(href) ?? LayoutDashboard;
}
