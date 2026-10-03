/**
 * check:payments-fx — payments in foreign currency, and deleting a payment, against a real database
 * that is not the owner's.
 *
 * Builds a scratch workspace database beside the real one (migrated from scratch, as check:ledger-close
 * does), drives the real actions as a workspace pointed at it (`runAsTenant`), and drops it at the end,
 * pass or fail. The last section reads the real database before and after to prove nothing of this
 * suite's reached it.
 *
 * Every figure is asserted exactly. Invoices are booked at ₹83 per dollar unless said otherwise:
 *
 *   · a USD invoice paid at another rate books the realised gain or loss, and AR goes to nil;
 *   · paid in two parts at two more rates, each part books its own difference;
 *   · rupees received on account and set against a USD invoice at a rate agreed on the day;
 *   · a USD bill paid, and refused to somebody without payments.record;
 *   · a rupee invoice unchanged — rate 1, no exchange entry — even one carrying a leftover rate;
 *   · deleting each payment (one at a time, in bulk, a cheque that cleared) reverses every entry it
 *     made, and removing an allocation or cancelling the invoice reverses its exchange difference;
 *   · the ledger-drift check and the close's AR/AP tie-out agree with all of it, and the drift check
 *     finds each thing left standing on purpose;
 *   · companyPaymentSummary and the COLLECTED_VALUE target in rupees;
 *   · runDepreciation's "already charged" check: a second run for the month charges nothing.
 *
 *   npm run check:payments-fx
 *   TZ=UTC npm run check:payments-fx      (from PowerShell for Asia/Kolkata: $env:TZ = "Asia/Kolkata")
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const ist = (s: string) => new Date(`${s}+05:30`);
const round2 = (n: number) => Math.round(n * 100) / 100;

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const TAG = "ZZPAYFX";

// ── Who the actions think is calling ────────────────────────────────────────────────────────────

let actor: { id: string; name: string; email: string; role: string } | null = null;

const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
class UnauthorizedError extends Error {}
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
  UnauthorizedError,
};
const navigation = {
  notFound: () => {
    throw new Error("NOT_FOUND_CALLED");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
  permanentRedirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const email = { sendEmailNotification: async () => {} };
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/navigation", navigation],
  ["@/lib/session", session],
  ["@/lib/email", email],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/navigation"), navigation],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("../src/lib/email"), email],
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

// ── The scratch database ────────────────────────────────────────────────────────────────────────

async function main() {
  const realUrl = process.env.DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);

  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_payments_fx`;
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

    // From here on anything reaching for the environment's workspace lands in the scratch one too, and
    // the control plane is switched off by value (a Prisma client reloads .env for a missing variable).
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = "";

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    closeAll = () => db.$disconnect();
    /* eslint-enable @typescript-eslint/no-require-imports */
    await run(scratchUrl);
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
  ok("its payments, allocations and journal are as they were", realAfter.counts === realBefore.counts, realAfter.counts);
  ok("  and nothing of this suite's is in it", realAfter.tagged === 0 && realBefore.tagged === 0, realAfter.tagged);

  console.log(failures === 0 ? `\nAll ${passes} payments-fx checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** What the suite must never change in the real workspace. Read-only. */
async function snapshot(client: PrismaClient) {
  const [payments, allocations, entries, assets, tagged] = await Promise.all([
    client.payment.count(),
    client.paymentAllocation.count(),
    client.journalEntry.count(),
    client.depreciationCharge.count(),
    client.company.count({ where: { name: { startsWith: TAG } } }),
  ]);
  return { counts: JSON.stringify({ payments, allocations, entries, assets }), tagged };
}

// ── The suite ───────────────────────────────────────────────────────────────────────────────────

async function run(scratchUrl: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db, getTenantDb } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const journal = require("../src/lib/ledger/journal") as typeof import("../src/lib/ledger/journal");
  const { SYSTEM_ACCOUNTS } = require("../src/lib/ledger/chart") as typeof import("../src/lib/ledger/chart");
  const { findLedgerDrift } = require("../src/lib/ledger/drift") as typeof import("../src/lib/ledger/drift");
  const { loadTieOut, tieOut } = require("../src/lib/close/tieout") as typeof import("../src/lib/close/tieout");
  const months = require("../src/lib/close/months") as typeof import("../src/lib/close/months");
  // The books keep India's calendar in every workspace.
  const { indiaClock } = require("../src/lib/time/zone") as typeof import("../src/lib/time/zone");
  const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
  const { measure } = require("../src/lib/targets/measure") as typeof import("../src/lib/targets/measure");
  const receivable = require("../src/actions/receivable") as typeof import("../src/actions/receivable");
  const payable = require("../src/actions/payable") as typeof import("../src/actions/payable");
  const payments = require("../src/actions/payment") as typeof import("../src/actions/payment");
  const assets = require("../src/actions/asset") as typeof import("../src/actions/asset");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const tenant = {
    id: randomUUID(),
    slug: "zzpayfx",
    name: "zzpayfx",
    status: "ACTIVE" as const,
    dbUrl: scratchUrl,
    primaryHost: "zzpayfx.localhost",
    hosts: ["zzpayfx.localhost"],
    source: "env" as const,
    isDefault: false,
    keyBundleCipher: null,
    country: "IN",
    entitlements: { v: 1 as const, all: true, modules: [], seats: null, copilotTokens: null, customDomains: null, plans: [] },
    holdReason: null,
  };

  await runAsTenant(tenant, async () => {
    const tx = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => db.$transaction(fn, { timeout: 60_000 });
    const today = indiaClock.today();

    // ── Fixture ────────────────────────────────────────────────────────────────────────────────
    section("Fixture");
    const user = (key: string, role: string, extra: { isSuperAdmin?: boolean } = {}) =>
      db.user.create({
        data: { name: `${TAG} ${key}`, email: `${TAG.toLowerCase()}-${key.toLowerCase()}@example.test`, passwordHash: "!", role, ...extra },
        select: { id: true, name: true, email: true, role: true },
      });
    const owner = await user("Owner", "ADMIN", { isSuperAdmin: true });
    const clerk = await user("Clerk", "SALES");
    const seller = await user("Seller", "SALES");
    await db.userPermission.create({ data: { userId: clerk.id, permission: "payments.record", allowed: false, reason: `${TAG}: may not record payments` } });
    await db.branch.create({ data: { name: `${TAG} Head office`, code: "HO", isHeadOffice: true } });
    await journal.ensureChartOfAccounts(db);
    actor = owner;
    ok("a super admin, a clerk refused payments.record, a salesperson, a head office and the chart", (await can(owner.id, "payments.record")) && !(await can(clerk.id, "payments.record")));

    const company = (name: string) =>
      db.company.create({ data: { name: `${TAG} ${name}`, normalizedName: `${TAG.toLowerCase()} ${name.toLowerCase()}`, createdById: owner.id }, select: { id: true } });

    let seq = 0;
    /** An issued document, posted as issuing posts it. No tax unless given, so the figures stay round. */
    const doc = async (d: {
      docType: "INVOICE" | "BILL";
      companyId: string;
      issueDate: Date;
      currency: string;
      rate: number;
      taxable: number;
      igst?: number;
      salespersonId?: string;
    }) => {
      seq += 1;
      const total = round2(d.taxable + (d.igst ?? 0));
      const row = await db.tradeDocument.create({
        data: {
          docNumber: `${TAG}-${d.docType}-${seq}`,
          docType: d.docType,
          direction: d.docType === "BILL" ? "PURCHASE" : "SALES",
          status: "ISSUED",
          companyId: d.companyId,
          createdById: owner.id,
          salespersonId: d.salespersonId ?? null,
          issueDate: d.issueDate,
          currency: d.currency,
          exchangeRate: d.rate,
          subtotal: d.taxable,
          taxableValue: d.taxable,
          igstAmount: d.igst ?? 0,
          total,
        },
        select: { id: true, docNumber: true },
      });
      await tx((t) => journal.postDocumentToLedger(t, row.id, owner.id));
      return row;
    };

    /** A party's balance on AR or AP over every entry: debit − credit. */
    const party = async (key: string, companyId: string) => {
      const s = await db.journalLine.aggregate({ where: { account: { systemKey: key }, companyId }, _sum: { debit: true, credit: true } });
      return round2(Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0));
    };
    const AR = (companyId: string) => party(SYSTEM_ACCOUNTS.AR, companyId);
    const AP = (companyId: string) => party(SYSTEM_ACCOUNTS.AP, companyId);
    /** An account's balance over every entry, debit − credit. */
    const balance = async (key: string) => {
      const s = await db.journalLine.aggregate({ where: { account: { systemKey: key } }, _sum: { debit: true, credit: true } });
      return round2(Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0));
    };
    const bank = () => balance(SYSTEM_ACCOUNTS.BANK);
    /** Exchange gain as a positive figure: the account is credit-natured when it gains. */
    const fxGain = async () => -(await balance(SYSTEM_ACCOUNTS.FX_GAIN_LOSS));
    const status = async (id: string) => (await db.tradeDocument.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
    /** A payment's entries by source, with each line's account and figures. */
    const entriesOf = (paymentId: string) =>
      db.journalEntry.findMany({
        where: { paymentId },
        orderBy: { entryNumber: "asc" },
        select: {
          id: true, entryNumber: true, source: true, date: true, reversesId: true, narration: true,
          reversedBy: { select: { id: true, date: true } },
          lines: { orderBy: { sortOrder: "asc" }, select: { debit: true, credit: true, companyId: true, account: { select: { systemKey: true } } } },
        },
      });
    const line = (e: Awaited<ReturnType<typeof entriesOf>>[number] | undefined, key: string) => {
      const l = e?.lines.find((x) => x.account.systemKey === key);
      return l ? { debit: Number(l.debit), credit: Number(l.credit) } : null;
    };
    const idOf = (r: { ok: boolean; data?: unknown; error?: string }) => {
      if (!r.ok) throw new Error(`the action refused: ${r.error}`);
      return (r.data as { id: string }).id;
    };

    const bank0 = await bank();
    const fx0 = await fxGain();

    // ── 1. Paid in full at another rate ────────────────────────────────────────────────────────
    section("1. A USD invoice paid in full at another rate");
    const alpha = await company("Alpha");
    const invA = await doc({ docType: "INVOICE", companyId: alpha.id, issueDate: ist("2025-10-10T11:00:00"), currency: "USD", rate: 83, taxable: 1000 });
    ok("$1,000 invoiced at ₹83: AR ₹83,000", (await AR(alpha.id)) === 83000, await AR(alpha.id));

    const payA = idOf(await receivable.recordInvoicePayment({ invoiceId: invA.id, amount: "1000", paidOn: "2025-11-05", method: "BANK_TRANSFER", exchangeRate: "84.10" }));
    const payARow = await db.payment.findUniqueOrThrow({ where: { id: payA }, select: { currency: true, exchangeRate: true, amount: true, allocations: { select: { amount: true, paymentAmount: true, exchangeRate: true } } } });
    ok(
      "received $1,000 at ₹84.10: the payment is USD 1,000 at 84.1, and its allocation $1,000 with no cross-currency figures",
      payARow.currency === "USD" && Number(payARow.exchangeRate) === 84.1 && Number(payARow.amount) === 1000 &&
        payARow.allocations.length === 1 && Number(payARow.allocations[0]!.amount) === 1000 && payARow.allocations[0]!.paymentAmount === null && payARow.allocations[0]!.exchangeRate === null,
    );
    const entA = await entriesOf(payA);
    const postA = entA.find((e) => e.source === "PAYMENT");
    const fxA = entA.find((e) => e.source === "FX");
    ok("  the payment: Dr Bank 84,100 / Cr AR 84,100", line(postA, "BANK")?.debit === 84100 && line(postA, "AR")?.credit === 84100, postA?.entryNumber);
    ok("  the exchange difference: Dr AR 1,100 / Cr FX gain 1,100, on the day it came in", line(fxA, "AR")?.debit === 1100 && line(fxA, "FX_GAIN_LOSS")?.credit === 1100 && !!fxA && indiaClock.dateKey(fxA.date) === "2025-11-05", fxA?.narration);
    ok("  AR is nil: 83,000 − 84,100 + 1,100", (await AR(alpha.id)) === 0, await AR(alpha.id));
    ok("  the bank is up ₹84,100 and the gain is ₹1,100", round2((await bank()) - bank0) === 84100 && round2((await fxGain()) - fx0) === 1100);
    ok("  and the invoice reads PAID", (await status(invA.id)) === "PAID");
    const settledA = await receivable.getInvoiceSettlement(invA.id);
    ok("  its panel is in dollars: total $1,000, paid $1,000, booked at 83", settledA?.currency === "USD" && settledA.total === 1000 && settledA.paid === 1000 && settledA.exchangeRate === 83);

    const delA = await payments.deletePayment(payA);
    const afterA = await db.journalEntry.findMany({ where: { id: { in: entA.map((e) => e.id) } }, select: { reversedBy: { select: { date: true } } } });
    ok("deleting it reverses both entries, dated today", delA.ok && afterA.length === 2 && afterA.every((e) => !!e.reversedBy && indiaClock.dateKey(e.reversedBy.date) === today));
    ok("  AR is back to ₹83,000, the bank and the gain to where they were", (await AR(alpha.id)) === 83000 && (await bank()) === bank0 && (await fxGain()) === fx0, `${await AR(alpha.id)} / ${await bank()} / ${await fxGain()}`);
    ok("  and the invoice is ISSUED again", (await status(invA.id)) === "ISSUED");

    // ── 2. In two parts ────────────────────────────────────────────────────────────────────────
    section("2. A part payment, then the rest at a third rate");
    const beta = await company("Beta");
    const invB = await doc({ docType: "INVOICE", companyId: beta.id, issueDate: ist("2025-10-11T11:00:00"), currency: "USD", rate: 83, taxable: 1000 });
    const payB1 = idOf(await receivable.recordInvoicePayment({ invoiceId: invB.id, amount: "400", paidOn: "2025-11-10", method: "BANK_TRANSFER", exchangeRate: "84.10" }));
    ok("$400 at ₹84.10: bank 33,640, gain 440, AR 49,800 — the $600 left at ₹83", (await AR(beta.id)) === 49800 && round2((await bank()) - bank0) === 33640 && round2((await fxGain()) - fx0) === 440, await AR(beta.id));
    ok("  PARTIALLY_PAID", (await status(invB.id)) === "PARTIALLY_PAID");
    const over = await receivable.recordInvoicePayment({ invoiceId: invB.id, amount: "700", paidOn: "2025-11-20", method: "BANK_TRANSFER", exchangeRate: "82.60" });
    ok("  $700 is refused in dollars: only $600.00 is outstanding", !over.ok && over.error.includes("$600.00"), over.ok ? "" : over.error);
    const payB2 = idOf(await receivable.recordInvoicePayment({ invoiceId: invB.id, amount: "600", paidOn: "2025-11-20", method: "BANK_TRANSFER", exchangeRate: "82.60" }));
    const fxB2 = (await entriesOf(payB2)).find((e) => e.source === "FX");
    ok("the other $600 at ₹82.60: bank 49,560, and a loss of 240 — Cr AR 240 / Dr FX 240", line(fxB2, "AR")?.credit === 240 && line(fxB2, "FX_GAIN_LOSS")?.debit === 240, fxB2?.narration);
    ok("  AR is nil: 49,800 − 49,560 − 240", (await AR(beta.id)) === 0, await AR(beta.id));
    ok("  bank up 83,200 in all, net gain 200", round2((await bank()) - bank0) === 83200 && round2((await fxGain()) - fx0) === 200);
    ok("  PAID", (await status(invB.id)) === "PAID");
    await payments.deletePayment(payB2);
    ok("deleting the second: AR 49,800, the loss gone, PARTIALLY_PAID", (await AR(beta.id)) === 49800 && round2((await fxGain()) - fx0) === 440 && (await status(invB.id)) === "PARTIALLY_PAID");
    await payments.deletePayment(payB1);
    ok("  and the first: AR 83,000, bank and gain back, ISSUED", (await AR(beta.id)) === 83000 && (await bank()) === bank0 && (await fxGain()) === fx0 && (await status(invB.id)) === "ISSUED");

    // ── 3. Rupees on account ───────────────────────────────────────────────────────────────────
    section("3. Rupees received on account, set against a USD invoice");
    const gamma = await company("Gamma");
    const onAccount = idOf(await payments.recordPayment({ companyId: gamma.id, amount: 90000, paidOn: "2025-11-01", method: "BANK_TRANSFER" }));
    ok("₹90,000 on account: AR −90,000", (await AR(gamma.id)) === -90000);
    const invC1 = await doc({ docType: "INVOICE", companyId: gamma.id, issueDate: ist("2025-11-15T10:00:00"), currency: "USD", rate: 83, taxable: 1000 });
    const invC2 = await doc({ docType: "INVOICE", companyId: gamma.id, issueDate: ist("2025-11-16T10:00:00"), currency: "USD", rate: 83, taxable: 2000 });

    const noRate = await receivable.applyPaymentToInvoice(onAccount, invC1.id, 1000);
    ok("applying without a rate is refused, and asks for one", !noRate.ok && noRate.error.includes("₹ per USD"), noRate.ok ? "" : noRate.error);
    const sevenPlaces = await receivable.applyPaymentToInvoice(onAccount, invC1.id, 1000, 84.1234567);
    ok("  a rate with seven decimals is refused", !sevenPlaces.ok && sevenPlaces.error.includes("six decimal"), sevenPlaces.ok ? "" : sevenPlaces.error);
    const zero = await receivable.applyPaymentToInvoice(onAccount, invC1.id, 1000, 0);
    ok("  a rate of 0 is refused", !zero.ok && zero.error.includes("more than zero"));
    const tooMuch = await receivable.applyPaymentToInvoice(onAccount, invC1.id, 1100, 84.1);
    ok("  $1,100 against $1,000 outstanding is refused", !tooMuch.ok && tooMuch.error.includes("$1,000.00"), tooMuch.ok ? "" : tooMuch.error);
    const tooDear = await receivable.applyPaymentToInvoice(onAccount, invC2.id, 1000, 90.1);
    ok("  $1,000 at ₹90.10 is ₹90,100, more than the ₹90,000 unapplied, and is refused", !tooDear.ok && tooDear.error.includes("₹90,100.00") && tooDear.error.includes("₹90,000.00"), tooDear.ok ? "" : tooDear.error);
    ok("  and none of those wrote anything", (await db.paymentAllocation.count({ where: { paymentId: onAccount } })) === 0 && (await db.journalEntry.count({ where: { paymentId: onAccount, source: "FX" } })) === 0);

    const allocC = idOf(await receivable.applyPaymentToInvoice(onAccount, invC1.id, 1000, 84.1));
    const allocCRow = await db.paymentAllocation.findUniqueOrThrow({ where: { id: allocC }, select: { amount: true, paymentAmount: true, exchangeRate: true } });
    ok("$1,000 at ₹84.10: the allocation settles $1,000 and takes ₹84,100, at 84.1", Number(allocCRow.amount) === 1000 && Number(allocCRow.paymentAmount) === 84100 && Number(allocCRow.exchangeRate) === 84.1);
    const fxC = (await entriesOf(onAccount)).find((e) => e.source === "FX");
    ok("  gain 1,100: Dr AR / Cr FX, dated the invoice's day (it came after the money)", line(fxC, "AR")?.debit === 1100 && line(fxC, "FX_GAIN_LOSS")?.credit === 1100 && !!fxC && indiaClock.dateKey(fxC.date) === "2025-11-15", fxC ? indiaClock.dateKey(fxC.date) : "none");
    ok("  AR: 83,000 + 166,000 − 90,000 + 1,100 = 1,60,100 — the $2,000 open less ₹5,900 on account", (await AR(gamma.id)) === 160100, await AR(gamma.id));
    ok("  the invoice is PAID, the other still ISSUED", (await status(invC1.id)) === "PAID" && (await status(invC2.id)) === "ISSUED");
    const listedC = (await payments.listCompanyPayments(gamma.id)).find((p) => p.id === onAccount);
    ok("  the payment shows ₹84,100 allocated and ₹5,900 unallocated", listedC?.allocated === 84100 && listedC.unallocated === 5900, `${listedC?.allocated} / ${listedC?.unallocated}`);
    const summaryC = await payments.companyPaymentSummary(gamma.id);
    ok("  the company summary: ₹90,000 received, ₹5,900 unallocated (it said ₹90,000: invoice money counted as unallocated)", summaryC.received === 90000 && summaryC.unallocated === 5900, JSON.stringify(summaryC));
    const statementC = await receivable.customerStatement(gamma.id);
    ok("  the statement: ₹5,900 of payments unapplied", statementC?.unappliedPayments === 5900, statementC?.unappliedPayments);

    const unallocate = await payments.deleteAllocation(allocC);
    const fxCAfter = fxC ? await db.journalEntry.findUniqueOrThrow({ where: { id: fxC.id }, select: { reversedBy: { select: { id: true } } } }) : null;
    ok("removing the allocation reverses its gain", unallocate.ok && !!fxCAfter?.reversedBy && round2((await fxGain()) - fx0) === 0);
    ok("  AR 1,59,000 — both invoices open, the ₹90,000 on account — and the invoice ISSUED", (await AR(gamma.id)) === 159000 && (await status(invC1.id)) === "ISSUED", await AR(gamma.id));
    ok("  the payment is all unallocated again", (await payments.listCompanyPayments(gamma.id)).find((p) => p.id === onAccount)?.unallocated === 90000);
    idOf(await receivable.applyPaymentToInvoice(onAccount, invC1.id, 1000, 84.1));
    await payments.deletePayment(onAccount);
    ok("applied again, then the payment deleted: its receipt and its gain both reversed — AR ₹2,49,000, the bank and FX back", (await AR(gamma.id)) === 249000 && round2((await fxGain()) - fx0) === 0 && (await bank()) === bank0 && (await status(invC1.id)) === "ISSUED", await AR(gamma.id));

    // ── 4. A USD bill ──────────────────────────────────────────────────────────────────────────
    section("4. A USD bill paid");
    const vendor = await company("Vendor");
    const bill = await doc({ docType: "BILL", companyId: vendor.id, issueDate: ist("2025-10-12T15:00:00"), currency: "USD", rate: 83, taxable: 1000, igst: 180 });
    ok("$1,180 billed at ₹83: AP ₹97,940", (await AP(vendor.id)) === -97940);
    actor = clerk;
    const refused = await payable.recordBillPayment({ billId: bill.id, amount: "1180", paidOn: "2025-11-20", method: "BANK_TRANSFER", exchangeRate: "82.50" });
    ok("somebody without payments.record is refused, as on the receivables side", !refused.ok && refused.error.includes("permission") && (await db.payment.count({ where: { companyId: vendor.id } })) === 0, refused.ok ? "" : refused.error);
    actor = owner;
    const overBill = await payable.recordBillPayment({ billId: bill.id, amount: "2000", paidOn: "2025-11-20", method: "BANK_TRANSFER", exchangeRate: "82.50" });
    ok("  $2,000 is refused in dollars: only $1,180.00 is outstanding", !overBill.ok && overBill.error.includes("$1,180.00"), overBill.ok ? "" : overBill.error);
    const paidBill = idOf(await payable.recordBillPayment({ billId: bill.id, amount: "1180", paidOn: "2025-11-20", method: "BANK_TRANSFER", exchangeRate: "82.50" }));
    const entBill = await entriesOf(paidBill);
    ok("paid at ₹82.50: Dr AP 97,350 / Cr Bank 97,350", line(entBill.find((e) => e.source === "PAYMENT"), "AP")?.debit === 97350 && line(entBill.find((e) => e.source === "PAYMENT"), "BANK")?.credit === 97350);
    ok("  gain 590: Dr AP 590 / Cr FX 590", line(entBill.find((e) => e.source === "FX"), "AP")?.debit === 590 && line(entBill.find((e) => e.source === "FX"), "FX_GAIN_LOSS")?.credit === 590);
    ok("  AP nil, bank down 97,350, the bill PAID", (await AP(vendor.id)) === 0 && round2((await bank()) - bank0) === -97350 && (await status(bill.id)) === "PAID");
    const billSettled = await payable.getBillSettlement(bill.id);
    ok("  its panel is in dollars", billSettled?.currency === "USD" && billSettled.paid === 1180 && billSettled.exchangeRate === 83);
    await payments.deletePayment(paidBill);
    ok("deleted: AP ₹97,940 again, the bank and the gain back, the bill ISSUED", (await AP(vendor.id)) === -97940 && (await bank()) === bank0 && (await fxGain()) === fx0 && (await status(bill.id)) === "ISSUED");

    // ── 5. Rupees ──────────────────────────────────────────────────────────────────────────────
    section("5. A rupee invoice is unchanged");
    const delta = await company("Delta");
    // Carrying a rate from before the form refused one on a rupee document.
    const invD = await doc({ docType: "INVOICE", companyId: delta.id, issueDate: ist("2025-10-15T11:00:00"), currency: "INR", rate: 83.25, taxable: 10000, igst: 1800 });
    ok("₹11,800 invoiced: AR ₹11,800 (the leftover rate is not applied)", (await AR(delta.id)) === 11800);
    const payD = idOf(await receivable.recordInvoicePayment({ invoiceId: invD.id, amount: "11800", paidOn: "2025-11-05", method: "UPI", exchangeRate: "90" }));
    const payDRow = await db.payment.findUniqueOrThrow({ where: { id: payD }, select: { currency: true, exchangeRate: true } });
    const entD = await entriesOf(payD);
    ok("received in full: INR at rate 1 whatever rate is sent — not the invoice's leftover 83.25", payDRow.currency === "INR" && Number(payDRow.exchangeRate) === 1, `${payDRow.currency} @ ${payDRow.exchangeRate}`);
    ok("  one entry, Dr Bank 11,800 / Cr AR 11,800, and no exchange entry", entD.length === 1 && line(entD[0], "BANK")?.debit === 11800 && line(entD[0], "AR")?.credit === 11800);
    ok("  AR nil, PAID", (await AR(delta.id)) === 0 && (await status(invD.id)) === "PAID");
    await payments.deletePayment(payD);
    ok("  deleted: AR ₹11,800, ISSUED", (await AR(delta.id)) === 11800 && (await status(invD.id)) === "ISSUED" && (await bank()) === bank0);

    // ── 6. A cheque that cleared ───────────────────────────────────────────────────────────────
    section("6. A cheque against a USD invoice, cleared, then deleted: three entries reversed");
    const echo = await company("Echo");
    const invE = await doc({ docType: "INVOICE", companyId: echo.id, issueDate: ist("2025-10-16T11:00:00"), currency: "USD", rate: 83, taxable: 500 });
    const cih0 = await balance(SYSTEM_ACCOUNTS.CHEQUES_IN_HAND);
    const payE = idOf(await receivable.recordInvoicePayment({ invoiceId: invE.id, amount: "500", paidOn: "2025-11-06", method: "CHEQUE", exchangeRate: "84" }));
    const clearedOn = new Date("2025-11-09T00:00:00.000Z");
    await tx(async (t) => {
      await t.payment.update({ where: { id: payE }, data: { clearedOn } });
      await journal.postChequeClearingToLedger(t, payE, owner.id, clearedOn);
    });
    const entE = await entriesOf(payE);
    ok(
      "$500 at ₹84: cheques in hand 42,000, a gain of 500, then cleared into the bank",
      entE.length === 3 && line(entE.find((e) => e.source === "PAYMENT" && !e.narration.includes("cleared")), "CHEQUES_IN_HAND")?.debit === 42000 &&
        line(entE.find((e) => e.source === "FX"), "FX_GAIN_LOSS")?.credit === 500 && line(entE.find((e) => e.narration.includes("cleared")), "BANK")?.debit === 42000,
      entE.map((e) => `${e.source}: ${e.narration}`).join("; "),
    );
    ok("  AR nil, bank +42,000, cheques in hand back to nil", (await AR(echo.id)) === 0 && round2((await bank()) - bank0) === 42000 && (await balance(SYSTEM_ACCOUNTS.CHEQUES_IN_HAND)) === cih0);
    await payments.deletePayment(payE);
    const reversedE = await db.journalEntry.count({ where: { id: { in: entE.map((e) => e.id) }, reversedBy: { isNot: null } } });
    ok("deleted: all three reversed — before, only whichever came first", reversedE === 3, `${reversedE} of 3`);
    ok("  AR ₹41,500, bank, cheques in hand and FX where they were", (await AR(echo.id)) === 41500 && (await bank()) === bank0 && (await balance(SYSTEM_ACCOUNTS.CHEQUES_IN_HAND)) === cih0 && (await fxGain()) === fx0);

    // ── 7. In bulk ─────────────────────────────────────────────────────────────────────────────
    section("7. Bulk delete reverses every payment's entries and re-derives the invoices");
    const foxtrot = await company("Foxtrot");
    const invF1 = await doc({ docType: "INVOICE", companyId: foxtrot.id, issueDate: ist("2025-10-17T11:00:00"), currency: "USD", rate: 83, taxable: 300 });
    const invF2 = await doc({ docType: "INVOICE", companyId: foxtrot.id, issueDate: ist("2025-10-17T12:00:00"), currency: "INR", rate: 1, taxable: 5000 });
    const payF1 = idOf(await receivable.recordInvoicePayment({ invoiceId: invF1.id, amount: "300", paidOn: "2025-11-07", method: "BANK_TRANSFER", exchangeRate: "85" }));
    const payF2 = idOf(await receivable.recordInvoicePayment({ invoiceId: invF2.id, amount: "5000", paidOn: "2025-11-07", method: "BANK_TRANSFER" }));
    ok("$300 at ₹85 (gain 600) and ₹5,000, both PAID, AR nil", (await AR(foxtrot.id)) === 0 && (await status(invF1.id)) === "PAID" && (await status(invF2.id)) === "PAID" && round2((await fxGain()) - fx0) === 600);
    const liveF = await db.journalEntry.findMany({ where: { paymentId: { in: [payF1, payF2] } }, select: { id: true } });
    const bulk = await payments.bulkDeletePayments([payF1, payF2]);
    const reversedF = await db.journalEntry.count({ where: { id: { in: liveF.map((e) => e.id) }, reversedBy: { isNot: null } } });
    ok("bulk-deleted: two payments, all three entries reversed (it deleted the rows and nothing else)", bulk.ok && bulk.data.count === 2 && liveF.length === 3 && reversedF === 3, `${reversedF} of ${liveF.length}`);
    ok("  AR ₹24,900 + ₹5,000 again, the gain gone, the bank back, both ISSUED", (await AR(foxtrot.id)) === 29900 && (await fxGain()) === fx0 && (await bank()) === bank0 && (await status(invF1.id)) === "ISSUED" && (await status(invF2.id)) === "ISSUED");

    // ── 8. Cancelled after payment ─────────────────────────────────────────────────────────────
    section("8. A paid USD invoice cancelled: its exchange difference goes with it");
    const golf = await company("Golf");
    const invG = await doc({ docType: "INVOICE", companyId: golf.id, issueDate: ist("2025-10-18T11:00:00"), currency: "USD", rate: 83, taxable: 200 });
    const payG = idOf(await receivable.recordInvoicePayment({ invoiceId: invG.id, amount: "200", paidOn: "2025-11-08", method: "BANK_TRANSFER", exchangeRate: "85" }));
    await tx(async (t) => {
      await t.tradeDocument.update({ where: { id: invG.id }, data: { status: "CANCELLED" } });
      await journal.reverseDocumentPosting(t, invG.id, owner.id);
    });
    const fxG = (await entriesOf(payG)).find((e) => e.source === "FX");
    ok("cancelled: the invoice's entry and the gain of 400 are both reversed", !!fxG?.reversedBy && round2((await fxGain()) - fx0) === 0);
    ok("  AR −₹17,000: the $200 received at ₹85, back on account", (await AR(golf.id)) === -17000, await AR(golf.id));

    // ── 9. A dollar receipt freed and applied again ────────────────────────────────────────────
    section("9. A USD receipt's allocation removed, and the dollars applied elsewhere");
    const hotel = await company("Hotel");
    const invH1 = await doc({ docType: "INVOICE", companyId: hotel.id, issueDate: ist("2025-10-19T11:00:00"), currency: "USD", rate: 83, taxable: 100 });
    const invH2 = await doc({ docType: "INVOICE", companyId: hotel.id, issueDate: ist("2025-10-20T11:00:00"), currency: "USD", rate: 80, taxable: 100 });
    const payH = idOf(await receivable.recordInvoicePayment({ invoiceId: invH1.id, amount: "100", paidOn: "2025-11-09", method: "BANK_TRANSFER", exchangeRate: "86" }));
    const allocH = await db.paymentAllocation.findFirstOrThrow({ where: { paymentId: payH }, select: { id: true } });
    ok("$100 at ₹86 against an invoice at ₹83: gain 300", round2((await fxGain()) - fx0) === 300);
    await payments.deleteAllocation(allocH.id);
    ok("the allocation removed: the gain reversed, the invoice ISSUED, $100 unallocated", round2((await fxGain()) - fx0) === 0 && (await status(invH1.id)) === "ISSUED" && (await payments.listCompanyPayments(hotel.id)).find((p) => p.id === payH)?.unallocated === 100);
    ok("  AR: 8,300 + 8,000 − 8,600", (await AR(hotel.id)) === 7700, await AR(hotel.id));
    const order = await payments.allocatePayment({ paymentId: payH, companyProductId: "none", amount: 50 });
    ok("  a dollar receipt can't go against an order (orders are rupees)", !order.ok && order.error.includes("USD"), order.ok ? "" : order.error);
    const wrongRate = await receivable.applyPaymentToInvoice(payH, invH2.id, 100, 90);
    ok("  applied to another USD invoice it keeps its own rate — another is refused", !wrongRate.ok && wrongRate.error.includes("86"), wrongRate.ok ? "" : wrongRate.error);
    idOf(await receivable.applyPaymentToInvoice(payH, invH2.id, 100));
    ok("  at its own ₹86 against the ₹80 invoice: gain 600, AR 8,300 (the first invoice)", round2((await fxGain()) - fx0) === 600 && (await AR(hotel.id)) === 8300 && (await status(invH2.id)) === "PAID");

    // ── 10. Rupees collected, in the targets and the tie-out ───────────────────────────────────
    section("10. What the books and the close say about all of it");
    const india = await company("India");
    const invK1 = await doc({ docType: "INVOICE", companyId: india.id, issueDate: ist("2025-12-01T11:00:00"), currency: "USD", rate: 83, taxable: 1000, salespersonId: seller.id });
    const invK2 = await doc({ docType: "INVOICE", companyId: india.id, issueDate: ist("2025-12-02T11:00:00"), currency: "USD", rate: 83, taxable: 500, salespersonId: seller.id });
    idOf(await receivable.recordInvoicePayment({ invoiceId: invK1.id, amount: "1000", paidOn: "2025-12-05", method: "BANK_TRANSFER", exchangeRate: "84.10" }));
    const rupeesK = idOf(await payments.recordPayment({ companyId: india.id, amount: 50000, paidOn: "2025-12-06", method: "BANK_TRANSFER" }));
    idOf(await receivable.applyPaymentToInvoice(rupeesK, invK2.id, 500, 84));
    // As the target screens measure it: on the workspace's own client (getTenantDb), not the routed db.
    const collected = await measure(await getTenantDb(), "COLLECTED_VALUE", { from: ist("2025-12-01T00:00:00"), to: ist("2025-12-31T23:59:59"), userIds: [seller.id] });
    ok("COLLECTED_VALUE for December is ₹84,100 + ₹42,000 = ₹1,26,100 — it added $1,000 and $500 as 1,500", collected === 126100, collected);

    const drift = await findLedgerDrift(db);
    ok("the drift check finds nothing wrong with any of it", drift.problems.length === 0, drift.problems.map((p) => p.message).join(" | "));
    const month = months.parseMonthKey(today.slice(0, 7))!;
    const arTie = tieOut(await loadTieOut("AR", month));
    const apTie = tieOut(await loadTieOut("AP", month));
    ok("the close's AR tie-out agrees with the ledger to the paisa", arTie.detail.difference === 0, `${arTie.detail.ageing} vs ${arTie.detail.ledger}`);
    ok("  and so does AP", apTie.detail.difference === 0, `${apTie.detail.ageing} vs ${apTie.detail.ledger}`);
    const unbalanced = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM (SELECT l."entryId" FROM journal_lines l GROUP BY l."entryId" HAVING SUM(l.debit) <> SUM(l.credit)) x`;
    ok("  and every entry in the scratch books balances", Number(unbalanced[0]?.n ?? 1) === 0);

    // ── 11. Depreciation, charged once ─────────────────────────────────────────────────────────
    section("11. runDepreciation: a second run for the month charges nothing");
    const assetAccount = await db.ledgerAccount.create({ data: { code: "ZZ-1299", name: `${TAG} Computers`, type: "ASSET" }, select: { id: true } });
    await db.fixedAsset.create({
      data: { tag: `${TAG}-A1`, name: "Laptop", purchasedOn: new Date("2026-01-01T00:00:00.000Z"), cost: 36000, usefulLifeYears: 3, assetAccountId: assetAccount.id, createdById: owner.id },
    });
    const first = await assets.runDepreciation({ month: 8, year: 2026 });
    ok("August 2026 charged: one asset, ₹1,000 (₹36,000 over three years)", first.ok && first.data.charged === 1 && first.data.total === 1000 && first.data.alreadyCharged === 0, first.ok ? JSON.stringify(first.data) : first.error);
    const second = await assets.runDepreciation({ month: 8, year: 2026 });
    ok("  again: nothing charged, and reported as already charged", second.ok && second.data.charged === 0 && second.data.total === 0 && second.data.alreadyCharged === 1, second.ok ? JSON.stringify(second.data) : second.error);
    ok(
      "  one charge row and one entry for the month — the charge's @db.Date and the run's 12:00 UTC month end are the same day",
      (await db.depreciationCharge.count()) === 1 && (await db.journalEntry.count({ where: { source: "DEPRECIATION" } })) === 1,
    );

    // ── 12. The drift check, finding what is left standing on purpose ──────────────────────────
    section("12. The drift check finds each thing left behind");
    const juliet = await company("Juliet");
    const invJ = await doc({ docType: "INVOICE", companyId: juliet.id, issueDate: ist("2025-10-21T11:00:00"), currency: "USD", rate: 83, taxable: 100 });
    const payJ = idOf(await receivable.recordInvoicePayment({ invoiceId: invJ.id, amount: "100", paidOn: "2025-11-10", method: "BANK_TRANSFER", exchangeRate: "85" }));
    // The row deleted the old way: nothing reversed.
    await db.paymentAllocation.deleteMany({ where: { paymentId: payJ } });
    const leftFx = await findLedgerDrift(db);
    ok("an allocation removed without its exchange difference", leftFx.problems.some((p) => p.kind === "fx-without-allocation"), leftFx.problems.map((p) => p.kind).join(", "));
    await db.payment.delete({ where: { id: payJ } });
    const orphaned = await findLedgerDrift(db);
    ok("  a payment deleted without its entries: both named", orphaned.problems.filter((p) => p.kind === "orphan-payment-entry").length === 2, orphaned.problems.map((p) => p.kind).join(", "));

    const invL = await doc({ docType: "INVOICE", companyId: juliet.id, issueDate: ist("2025-10-22T11:00:00"), currency: "USD", rate: 83, taxable: 100 });
    idOf(await receivable.recordInvoicePayment({ invoiceId: invL.id, amount: "100", paidOn: "2025-11-11", method: "BANK_TRANSFER", exchangeRate: "85" }));
    // Cancelled the old way: the invoice's own entry reversed, its exchange difference not.
    const own = await tx((t) => journal.currentDocumentEntry(t, invL.id));
    const ownLines = await db.journalLine.findMany({ where: { entryId: own!.id }, orderBy: { sortOrder: "asc" }, select: journal.reversibleLineSelect });
    await tx((t) =>
      journal.writeEntry(t, { date: new Date(), narration: `${TAG} old-style cancellation`, source: "MANUAL", userId: owner.id, lines: journal.reversedLines(ownLines), reversesId: own!.id }),
    );
    await db.tradeDocument.update({ where: { id: invL.id }, data: { status: "CANCELLED" } });
    const cancelledDrift = await findLedgerDrift(db);
    ok(
      "  a cancelled invoice whose exchange difference still stands — named as the payment's, not as the invoice's own posting",
      cancelledDrift.problems.some((p) => p.kind === "cancelled-fx-live" && p.message.includes(invL.docNumber)) &&
        !cancelledDrift.problems.some((p) => p.kind === "cancelled-live" && p.message.includes(invL.docNumber)),
      cancelledDrift.problems.filter((p) => p.message.includes(invL.docNumber)).map((p) => p.kind).join(", "),
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
