/**
 * check:accounts-nav — Finance → Accounts (owner, 22 Oct 2026).
 *
 *   · Every finance module's pages sit in one group, Accounts, under the Finance heading — sales and purchase
 *     documents, orders, items and stock, payments, receivables and payables, the ledger and the close. No
 *     separate Accounting, Inventory, Billing, Stock, GST, Banking or Payments group is left.
 *   · The group is drawn in parts, in ACCOUNTS_SECTIONS order, whichever module a page comes from; the part
 *     holding the page you're on starts open; a breadcrumb names Finance › Accounts › part › page.
 *   · Each new page's link asks the permission its page and actions ask — and every link leads to a page.
 *
 * No database: the menu is built from the registry and a person's permissions, as the layout builds it.
 *
 *   npm run check:accounts-nav
 */
import { existsSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let pathname = "/dashboard";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => pathname,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

async function main() {
  const { ACCOUNTS_SECTIONS, MODULE_REGISTRY, NAV_GROUP_ORDER, getModuleDefinition } = await import("../src/lib/modules");
  const { buildNavigation, headedNavigation, openModuleKeys, sectionRank } = await import("../src/lib/navigation");
  const { PERMISSIONS, PERMISSION_KEYS } = await import("../src/lib/permissions");
  const { Sidebar } = await import("../src/components/layout/sidebar");
  const { NavBreadcrumb } = await import("../src/components/layout/nav-breadcrumb");
  const { DEFAULT_BRANDING } = await import("../src/lib/branding");

  const SECTIONS = PERMISSIONS.filter((p) => p.everyone).map((p) => p.key as string);
  const menu = (holds: string[], country = "IN") =>
    buildNavigation({
      openModules: openModuleKeys(() => ({ entitled: true, switchedOn: true }), new Set(holds)).filter((key) => {
        const def = getModuleDefinition(key);
        return !def?.countries || def.countries.includes(country);
      }),
      permissions: holds,
      country,
    });
  const hrefs = (nav: ReturnType<typeof menu>) => nav.flatMap((s) => s.items.map((i) => i.href));
  const accounts = (nav: ReturnType<typeof menu>) => nav.find((s) => s.group === "Accounts");

  section("One group for finance");
  const FINANCE = ["sales_documents", "purchase_documents", "items", "orders", "payments", "receivables", "payables", "accounting", "revenue_close"];
  ok("every finance module is in Accounts", FINANCE.every((k) => getModuleDefinition(k)?.navGroup === "Accounts"), FINANCE.filter((k) => getModuleDefinition(k)?.navGroup !== "Accounts"));
  ok("renewals has its own group", getModuleDefinition("renewals")?.navGroup === "Renewals");
  const RETIRED = ["Accounting", "Inventory", "Billing", "Stock", "GST", "Banking", "Payments", "Purchase", "Quotes & Invoices", "Catalog & Stock", "Orders & Renewals"];
  ok("no separate Accounting, Inventory, Billing, Stock, GST, Banking or Payments group", !RETIRED.some((g) => (NAV_GROUP_ORDER as readonly string[]).includes(g) || MODULE_REGISTRY.some((m) => m.navGroup === g)));
  const accountItems = MODULE_REGISTRY.filter((m) => m.navGroup === "Accounts").flatMap((m) => m.navItems);
  ok("every Accounts link names its part", accountItems.every((i) => i.section && (ACCOUNTS_SECTIONS as readonly string[]).includes(i.section)), accountItems.filter((i) => !i.section).map((i) => i.href));
  ok("and no other group's link does", MODULE_REGISTRY.filter((m) => m.navGroup !== "Accounts").every((m) => m.navItems.every((i) => !i.section)));

  section("Everything, for somebody holding everything");
  const all = menu([...PERMISSION_KEYS]);
  const group = accounts(all);
  ok("one Accounts group", all.filter((s) => s.group === "Accounts").length === 1);
  const headed = headedNavigation(all);
  ok("under the Finance heading, alone", headed.find((h) => h.heading === "Finance")?.sections.map((s) => s.group).join(",") === "Accounts", headed.map((h) => `${h.heading}:${h.sections.map((s) => s.group).join("/")}`).join(" | "));
  const ranks = (group?.items ?? []).map((i) => sectionRank(i.section));
  ok("its links in the parts' order", ranks.every((r, i) => i === 0 || ranks[i - 1]! <= r), (group?.items ?? []).map((i) => i.section).join(","));
  const parts = [...new Set((group?.items ?? []).map((i) => i.section))];
  ok("every part has something in it", ACCOUNTS_SECTIONS.every((p) => parts.includes(p)), ACCOUNTS_SECTIONS.filter((p) => !parts.includes(p)));
  const NEW = ["/accounting/vouchers", "/accounting/day-book", "/accounting/cash-book", "/accounting/registers", "/items/stock", "/items/receipts", "/items/warehouses", "/items/units", "/items/stock-reports", "/items/settings"];
  ok("the new pages are in it", NEW.every((h) => hrefs(all).includes(h)), NEW.filter((h) => !hrefs(all).includes(h)));
  const pageFile = (href: string) => path.join(process.cwd(), "src/app/(dashboard)", href, "page.tsx");
  const everyHref = MODULE_REGISTRY.filter((m) => m.navGroup === "Accounts").flatMap((m) => m.navItems.map((i) => i.href));
  ok("every Accounts link leads to a page", everyHref.every((h) => existsSync(pageFile(h))), everyHref.filter((h) => !existsSync(pageFile(h))));

  section("Each link for whoever its page is for");
  const inventoryReader = hrefs(menu(["inventory.view", ...SECTIONS]));
  ok("stock reader: stock vouchers, reports, warehouses, units", ["/items/stock", "/items/stock-reports", "/items/warehouses", "/items/units", "/items/receipts"].every((h) => inventoryReader.includes(h)));
  ok("  not settings, vouchers or the ledger's pages", !inventoryReader.includes("/items/settings") && !inventoryReader.some((h) => h.startsWith("/accounting")));
  const plain = hrefs(menu(SECTIONS));
  ok("nobody's permissions: items, but none of the stock pages", plain.includes("/items") && !["/items/stock", "/items/receipts", "/items/warehouses", "/items/units", "/items/stock-reports", "/items/settings"].some((h) => plain.includes(h)));
  const receiver = hrefs(menu(["inventory.receive", ...SECTIONS]));
  ok("a receiver gets goods receipts and stock vouchers", receiver.includes("/items/receipts") && receiver.includes("/items/stock"));
  const configurer = hrefs(menu(["accounts.configure", ...SECTIONS]));
  ok("Configure Accounts opens settings", configurer.includes("/items/settings"));
  const ledgerReader = hrefs(menu(["ledger.viewReports", ...SECTIONS]));
  ok("a ledger reader: vouchers, day book, registers, cash & bank books", ["/accounting/vouchers", "/accounting/day-book", "/accounting/registers", "/accounting/cash-book"].every((h) => ledgerReader.includes(h)));
  ok("  but not settings or stock vouchers", !ledgerReader.includes("/items/settings") && !ledgerReader.includes("/items/stock"));
  const voucherClerk = hrefs(menu(["vouchers.create", ...SECTIONS]));
  ok("a voucher clerk sees Vouchers, not the statements", voucherClerk.includes("/accounting/vouchers") && !voucherClerk.includes("/accounting/trial-balance"));
  const abroad = menu([...PERMISSION_KEYS], "AE");
  ok("abroad: Accounts without the ledger's India-only pages", !!accounts(abroad) && !hrefs(abroad).some((h) => h.startsWith("/accounting")) && hrefs(abroad).includes("/items/stock"));

  section("Drawn: parts and the breadcrumb");
  pathname = "/items/stock/abc123";
  const crumb = renderToStaticMarkup(createElement(NavBreadcrumb, { navigation: all }));
  const words = [...crumb.matchAll(/>([^<>]+)</g)].map((m) => m[1]);
  ok("a stock voucher's breadcrumb: Finance › Accounts › Inventory › Stock vouchers", ["Finance", "Accounts", "Inventory", "Stock vouchers"].every((w) => words.includes(w)) && crumb.includes('href="/items/stock"'), words.join(" › "));
  pathname = "/items/stock";
  ok("  on the page itself, the last crumb is the current page", renderToStaticMarkup(createElement(NavBreadcrumb, { navigation: all })).includes('aria-current="page"'));
  pathname = "/leads";
  ok("  and none outside Accounts", renderToStaticMarkup(createElement(NavBreadcrumb, { navigation: all })) === "");
  pathname = "/items/stock";
  const side = renderToStaticMarkup(createElement(Sidebar, { navigation: all, branding: DEFAULT_BRANDING }));
  // Inventory is one page today, so it is drawn as its link; Accounts itself is open at it.
  ok("the sidebar opens Accounts at the stock vouchers", /aria-expanded="true"[^>]*>(?:(?!<\/button>).)*Accounts/.test(side) && side.includes('href="/items/stock"'));
  ok("  with the other parts folded", /aria-expanded="false"[^>]*>(?:(?!<\/button>).)*Reports/.test(side) && !side.includes('href="/accounting/trial-balance"'));
  pathname = "/accounting/day-book";
  const reports = renderToStaticMarkup(createElement(Sidebar, { navigation: all, branding: DEFAULT_BRANDING }));
  ok("  on a report, its Reports part is open and Masters folded", /aria-expanded="true"[^>]*>(?:(?!<\/button>).)*Reports/.test(reports) && /aria-expanded="false"[^>]*>(?:(?!<\/button>).)*Masters/.test(reports) && reports.includes('href="/accounting/trial-balance"'));
  pathname = "/accounting";
  const overview = renderToStaticMarkup(createElement(Sidebar, { navigation: all, branding: DEFAULT_BRANDING }));
  ok("  a one-page part (Overview) is a plain link", overview.includes('href="/accounting"') && !/aria-expanded="[a-z]+"[^>]*>(?:(?!<\/button>).)*>Overview</.test(overview));

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
