import type { NavItem, NavMenu, NavMenuItem, SiteSettings } from "../../src/components/site/blocks/types";
import { ADD_ONS } from "../../src/lib/products";
import { COMPARE_ENTRIES, PRODUCT_GROUP_TITLES, PRODUCT_LINE_GROUPS, RESOURCE_ENTRIES, SOLUTION_GROUPS, byPath, type CatalogEntry } from "./_catalog";
import { ADD_ON_PAGES, CAPABILITY_PAGES } from "./_products";

/**
 * The header's menus and the footer, as the site's settings store them (NavItem[], footer columns).
 * Built from the catalogue, so a menu's line and a hub card's line never disagree.
 *
 * The Product menu is the products (src/lib/products.ts): a column per menu group — the suite, sell
 * and serve, run the business, people and security — each product its name with its tagline under
 * it, then the add-ons that have a page and what every product has (security and access, linked
 * workspaces, import and migration), each linking to its module page. "See every module" is at its foot.
 *
 * `partnerPortal` is the partner portal's own address — https://partners.<domain>/ — made by the
 * helper the portal itself uses (src/lib/partners/users.ts partnerOrigin), because a site path can't
 * reach another host.
 */

const item = (e: CatalogEntry) => ({ label: e.label, href: e.path, description: e.tagline });

/** The add-ons with a page of their own, then the capabilities every product has. */
function addOnItems(): NavMenuItem[] {
  const addOns = ADD_ONS.flatMap((a) => (ADD_ON_PAGES[a.key] ? [{ label: a.name, href: ADD_ON_PAGES[a.key]!, description: a.tagline }] : []));
  return [...addOns, ...CAPABILITY_PAGES.map((path) => item(byPath(path)))];
}

/** The Product menu: one column per group of products, then the add-ons and capabilities. */
export function productMenu(): NavMenu {
  return {
    label: "Product",
    columns: [...PRODUCT_LINE_GROUPS.map((g) => ({ title: g.title, items: g.entries.map(item) })), { title: "Add-ons & capabilities", items: addOnItems() }],
    footer: { label: "See every module", href: "/product" },
  };
}

/**
 * The footer's product columns. Twelve products and their add-ons don't fit one column (ten links at
 * most), so there are two, split along the Product menu's groups: the suite and the products that sell
 * and serve, with every module and pricing; then the products that run the business and look after its
 * people, with the add-ons.
 */
export function productFooterColumns(): SiteSettings["footer"]["columns"] {
  const links = (titles: string[]) =>
    PRODUCT_LINE_GROUPS.filter((g) => titles.includes(g.title)).flatMap((g) => g.entries.map((e) => ({ label: e.label, href: e.path })));
  return [
    {
      title: "Products",
      links: [...links([PRODUCT_GROUP_TITLES.suite, PRODUCT_GROUP_TITLES.sell]), { label: "Every module", href: "/product" }, { label: "Pricing", href: "/pricing" }],
    },
    {
      title: "More products",
      links: [
        ...links([PRODUCT_GROUP_TITLES.run, PRODUCT_GROUP_TITLES.people]),
        ...ADD_ONS.flatMap((a) => (ADD_ON_PAGES[a.key] ? [{ label: a.name, href: ADD_ON_PAGES[a.key]! }] : [])),
      ],
    },
  ];
}

export function siteNav(options: { partnerPortal: string }): { nav: NavItem[]; footer: SiteSettings["footer"] } {
  const product = productMenu();
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
      ...productFooterColumns(),
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
