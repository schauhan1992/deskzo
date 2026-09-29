/**
 * check:ledger-close — the ledger's Phase 0 fixes, against a real database that is not the owner's.
 *
 * Builds a scratch workspace database beside the real one (migrated from scratch, the way
 * check:tenancy-isolation does), works it through the ledger's own functions, and drops it at the
 * end, pass or fail. Nothing here closes a year, moves the lock or writes an entry in the real
 * workspace; the last section proves that by reading the real database before and after.
 *
 *   · F1 — a USD invoice and bill post at their rate, and posting again is a no-op;
 *   · settling them at another rate clears the receivable and the payable exactly, the difference
 *     going to exchange gain or loss;
 *   · the repair (`ledger:repost-fx`): a dry run that finds the rate-1 postings and writes nothing,
 *     the real script applying it to this workspace, and a second run that finds nothing; the
 *     repaired document's live entry is the one issuing finds and cancelling reverses;
 *   · F2 — the lock refuses an entry at 12:00 UTC on the locked day, and lets India's next day in;
 *   · F3 — closing a year takes in March's payroll and depreciation, dated 12:00 UTC on 31 March, and
 *     leaves 1 April alone;
 *   · F4 — reopening reverses through the write door: a number from the counter, every tag kept.
 *
 * Dates are written with India's offset spelled out, so the suite means the same under any clock:
 *
 *   npm run check:ledger-close
 *   TZ=UTC npm run check:ledger-close
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import type { PrismaClient, Prisma } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const ist = (s: string) => new Date(`${s}+05:30`);
const round2 = (n: number) => Math.round(n * 100) / 100;
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const TAG = "ZZLC";
const SLUG = "zzledgerclose";

type Tx = Prisma.TransactionClient;

async function main() {
  const realUrl = process.env.DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);

  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_ledger_close`;
  const scratchUrl = withDatabase(realUrl, scratchName);
  ok("  and it is not the real one", scratchName !== realName, scratchName);

  // What the real workspace's books say before; read again at the end to show nothing moved.
  const real = directClient(realUrl, { max: 1 });
  const realBefore = await snapshot(real);

  const admin = directClient(withDatabase(realUrl, "postgres"), { max: 1 });
  let client: PrismaClient | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60 * 1000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);

    // From here on, anything that reached for the shared `db` by mistake would land in the scratch
    // database too, not the owner's: the environment's workspace is the scratch one, and the control
    // plane is switched off by value (a Prisma client reloads .env for a variable that is missing).
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = "";

    client = directClient(scratchUrl, { max: 4 });
    await run(client, scratchUrl);
  } finally {
    await client?.$disconnect().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const gone = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratchName}'`);
    ok("the scratch database is dropped", Number(gone[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  section("The real workspace was not touched");
  const realAfter = await snapshot(real);
  await real.$disconnect();
  ok("its lock is as it was", realAfter.lock === realBefore.lock, realAfter.lock ?? "no lock");
  ok("  no year was closed or reopened", realAfter.closes === realBefore.closes, realAfter.closes);
  ok("  and no entry or document of this suite's is in it", realAfter.tagged === 0 && realBefore.tagged === 0, realAfter.tagged);

  console.log(failures === 0 ? "\nAll ledger close checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** What the suite must never change in the real workspace. Read-only. */
async function snapshot(db: PrismaClient) {
  const [lock, closes, entries, docs] = await Promise.all([
    db.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true, note: true } }),
    db.fiscalYearClose.findMany({ select: { label: true, closingEntryId: true }, orderBy: { label: "asc" } }),
    db.journalEntry.count({ where: { narration: { contains: TAG } } }),
    db.tradeDocument.count({ where: { docNumber: { startsWith: TAG } } }),
  ]);
  return {
    lock: lock ? `${lock.lockedUntil?.toISOString() ?? "null"} ${lock.note ?? ""}` : null,
    closes: JSON.stringify(closes),
    tagged: entries + docs,
  };
}

