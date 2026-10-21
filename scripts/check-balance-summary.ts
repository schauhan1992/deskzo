/**
 * The Customer and Vendor Balance Summary, and rupees on the ageing screens (owner, 21 Oct 2026 —
 * src/lib/receivables/balance-summary.ts, src/actions/receivable.ts, payable.ts, src/lib/finance/dashboard.ts):
 *
 *   · Each party's open invoices (bills) in rupees at each document's own rate, unused credits — payments
 *     not set against anything, credit notes not used, overpayments — journals, and the balance netted;
 *     the balance in each other currency as written.
 *   · As of a day: a payment dated after it, and a credit note applied after it, don't count yet.
 *   · The balance agrees with Accounts Receivable (Payable) in the ledger, party by party, for real
 *     postings — a dollar invoice paid at another rate included, through its exchange-difference entry;
 *     a document whose posting disagrees is marked. An opening balance with no documents is listed.
 *   · Somebody without the books isn't shown the ledger, and sees only their own customers.
 *   · The ageing, both sides, and the Accounting overview's totals count a dollar balance in rupees.
 *
 * Everything is named ZZPROBE_BS / ZZBS- and removed in a finally, its ledger entries with it.
 *
 *   npm run check:balance-summary
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actorId = "";
const roles = new Map<string, string>();
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => (actorId ? { id: actorId, role: roles.get(actorId) ?? "PROFILE", name: "Zzprobe Bs", email: `${actorId}${MAIL}` } : null);
    return {
      requireUser: async () => {
        const u = await user();
        if (!u) throw new Error("Unauthorized");
        return u;
      },
      currentUser: user,
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_BS";
const MAIL = "@zzprobe-bs.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const day = (d: string) => new Date(`${d}T00:00:00Z`);

async function cleanup() {
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  const docs = (await db.tradeDocument.findMany({ where: { docNumber: { startsWith: "ZZBS-" } }, select: { id: true } })).map((d) => d.id);
  const payments = companies.length ? (await db.payment.findMany({ where: { companyId: { in: companies } }, select: { id: true } })).map((p) => p.id) : [];
  const entries = { OR: [{ documentId: { in: docs } }, { paymentId: { in: payments } }, { companyId: { in: companies } }, { lines: { some: { companyId: { in: companies } } } }] };
  if (companies.length || docs.length) {
    await db.journalEntry.deleteMany({ where: { reversesId: { not: null }, ...entries } });
    await db.journalEntry.deleteMany({ where: entries });
  }
  await db.creditNoteApplication.deleteMany({ where: { invoiceId: { in: docs } } });
  await db.paymentAllocation.deleteMany({ where: { paymentId: { in: payments } } });
  await db.payment.deleteMany({ where: { id: { in: payments } } });
  await db.tradeDocument.deleteMany({ where: { docNumber: { startsWith: "ZZBS-" } } });
  if (companies.length) await db.company.deleteMany({ where: { id: { in: companies } } });
  const users = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  if (users.length) {
    await db.auditLog.deleteMany({ where: { userId: { in: users } } });
    await db.userPermission.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
  }
}

async function main() {
  // Required here, after the session stub: a top-of-file import is hoisted above it and loads the real one.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const lib = require("../src/lib/receivables/balance-summary") as typeof import("../src/lib/receivables/balance-summary");
  const receivable = require("../src/actions/receivable") as typeof import("../src/actions/receivable");
  const payable = require("../src/actions/payable") as typeof import("../src/actions/payable");
  const journal = require("../src/lib/ledger/journal") as typeof import("../src/lib/ledger/journal");
  const dashboard = require("../src/lib/finance/dashboard") as typeof import("../src/lib/finance/dashboard");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("The rows, by hand");

  const base = { companySeq: 1, posted: 0, hasEntry: true, entryNumbers: [], allocated: 0, credited: 0, applied: 0 };
  const doc = (over: Record<string, unknown>) => ({ ...base, id: "d", docNumber: "N", docType: "INVOICE", companyId: "a", companyName: "Acme", currency: "INR", rate: 1, total: 0, ...over }) as Parameters<typeof lib.summariseBalances>[0]["documents"][number];
  const pay = (over: Record<string, unknown>) => ({ id: "p", label: "Payment #1", companyId: "a", companySeq: 1, companyName: "Acme", currency: "INR", rate: 1, amount: 0, applied: 0, ...over }) as Parameters<typeof lib.summariseBalances>[0]["payments"][number];
  const { rows, totals } = lib.summariseBalances({
    documents: [
      doc({ id: "i1", total: 11800, allocated: 5000, credited: 1180 }),
      doc({ id: "i2", currency: "USD", rate: 83.47, total: 118.44, allocated: 50 }),
      doc({ id: "c1", docType: "CREDIT_NOTE", total: 1180, applied: 1180 }),
      doc({ id: "c2", docType: "CREDIT_NOTE", total: 500 }),
      doc({ id: "i3", total: 100, allocated: 150 }),
      doc({ id: "z1", companyId: "z", companyName: "Zeta", total: 900 }),
      doc({ id: "b1", companyId: "b", companyName: "beta", total: 1000, allocated: 1000 }),
    ],
    payments: [pay({ id: "p1", amount: 2000 }), pay({ id: "p2", currency: "USD", rate: 85, amount: 10 })],
    journals: [{ companyId: "o", companySeq: 3, name: "Opening Co", amount: 5000 }],
    ledger: new Map([
      ["a", { companySeq: 1, name: "Acme", amount: 0 }],
      ["g", { companySeq: 9, name: "Ghost", amount: 750 }],
    ]),
  });
  const acme = rows.find((r) => r.id === "a")!;
  // 11800 − 5000 − 1180 = 5620; $118.44 − $50 at 83.47 = 9886.19 − 4173.50 = 5712.69.
  ok("open: each invoice's balance at its own rate", acme.open === 11332.69 && acme.documents === 2, JSON.stringify(acme));
  // ₹500 credit note + ₹50 overpaid + ₹2,000 payment + $10 at 85.
  ok("unused: a credit note not used, an invoice paid over, payments not applied", acme.unused === 3400, acme.unused);
  ok("  the balance nets them; a used credit note and a paid invoice are nothing", acme.balance === 7932.69 && !rows.some((r) => r.id === "b"), acme.balance);
  ok("the balance in dollars: $68.44 left on the invoice less $10 on account", JSON.stringify(acme.foreign) === JSON.stringify([{ currency: "USD", amount: 58.44 }]), JSON.stringify(acme.foreign));
  ok("an opening balance with no documents is a row of its own", rows.find((r) => r.id === "o")?.balance === 5000 && rows.find((r) => r.id === "o")?.journals === 5000);
  ok("a party only the ledger has is listed, and marked as differing", rows.some((r) => r.id === "g" && r.balance === 0 && r.ledger === 750 && lib.differsFromLedger(r)) && lib.differsFromLedger(acme));
  ok("alphabetical, whatever the case", rows.map((r) => r.name).join() === "Acme,Ghost,Opening Co,Zeta", rows.map((r) => r.name).join());
  ok("the totals add the rows", totals.balance === 13832.69 && totals.open === 12232.69 && totals.unused === 3400 && totals.journals === 5000, JSON.stringify(totals));
  const close = lib.summariseBalances({ documents: [doc({ total: 1000 })], payments: [], journals: [], ledger: new Map([["a", { companySeq: 1, name: "Acme", amount: 999.2 }]]) }).rows[0]!;
  ok("within a rupee of the ledger is agreeing, as the close allows", !lib.differsFromLedger(close));

  await cleanup();
  const preAr = await dashboard.receivablesOutstanding();
  const preAp = await dashboard.payablesOutstanding();
  try {
    const admin = await db.user.create({ data: { name: `${TAG} admin`, email: `admin${MAIL}`, role: "ADMIN", passwordHash: "x".repeat(60) } });
    roles.set(admin.id, "ADMIN");
    // A salesperson: payments.view by their role, their own accounts only, and not the books.
    const viewer = await db.user.create({ data: { name: `${TAG} viewer`, email: `viewer${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    roles.set(viewer.id, "SALES");
    await db.userPermission.createMany({
      data: [
        { userId: viewer.id, permission: "payments.view", allowed: true, reason: TAG },
        { userId: viewer.id, permission: "ledger.viewReports", allowed: false, reason: TAG },
      ],
    });
    // Inserted naming their columns, so the suite runs whatever columns other work has added to companies
    // and not migrated yet (a create returns the whole row).
    const company = async (name: string, kind: "CLIENT" | "VENDOR", owner: string) => {
      const id = `zzbs_${name.toLowerCase()}_${Date.now()}`;
      await db.$executeRaw`INSERT INTO "companies" ("id", "name", "normalizedName", "relationshipType", "createdById", "ownerUserId", "updatedAt") VALUES (${id}, ${`${TAG} ${name}`}, ${`${TAG} ${name}`.toLowerCase()}, ${kind}::"CompanyRelationshipType", ${admin.id}, ${owner}, now())`;
      return id;
    };
    const rupee = await company("Rupee", "CLIENT", viewer.id);
    const dollar = await company("Dollar", "CLIENT", admin.id);
    const opening = await company("Opening", "CLIENT", admin.id);
    const askew = await company("Askew", "CLIENT", admin.id);
    const vendor = await company("Vendor", "VENDOR", admin.id);

    let n = 0;
    const tradeDoc = (docType: string, companyId: string, total: number, issued: string, extra: Record<string, unknown> = {}) =>
      db.tradeDocument.create({
        data: { docType, direction: docType === "BILL" ? "PURCHASE" : "SALES", status: "ISSUED", companyId, docNumber: `ZZBS-${++n}`, taxableValue: total, total, createdById: admin.id, issueDate: day(issued), ...extra } as never,
        select: { id: true },
      });
    const payment = (companyId: string, amount: number, paid: string, extra: Record<string, unknown> = {}) =>
      db.payment.create({ data: { companyId, amount, paidOn: day(paid), method: "BANK_TRANSFER", recordedByUserId: admin.id, ...extra } as never, select: { id: true } });
    const allocate = (paymentId: string, documentId: string, amount: number) => db.paymentAllocation.create({ data: { paymentId, documentId, amount, allocatedByUserId: admin.id } });

    const invR = await tradeDoc("INVOICE", rupee, 11800, "2026-10-05");
    const cnR = await tradeDoc("CREDIT_NOTE", rupee, 1180, "2026-10-10");
    const pr1 = await payment(rupee, 5000, "2026-10-08");
    const pr2 = await payment(rupee, 2000, "2026-10-12");
    const pr3 = await payment(rupee, 3000, "2026-10-20");
    await allocate(pr1.id, invR.id, 5000);
    await allocate(pr3.id, invR.id, 3000);
    await db.creditNoteApplication.create({ data: { creditNoteId: cnR.id, invoiceId: invR.id, amount: 1180, appliedByUserId: admin.id, createdAt: day("2026-10-10") } });

    const invD = await tradeDoc("INVOICE", dollar, 100, "2026-10-06", { currency: "USD", exchangeRate: 83 });
    const pd1 = await payment(dollar, 40, "2026-10-09", { currency: "USD", exchangeRate: 85 });
    const pd2 = await payment(dollar, 10, "2026-10-11", { currency: "USD", exchangeRate: 84 });
    await allocate(pd1.id, invD.id, 40);

    const invA = await tradeDoc("INVOICE", askew, 1000, "2026-10-07");
    const bill = await tradeDoc("BILL", vendor, 5000, "2026-10-07");
    const billUsd = await tradeDoc("BILL", vendor, 50, "2026-10-08", { currency: "USD", exchangeRate: 82 });
    const pv1 = await payment(vendor, 2000, "2026-10-09", { direction: "PAID" });
    await allocate(pv1.id, bill.id, 2000);

    // The real postings, as issuing and recording write them — and the exchange difference on the dollars.
    const [ar, obe] = await Promise.all([
      db.ledgerAccount.findUniqueOrThrow({ where: { systemKey: "AR" }, select: { id: true } }),
      db.ledgerAccount.findUniqueOrThrow({ where: { systemKey: "OPENING_BALANCE_EQUITY" }, select: { id: true } }),
    ]);
    await db.$transaction(async (tx) => {
      for (const d of [invR, cnR, invD, invA, bill, billUsd]) await journal.postDocumentToLedger(tx, d.id, admin.id);
      for (const p of [pr1, pr2, pr3, pd1, pd2, pv1]) await journal.postPaymentToLedger(tx, p.id, admin.id);
      await journal.postExchangeDifferenceToLedger(tx, { paymentId: pd1.id, documentId: invD.id, allocatedAmount: 40, userId: admin.id });
      await journal.writeEntry(tx, {
        date: day("2026-10-01"),
        narration: `${TAG} opening balance`,
        source: "OPENING",
        userId: admin.id,
        lines: [
          { accountId: ar.id, debit: 5000, credit: 0, companyId: opening },
          { accountId: obe.id, debit: 0, credit: 5000 },
        ],
      });
    }, { timeout: 60_000 });
    // Changed after it posted, as nothing in the app does: the ledger holds 1,000, the invoice says 1,200.
    await db.tradeDocument.update({ where: { id: invA.id }, data: { total: 1200 } });

    section("Customers, as of a day");

    actorId = admin.id;
    const mid = (await receivable.customerBalanceSummary({ asOf: "2026-10-15", search: TAG }))!;
    const row = (summary: typeof mid, id: string) => summary.rows.find((r) => r.id === id);
    const r15 = row(mid, rupee)!;
    // 11,800 − 5,000 paid − 1,180 credited; ₹2,000 on account; the 20 Oct payment not yet.
    ok("rupees on 15 Oct: 5,620 open, 2,000 unused, 3,620 owed", r15.open === 5620 && r15.unused === 2000 && r15.balance === 3620, JSON.stringify(r15));
    const d15 = row(mid, dollar)!;
    // $60 left at 83 = 4,980; $10 on account at 84 = 840.
    ok("dollars on 15 Oct: ₹4,980 open, ₹840 unused, ₹4,140 owed, $50 in dollars", d15.open === 4980 && d15.unused === 840 && d15.balance === 4140 && JSON.stringify(d15.foreign) === JSON.stringify([{ currency: "USD", amount: 50 }]), JSON.stringify(d15));
    ok("  and each agrees with the ledger — the dollars through their exchange difference", r15.ledger === 3620 && d15.ledger === 4140 && !lib.differsFromLedger(r15) && !lib.differsFromLedger(d15), `${r15.ledger} / ${d15.ledger}`);
    const o15 = row(mid, opening)!;
    ok("an opening balance with no invoices is listed as a journal", o15.journals === 5000 && o15.balance === 5000 && o15.ledger === 5000);
    const a15 = row(mid, askew)!;
    ok("an invoice whose posting disagrees is marked with what the ledger holds", a15.balance === 1200 && a15.ledger === 1000 && lib.differsFromLedger(a15) && mid.ledger?.differing === 1, JSON.stringify({ a15, ledger: mid.ledger }));
    ok("no vendor among the customers", !row(mid, vendor));

    const late = (await receivable.customerBalanceSummary({ asOf: "2026-10-21", search: TAG }))!;
    ok("on 21 Oct the 20 Oct payment has come in: 2,620 open, 620 owed", row(late, rupee)?.open === 2620 && row(late, rupee)?.balance === 620 && row(late, rupee)?.ledger === 620, JSON.stringify(row(late, rupee)));
    const early = (await receivable.customerBalanceSummary({ asOf: "2026-10-04", search: TAG }))!;
    ok("on 4 Oct only the opening balance was there", early.rows.length === 1 && early.rows[0]!.id === opening, early.rows.map((r) => r.name).join());
    const named = (await receivable.customerBalanceSummary({ asOf: "2026-10-15", search: `${TAG} dol` }))!;
    ok("a search narrows the rows and the totals", named.rows.length === 1 && named.totals.balance === 4140);
    const nonsense = (await receivable.customerBalanceSummary({ asOf: "15/10/2026", search: TAG }))!;
    ok("a day that isn't one means today", /^\d{4}-\d{2}-\d{2}$/.test(nonsense.asOf) && nonsense.asOf !== "15/10/2026", nonsense.asOf);

    actorId = viewer.id;
    const theirs = (await receivable.customerBalanceSummary({ asOf: "2026-10-15", search: TAG }))!;
    ok("a salesperson sees their own customer whole, and no ledger", theirs.ledger === null && theirs.rows.length === 1 && theirs.rows[0]!.id === rupee && theirs.rows[0]!.balance === 3620 && theirs.rows[0]!.ledger === null, JSON.stringify(theirs.rows.map((r) => [r.name, r.balance])));

    section("Vendors");

    actorId = admin.id;
    const owed = (await payable.vendorBalanceSummary({ asOf: "2026-10-15", search: TAG }))!;
    const v = owed.rows.find((r) => r.id === vendor)!;
    // 5,000 − 2,000 paid, and $50 at 82 = 4,100.
    ok("what we owe the vendor: 7,100 open, agreeing with Accounts Payable", v.open === 7100 && v.balance === 7100 && v.ledger === 7100 && JSON.stringify(v.foreign) === JSON.stringify([{ currency: "USD", amount: 50 }]), JSON.stringify(v));
    ok("  and no customer among the vendors", owed.rows.length === 1);

    section("Rupees on the ageing and the overview");

    const aged = await receivable.agingReport({ search: TAG });
    const agedDollar = aged.rows.find((r) => r.id === dollar)!;
    ok("Receivables: $60 left counts as ₹4,980, with the dollars noted", agedDollar.total === 4980 && agedDollar.foreign.USD === 60, JSON.stringify({ total: agedDollar.total, foreign: agedDollar.foreign }));
    const agedVendor = (await payable.payablesAging({ search: TAG })).rows.find((r) => r.id === vendor)!;
    ok("Payables: the $50 bill counts as ₹4,100", agedVendor.total === 7100 && agedVendor.foreign.USD === 50, JSON.stringify({ total: agedVendor.total, foreign: agedVendor.foreign }));
    const postAr = await dashboard.receivablesOutstanding();
    const postAp = await dashboard.payablesOutstanding();
    // Rupee 2,620 + dollar 4,980 + askew 1,200 (the credit note is fully used).
    ok("the Accounting overview's receivables rose by ₹8,800, the dollars in rupees", Math.round((postAr.total - preAr.total) * 100) / 100 === 8800, postAr.total - preAr.total);
    ok("  and its payables by ₹7,100", Math.round((postAp.total - preAp.total) * 100) / 100 === 7100, postAp.total - preAp.total);
  } finally {
    actorId = "";
    await cleanup();
  }

  console.log(failures === 0 ? "\nAll balance summary checks passed." : `\n${failures} balance summary check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
