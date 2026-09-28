import { ENTER, MANAGERS, OWNERS, SELLERS, SETTINGS_VIEWERS, SIGNUP_VIEWERS, SUPPORT_VIEWERS, WEBSITE_VIEWERS } from "@/lib/console-shared/roles";
import type { ConsoleRole, NavBadgeKey } from "@/lib/console-shared/types";

/**
 * The console's pages, once: the sidebar, the page gates (`consoleStaff(PAGE_ROLES.billing)`), the
 * palette's "Go to" list, the `g` shortcuts and the breadcrumbs all read this table. Browser paths
 * are un-prefixed — the proxy rewrites admin.<domain>/x to /platform-console/x — so every href here
 * is root-relative.
 *
 * Pure and client-safe: nothing here reaches src/lib/platform or src/lib/tenancy.
 */

export type ConsolePageKey =
  | "overview"
  | "alerts"
  | "workspaces"
  | "support"
  | "trials"
  | "signups"
  | "invites"
  | "partners"
  | "announcements"
  | "billing"
  | "commissions"
  | "plans"
  | "health"
  | "provisioning"
  | "migrations"
  | "devices"
  | "reference"
  | "website"
  | "staff"
  | "audit"
  | "settings"
  | "account";

export type NavGroup = "home" | "customers" | "revenue" | "platform" | "admin";

/** lucide-react names; the shell maps them to components (src/components/console/shell/nav-icons.tsx). */
export type NavIconName =
  | "LayoutDashboard"
  | "BellRing"
  | "Building2"
  | "LifeBuoy"
  | "Hourglass"
  | "UserPlus"
  | "Ticket"
  | "Handshake"
  | "Megaphone"
  | "CreditCard"
  | "HandCoins"
  | "Layers"
  | "HeartPulse"
  | "Rocket"
  | "DatabaseZap"
  | "Fingerprint"
  | "Earth"
  | "Globe"
  | "Users"
  | "ScrollText"
  | "Settings"
  | "UserRound";

export type ConsolePage = {
  key: ConsolePageKey;
  href: string;
  label: string;
  group: NavGroup;
  icon: NavIconName;
  /** Who may open it; undefined is every staff member. */
  roles?: readonly ConsoleRole[];
  badge?: NavBadgeKey;
  /** Extra words the palette matches on. */
  keywords: string[];
  /** The key after `g` ("g w" opens Workspaces). */
  shortcut?: string;
  /** false: reached from the staff menu, not the sidebar. */
  inNav: boolean;
};

/**
 * Each page's gate. Sub-routes gate themselves: /plans/new is SELLERS, /announcements/new MANAGERS,
 * /partners/requests SELLERS (a partner's own page, /partners/<slug>, keeps the partners gate);
 * a role outside the gate gets the same "not found" as a page that does not exist.
 */
export const PAGE_ROLES: Record<ConsolePageKey, readonly ConsoleRole[] | undefined> = {
  overview: undefined,
  alerts: undefined,
  workspaces: undefined,
  support: SUPPORT_VIEWERS,
  trials: undefined,
  signups: SIGNUP_VIEWERS,
  invites: undefined,
  partners: undefined,
  announcements: undefined,
  billing: SELLERS,
  commissions: SELLERS,
  plans: undefined,
  health: undefined,
  provisioning: undefined,
  migrations: undefined,
  devices: undefined,
  reference: undefined,
  website: WEBSITE_VIEWERS,
  staff: undefined,
  audit: undefined,
  settings: SETTINGS_VIEWERS,
  account: undefined,
};