async function run(db: PrismaClient, scratchUrl: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const journal = require("../src/lib/ledger/journal") as typeof import("../src/lib/ledger/journal");
  const yearEnd = require("../src/lib/ledger/year-end") as typeof import("../src/lib/ledger/year-end");
  const repost = require("../src/lib/ledger/repost-fx") as typeof import("../src/lib/ledger/repost-fx");
  const { SYSTEM_ACCOUNTS } = require("../src/lib/ledger/chart") as typeof import("../src/lib/ledger/chart");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const tx = <T>(fn: (tx: Tx) => Promise<T>) => db.$transaction(fn);

  // ── Fixture ─────────────────────────────────────────────────────────────────────────────────
  section("Fixture");
  if (!(await db.role.findUnique({ where: { key: "ADMIN" } }))) {
    await db.role.create({ data: { key: "ADMIN", name: "Admin" } });
  }
  const sa = await db.user.create({
    data: { name: `${TAG} Owner`, email: `${TAG.toLowerCase()}-owner@example.test`, passwordHash: "!", role: "ADMIN", isSuperAdmin: true },
    select: { id: true },
  });
  const clerk = await db.user.create({
    data: { name: `${TAG} Clerk`, email: `${TAG.toLowerCase()}-clerk@example.test`, passwordHash: "!", role: "ADMIN" },
    select: { id: true },
  });
  const customer = await db.company.create({ data: { name: `${TAG} Customer Inc`, normalizedName: `${TAG.toLowerCase()} customer inc`, createdById: sa.id } });
  const vendor = await db.company.create({ data: { name: `${TAG} Vendor LLC`, normalizedName: `${TAG.toLowerCase()} vendor llc`, createdById: sa.id } });
  const mumbaiGst = await db.gstRegistration.create({ data: { gstin: "27AAACZ9999Z1Z5", stateCode: "27", code: "MH" } });
  const puneGst = await db.gstRegistration.create({ data: { gstin: "29AAACZ9999Z1Z1", stateCode: "29", code: "KA" } });
  const head = await db.branch.create({ data: { name: `${TAG} Head office`, code: "HO", isHeadOffice: true, gstRegistrationId: mumbaiGst.id } });
  const bengaluru = await db.branch.create({ data: { name: `${TAG} Bengaluru`, code: "BLR", gstRegistrationId: puneGst.id } });
  const sales = await db.department.create({ data: { name: `${TAG} Sales` } });
  ok("a super admin, a customer, a vendor, two branches under two GSTINs", !!sa && !!bengaluru && !!head);

  let seq = 0;
  const document = (data: {
    docType: "INVOICE" | "CREDIT_NOTE" | "BILL";
    issueDate: Date;
    currency: string;
    exchangeRate: number;
    taxable: number;
    cgst?: number;
    sgst?: number;
    igst?: number;
    status?: "ISSUED" | "CANCELLED";
    branchId?: string | null;
    gstRegistrationId?: string | null;
  }) => {
    seq += 1;
    const total = round2(data.taxable + (data.cgst ?? 0) + (data.sgst ?? 0) + (data.igst ?? 0));
    return db.tradeDocument.create({
      data: {
        docNumber: `${TAG}-${data.docType}-${seq}`,
        docType: data.docType,
        direction: data.docType === "BILL" ? "PURCHASE" : "SALES",
        status: data.status ?? "ISSUED",
        companyId: data.docType === "BILL" ? vendor.id : customer.id,
        createdById: sa.id,
        issueDate: data.issueDate,
        currency: data.currency,
        exchangeRate: data.exchangeRate,
        subtotal: data.taxable,
        taxableValue: data.taxable,
        cgstAmount: data.cgst ?? 0,
        sgstAmount: data.sgst ?? 0,
        igstAmount: data.igst ?? 0,
        total,
        branchId: data.branchId === undefined ? bengaluru.id : data.branchId,
        gstRegistrationId: data.gstRegistrationId === undefined ? puneGst.id : data.gstRegistrationId,
      },
      select: { id: true, docNumber: true, total: true },
    });
  };

  /** A party's balance on AR or AP, over every entry: debit − credit. */
  const partyBalance = async (key: string, companyId: string) => {
    const s = await db.journalLine.aggregate({
      where: { account: { systemKey: key }, companyId },
      _sum: { debit: true, credit: true },
    });
    return round2(Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0));
  };
  const entryLines = (id: string) =>
    db.journalLine.findMany({
      where: { entryId: id },
      orderBy: { sortOrder: "asc" },
      select: { debit: true, credit: true, branchId: true, gstRegistrationId: true, departmentId: true, companyId: true, accountId: true, account: { select: { systemKey: true } } },
    });

  // ── F1 ──────────────────────────────────────────────────────────────────────────────────────
  section("F1: a foreign document posts at its rate");

  const invoice = await document({ docType: "INVOICE", issueDate: ist("2025-10-10T11:00:00"), currency: "USD", exchangeRate: 83.47, taxable: 100.38, cgst: 9.03, sgst: 9.03 });
  const invEntry = await tx((t) => journal.postDocumentToLedger(t, invoice.id, sa.id));
  ok("a USD invoice issues — its entry balances", !!invEntry, invEntry?.entryNumber);
  const invLines = invEntry ? await entryLines(invEntry.id) : [];
  const invAr = invLines.filter((l) => l.account.systemKey === SYSTEM_ACCOUNTS.AR).reduce((t, l) => t + Number(l.debit), 0);
  ok("  AR is total × rate: $118.44 × 83.47 = ₹9,886.19", near(invAr, 9886.19), invAr);
  ok("  not the dollar figure it used to book", !near(invAr, 118.44));
  const invDr = round2(invLines.reduce((t, l) => t + Number(l.debit), 0));
  const invCr = round2(invLines.reduce((t, l) => t + Number(l.credit), 0));
  ok("  and debits equal credits, the conversion paisa in round off", invDr === invCr && invDr === 9886.19, `${invDr} / ${invCr}`);
  ok("  every line under the invoice's branch and GSTIN", invLines.every((l) => l.branchId === bengaluru.id && l.gstRegistrationId === puneGst.id));

  const bill = await document({ docType: "BILL", issueDate: ist("2025-10-12T15:00:00"), currency: "USD", exchangeRate: 83, taxable: 1000, igst: 180, branchId: null, gstRegistrationId: null });
  const billEntry = await tx((t) => journal.postDocumentToLedger(t, bill.id, sa.id));
  const billLines = billEntry ? await entryLines(billEntry.id) : [];
  const billAp = billLines.filter((l) => l.account.systemKey === SYSTEM_ACCOUNTS.AP).reduce((t, l) => t + Number(l.credit), 0);
  ok("a USD bill posts AP at total × rate: $1,180 × 83 = ₹97,940", near(billAp, 97940), billAp);
  ok("  a document with no branch goes to the head office", billLines.every((l) => l.branchId === head.id));

  // A rupee invoice from before the form refused a rate on one: it still carries 83.25.
  const stale = await document({ docType: "INVOICE", issueDate: ist("2025-10-14T11:00:00"), currency: "INR", exchangeRate: 83.25, taxable: 1000, igst: 180 });
  const staleEntry = await tx((t) => journal.postDocumentToLedger(t, stale.id, sa.id));
  const staleAr = staleEntry ? (await entryLines(staleEntry.id)).filter((l) => l.account.systemKey === SYSTEM_ACCOUNTS.AR).reduce((t, l) => t + Number(l.debit), 0) : 0;
  ok("a rupee invoice with a leftover rate posts as written", near(staleAr, 1180), staleAr);
  // Cancelled again, so the customer's receivable below is the foreign invoices' alone.
  await tx((t) => journal.reverseDocumentPosting(t, stale.id, sa.id));
  await db.tradeDocument.update({ where: { id: stale.id }, data: { status: "CANCELLED" } });

  const again = await tx((t) => journal.postDocumentToLedger(t, invoice.id, sa.id));
  const invCount = await db.journalEntry.count({ where: { documentId: invoice.id } });
  ok("issuing again is a no-op: the same entry, and still one", again?.id === invEntry?.id && invCount === 1, invCount);

  // ── Settlement ──────────────────────────────────────────────────────────────────────────────
  section("Settling at another rate nets AR and AP to zero");

  const receipt = await db.payment.create({
    data: {
      companyId: customer.id, amount: 118.44, currency: "USD", exchangeRate: 85, paidOn: ist("2025-11-05T12:00:00"),
      method: "BANK_TRANSFER", recordedByUserId: sa.id, branchId: bengaluru.id,
      allocations: { create: [{ documentId: invoice.id, amount: 118.44, allocatedByUserId: sa.id }] },
    },
  });
  await tx(async (t) => {
    await journal.postPaymentToLedger(t, receipt.id, sa.id);
    await journal.postExchangeDifferenceToLedger(t, { paymentId: receipt.id, documentId: invoice.id, allocatedAmount: 118.44, userId: sa.id });
  });
  const fxGain = await db.journalLine.aggregate({
    where: { entry: { paymentId: receipt.id, source: "FX" }, account: { systemKey: SYSTEM_ACCOUNTS.FX_GAIN_LOSS } },
    _sum: { credit: true, debit: true },
  });
  ok(
    "$118.44 received at 85: bank ₹10,067.40, exchange gain ₹181.21",
    near(Number(fxGain._sum.credit ?? 0), 181.21) && near(Number(fxGain._sum.debit ?? 0), 0),
    `gain ${Number(fxGain._sum.credit ?? 0)} = 118.44 × (85 − 83.47)`,
  );
  const arAfter = await partyBalance(SYSTEM_ACCOUNTS.AR, customer.id);
  ok("  and the customer's AR is exactly nil: 9,886.19 − 10,067.40 + 181.21", arAfter === 0, arAfter);

  // $1 booked at ₹82.915 (₹82.92) and received at ₹84.4444 (₹84.44): the difference taken as
  // amount × (rate − rate) was ₹1.53 and left a paisa on the receivable.
  const dollar = await document({ docType: "INVOICE", issueDate: ist("2025-10-20T11:00:00"), currency: "USD", exchangeRate: 82.915, taxable: 1 });
  await tx((t) => journal.postDocumentToLedger(t, dollar.id, sa.id));
  const dollarIn = await db.payment.create({
    data: {
      companyId: customer.id, amount: 1, currency: "USD", exchangeRate: 84.4444, paidOn: ist("2025-11-06T12:00:00"),
      method: "BANK_TRANSFER", recordedByUserId: sa.id,
      allocations: { create: [{ documentId: dollar.id, amount: 1, allocatedByUserId: sa.id }] },
    },
  });
  await tx(async (t) => {
    await journal.postPaymentToLedger(t, dollarIn.id, sa.id);
    await journal.postExchangeDifferenceToLedger(t, { paymentId: dollarIn.id, documentId: dollar.id, allocatedAmount: 1, userId: sa.id });
  });
  const arDollar = await partyBalance(SYSTEM_ACCOUNTS.AR, customer.id);
  ok("$1 at ₹82.915 settled at ₹84.4444 leaves no paisa on AR", arDollar === 0, arDollar);

  const paid = await db.payment.create({
    data: {
      companyId: vendor.id, direction: "PAID", amount: 1180, currency: "USD", exchangeRate: 82.5, paidOn: ist("2025-11-20T12:00:00"),
      method: "BANK_TRANSFER", recordedByUserId: sa.id,
      allocations: { create: [{ documentId: bill.id, amount: 1180, allocatedByUserId: sa.id }] },
    },
  });
  await tx(async (t) => {
    await journal.postPaymentToLedger(t, paid.id, sa.id);
    await journal.postExchangeDifferenceToLedger(t, { paymentId: paid.id, documentId: bill.id, allocatedAmount: 1180, userId: sa.id });
  });
  const apAfter = await partyBalance(SYSTEM_ACCOUNTS.AP, vendor.id);
  ok("$1,180 paid at 82.50: AP is nil — −97,940 + 97,350 + 590 gain", apAfter === 0, apAfter);

  // As the invoice screen now records a receipt: in the invoice's currency, at its rate.
  const invoice2 = await document({ docType: "INVOICE", issueDate: ist("2025-12-01T10:00:00"), currency: "EUR", exchangeRate: 90.25, taxable: 500, igst: 90 });
  await tx((t) => journal.postDocumentToLedger(t, invoice2.id, sa.id));
  const onScreen = await db.payment.create({
    data: {
      companyId: customer.id, amount: 590, currency: "EUR", exchangeRate: 90.25, paidOn: ist("2025-12-15T12:00:00"),
      method: "BANK_TRANSFER", recordedByUserId: sa.id,
      allocations: { create: [{ documentId: invoice2.id, amount: 590, allocatedByUserId: sa.id }] },
    },
  });
  const fx2 = await tx(async (t) => {
    await journal.postPaymentToLedger(t, onScreen.id, sa.id);
    return journal.postExchangeDifferenceToLedger(t, { paymentId: onScreen.id, documentId: invoice2.id, allocatedAmount: 590, userId: sa.id });
  });
  ok("A receipt in the invoice's currency at its rate clears it exactly, with no FX entry", (await partyBalance(SYSTEM_ACCOUNTS.AR, customer.id)) === 0 && fx2 === null);

  // ── F3 and F4 ───────────────────────────────────────────────────────────────────────────────
  section("F3: closing 2024-25 takes in March's payroll and depreciation");

  const acc = await tx(async (t) =>
    journal.resolveAccounts(t, [
      SYSTEM_ACCOUNTS.SALARIES, SYSTEM_ACCOUNTS.SALARY_PAYABLE, SYSTEM_ACCOUNTS.DEPRECIATION,
      SYSTEM_ACCOUNTS.ACCUMULATED_DEPRECIATION, SYSTEM_ACCOUNTS.SALES, SYSTEM_ACCOUNTS.BANK, SYSTEM_ACCOUNTS.EXP_TRAVEL,
    ]),
  );
  const a = (key: string) => acc.get(key as never)!;
  const post = (date: Date, narration: string, dr: string, cr: string, amount: number, source: "PAYROLL" | "DEPRECIATION" | "MANUAL" = "MANUAL") =>
    tx((t) =>
      journal.writeEntry(t, {
        date, narration: `${TAG} ${narration}`, source, userId: sa.id,
        lines: [
          { accountId: dr, debit: amount, credit: 0 },
          { accountId: cr, debit: 0, credit: amount },
        ],
      }),
    );
  await post(ist("2024-09-15T12:00:00"), "sales", a(SYSTEM_ACCOUNTS.BANK), a(SYSTEM_ACCOUNTS.SALES), 200000);
  await post(new Date("2025-03-31T12:00:00.000Z"), "March payroll", a(SYSTEM_ACCOUNTS.SALARIES), a(SYSTEM_ACCOUNTS.SALARY_PAYABLE), 50000, "PAYROLL");
  await post(new Date("2025-03-31T12:00:00.000Z"), "March depreciation", a(SYSTEM_ACCOUNTS.DEPRECIATION), a(SYSTEM_ACCOUNTS.ACCUMULATED_DEPRECIATION), 4000, "DEPRECIATION");
  await post(ist("2025-04-01T00:00:00"), "1 April travel", a(SYSTEM_ACCOUNTS.EXP_TRAVEL), a(SYSTEM_ACCOUNTS.BANK), 7777);

  const fy = { from: ist("2024-04-01T00:00:00"), to: ist("2025-04-01T00:00:00") };
  const yearBalance = async (id: string) => {
    const s = await db.journalLine.aggregate({ where: { accountId: id, entry: { date: { gte: fy.from, lt: fy.to } } }, _sum: { debit: true, credit: true } });
    return round2(Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0));
  };
  ok("before the close, 2024-25 carries the payroll and depreciation", (await yearBalance(a(SYSTEM_ACCOUNTS.SALARIES))) === 50000 && (await yearBalance(a(SYSTEM_ACCOUNTS.DEPRECIATION))) === 4000);

  const closed = await tx((t) => yearEnd.closeFinancialYearInBooks(t, { label: "2024-25", userId: sa.id }));
  ok("2024-25 closes", !!closed.entryNumber, `${closed.entryNumber}, net ₹${closed.netProfit}`);
  ok("  net profit is sales less payroll less depreciation: 2,00,000 − 50,000 − 4,000", closed.netProfit === 146000, closed.netProfit);
  ok("  the payroll dated 31 March 12:00 UTC is zeroed", (await yearBalance(a(SYSTEM_ACCOUNTS.SALARIES))) === 0, "the old lte-midnight bound left ₹50,000 of it standing");
  ok("  and so is the depreciation", (await yearBalance(a(SYSTEM_ACCOUNTS.DEPRECIATION))) === 0);
  const pl = await db.journalLine.groupBy({
    by: ["accountId"],
    where: { account: { type: { in: ["INCOME", "EXPENSE"] } }, entry: { date: { gte: fy.from, lt: fy.to } } },
    _sum: { debit: true, credit: true },
  });
  ok("  every income and expense account is nil for the year", pl.every((r) => round2(Number(r._sum.debit ?? 0) - Number(r._sum.credit ?? 0)) === 0), `${pl.length} accounts`);
  const travelApril = await db.journalLine.aggregate({ where: { accountId: a(SYSTEM_ACCOUNTS.EXP_TRAVEL) }, _sum: { debit: true, credit: true } });
  ok("  while 1 April 00:00 IST stays in 2025-26, untouched", round2(Number(travelApril._sum.debit ?? 0) - Number(travelApril._sum.credit ?? 0)) === 7777);
  const closingEntry = await db.journalEntry.findFirstOrThrow({ where: { entryNumber: closed.entryNumber! }, select: { id: true, date: true } });
  ok("  the closing entry is dated 31 March, 12:00 UTC", closingEntry.date.toISOString() === "2025-03-31T12:00:00.000Z", closingEntry.date.toISOString());
  const closeRow = await db.fiscalYearClose.findUniqueOrThrow({ where: { label: "2024-25" } });
  ok("  the close record holds 1 April and 31 March as days", closeRow.fromDate.toISOString() === "2024-04-01T00:00:00.000Z" && closeRow.toDate.toISOString() === "2025-03-31T00:00:00.000Z" && closeRow.closingEntryId === closingEntry.id);
  const lockAfterClose = await db.ledgerLock.findUnique({ where: { id: "global" } });
  ok("  and the books are locked to 31 March", lockAfterClose?.lockedUntil?.toISOString() === "2025-03-31T00:00:00.000Z", lockAfterClose?.lockedUntil?.toISOString());

  let refusedTwice = "";
  try {
    await tx((t) => yearEnd.closeFinancialYearInBooks(t, { label: "2024-25", userId: sa.id }));
  } catch (e) {
    refusedTwice = e instanceof Error ? e.message : String(e);
  }
  ok("  closing it again is refused", /already closed/.test(refusedTwice), refusedTwice);
  let notOver = "";
  try {
    await tx((t) => yearEnd.closeFinancialYearInBooks(t, { label: "2026-27", userId: sa.id, now: ist("2027-03-31T23:30:00") }));
  } catch (e) {
    notOver = e instanceof Error ? e.message : String(e);
  }
  ok("  and a year is not over at 23:30 IST on its 31 March", /isn't over yet/.test(notOver), notOver);

  section("F2: the lock refuses 12:00 UTC on the locked day");

  let refused = "";
  try {
    await post(new Date("2025-03-31T12:00:00.000Z"), "late payroll", a(SYSTEM_ACCOUNTS.SALARIES), a(SYSTEM_ACCOUNTS.SALARY_PAYABLE), 1000, "PAYROLL");
  } catch (e) {
    refused = e instanceof Error ? e.message : String(e);
  }
  ok("an entry at 31 March 12:00 UTC is refused by a lock to 31 March", /closed to 2025-03-31/.test(refused), refused || "it was accepted");
  let lateNight = "";
  try {
    await post(ist("2025-03-31T23:59:00"), "late night", a(SYSTEM_ACCOUNTS.EXP_TRAVEL), a(SYSTEM_ACCOUNTS.BANK), 10);
  } catch (e) {
    lateNight = e instanceof Error ? e.message : String(e);
  }
  ok("  and so is 23:59 IST that day", /closed to/.test(lateNight));
  const nextDay = await post(ist("2025-04-01T00:00:00"), "first thing on 1 April", a(SYSTEM_ACCOUNTS.EXP_TRAVEL), a(SYSTEM_ACCOUNTS.BANK), 10).catch(() => null);
  ok("  while India's midnight starting 1 April is open", !!nextDay, nextDay?.entryNumber);

  section("F4: reopening reverses through the write door");

  const reopened = await tx((t) => yearEnd.reopenFinancialYearInBooks(t, { label: "2024-25", userId: clerk.id }));
  const reversal = reopened.reversal
    ? await db.journalEntry.findUniqueOrThrow({ where: { id: reopened.reversal.id }, select: { entryNumber: true, date: true, reversesId: true, source: true, createdById: true } })
    : null;
  ok("the closing entry is reversed", reversal?.reversesId === closingEntry.id, reversal?.entryNumber);
  ok("  numbered from the counter, not <original>-R", !!reversal && /^JV\/2024-25\/\d{4,}$/.test(reversal.entryNumber), reversal?.entryNumber);
  ok("  dated as the closing entry was, inside the year", reversal?.date.getTime() === closingEntry.date.getTime());
  ok("  by whoever reopened it", reversal?.createdById === clerk.id);
  ok("  and the year's P&L reads as before the close", (await yearBalance(a(SYSTEM_ACCOUNTS.SALARIES))) === 50000 && (await yearBalance(a(SYSTEM_ACCOUNTS.DEPRECIATION))) === 4000);
  const lockAfterReopen = await db.ledgerLock.findUnique({ where: { id: "global" } });
  ok("  the lock goes back to the day before the year", lockAfterReopen?.lockedUntil?.toISOString() === "2024-03-31T00:00:00.000Z", lockAfterReopen?.lockedUntil?.toISOString());
  ok("  and the close record is gone", (await db.fiscalYearClose.count({ where: { label: "2024-25" } })) === 0);

  // The year-end close writes untagged lines, so tags are proved on a closing entry that has them:
  // a year closed by an older build, whose closing entry a hand had tagged by branch and team.
  // The lock is lifted first, as the close of that year would have lifted it to write the entry.
  await db.ledgerLock.update({ where: { id: "global" }, data: { lockedUntil: null } });
  const tagged = await tx((t) =>
    journal.writeEntry(t, {
      date: new Date("2024-03-31T12:00:00.000Z"),
      narration: `${TAG} tagged closing entry`,
      source: "CLOSING",
      userId: sa.id,
      lines: [
        { accountId: a(SYSTEM_ACCOUNTS.SALES), debit: 1234, credit: 0, branchId: bengaluru.id, gstRegistrationId: puneGst.id, departmentId: sales.id },
        { accountId: a(SYSTEM_ACCOUNTS.SALES), debit: 0, credit: 1234, branchId: head.id, gstRegistrationId: mumbaiGst.id },
      ],
    }),
  );
  await db.fiscalYearClose.create({
    data: { label: "2023-24", fromDate: new Date("2023-04-01T00:00:00.000Z"), toDate: new Date("2024-03-31T00:00:00.000Z"), netProfit: 0, closingEntryId: tagged.id, closedById: sa.id },
  });
  const r2 = await tx((t) => yearEnd.reopenFinancialYearInBooks(t, { label: "2023-24", userId: sa.id }));
  const [origLines, revLines] = await Promise.all([entryLines(tagged.id), r2.reversal ? entryLines(r2.reversal.id) : Promise.resolve([])]);
  ok(
    "a reopened year's reversal keeps each line's branch, GSTIN and cost centre",
    revLines.length === 2 &&
      revLines.every((l, i) => l.branchId === origLines[i].branchId && l.gstRegistrationId === origLines[i].gstRegistrationId && l.departmentId === origLines[i].departmentId),
    revLines.map((l) => `${l.branchId === bengaluru.id ? "BLR" : "HO"}/${l.departmentId ? "Sales" : "-"}`).join(", "),
  );
  ok("  with debit and credit swapped", revLines.every((l, i) => Number(l.debit) === Number(origLines[i].credit) && Number(l.credit) === Number(origLines[i].debit)));
  ok("  and a counter number of its own year", !!r2.reversal && /^JV\/2023-24\/\d{4,}$/.test(r2.reversal.entryNumber), r2.reversal?.entryNumber);

  // ── The repair ──────────────────────────────────────────────────────────────────────────────
  section("The repair: rate-1 postings found, re-posted, and not found again");

  // As the old build posted: the document's rate never reached the posting, so it was as if it were 1.
  const atRateOne = async (doc: Parameters<typeof document>[0]) => {
    const rate = doc.exchangeRate;
    const d = await document({ ...doc, exchangeRate: 1 });
    await tx((t) => journal.postDocumentToLedger(t, d.id, clerk.id));
    await db.tradeDocument.update({ where: { id: d.id }, data: { exchangeRate: rate } });
    return d;
  };
  const oldInvoice = await atRateOne({ docType: "INVOICE", issueDate: ist("2025-06-15T10:00:00"), currency: "USD", exchangeRate: 84.1, taxable: 2000, cgst: 180, sgst: 180 });
  const oldCredit = await atRateOne({ docType: "CREDIT_NOTE", issueDate: ist("2025-11-03T10:00:00"), currency: "USD", exchangeRate: 84.1, taxable: 200, cgst: 18, sgst: 18 });
  const oldBill = await atRateOne({ docType: "BILL", issueDate: ist("2025-12-08T10:00:00"), currency: "GBP", exchangeRate: 105.5, taxable: 300, igst: 54, branchId: head.id, gstRegistrationId: mumbaiGst.id });
  const cancelled = await atRateOne({ docType: "INVOICE", issueDate: ist("2025-12-09T10:00:00"), currency: "USD", exchangeRate: 84.1, taxable: 10, igst: 1.8 });
  await tx((t) => journal.reverseDocumentPosting(t, cancelled.id, clerk.id));
  await db.tradeDocument.update({ where: { id: cancelled.id }, data: { status: "CANCELLED" } });
  const rupee = await atRateOne({ docType: "INVOICE", issueDate: ist("2025-12-10T10:00:00"), currency: "INR", exchangeRate: 1, taxable: 1000, igst: 180 });
  // A receipt taken the old way against the June invoice — in rupees, at rate 1.
  await db.payment.create({
    data: {
      companyId: customer.id, amount: 1000, paidOn: ist("2025-07-01T12:00:00"), method: "BANK_TRANSFER", recordedByUserId: sa.id,
      allocations: { create: [{ documentId: oldInvoice.id, amount: 1000, allocatedByUserId: sa.id }] },
    },
  });
  // June is closed by now.
  await db.ledgerLock.upsert({
    where: { id: "global" },
    create: { id: "global", lockedUntil: new Date("2025-09-30T00:00:00.000Z"), updatedById: sa.id },
    update: { lockedUntil: new Date("2025-09-30T00:00:00.000Z"), updatedById: sa.id },
  });

  const found = await repost.findFxMisposts(db);
  const foundIds = new Set(found.map((f) => f.documentId));
  ok(
    "the dry run finds the three posted at rate 1",
    [oldInvoice.id, oldCredit.id, oldBill.id].every((id) => foundIds.has(id)) && found.length === 3,
    found.map((f) => `${f.docNumber}: booked ${f.booked}, should be ${f.expected}`).join("; "),
  );
  ok("  and not the ones at their rate, the cancelled one or the rupee ones", ![invoice.id, bill.id, invoice2.id, cancelled.id, rupee.id, stale.id].some((id) => foundIds.has(id)));
  const june = found.find((f) => f.documentId === oldInvoice.id);
  ok("  the June invoice should carry $2,360 × 84.10 = ₹1,98,476", june?.expected === 198476 && june.booked === 2360, `${june?.booked} → ${june?.expected}`);
  ok("  and its rupee receipt is flagged, not touched", june?.ratelessPayments.count === 1 && june.ratelessPayments.amount === 1000);

  const entriesBefore = await db.journalEntry.count();
  const lines: string[] = [];
  const dry = await repost.repairFxPostings(db, { apply: false, say: (l) => lines.push(l) });
  ok("  a dry run writes nothing", (await db.journalEntry.count()) === entriesBefore && dry.repaired.length === 0 && dry.found.length === 3, `${entriesBefore} entries`);
  ok("  and says where each would be dated", lines.some((l) => l.includes(oldInvoice.docNumber) && l.includes("re-posted 2025-10-01, after the lock")), lines.find((l) => l.includes(oldInvoice.docNumber)));

  const originals = new Map<string, { id: string; date: Date; lines: Awaited<ReturnType<typeof entryLines>> }>();
  for (const f of found) originals.set(f.documentId, { id: f.entryId, date: f.entryDate, lines: await entryLines(f.entryId) });

  // The real script, on this workspace only, the way an operator runs it.
  let output = "";
  let exitOk = true;
  try {
    output = execSync(`npx tsx scripts/ledger-repost-fx.ts --workspace ${SLUG} --apply`, {
      stdio: "pipe",
      encoding: "utf8",
      env: { ...process.env, [`TENANT_DB_${SLUG.toUpperCase()}`]: scratchUrl, DATABASE_URL: scratchUrl, CONTROL_DATABASE_URL: "" },
      timeout: 5 * 60 * 1000,
    });
  } catch (e) {
    exitOk = false;
    output = String((e as { stdout?: string }).stdout ?? e);
  }
  ok("`npm run ledger:repost-fx -- --workspace … --apply` repairs three", exitOk && /3 document\(s\) repaired across 1 workspace/.test(output), output.split("\n").filter((l) => /✓|✗|repaired/.test(l)).join(" | "));

  for (const doc of [oldInvoice, oldCredit, oldBill]) {
    const original = originals.get(doc.id)!;
    const entries = await db.journalEntry.findMany({
      where: { OR: [{ documentId: doc.id }, { reversesId: original.id }] },
      select: { id: true, entryNumber: true, date: true, source: true, reversesId: true, createdById: true, reversedBy: { select: { id: true } } },
      orderBy: { createdAt: "asc" },
    });
    const rev = entries.find((e) => e.reversesId === original.id);
    const live = entries.filter((e) => !e.reversesId && !e.reversedBy && e.source !== "MANUAL");
    const [revLines2, liveLines] = await Promise.all([rev ? entryLines(rev.id) : [], live[0] ? entryLines(live[0].id) : []]);
    const key = doc.docNumber.includes("BILL") ? SYSTEM_ACCOUNTS.AP : SYSTEM_ACCOUNTS.AR;
    const rate = Number((await db.tradeDocument.findUniqueOrThrow({ where: { id: doc.id }, select: { exchangeRate: true } })).exchangeRate);
    const party = round2(liveLines.filter((l) => l.account.systemKey === key).reduce((t, l) => t + Number(l.debit) + Number(l.credit), 0));
    const expectedDate = original.date < new Date("2025-09-30T18:30:00.000Z") ? new Date("2025-10-01T12:00:00.000Z") : original.date;
    ok(
      `${doc.docNumber}: reversed and posted again, one live entry`,
      !!rev && live.length === 1 && /^JV\/\d{4}-\d{2}\/\d{4,}$/.test(rev.entryNumber) && /^JV\/\d{4}-\d{2}\/\d{4,}$/.test(live[0].entryNumber),
      `${rev?.entryNumber} + ${live[0]?.entryNumber}`,
    );
    ok(`  its ${key} line is total × rate`, near(party, round2(Number(doc.total) * rate)), `${party}`);
    ok(
      `  dated ${expectedDate.toISOString().slice(0, 10)}${expectedDate === original.date ? ", the original date, which is open" : ", the first open day after the lock"}`,
      rev?.date.getTime() === expectedDate.getTime() && live[0]?.date.getTime() === expectedDate.getTime(),
    );
    ok(
      "  the reversal keeps every line's tags, the re-post the original's",
      revLines2.length === original.lines.length &&
        revLines2.every((l, i) => l.branchId === original.lines[i].branchId && l.gstRegistrationId === original.lines[i].gstRegistrationId) &&
        liveLines.every((l) => l.branchId === original.lines[0].branchId && l.gstRegistrationId === original.lines[0].gstRegistrationId),
      `${original.lines[0].branchId === head.id ? "head office" : "Bengaluru"}`,
    );
    ok("  both by the super admin", rev?.createdById === sa.id && live[0]?.createdById === sa.id);
  }

  const second = await repost.repairFxPostings(db, { apply: true });
  ok("a second run finds nothing and writes nothing", second.found.length === 0 && second.repaired.length === 0);
  let dryAgain = "";
  try {
    dryAgain = execSync(`npx tsx scripts/ledger-repost-fx.ts --workspace ${SLUG}`, {
      stdio: "pipe", encoding: "utf8",
      env: { ...process.env, [`TENANT_DB_${SLUG.toUpperCase()}`]: scratchUrl, DATABASE_URL: scratchUrl, CONTROL_DATABASE_URL: "" },
      timeout: 5 * 60 * 1000,
    });
  } catch (e) {
    dryAgain = String((e as { stdout?: string }).stdout ?? e);
  }
  ok("  and neither does the script's dry run", /0 document\(s\) to repair/.test(dryAgain), dryAgain.trim().split("\n").pop());

  const reissue = await tx((t) => journal.postDocumentToLedger(t, oldInvoice.id, sa.id));
  const current = await tx((t) => journal.currentDocumentEntry(t, oldInvoice.id));
  ok("issuing the repaired invoice again finds the re-post, and writes nothing", !!reissue && reissue.id === current?.id && (await db.journalEntry.count({ where: { documentId: oldInvoice.id } })) === 3);
  await db.ledgerLock.update({ where: { id: "global" }, data: { lockedUntil: null } });
  const cancel = await tx((t) => journal.reverseDocumentPosting(t, oldCredit.id, sa.id));
  const creditEntries = await db.journalEntry.findMany({ where: { documentId: oldCredit.id, reversesId: null, source: "CREDIT_NOTE" }, select: { id: true, reversedBy: { select: { id: true } } } });
  ok("cancelling a repaired credit note reverses the re-post, leaving nothing live", !!cancel && creditEntries.length === 2 && creditEntries.every((e) => !!e.reversedBy));
  const cnNet = await db.journalLine.aggregate({
    where: { account: { systemKey: SYSTEM_ACCOUNTS.AR }, entry: { OR: [{ documentId: oldCredit.id }, { reverses: { documentId: oldCredit.id } }] } },
    _sum: { debit: true, credit: true },
  });
  ok("  and its receivable nets to nil across all four entries", round2(Number(cnNet._sum.debit ?? 0) - Number(cnNet._sum.credit ?? 0)) === 0);
  const again2 = await tx((t) => journal.reverseDocumentPosting(t, oldCredit.id, sa.id));
  ok("  cancelling twice does nothing more", again2 === null);

  // Balanced, every one of them.
  const unbalanced = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM (
      SELECT l."entryId" FROM journal_lines l GROUP BY l."entryId" HAVING SUM(l.debit) <> SUM(l.credit)
    ) x`;
  ok("every entry in the scratch books balances", Number(unbalanced[0]?.n ?? 1) === 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
