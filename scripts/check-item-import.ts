/**
 * The item import and the catalogue behind it.
 *
 *   · Every attribute on the item form comes in through the import — brand, product family and
 *     HSN/SAC included — with headers matched loosely.
 *   · Brands and families are matched by name, case and spacing ignored, and created once when a
 *     file names one that isn't there — but only by someone who manages the catalogue.
 *   · A column the file doesn't have leaves the field alone; a blank cell clears it.
 *   · An export comes back in unchanged.
 *   · The Brands page pages and searches, lives under Items & Inventory, and is read-only without
 *     `catalog.manage`; Settings → Lists points at it.
 *
 * Everything is named ZZPROBE_ITEMS and removed in a finally.
 *
 *   npm run check:item-import
 */
import "dotenv/config";
import Module from "node:module";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import Papa from "papaparse";
import { directClient } from "../src/lib/tenancy/direct-client";
import { canonicalColumn, hsnIssue, nameKey } from "../src/lib/items/catalogue-import";
import { createItemSchema } from "../src/lib/validation/item";
import { MODULE_REGISTRY } from "../src/lib/modules";
import { PERMISSIONS } from "../src/lib/permissions";
import { DEFAULT_BRANDING } from "../src/lib/branding";

let actorId = "";
let pathname = "/items";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "PROFILE", name: "Zzprobe Items", email: `x${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user() };
  }
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

const db = directClient();
const TAG = "ZZPROBE_ITEMS";
const MAIL = "@zzprobe-items.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

/** A server component tree with its nested async components awaited, so it can be rendered. */
async function resolveAsync(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: unknown }>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    return resolveAsync(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
  }
  if (el.props && "children" in el.props) {
    // Passed as arguments, not as a `children` array, so React does not ask for keys it never needed.
    const kids = await resolveAsync(el.props.children);
    return Array.isArray(kids)
      ? cloneElement(el, undefined, ...(kids as ReactNode[]))
      : cloneElement(el, undefined, kids as ReactNode);
  }
  return el;
}

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  await db.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  const items = await db.item.findMany({ where: { sku: { startsWith: TAG } }, select: { id: true } });
  await db.stockMovement.deleteMany({ where: { itemId: { in: items.map((i) => i.id) } } });
  await db.item.deleteMany({ where: { id: { in: items.map((i) => i.id) } } });
  await db.brand.deleteMany({ where: { name: { startsWith: TAG, mode: "insensitive" } } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  section("The rules, without a database");

  ok("HSN/SAC of 4, 6 or 8 digits is accepted", [ "8471", "847130", "84713010", ""].every((c) => hsnIssue(c) === null));
  ok("  including the spaced and dotted forms people copy", hsnIssue("8471 30 10") === null && hsnIssue("9983.13") === null);
  ok("  and anything else is not", ["84713", "847", "84A1", "847130101"].every((c) => hsnIssue(c) !== null));
  const parsedHsn = createItemSchema.safeParse({ name: "Zz", sku: "Z", type: "GOOD", sellingPrice: 1, hsnCode: "8471 30 10" });
  ok("the item form stores it without the spaces", parsedHsn.success && parsedHsn.data.hsnCode === "84713010");
  ok("  and refuses a malformed one", !createItemSchema.safeParse({ name: "Zz", sku: "Z", type: "GOOD", sellingPrice: 1, hsnCode: "12345" }).success);
  const headers: Record<string, string> = {
    "Selling Price": "sellingPrice",
    "HSN/SAC": "hsnCode",
    "Product Family": "productFamily",
    Make: "brand",
    UOM: "unit",
    "GST Rate": "taxRatePercent",
    selling_price: "sellingPrice",
    itemId: "itemId",
  };
  const wrongHeaders = Object.entries(headers).filter(([h, want]) => canonicalColumn(h) !== want);
  ok("headers as a spreadsheet writes them are understood", wrongHeaders.length === 0, wrongHeaders.map(([h]) => `${h}→${canonicalColumn(h)}`).join(", "));
  ok("names compare without case or extra spaces", nameKey("  Microsoft   365 ") === nameKey("microsoft 365"));

  /* eslint-disable @typescript-eslint/no-require-imports */
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const itemActions = require("../src/actions/item") as typeof import("../src/actions/item");
  const brandActions = require("../src/actions/brand") as typeof import("../src/actions/brand");
  const moduleActions = require("../src/actions/module") as typeof import("../src/actions/module");
  const BrandsPage = (require("../src/app/(dashboard)/items/brands/page") as { default: (p: unknown) => Promise<ReactElement> }).default;
  const ListsPage = (require("../src/app/(dashboard)/settings/lists/page") as { default: () => Promise<ReactElement> }).default;
  const { Sidebar } = require("../src/components/layout/sidebar") as typeof import("../src/components/layout/sidebar");
  const { buildNavigation, openModuleKeys } = require("../src/lib/navigation") as typeof import("../src/lib/navigation");
  // The menu as the layout builds it, for a workspace with every module on: the same pure rule over
  // the permissions given, then drawn by the sidebar.
  const menuFor = (permissions: string[]) =>
    buildNavigation({ openModules: openModuleKeys(() => ({ entitled: true, switchedOn: true }), new Set(permissions)), permissions, country: "IN" });

  const importCsv = async (rows: string[]) => {
    const form = new FormData();
    form.set("file", new File([rows.join("\n")], "items.csv", { type: "text/csv" }));
    const res = await itemActions.importItems(form);
    if (!res.ok) throw new Error(`import refused: ${res.error}`);
    return res.data;
  };
  const item = (sku: string) =>
    db.item.findUnique({ where: { sku }, select: { id: true, brandId: true, productFamilyId: true, hsnCode: true, sellingPrice: true } });
  const brandsNamed = (name: string) => db.brand.count({ where: { name: { equals: name, mode: "insensitive" } } });

  await cleanup();
  try {
    const make = (name: string, manage: boolean, extra: string[] = []) =>
      db.user.create({
        data: {
          name: `Zzprobe ${name}`,
          email: `${name}${MAIL}`,
          role: "PROFILE",
          passwordHash: "x".repeat(60),
          permissionGrants: {
            create: [
              { permission: "catalog.manage", allowed: manage, reason: TAG },
              ...extra.map((permission) => ({ permission, allowed: true, reason: TAG })),
            ],
          },
        },
      });
    // Settings → Lists is rendered too, and that page is `settings.manage`'s.
    const keeper = await make("keeper", true, ["settings.manage"]);
    const reader = await make("reader", false);
    actorId = keeper.id;
    if (!(await moduleActions.isModuleEnabled("items"))) throw new Error("The Items module is switched off on this database — switch it on to run this suite.");

    const dell = await db.brand.create({ data: { name: `${TAG} Dell`, families: { create: [{ name: "Latitude" }] } }, include: { families: true } });
    const latitude = dell.families[0]!;

    section("Brand, family and HSN come in with the items");

    const first = await importCsv([
      "Name,SKU,Type,Brand,Product Family,HSN/SAC,Selling Price,GST Rate",
      `ZZ Laptop,${TAG}-1,GOOD,${TAG.toLowerCase()}   dell,LATITUDE,8471 30 10,1000,18`,
      `ZZ Laptop 2,${TAG}-2,GOOD,${TAG} Newco,Alpha Line,847130,2000,18`,
      `ZZ Laptop 3,${TAG}-3,GOOD,${TAG.toLowerCase()} newco,alpha line,,3000,18`,
      `ZZ Orphan,${TAG}-4,GOOD,,Beta Line,,10,18`,
      `ZZ Bad HSN,${TAG}-5,GOOD,${TAG} Newco,,12345,10,18`,
    ]);
    ok("three items are created and two rows refused", first.created === 3 && first.errors.length === 2, JSON.stringify(first.errors));
    ok("  a family with no brand is refused, naming it", first.errors.some((e) => e.row === 5 && e.message.includes("Beta Line")));
    ok("  and a malformed HSN/SAC", first.errors.some((e) => e.row === 6 && e.message.includes("HSN")));
    const i1 = await item(`${TAG}-1`);
    ok("an existing brand and family are matched whatever the case and spacing", i1?.brandId === dell.id && i1.productFamilyId === latitude.id);
    ok("  and the HSN/SAC is stored without its spaces", i1?.hsnCode === "84713010", i1?.hsnCode);
    ok("a brand the catalogue lacks is created once, not once per row", (await brandsNamed(`${TAG} Newco`)) === 1 && first.brandsCreated.length === 1, first.brandsCreated.join(", "));
    ok("  and its family likewise", first.familiesCreated.length === 1 && first.familiesCreated[0] === `${TAG} Newco → Alpha Line`, first.familiesCreated.join(", "));
    const [i2, i3] = await Promise.all([item(`${TAG}-2`), item(`${TAG}-3`)]);
    ok("  and both rows land on the same brand and family", !!i2?.brandId && i2.brandId === i3?.brandId && !!i2.productFamilyId && i2.productFamilyId === i3?.productFamilyId);
    ok("no brand was made for the refused rows", (await db.brand.count({ where: { name: { startsWith: TAG, mode: "insensitive" } } })) === 2);

    section("A column the file doesn't have is left alone; a blank one clears");

    const pricesOnly = await importCsv(["name,sku,type,sellingPrice", `ZZ Laptop,${TAG}-1,GOOD,1500`]);
    const afterPrices = await item(`${TAG}-1`);
    ok(
      "a price-only sheet updates the price and keeps brand, family and HSN",
      pricesOnly.updated === 1 && Number(afterPrices?.sellingPrice) === 1500 && afterPrices?.brandId === dell.id && afterPrices.productFamilyId === latitude.id && afterPrices.hsnCode === "84713010",
    );
    await importCsv(["name,sku,type,brand,productFamily,hsnCode,sellingPrice", `ZZ Laptop,${TAG}-1,GOOD,,,,1500`]);
    const cleared = await item(`${TAG}-1`);
    ok("blank cells in present columns clear them", cleared?.brandId === null && cleared.productFamilyId === null && cleared.hsnCode === null);
    await importCsv(["name,sku,type,brand,sellingPrice", `ZZ Laptop 2,${TAG}-2,GOOD,${TAG} Dell,2000`]);
    const moved = await item(`${TAG}-2`);
    ok("moving an item to another brand drops the old brand's family", moved?.brandId === dell.id && moved.productFamilyId === null);
    const gamma = await importCsv(["name,sku,type,productFamily,sellingPrice", `ZZ Laptop 3,${TAG}-3,GOOD,Gamma Line,3000`]);
    const i3b = await item(`${TAG}-3`);
    ok(
      "a family alone is found under the item's existing brand",
      gamma.familiesCreated[0] === `${TAG} Newco → Gamma Line` && i3b?.brandId === i3?.brandId && i3b?.productFamilyId !== i3?.productFamilyId,
      gamma.familiesCreated.join(", "),
    );

    section("Without catalog.manage, the catalogue is not added to");

    actorId = reader.id;
    const limited = await importCsv([
      "name,sku,type,brand,productFamily,sellingPrice",
      `ZZ Unknown,${TAG}-6,GOOD,${TAG} Unknownco,,10`,
      `ZZ Known,${TAG}-7,GOOD,${TAG} DELL,latitude,10`,
      `ZZ New family,${TAG}-8,GOOD,${TAG} Dell,Vostro,10`,
    ]);
    ok("a row naming a brand that isn't there is refused, by name", limited.errors.some((e) => e.row === 2 && e.message.includes("Unknownco")) && (await brandsNamed(`${TAG} Unknownco`)) === 0);
    ok("  as is one naming a family that isn't there", limited.errors.some((e) => e.row === 4 && e.message.includes("Vostro")) && (await db.productFamily.count({ where: { name: "Vostro", brandId: dell.id } })) === 0);
    const i7 = await item(`${TAG}-7`);
    ok("  and a row naming ones that are goes in", limited.created === 1 && i7?.brandId === dell.id && i7.productFamilyId === latitude.id);
    ok("  and nothing was reported as added", limited.brandsCreated.length === 0 && limited.familiesCreated.length === 0);

    section("An export comes back in unchanged");

    actorId = keeper.id;
    const exported = await itemActions.exportItemsCsv();
    if (!exported.ok) throw new Error(exported.error);
    const exportRows = Papa.parse<Record<string, string>>(exported.data.csv, { header: true, skipEmptyLines: true });
    const fields = exportRows.meta.fields ?? [];
    ok("the export carries brand, product family and HSN/SAC", ["brand", "productFamily", "hsnCode"].every((f) => fields.includes(f)), fields.join(","));
    // Only this suite's rows go back in — the export is the whole catalogue of a live database.
    const ours = exportRows.data.filter((r) => r.sku?.startsWith(TAG));
    const before = await db.item.findMany({ where: { sku: { startsWith: TAG } }, orderBy: { sku: "asc" }, select: { sku: true, brandId: true, productFamilyId: true, hsnCode: true } });
    const back = await importCsv(Papa.unparse(ours).split(/\r?\n/));
    const after = await db.item.findMany({ where: { sku: { startsWith: TAG } }, orderBy: { sku: "asc" }, select: { sku: true, brandId: true, productFamilyId: true, hsnCode: true } });
    ok(
      "re-importing it updates every row and changes nothing",
      back.created === 0 && back.updated === ours.length && back.errors.length === 0 && JSON.stringify(before) === JSON.stringify(after),
      back.errors.map((e) => e.message).join("; "),
    );
    ok("  and adds no brands", back.brandsCreated.length === 0 && back.familiesCreated.length === 0);

    section("The item form");

    const made = await itemActions.createItem({ name: "ZZ Service", sku: `${TAG}-9`, type: "SERVICE", sellingPrice: 100, hsnCode: "9983 13" });
    ok("an item is created with its SAC code", made.ok && (await item(`${TAG}-9`))?.hsnCode === "998313");
    const bad = await itemActions.createItem({ name: "ZZ Service 2", sku: `${TAG}-10`, type: "SERVICE", sellingPrice: 100, hsnCode: "99" });
    ok("  and refused with a malformed one", !bad.ok && (await item(`${TAG}-10`)) === null);

    section("Brands: case-blind names, paging and search");

    const dupe = await brandActions.createBrand({ name: `${TAG.toLowerCase()}   newco` });
    ok("a brand differing only in case is refused", !dupe.ok && (await brandsNamed(`${TAG} Newco`)) === 1, dupe.ok ? "created" : dupe.error);
    await db.brand.createMany({ data: Array.from({ length: 30 }, (_, i) => ({ name: `${TAG} Page ${String(i + 1).padStart(2, "0")}` })) });
    const omega = await db.brand.findFirstOrThrow({ where: { name: `${TAG} Page 07` } });
    await db.productFamily.create({ data: { brandId: omega.id, name: "Zzfamily Omega" } });
    const page1 = await brandActions.listBrandsPaged({ q: TAG, page: 1, pageSize: 25 });
    const page2 = await brandActions.listBrandsPaged({ q: TAG, page: 2, pageSize: 25 });
    ok("a thousand-brand catalogue is read a page at a time", page1.rows.length === 25 && page1.total === 32 && page2.rows.length === 7, `${page1.rows.length}/${page2.rows.length} of ${page1.total}`);
    const byFamily = await brandActions.listBrandsPaged({ q: "Zzfamily Omega", page: 1, pageSize: 25 });
    ok("searching a family's name finds its brand", byFamily.total === 1 && byFamily.rows[0]?.id === omega.id);

    section("The Brands page, and where it lives");

    const html = (el: unknown) => renderToStaticMarkup(el as ReactElement);
    const asKeeper = html(await resolveAsync(await BrandsPage({ searchParams: Promise.resolve({ q: TAG }) })));
    ok("it lists this page of brands with their families and counts", asKeeper.includes(`${TAG} Dell`) && asKeeper.includes("Latitude") && asKeeper.includes("32 brand(s)"));
    ok("  with the pager counting them", asKeeper.includes("of 32 brands"));
    const small = html(await resolveAsync(await BrandsPage({ searchParams: Promise.resolve({ q: TAG, pageSize: "25", page: "2" }) })));
    ok("  and page 2 holds the rest", small.includes("26–32 of 32 brands") && small.includes(`${TAG} Page 30`) && !small.includes(`${TAG} Dell<`));
    ok("  and offers adding and renaming to someone who manages the catalogue", asKeeper.includes('aria-label="New brand name"') && asKeeper.includes("Rename brand"));
    actorId = reader.id;
    const asReader = html(await resolveAsync(await BrandsPage({ searchParams: Promise.resolve({ q: TAG }) })));
    ok("  and not to someone who doesn't", asReader.includes(`${TAG} Dell`) && !asReader.includes('aria-label="New brand name"') && !asReader.includes("Rename brand"));
    actorId = keeper.id;

    const lists = html(await resolveAsync(await ListsPage()));
    ok("Settings → Lists no longer manages brands, and says where they went", !lists.includes('aria-label="New brand name"') && lists.includes('href="/items/brands"'));

    ok("the Brands page is a link under Items & Inventory", MODULE_REGISTRY.find((m) => m.key === "items")?.navItems.some((n) => n.href === "/items/brands") === true);
    pathname = "/items/brands";
    const nav = renderToStaticMarkup(
      // The sections every role holds until unticked — without them the menu shows nothing (owner, 8 Oct 2026).
      createElement(Sidebar, { navigation: menuFor(PERMISSIONS.filter((d) => d.everyone).map((d) => d.key)), branding: DEFAULT_BRANDING }),
    );
    const current = [...nav.matchAll(/<a [^>]*href="([^"]+)"[^>]*aria-current="page"|<a [^>]*aria-current="page"[^>]*href="([^"]+)"/g)].map((m) => m[1] ?? m[2]);
    ok("  and on it, it alone is marked as where you are", current.length === 1 && current[0] === "/items/brands", current.join(", "));
  } finally {
    await cleanup();
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll item-import checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