export const CONSOLE_PAGES: readonly ConsolePage[] = [
  { key: "overview", href: "/", label: "Overview", group: "home", icon: "LayoutDashboard", keywords: ["home", "dashboard", "summary"], shortcut: "o", inNav: true },
  { key: "alerts", href: "/alerts", label: "Alerts", group: "home", icon: "BellRing", badge: "alerts", keywords: ["attention", "problems", "warnings"], shortcut: "a", inNav: true },
  { key: "workspaces", href: "/workspaces", label: "Workspaces", group: "customers", icon: "Building2", keywords: ["tenants", "customers", "accounts", "companies"], shortcut: "w", inNav: true },
  // No `g` shortcut: "s" is Staff's.
  { key: "support", href: "/support", label: "Support", group: "customers", icon: "LifeBuoy", roles: PAGE_ROLES.support, badge: "support", keywords: ["help", "tickets", "requests", "customer"], inNav: true },
  { key: "trials", href: "/trials", label: "Trials", group: "customers", icon: "Hourglass", badge: "trials", keywords: ["trial", "ending", "conversion"], shortcut: "t", inNav: true },
  { key: "signups", href: "/signups", label: "Signups", group: "customers", icon: "UserPlus", roles: PAGE_ROLES.signups, badge: "signups", keywords: ["sign up", "funnel", "pending", "stuck"], inNav: true },
  { key: "invites", href: "/invites", label: "Invitations", group: "customers", icon: "Ticket", keywords: ["invite", "codes", "invitation"], inNav: true },
  { key: "partners", href: "/partners", label: "Partners", group: "customers", icon: "Handshake", badge: "partners", keywords: ["resellers", "distributors", "channel", "referrals", "deals"], inNav: true },
  { key: "announcements", href: "/announcements", label: "Announcements", group: "customers", icon: "Megaphone", badge: "announcements", keywords: ["banner", "notice", "message", "broadcast"], inNav: true },
  { key: "billing", href: "/billing", label: "Billing", group: "revenue", icon: "CreditCard", roles: PAGE_ROLES.billing, badge: "billing", keywords: ["revenue", "invoices", "subscriptions", "webhooks", "mrr", "stripe", "razorpay"], shortcut: "b", inNav: true },
  { key: "commissions", href: "/commissions", label: "Commissions", group: "revenue", icon: "HandCoins", roles: PAGE_ROLES.commissions, badge: "commissions", keywords: ["payouts", "statements", "partner revenue"], inNav: true },
  { key: "plans", href: "/plans", label: "Plans", group: "revenue", icon: "Layers", keywords: ["pricing", "editions", "modules", "prices"], inNav: true },
  { key: "health", href: "/health", label: "System health", group: "platform", icon: "HeartPulse", badge: "health", keywords: ["status", "checks", "jobs", "configuration"], shortcut: "h", inNav: true },
  { key: "provisioning", href: "/provisioning", label: "Provisioning", group: "platform", icon: "Rocket", badge: "provisioning", keywords: ["setup", "jobs", "warm pool", "worker"], shortcut: "p", inNav: true },
  { key: "migrations", href: "/migrations", label: "Migrations", group: "platform", icon: "DatabaseZap", badge: "migrations", keywords: ["schema", "database", "behind"], shortcut: "m", inNav: true },
  { key: "devices", href: "/devices", label: "Terminals", group: "platform", icon: "Fingerprint", keywords: ["devices", "biometric", "attendance", "serial"], inNav: true },
  { key: "reference", href: "/reference", label: "Reference data", group: "platform", icon: "Earth", badge: "reference", keywords: ["pin", "postal", "places", "countries", "sync"], inNav: true },
  { key: "website", href: "/website", label: "Website CMS", group: "platform", icon: "Globe", roles: PAGE_ROLES.website, keywords: ["cms", "site", "marketing", "blog", "pages", "leads"], inNav: true },
  { key: "staff", href: "/staff", label: "Staff", group: "admin", icon: "Users", keywords: ["team", "people", "roles", "sessions"], shortcut: "s", inNav: true },
  { key: "audit", href: "/audit", label: "Audit log", group: "admin", icon: "ScrollText", keywords: ["history", "activity", "log"], shortcut: "l", inNav: true },
  { key: "settings", href: "/settings", label: "Settings", group: "admin", icon: "Settings", roles: PAGE_ROLES.settings, keywords: ["signup", "gateways", "keys", "security", "environment"], inNav: true },
  { key: "account", href: "/account", label: "My account", group: "admin", icon: "UserRound", keywords: ["profile", "password", "sessions", "preferences"], inNav: false },
];

