import { CMS_ADMINS, type CmsRole } from "@/lib/cms/types";

/**
 * The website CMS's pages, once: the sidebar, the page gates (`cmsPage(CMS_PAGE_ROLES.users)`), the
 * `g` shortcuts, the top bar's "New" menu and every link from one CMS screen to another read this
 * table. Browser paths are un-prefixed — the proxy rewrites cms.<domain>/x to /platform-cms/x — so
 * every href here is root-relative.
 *
 * Who may *open* a page is here; who may *change* anything on it is `cmsCapsFor(role)` in
 * ./types.ts, and every action checks again. Reading is broad on purpose (the backend lets every
 * role read pages, posts, media, leads, settings and the activity log): a viewer or an author sees
 * the page and none of the controls they cannot use.
 *
 * Pure and client-safe: nothing here reaches the database.
 */

export type CmsPageKey = "dashboard" | "pages" | "posts" | "media" | "leads" | "navigation" | "settings" | "users" | "activity" | "account";

export type CmsNavGroup = "home" | "content" | "inbox" | "site" | "team";

/** lucide-react names; the shell turns them into glyphs (src/components/cms/shell/nav-icons.tsx). */
export type CmsNavIconName = "LayoutDashboard" | "FileText" | "Newspaper" | "Images" | "Inbox" | "PanelsTopLeft" | "Settings" | "Users" | "Activity" | "UserRound";

/** A count the layout works out for the sidebar. */
export type CmsNavBadgeKey = "leads";

export type CmsNavPage = {
  key: CmsPageKey;
  href: string;
  label: string;
  group: CmsNavGroup;
  icon: CmsNavIconName;
  /** One line: what the page is for (the shortcut sheet, empty states). */
  description: string;
  /** Who may open it; undefined is everybody signed in. */
  roles?: readonly CmsRole[];
  badge?: CmsNavBadgeKey;
  /** The key after `g` ("g p" opens Pages). */
  shortcut?: string;
  /** false: reached from the user menu, not the sidebar. */
  inNav: boolean;
};

/**
 * Each page's gate, for `cmsPage(CMS_PAGE_ROLES.x)` on the page itself. Sub-routes gate themselves:
 * /settings/security is ADMIN only; /pages/[id] and /posts/[id] follow their list.
 */
export const CMS_PAGE_ROLES: Record<CmsPageKey, readonly CmsRole[] | undefined> = {
  dashboard: undefined,
  pages: undefined,
  posts: undefined,
  media: undefined,
  leads: undefined,
  navigation: undefined,
  settings: undefined,
  users: CMS_ADMINS,
  activity: undefined,
  account: undefined,
};

/** Every CMS address another screen links to — so a rename happens in one place. */
export const CMS_ROUTES = {
  dashboard: "/",
  pages: "/pages",
  page: (id: string) => `/pages/${encodeURIComponent(id)}`,
  /** A built-in page by its slug, saved or not ("builtin-home"). */
  builtinPage: (slug: string) => `/pages/builtin-${encodeURIComponent(slug)}`,
  posts: "/posts",
  post: (id: string) => `/posts/${encodeURIComponent(id)}`,
  media: "/media",
  /** The library with one item's details open (never /media/<id>: on this host that is the image itself). */
  mediaItem: (id: string) => `/media?id=${encodeURIComponent(id)}`,
  /** The library with its uploader in front. */
  mediaUpload: "/media?upload=1",
  leads: "/leads",
  lead: (id: string) => `/leads/${encodeURIComponent(id)}`,
  settings: "/settings",
  navigation: "/settings/navigation",
  security: "/settings/security",
  users: "/users",
  activity: "/activity",
  account: "/account",
} as const;

