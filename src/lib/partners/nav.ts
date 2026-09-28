import { PARTNER_ADMINS, PARTNER_MONEY, type PartnerKind, type PartnerRole } from "@/lib/partners/types";

/**
 * The partner portal's pages, once: the sidebar, the page gates (`partnerPage(PARTNER_PAGE_ROLES.team)`)
 * and every link from one portal screen to another read this table. Browser paths are un-prefixed —
 * the proxy rewrites partners.<domain>/x to /platform-partners/x — so every href here is root-relative.
 *
 * Who may *open* a page is here; who may *change* anything on it is `partnerCapsFor(me)` in
 * ./types.ts, and every action checks again. Money pages are for the money roles only; the Resellers
 * pages exist only for a distributor (a reseller never has resellers of its own).
 *
 * Pure and client-safe: nothing here reaches the database.
 */

export type PartnerPageKey = "dashboard" | "customers" | "invitations" | "deals" | "commissions" | "statements" | "resellers" | "profile" | "team" | "activity" | "account";

export type PartnerNavGroup = "home" | "sell" | "money" | "channel" | "company";

/** lucide-react names; the shell turns them into glyphs. */
export type PartnerNavIconName =
  | "LayoutDashboard"
  | "Building2"
  | "Ticket"
  | "Handshake"
  | "HandCoins"
  | "FileSpreadsheet"
  | "Network"
  | "BadgeCheck"
  | "Users"
  | "Activity"
  | "UserRound";

export type PartnerNavPage = {
  key: PartnerPageKey;
  href: string;
  label: string;
  group: PartnerNavGroup;
  icon: PartnerNavIconName;
  /** One line: what the page is for (empty states, the shortcut sheet). */
  description: string;
  /** Who may open it; undefined is everybody signed in. */
  roles?: readonly PartnerRole[];
  /** Only a distributor has it. */
  distributorOnly: boolean;
  /** false: reached from the user menu, not the sidebar. */
  inNav: boolean;
};

/** Who opens invitations and deals: everybody but finance (who sells nothing). */
const PARTNER_SELL_READERS: readonly PartnerRole[] = ["ADMIN", "SALES", "VIEWER"];

/**
 * Each page's gate, for `partnerPage(PARTNER_PAGE_ROLES.x)` on the page itself. Sub-routes follow
 * their list: /customers/[slug] as customers, /statements/[number] as statements, /resellers/[slug]
 * as resellers (with `distributorOnly`).
 */
export const PARTNER_PAGE_ROLES: Record<PartnerPageKey, readonly PartnerRole[] | undefined> = {
  dashboard: undefined,
  customers: undefined,
  invitations: PARTNER_SELL_READERS,
  deals: PARTNER_SELL_READERS,
  commissions: PARTNER_MONEY,
  statements: PARTNER_MONEY,
  resellers: undefined,
  profile: undefined,
  team: PARTNER_ADMINS,
  activity: PARTNER_ADMINS,
  account: undefined,
};

/** Every portal address another screen links to — so a rename happens in one place. */
export const PARTNER_ROUTES = {
  dashboard: "/",
  customers: "/customers",
  customer: (slug: string) => `/customers/${encodeURIComponent(slug)}`,
  invitations: "/invitations",
  deals: "/deals",
  commissions: "/commissions",
  statements: "/statements",
  statement: (number: string) => `/statements/${encodeURIComponent(number)}`,
  resellers: "/resellers",
  reseller: (slug: string) => `/resellers/${encodeURIComponent(slug)}`,
  profile: "/profile",
  team: "/team",
  activity: "/activity",
  account: "/account",
} as const;