export const NAV_GROUPS: readonly { key: NavGroup; label: string | null }[] = [
  { key: "home", label: null },
  { key: "customers", label: "Customers" },
  { key: "revenue", label: "Revenue" },
  { key: "platform", label: "Platform" },
  { key: "admin", label: "Admin" },
];

export function pageByKey(key: ConsolePageKey): ConsolePage {
  const page = CONSOLE_PAGES.find((p) => p.key === key);
  if (!page) throw new Error(`No console page "${key}".`);
  return page;
}

export function canOpen(role: ConsoleRole, key: ConsolePageKey): boolean {
  const roles = PAGE_ROLES[key];
  return !roles || roles.includes(role);
}

/** Every page a role may open, in table order — including My account, which is not in the sidebar (`inNav`). */
export function pagesFor(role: ConsoleRole): ConsolePage[] {
  return CONSOLE_PAGES.filter((p) => canOpen(role, p.key));
}

/** A browser path without its query, hash, trailing slash or the internal /platform-console prefix. */
function plainPath(pathname: string): string {
  let path = pathname.split(/[?#]/)[0] || "/";
  if (path === "/platform-console" || path.startsWith("/platform-console/")) path = path.slice("/platform-console".length) || "/";
  if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "") || "/";
  return path.startsWith("/") ? path : `/${path}`;
}

/** The page a path belongs to: "/" exactly, otherwise the longest href it is or sits under ("/plans/new" → plans). */
export function activePageKey(pathname: string): ConsolePageKey | null {
  const path = plainPath(pathname);
  if (path === "/") return "overview";
  let best: ConsolePage | null = null;
  for (const page of CONSOLE_PAGES) {
    if (page.href === "/") continue;
    if (path !== page.href && !path.startsWith(`${page.href}/`)) continue;
    if (!best || page.href.length > best.href.length) best = page;
  }
  return best?.key ?? null;
}

/** "/workspaces/acme" (and anything under it) → "acme"; null anywhere else. */
export function workspaceSlugFromPath(pathname: string): string | null {
  const match = /^\/workspaces\/([^/]+)/.exec(plainPath(pathname));
  if (!match) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) ? slug : null;
}

/**
 * The palette's actions. They only navigate: each opens the page that owns the action, with a URL
 * param that opens its dialog. Labels avoid the wording kept for the roles allowed to act.
 */
export type PaletteAction = { key: string; label: string; href: string; roles: readonly ConsoleRole[]; context?: "workspace" };

export const PALETTE_ACTIONS: readonly PaletteAction[] = [
  { key: "new-invite", label: "New invitation", href: "/invites?new=1", roles: MANAGERS },
  { key: "new-partner", label: "New partner", href: "/partners?new=1", roles: MANAGERS },
  { key: "add-staff", label: "Add staff member", href: "/staff?add=1", roles: OWNERS },
  { key: "new-plan", label: "New plan", href: "/plans/new", roles: SELLERS },
  { key: "new-announcement", label: "New announcement", href: "/announcements/new", roles: MANAGERS },
  { key: "top-up", label: "Top up warm pool", href: "/provisioning?topup=1", roles: MANAGERS },
  { key: "sync-pin", label: "Sync PIN directory", href: "/reference?sync=pin", roles: MANAGERS },
  { key: "hold-this", label: "Hold this workspace…", href: "/workspaces/{slug}?do=hold", roles: MANAGERS, context: "workspace" },
  { key: "enter-this", label: "Enter this workspace as support", href: "/workspaces/{slug}?do=enter", roles: ENTER, context: "workspace" },
];

/** The actions a role may take from where it is: the workspace ones only on a workspace's page. */
export function paletteActionsFor(role: ConsoleRole, workspaceSlug: string | null): { key: string; label: string; href: string }[] {
  return PALETTE_ACTIONS.filter((a) => a.roles.includes(role) && (a.context !== "workspace" || !!workspaceSlug)).map((a) => ({
    key: a.key,
    label: a.label,
    href: workspaceSlug ? a.href.replace("{slug}", encodeURIComponent(workspaceSlug)) : a.href,
  }));
}
