/**
 * check:migration — a company switching to Deskzo partway through its financial year (src/lib/migration).
 *
 * On a scratch workspace database of its own (<db>_migration_check, built from the migrations and dropped at
 * the end, pass or fail), as an admin:
 *
 *   · starting one: the year from 1 April, the switch on the first of a month, one open at a time;
 *   · invoices from a Zoho Books-style file: grouped by number, posted on their own dates, their IRN, signed
 *     QR and e-way bill kept, marked MIGRATED; void ones left behind; rows outside the year, for an unknown
 *     customer or with a wrong total refused — each with why; the same file again brings nothing twice;
 *   · a credit note applied to its invoice; receipts applied to the invoices they paid, the rest on account,
 *     into the bank account named; the invoices' statuses from what settled them;
 *   · migrated documents count in sales but never in a GST return, a target or commission, and nothing here
 *     generates their e-invoice or e-way bill again;
 *   · bills from Zoho-style rows: two vendors' bills with the same number kept apart, numbered in Deskzo's series
 *     with the vendor's number as the reference, each line posted to the account the file names (by code or
 *     name), TDS withheld at its rate; a void bill left behind, an unknown account or a bank account refused;
 *   · a vendor credit posted to its line's account and set against its bill; vendor payments applied to bills
 *     by the vendor's number, an advance left over, paid through the bank or cash; bills' statuses from them;
 *   · expenses as payment vouchers — tax worked out, inclusive or not, two alike on one day both brought, the
 *     same file again bringing nothing; manual journals as journal and contra vouchers, an unbalanced one or a
 *     payable line with no contact refused; the accounts they touch at the month end what the files add up to;
 *   · Undo takes back every document, payment, vendor credit, voucher and entry, leaving the opening entry;
 *   · the old system's month-end trial balances: a Month column or the month chosen, a bad month or an unknown
 *     account keeping nothing; each month compared account by account; a deliberate difference shown, then
 *     covered by an adjustment;
 *   · Finish needs every month agreeing and the right to close the books; it locks the year, and nothing can
 *     be posted into it after; the accounting pages' "figures not final" banner comes and goes with it.
 *
 * The session is a stand-in; no mail is sent; nothing is written to any other database.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import Module from "node:module";
import Papa from "papaparse";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const withDatabase = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};
const file = (rows: Record<string, string>[], name: string) => ({
  filename: name,
  base64: Buffer.from(Papa.unparse({ fields: [...new Set(rows.flatMap((r) => Object.keys(r)))], data: rows })).toString("base64"),
});

let actorId = "";
const roles = new Map<string, string>();
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => (actorId ? { id: actorId, role: roles.get(actorId) ?? "PROFILE", name: "Zz Migrator", email: `${actorId}@zzmigration.invalid` } : null);
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

const IRN = "a".repeat(32) + "0123456789abcdef0123456789abcdef";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is needed.");
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error("Only against a local database server.");
  const scratchName = `${new URL(url).pathname.slice(1)}_migration_check`;
  const scratchUrl = withDatabase(url, scratchName);
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });

  section("A scratch workspace");
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
  try {
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60_000 });
    ok("built from its migrations", true);
    // Everything below reads and writes the scratch database: the workspace is the environment's, and no
    // control plane is consulted. Off by value, never deleted, so a client re-reading .env can't put it back.
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = " ";
    process.env.DESKZO_TENANCY_FALLBACK = "legacy";
    await scenario();
  } finally {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname = ${scratchName}`;
    ok("the scratch workspace is dropped", Number(left[0]!.n) === 0);
    await admin.$disconnect();
  }
  console.log(failures === 0 ? "\nAll migration checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

async function scenario() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const actions = require("../src/actions/migration") as typeof import("../src/actions/migration");
  const state = require("../src/lib/migration/state") as typeof import("../src/lib/migration/state");
  const balances = require("../src/lib/migration/balances") as typeof import("../src/lib/migration/balances");
  const ledgerLib = require("../src/lib/migration/ledger") as typeof import("../src/lib/migration/ledger");
  const steps = require("../src/lib/migration/steps") as typeof import("../src/lib/migration/steps");
  const journal = require("../src/lib/ledger/journal") as typeof import("../src/lib/ledger/journal");
  const openingLib = require("../src/lib/portability/opening-balances") as typeof import("../src/lib/portability/opening-balances");
  const imported = require("../src/lib/documents/imported") as typeof import("../src/lib/documents/imported");
  const { renderHtml } = require("./lib/render-html") as typeof import("./lib/render-html");
  const Layout = (require("../src/app/(dashboard)/accounting/layout") as { default: (p: { children: unknown }) => Promise<unknown> }).default;
  /* eslint-enable @typescript-eslint/no-require-imports */

  await journal.ensureChartOfAccounts();
  const user = async (key: string, role: "ADMIN" | "PROFILE", grants: string[] = []) => {
    const u = await db.user.create({ data: { name: `Zz ${key}`, email: `${key}@zzmigration.invalid`, role, passwordHash: "x".repeat(60) } });
    roles.set(u.id, role);
    for (const permission of grants) await db.userPermission.create({ data: { userId: u.id, permission, allowed: true, reason: "check:migration" } });
    return u;
  };
  const boss = await user("boss", "ADMIN");
  const clerk = await user("clerk", "PROFILE", ["ledger.post", "data.importFinance"]);
  const outsider = await user("outsider", "PROFILE", ["ledger.post"]);

  const company = async (name: string, state: string, gstin: string) => {
    const c = await db.company.create({ data: { name, normalizedName: name.toLowerCase(), relationshipType: "CLIENT", createdById: boss.id, ownerUserId: boss.id } });
    await db.companyLocation.create({ data: { companyId: c.id, label: "Head office", isPrimary: true, state, gstNumber: gstin, gstTreatment: "REGISTERED_REGULAR", city: "City", address: "1 Road", pincode: "400001", country: "India" } });
    return c;
  };
  const acme = await company("Zz Acme Traders", "Maharashtra", "27AAACZ1234F1Z5");
  const bright = await company("Zz Bright Retail", "Karnataka", "29AAACB5678K1Z2");
  const accounts = new Map((await db.ledgerAccount.findMany({ where: { systemKey: { not: null } }, select: { id: true, code: true, systemKey: true } })).map((a) => [a.systemKey!, a]));
  const capital = await db.ledgerAccount.create({ data: { code: "ZZ-CAP", name: "Zz Capital", type: "EQUITY" } });
  const hdfcLedger = await db.ledgerAccount.create({ data: { code: "ZZ-HDFC", name: "Zz HDFC Current", type: "ASSET" } });
  await db.bankAccount.create({ data: { name: "Zz HDFC", ledgerAccountId: hdfcLedger.id } });
  const vendor = async (name: string, state: string, gstin: string) => {
    const c = await db.company.create({ data: { name, normalizedName: name.toLowerCase(), relationshipType: "VENDOR", createdById: boss.id, ownerUserId: boss.id } });
    await db.companyLocation.create({ data: { companyId: c.id, label: "Head office", isPrimary: true, state, gstNumber: gstin, gstTreatment: "REGISTERED_REGULAR", city: "City", address: "1 Road", pincode: "400001", country: "India" } });
    return c;
  };
  const steel = await vendor("Zz Steel Supplies", "Maharashtra", "27AAACS1111A1Z1");
  const spices = await vendor("Zz Kerala Spices", "Kerala", "32AAACK2222B1Z2");
  // The old system's own accounts, which the chart is given before its purchases come across.
  const rent = await db.ledgerAccount.create({ data: { code: "ZZ-RENT", name: "Zz Rent", type: "EXPENSE" } });
  const supplies = await db.ledgerAccount.create({ data: { code: "ZZ-OFF", name: "Zz Office Supplies", type: "EXPENSE" } });
  const furniture = await db.ledgerAccount.create({ data: { code: "ZZ-FUR", name: "Zz Furniture", type: "ASSET" } });

  section("Who may");
  ok("every step is in this plan", (await steps.stepsInPlan()).length === steps.STEPS.length);
  actorId = outsider.id;
  ok("posting journals without importing finance data isn't enough", !(await actions.startMigrationAction({ source: "zoho-books", yearStart: "2026-04-01", switchDate: "2026-07-01" })).ok);

  section("Starting one");
  actorId = clerk.id;
  const refusal = async (yearStart: string, switchDate: string) => {
    const r = await actions.startMigrationAction({ source: "zoho-books", yearStart, switchDate });
    return r.ok ? "" : r.error;
  };
  ok("the year starts on 1 April", /1 April/.test(await refusal("2026-05-01", "2026-07-01")));
  ok("the switch is the first of a month", /first of a month/.test(await refusal("2026-04-01", "2026-07-15")));
  ok("the switch is inside the year", /inside|in that financial year/.test(await refusal("2026-04-01", "2027-05-01")));
  const started = await actions.startMigrationAction({ source: "zoho-books", yearStart: "2026-04-01", switchDate: "2026-07-01" });
  ok("started: April to the day before 1 July", started.ok);
  ok("  only one at a time", /already open/.test(await refusal("2026-04-01", "2026-07-01")));
  let m = (await state.openMigration())!;
  ok("  its months are April, May and June", state.migrationMonths(m).join() === "2026-04,2026-05,2026-06", state.migrationMonths(m));

  // The start of the year, as today's opening import brings it: bank and capital on 1 April.
  await openingLib.applyOpeningBalances(
    [
      { "Account code": accounts.get("BANK")!.code, Debit: "100000", Credit: "" },
      { "Account code": "ZZ-CAP", Debit: "", Credit: "100000" },
    ],
    clerk.id,
    { openingDate: "2026-04-01", filename: "opening.csv" },
  );

  // As Zoho Books exports invoices: one row a line, its own headings.
  const invoiceRows = (extra = true) => [
    { "Invoice Number": "ZZM-INV-001", "Invoice Date": "2026-04-10", "Customer Name": "Zz Acme Traders", "Invoice Status": "Paid", "Item Name": "Laptop", Quantity: "2", "Item Price": "50000", "Item Tax %": "18", Total: "129800", "IRN Number": IRN, "Ack No": "112610000012345", "Ack Dt": "2026-04-10", "Signed QR Code Data": "eyJhbGciOiJ.zz.signed", "E-Way Bill No": "321098765432", "E-Way Bill Date": "2026-04-10", "E-Way Bill Valid Till": "2026-04-12" },
    { "Invoice Number": "ZZM-INV-001", "Invoice Date": "", "Customer Name": "", "Invoice Status": "", "Item Name": "Support", Quantity: "1", "Item Price": "10000", "Item Tax %": "18", Total: "", "IRN Number": "", "Ack No": "", "Ack Dt": "", "Signed QR Code Data": "", "E-Way Bill No": "", "E-Way Bill Date": "", "E-Way Bill Valid Till": "" },
    { "Invoice Number": "ZZM-INV-002", "Invoice Date": "2026-05-05", "Customer Name": "Zz Bright Retail", "Invoice Status": "Paid", "Item Name": "Monitor", Quantity: "1", "Item Price": "20000", "Item Tax %": "18", Total: "23600", "IRN Number": "", "Ack No": "", "Ack Dt": "", "Signed QR Code Data": "", "E-Way Bill No": "", "E-Way Bill Date": "", "E-Way Bill Valid Till": "" },
    { "Invoice Number": "ZZM-INV-003", "Invoice Date": "2026-06-20", "Customer Name": "Zz Acme Traders", "Invoice Status": "Overdue", "Item Name": "Cable", Quantity: "1", "Item Price": "5000", "Item Tax %": "18", Total: "5900", "IRN Number": "", "Ack No": "", "Ack Dt": "", "Signed QR Code Data": "", "E-Way Bill No": "", "E-Way Bill Date": "", "E-Way Bill Valid Till": "" },
    ...(extra
      ? [
          { "Invoice Number": "ZZM-INV-004", "Invoice Date": "2026-06-21", "Customer Name": "Zz Acme Traders", "Invoice Status": "Void", "Item Name": "Cable", Quantity: "1", "Item Price": "5000", "Item Tax %": "18", Total: "5900", "IRN Number": "", "Ack No": "", "Ack Dt": "", "Signed QR Code Data": "", "E-Way Bill No": "", "E-Way Bill Date": "", "E-Way Bill Valid Till": "" },
          { "Invoice Number": "ZZM-INV-005", "Invoice Date": "2026-07-05", "Customer Name": "Zz Acme Traders", "Invoice Status": "Sent", "Item Name": "Cable", Quantity: "1", "Item Price": "5000", "Item Tax %": "18", Total: "5900", "IRN Number": "", "Ack No": "", "Ack Dt": "", "Signed QR Code Data": "", "E-Way Bill No": "", "E-Way Bill Date": "", "E-Way Bill Valid Till": "" },
          { "Invoice Number": "ZZM-INV-006", "Invoice Date": "2026-05-06", "Customer Name": "Zz Nobody Ltd", "Invoice Status": "Sent", "Item Name": "Cable", Quantity: "1", "Item Price": "5000", "Item Tax %": "18", Total: "5900", "IRN Number": "", "Ack No": "", "Ack Dt": "", "Signed QR Code Data": "", "E-Way Bill No": "", "E-Way Bill Date": "", "E-Way Bill Valid Till": "" },
          { "Invoice Number": "ZZM-INV-007", "Invoice Date": "2026-05-07", "Customer Name": "Zz Acme Traders", "Invoice Status": "Sent", "Item Name": "Cable", Quantity: "1", "Item Price": "5000", "Item Tax %": "18", Total: "9999", "IRN Number": "", "Ack No": "", "Ack Dt": "", "Signed QR Code Data": "", "E-Way Bill No": "", "E-Way Bill Date": "", "E-Way Bill Valid Till": "" },
        ]
      : []),
  ];
  const creditRows = [{ "Credit Note Number": "ZZM-CN-001", "Credit Note Date": "2026-05-15", "Customer Name": "Zz Acme Traders", "Invoice Number": "ZZM-INV-001", "Item Name": "Laptop return", Quantity: "1", "Item Price": "10000", "Item Tax %": "18", Total: "11800" }];
  const receiptRows = [
    { "Payment Number": "ZZM-PAY-001", Date: "2026-05-20", "Customer Name": "Zz Acme Traders", Amount: "118000", "Payment Mode": "Bank Transfer", "Deposit To": "Zz HDFC", "Invoice Number": "ZZM-INV-001", "Amount Applied to Invoice": "118000" },
    { "Payment Number": "ZZM-PAY-002", Date: "2026-06-10", "Customer Name": "Zz Bright Retail", Amount: "30000", "Payment Mode": "Cheque", "Deposit To": "", "Invoice Number": "ZZM-INV-002", "Amount Applied to Invoice": "" },
    { "Payment Number": "ZZM-PAY-003", Date: "2026-06-11", "Customer Name": "Zz Bright Retail", Amount: "500", "Payment Mode": "Cash", "Deposit To": "", "Invoice Number": "ZZM-INV-999", "Amount Applied to Invoice": "500" },
  ];

  // The purchase side, as Zoho Books exports it. Both vendors numbered a bill V-100.
  const bill = (number: string, date: string, vendorName: string, status: string, item: string, desc: string, qty: string, rate: string, account: string, more: Record<string, string> = {}) => ({
    "Bill Number": number, "Bill Date": date, "Vendor Name": vendorName, "Bill Status": status, "Item Name": item, "Item Desc": desc, Quantity: qty, Rate: rate, "Item Tax %": "18", Account: account, "TDS Percentage": "", "TDS Section": "", Total: "", ...more,
  });
  const billRows = [
    bill("V-100", "2026-04-15", "Zz Steel Supplies", "Paid", "Office chairs", "", "2", "10000", "Zz Furniture", { Total: "24780" }),
    bill("V-100", "", "", "", "", "Printer paper", "1", "1000", "ZZ-OFF"),
    bill("V-100", "2026-05-10", "Zz Kerala Spices", "Paid", "", "Warehouse rent for May", "1", "50000", "Zz Rent", { "TDS Percentage": "10", "TDS Section": "194I", Total: "54000" }),
    bill("V-101", "2026-05-11", "Zz Steel Supplies", "Void", "Bolts", "", "1", "100", ""),
    bill("V-102", "2026-05-12", "Zz Steel Supplies", "Open", "Bolts", "", "1", "100", "Zz Nowhere"),
    bill("V-103", "2026-05-13", "Zz Steel Supplies", "Open", "Bolts", "", "1", "100", "Zz HDFC"),
  ];
  const vendorCreditRows = [{ "Vendor Credit Number": "VC-1", "Vendor Credit Date": "2026-05-20", "Vendor Name": "Zz Steel Supplies", "Item Name": "Damaged chair", Account: "Zz Furniture", Amount: "5000", "Item Tax %": "18", "Bill Number": "V-100", "Amount Applied": "5900", Total: "5900" }];
  const vendorPaymentRows = [
    { "Payment Number": "VP-1", Date: "2026-06-05", "Vendor Name": "Zz Steel Supplies", Amount: "18880", "Payment Mode": "Bank Transfer", "Paid Through": "Zz HDFC", "Bill Number": "V-100", "Amount Applied to Bill": "18880" },
    { "Payment Number": "VP-2", Date: "2026-06-06", "Vendor Name": "Zz Kerala Spices", Amount: "60000", "Payment Mode": "Bank Transfer", "Paid Through": "Petty Cash", "Bill Number": "V-100", "Amount Applied to Bill": "" },
    { "Payment Number": "VP-3", Date: "2026-06-07", "Vendor Name": "Zz Steel Supplies", Amount: "100", "Payment Mode": "Cash", "Paid Through": "", "Bill Number": "V-999", "Amount Applied to Bill": "100" },
  ];
  const rentExpense = { "Expense Reference ID": "", "Expense Date": "2026-04-20", "Expense Account": "Zz Rent", "Paid Through": "Zz HDFC", "Vendor Name": "Zz Landlord", "Expense Amount": "30000", "Tax Percentage": "18", "Is Inclusive Tax": "false", "Reference#": "APR-RENT", Notes: "" };
  const expenseRows = [
    rentExpense,
    rentExpense,
    { ...rentExpense, "Expense Reference ID": "EXP-9", "Expense Date": "2026-05-02", "Expense Account": "ZZ-OFF", "Paid Through": "Petty Cash", "Vendor Name": "", "Expense Amount": "1180", "Is Inclusive Tax": "true", "Reference#": "", Notes: "Stationery" },
    { ...rentExpense, "Expense Reference ID": "EXP-10", "Expense Account": "Zz HDFC", "Paid Through": "Petty Cash", "Expense Amount": "100", "Tax Percentage": "" },
  ];
  const journalLine = (number: string, date: string, account: string, debit: string, credit: string, contact = "", notes = "") => ({ "Journal Number": number, "Journal Date": date, Notes: notes, Account: account, "Contact Name": contact, Debit: debit, Credit: credit });
  const journalRows = [
    journalLine("J-1", "2026-06-30", "ZZ-RENT", "2000", "", "", "Rent for June, billed in July"),
    journalLine("J-1", "", "Accounts Payable", "", "2000", "Zz Kerala Spices"),
    journalLine("J-2", "2026-06-15", "Cash", "5000", "", "", "Cash withdrawn"),
    journalLine("J-2", "", "Zz HDFC", "", "5000"),
    journalLine("J-3", "2026-06-16", "ZZ-RENT", "100", "", "", "Unbalanced"),
    journalLine("J-3", "", "Zz HDFC", "", "90"),
    journalLine("J-4", "2026-06-17", "ZZ-RENT", "100", "", "", "No contact"),
    journalLine("J-4", "", "Accounts Payable", "", "100"),
  ];

  const bring = async (step: string, rows: Record<string, string>[]) => {
    const up = await actions.uploadMigrationFile(step, file(rows, `${step}.csv`));
    if (!up.ok) throw new Error(`${step}: ${up.error}`);
    const outcomes: { kind: string; label: string; error?: string }[] = [];
    for (let offset = 0; offset < up.data.units; ) {
      const c = await actions.checkMigrationPart(up.data.fileId, offset);
      if (!c.ok) throw new Error(c.error);
      outcomes.push(...(c.data.outcomes as { kind: string; label: string; error?: string }[]));
      offset = c.data.next;
    }
    let progress: Awaited<ReturnType<typeof actions.importMigrationPart>> | null = null;
    for (;;) {
      progress = await actions.importMigrationPart(up.data.fileId);
      if (!progress.ok) throw new Error(progress.error);
      if (progress.data.done >= progress.data.units) break;
    }
    return { up: up.data, outcomes, progress: progress.ok ? progress.data : null };
  };

  const everything = async () => {
    const inv = await bring("invoices", invoiceRows());
    const cn = await bring("credit-notes", creditRows);
    const rc = await bring("receipts", receiptRows);
    const bl = await bring("bills", billRows);
    const vc = await bring("vendor-credits", vendorCreditRows);
    const vp = await bring("vendor-payments", vendorPaymentRows);
    const ex = await bring("expenses", expenseRows);
    const jn = await bring("journals", journalRows);
    return { inv, cn, rc, bl, vc, vp, ex, jn };
  };

  section("Invoices");
  const first = await everything();
  const errors = first.inv.outcomes.filter((o) => o.kind === "error");
  ok("Zoho's headings are read: eight rows make seven invoices", first.inv.up.units === 7, first.inv.up);
  ok("  the check: three to bring, the void one left behind, three with a problem", first.inv.outcomes.filter((o) => o.kind === "create").length === 3 && first.inv.outcomes.filter((o) => o.kind === "skip").length === 1 && errors.length === 3, first.inv.outcomes);
  ok("  dated after the switch: refused, saying the year", errors.some((e) => e.label === "ZZM-INV-005" && /outside the year/.test(e.error ?? "")));
  ok("  an unknown customer: refused, naming it", errors.some((e) => e.label === "ZZM-INV-006" && /Zz Nobody Ltd/.test(e.error ?? "")));
  ok("  a total that doesn't add up: refused, with both figures", errors.some((e) => e.label === "ZZM-INV-007" && /₹5,900/.test(e.error ?? "") && /₹9,999/.test(e.error ?? "")));
  ok("  imported: three, and the three failures kept with why", first.inv.progress?.created === 3 && first.inv.progress?.failed.length === 3, first.inv.progress);
  const inv1 = await db.tradeDocument.findUniqueOrThrow({ where: { docNumber: "ZZM-INV-001" }, include: { ewayBills: true } });
  ok("ZZM-INV-001 is MIGRATED, issued on its own date, total ₹1,29,800", inv1.origin === "MIGRATED" && inv1.issueDate.toISOString().slice(0, 10) === "2026-04-10" && Number(inv1.total) === 129800, { origin: inv1.origin, total: Number(inv1.total) });
  ok("  its e-invoice kept as issued: IRN, acknowledgement, signed QR, marked generated", inv1.irn === IRN && inv1.ackNo === "112610000012345" && inv1.signedQrCode === "eyJhbGciOiJ.zz.signed" && inv1.einvoiceStatus === "GENERATED");
  ok("  its e-way bill too, with its number and validity", inv1.ewayBills.length === 1 && inv1.ewayBills[0]!.ewayBillNumber === "321098765432" && inv1.ewayBills[0]!.status === "GENERATED" && inv1.ewayBills[0]!.validUntil?.toISOString().slice(0, 10) === "2026-04-12");
  const entry1 = await db.journalEntry.findFirst({ where: { documentId: inv1.id } });
  ok("  posted on its own date", entry1?.date.toISOString().slice(0, 10) === "2026-04-10", entry1?.date);
  ok("  no stock moved for it", (await db.stockMovement.count({ where: { tradeDocumentId: inv1.id } })) === 0);
  const inv2 = await db.tradeDocument.findUniqueOrThrow({ where: { docNumber: "ZZM-INV-002" } });
  ok("ZZM-INV-002 to Karnataka is inter-state: IGST", Number(inv2.igstAmount) === 3600 && Number(inv2.cgstAmount) === 0, { igst: Number(inv2.igstAmount) });

  section("Credit notes and receipts");
  const cn1 = await db.tradeDocument.findUniqueOrThrow({ where: { docNumber: "ZZM-CN-001" } });
  const applied = await db.creditNoteApplication.findFirst({ where: { creditNoteId: cn1.id } });
  ok("the credit note is applied to the invoice it names, in full", Number(applied?.amount) === 11800 && applied?.invoiceId === inv1.id);
  ok("  receipts: two brought, one refused for an invoice that isn't here", first.rc.progress?.created === 2 && first.rc.progress?.failed.some((f) => /ZZM-INV-999/.test(f.error)), first.rc.progress);
  const pay1 = await db.payment.findFirstOrThrow({ where: { companyId: acme.id }, include: { allocations: true } });
  ok("  ZZM-PAY-001: into the HDFC account, applied to ZZM-INV-001, on its own date", pay1.bankAccountId !== null && pay1.allocations.length === 1 && Number(pay1.allocations[0]!.amount) === 118000 && pay1.paidOn.toISOString().slice(0, 10) === "2026-05-20" && pay1.method === "BANK_TRANSFER");
  const pay2 = await db.payment.findFirstOrThrow({ where: { companyId: bright.id }, include: { allocations: true } });
  ok("  ZZM-PAY-002: what the invoice owed applied, the rest on account", Number(pay2.amount) === 30000 && Number(pay2.allocations[0]!.amount) === 23600 && pay2.method === "CHEQUE");
  const statuses = await db.tradeDocument.findMany({ where: { docNumber: { in: ["ZZM-INV-001", "ZZM-INV-002", "ZZM-INV-003"] } }, select: { docNumber: true, status: true }, orderBy: { docNumber: "asc" } });
  ok("  statuses from what settled them: paid, paid, issued", statuses.map((s) => s.status).join() === "PAID,PAID,ISSUED", statuses);

  section("Bills");
  const head = await ledgerLib.headOffice();
  const intra = head.stateCode === "27";
  const linesOf = async (where: { documentId?: string; vendorCreditId?: string; accountVoucherId?: string }) => {
    const entry = await db.journalEntry.findFirst({ where, include: { lines: { include: { account: { select: { code: true } } } } } });
    const sums = new Map<string, number>();
    for (const l of entry?.lines ?? []) sums.set(l.account.code, Math.round(((sums.get(l.account.code) ?? 0) + Number(l.debit) - Number(l.credit)) * 100) / 100);
    return { entry, sums };
  };
  const code = (key: string) => accounts.get(key)!.code;
  const billErrors = first.bl.outcomes.filter((o) => o.kind === "error");
  ok("six rows make five bills: two to bring, the void one left behind, two with a problem", first.bl.up.units === 5 && first.bl.outcomes.filter((o) => o.kind === "create").length === 2 && first.bl.outcomes.filter((o) => o.kind === "skip").length === 1 && billErrors.length === 2, first.bl.outcomes);
  ok("  an account the chart hasn't got: refused, naming it", billErrors.some((e) => e.label === "V-102" && /Zz Nowhere/.test(e.error ?? "")));
  ok("  a bank account on a line: refused", billErrors.some((e) => e.label === "V-103" && /bank or cash/.test(e.error ?? "")));
  const bills = await db.tradeDocument.findMany({ where: { docType: "BILL" }, orderBy: { issueDate: "asc" }, select: { id: true, docNumber: true, reference: true, origin: true, companyId: true, total: true, status: true, withholdingSection: true, withholdingAmount: true } });
  const steelBill = bills.find((b) => b.companyId === steel.id);
  const spicesBill = bills.find((b) => b.companyId === spices.id);
  ok("both vendors' V-100 came across, apart: Deskzo's own numbers, V-100 kept as the reference, MIGRATED", bills.length === 2 && !!steelBill && !!spicesBill && steelBill.docNumber !== spicesBill.docNumber && bills.every((b) => b.reference === "V-100" && b.origin === "MIGRATED"), bills);
  const steelEntry = await linesOf({ documentId: steelBill?.id });
  ok(
    "  Steel's: each line to its account — chairs to Furniture, paper to Office Supplies (by code) — tax as input, Payables the total",
    steelEntry.sums.get("ZZ-FUR") === 20000 && steelEntry.sums.get("ZZ-OFF") === 1000 && steelEntry.sums.get(code("AP")) === -24780 && !steelEntry.sums.has(code("PURCHASES")) && (intra ? steelEntry.sums.get(code("INPUT_CGST")) === 1890 : steelEntry.sums.get(code("INPUT_IGST")) === 3780),
    Object.fromEntries(steelEntry.sums),
  );
  ok("  posted on its own date", steelEntry.entry?.date.toISOString().slice(0, 10) === "2026-04-15", steelEntry.entry?.date);
  const spicesEntry = await linesOf({ documentId: spicesBill?.id });
  ok(
    "  the Kerala vendor's rent: to Rent, IGST, TDS withheld at 10% under 194I, Payables what's left (the file's total after TDS agreed)",
    spicesEntry.sums.get("ZZ-RENT") === 50000 && spicesEntry.sums.get(code("INPUT_IGST")) === 9000 && spicesEntry.sums.get(code("TDS_PAYABLE")) === -5000 && spicesEntry.sums.get(code("AP")) === -54000 && spicesBill?.withholdingSection === "194I",
    Object.fromEntries(spicesEntry.sums),
  );

  section("Vendor credits and payments");
  const credit = await db.vendorCredit.findFirst({ where: { vendorId: steel.id }, include: { applications: true } });
  ok("the vendor credit: Steel's VC-1, ₹5,900, set against its V-100 on its own date", credit?.reference === "VC-1" && Number(credit.total) === 5900 && credit.applications.length === 1 && credit.applications[0]!.billId === steelBill?.id && Number(credit.applications[0]!.amount) === 5900 && credit.applications[0]!.createdAt.toISOString().slice(0, 10) === "2026-05-20", credit);
  const creditEntry = await linesOf({ vendorCreditId: credit?.id });
  ok("  posted back to the chairs' account, its input tax reversed, Payables down", creditEntry.sums.get("ZZ-FUR") === -5000 && creditEntry.sums.get(code("AP")) === 5900, Object.fromEntries(creditEntry.sums));
  ok("  vendor payments: two brought, one refused for a bill that isn't here", first.vp.progress?.created === 2 && first.vp.progress?.failed.some((f) => /V-999/.test(f.error)), first.vp.progress);
  const paidOut = await db.payment.findMany({ where: { direction: "PAID" }, include: { allocations: true } });
  const vp1 = paidOut.find((p) => p.companyId === steel.id);
  const vp2 = paidOut.find((p) => p.companyId === spices.id);
  ok("  VP-1 from the HDFC account settles what Steel's bill still owed after the credit", vp1?.bankAccountId !== null && Number(vp1?.allocations[0]?.amount) === 18880 && vp1?.allocations[0]?.documentId === steelBill?.id);
  ok("  VP-2 paid through petty cash: cash, the bill's ₹54,000 applied, ₹6,000 left as an advance", vp2?.method === "CASH" && vp2.bankAccountId === null && Number(vp2.allocations[0]?.amount) === 54000);
  const billStatuses = await db.tradeDocument.findMany({ where: { docType: "BILL" }, select: { status: true } });
  ok("  both bills are paid", billStatuses.every((b) => b.status === "PAID"), billStatuses);

  section("Expenses and journals");
  ok("four expense rows: three to bring (two alike on one day are two), one refused for a bank account as the expense", first.ex.up.units === 4 && first.ex.progress?.created === 3 && first.ex.progress?.failed.length === 1 && /bank or cash/.test(first.ex.progress?.failed[0]?.error ?? ""), first.ex.progress);
  const vouchers = await db.accountVoucher.findMany({ orderBy: { number: "asc" }, include: { journalEntries: true } });
  const payments = vouchers.filter((v) => v.type === "PAYMENT");
  ok("  each a posted payment voucher, numbered in the year's series, posted on its date", payments.length === 3 && payments.every((v) => v.status === "POSTED" && v.number.startsWith("PMT/2026-27/") && v.journalEntries.length === 1 && v.journalEntries[0]!.date.getTime() === v.date.getTime()), payments.map((v) => [v.number, v.status, v.date]));
  const rentVoucher = payments.find((v) => v.reference === "APR-RENT");
  const rentLines = await linesOf({ accountVoucherId: rentVoucher?.id });
  ok("  the rent: ₹30,000 to Rent, ₹5,400 input tax, ₹35,400 out of HDFC; the unknown landlord kept in the narration", rentLines.sums.get("ZZ-RENT") === 30000 && rentLines.sums.get("ZZ-HDFC") === -35400 && /Zz Landlord/.test(rentVoucher?.narration ?? ""), { ...Object.fromEntries(rentLines.sums), narration: rentVoucher?.narration });
  const stationery = payments.find((v) => v.narration.startsWith("Stationery"));
  const stationeryLines = await linesOf({ accountVoucherId: stationery?.id });
  ok("  tax inclusive: ₹1,180 is ₹1,000 and ₹180 tax, out of cash", stationeryLines.sums.get("ZZ-OFF") === 1000 && stationeryLines.sums.get(code("CASH")) === -1180, Object.fromEntries(stationeryLines.sums));
  const journalErrors = first.jn.progress?.failed ?? [];
  ok("journals: two brought, the unbalanced one and the payable with no contact refused", first.jn.progress?.created === 2 && journalErrors.some((f) => /doesn't balance/.test(f.error)) && journalErrors.some((f) => /choose whose/.test(f.error)), first.jn.progress);
  const j1 = vouchers.find((v) => v.reference === "J-1");
  const j2 = vouchers.find((v) => v.reference === "J-2");
  ok("  the provision is a journal voucher with the vendor on its payable line; the withdrawal a contra", j1?.type === "JOURNAL" && j1.companyId === spices.id && j2?.type === "CONTRA", { j1: j1?.type, j2: j2?.type });
  const at = async (accountId: string) => {
    const s = await db.journalLine.aggregate({ where: { accountId, entry: { date: { lt: state.afterMonth("2026-06") } } }, _sum: { debit: true, credit: true } });
    return Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0);
  };
  ok("Rent at 30 June is what the files add up to: the bill, two expenses and the provision", (await at(rent.id)) === 112000, await at(rent.id));
  ok("  Furniture: the chairs less the credit; Office Supplies: the paper and the stationery", (await at(furniture.id)) === 15000 && (await at(supplies.id)) === 2000, { furniture: await at(furniture.id), supplies: await at(supplies.id) });
  ok("  and nothing went to Purchases", (await at(accounts.get("PURCHASES")!.id)) === 0);
  const expensesAgain = await bring("expenses", expenseRows);
  ok("  the same expenses again bring nothing twice", expensesAgain.progress?.created === 0, expensesAgain.progress);

  section("Where migrated documents count");
  const ours = { docNumber: { startsWith: "ZZM-" } };
  ok("in the year's sales", (await db.tradeDocument.count({ where: { AND: [ours, imported.SOLD_THIS_YEAR] } })) === 4);
  ok("never in a GST return, a target or commission (raised in Deskzo only)", (await db.tradeDocument.count({ where: { AND: [ours, imported.RAISED_IN_DESKZO] } })) === 0);
  ok("  and nothing here generates their e-invoice or e-way bill again", imported.isImported(inv1));

  section("Undo");
  const before = await db.journalEntry.count();
  const undone = await actions.undoMigrationAction();
  ok("everything it brought is taken back: six documents, four payments, the vendor credit, five vouchers", undone.ok && undone.data.documents === 6 && undone.data.payments === 4 && undone.data.vendorCredits === 1 && undone.data.vouchers === 5, undone);
  ok("  documents, payments, credits, vouchers and their entries gone; the opening entry stays", (await db.tradeDocument.count()) === 0 && (await db.payment.count()) === 0 && (await db.vendorCredit.count()) === 0 && (await db.accountVoucher.count()) === 0 && (await db.journalEntry.count()) === 1 && before > 1, { before, after: await db.journalEntry.count() });
  ok("  and the migration is marked undone", (await state.openMigration()) === null && (await state.latestMigration())?.status === "UNDONE");

  section("Again, then the month-end check");
  ok("a new one starts", (await actions.startMigrationAction({ source: "zoho-books", yearStart: "2026-04-01", switchDate: "2026-07-01" })).ok);
  m = (await state.openMigration())!;
  const again = await everything();
  ok("everything comes back", again.inv.progress?.created === 3 && again.cn.progress?.created === 1 && again.rc.progress?.created === 2 && again.bl.progress?.created === 2 && again.vc.progress?.created === 1 && again.vp.progress?.created === 2 && again.ex.progress?.created === 3 && again.jn.progress?.created === 2, again);
  const once = await bring("invoices", invoiceRows(false));
  ok("  the same invoices again bring nothing twice", once.progress?.created === 0 && once.outcomes.every((o) => o.kind === "skip"), once.outcomes);

  // The old system's books: Deskzo's own at each month end, June's bank ₹500 higher and sales ₹500 higher too.
  const tbRows: Record<string, string>[] = [];
  const byId = new Map((await db.ledgerAccount.findMany({ select: { id: true, code: true } })).map((a) => [a.id, a.code]));
  for (const month of ["2026-04", "2026-05", "2026-06"]) {
    const grouped = await db.journalLine.groupBy({ by: ["accountId"], where: { entry: { date: { lt: state.afterMonth(month) } } }, _sum: { debit: true, credit: true } });
    for (const g of grouped) {
      let net = Number(g._sum.debit ?? 0) - Number(g._sum.credit ?? 0);
      const code = byId.get(g.accountId)!;
      if (month === "2026-06" && code === accounts.get("BANK")!.code) net += 500;
      if (month === "2026-06" && code === accounts.get("SALES")!.code) net -= 500;
      if (Math.abs(net) < 0.005) continue;
      tbRows.push({ Month: `${["Apr", "May", "Jun"][Number(month.slice(5)) - 4]} 2026`, "Account Code": code, Debit: net > 0 ? net.toFixed(2) : "", Credit: net < 0 ? (-net).toFixed(2) : "" });
    }
  }
  const badMonth = await actions.uploadMigrationBalances(file([{ Month: "Sept 2025", "Account Code": "ZZ-CAP", Debit: "", Credit: "1" }], "bad.csv"));
  ok("a month outside the year keeps nothing, saying so", badMonth.ok && badMonth.data.failed.length === 1 && /isn't a month being brought across/.test(badMonth.data.failed[0]!.error));
  const badAccount = await actions.uploadMigrationBalances(file([...tbRows.slice(0, 2), { Month: "Apr 2026", "Account Code": "ZZ-NOPE", Debit: "1", Credit: "" }], "bad.csv"));
  ok("  an unknown account keeps nothing", badAccount.ok && badAccount.data.failed.some((f) => /ZZ-NOPE/.test(f.error)) && (await db.migrationBalance.count({ where: { migrationId: m.id } })) === 0);
  const aprilOnly = tbRows.filter((r) => r.Month === "Apr 2026").map(({ Month: _month, ...rest }) => (void _month, rest));
  const chosen = await actions.uploadMigrationBalances({ ...file(aprilOnly, "april.csv"), month: "2026-04" });
  ok("one month's file, the month chosen as it's uploaded", chosen.ok && chosen.data.months.join() === "2026-04", chosen);
  const all = await actions.uploadMigrationBalances(file(tbRows, "tb.csv"));
  ok("all three in one file with a Month column", all.ok && all.data.months.join() === "2026-04,2026-05,2026-06", all);
  let months = await balances.compareMonths(m);
  ok("April and May agree; June is off on two accounts by ₹500", months[0]!.agrees && months[1]!.agrees && !months[2]!.agrees && months[2]!.differences.length === 2 && months[2]!.differences.every((d) => Math.abs(d.difference) === 500), months[2]);

  section("Finish");
  ok("refused while June is off", !(await actions.finishMigrationAction()).ok);
  const adj = await actions.addMigrationAdjustment({ month: "2026-06", debitAccountId: accounts.get("BANK")!.id, creditAccountId: accounts.get("SALES")!.id, amount: "500", reason: "Bank charge reversed in the old system, not in the file" });
  ok("an adjustment covers it, with its reason", adj.ok, adj);
  months = await balances.compareMonths(m);
  ok("  every month agrees now", months.every((x) => x.agrees), months.map((x) => x.differences));
  ok("  and it's listed", (await balances.listAdjustments(m)).some((a) => /Bank charge/.test(a.reason)));
  const banner = await renderHtml(Layout({ children: "zz" }));
  ok("the accounting pages say the figures aren't final while it's open", banner.includes("Migration in progress"));
  ok("finishing without the right to close the books is refused", !(await actions.finishMigrationAction()).ok);
  actorId = boss.id;
  const finished = await actions.finishMigrationAction();
  ok("an admin finishes it: the books lock to 30 June", finished.ok && finished.data.lockedUntil === "2026-06-30", finished);
  const lock = await db.ledgerLock.findUnique({ where: { id: "global" } });
  ok("  the lock is there", lock?.lockedUntil?.toISOString().slice(0, 10) === "2026-06-30");
  ok("  its files are gone; it's finished", (await db.migrationFile.count()) === 0 && (await state.latestMigration())?.status === "FINISHED");
  ok("  nothing can be posted into the year now", /lock|closed/i.test(await db.$transaction((tx) => journal.writeEntry(tx, { date: new Date("2026-05-31T00:00:00Z"), narration: "zz", source: "MANUAL", userId: boss.id, lines: [{ accountId: capital.id, debit: 1, credit: 0 }, { accountId: accounts.get("BANK")!.id, debit: 0, credit: 1 }] })).then(() => "", (e: unknown) => String(e))));
  ok("  Undo is no longer offered", !(await actions.undoMigrationAction()).ok);
  ok("  and the banner is gone", !(await renderHtml(Layout({ children: "zz" }))).includes("Migration in progress"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
