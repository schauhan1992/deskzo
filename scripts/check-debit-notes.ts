/**
 * check:debit-notes — debit notes (owner, 23 Oct 2026): a sales document that adds to an issued invoice.
 *
 *   · Its own series (DN), raised against an invoice of the same customer — never without one.
 *   · Posted as the invoice was: Dr Receivables, Cr Sales and output tax, under its own source.
 *   · Owed like an invoice: paid, aged, chased, on the statement, in the dashboard's receivables, in the
 *     month-end tie-out, held against, forecast.
 *   · In the GST return with the notes (type D), adding rather than taking away; DBN to the IRP, with the
 *     invoice it refers to.
 *   · "Charge interest": a draft debit note for a late invoice's MSMED Act interest, GST at the invoice's
 *     rate, never charging the same interest twice.
 *
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:debit-notes
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

const DAY = 86_400_000;

async function main() {
  section("Without a database");
  const td = load("../src/lib/trade-documents") as typeof import("../src/lib/trade-documents");
  ok("a debit note is a sales document, numbered DN, raised from an invoice", td.tradeDocumentLabels.DEBIT_NOTE === "Debit note" && td.documentPrefixes.DEBIT_NOTE === "DN" && td.documentDirection.DEBIT_NOTE === "SALES" && !!td.conversionTargets.INVOICE?.includes("DEBIT_NOTE"));
  // Coolify migrates after the deploy: a database without the type must never be sent its name.
  const owed = td.docTypeIn(["INVOICE", "DEBIT_NOTE"]);
  ok("what's owed is asked as \"none of the others\" — the new type is never named to a database", "notIn" in owed && !owed.notIn.includes("DEBIT_NOTE") && !owed.notIn.includes("INVOICE") && owed.notIn.includes("PROPOSAL"), owed);
  ok("  a list without it is asked plainly", JSON.stringify(td.docTypeIn(["INVOICE", "CREDIT_NOTE"])) === JSON.stringify({ in: ["INVOICE", "CREDIT_NOTE"] }));
  const posting = load("../src/lib/ledger/posting") as typeof import("../src/lib/ledger/posting");
  const docs = posting.sourceIn(posting.DOCUMENT_SOURCES);
  ok("  and a document's postings the same way", "notIn" in docs && !docs.notIn.includes("DEBIT_NOTE") && docs.notIn.includes("PAYMENT") && !docs.notIn.includes("INVOICE"), docs);
  ok("  owed like an invoice; reported to the IRP", td.isReceivable("DEBIT_NOTE") && td.isReceivable("INVOICE") && !td.isReceivable("CREDIT_NOTE") && td.isEInvoiceEligible("DEBIT_NOTE"));
  const { buildEInvoicePayload } = load("../src/lib/einvoice/payload") as typeof import("../src/lib/einvoice/payload");
  const party = { gstin: "27AAAAA0000A1Z5", legalName: "Zz Buyer", address1: "1 MG Road", address2: null, city: "Pune", pincode: "411001", stateCode: "27", phone: null, email: null, label: "HO" };
  const payload = buildEInvoicePayload({
    docType: "DEBIT_NOTE",
    docNumber: "DN/2627/0001",
    issueDate: new Date("2026-10-23T00:00:00Z"),
    reverseCharge: false,
    placeOfSupplyCode: "27",
    seller: { ...party, gstin: "27BBBBB0000B1Z5", legalName: "Zz Seller" },
    buyer: party,
    againstDocNumber: "INV/2627/0042",
    againstDocDate: new Date("2026-08-01T00:00:00Z"),
    lines: [{ description: "Interest on delayed payment", isService: true, hsnCode: "998314", quantity: 1, unit: "OTH", unitPrice: 1000, discountAmount: 0, taxableValue: 1000, taxRatePercent: 18, cgstAmount: 90, sgstAmount: 90, igstAmount: 0, lineTotal: 1180 }],
    taxableValue: 1000,
    cgstAmount: 90,
    sgstAmount: 90,
    igstAmount: 0,
    total: 1180,
  } as never) as { DocDtls: { Typ: string }; RefDtls?: { PrecDocDtls: { InvNo: string }[] } };
  ok("the IRP is sent a DBN naming the invoice it adds to", payload.DocDtls.Typ === "DBN" && payload.RefDtls?.PrecDocDtls[0]?.InvNo === "INV/2627/0042", { typ: payload.DocDtls.Typ, ref: payload.RefDtls });
  const { buildGstr1 } = load("../src/lib/ledger/gst-returns") as typeof import("../src/lib/ledger/gst-returns");
  const doc = (docType: "INVOICE" | "DEBIT_NOTE" | "CREDIT_NOTE", n: string, gstin: string | null) => ({
    docNumber: n,
    docType,
    issueDate: new Date("2026-10-10T00:00:00Z"),
    status: "ISSUED",
    partyName: "Zz Buyer",
    partyGstin: gstin,
    placeOfSupplyCode: "27",
    taxableValue: 1000,
    cgstAmount: 90,
    sgstAmount: 90,
    igstAmount: 0,
    total: 1180,
    lines: [{ hsnCode: "998314", description: "x", quantity: 1, unit: "OTH", taxableValue: 1000, taxRatePercent: 18, cgstAmount: 90, sgstAmount: 90, igstAmount: 0 }],
  });
  const gstr1 = buildGstr1([doc("INVOICE", "INV-1", "27AAAAA0000A1Z5"), doc("DEBIT_NOTE", "DN-1", "27AAAAA0000A1Z5"), doc("DEBIT_NOTE", "DN-2", null)] as never);
  const dn = gstr1.b2b.find((b) => b.docNumber === "DN-1");
  ok("GSTR-1: a registered buyer's debit note listed as one, not as an invoice", dn?.isDebitNote === true && dn.isCreditNote === false, dn);
  const b2c = gstr1.b2c.find((r) => r.taxRatePercent === 18);
  ok("  an unregistered buyer's adds to the B2C totals", b2c?.taxableValue === 1000, b2c);

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${realName}_debitnotes`;
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
    const docs = require("../src/actions/trade-document") as typeof import("../src/actions/trade-document");
    const receivable = require("../src/actions/receivable") as typeof import("../src/actions/receivable");
    const collect = require("../src/actions/payment-collection") as typeof import("../src/actions/payment-collection");
    const { creditHoldFor } = require("../src/lib/collect/hold") as typeof import("../src/lib/collect/hold");
    const { collectionInsights } = require("../src/lib/collect/insights") as typeof import("../src/lib/collect/insights");
    const { receivablesOutstanding } = require("../src/lib/finance/dashboard") as typeof import("../src/lib/finance/dashboard");
    const { partyStatement } = require("../src/lib/receivables/statement") as typeof import("../src/lib/receivables/statement");
    const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
    /* eslint-enable @typescript-eslint/no-require-imports */

    const boss = await db.user.create({ data: { name: "Zz Boss", email: "boss@zz-dn.in", passwordHash: "!", role: "ADMIN", isSuperAdmin: true }, select: { id: true, name: true, email: true, role: true } });
    actor = { id: boss.id, name: boss.name, email: boss.email!, role: boss.role };
    const customer = await db.company.create({ data: { name: "Zz Late Buyer", normalizedName: "zz late buyer", relationshipType: "CLIENT", createdById: boss.id, ownerUserId: boss.id }, select: { id: true } });
    const site = await db.companyLocation.create({ data: { companyId: customer.id, label: "Head Office", address: "1 MG Road", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India", isBilling: true, isShipping: true }, select: { id: true } });
    const other = await db.company.create({ data: { name: "Zz Other Buyer", normalizedName: "zz other buyer", relationshipType: "CLIENT", createdById: boss.id, ownerUserId: boss.id }, select: { id: true } });
    const clock = await workspaceClock();
    const today = clock.calendarDate(new Date());
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    const input = (over: Record<string, unknown>) => ({
      docType: "INVOICE",
      companyId: customer.id,
      locationId: site.id,
      issueDate: ymd(today),
      gstTreatment: "UNREGISTERED",
      billing: { line1: "1 MG Road", city: "Pune", state: "Maharashtra", stateCode: "27", pincode: "411001", country: "India" },
      shippingSameAsBilling: true,
      shipping: {},
      lines: [{ name: "Zz Laptop", hsnCode: "8471", unit: "NOS", quantity: 1, unitPrice: 100000, taxRatePercent: 18 }],
      ...over,
    });

    section("Raised against an invoice");
    const inv = await docs.createTradeDocument(input({ issueDate: ymd(new Date(today.getTime() - 90 * DAY)), dueDate: ymd(new Date(today.getTime() - 60 * DAY)) }));
    ok("(an invoice for ₹1,18,000, 60 days overdue)", inv.ok, inv.ok ? "" : inv.error);
    if (!inv.ok) throw new Error("no invoice");
    const issuedInv = await docs.issueTradeDocument({ id: inv.data.id });
    ok("(issued)", issuedInv.ok, issuedInv.ok ? issuedInv.data.docNumber : issuedInv.error);
    const orphan = await docs.createTradeDocument(input({ docType: "DEBIT_NOTE" }));
    ok("a debit note without an invoice is refused", !orphan.ok && orphan.error.includes("invoice it adds to"), orphan.ok ? "MADE" : orphan.error);
    const otherInv = await docs.createTradeDocument(input({ companyId: other.id, locationId: undefined }));
    const crossed = otherInv.ok ? await docs.createTradeDocument(input({ docType: "DEBIT_NOTE", againstDocumentId: otherInv.data.id })) : { ok: false as const, error: "no other invoice" };
    ok("  nor one against another customer's invoice", !crossed.ok, crossed.ok ? "MADE" : crossed.error);
    const made = await docs.createTradeDocument(input({ docType: "DEBIT_NOTE", againstDocumentId: inv.data.id, lines: [{ name: "Price revised", hsnCode: "8471", unit: "NOS", quantity: 1, unitPrice: 5000, taxRatePercent: 18 }] }));
    ok("a debit note against the invoice: ₹5,000 + GST", made.ok, made.ok ? "" : made.error);
    if (!made.ok) throw new Error("no debit note");
    const issuedDn = await docs.issueTradeDocument({ id: made.data.id });
    ok("issued in its own series", issuedDn.ok && issuedDn.data.docNumber.includes("DN"), issuedDn.ok ? issuedDn.data.docNumber : issuedDn.error);
    const dnRow = await db.tradeDocument.findUniqueOrThrow({ where: { id: made.data.id }, select: { total: true, againstDocumentId: true, docType: true } });
    ok("  for ₹5,900, naming its invoice", Number(dnRow.total) === 5900 && dnRow.againstDocumentId === inv.data.id);

    section("In the books");
    const entry = await db.journalEntry.findFirst({ where: { documentId: made.data.id }, include: { lines: { include: { account: { select: { systemKey: true } } } } } });
    const line = (key: string) => entry?.lines.find((l) => l.account.systemKey === key);
    ok("posted as a debit note: Dr Receivables ₹5,900", entry?.source === "DEBIT_NOTE" && Number(line("AR")?.debit) === 5900, entry?.lines.map((l) => `${l.account.systemKey}:${Number(l.debit)}/${Number(l.credit)}`));
    ok("  Cr Sales ₹5,000 and the output tax", Number(line("SALES")?.credit) === 5000 && Number(line("OUTPUT_IGST")?.credit ?? 0) + Number(line("OUTPUT_CGST")?.credit ?? 0) + Number(line("OUTPUT_SGST")?.credit ?? 0) === 900);
    ok("  narrated as a debit note", !!entry?.narration.startsWith("Debit note"));

    section("Owed like an invoice");
    const aging = await receivable.agingReport();
    const row = aging.rows.find((r) => r.id === customer.id);
    ok("on the aged receivables, with its invoice", Math.abs((row?.total ?? 0) - 123900) < 0.01, row?.total);
    const statement = await partyStatement("AR", customer.id);
    ok("on the customer's statement, as a debit note", statement.lines.some((l) => l.description.startsWith("Debit note") && l.debit === 5900), statement.lines.map((l) => `${l.description}:${l.debit}`));
    const outstanding = await receivablesOutstanding();
    ok("in the dashboard's receivables", Math.abs(outstanding.total - 123900) < 0.01, outstanding);
    const paid = await receivable.recordInvoicePayment({ invoiceId: made.data.id, amount: 5900, paidOn: ymd(today), method: "UPI" });
    ok("paid like an invoice", paid.ok && (await db.tradeDocument.findUnique({ where: { id: made.data.id }, select: { status: true } }))?.status === "PAID", paid.ok ? "" : paid.error);
    const fresh = await docs.createTradeDocument(input({ docType: "DEBIT_NOTE", againstDocumentId: inv.data.id, issueDate: ymd(new Date(today.getTime() - 80 * DAY)), dueDate: ymd(new Date(today.getTime() - 70 * DAY)), lines: [{ name: "Short billed", hsnCode: "8471", unit: "NOS", quantity: 1, unitPrice: 1000, taxRatePercent: 18 }] }));
    if (fresh.ok) await docs.issueTradeDocument({ id: fresh.data.id });
    const hold = await creditHoldFor(customer.id);
    // The invoice is exactly 60 days late — not past the hold; the debit note, 70 days, is.
    ok("an unpaid one past the days puts the customer on credit hold by itself", hold?.invoices === 1 && hold.overdue === 1180 && hold.oldestDays === 70, hold);
    const insights = await collectionInsights({ companyId: customer.id }, today);
    ok("  and is overdue in the forecast", insights.overdueUnpromised.invoices === 2, insights.overdueUnpromised);

    section("Charge interest");
    const noMsme = await collect.chargeMsmeInterest(inv.data.id);
    ok("not before the MSME details are filled in", !noMsme.ok && noMsme.error.includes("Udyam"));
    await collect.saveMsmeDetails({ udyamNumber: "UDYAM-MH-26-0123456", category: "SMALL", bankRate: 5.75 });
    const charged = await collect.chargeMsmeInterest(inv.data.id);
    ok("a draft debit note for the interest so far", charged.ok, charged.ok ? "" : charged.error);
    if (charged.ok) {
      const note = await db.tradeDocument.findUniqueOrThrow({ where: { id: charged.data.id }, include: { lines: true } });
      const interestLine = note.lines[0]!;
      ok("  against the invoice, a draft — for somebody to check and issue", note.docType === "DEBIT_NOTE" && note.status === "DRAFT" && note.againstDocumentId === inv.data.id);
      ok("  GST at the invoice's rate, on the interest", Number(interestLine.taxRatePercent) === 18 && Number(interestLine.taxableValue) > 0 && interestLine.hsnCode === "8471", { taxable: Number(interestLine.taxableValue), rate: Number(interestLine.taxRatePercent) });
      ok("  saying what it's for", interestLine.name === "Interest on delayed payment" && !!note.notes?.includes("MSMED Act"));
      const twice = await collect.chargeMsmeInterest(inv.data.id);
      ok("charged again the same day: refused — it's already on the draft", !twice.ok && twice.error.includes("already"), twice.ok ? "MADE" : twice.error);
    }
  } finally {
    actor = null;
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} debit note checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
