import type { NavItem, NavMenu, SiteSettings } from "../../src/components/site/blocks/types";
import { COMPARE_ENTRIES, PRODUCT_GROUPS, RESOURCE_ENTRIES, SOLUTION_GROUPS, byPath, type CatalogEntry } from "./_catalog";

/**
 * The header's menus and the footer, as the site's settings store them (NavItem[], footer columns).
 * Built from the catalogue, so a menu's line and a hub card's line never disagree.
 *
 * `partnerPortal` is the partner portal's own address — https://partners.<domain>/ — made by the
 * helper the portal itself uses (src/lib/partners/users.ts partnerOrigin), because a site path can't
 * reach another host.
 */

const item = (e: CatalogEntry) => ({ label: e.label, href: e.path, description: e.tagline });

export function siteNav(options: { partnerPortal: string }): { nav: NavItem[]; footer: SiteSettings["footer"] } {
  const product: NavMenu = {
    label: "Product",
    columns: PRODUCT_GROUPS.map((g) => ({ title: g.title, items: g.entries.map(item) })),
    footer: { label: "See every module", href: "/product" },
  };
  const solutions: NavMenu = {
    label: "Solutions",
    columns: SOLUTION_GROUPS.map((g) => ({ title: g.title, items: g.entries.map(item) })),
    footer: { label: "All solutions", href: "/solutions" },
  };
  const compare: NavMenu = {
    label: "Compare",
    columns: [{ title: "{siteName} compared with", items: COMPARE_ENTRIES.map((e) => ({ label: e.label, href: e.path })) }],
    footer: { label: "How to choose", href: "/compare" },
  };
  const partners: NavMenu = {
    label: "Partners",
    columns: [
      {
        title: "Partner programme",
        items: [
          { label: "Become a partner", href: "/partners", description: "Sell {siteName} and earn a recurring commission" },
          { label: "Find a partner", href: "/partners/find", description: "Companies that sell, set up and support {siteName}" },
          { label: "Partner portal sign-in", href: options.partnerPortal, description: "Your customers, commissions and statements" },
        ],
      },
    ],
  };
  const resources: NavMenu = {
    label: "Resources",
    columns: [
      { title: "Learn", items: RESOURCE_ENTRIES.map(item) },
      {
        title: "Company",
        items: [
          { label: "Security", href: "/security", description: "How each company's data is kept apart" },
          { label: "Contact", href: "/contact", description: "Plans, pricing, or help with your workspace" },
          { label: "Book a demo", href: "/contact?topic=demo", description: "A walk through the modules that matter to you" },
        ],
      },
    ],
    footer: { label: "All resources", href: "/resources" },
  };
  const nav: NavItem[] = [product, solutions, compare, { label: "Pricing", href: "/pricing" }, partners, resources];

  const footer: SiteSettings["footer"] = {
    columns: [
      {
        title: "Product",
        links: [
          ...["/product/crm", "/product/quotes-invoices", "/product/accounting-gst", "/product/payroll", "/product/helpdesk", "/product/inventory", "/product/revenue-close", "/product/security"].map((path) => ({ label: byPath(path).label, href: path })),
          { label: "Pricing", href: "/pricing" },
          { label: "Every module", href: "/product" },
        ],
      },
      {
        title: "Solutions",
        links: [
          ...["/solutions/founders", "/solutions/finance-teams", "/solutions/sales-teams", "/solutions/hr-teams", "/solutions/small-business", "/solutions/multi-branch-enterprises", "/solutions/it-services-resellers", "/solutions/trading-distribution", "/solutions/saas-subscriptions"].map(
            (path) => ({ label: byPath(path).label, href: path }),
          ),
          { label: "All solutions", href: "/solutions" },
        ],
      },
      {
        title: "Compare",
        links: [...COMPARE_ENTRIES.map((e) => ({ label: `vs ${e.label}`, href: e.path })), { label: "How to choose", href: "/compare" }],
      },
      {
        title: "Resources",
        links: [
          ...RESOURCE_ENTRIES.map((e) => ({ label: e.label, href: e.path })),
          { label: "All resources", href: "/resources" },
          { label: "Become a partner", href: "/partners" },
          { label: "Find a partner", href: "/partners/find" },
          { label: "Partner portal", href: options.partnerPortal },
        ],
      },
      {
        title: "Company",
        links: [
          { label: "Security", href: "/security" },
          { label: "Sub-processors", href: "/security#subprocessors" },
          { label: "Terms", href: "/terms" },
          { label: "Privacy", href: "/privacy" },
          { label: "Contact", href: "/contact" },
          { label: "Book a demo", href: "/contact?topic=demo" },
          { label: "Sign in", href: "/signin" },
          { label: "Find my workspaces", href: "/signin#find" },
        ],
      },
    ],
    note: "{tagline}",
  };
  return { nav, footer };
}
