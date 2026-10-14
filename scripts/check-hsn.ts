/**
 * HSN/SAC: the GST portal's directory, and what an item and a document line may carry.
 *
 *   · the rules without a database — required, 4/6/8 digits, goods take HSN and services SAC (99…),
 *     a subscription or perpetual licence being a service; the portal's sheet cleaned ("30559" is 030559);
 *   · the committed workbook (prisma/reference/hsn-sac.xlsx) parses into both sheets, with headings;
 *     a file that isn't the directory, or would halve it, is refused before anything is replaced;
 *   · the loaded directory answers: search by code and by words, narrowed to goods or services;
 *     whether a code is real; a document's lines; which items need their code fixed;
 *   · in an Indian workspace the item actions refuse a missing code, a code of the wrong kind and one
 *     the directory doesn't list, on create, update, bulk edit and import — and take a real one;
 *   · a line that names a product but arrives without a code gets the product's.
 *
 * Read-only against the directory — the load itself is the seed's (`npm run db:hsn`), and this suite
 * never replaces it. Everything it creates in the workspace is named ZZPROBE_HSN and removed after.
 *
 *   npm run check:hsn
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import Module from "node:module";
import ExcelJS from "exceljs";
import { directClient } from "../src/lib/tenancy/direct-client";
import { directoryCode, directoryDescription, hsnShapeIssue, kindOfCode, kindsForItemType, HSN_REQUIRED_MESSAGE } from "../src/lib/hsn";
import { REFERENCE_TABLES } from "../src/lib/reference-data";
import { COUNTRY_FEATURES } from "../src/lib/modules";
import { HSN_CANONICAL_FILE, hsnRefusalFor, parseHsnWorkbook, HsnFileRefused } from "../prisma/reference/hsn";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "PROFILE", name: "Zzprobe Hsn", email: `x${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user() };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_HSN";
const MAIL = "@zzprobe-hsn.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  await db.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  const items = await db.item.findMany({ where: { sku: { startsWith: TAG } }, select: { id: true } });
  await db.stockMovement.deleteMany({ where: { itemId: { in: items.map((i) => i.id) } } });
  await db.item.deleteMany({ where: { id: { in: items.map((i) => i.id) } } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

/** A workbook made here, for the refusals — never the directory. */
async function workbook(sheets: Record<string, (string | number)[][]>): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) wb.addWorksheet(name).addRows(rows);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

