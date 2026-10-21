/**
 * Customer and vendor statements across currencies (owner, 21 Oct 2026: "rupees, plus a per-currency
 * section" — src/lib/receivables/statement.ts, customerStatement, vendorStatement):
 *
 *   · Every line in rupees at its own rate, a foreign one with what it was written for; the difference the
 *     ledger books when a dollar invoice is paid at another rate, as a line; an opening balance as a journal.
 *   · One running balance, closing on the party's row in the Customer (Vendor) Balance Summary and on what
 *     Accounts Receivable (Payable) holds for them in the ledger, for real postings.
 *   · What is open in dollars, as written, in its own section; open invoices in their currency and rupees.
 *   · A payment made to the company — as a vendor — isn't one received on its customer statement.
 *   · A period brings forward what came before it and leaves out what came after.
 *
 * Everything is named ZZPROBE_ST / ZZST- and removed in a finally, its ledger entries with it.
 *
 *   npm run check:statements
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => (actorId ? { id: actorId, role: "ADMIN", name: "Zzprobe St", email: `${actorId}${MAIL}` } : null);
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
const TAG = "ZZPROBE_ST";
const MAIL = "@zzprobe-st.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const day = (d: string) => new Date(`${d}T00:00:00Z`);

async function cleanup() {
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  const docs = (await db.tradeDocument.findMany({ where: { docNumber: { startsWith: "ZZST-" } }, select: { id: true } })).map((d) => d.id);
  const payments = companies.length ? (await db.payment.findMany({ where: { companyId: { in: companies } }, select: { id: true } })).map((p) => p.id) : [];
  const entries = { OR: [{ documentId: { in: docs } }, { paymentId: { in: payments } }, { companyId: { in: companies } }, { lines: { some: { companyId: { in: companies } } } }] };
  if (companies.length || docs.length) {
    await db.journalEntry.deleteMany({ where: { reversesId: { not: null }, ...entries } });
    await db.journalEntry.deleteMany({ where: entries });
  }
  await db.creditNoteApplication.deleteMany({ where: { invoiceId: { in: docs } } });
  await db.paymentAllocation.deleteMany({ where: { paymentId: { in: payments } } });
  await db.payment.deleteMany({ where: { id: { in: payments } } });
  await db.tradeDocument.deleteMany({ where: { docNumber: { startsWith: "ZZST-" } } });
  if (companies.length) await db.company.deleteMany({ where: { id: { in: companies } } });
  const users = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  if (users.length) {
    await db.auditLog.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
  }
}

async function main() {
  // Required here, after the session stub: a top-of-file import is hoisted above it and loads the real one.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const receivable = require("../src/actions/receivable") as typeof import("../src/actions/receivable");
  const payable = require("../src/actions/payable") as typeof import("../src/actions/payable");
  const journal = require("../src/lib/ledger/journal") as typeof import("../src/lib/ledger/journal");
  /* eslint-enable @typescript-eslint/no-require-imports */

  await cleanup();
  try {
    const admin = await db.user.create({ data: { name: `${TAG} admin`, email: `admin${MAIL}`, role: "ADMIN", passwordHash: "x".repeat(60) } });
    actorId = admin.id;
    // Inserted naming their columns, so the suite runs whatever columns other work has added to companies
    // and not migrated yet (a create returns the whole row).
    const company = async (name: string, kind: "CLIENT" | "VENDOR") => {
      const id = `zzst_${name.toLowerCase()}_${Date.now()}`;
      await db.$executeRaw`INSERT INTO "companies" ("id", "name", "normalizedName", "relationshipType", "createdById", "ownerUserId", "updatedAt") VALUES (${id}, ${`${TAG} ${name}`}, ${`${TAG} ${name}`.toLowerCase()}, ${kind}::"CompanyRelationshipType", ${admin.id}, ${admin.id}, now())`;
      return id;
    };
    const mixed = await company("Mixed", "CLIENT");
    const vendor = await company("Vendor", "VENDOR");

    let n = 0;
    const tradeDoc = (docType: string, companyId: string, total: number, issued: string, extra: Record<string, unknown> = {}) =>
      db.tradeDocument.create({
        data: { docType, direction: docType === "BILL" ? "PURCHASE" : "SALES", status: "ISSUED", companyId, docNumber: `ZZST-${++n}`, taxableValue: total, total, createdById: admin.id, issueDate: day(issued), ...extra } as never,
        select: { id: true, docNumber: true },
      });
    const payment = (companyId: string, amount: number, paid: string, extra: Record<string, unknown> = {}) =>
      db.payment.create({ data: { companyId, amount, paidOn: day(paid), method: "BANK_TRANSFER", recordedByUserId: admin.id, ...extra } as never, select: { id: true } });
    const allocate = (paymentId: string, documentId: string, amount: number) => db.paymentAllocation.create({ data: { paymentId, documentId, amount, allocatedByUserId: admin.id } });

    const invR = await tradeDoc("INVOICE", mixed, 11800, "2026-10-05");
    const invD = await tradeDoc("INVOICE", mixed, 100, "2026-10-06", { currency: "USD", exchangeRate: 83 });
    const pr1 = await payment(mixed, 5000, "2026-10-08");
    const pd1 = await payment(mixed, 40, "2026-10-09", { currency: "USD", exchangeRate: 85 });
    const cnR = await tradeDoc("CREDIT_NOTE", mixed, 1180, "2026-10-10");
    const pr2 = await payment(mixed, 2000, "2026-10-12");
    // Money we paid them — a refund, or a bill of theirs: not a payment they made.
    const out = await payment(mixed, 700, "2026-10-13", { direction: "PAID" });
    await allocate(pr1.id, invR.id, 5000);
    await allocate(pd1.id, invD.id, 40);
    await db.creditNoteApplication.create({ data: { creditNoteId: cnR.id, invoiceId: invR.id, amount: 1180, appliedByUserId: admin.id, createdAt: day("2026-10-10") } });

    const bill = await tradeDoc("BILL", vendor, 5000, "2026-10-07");
    const billUsd = await tradeDoc("BILL", vendor, 50, "2026-10-08", { currency: "USD", exchangeRate: 82 });
    const pv1 = await payment(vendor, 2000, "2026-10-09", { direction: "PAID" });
    const pv2 = await payment(vendor, 20, "2026-10-11", { direction: "PAID", currency: "USD", exchangeRate: 84 });
    await allocate(pv1.id, bill.id, 2000);
    await allocate(pv2.id, billUsd.id, 20);

    const [ar, obe] = await Promise.all([
      db.ledgerAccount.findUniqueOrThrow({ where: { systemKey: "AR" }, select: { id: true } }),
      db.ledgerAccount.findUniqueOrThrow({ where: { systemKey: "OPENING_BALANCE_EQUITY" }, select: { id: true } }),
    ]);
    await db.$transaction(async (tx) => {
      for (const d of [invR, invD, cnR, bill, billUsd]) await journal.postDocumentToLedger(tx, d.id, admin.id);
      for (const p of [pr1, pd1, pr2, out, pv1, pv2]) await journal.postPaymentToLedger(tx, p.id, admin.id);
      await journal.postExchangeDifferenceToLedger(tx, { paymentId: pd1.id, documentId: invD.id, allocatedAmount: 40, userId: admin.id });
      await journal.postExchangeDifferenceToLedger(tx, { paymentId: pv2.id, documentId: billUsd.id, allocatedAmount: 20, userId: admin.id });
      await journal.writeEntry(tx, {
        date: day("2026-10-01"),
        narration: `${TAG} opening balance`,
        source: "OPENING",
        userId: admin.id,
        lines: [
          { accountId: ar.id, debit: 5000, credit: 0, companyId: mixed },
          { accountId: obe.id, debit: 0, credit: 5000 },
        ],
      });
    }, { timeout: 60_000 });

    section("A customer in rupees and dollars");

    const st = (await receivable.customerStatement(mixed))!;
    const line = (kind: string, ref?: string) => st.ledger.filter((l) => l.kind === kind && (!ref || l.reference === ref));
    ok("the dollar invoice is ₹8,300 at 83, with $100 under it", line("INVOICE", invD.docNumber)[0]?.debit === 8300 && line("INVOICE", invD.docNumber)[0]?.foreign?.amount === 100, JSON.stringify(line("INVOICE", invD.docNumber)));
    ok("  the dollar payment ₹3,400 at 85, with $40", st.ledger.some((l) => l.kind === "PAYMENT" && l.credit === 3400 && l.foreign?.currency === "USD" && l.foreign.amount === 40));
    ok("  and the ₹80 the ledger books as the exchange difference, on the payment's day", line("EXCHANGE").length === 1 && line("EXCHANGE")[0]!.debit === 80 && new Date(line("EXCHANGE")[0]!.date).toISOString().startsWith("2026-10-09"), JSON.stringify(line("EXCHANGE")));
    ok("the opening balance is a journal line", line("JOURNAL").length === 1 && line("JOURNAL")[0]!.debit === 5000);
    ok("the ₹700 we paid them isn't a payment they made", !st.ledger.some((l) => l.kind === "PAYMENT" && (l.credit === 700 || l.debit === 700)) && st.received === 5000 + 3400 + 2000, st.received);
    // 11,800 + 8,300 + 80 + 5,000 − 5,000 − 3,400 − 1,180 − 2,000.
    const closing = st.ledger.at(-1)?.balance;
    ok("one running balance, closing at ₹13,600", closing === 13600 && st.netPosition === 13600, `${closing} / ${st.netPosition}`);
    const summary = (await receivable.customerBalanceSummary({ search: TAG }))!;
    const row = summary.rows.find((r) => r.id === mixed);
    ok("  their row in the Customer Balance Summary, and Accounts Receivable in the ledger", row?.balance === 13600 && row?.ledger === 13600, JSON.stringify(row));
    ok("the figures: ₹10,600 open on invoices, ₹2,000 on account, ₹5,000 in journals", st.outstanding === 10600 && st.unappliedPayments === 2000 && st.unappliedCredits === 0 && st.journals === 5000, JSON.stringify({ o: st.outstanding, p: st.unappliedPayments, c: st.unappliedCredits, j: st.journals }));
    ok("  and the ageing adds up to what's open", Object.values(st.aging).reduce((t, v) => t + v, 0) === 10600);
    const usdOpen = st.openInvoices.find((i) => i.id === invD.id);
    ok("an open dollar invoice: $60 left, ₹4,980", usdOpen?.balance === 60 && usdOpen.currency === "USD" && usdOpen.rupees === 4980, JSON.stringify(usdOpen));
    ok("in dollars: $60 open, nothing on account", JSON.stringify(st.currencies) === JSON.stringify([{ currency: "USD", open: 60, unused: 0, balance: 60 }]), JSON.stringify(st.currencies));

    const period = (await receivable.customerStatement(mixed, { from: "2026-10-09", to: "2026-10-10" }))!;
    const first = period.ledger[0];
    // 5,000 + 11,800 + 8,300 − 5,000 before the 9th.
    ok("a period brings forward ₹20,100 on its first day", first?.kind === "OPENING" && first.debit === 20100 && first.balance === 20100, JSON.stringify(first));
    // − 3,400 + 80 on the 9th, − 1,180 on the 10th; the 12th's payment is after it.
    ok("  and ends on its last, at ₹15,600", period.ledger.at(-1)?.balance === 15600 && !period.ledger.some((l) => l.credit === 2000), JSON.stringify(period.ledger.map((l) => [l.kind, l.balance])));

    section("A vendor in rupees and dollars");

    const vs = (await payable.vendorStatement(vendor))!;
    // ₹5,000 + $50 at 82; ₹2,000 + $20 at 84; the $20 paid at 84 against 82 is ₹40 more.
    ok("billed ₹9,100, paid ₹3,680", vs.billed === 9100 && vs.paid === 3680, `${vs.billed} / ${vs.paid}`);
    ok("  what we owe them, ₹5,460 — the exchange difference counted", vs.outstanding === 5460 && vs.entries.some((e) => e.kind === "EXCHANGE" && e.credit === 40), JSON.stringify(vs.entries.map((e) => [e.kind, e.debit, e.credit])));
    const vsum = (await payable.vendorBalanceSummary({ search: TAG }))!;
    const vrow = vsum.rows.find((r) => r.id === vendor);
    ok("  their row in the Vendor Balance Summary, and Accounts Payable in the ledger", vrow?.balance === 5460 && vrow?.ledger === 5460, JSON.stringify(vrow));
    ok("  and $30 open in dollars", JSON.stringify(vs.currencies) === JSON.stringify([{ currency: "USD", open: 30, unused: 0, balance: 30 }]), JSON.stringify(vs.currencies));
  } finally {
    actorId = "";
    await cleanup();
  }

  console.log(failures === 0 ? "\nAll statement checks passed." : `\n${failures} statement check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