export const CMS_PAGES: readonly CmsNavPage[] = [
  { key: "dashboard", href: CMS_ROUTES.dashboard, label: "Dashboard", group: "home", icon: "LayoutDashboard", description: "What's live, what's in progress, what just happened", shortcut: "d", inNav: true },
  { key: "pages", href: CMS_ROUTES.pages, label: "Pages", group: "content", icon: "FileText", description: "The site's pages, drafts and published versions", roles: CMS_PAGE_ROLES.pages, shortcut: "p", inNav: true },
  { key: "posts", href: CMS_ROUTES.posts, label: "Posts", group: "content", icon: "Newspaper", description: "Blog and news posts, scheduled or live", roles: CMS_PAGE_ROLES.posts, shortcut: "o", inNav: true },
  { key: "media", href: CMS_ROUTES.media, label: "Media", group: "content", icon: "Images", description: "Images for pages, posts and sharing", roles: CMS_PAGE_ROLES.media, shortcut: "m", inNav: true },
  { key: "leads", href: CMS_ROUTES.leads, label: "Leads", group: "inbox", icon: "Inbox", description: "Requests sent through the contact form", roles: CMS_PAGE_ROLES.leads, badge: "leads", shortcut: "l", inNav: true },
  { key: "navigation", href: CMS_ROUTES.navigation, label: "Navigation", group: "site", icon: "PanelsTopLeft", description: "The header menu, the footer's columns and the sign-up button", roles: CMS_PAGE_ROLES.navigation, shortcut: "n", inNav: true },
  { key: "settings", href: CMS_ROUTES.settings, label: "Settings", group: "site", icon: "Settings", description: "Site name, tagline, contact email, social links and search defaults", roles: CMS_PAGE_ROLES.settings, shortcut: "s", inNav: true },
  { key: "users", href: CMS_ROUTES.users, label: "Users", group: "team", icon: "Users", description: "Who can sign in to the CMS, and as what", roles: CMS_PAGE_ROLES.users, shortcut: "u", inNav: true },
  { key: "activity", href: CMS_ROUTES.activity, label: "Activity", group: "team", icon: "Activity", description: "Everything changed in the CMS, by whom and when", roles: CMS_PAGE_ROLES.activity, shortcut: "a", inNav: true },
  { key: "account", href: CMS_ROUTES.account, label: "My account", group: "team", icon: "UserRound", description: "Your name, sessions, password and two-factor", roles: CMS_PAGE_ROLES.account, inNav: false },
];

export const CMS_NAV_GROUPS: readonly { key: CmsNavGroup; label: string | null }[] = [
  { key: "home", label: null },
  { key: "content", label: "Content" },
  { key: "inbox", label: "Inbox" },
  { key: "site", label: "Site" },
  { key: "team", label: "Team" },
];

export function canOpenCmsPage(role: CmsRole, key: CmsPageKey): boolean {
  const roles = CMS_PAGE_ROLES[key];
  return !roles || roles.includes(role);
}

/** Every page a role may open, in table order — My account included (it is not in the sidebar). */
export function cmsPagesFor(role: CmsRole): CmsNavPage[] {
  return CMS_PAGES.filter((p) => canOpenCmsPage(role, p.key));
}

/** A browser path without its query, hash, trailing slash or the internal /platform-cms prefix. */
function plainPath(pathname: string): string {
  let path = pathname.split(/[?#]/)[0] || "/";
  if (path === "/platform-cms" || path.startsWith("/platform-cms/")) path = path.slice("/platform-cms".length) || "/";
  if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "") || "/";
  return path.startsWith("/") ? path : `/${path}`;
}

/** The page a path belongs to: "/" exactly, otherwise the longest href it is or sits under ("/settings/navigation" → navigation). */
export function activeCmsPageKey(pathname: string): CmsPageKey | null {
  const path = plainPath(pathname);
  if (path === "/") return "dashboard";
  let best: CmsNavPage | null = null;
  for (const page of CMS_PAGES) {
    if (page.href === "/") continue;
    if (path !== page.href && !path.startsWith(`${page.href}/`)) continue;
    if (!best || page.href.length > best.href.length) best = page;
  }
  return best?.key ?? null;
}
