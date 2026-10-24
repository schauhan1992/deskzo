import {
  BookMarked,
  BookOpen,
  Boxes,
  Briefcase,
  Building2,
  Calculator,
  CalendarCheck,
  CalendarDays,
  Cloud,
  Crown,
  Handshake,
  Import,
  LogIn,
  MessageSquare,
  Network,
  Newspaper,
  PenLine,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Sprout,
  Store,
  TrendingUp,
  Truck,
  Users,
  type LucideIcon,
} from "lucide-react";

/**
 * The header menus' icons for the site's own pages (the seed's menus: scripts/site-content/nav.ts), by
 * address — a product's page has its own icon instead (src/lib/brand/product-icons.ts). A link the CMS
 * adds to an address not here has no icon and is drawn without one, so nothing has to be kept in step:
 * this is the look of the pages the site has, not a list of what a menu may hold.
 */
export const NAV_ICONS: Record<string, LucideIcon> = {
  // Solutions
  "/solutions/founders": Crown,
  "/solutions/finance-teams": Calculator,
  "/solutions/sales-teams": TrendingUp,
  "/solutions/hr-teams": Users,
  "/solutions/operations": Boxes,
  "/solutions/it-admins": ShieldCheck,
  "/solutions/small-business": Store,
  "/solutions/growing-companies": Sprout,
  "/solutions/multi-branch-enterprises": Building2,
  "/solutions/it-services-resellers": Server,
  "/solutions/professional-services": Briefcase,
  "/solutions/trading-distribution": Truck,
  "/solutions/saas-subscriptions": Cloud,
  // Add-ons and capabilities
  "/product/revenue-close": CalendarCheck,
  "/product/ai-copilot": Sparkles,
  "/product/security": ShieldCheck,
  "/product/linked-workspaces": Network,
  "/product/import-migration": Import,
  // Resources and the company
  "/blog/category/guides": BookOpen,
  "/resources/glossary": BookMarked,
  "/blog": Newspaper,
  "/email-signature-generator": PenLine,
  "/security": ShieldCheck,
  "/contact": MessageSquare,
  "/contact?topic=demo": CalendarDays,
  // Partners
  "/partners": Handshake,
  "/partners/find": Search,
  "partner-portal": LogIn,
};

/**
 * Which of `NAV_ICONS` a menu link has: its whole address, then its path; the partner portal (a host of
 * its own) by its name. Null for none. A key rather than the icon, so a component looks the icon up
 * from the map and React's rules see a component that never changes.
 */
export function navIconKey(href: string): string | null {
  if (/^https?:[/][/]partners[.]/i.test(href)) return "partner-portal";
  if (Object.hasOwn(NAV_ICONS, href)) return href;
  const path = href.split("#")[0]!.split("?")[0]!;
  return Object.hasOwn(NAV_ICONS, path) ? path : null;
}
