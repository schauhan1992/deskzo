/**
 * check:accounts-settings — Finance → Accounts › Accounts settings (owner, 22 Oct 2026).
 *
 *   · Only somebody holding “Change Accounts settings” reads or changes them — nobody by default; an admin
 *     has it, as everything. A page or a link hidden isn't the security: the actions refuse.
 *   · The defaults are how the books already behaved: periodic inventory, weighted average, no negative stock,
 *     nothing moving stock on its own.
 *   · The costing method can't change under stock on hand; a prefix has to be clean and its own series'.
 *   · Periodic → perpetual posts what is on hand to Stock in Hand against Opening Balance Equity, once, in the
 *     same transaction; perpetual isn't switched back.
 *
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:accounts-settings
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["@/lib/session", session],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("../src/lib/session"), session],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (byName.has(request)) return byName.get(request);
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

async function main() {
  section("The permission");
  const { getPermissionDefinition } = load("../src/lib/permissions") as typeof import("../src/lib/permissions");
  const def = getPermissionDefinition("accounts.configure");
  ok("“Change Accounts settings” is nobody's by default, sensitive, and not handed on", !!def && def.defaultRoles.length === 0 && def.delegable === false && def.tier === "sensitive");

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${realName}_acctset`;
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  let close: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, scratch) }, timeout: 10 * 60_000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);
    process.env.DATABASE_URL = withDatabase(url, scratch);
    process.env.CONTROL_DATABASE_URL = "";

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    close = () => db.$disconnect();
    const settingsActions = require("../src/actions/accounts-settings") as typeof import("../src/actions/accounts-settings");
    const { accountsSettings, DEFAULT_ACCOUNTS_SETTINGS } = require("../src/lib/accounts/settings") as typeof import("../src/lib/accounts/settings");
    const { recordOpeningStock } = require("../src/lib/inventory/opening") as typeof import("../src/lib/inventory/opening");
    const { ensureChartOfAccounts } = require("../src/lib/ledger/journal") as typeof import("../src/lib/ledger/journal");
    /* eslint-enable @typescript-eslint/no-require-imports */

    const person = (name: string, role: string) =>
      db.user.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zz-acctset.in`, passwordHash: "!", role }, select: { id: true, name: true, email: true, role: true } });
    const boss = await person("Zz Admin", "ADMIN");
    const accounts = await person("Zz Accounts", "ACCOUNTS");
    const sales = await person("Zz Sales", "SALES");
    const as = async <T,>(who: { id: string; name: string; email: string | null; role: string }, work: () => Promise<T>) => {
      const before = actor;
      actor = { id: who.id, name: who.name, email: who.email!, role: who.role };
      try {
        return await work();
      } finally {
        actor = before;
      }
    };

    section("The chart, set up by many requests at once");
    // A page fires several reports in parallel, and each makes sure the chart has its system accounts — on an
    // upgraded workspace, the stock accounts are missing the first time. None may fail on a duplicate code.
    const raced = await Promise.allSettled(Array.from({ length: 8 }, () => ensureChartOfAccounts()));
    ok("eight at once on an empty chart: none fails", raced.every((r) => r.status === "fulfilled"), raced.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason).slice(0, 120)));
    const keyed = await db.ledgerAccount.groupBy({ by: ["systemKey"], where: { systemKey: { not: null } }, _count: { _all: true } });
    ok("  and each system account is there once — the stock ones too", keyed.every((k) => k._count._all === 1) && ["INVENTORY", "GRNI", "COGS", "STOCK_ADJUSTMENT"].every((k) => keyed.some((r) => r.systemKey === k)), keyed.filter((k) => k._count._all !== 1));
    await db.ledgerAccount.deleteMany({ where: { systemKey: { in: ["INVENTORY", "GRNI", "COGS", "STOCK_ADJUSTMENT"] } } });
    const upgraded = await Promise.allSettled(Array.from({ length: 8 }, () => ensureChartOfAccounts()));
    ok("  and on an upgraded chart missing only the stock accounts, the same", upgraded.every((r) => r.status === "fulfilled") && (await db.ledgerAccount.count({ where: { systemKey: { in: ["INVENTORY", "GRNI", "COGS", "STOCK_ADJUSTMENT"] } } })) === 4);

    section("Who may");
    ok("a salesperson reads nothing", (await as(sales, () => settingsActions.getAccountsSettings())) === null);
    const base = { ...DEFAULT_ACCOUNTS_SETTINGS, seriesPrefixes: {} };
    const bySales = await as(sales, () => settingsActions.saveAccountsSettings({ ...base, allowNegativeStock: true }));
    ok("  and changes nothing", !bySales.ok, bySales.ok ? "SAVED" : bySales.error);
    const byAccounts = await as(accounts, () => settingsActions.saveAccountsSettings({ ...base, allowNegativeStock: true }));
    ok("Accounts doesn't have it by default either", !byAccounts.ok && (await as(accounts, () => settingsActions.getAccountsSettings())) === null);
    const view = await as(boss, () => settingsActions.getAccountsSettings());
    ok("an admin reads them", !!view && view.migrated);
    ok("  and they are the old behaviour: periodic, weighted average, no negative stock, nothing automatic", !!view && view.inventoryAccounting === "PERIODIC" && view.costingMethod === "WEIGHTED_AVERAGE" && !view.allowNegativeStock && !view.invoiceIssuesStock && !view.billReceivesStock && !view.creditNoteReturnsStock && !view.reserveOnOrderApproval);
    ok("  with a series for each kind of voucher, starting at 0001", !!view && view.series.length === 9 && view.series.every((s) => /\/\d{4}-\d{2}\/0001$/.test(s.next)), view?.series.map((s) => s.next));

    section("What is refused");
    const clash = await as(boss, () => settingsActions.saveAccountsSettings({ ...base, seriesPrefixes: { GRN: "PMT" } }));
    ok("two series with one prefix", !clash.ok && /PMT/.test(clash.ok ? "" : clash.error), clash.ok ? "SAVED" : clash.error);
    const dirty = await as(boss, () => settingsActions.saveAccountsSettings({ ...base, seriesPrefixes: { PAYMENT: "P@Y!" } }));
    ok("a prefix that isn't letters, digits or dashes", !dirty.ok);
    const decimals = await as(boss, () => settingsActions.saveAccountsSettings({ ...base, quantityDecimals: 5 }));
    ok("more than 3 quantity decimals", !decimals.ok);
    const prefixed = await as(boss, () => settingsActions.saveAccountsSettings({ ...base, seriesPrefixes: { PAYMENT: "pay" } }));
    const afterPrefix = await as(boss, () => settingsActions.getAccountsSettings());
    ok("a clean prefix is kept, upper-cased, for the next number", prefixed.ok && afterPrefix!.series.find((s) => s.key === "PAYMENT")!.next.startsWith("PAY/"), afterPrefix?.series.find((s) => s.key === "PAYMENT")?.next);

    section("Costing under stock");
    const item = await db.item.create({ data: { name: "Zz Widget", sku: "ZZ-WID-1", type: "GOOD", trackInventory: true, sellingPrice: 500, costPrice: 120, createdById: boss.id }, select: { id: true } });
    const current = await accountsSettings();
    await db.$transaction((tx) => recordOpeningStock(tx, { itemId: item.id, quantity: 10, unitCost: 120, userId: boss.id, reason: "Opening stock" }, current));
    const onHand = await db.stockBalance.aggregate({ _sum: { quantity: true, value: true } });
    ok("opening stock is on hand, valued", Number(onHand._sum.quantity) === 10 && Number(onHand._sum.value) === 1200, onHand._sum);
    const fifo = await as(boss, () => settingsActions.saveAccountsSettings({ ...base, seriesPrefixes: { PAYMENT: "PAY" }, costingMethod: "FIFO" }));
    ok("the costing method doesn't change under stock", !fifo.ok && /on hand/.test(fifo.ok ? "" : fifo.error), fifo.ok ? "SAVED" : fifo.error);
    ok("  and nothing else in that save was kept", (await accountsSettings()).costingMethod === "WEIGHTED_AVERAGE");

    section("Periodic to perpetual");
    const perpetual = await as(boss, () => settingsActions.saveAccountsSettings({ ...base, seriesPrefixes: { PAYMENT: "PAY" }, inventoryAccounting: "PERPETUAL" }));
    ok("switching to perpetual is saved", perpetual.ok && (await accountsSettings()).inventoryAccounting === "PERPETUAL", perpetual.ok ? perpetual.data : perpetual.error);
    const opening = await db.journalEntry.findMany({ where: { postingKey: { startsWith: "inventory:perpetual-opening:" } }, include: { lines: { include: { account: { select: { systemKey: true } } } } } });
    const line = (key: string) => opening[0]?.lines.find((l) => l.account.systemKey === key);
    ok("  with one opening entry, source INVENTORY", opening.length === 1 && opening[0]!.source === "INVENTORY", opening.length);
    ok("  Dr Stock in Hand ₹1,200, Cr Opening Balance Equity ₹1,200", Number(line("INVENTORY")?.debit) === 1200 && Number(line("OPENING_BALANCE_EQUITY")?.credit) === 1200, opening[0]?.lines.map((l) => [l.account.systemKey, Number(l.debit), Number(l.credit)]));
    const again = await as(boss, () => settingsActions.saveAccountsSettings({ ...base, seriesPrefixes: { PAYMENT: "PAY" }, inventoryAccounting: "PERPETUAL", allowNegativeStock: true }));
    ok("saving again posts nothing more", again.ok && (await db.journalEntry.count({ where: { postingKey: { startsWith: "inventory:perpetual-opening:" } } })) === 1);
    const back = await as(boss, () => settingsActions.saveAccountsSettings({ ...base, seriesPrefixes: { PAYMENT: "PAY" }, inventoryAccounting: "PERIODIC" }));
    ok("and perpetual isn't switched back", !back.ok && (await accountsSettings()).inventoryAccounting === "PERPETUAL", back.ok ? "SAVED" : back.error);

    section("On the record");
    const audits = await db.auditLog.findMany({ where: { entityType: "AccountsSettings" }, orderBy: { createdAt: "asc" }, select: { entityLabel: true } });
    ok("every saved change is in the audit log, by what changed", audits.length >= 3 && audits.some((a) => /Inventory accounting/.test(a.entityLabel ?? "") && /opening stock entry/.test(a.entityLabel ?? "")), audits.map((a) => a.entityLabel));
  } finally {
    await close?.();
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    await admin.$disconnect();
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
