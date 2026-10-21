/**
 * The aging report, both sides (owner, 21 Oct 2026 — src/lib/receivables/aging.ts, the `?view=aging` view on
 * Receivables and Payables):
 *
 *   · The columns as Zoho counts them: "4 × 15 days" is Current, 1–15, 16–30, 31–45, > 45; aged by the
 *     document's date they start at 0; 4 × 30 by due date is the Aged view's own columns.
 *   · Ages in calendar days, from the due date — or the document's date when it has none, or when asked.
 *   · As of a day: a payment dated after it doesn't count yet; a bill issued after it isn't there; a bill
 *     paid by then is gone.
 *   · In rupees at each document's own rate, what is left in its own currency beside it; credit notes, and
 *     documents paid in full or more, aren't aged.
 *   · The documents behind a figure: one party, one column. The workbook's two sheets.
 *   · Who sees what is the document lists' rule: a salesperson doesn't see another's vendor's bills.
 *
 * Everything is named ZZPROBE_AG / ZZAG- and removed in a finally.
 *
 *   npm run check:aging-report
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
    const user = async () => (actorId ? { id: actorId, role: roles.get(actorId) ?? "PROFILE", name: "Zzprobe Ag", email: `${actorId}${MAIL}` } : null);
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
const TAG = "ZZPROBE_AG";
const MAIL = "@zzprobe-ag.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const day = (d: string) => new Date(`${d}T00:00:00Z`);
const json = (v: unknown) => JSON.stringify(v);

async function cleanup() {
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  const payments = companies.length ? (await db.payment.findMany({ where: { companyId: { in: companies } }, select: { id: true } })).map((p) => p.id) : [];
  await db.paymentAllocation.deleteMany({ where: { paymentId: { in: payments } } });
  await db.payment.deleteMany({ where: { id: { in: payments } } });
  await db.tradeDocument.deleteMany({ where: { docNumber: { startsWith: "ZZAG-" } } });
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
  const lib = require("../src/lib/receivables/aging") as typeof import("../src/lib/receivables/aging");
  const receivable = require("../src/actions/receivable") as typeof import("../src/actions/receivable");
  const payable = require("../src/actions/payable") as typeof import("../src/actions/payable");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("The columns");

  const labels = (basis: "due" | "date", key: Parameters<typeof lib.agingColumns>[1]) => lib.agingColumns(basis, key).map((c) => c.label).join(" | ");
  ok("4 × 15 by due date: Current, 1–15, 16–30, 31–45, > 45", labels("due", "4x15") === "Current | 1–15 days | 16–30 days | 31–45 days | > 45 days", labels("due", "4x15"));
  ok("4 × 30 by due date is the Aged view's columns", labels("due", "4x30") === "Current | 1–30 days | 31–60 days | 61–90 days | > 90 days", labels("due", "4x30"));
  ok("by the document's date they start at 0", labels("date", "4x15") === "0–15 days | 16–30 days | 31–45 days | > 45 days", labels("date", "4x15"));
  const due15 = lib.agingColumns("due", "4x15");
  const at = (age: number) => lib.columnOf(age, due15);
  ok("an age lands in its column, both ends in", [at(-3), at(0), at(1), at(15), at(16), at(45), at(46), at(400)].join() === "0,0,1,1,2,3,4,4", [at(-3), at(0), at(1), at(15), at(16), at(45), at(46), at(400)].join());

  section("Ages");

  ok("days past the due date", lib.ageOn("2026-10-05", "due", day("2026-09-01"), day("2026-09-16")) === 19);
  ok("  not yet due is negative", lib.ageOn("2026-10-05", "due", day("2026-10-01"), day("2026-10-31")) === -26);
  ok("  no due date: from its date", lib.ageOn("2026-09-22", "due", day("2026-09-20"), null) === 2);
  ok("by the document's date, whatever the due date", lib.ageOn("2026-10-20", "date", day("2026-09-01"), day("2026-09-16")) === 49);

  section("Documents, by hand");

  const base = { companySeq: 7, posted: 0, hasEntry: true, entryNumbers: [], allocated: 0, credited: 0, applied: 0, companyId: "v", companyName: "Vendor", currency: "INR", rate: 1 };
  const doc = (over: Record<string, unknown>) => ({ ...base, id: "d", docNumber: "N", docType: "BILL", total: 0, issueDate: day("2026-09-01"), dueDate: day("2026-09-16"), ...over }) as Parameters<typeof lib.ageDocuments>[0]["documents"][number];
  const aged = lib.ageDocuments({
    asOf: "2026-10-05",
    basis: "due",
    columns: due15,
    documents: [
      doc({ id: "b1", docNumber: "B1", total: 5000, allocated: 2000 }),
      doc({ id: "b2", docNumber: "B2", currency: "USD", rate: 82, total: 100, issueDate: day("2026-10-01"), dueDate: day("2026-10-31") }),
      doc({ id: "b3", docNumber: "B3", total: 1000, allocated: 1000 }),
      doc({ id: "b4", docNumber: "B4", total: 1000, allocated: 1200 }),
      doc({ id: "c1", docNumber: "C1", docType: "VENDOR_CREDIT", total: 500 }),
      doc({ id: "z1", docNumber: "Z1", companyId: "z", companyName: "Zeta", companySeq: 9, total: 700, dueDate: null, issueDate: day("2026-06-01") }),
    ],
  });
  ok("paid, overpaid and credit notes aren't aged", aged.map((d) => d.docNumber).join() === "Z1,B1,B2", aged.map((d) => d.docNumber).join());
  const b2 = aged.find((d) => d.id === "b2")!;
  ok("a dollar bill in rupees at its own rate, its dollars beside it", b2.balance === 8200 && b2.left === 100 && b2.currency === "USD" && b2.column === 0, json(b2));
  const b1 = aged.find((d) => d.id === "b1")!;
  ok("what is left after a payment, in its column", b1.balance === 3000 && b1.age === 19 && b1.column === 2 && b1.dueDate === "2026-09-16", json(b1));
  const { rows, totals } = lib.summariseAging(aged, due15.length);
  const vrow = rows.find((r) => r.id === "v")!;
  ok("a row a party, the columns added", json(vrow.cells) === json([8200, 0, 3000, 0, 0]) && json(vrow.counts) === json([1, 0, 1, 0, 0]) && vrow.total === 11200 && vrow.count === 2, json(vrow));
  ok("  its other currencies as written", json(vrow.foreign) === json([{ currency: "USD", amount: 100 }]));
  ok("alphabetical, and the totals add the rows", rows.map((r) => r.name).join() === "Vendor,Zeta" && totals.total === 11900 && json(totals.cells) === json([8200, 0, 3000, 0, 700]) && totals.count === 3, json(totals));

  section("Reading the address");

  const s = lib.readAgingParams({ asOf: "15/10/2026", by: "nonsense", iv: "9x9", show: "pie", party: "x", col: "-1" }, "2026-10-21");
  ok("anything unreadable falls back: today, due date, 4 × 30, amounts, no narrowing", json(s) === json({ asOf: "2026-10-21", basis: "due", interval: "4x30", show: "amount", search: null, party: null, column: null }), json(s));
  const t = lib.readAgingParams({ asOf: "2026-09-30", by: "date", iv: "4x15", show: "count", q: "  acme ", party: "5187", col: "2" }, "2026-10-21");
  ok("and what is readable is kept", json(t) === json({ asOf: "2026-09-30", basis: "date", interval: "4x15", show: "count", search: "acme", party: 5187, column: 2 }), json(t));

  await cleanup();
  try {
    const admin = await db.user.create({ data: { name: `${TAG} admin`, email: `admin${MAIL}`, role: "ADMIN", passwordHash: "x".repeat(60) } });
    roles.set(admin.id, "ADMIN");
    const viewer = await db.user.create({ data: { name: `${TAG} viewer`, email: `viewer${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    roles.set(viewer.id, "SALES");
    await db.userPermission.create({ data: { userId: viewer.id, permission: "payments.view", allowed: true, reason: TAG } });
    // Inserted naming their columns, so the suite runs whatever columns other work has added to companies
    // and not migrated yet.
    const company = async (name: string, kind: "CLIENT" | "VENDOR", owner: string) => {
      const id = `zzag_${name.toLowerCase()}_${Date.now()}`;
      await db.$executeRaw`INSERT INTO "companies" ("id", "name", "normalizedName", "relationshipType", "createdById", "ownerUserId", "updatedAt") VALUES (${id}, ${`${TAG} ${name}`}, ${`${TAG} ${name}`.toLowerCase()}, ${kind}::"CompanyRelationshipType", ${admin.id}, ${owner}, now())`;
      return id;
    };
    const vendor = await company("Vendor", "VENDOR", admin.id);
    const customer = await company("Customer", "CLIENT", admin.id);
    const vendorSeq = (await db.company.findUniqueOrThrow({ where: { id: vendor }, select: { companySeq: true } })).companySeq;

    let n = 0;
    const tradeDoc = (docType: string, companyId: string, total: number, issued: string, due: string | null, extra: Record<string, unknown> = {}) =>
      db.tradeDocument.create({
        data: { docType, direction: docType === "BILL" ? "PURCHASE" : "SALES", status: "ISSUED", companyId, docNumber: `ZZAG-${++n}`, taxableValue: total, total, createdById: admin.id, issueDate: day(issued), dueDate: due ? day(due) : null, ...extra } as never,
        select: { id: true, docNumber: true },
      });
    const pay = async (companyId: string, documentId: string, amount: number, paid: string, direction: "PAID" | "RECEIVED") => {
      const p = await db.payment.create({ data: { companyId, amount, paidOn: day(paid), method: "BANK_TRANSFER", direction, recordedByUserId: admin.id } as never, select: { id: true } });
      await db.paymentAllocation.create({ data: { paymentId: p.id, documentId, amount, allocatedByUserId: admin.id } });
    };

    const b1 = await tradeDoc("BILL", vendor, 5000, "2026-09-01", "2026-09-16");
    const b2 = await tradeDoc("BILL", vendor, 100, "2026-10-01", "2026-10-31", { currency: "USD", exchangeRate: 82 });
    const b3 = await tradeDoc("BILL", vendor, 1000, "2026-09-20", null);
    await pay(vendor, b1.id, 2000, "2026-10-10", "PAID");
    await pay(vendor, b3.id, 1000, "2026-09-25", "PAID");
    const i1 = await tradeDoc("INVOICE", customer, 11800, "2026-08-01", "2026-08-31");

    section("Payables, as of a day");

    actorId = admin.id;
    const ap = async (params: Record<string, string>) => (await payable.payablesAgingReport({ q: TAG, ...params }))!;
    const oct5 = await ap({ asOf: "2026-10-05", iv: "4x15" });
    const row5 = oct5.rows.find((r) => r.id === vendor);
    ok("5 Oct: the payment of 10 Oct not yet — ₹5,000 at 19 days past due, the dollar bill current", json(row5?.cells) === json([8200, 0, 5000, 0, 0]) && row5?.total === 13200 && row5?.count === 2, json(row5));
    ok("  the bill paid on 25 Sep is gone, and the dollars are noted", !oct5.documents.some((d) => d.id === b3.id) && json(row5?.foreign) === json([{ currency: "USD", amount: 100 }]));
    ok("  and no customer among the vendors", oct5.rows.length === 1, oct5.rows.map((r) => r.name).join());
    const oct20 = await ap({ asOf: "2026-10-20", iv: "4x15" });
    ok("20 Oct: ₹3,000 left, now 34 days past due", json(oct20.rows[0]?.cells) === json([8200, 0, 0, 3000, 0]), json(oct20.rows[0]?.cells));
    const sep22 = await ap({ asOf: "2026-09-22", iv: "4x15" });
    ok("22 Sep: the dollar bill not yet issued; the one with no due date aged from its date", json(sep22.rows[0]?.cells) === json([0, 6000, 0, 0, 0]) && sep22.totals.count === 2, json(sep22.rows[0]));
    const byDate = await ap({ asOf: "2026-10-20", by: "date" });
    ok("by bill date, 4 × 30: 49 days and 19 days old", json(byDate.columns.map((c) => c.label)) === json(["0–30 days", "31–60 days", "61–90 days", "> 90 days"]) && json(byDate.rows[0]?.cells) === json([8200, 3000, 0, 0]), json(byDate.rows[0]?.cells));
    const docs = await ap({ asOf: "2026-10-20", iv: "4x15", party: String(vendorSeq), col: "3" });
    ok("the documents behind one figure: that party, that column", docs.documents.length === 1 && docs.documents[0]!.id === b1.id && docs.documents[0]!.balance === 3000 && docs.documents[0]!.age === 34, json(docs.documents));
    ok("  while the summary keeps every row", docs.rows.length === 1 && docs.totals.total === 11200, docs.totals.total);
    const sheets = lib.agingSheets(oct20);
    ok("the workbook: the summary with a total line, and every bill", sheets[0]!.rows.length === 2 && sheets[0]!.rows[1]!.Vendor === "Total" && sheets[1]!.rows.length === 2 && sheets[1]!.rows.some((r) => r["Balance (FCY)"] === "USD 100.00"), json(sheets));

    section("Receivables");

    const ar = (await receivable.receivablesAgingReport({ q: TAG, asOf: "2026-10-20" }))!;
    const crow = ar.rows.find((r) => r.id === customer);
    ok("an invoice 50 days past due in 31–60, by the default 4 × 30", json(crow?.cells) === json([0, 0, 11800, 0, 0]) && ar.documents[0]?.id === i1.id, json(crow));
    ok("  and no vendor among the customers", ar.rows.length === 1);

    section("Who sees what");

    actorId = viewer.id;
    const theirs = (await payable.payablesAgingReport({ q: TAG, asOf: "2026-10-20" }))!;
    ok("a salesperson doesn't see another's vendor's bills", !theirs.rows.some((r) => r.id === vendor) && !theirs.documents.some((d) => d.id === b1.id), json(theirs.rows.map((r) => r.name)));
    void b2;
  } finally {
    actorId = "";
    await cleanup();
  }

  console.log(failures === 0 ? "\nAll aging report checks passed." : `\n${failures} aging report check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
