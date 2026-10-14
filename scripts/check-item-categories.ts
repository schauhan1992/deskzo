/**
 * Item categories and "manage as a subscription".
 *
 *   · the list (Items › Categories): added once whatever the case, renamed on every item in it, and
 *     not deleted while an item is in it — only by somebody who manages the catalogue;
 *   · an item's category is one from the list, stored as the list spells it;
 *   · a perpetual licence is a service in the "Perpetual licence" category — from an old form value or
 *     an old spreadsheet alike;
 *   · an item is managed as a subscription only where Renewals is in the plan and switched on: a new
 *     one, a change to one, a bulk change and an import row are refused without it, and an item that
 *     already renews is kept.
 *
 * Everything it makes is named ZZPROBE_CAT and removed after; the Renewals switch it turns off for a
 * moment is put back as it was.
 *
 *   npm run check:item-categories
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";
import { PERPETUAL_CATEGORY } from "../src/lib/validation/item";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "PROFILE", name: "Zzprobe Categories", email: `x${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user() };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_CAT";
const MAIL = "@zzprobe-cat.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "it went through" : (r.error ?? ""));

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  await db.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  const items = await db.item.findMany({ where: { sku: { startsWith: TAG } }, select: { id: true } });
  await db.stockMovement.deleteMany({ where: { itemId: { in: items.map((i) => i.id) } } });
  await db.item.deleteMany({ where: { id: { in: items.map((i) => i.id) } } });
  await db.itemCategory.deleteMany({ where: { name: { startsWith: TAG, mode: "insensitive" } } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

/** A CSV as the import dialog sends it. */
function csv(lines: string[]): FormData {
  const form = new FormData();
  form.set("file", new File([lines.join("\n")], "items.csv", { type: "text/csv" }));
  return form;
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const categories = require("../src/actions/item-category") as typeof import("../src/actions/item-category");
  const items = require("../src/actions/item") as typeof import("../src/actions/item");
  const { closeRefDb } = require("../src/lib/platform/reference-db") as typeof import("../src/lib/platform/reference-db");
  /* eslint-enable @typescript-eslint/no-require-imports */

  await cleanup();
  const renewalsSwitch = await db.systemModule.findUnique({ where: { key: "renewals" } });
  try {
    const person = (key: string, manage: boolean) =>
      db.user.create({
        data: {
          name: `Zzprobe ${key}`,
          email: `${key}${MAIL}`,
          role: "PROFILE",
          passwordHash: "x".repeat(60),
          permissionGrants: { create: [{ permission: "catalog.manage", allowed: manage, reason: TAG }] },
        },
      });
    const keeper = await person("keeper", true);
    const reader = await person("reader", false);
    const item = (sku: string) => db.item.findUnique({ where: { sku } });

    section("The list");

    actorId = reader.id;
    const notAllowed = await categories.createItemCategory(`${TAG} Laptops`);
    ok("only somebody who manages the catalogue adds a category", !notAllowed.ok, errorOf(notAllowed));
    actorId = keeper.id;
    const laptops = await categories.createItemCategory(`  ${TAG}   Laptops `);
    ok("a category is added, its spaces tidied", laptops.ok && laptops.data.name === `${TAG} Laptops`, laptops.ok ? laptops.data.name : laptops.error);
    const twice = await categories.createItemCategory(`${TAG.toLowerCase()} laptops`);
    ok("  and the same name in another case is the same category", !twice.ok && twice.error.includes("already"), errorOf(twice));
    ok("every workspace has the Perpetual licence category", (await db.itemCategory.count({ where: { name: PERPETUAL_CATEGORY } })) === 1);
    if (!laptops.ok) throw new Error("the fixture category wasn't created");

    section("An item's category");

    const base = { name: "Zz Laptop", type: "GOOD" as const, sellingPrice: 1000, hsnCode: "84713010" };
    const offList = await items.createItem({ ...base, sku: `${TAG}-1`, category: `${TAG} Tablets` });
    ok("a category that isn't on the list is refused", !offList.ok && offList.error.includes("isn't one of your item categories"), errorOf(offList));
    const onList = await items.createItem({ ...base, sku: `${TAG}-1`, category: `${TAG.toLowerCase()}  LAPTOPS` });
    ok("one that is goes in, as the list spells it", onList.ok && (await item(`${TAG}-1`))?.category === `${TAG} Laptops`, (await item(`${TAG}-1`))?.category);
    const oldForm = await items.createItem({ ...base, sku: `${TAG}-2`, type: "PERPETUAL", hsnCode: "997331" });
    ok("an old form's perpetual licence is saved as a service", oldForm.ok && (await item(`${TAG}-2`))?.type === "SERVICE", errorOf(oldForm));

    const renamed = await categories.renameItemCategory(laptops.data.id, `${TAG} Notebooks`);
    ok("renaming a category renames it on its items", renamed.ok && renamed.data.items === 1 && (await item(`${TAG}-1`))?.category === `${TAG} Notebooks`, errorOf(renamed));
    const inUse = await categories.deleteItemCategory(laptops.data.id);
    ok("a category with items in it isn't deleted, and says how many", !inUse.ok && inUse.error.includes("1 item is still in"), errorOf(inUse));
    const spare = await categories.createItemCategory(`${TAG} Spare`);
    const gone = spare.ok ? await categories.deleteItemCategory(spare.data.id) : spare;
    ok("  an empty one is", gone.ok && (await db.itemCategory.count({ where: { name: `${TAG} Spare` } })) === 0, errorOf(gone));
    const counted = (await categories.listItemCategoriesWithCounts()).find((c) => c.name === `${TAG} Notebooks`);
    ok("the Categories page counts each one's items", counted?.items === 1, counted?.items);

    section("Importing");

    const imported = await items.importItems(
      csv([
        "Name,SKU,Type,Category,HSN/SAC,Selling Price",
        `Zz Office 2024,${TAG}-3,PERPETUAL,,997331,100`,
        `Zz Desktop,${TAG}-4,GOOD,${TAG} Desktops,84714190,100`,
      ]),
    );
    ok("an old spreadsheet's perpetual licence comes in as a service in that category", (await item(`${TAG}-3`))?.type === "SERVICE" && (await item(`${TAG}-3`))?.category === PERPETUAL_CATEGORY, JSON.stringify(imported));
    ok("  and a category the file names that isn't on the list is added, by name", imported.ok && imported.data.categoriesCreated.includes(`${TAG} Desktops`));
    actorId = reader.id;
    const limited = await items.importItems(csv(["Name,SKU,Type,Category,HSN/SAC,Selling Price", `Zz Server,${TAG}-5,GOOD,${TAG} Servers,84714190,100`]));
    ok("  but not by somebody who doesn't manage the catalogue", limited.ok && limited.data.created === 0 && limited.data.errors.some((e) => e.message.includes(`${TAG} Servers`)), JSON.stringify(limited));
    actorId = keeper.id;

    section("Managed as a subscription");

    const subscription = await items.createItem({ name: "Zz 365", sku: `${TAG}-6`, type: "SUBSCRIPTION", sellingPrice: 500, hsnCode: "997331" });
    ok("with Renewals, a service can be a subscription", subscription.ok, errorOf(subscription));
    await db.systemModule.upsert({ where: { key: "renewals" }, create: { key: "renewals", enabled: false }, update: { enabled: false } });
    const without = await items.createItem({ name: "Zz 365 b", sku: `${TAG}-7`, type: "SUBSCRIPTION", sellingPrice: 500, hsnCode: "997331" });
    ok("without it, a new subscription is refused, saying why", !without.ok && without.error.includes("needs Renewals"), errorOf(without));
    const stillRenews = subscription.ok ? await items.updateItem({ id: subscription.data.id, name: "Zz 365 renamed", sku: `${TAG}-6`, type: "SUBSCRIPTION", sellingPrice: 500, hsnCode: "997331" }) : subscription;
    ok("  one that already renews is kept, and can be edited", stillRenews.ok && (await item(`${TAG}-6`))?.name === "Zz 365 renamed", errorOf(stillRenews));
    const madeOne = onList.ok ? await items.updateItem({ ...base, id: onList.data.id, sku: `${TAG}-1`, type: "SUBSCRIPTION", hsnCode: "997331" }) : onList;
    ok("  turning an item into one is refused", !madeOne.ok && madeOne.error.includes("needs Renewals"), errorOf(madeOne));
    const bulk = oldForm.ok ? await items.bulkUpdateItems({ itemIds: [oldForm.data.id], type: "SUBSCRIPTION" }) : oldForm;
    ok("  so is a bulk change", !bulk.ok && bulk.error.includes("needs Renewals"), errorOf(bulk));
    const row = await items.importItems(csv(["Name,SKU,Type,HSN/SAC,Selling Price", `Zz 365 c,${TAG}-8,SUBSCRIPTION,997331,500`]));
    ok("  and an import row", row.ok && row.data.created === 0 && row.data.errors.some((e) => e.message.includes("needs Renewals")), JSON.stringify(row));
  } finally {
    // The Renewals switch back as it was found.
    if (renewalsSwitch) await db.systemModule.update({ where: { key: "renewals" }, data: { enabled: renewalsSwitch.enabled } });
    else await db.systemModule.deleteMany({ where: { key: "renewals" } });
    await cleanup();
    await closeRefDb();
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll item-category checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