export const PARTNER_PAGES: readonly PartnerNavPage[] = [
  { key: "dashboard", href: PARTNER_ROUTES.dashboard, label: "Dashboard", group: "home", icon: "LayoutDashboard", description: "Your customers, what they bring in and what is coming up", distributorOnly: false, inNav: true },
  { key: "customers", href: PARTNER_ROUTES.customers, label: "Customers", group: "sell", icon: "Building2", description: "The workspaces attributed to you, their plans and standing", roles: PARTNER_PAGE_ROLES.customers, distributorOnly: false, inNav: true },
  { key: "invitations", href: PARTNER_ROUTES.invitations, label: "Invitations", group: "sell", icon: "Ticket", description: "Invitation codes and referral links that credit new customers to you", roles: PARTNER_PAGE_ROLES.invitations, distributorOnly: false, inNav: true },
  { key: "deals", href: PARTNER_ROUTES.deals, label: "Deal registrations", group: "sell", icon: "Handshake", description: "Companies you are working with, protected while approved", roles: PARTNER_PAGE_ROLES.deals, distributorOnly: false, inNav: true },
  { key: "commissions", href: PARTNER_ROUTES.commissions, label: "Commissions", group: "money", icon: "HandCoins", description: "What you have earned on each invoice, and what was clawed back", roles: PARTNER_PAGE_ROLES.commissions, distributorOnly: false, inNav: true },
  { key: "statements", href: PARTNER_ROUTES.statements, label: "Statements", group: "money", icon: "FileSpreadsheet", description: "Monthly statements, approved and paid", roles: PARTNER_PAGE_ROLES.statements, distributorOnly: false, inNav: true },
  { key: "resellers", href: PARTNER_ROUTES.resellers, label: "Resellers", group: "channel", icon: "Network", description: "Your resellers' customers and what they bring in", roles: PARTNER_PAGE_ROLES.resellers, distributorOnly: true, inNav: true },
  { key: "profile", href: PARTNER_ROUTES.profile, label: "Company profile", group: "company", icon: "BadgeCheck", description: "Your company's details, payout details and commission terms", roles: PARTNER_PAGE_ROLES.profile, distributorOnly: false, inNav: true },
  { key: "team", href: PARTNER_ROUTES.team, label: "Team", group: "company", icon: "Users", description: "Who can sign in to the portal for your company, and as what", roles: PARTNER_PAGE_ROLES.team, distributorOnly: false, inNav: true },
  { key: "activity", href: PARTNER_ROUTES.activity, label: "Activity", group: "company", icon: "Activity", description: "Everything done in your partner account, by whom and when", roles: PARTNER_PAGE_ROLES.activity, distributorOnly: false, inNav: true },
  { key: "account", href: PARTNER_ROUTES.account, label: "My account", group: "company", icon: "UserRound", description: "Your name, sessions, password and two-factor", roles: PARTNER_PAGE_ROLES.account, distributorOnly: false, inNav: false },
];

export const PARTNER_NAV_GROUPS: readonly { key: PartnerNavGroup; label: string | null }[] = [
  { key: "home", label: null },
  { key: "sell", label: "Sell" },
  { key: "money", label: "Money" },
  { key: "channel", label: "Channel" },
  { key: "company", label: "Company" },
];

export function canOpenPartnerPage(role: PartnerRole, kind: PartnerKind, key: PartnerPageKey): boolean {
  const page = PARTNER_PAGES.find((p) => p.key === key);
  if (!page || (page.distributorOnly && kind !== "DISTRIBUTOR")) return false;
  const roles = PARTNER_PAGE_ROLES[key];
  return !roles || roles.includes(role);
}

/** Every page a role of this kind of partner may open, in table order — My account included (it is not in the sidebar). */
export function partnerPagesFor(role: PartnerRole, kind: PartnerKind): PartnerNavPage[] {
  return PARTNER_PAGES.filter((p) => canOpenPartnerPage(role, kind, p.key));
}

/** A browser path without its query, hash, trailing slash or the internal /platform-partners prefix. */
function plainPath(pathname: string): string {
  let path = pathname.split(/[?#]/)[0] || "/";
  if (path === "/platform-partners" || path.startsWith("/platform-partners/")) path = path.slice("/platform-partners".length) || "/";
  if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "") || "/";
  return path.startsWith("/") ? path : `/${path}`;
}

/** The page a path belongs to: "/" exactly, otherwise the longest href it is or sits under ("/customers/acme" → customers). */
export function activePartnerPageKey(pathname: string): PartnerPageKey | null {
  const path = plainPath(pathname);
  if (path === "/") return "dashboard";
  let best: PartnerNavPage | null = null;
  for (const page of PARTNER_PAGES) {
    if (page.href === "/") continue;
    if (path !== page.href && !path.startsWith(`${page.href}/`)) continue;
    if (!best || page.href.length > best.href.length) best = page;
  }
  return best?.key ?? null;
}
