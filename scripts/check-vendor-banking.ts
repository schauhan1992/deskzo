/**
 * Vendor codes, bank accounts and the standard industries (owner, 8 Oct 2026):
 *
 *   · **Vendor codes are given, never twice.** Each new vendor gets the workspace's prefix and the next
 *     number; a code typed by hand is kept, numbering carries on past it, and two vendors created at
 *     once still get two codes.
 *   · **Several bank accounts, one primary** — a vendor's, and the organisation's own. A changed
 *     account number is how payment fraud is done, so a vendor's are changed only with `payments.manage`,
 *     seen in full only by finance, and audited by their last four digits.
 *   · **The account a sale prints**: the document's pick, else its branch's default, else the primary —
 *     the old single bank block only while a workspace waits for its migration.
 *   · **What was there is moved across**: the migration makes the old bank details the new lists' primaries.
 *   · **Domain Intel is for customers**: no vendor in its lists, counts or panel.
 *   · **Forty standard industries** in every workspace, its own kept, no near-duplicates.
 *   · **A contact who has left their company**: kept, but out of everything new; and the compact contact list.
 *
 * Builds a scratch database beside the local one from the migrations, and drives the real actions in
 * it as stubbed users — the real workspace is only read, before and after, to show it was not touched.
 * Nothing here reaches the network: the one domain lookup it calls is refused before it would.
 *
 *   npm run check:vendor-banking
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";
import { bankAccountSchema, maskedAccountNumber } from "../src/lib/validation/bank-account";
import { holdsBankAccounts } from "../src/lib/validation/company";
import { formatVendorCode, vendorCodeNumber, VENDOR_CODE_PREFIX_PATTERN } from "../src/lib/companies/vendor-code";
import { STANDARD_INDUSTRIES } from "../src/lib/companies/standard-industries";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const json = (v: unknown) => JSON.stringify(v);
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}
const migration = (folder: string) => readFileSync(path.join(process.cwd(), "prisma", "migrations", folder, "migration.sql"), "utf8");

const TAG = "ZZVB";

// ── Who is calling ──────────────────────────────────────────────────────────────────────────────

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;

const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};
const navigation = {
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NOT_FOUND_CALLED");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
// Every module in the plan: what is checked here is who may, not what the plan sells.
const moduleOverrides = {
  requireModuleUser: async () => session.requireUser(),
  moduleAvailableForTenant: async () => true,
};
let modulesAccess: unknown = null;
const stubs = new Map<string, () => unknown>([
  ["next/cache", () => nextCache],
  ["next/navigation", () => navigation],
  ["@/lib/session", () => session],
]);
const files = new Map<string, () => unknown>([
  [load.resolve("next/navigation"), () => navigation],
  [load.resolve("next/cache"), () => nextCache],
  [load.resolve("../src/lib/session"), () => session],
]);
const modulesFile = load.resolve("../src/lib/modules-access");
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  const named = stubs.get(request);
  if (named) return named();
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved && files.has(resolved)) return files.get(resolved)!();
  if (request === "@/lib/modules-access" || resolved === modulesFile) {
    modulesAccess ??= { ...(realLoad.call(this, request, parent, isMain) as object), ...moduleOverrides };
    return modulesAccess;
  }
  return realLoad.call(this, request, parent, isMain);
};

// ── Without a database ──────────────────────────────────────────────────────────────────────────

function pure() {
  section("1. A bank account's fields");
  const account = (over: Record<string, unknown>) => bankAccountSchema.safeParse({ label: "Main", ...over });
  ok("an account number alone is enough", account({ accountNumber: "50100012345678" }).success);
  ok("  so is a UPI id alone", account({ upiId: "acme@hdfc" }).success);
  ok("  but neither is refused", !account({ bankName: "HDFC Bank" }).success);
  const spaced = account({ accountNumber: " 5010 0012 3456 " });
  ok("spaces in the number are dropped", spaced.success && spaced.data.accountNumber === "501000123456", spaced.success ? spaced.data.accountNumber : "");
  ok("an IFSC must be well formed", !account({ accountNumber: "1", ifsc: "HDFC1234" }).success && account({ accountNumber: "1", ifsc: "hdfc0001234" }).success);
  ok("  and so must a SWIFT code, of 8 or 11", account({ accountNumber: "1", swift: "hdfcinbb" }).success && account({ accountNumber: "1", swift: "HDFCINBBXXX" }).success && !account({ accountNumber: "1", swift: "HDFCIN" }).success);
  ok("a name is required", !bankAccountSchema.safeParse({ label: " ", accountNumber: "1" }).success);
  ok("a number is masked to its last four", maskedAccountNumber("50100012345678") === "•••• 5678" && maskedAccountNumber("123") === "123" && maskedAccountNumber(null) === null);

  section("2. Who keeps bank accounts on their record");
  ok("vendors, OEMs, distributors, partners and resellers do", (["VENDOR", "OEM", "DISTRIBUTOR", "PARTNER", "OTHER", "RESELLER"] as const).every(holdsBankAccounts));
  ok("  a client and a commission party do not", !holdsBankAccounts("CLIENT") && !holdsBankAccounts("COMMISSION_PARTY"));

  section("3. Vendor code numbers");
  ok("the number after the prefix", vendorCodeNumber("VEN-0041", "VEN-") === 41);
  ok("  whatever its capitals", vendorCodeNumber("ven-12", "VEN-") === 12);
  ok("  and none when the rest is not a number", vendorCodeNumber("VEN-12A", "VEN-") === null && vendorCodeNumber("V-1296", "VEN-") === null && vendorCodeNumber("VEN-", "VEN-") === null);
  ok("four digits, and more once there are more", formatVendorCode("VEN-", 7) === "VEN-0007" && formatVendorCode("VEN-", 12345) === "VEN-12345");
  ok("a prefix is letters, digits and a separator", VENDOR_CODE_PREFIX_PATTERN.test("VEN-") && VENDOR_CODE_PREFIX_PATTERN.test("V/") && !VENDOR_CODE_PREFIX_PATTERN.test("A B") && !VENDOR_CODE_PREFIX_PATTERN.test("-V"));

  section("4. The standard industries");
  const sql = migration("20261028100000_standard_industries");
  const inMigration = [...sql.slice(sql.indexOf("FROM (VALUES"), sql.indexOf(") AS v(name)")).matchAll(/\('([^']+)'\)/g)].map((m) => m[1]!);
  ok("forty of them", STANDARD_INDUSTRIES.length === 40, STANDARD_INDUSTRIES.length);
  ok("  the migration adds exactly the list", json(inMigration) === json(STANDARD_INDUSTRIES), json(inMigration.filter((n) => !STANDARD_INDUSTRIES.includes(n))));
  ok("  none twice, whatever its capitals", new Set(STANDARD_INDUSTRIES.map((n) => n.toLowerCase())).size === STANDARD_INDUSTRIES.length);
}

// ── The scratch database ────────────────────────────────────────────────────────────────────────

async function main() {
  pure();

  const realUrl = process.env.DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);

  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_vendor_banking`;
  const scratchUrl = withDatabase(realUrl, scratchName);
  ok("  and it is not the real one", scratchName !== realName, scratchName);

  const real = directClient(realUrl, { max: 1 });
  const realBefore = await snapshot(real);
  const admin = directClient(withDatabase(realUrl, "postgres"), { max: 1 });
  let closeAll: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60 * 1000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);

    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = "";
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    /* eslint-enable @typescript-eslint/no-require-imports */
    closeAll = () => db.$disconnect();
    await run(db as unknown as PrismaClient);
  } finally {
    await closeAll?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const gone = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratchName}'`);
    ok("the scratch database is dropped", Number(gone[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  section("The real workspace was not touched");
  const realAfter = await snapshot(real);
  await real.$disconnect();
  ok("its companies, accounts and industries are as they were", realAfter === realBefore, realAfter);

  console.log(failures === 0 ? `\nAll ${passes} vendor and banking checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** What the suite must never change in the real workspace. Read-only. */
async function snapshot(client: PrismaClient) {
  const [companies, codes, industries, tagged] = await Promise.all([
    client.company.count(),
    client.company.count({ where: { vendorCode: { not: null } } }),
    client.industry.count(),
    client.company.count({ where: { name: { startsWith: TAG } } }),
  ]);
  const accounts = await client.companyBankAccount.count().catch(() => -1);
  return JSON.stringify({ companies, codes, industries, tagged, accounts });
}

// ── The suite ───────────────────────────────────────────────────────────────────────────────────

async function run(db: PrismaClient) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const companies = require("../src/actions/company") as typeof import("../src/actions/company");
  const companyBank = require("../src/actions/company-bank") as typeof import("../src/actions/company-bank");
  const orgBank = require("../src/actions/organisation-bank") as typeof import("../src/actions/organisation-bank");
  const vendorCodes = require("../src/actions/vendor-codes") as typeof import("../src/actions/vendor-codes");
  const branches = require("../src/actions/branch") as typeof import("../src/actions/branch");
  const documents = require("../src/actions/trade-document") as typeof import("../src/actions/trade-document");
  const domains = require("../src/actions/domain") as typeof import("../src/actions/domain");
  const { assignVendorCodes } = require("../src/lib/companies/vendor-code") as typeof import("../src/lib/companies/vendor-code");
  const { printedBankAccount, documentBankChoices } = require("../src/lib/banking/organisation-accounts") as typeof import("../src/lib/banking/organisation-accounts");
  const { branchIdentity, ensureHeadOffice } = require("../src/lib/branches/identity") as typeof import("../src/lib/branches/identity");
  const { executeMerge } = require("../src/lib/companies/merge") as typeof import("../src/lib/companies/merge");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const person = async (key: string, role: "ADMIN" | "ACCOUNTS" | "SALES") =>
    db.user.create({
      data: { name: `${TAG} ${key}`, email: `${TAG.toLowerCase()}-${key.toLowerCase()}@example.test`, passwordHash: "!", role },
      select: { id: true, name: true, email: true, role: true },
    });
  const boss = await person("Admin", "ADMIN");
  const finance = await person("Accounts", "ACCOUNTS");
  const seller = await person("Sales", "SALES");
  const otherSeller = await person("Sales2", "SALES");
  const as = <T,>(who: Actor, work: () => Promise<T>) => {
    actor = who;
    return work();
  };
  const company = async (who: Actor, name: string, relationshipType: string, extra: Record<string, unknown> = {}) => {
    const result = await as(who, () =>
      companies.createCompany({
        name: `${TAG} ${name}`,
        relationshipType,
        location: { label: "HQ", city: "Mumbai", state: "Maharashtra", country: "India", pincode: "400001", gstTreatment: "UNREGISTERED" },
        ...extra,
      }),
    );
    if (!result.ok) throw new Error(`${name} wasn't created: ${result.error}`);
    return db.company.findUniqueOrThrow({ where: { id: result.data.id }, include: { locations: true } });
  };

  // ── The migration ───────────────────────────────────────────────────────────────────────────

  section("5. The old bank details are moved across");
  const ho = await ensureHeadOffice();
  const [pune, delhi] = await Promise.all(
    [
      { name: `${TAG} Pune`, code: "ZPUN", bankName: "Axis Bank", bankAccountNumber: " 9180 ", bankIfsc: "utib0000001", upiId: null },
      { name: `${TAG} Delhi`, code: "ZDEL", bankName: "HDFC Bank", bankAccountNumber: "50100000000001", bankIfsc: null, upiId: "org@hdfc" },
    ].map((b) => db.branch.create({ data: { ...b, addressLine1: "1 Road", city: "Pune", state: "Maharashtra", pincode: "411001" }, select: { id: true } })),
  );
  const oldVendor = await db.company.create({
    data: {
      name: `${TAG} Old Vendor`,
      normalizedName: `${TAG.toLowerCase()} old vendor`,
      relationshipType: "VENDOR",
      createdById: boss.id,
      ownerUserId: boss.id,
      bankAccountName: "Old Vendor LLP",
      bankAccountNumber: "123456789",
      bankIfsc: "icic0000002",
      bankName: "ICICI Bank",
    },
    select: { id: true },
  });
  await db.organisationSettings.upsert({
    where: { id: "global" },
    update: { bankName: "HDFC Bank", bankAccountNumber: "50100000000001", bankIfsc: "HDFC0000001", bankBranch: "Fort", upiId: "org@hdfc" },
    create: { id: "global", legalName: `${TAG} Org`, bankName: "HDFC Bank", bankAccountNumber: "50100000000001", bankIfsc: "HDFC0000001", bankBranch: "Fort", upiId: "org@hdfc" },
  });
  // The moves, exactly as the migration has them, over these rows.
  const sql = migration("20261028110000_bank_accounts_vendor_codes");
  const moves = sql.slice(sql.indexOf("-- 1. The organisation's bank block")).split(/;\s*\n/).map((s) => s.trim()).filter((s) => s.replace(/^--.*$/gm, "").trim());
  ok("the migration has its four moves", moves.length === 4, moves.length);
  for (const statement of moves) await db.$executeRawUnsafe(statement);

  const main = await db.organisationBankAccount.findUnique({ where: { id: "orgbank-main" } });
  ok(
    "the organisation's bank block is its primary \"Main account\", whole",
    main?.isPrimary === true && main.label === "Main account" && main.accountNumber === "50100000000001" && main.ifsc === "HDFC0000001" && main.branchName === "Fort" && main.upiId === "org@hdfc",
    json(main),
  );
  const puneAccount = await db.organisationBankAccount.findUnique({ where: { id: `brbank-${pune.id}` } });
  ok(
    "a branch with its own account gets it as one of the organisation's — trimmed, its IFSC in capitals",
    puneAccount?.accountNumber === "9180" && puneAccount.ifsc === "UTIB0000001" && puneAccount.isPrimary === false && puneAccount.label === `${TAG} Pune account`,
    json(puneAccount),
  );
  const branchDefaults = await db.branch.findMany({ where: { id: { in: [pune.id, delhi.id, ho.id] } }, select: { id: true, defaultBankAccountId: true } });
  const defaultOf = (id: string) => branchDefaults.find((b) => b.id === id)?.defaultBankAccountId;
  ok("  and as its default", defaultOf(pune.id) === `brbank-${pune.id}`);
  ok(
    "a branch whose account is the organisation's own gets no copy — it defaults to the main account",
    defaultOf(delhi.id) === "orgbank-main" && !(await db.organisationBankAccount.findUnique({ where: { id: `brbank-${delhi.id}` } })),
  );
  ok("a branch with no bank block of its own is left alone", defaultOf(ho.id) === null);
  const moved = await db.companyBankAccount.findUnique({ where: { id: `cba-${oldVendor.id}` } });
  ok(
    "a vendor's single account is its primary, holder and all",
    moved?.isPrimary === true && moved.companyId === oldVendor.id && moved.accountHolderName === "Old Vendor LLP" && moved.accountNumber === "123456789" && moved.ifsc === "ICIC0000002",
    json(moved),
  );

  section("6. One primary, held by the database");
  const secondPrimary = await db.companyBankAccount
    .create({ data: { companyId: oldVendor.id, label: "Another", accountNumber: "1", isPrimary: true } })
    .then(() => "created")
    .catch((e: Error) => e.message);
  ok("a second primary for one vendor is refused", secondPrimary !== "created", secondPrimary.slice(0, 80));
  const secondOrgPrimary = await db.organisationBankAccount
    .create({ data: { label: "Another", accountNumber: "1", isPrimary: true } })
    .then(() => "created")
    .catch((e: Error) => e.message);
  ok("  and so is a second for the organisation", secondOrgPrimary !== "created", secondOrgPrimary.slice(0, 80));
  // Back to a clean slate for the actions below.
  await db.branch.updateMany({ data: { defaultBankAccountId: null } });
  await db.organisationBankAccount.deleteMany({});

  section("7. The industries, again over a workspace's own");
  await db.company.updateMany({ data: { industryId: null } });
  await db.industry.deleteMany({});
  await db.industry.createMany({ data: [{ name: "it services" }, { name: `${TAG} Our Own` }] });
  await db.$executeRawUnsafe(migration("20261028100000_standard_industries"));
  const industries = (await db.industry.findMany({ select: { name: true } })).map((i) => i.name);
  ok("every standard industry is there, and the workspace's own", industries.length === 41 && industries.includes(`${TAG} Our Own`), industries.length);
  ok("  with no near-duplicate of one it had", industries.includes("it services") && !industries.includes("IT Services"));
  await db.$executeRawUnsafe(migration("20261028100000_standard_industries"));
  ok("  and running it twice adds nothing", (await db.industry.count()) === 41);

  // ── Vendor codes ────────────────────────────────────────────────────────────────────────────

  section("8. Vendor codes");
  ok("changing the prefix needs settings.manage", !(await as(seller, () => vendorCodes.saveVendorCodePrefix("ZV-"))).ok);
  ok("  and so does seeing it", (await as(seller, () => vendorCodes.getVendorCodeSettings())) === null);
  ok("a prefix with a space is refused", !(await as(boss, () => vendorCodes.saveVendorCodePrefix("Z V"))).ok);
  const saved = await as(boss, () => vendorCodes.saveVendorCodePrefix("zv-"));
  const stored = await db.organisationSettings.findUnique({ where: { id: "global" }, select: { vendorCodePrefix: true } });
  ok("the prefix is saved, in capitals", saved.ok && stored?.vendorCodePrefix === "ZV-", stored?.vendorCodePrefix);
  // The old vendor already has a code of another shape, which numbering leaves be.
  await db.company.update({ where: { id: oldVendor.id }, data: { vendorCode: "V-1296" } });

  const v1 = await company(seller, "Vendor One", "VENDOR");
  ok("a new vendor is given the first code", v1.vendorCode === "ZV-0001", v1.vendorCode);
  const oem = await company(seller, "OEM", "OEM");
  ok("  an OEM the next", oem.vendorCode === "ZV-0002", oem.vendorCode);
  const client = await company(seller, "Client", "CLIENT", { website: "https://zzvb-client.example" });
  ok("a client is given none", client.vendorCode === null);
  const party = await company(seller, "Commission Party", "COMMISSION_PARTY");
  ok("  nor is a commission party", party.vendorCode === null);

  const typed = await as(seller, () => companies.setVendorCode(oem.id, "zv-0040"));
  ok("a code typed by hand is kept, in capitals", typed.ok && (await db.company.findUnique({ where: { id: oem.id } }))?.vendorCode === "ZV-0040");
  const v3 = await company(seller, "Vendor Three", "DISTRIBUTOR", { website: "https://zzvb-vendor.example" });
  ok("  and numbering carries on after it", v3.vendorCode === "ZV-0041", v3.vendorCode);
  const clash = await as(seller, () => companies.setVendorCode(v3.id, "zv-0001"));
  ok("another vendor's code is refused, whatever its capitals", !clash.ok && /Vendor One/.test(clash.ok ? "" : clash.error), clash.ok ? "accepted" : clash.error);
  ok("a client can't be given one", !(await as(seller, () => companies.setVendorCode(client.id, "X1"))).ok);
  ok("nor can a vendor somebody can't see", !(await as(otherSeller, () => companies.setVendorCode(v1.id, "ZV-0099"))).ok);

  const waiting = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      db.company.create({
        data: { name: `${TAG} Rush ${i}`, normalizedName: `${TAG.toLowerCase()} rush ${i}`, relationshipType: "VENDOR", createdById: boss.id, ownerUserId: boss.id },
        select: { id: true },
      }),
    ),
  );
  const rushed = (await Promise.all(waiting.map((w) => assignVendorCodes([w.id])))).flat();
  const rushedCodes = rushed.map((r) => r.vendorCode).sort();
  ok(
    "six vendors numbered at once get six codes, one after another",
    new Set(rushedCodes).size === 6 && json(rushedCodes) === json(["ZV-0042", "ZV-0043", "ZV-0044", "ZV-0045", "ZV-0046", "ZV-0047"]),
    json(rushedCodes),
  );
  ok("  and numbering one already numbered gives it nothing new", (await assignVendorCodes([waiting[0]!.id])).length === 0);

  await db.company.create({ data: { name: `${TAG} Before Codes`, normalizedName: `${TAG.toLowerCase()} before codes`, relationshipType: "PARTNER", createdById: boss.id, ownerUserId: boss.id } });
  const settings = await as(boss, () => vendorCodes.getVendorCodeSettings());
  ok("Settings counts the vendors without a code, and says what comes next", settings?.withoutCode === 1 && settings.nextCode === "ZV-0048", json(settings));
  ok("giving them codes needs settings.manage", !(await as(seller, () => vendorCodes.giveVendorsCodes())).ok);
  const given = await as(boss, () => vendorCodes.giveVendorsCodes());
  ok("  and gives each one", given.ok && given.data.given === 1 && (await db.company.count({ where: { relationshipType: "PARTNER", vendorCode: null } })) === 0);
  ok("the commission party and the client are still without", (await db.company.findUnique({ where: { id: party.id } }))?.vendorCode === null && (await db.company.findUnique({ where: { id: client.id } }))?.vendorCode === null);

  // ── A vendor's bank accounts ────────────────────────────────────────────────────────────────

  section("9. A vendor's bank accounts");
  const input = (label: string, accountNumber: string, isPrimary = false) => ({ label, accountNumber, ifsc: "HDFC0001234", bankName: "HDFC Bank", isPrimary });
  const refused = await as(seller, () => companyBank.createCompanyBankAccount(v1.id, input("Main", "11112222")));
  ok("its account manager can't add one without payments.manage", !refused.ok, refused.ok ? "" : refused.error);
  ok("an account on a client is refused", !(await as(finance, () => companyBank.createCompanyBankAccount(client.id, input("Main", "1")))).ok);
  ok("an account with no number and no UPI id is refused", !(await as(finance, () => companyBank.createCompanyBankAccount(v1.id, { label: "Main", bankName: "HDFC" }))).ok);
  const first = await as(finance, () => companyBank.createCompanyBankAccount(v1.id, input("Main", "11112222")));
  const second = await as(finance, () => companyBank.createCompanyBankAccount(v1.id, input("USD", "33334444")));
  const primaryOf = async (companyId: string) => (await db.companyBankAccount.findMany({ where: { companyId, isPrimary: true }, select: { id: true } })).map((a) => a.id);
  ok("finance adds them; the first is the primary without being asked", first.ok && second.ok && json(await primaryOf(v1.id)) === json(first.ok ? [first.data.id] : []));
  const third = await as(finance, () => companyBank.createCompanyBankAccount(v1.id, input("New main", "55556666", true)));
  ok("  one added as primary takes it over", third.ok && json(await primaryOf(v1.id)) === json(third.ok ? [third.data.id] : []));
  if (first.ok && second.ok && third.ok) {
    await as(finance, () => companyBank.setPrimaryCompanyBankAccount(first.data.id));
    ok("  and \"make primary\" moves it back", json(await primaryOf(v1.id)) === json([first.data.id]));
    const unticked = await as(finance, () => companyBank.updateCompanyBankAccount(first.data.id, { ...input("Main", "11112299"), isPrimary: false }));
    ok("unticking the primary leaves it primary — some account always is", unticked.ok && json(await primaryOf(v1.id)) === json([first.data.id]));
    await as(finance, () => companyBank.deleteCompanyBankAccount(first.data.id));
    ok("deleting the primary makes the oldest of the rest primary", json(await primaryOf(v1.id)) === json([second.data.id]));

    const asSeller = await as(seller, () => companyBank.listCompanyBankAccounts(v1.id));
    const asFinance = await as(finance, () => companyBank.listCompanyBankAccounts(v1.id));
    ok(
      "its account manager sees the accounts, numbers masked, and can't change them",
      asSeller.ok && !asSeller.data.canManage && asSeller.data.accounts.every((a) => a.accountNumber?.startsWith("•••• ")),
      asSeller.ok ? json(asSeller.data.accounts.map((a) => a.accountNumber)) : asSeller.error,
    );
    ok("  finance sees them whole", asFinance.ok && asFinance.data.canManage && asFinance.data.accounts.some((a) => a.accountNumber === "33334444"));
    ok("somebody who can't see the vendor sees none of it", !(await as(otherSeller, () => companyBank.listCompanyBankAccounts(v1.id))).ok);

    const changed = await as(finance, () => companyBank.updateCompanyBankAccount(second.data.id, input("USD", "77778888")));
    const trail = await db.auditLog.findMany({ where: { entityType: "CompanyBankAccount" }, select: { entityLabel: true } });
    ok("a changed number is audited, old and new by their last four", changed.ok && trail.some((t) => t.entityLabel.includes("•••• 4444 → •••• 8888")), json(trail.map((t) => t.entityLabel)));
    ok("  and no audit line holds a whole number", !trail.some((t) => /\d{6,}/.test(t.entityLabel)));
  } else {
    ok("the accounts were created", false, json([first, second, third]));
  }
  ok("its PAN needs payments.manage too", !(await as(seller, () => companies.setPayoutDetails(v1.id, { panNumber: "ABCDE1234F" }))).ok);
  const pan = await as(finance, () => companies.setPayoutDetails(v1.id, { panNumber: "abcde1234f" }));
  ok("  and finance sets it", pan.ok && (await db.company.findUnique({ where: { id: v1.id } }))?.panNumber === "ABCDE1234F");

  section("10. Merging two vendors keeps one primary");
  const twin = await company(boss, "Vendor One Twin", "VENDOR");
  await as(finance, () => companyBank.createCompanyBankAccount(twin.id, input("Twin main", "99990000")));
  const keptPrimary = await primaryOf(v1.id);
  await executeMerge({ keepId: v1.id, dropId: twin.id, choices: {}, combine: [], userId: boss.id });
  const afterMerge = await db.companyBankAccount.findMany({ where: { companyId: v1.id }, select: { id: true, label: true, isPrimary: true } });
  ok(
    "the duplicate's accounts move across, and the staying vendor's primary stays the one",
    afterMerge.some((a) => a.label === "Twin main" && !a.isPrimary) && json(afterMerge.filter((a) => a.isPrimary).map((a) => a.id)) === json(keptPrimary),
    json(afterMerge),
  );

  // ── The organisation's accounts, and what a sale prints ─────────────────────────────────────

  section("11. The organisation's accounts");
  ok("seeing them needs settings.manage", (await as(seller, () => orgBank.listOrganisationBankAccounts())) === null);
  ok("  and so does adding one", !(await as(seller, () => orgBank.createOrganisationBankAccount(input("Main", "1")))).ok);
  const a = await as(boss, () => orgBank.createOrganisationBankAccount(input("A", "100000000001")));
  const b = await as(boss, () => orgBank.createOrganisationBankAccount(input("B", "200000000002")));
  const c = await as(boss, () => orgBank.createOrganisationBankAccount({ label: "C", upiId: "org@okaxis", isPrimary: false }));
  if (!a.ok || !b.ok || !c.ok) {
    ok("the organisation's accounts were created", false, json([a, b, c]));
    return;
  }
  const orgPrimary = async () => (await db.organisationBankAccount.findFirst({ where: { isPrimary: true }, select: { id: true } }))?.id;
  ok("the first is the primary", (await orgPrimary()) === a.data.id);
  ok("the primary can't be retired", !(await as(boss, () => orgBank.setOrganisationBankAccountActive(a.data.id, false))).ok);
  await as(boss, () => orgBank.setPrimaryOrganisationBankAccount(b.data.id));
  const retired = await as(boss, () => orgBank.setOrganisationBankAccountActive(a.data.id, false));
  ok("once another is primary it can", retired.ok && (await orgPrimary()) === b.data.id);
  ok("a retired account can't be made primary", !(await as(boss, () => orgBank.setPrimaryOrganisationBankAccount(a.data.id))).ok);

  const head = await db.branch.findUniqueOrThrow({ where: { id: ho.id }, select: { id: true, name: true, code: true } });
  const toRetired = await as(boss, () => branches.saveBranch({ id: head.id, name: head.name, code: head.code, defaultBankAccountId: a.data.id }));
  ok("a branch can't default to a retired account", !toRetired.ok, toRetired.ok ? "" : toRetired.error);
  const toC = await as(boss, () => branches.saveBranch({ id: head.id, name: head.name, code: head.code, defaultBankAccountId: c.data.id }));
  const headDefault = async () => (await db.branch.findUnique({ where: { id: ho.id }, select: { defaultBankAccountId: true } }))?.defaultBankAccountId;
  ok("  but can to one in use", toC.ok && (await headDefault()) === c.data.id, toC.ok ? "" : toC.error);
  const leftOut = await as(boss, () => branches.saveBranch({ id: head.id, name: head.name, code: head.code }));
  ok("  and a save that doesn't send it leaves it as it was", leftOut.ok && (await headDefault()) === c.data.id);
  ok("an account a branch names can't be deleted", !(await as(boss, () => orgBank.deleteOrganisationBankAccount(c.data.id))).ok);

  section("12. What a sale prints");
  const proposal = async (over: Record<string, unknown> = {}) => {
    const result = await as(boss, () =>
      documents.createTradeDocument({
        docType: "PROPOSAL",
        issueDate: today,
        companyId: client.id,
        locationId: client.locations[0]!.id,
        branchId: ho.id,
        gstTreatment: "UNREGISTERED",
        billing: { line1: "1 Road", city: "Mumbai", state: "Maharashtra", stateCode: "27", pincode: "400001", country: "India" },
        shippingSameAsBilling: true,
        shipping: {},
        lines: [{ name: `${TAG} Laptop`, hsnCode: "8471", unit: "NOS", quantity: 1, unitPrice: 1000, taxRatePercent: 18 }],
        ...over,
      }),
    );
    if (!result.ok) throw new Error(`The proposal wasn't created: ${result.error}`);
    return result.data.id;
  };
  // A typed day, as the form sends it; which day does not matter here.
  const today = new Date().toISOString().slice(0, 10);
  const identity = await branchIdentity(ho.id);
  const plain = await proposal();
  ok("left on default, a sale prints its branch's account", (await printedBankAccount(plain, identity))?.label === "C");
  const picked = await proposal({ bankAccountId: a.data.id });
  ok("one that picks an account prints it — even once retired, as a reprint must", (await printedBankAccount(picked, identity))?.accountNumber === "100000000001");
  const nowhere = await as(boss, () =>
    documents.createTradeDocument({
      docType: "PROPOSAL", issueDate: today, companyId: client.id, locationId: client.locations[0]!.id, branchId: ho.id, gstTreatment: "UNREGISTERED",
      billing: { line1: "1 Road", city: "Mumbai", state: "Maharashtra", stateCode: "27", pincode: "400001", country: "India" },
      shippingSameAsBilling: true, shipping: {}, lines: [{ name: "X", quantity: 1, unitPrice: 1, taxRatePercent: 18 }],
      bankAccountId: "not-an-account",
    }),
  );
  ok("an account that isn't one of the organisation's is refused", !nowhere.ok);
  await db.branch.update({ where: { id: ho.id }, data: { defaultBankAccountId: null } });
  ok("with no branch default, the primary prints", (await printedBankAccount(plain, identity))?.label === "B");
  await db.branch.update({ where: { id: ho.id }, data: { defaultBankAccountId: a.data.id } });
  ok("  and so it does when the branch's default has been retired", (await printedBankAccount(plain, identity))?.label === "B");

  const choicesFor = await documentBankChoices(picked);
  const choicesNew = await documentBankChoices();
  ok(
    "the form offers the accounts in use, and a document's own retired one only to it",
    choicesFor.current === a.data.id && choicesFor.accounts.some((x) => x.id === a.data.id && !x.active) && !choicesNew.accounts.some((x) => x.id === a.data.id),
    json({ current: choicesFor.current, forDoc: choicesFor.accounts.map((x) => x.id === a.data.id), forNew: choicesNew.accounts.length }),
  );
  ok("  and names no branch default that has been retired", choicesNew.branchDefaults[ho.id] === null);

  const converted = await as(boss, () => documents.convertTradeDocument({ id: picked, target: "PROFORMA" }));
  const proforma = converted.ok ? await db.tradeDocument.findUnique({ where: { id: converted.data.id }, select: { bankAccountId: true } }) : null;
  ok("a proposal converted keeps the account it asked to be paid into", proforma?.bankAccountId === a.data.id, converted.ok ? json(proforma) : converted.error);

  const purchase = await as(boss, () =>
    documents.createTradeDocument({
      docType: "PURCHASE_ORDER", issueDate: today, companyId: v3.id, locationId: v3.locations[0]!.id, branchId: ho.id, gstTreatment: "UNREGISTERED",
      billing: { line1: "1 Road", city: "Mumbai", state: "Maharashtra", stateCode: "27", pincode: "400001", country: "India" },
      shippingSameAsBilling: true, shipping: {}, lines: [{ name: "Y", quantity: 1, unitPrice: 1, taxRatePercent: 18 }],
      bankAccountId: b.data.id,
    }),
  );
  const po = purchase.ok ? await db.tradeDocument.findUnique({ where: { id: purchase.data.id }, select: { bankAccountId: true } }) : null;
  ok("a purchase order names no account of ours", purchase.ok && po?.bankAccountId === null, purchase.ok ? json(po) : purchase.error);

  // A workspace the new release reaches before its migration: no accounts table, the old block prints.
  await db.$executeRawUnsafe(`ALTER TABLE "organisation_bank_accounts" RENAME TO "organisation_bank_accounts_away"`);
  try {
    const legacy = await printedBankAccount(plain, { ...identity, bankName: "Old Bank", bankAccountNumber: "42", bankIfsc: "OLDB0000001", bankBranch: null, upiId: null });
    ok("a workspace not yet migrated prints its old bank block", legacy?.bankName === "Old Bank" && legacy.accountNumber === "42" && legacy.ifsc === "OLDB0000001", json(legacy));
    ok("  and its forms offer no accounts", (await documentBankChoices(plain)).accounts.length === 0);
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "organisation_bank_accounts_away" RENAME TO "organisation_bank_accounts"`);
  }

  // ── Domain Intel ────────────────────────────────────────────────────────────────────────────

  section("13. Domain Intel is for customers");
  actor = boss;
  ok("a client has its briefing", (await domains.getDomainBriefing(client.id)) !== null);
  ok("  a vendor none", (await domains.getDomainBriefing(v3.id)) === null);
  const lookup = await domains.refreshDomainProfile(v3.id);
  ok("  and a lookup for one is refused before anything is fetched", !lookup.ok && /vendors/.test(lookup.ok ? "" : lookup.error), lookup.ok ? "looked up" : lookup.error);
  const listed = await domains.listDomainProfiles({ page: 1, pageSize: 50 });
  const names = (listed as { rows: { name: string }[] }).rows.map((r) => r.name);
  ok("the list has the client with a website and not the vendor", names.includes(client.name) && !names.includes(v3.name), json(names));
  const summary = await domains.domainSummary();
  ok("  and so do its counts", summary.withWebsite === 1, json(summary));

  section("13b. A customer category is for customers");
  /* eslint-disable @typescript-eslint/no-require-imports */
  const categories = require("../src/actions/customer-category") as typeof import("../src/actions/customer-category");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const starter = await db.customerCategory.findFirst({ select: { id: true } });
  if (starter) {
    const onVendor = await categories.setCompanyCategory(v3.id, starter.id);
    ok("a distributor can't be given one", !onVendor.ok && (await db.company.findUnique({ where: { id: v3.id } }))?.customerCategoryId === null, onVendor.ok ? "set" : onVendor.error);
    ok("  a client can", (await categories.setCompanyCategory(client.id, starter.id)).ok);
    await db.company.update({ where: { id: v3.id }, data: { customerCategoryId: starter.id } });
    ok("  and one a vendor has from before can be cleared", (await categories.setCompanyCategory(v3.id, null)).ok && (await db.company.findUnique({ where: { id: v3.id } }))?.customerCategoryId === null);
  } else {
    ok("the starter customer categories are there", false);
  }

  // ── A contact who has left ──────────────────────────────────────────────────────────────────

  section("13c. A contact who has left the company");
  /* eslint-disable @typescript-eslint/no-require-imports */
  const calls = require("../src/actions/call") as typeof import("../src/actions/call");
  const contactActions = require("../src/actions/contact") as typeof import("../src/actions/contact");
  const { leftContactsOf, STILL_THERE } = require("../src/lib/contacts/left") as typeof import("../src/lib/contacts/left");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const kavya = await db.contact.create({
    data: { companyId: client.id, name: `${TAG} Kavya`, designation: "IT_MANAGER", email: "kavya@zzvb-client.example", phone: "+91 9652267482", linkedinUrl: "linkedin.com/in/zzvb-kavya", isPrimary: true, receivesDocuments: true },
    select: { id: true },
  });
  const vinay = await db.contact.create({ data: { companyId: client.id, name: `${TAG} Vinay`, designation: "HR", phone: "+91 9814013374" }, select: { id: true } });
  const portal = await db.portalLogin.create({ data: { token: `${TAG}-portal-token`, companyId: client.id, contactId: kavya.id, personName: `${TAG} Kavya` }, select: { id: true } });
  ok("somebody who can't see the company can't mark them", !(await as(otherSeller, () => companies.setContactLeft(kavya.id, true))).ok);
  const gone = await as(seller, () => companies.setContactLeft(kavya.id, true));
  const kavyaNow = await db.contact.findUnique({ where: { id: kavya.id }, select: { leftAt: true, isPrimary: true, receivesDocuments: true } });
  ok(
    "marked left, they are no longer primary nor sent documents",
    gone.ok && !!kavyaNow?.leftAt && !kavyaNow.isPrimary && !kavyaNow.receivesDocuments,
    gone.ok ? json(kavyaNow) : gone.error,
  );
  ok("  and their customer-portal link stops working", !!(await db.portalLogin.findUnique({ where: { id: portal.id }, select: { revokedAt: true } }))?.revokedAt);
  ok("  the company page knows when", (await leftContactsOf(client.id)).has(kavya.id) && !(await leftContactsOf(client.id)).has(vinay.id));
  const remade = await as(seller, () =>
    companies.updateContact({ id: kavya.id, name: `${TAG} Kavya`, designation: "IT_MANAGER", email: "kavya@zzvb-client.example", phone: "+91 9652267482", isPrimary: true, receivesDocuments: false }),
  );
  ok("they can't be made primary again while they're gone", !remade.ok && /has left/.test(remade.ok ? "" : remade.error), remade.ok ? "made primary" : remade.error);
  const dialler = await as(seller, () => calls.listCompanyNumbers(client.id));
  ok("the dialler offers only those still there", dialler.some((c) => c.id === vinay.id) && !dialler.some((c) => c.id === kavya.id), json(dialler.map((c) => c.name)));
  ok("  as does every list that picks people to write to", (await db.contact.count({ where: { companyId: client.id, ...STILL_THERE } })) === 1);
  const back = await as(seller, () => companies.setContactLeft(kavya.id, false));
  ok(
    "marked back, they are offered again — a primary and the portal are given again by hand",
    back.ok && !(await leftContactsOf(client.id)).has(kavya.id) && (await as(seller, () => calls.listCompanyNumbers(client.id))).some((c) => c.id === kavya.id),
  );
  await as(seller, () => companies.setContactLeft(kavya.id, true));

  // ── Designations from a list of the workspace's own ─────────────────────────────────────────

  section("15. Designations: pick one, or add one");
  /* eslint-disable @typescript-eslint/no-require-imports */
  const designationActions = require("../src/actions/designation") as typeof import("../src/actions/designation");
  /* eslint-enable @typescript-eslint/no-require-imports */
  ok("a workspace starts with the seven of the fixed list", (await db.designation.count()) === 7 && !!(await db.designation.findUnique({ where: { id: "des-hr" } })));
  const roleSql = migration("20261029110000_designations_vendor_fields_reminders");
  const backfill = roleSql.slice(roleSql.indexOf('UPDATE "contacts" c SET "designationId"')).trim().replace(/;$/, "");
  const oldHr = await db.contact.create({ data: { companyId: client.id, name: `${TAG} Old HR`, designation: "HR" }, select: { id: true } });
  await db.$executeRawUnsafe(backfill);
  ok("  and a contact from before keeps its designation, now from the list", (await db.contact.findUnique({ where: { id: oldHr.id }, select: { designationId: true } }))?.designationId === "des-hr");
  const engineer = await as(seller, () => companies.addContact(client.id, { name: `${TAG} Neha`, designationName: "  network   engineer " }));
  const nehaRow = engineer.ok ? await db.contact.findUnique({ where: { id: engineer.data.id }, select: { designation: true, designationRef: { select: { name: true, kind: true } } } }) : null;
  ok(
    "a name that isn't on the list is added to it as the contact is saved, its type guessed from the words",
    nehaRow?.designationRef?.name === "network engineer" && nehaRow.designationRef.kind === "IT_MANAGER" && nehaRow.designation === "IT_MANAGER",
    json(nehaRow),
  );
  const again = await as(seller, () => companies.addContact(client.id, { name: `${TAG} Ravi`, designationName: "Network Engineer" }));
  ok("  and the same name again, whatever its capitals, is the same designation", again.ok && (await db.designation.count({ where: { name: { equals: "network engineer", mode: "insensitive" } } })) === 1);
  const engineerId = (await db.designation.findFirst({ where: { name: { equals: "network engineer", mode: "insensitive" } }, select: { id: true } }))!.id;
  ok("only somebody who manages the lists renames one", !(await as(seller, () => designationActions.renameDesignation(engineerId, "Network Engineer"))).ok);
  ok("  and not to a name already on the list", !(await as(boss, () => designationActions.renameDesignation(engineerId, "it manager"))).ok);
  ok("  but to a new one, it is", (await as(boss, () => designationActions.renameDesignation(engineerId, "Network Engineer"))).ok);
  const retyped = await as(boss, () => designationActions.setDesignationKind(engineerId, "IT_HEAD"));
  ok(
    "a new type moves every contact that has it, for scoring and rules",
    retyped.ok && retyped.data.contacts === 2 && (await db.contact.count({ where: { designationId: engineerId, designation: "IT_HEAD" } })) === 2,
    retyped.ok ? retyped.data.contacts : retyped.error,
  );
  const dupe = await as(seller, () => companies.addContact(client.id, { name: `${TAG} Sunil`, designationName: "Netwrk Engineer" }));
  const dupeId = (await db.designation.findFirst({ where: { name: "Netwrk Engineer" }, select: { id: true } }))!.id;
  ok("a designation in use can't be deleted", dupe.ok && !(await as(boss, () => designationActions.deleteDesignation(dupeId))).ok);
  const merged = await as(boss, () => designationActions.mergeDesignations(dupeId, engineerId));
  ok(
    "a duplicate merged: its contacts take the one that stays, and its type, and it's gone",
    merged.ok && merged.data.contacts === 1 && !(await db.designation.findUnique({ where: { id: dupeId } })) && (await db.contact.count({ where: { designationId: engineerId, designation: "IT_HEAD" } })) === 3,
  );
  const cleared = engineer.ok ? await as(seller, () => companies.updateContact({ id: engineer.data.id, name: `${TAG} Neha`, designationName: "" })) : null;
  ok(
    "clearing it leaves no designation, and the type Other",
    !!cleared?.ok && json(await db.contact.findUnique({ where: { id: engineer.ok ? engineer.data.id : "" }, select: { designationId: true, designation: true } })) === json({ designationId: null, designation: "OTHER" }),
  );
  const bulk = await as(seller, () => contactActions.bulkUpdateContacts({ contactIds: [oldHr.id], designationName: "Head of Procurement" }));
  ok("the Contacts page's bulk bar gives a designation by name too", bulk.ok && (await db.contact.findUnique({ where: { id: oldHr.id }, select: { designation: true, designationRef: { select: { name: true } } } }))?.designationRef?.name === "Head of Procurement");

  // ── A person who moved to another company ───────────────────────────────────────────────────

  section("16. Somebody who left joins another company");
  const newHome = await company(seller, "New Home", "CLIENT");
  const anjali = await db.contact.create({
    data: { companyId: client.id, name: `${TAG} Anjali`, email: "anjali@zzvb-client.example", linkedinUrl: "https://linkedin.com/in/zzvb-anjali", isPrimary: false },
    select: { id: true },
  });
  ok("not to the company they're at", !(await as(seller, () => companies.moveContact(anjali.id, { companyId: client.id }))).ok);
  ok("nor to one the person can't add contacts to", !(await as(otherSeller, () => companies.moveContact(anjali.id, { companyId: newHome.id }))).ok);
  const joinedThere = await as(seller, () => companies.moveContact(anjali.id, { companyId: newHome.id, email: "Anjali@NewHome.example", phone: "+91 90000 00001", designationName: "Director" }));
  const there = joinedThere.ok ? await db.contact.findUnique({ where: { id: joinedThere.data.id }, select: { companyId: true, name: true, email: true, linkedinUrl: true, previousContactId: true, designation: true } }) : null;
  ok(
    "a record of them is made there, new email and designation, the same LinkedIn, linked back",
    there?.companyId === newHome.id && there.name === `${TAG} Anjali` && there.email === "anjali@newhome.example" && there.linkedinUrl === "https://linkedin.com/in/zzvb-anjali" && there.previousContactId === anjali.id && there.designation === "DIRECTOR",
    joinedThere.ok ? json(there) : joinedThere.error,
  );
  ok("  and the old record has left", !!(await db.contact.findUnique({ where: { id: anjali.id }, select: { leftAt: true } }))?.leftAt);
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { contactMovesOf } = require("../src/lib/contacts/moves") as typeof import("../src/lib/contacts/moves");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const links = joinedThere.ok ? await contactMovesOf([anjali.id, joinedThere.data.id]) : {};
  ok(
    "each record points at the other, company and all",
    links[anjali.id]?.next?.companyName === newHome.name && joinedThere.ok && links[joinedThere.data.id]?.previous?.companyName === client.name,
    json(links),
  );
  ok("recording the same move twice is refused", !(await as(seller, () => companies.moveContact(anjali.id, { companyId: newHome.id }))).ok);

  // ── Vendors' own fields ─────────────────────────────────────────────────────────────────────

  section("17. Vendors' own fields, apart from companies'");
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fieldActions = require("../src/actions/custom-fields") as typeof import("../src/actions/custom-fields");
  const { formSetup } = require("../src/lib/custom-fields/server") as typeof import("../src/lib/custom-fields/server");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const companyField = await as(boss, () => fieldActions.saveCustomFieldDefinition({ entity: "COMPANY", label: "Region", type: "TEXT" }));
  const vendorField = await as(boss, () => fieldActions.saveCustomFieldDefinition({ entity: "VENDOR", label: "Region", type: "TEXT" }));
  const msme = await as(boss, () => fieldActions.saveCustomFieldDefinition({ entity: "VENDOR", label: "MSME number", type: "TEXT" }));
  const defs = await db.customFieldDefinition.findMany({ where: { label: { in: ["Region", "MSME number"] } }, select: { entity: true, label: true, key: true } });
  const regionKeys = defs.filter((d) => d.label === "Region").map((d) => d.key);
  ok("the two may share a name, but never a key — both live on the company", companyField.ok && vendorField.ok && msme.ok && regionKeys.length === 2 && regionKeys[0] !== regionKeys[1], json(defs));
  const vendorForm = await formSetup("VENDOR", boss.id);
  const companyForm = await formSetup("COMPANY", boss.id);
  ok(
    "a vendor's form has the vendors' fields and not the companies'",
    vendorForm.fields.some((f) => f.label === "MSME number") && !companyForm.fields.some((f) => f.label === "MSME number") && vendorForm.fields.length === 2,
    json(vendorForm.fields.map((f) => f.label)),
  );
  const msmeKey = defs.find((d) => d.label === "MSME number")!.key;
  const fielded = await company(seller, "Fielded Vendor", "VENDOR", { customFields: { [msmeKey]: "UDYAM-MH-01-0000001" } });
  // By name: customFields is left out of a select-less read until every workspace has it.
  const fieldedValues = (await db.company.findUnique({ where: { id: fielded.id }, select: { customFields: true } }))?.customFields as Record<string, unknown>;
  ok("a vendor is created with its own field filled in", fieldedValues[msmeKey] === "UDYAM-MH-01-0000001", json(fieldedValues));
  const companyRegion = defs.find((d) => d.entity === "COMPANY")!.key;
  const refusedField = await as(seller, () => companies.updateCompanyCustomFields(fielded.id, { [companyRegion]: "West" }));
  ok(
    "  and a company field sent for it is no field of a vendor's",
    !((await db.company.findUnique({ where: { id: fielded.id }, select: { customFields: true } }))?.customFields as Record<string, unknown>)[companyRegion],
    refusedField.ok ? "saved nothing of it" : refusedField.error,
  );

  // ── Reminders that chime ────────────────────────────────────────────────────────────────────

  section("18. A meeting about to start, and its chime");
  /* eslint-disable @typescript-eslint/no-require-imports */
  const notifications = require("../src/actions/notification") as typeof import("../src/actions/notification");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const opened = new Date(Date.now() - 60_000).toISOString();
  const soon = await db.calendarEvent.create({
    data: { userId: seller.id, provider: "MICROSOFT", externalId: `${TAG}-soon`, title: `${TAG} Demo`, startsAt: new Date(Date.now() + 6 * 60_000), endsAt: new Date(Date.now() + 36 * 60_000), busy: true },
    select: { id: true },
  });
  await db.calendarEvent.create({
    data: { userId: seller.id, provider: "MICROSOFT", externalId: `${TAG}-later`, title: `${TAG} Later`, startsAt: new Date(Date.now() + 3 * 3600_000), endsAt: new Date(Date.now() + 4 * 3600_000), busy: true },
  });
  const pulse = await as(seller, () => notifications.notificationPulse(opened));
  const raised = await db.notification.findMany({ where: { userId: seller.id, type: "MEETING_SOON" }, select: { title: true } });
  ok("a meeting starting within ten minutes is a reminder; one in three hours isn't yet", raised.length === 1 && raised[0]!.title.includes(`${TAG} Demo`), json(raised));
  ok("  and it chimes — sounds are on unless turned off", pulse.chime?.type === "MEETING_SOON", json(pulse));
  const next = await as(seller, () => notifications.notificationPulse(new Date().toISOString()));
  ok("  once: the next ask raises nothing new and stays quiet", next.chime === null && (await db.notification.count({ where: { userId: seller.id, type: "MEETING_SOON" } })) === 1);
  await db.notification.deleteMany({ where: { userId: seller.id, type: "MEETING_SOON" } });
  await db.calendarEvent.update({ where: { id: soon.id }, data: { startsAt: new Date(Date.now() + 8 * 60_000) } });
  await as(seller, () => notifications.saveReminderSounds({ meetings: false }));
  const quiet = await as(seller, () => notifications.notificationPulse(opened));
  ok("moved, it is reminded again — but with meeting sounds off, it doesn't chime", (await db.notification.count({ where: { userId: seller.id, type: "MEETING_SOON" } })) === 1 && quiet.chime === null);
  await as(seller, () => notifications.saveReminderSounds({ off: true, meetings: true }));
  ok("every sound off is every sound off", json(await as(seller, () => notifications.getReminderSounds())) === json({ off: true }));
  await as(seller, () => notifications.saveReminderSounds({}));

  // ── The screens, rendered ───────────────────────────────────────────────────────────────────

  section("14. The screens");
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { BankAccountsManager } = require("../src/components/banking/bank-accounts-manager") as typeof import("../src/components/banking/bank-accounts-manager");
  const { VendorCodesManager } = require("../src/components/settings/vendor-codes-manager") as typeof import("../src/components/settings/vendor-codes-manager");
  const { PayoutDetailsButton } = require("../src/components/companies/payout-details-button") as typeof import("../src/components/companies/payout-details-button");
  const { ContactsList } = require("../src/components/companies/contacts-list") as typeof import("../src/components/companies/contacts-list");
  const people = await db.contact.findMany({ where: { companyId: client.id }, orderBy: { createdAt: "asc" } });
  const contactsHtml = renderToStaticMarkup(
    createElement(ContactsList, { companyId: client.id, companyName: client.name, contacts: people, canMeet: true, left: { [kavya.id]: "8 Oct 2026" } }),
  );
  const [present, departed] = contactsHtml.split("Left the company (1)");
  ok(
    "the contacts list keeps those still there on top, each with its actions as icons",
    !!departed && present!.includes(`${TAG} Vinay`) && present!.includes("HR") && present!.includes("WhatsApp ZZVB Vinay") && present!.includes("ZZVB Vinay has left"),
  );
  ok("  and the one who left below, with the day and a way back", !present!.includes(`${TAG} Kavya`) && departed!.includes(`${TAG} Kavya`) && departed!.includes("Left 8 Oct 2026") && departed!.includes("is back at"));
  await as(seller, () => companies.setContactLeft(kavya.id, false));
  const backHtml = renderToStaticMarkup(createElement(ContactsList, { companyId: client.id, companyName: client.name, contacts: people, canMeet: true }));
  ok("a contact's LinkedIn is an icon of its own, opening in a new tab", backHtml.includes("ZZVB Kavya on LinkedIn") && backHtml.includes('href="https://linkedin.com/in/zzvb-kavya"') && backHtml.includes('referrerPolicy="no-referrer"'));
  ok("  and the role reads as words", backHtml.includes("IT manager") && !backHtml.includes("IT_MANAGER") && !backHtml.includes("IT MANAGER"));
  const { DesignationsManager } = require("../src/components/settings/designations-manager") as typeof import("../src/components/settings/designations-manager");
  const { ReminderSoundsCard } = require("../src/components/notifications/reminder-sounds-card") as typeof import("../src/components/notifications/reminder-sounds-card");
  const { ContactsTable } = require("../src/components/contacts/contacts-table") as typeof import("../src/components/contacts/contacts-table");
  const designationsHtml = renderToStaticMarkup(createElement(DesignationsManager, { designations: await as(boss, () => designationActions.listDesignationsForSettings()) }));
  ok(
    "Settings › Lists: each designation renamable, with its type, its contacts, and merge",
    designationsHtml.includes('value="Network Engineer"') && designationsHtml.includes("Type of Network Engineer") && designationsHtml.includes(`${await db.contact.count({ where: { designationId: engineerId } })} contacts`) && designationsHtml.includes("Merge Network Engineer into another designation"),
  );
  const soundsHtml = renderToStaticMarkup(createElement(ReminderSoundsCard, { sounds: { notes: false } }));
  ok(
    "Notifications › Preferences: sounds on, one kind off, and a way to hear it",
    soundsHtml.includes("Play a sound when a reminder arrives") && soundsHtml.includes("A meeting is about to start") && soundsHtml.includes("Play the sound") && (soundsHtml.match(/checked=""/g) ?? []).length === 4,
  );
  const tableRows = await as(seller, () => contactActions.listAllContactsPaged({ page: 1, pageSize: 50, status: "all", search: TAG }));
  const tableHtml = renderToStaticMarkup(createElement(ContactsTable, { contacts: tableRows.rows }));
  ok(
    "the Contacts page shows a designation's name, who has left, and LinkedIn as an icon",
    tableHtml.includes("Head of Procurement") && tableHtml.includes(">Left<") && tableHtml.includes("ZZVB Anjali on LinkedIn"),
  );
  const stillThere = await as(seller, () => contactActions.listAllContactsPaged({ page: 1, pageSize: 50, search: TAG }));
  ok("  and lists only those still there unless asked", !stillThere.rows.some((r) => r.leftAt) && tableRows.rows.some((r) => r.leftAt));
  if (joinedThere.ok) {
    const homePeople = await db.contact.findMany({ where: { companyId: newHome.id } });
    const homeHtml = renderToStaticMarkup(
      createElement(ContactsList, { companyId: newHome.id, companyName: newHome.name, contacts: homePeople, moves: await contactMovesOf(homePeople.map((p) => p.id)) }),
    );
    ok("a moved person's new record links to the company they were at before", homeHtml.includes(`Previously at ${client.name}`));
  }
  /* eslint-enable @typescript-eslint/no-require-imports */
  const vendorList = await as(finance, () => companyBank.listCompanyBankAccounts(v1.id));
  const sellerList = await as(seller, () => companyBank.listCompanyBankAccounts(v1.id));
  if (vendorList.ok && sellerList.ok) {
    const forFinance = renderToStaticMarkup(
      createElement(BankAccountsManager, { scope: { kind: "company", companyId: v1.id }, accounts: vendorList.data.accounts, canManage: true, emptyText: "None" }),
    );
    const forSeller = renderToStaticMarkup(
      createElement(BankAccountsManager, { scope: { kind: "company", companyId: v1.id }, accounts: sellerList.data.accounts, canManage: false, emptyText: "None" }),
    );
    ok("a vendor's list shows each account, the primary marked, with its actions for finance", forFinance.includes("USD") && forFinance.includes("Primary") && forFinance.includes("Make primary") && forFinance.includes("+ Add bank account"));
    ok("  and to anyone else only masked numbers, without the actions", forSeller.includes("•••• 8888") && !forSeller.includes("77778888") && !forSeller.includes("Edit account") && !forSeller.includes("Add bank account"));
    ok("  with no Retire on a vendor's", !forFinance.includes("Retire"));
  }
  const orgList = await as(boss, () => orgBank.listOrganisationBankAccounts());
  const orgHtml = renderToStaticMarkup(createElement(BankAccountsManager, { scope: { kind: "organisation" }, accounts: orgList ?? [], canManage: true, emptyText: "None" }));
  ok("the organisation's list marks the retired one and names the branch that defaults to an account", orgHtml.includes("Retired") && orgHtml.includes("Put back in use") && orgHtml.includes(`Default for ${head.name}`), "");
  const codesHtml = renderToStaticMarkup(createElement(VendorCodesManager, { settings: { prefix: "ZV-", nextCode: "ZV-0049", withoutCode: 3 } }));
  ok("Settings › Vendor codes shows the prefix, the next code and the vendors without one", codesHtml.includes('value="ZV-"') && codesHtml.includes("ZV-0049") && codesHtml.includes("3 vendors have no code yet") && codesHtml.includes("Give them codes"));
  const payoutHtml = renderToStaticMarkup(createElement(PayoutDetailsButton, { companyId: v1.id, panNumber: "ABCDE1234F" }));
  ok("the payout button is about the PAN alone now", payoutHtml.includes("PAN set") && !/account number/i.test(payoutHtml));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