async function main() {
  section("The rules, without a database");

  ok("a blank code is refused as required", hsnShapeIssue("", "GOOD") === HSN_REQUIRED_MESSAGE);
  ok("  and one not 4, 6 or 8 digits as malformed", ["84", "84713", "847130101"].every((c) => hsnShapeIssue(c, "GOOD")?.includes("4, 6 or 8")));
  ok("SAC codes are the 99s, everything else HSN", kindOfCode("998313") === "SERVICES" && kindOfCode("8471") === "GOODS");
  ok("goods take HSN; a service — one-time, subscription or perpetual licence — SAC", JSON.stringify([kindsForItemType("GOOD"), kindsForItemType("SERVICE"), kindsForItemType("SUBSCRIPTION"), kindsForItemType("PERPETUAL")]) === JSON.stringify([["GOODS"], ["SERVICES"], ["SERVICES"], ["SERVICES"]]));
  ok("  so a good with a SAC is refused, saying why", hsnShapeIssue("997331", "GOOD")?.includes("SAC (services)") === true, hsnShapeIssue("997331", "GOOD"));
  ok("  and a service with an HSN", hsnShapeIssue("8471", "SERVICE")?.includes("starts with 99") === true);
  ok("  a subscription or licence with a SAC is fine", hsnShapeIssue("997331", "SUBSCRIPTION") === null && hsnShapeIssue("997331", "PERPETUAL") === null);
  ok("  and one with an HSN is refused, saying it is a service", hsnShapeIssue("85238020", "PERPETUAL")?.includes("a perpetual licence is a service") === true, hsnShapeIssue("85238020", "PERPETUAL"));
  ok("  and the spaces people copy codes with don't matter", hsnShapeIssue("8471 30 10", "GOOD") === null);
  ok("the portal's codes are cleaned: a dropped zero put back, a space taken out", directoryCode("30559") === "030559" && directoryCode("2307 00") === "230700" && directoryCode(9983) === "9983");
  ok("  and something that isn't a code is nothing", directoryCode("") === null && directoryCode("123456789") === null);
  ok("descriptions read the portal's ~ as a dash, one space at a time", directoryDescription("FISH~Dried,\r\n salted") === "FISH — Dried, salted");
  ok("HSN is India's: required and checked only in an Indian workspace", JSON.stringify(COUNTRY_FEATURES.hsn) === JSON.stringify(["IN"]));
  ok("the directory is reference data, which no reset removes", REFERENCE_TABLES.some((t) => t.table === "hsn_codes"));

  section("The portal's workbook");

  const parsed = await parseHsnWorkbook(readFileSync(HSN_CANONICAL_FILE));
  const byCode = new Map(parsed.rows.map((r) => [r.code, r]));
  const goods = parsed.rows.filter((r) => r.kind === "GOODS").length;
  const services = parsed.rows.filter((r) => r.kind === "SERVICES").length;
  ok("the committed copy parses into both sheets", goods > 20_000 && services > 600, `${goods} HSN, ${services} SAC, ${parsed.skipped} set aside`);
  ok("  every SAC starts with 99 and no HSN does", parsed.rows.every((r) => (r.kind === "SERVICES") === r.code.startsWith("99")));
  ok("  a personal computer is 84713010, under automatic data processing machines", byCode.get("84713010")?.description === "PERSONAL COMPUTER" && /AUTOMATIC DATA PROCESSING/.test(byCode.get("84713010")?.heading ?? ""));
  ok("  software licensing is 997331", /software/i.test(byCode.get("997331")?.description ?? ""));
  ok("  and the row the sheet printed as 30559 is filed as chapter 03's 030559, not a 5-digit code", !byCode.has("30559") && byCode.get("030559")?.heading?.startsWith("FISH") === true);
  const notAWorkbook = await parseHsnWorkbook(new TextEncoder().encode("code,description\n8471,Computers")).catch((e: unknown) => e);
  ok("a file that isn't a workbook is refused, in words", notAWorkbook instanceof HsnFileRefused && notAWorkbook.message.includes("Excel"));
  const otherSheet = await parseHsnWorkbook(await workbook({ Prices: [["Item", "Price"], ["Laptop", 1000]] })).catch((e: unknown) => e);
  ok("  and so is a workbook with no HSN_CD or SAC_CD column", otherSheet instanceof HsnFileRefused && otherSheet.message.includes("HSN_CD"));
  ok("a file with nothing usable, or less than half the codes, may not replace the directory", hsnRefusalFor(22_000, 0, false) !== null && hsnRefusalFor(22_000, 9_000, false) !== null);
  ok("  unless forced; a real update goes through", hsnRefusalFor(22_000, 9_000, true) === null && hsnRefusalFor(22_000, 21_950, false) === null);

  /* eslint-disable @typescript-eslint/no-require-imports */
  const dir = require("../src/lib/platform/hsn-directory") as typeof import("../src/lib/platform/hsn-directory");
  const itemActions = require("../src/actions/item") as typeof import("../src/actions/item");
  const { checkLineLinks } = require("../src/lib/documents/create-draft") as typeof import("../src/lib/documents/create-draft");
  const { closeRefDb } = require("../src/lib/platform/reference-db") as typeof import("../src/lib/platform/reference-db");
  /* eslint-enable @typescript-eslint/no-require-imports */

  await cleanup();
  try {
    section("The loaded directory");

    const state = await dir.readHsnDirectory();
    if (!state.loaded) throw new Error("The HSN/SAC directory isn't loaded on this machine — run npm run db:hsn first.");
    ok("it is loaded, both kinds", state.loaded.goods > 20_000 && state.loaded.services > 600, `${state.loaded.goods} HSN, ${state.loaded.services} SAC from ${state.loaded.source}`);
    const byDigits = await dir.searchHsnDirectory("8471");
    ok("digits match the start of a code", byDigits.length > 0 && byDigits.every((o) => o.code.startsWith("8471")), byDigits.slice(0, 3).map((o) => o.code).join(", "));
    ok("  and only codes an item can carry are offered — no 2-digit chapters", byDigits.every((o) => [4, 6, 8].includes(o.code.length)));
    const byWords = await dir.searchHsnDirectory("computer repair");
    ok("words match the description", byWords.some((o) => o.code === "998713"), byWords.map((o) => o.code).join(", "));
    const goodsOnly = await dir.searchHsnDirectory("software", ["GOODS"]);
    const servicesOnly = await dir.searchHsnDirectory("software", ["SERVICES"]);
    ok("  narrowed to goods for a good", goodsOnly.length > 0 && goodsOnly.every((o) => o.kind === "GOODS"));
    ok("  and to services for a service", servicesOnly.some((o) => o.code === "997331") && servicesOnly.every((o) => o.kind === "SERVICES"));
    ok("a query too short to mean anything finds nothing", (await dir.searchHsnDirectory("8")).length === 0);
    ok("a real code passes", (await dir.hsnIssue("84713010", "GOOD")) === null && (await dir.hsnIssue("9983 13", "SERVICE")) === null);
    ok("  a made-up one is refused as not in the directory", (await dir.hsnIssue("84719999", "GOOD"))?.includes("isn't in the GST portal's HSN/SAC directory") === true);
    ok("document lines: a blank code is the line's own business", (await dir.lineHsnRefusal([{ hsnCode: "" }, { hsnCode: "84713010" }])) === null);
    ok("  a malformed one is refused by line", (await dir.lineHsnRefusal([{ hsnCode: "8471" }, { hsnCode: "847" }]))?.startsWith("Line 2:") === true);
    ok("  and so is one the directory doesn't list", (await dir.lineHsnRefusal([{ hsnCode: "84719999" }]))?.startsWith("Line 1: 84719999 isn't") === true);

    section("Items, in an Indian workspace");

    const keeper = await db.user.create({
      data: {
        name: "Zzprobe Hsn keeper",
        email: `keeper${MAIL}`,
        role: "PROFILE",
        passwordHash: "x".repeat(60),
        permissionGrants: { create: [{ permission: "catalog.manage", allowed: true, reason: TAG }] },
      },
    });
    actorId = keeper.id;
    const item = (sku: string) => db.item.findUnique({ where: { sku } });
    const base = { name: "Zz Laptop", type: "GOOD" as const, sellingPrice: 1000 };

    const missing = await itemActions.createItem({ ...base, sku: `${TAG}-1`, hsnCode: "" });
    ok("an item without HSN/SAC is refused", !missing.ok && missing.error === HSN_REQUIRED_MESSAGE && (await item(`${TAG}-1`)) === null, missing.ok ? "created" : missing.error);
    const wrongKind = await itemActions.createItem({ ...base, sku: `${TAG}-1`, hsnCode: "997331" });
    ok("  a good with a SAC is refused", !wrongKind.ok && wrongKind.error.includes("SAC (services)"));
    const madeUp = await itemActions.createItem({ ...base, sku: `${TAG}-1`, hsnCode: "84719999" });
    ok("  and one the GST directory doesn't list", !madeUp.ok && madeUp.error.includes("isn't in the GST portal's HSN/SAC directory"));
    const laptop = await itemActions.createItem({ ...base, sku: `${TAG}-1`, hsnCode: "8471 30 10" });
    ok("a real one goes in, stored without its spaces", laptop.ok && (await item(`${TAG}-1`))?.hsnCode === "84713010");
    const licence = await itemActions.createItem({ name: "Zz Licence", sku: `${TAG}-2`, type: "SUBSCRIPTION", sellingPrice: 500, hsnCode: "997331" });
    ok("  as does a subscription with a SAC", licence.ok);
    if (!laptop.ok || !licence.ok) throw new Error("the fixture items weren't created");

    const editBlank = await itemActions.updateItem({ ...base, id: laptop.data.id, sku: `${TAG}-1`, hsnCode: "" });
    ok("editing an item can't take its code away", !editBlank.ok && (await item(`${TAG}-1`))?.hsnCode === "84713010");
    const bulkSac = await itemActions.bulkUpdateItems({ itemIds: [laptop.data.id, licence.data.id], hsnCode: "997331" });
    ok("bulk edit refuses a SAC for picked goods", !bulkSac.ok && bulkSac.error.includes("SAC (services)"));
    const bulkFake = await itemActions.bulkUpdateItems({ itemIds: [licence.data.id], hsnCode: "99733199" });
    ok("  and a code that isn't one", !bulkFake.ok);
    const bulkReal = await itemActions.bulkUpdateItems({ itemIds: [licence.data.id], hsnCode: "998314" });
    ok("  and sets a real one", bulkReal.ok && (await item(`${TAG}-2`))?.hsnCode === "998314");
    const bulkType = await itemActions.bulkUpdateItems({ itemIds: [laptop.data.id], type: "SERVICE" });
    ok("making goods services refuses while their HSN is a goods code", !bulkType.ok && (await item(`${TAG}-1`))?.type === "GOOD");

    const legacy = await db.item.create({ data: { name: "Zz Legacy", sku: `${TAG}-3`, type: "GOOD", sellingPrice: 10, hsnCode: "84719999", createdById: keeper.id } });
    const blank = await db.item.create({ data: { name: "Zz Blank", sku: `${TAG}-4`, type: "SERVICE", sellingPrice: 10, createdById: keeper.id } });
    const problems = await dir.hsnProblemsFor([
      { id: legacy.id, type: legacy.type, hsnCode: legacy.hsnCode },
      { id: blank.id, type: blank.type, hsnCode: blank.hsnCode },
      { id: laptop.data.id, type: "GOOD", hsnCode: "84713010" },
    ]);
    ok("the items list flags a code the directory doesn't list, and a missing one", problems.has(legacy.id) && problems.has(blank.id) && !problems.has(laptop.data.id), [...problems.values()].join(" | "));
    const fixList = await itemActions.listItems({ search: TAG, checkHsn: true, hsnToFix: true });
    ok("  and its filter shows just those", fixList.items.map((i) => i.sku).sort().join(",") === `${TAG}-3,${TAG}-4` && fixList.hsnProblems[legacy.id] !== undefined, fixList.items.map((i) => i.sku).join(","));

    section("Document lines");

    const filled = await checkLineLinks(
      [
        { name: "Laptop", itemId: laptop.data.id, hsnCode: "", quantity: 1, unitPrice: 1000, discountMode: "PERCENT", discountValue: 0, taxRatePercent: 18 },
        { name: "Typed", itemId: laptop.data.id, hsnCode: "8471 30", quantity: 1, unitPrice: 1000, discountMode: "PERCENT", discountValue: 0, taxRatePercent: 18 },
        { name: "One-off", hsnCode: "", quantity: 1, unitPrice: 10, discountMode: "PERCENT", discountValue: 0, taxRatePercent: 18 },
      ] as Parameters<typeof checkLineLinks>[0],
      "no-party",
      null,
    );
    const lines = "lines" in filled ? filled.lines : [];
    ok("a line naming a product but sent without a code gets the product's", lines[0]?.hsnCode === "84713010", lines[0]?.hsnCode);
    ok("  a code typed on the line is kept", lines[1]?.hsnCode === "847130");
    ok("  and a one-off line is left as it came", lines[2]?.hsnCode === "");
  } finally {
    await cleanup();
    await closeRefDb();
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll HSN/SAC checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
