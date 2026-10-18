/**
 * Moving from Zoho CRM, Zoho Books and other systems (owner, 18 Oct 2026 — src/lib/portability/importers/leads.ts,
 * src/lib/portability/documents.ts, src/actions/document-import.ts). What check:import can't reach:
 *
 *   · Stages by name, then by the usual words: Closed Won, Proposal/Price Quote, Negotiation/Review,
 *     Qualification, Junk Lead, Not Contacted… and sources by their words, the rest kept as Other.
 *   · A Zoho-headed leads file is read as Deskzo's (Deal Name, Account Name, Deal Owner, Closing Date…), a
 *     person's first and last name joined, and the preview says what was read as what.
 *   · Open documents, one row a line: rows sharing a number are one document, built as the form builds it —
 *     linked to the catalogue, taxed from the party's location — with its own number, marked imported and
 *     issued as it was, posting nothing. A total that doesn't agree, an unknown party, a vendor on a sale,
 *     a customer on a PO and a line with no item are refused; the same file again changes nothing; a number
 *     another document holds is refused.
 *   · Only somebody who may raise the document and import finance data may import it.
 *
 * Everything is named ZZPROBE_CM / ZZCM- and removed in a finally.
 *
 *   npm run check:crm-migration
 */
import "dotenv/config";
import Module from "node:module";
import Papa from "papaparse";
import { directClient } from "../src/lib/tenancy/direct-client";

let actorId = "";
const roles = new Map<string, string>();
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => (actorId ? { id: actorId, role: roles.get(actorId) ?? "PROFILE", name: "Zzprobe Cm", email: `${actorId}${MAIL}` } : null);
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
const TAG = "ZZPROBE_CM";
const MAIL = "@zzprobe-cm.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
// Every row's columns, not the first's: Papa takes the header from the first row unless told.
const file = (rows: Record<string, string>[], name = "zoho-export.csv") => ({
  filename: name,
  base64: Buffer.from(Papa.unparse({ fields: [...new Set(rows.flatMap((r) => Object.keys(r)))], data: rows })).toString("base64"),
});

async function cleanup() {
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  const docs = (await db.tradeDocument.findMany({ where: { docNumber: { startsWith: "ZZCM-" } }, select: { id: true } })).map((d) => d.id);
  const payments = companies.length ? (await db.payment.findMany({ where: { companyId: { in: companies } }, select: { id: true } })).map((p) => p.id) : [];
  // The entries the imports and payments wrote: reversals before what they reverse.
  const entries = { OR: [{ documentId: { in: docs } }, { paymentId: { in: payments } }, { companyId: { in: companies } }] };
  await db.journalEntry.deleteMany({ where: { reversesId: { not: null }, ...entries } });
  await db.journalEntry.deleteMany({ where: entries });
  await db.payment.deleteMany({ where: { id: { in: payments } } });
  await db.tradeDocument.deleteMany({ where: { docNumber: { startsWith: "ZZCM-" }, docType: "CREDIT_NOTE" } });
  await db.tradeDocument.deleteMany({ where: { docNumber: { startsWith: "ZZCM-" } } });
  if (companies.length) {
    await db.lead.deleteMany({ where: { companyId: { in: companies } } });
    await db.contact.deleteMany({ where: { companyId: { in: companies } } });
    await db.companyLocation.deleteMany({ where: { companyId: { in: companies } } });
    await db.company.deleteMany({ where: { id: { in: companies } } });
  }
  await db.item.deleteMany({ where: { sku: { startsWith: "ZZCM-" } } });
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
  const { sourceOf, stageMeaning } = require("../src/lib/portability/importers/leads") as typeof import("../src/lib/portability/importers/leads");
  /* eslint-enable @typescript-eslint/no-require-imports */
  section("Stages and sources, by their words");

  const meant = (pairs: [string, string | null][]) => pairs.filter(([text, want]) => stageMeaning(text) !== want).map(([text, want]) => `${text} → ${stageMeaning(text)} (wanted ${want})`);
  const wrong = meant([
    ["Closed Won", "WON"],
    ["Closed Lost", "LOST"],
    ["Closed Lost to Competition", "LOST"],
    ["Proposal/Price Quote", "PROPOSAL_SENT"],
    ["Negotiation/Review", "NEGOTIATION"],
    ["Contract Sent", "NEGOTIATION"],
    ["Qualification", "QUALIFYING"],
    ["Needs Analysis", "QUALIFYING"],
    ["Id. Decision Makers", "QUALIFYING"],
    ["Qualified To Buy", "QUALIFIED"],
    ["Pre-Qualified", "QUALIFYING"],
    ["Not Qualified", "DISQUALIFIED"],
    ["Junk Lead", "DISQUALIFIED"],
    ["Lost Lead", "LOST"],
    ["Not Contacted", "NEW"],
    ["Attempted to Contact", "CONTACTED"],
    ["Contact in Future", "CONTACTED"],
    ["Prospecting", "NEW"],
    ["Banana", null],
  ]);
  ok("the usual stage words mean what they say", wrong.length === 0, wrong.join(" | "));
  ok("sources by name or word; the rest is Other, kept as the detail", sourceOf("WEBSITE").source === "WEBSITE" && sourceOf("Web Site").source === "WEBSITE" && sourceOf("Employee Referral").source === "REFERRAL" && sourceOf("Cold Call").source === "CALLING" && sourceOf("Trade Show").source === "EVENT" && sourceOf("Facebook Ads").source === "ADVERTISEMENT" && JSON.stringify(sourceOf("Mela stall")) === JSON.stringify({ source: "OTHER", detail: "Mela stall" }));

  /* eslint-disable @typescript-eslint/no-require-imports */
  const { plan } = require("../src/lib/portability/import") as typeof import("../src/lib/portability/import");
  const documents = require("../src/actions/document-import") as typeof import("../src/actions/document-import");
  const receivable = require("../src/actions/receivable") as typeof import("../src/actions/receivable");
  const tax = require("../src/actions/tax-reports") as typeof import("../src/actions/tax-reports");
  const trade = require("../src/actions/trade-document") as typeof import("../src/actions/trade-document");
  const tieout = require("../src/lib/close/tieout") as typeof import("../src/lib/close/tieout");
  /* eslint-enable @typescript-eslint/no-require-imports */

  await cleanup();
  try {
    const admin = await db.user.create({ data: { name: `${TAG} admin`, email: `admin${MAIL}`, role: "ADMIN", passwordHash: "x".repeat(60) } });
    roles.set(admin.id, "ADMIN");
    const seller = await db.user.create({ data: { name: `${TAG} seller`, email: `seller${MAIL}`, role: "PROFILE", passwordHash: "x".repeat(60) } });
    await db.userPermission.create({ data: { userId: seller.id, permission: "documents.issue", allowed: true, reason: TAG } });
    const company = (name: string, relationshipType: "CLIENT" | "VENDOR") =>
      db.company.create({ data: { name: `${TAG} ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), relationshipType, createdById: admin.id, ownerUserId: admin.id } });
    const customer = await company("Customer", "CLIENT");
    await db.companyLocation.create({ data: { companyId: customer.id, label: "Head office", address: "1 MG Road", city: "Bengaluru", state: "Karnataka", pincode: "560001", country: "India", gstNumber: "29ABCDE1234F1Z5", gstTreatment: "REGISTERED_REGULAR", isPrimary: true } });
    await company("Vendor", "VENDOR");
    const item = await db.item.create({ data: { name: `${TAG} Laptop`, sku: "ZZCM-LAP", type: "GOOD", sellingPrice: 50000, taxRatePercent: 18, createdById: admin.id } });

    section("A leads file as Zoho exports it");

    const zohoLeads = [
      { "Record Id": "zcrm_1", "Deal Name": `${TAG} Renewal`, "Account Name": `${TAG} Customer`, "First Name": "Ravi", "Last Name": "Kumar", Email: "ravi@zzprobe-cm.invalid", Stage: "Negotiation/Review", Amount: "1,20,000", "Closing Date": "31/12/2026", "Deal Owner": admin.name, "Lead Source": "Employee Referral", "Created Time": "2026-08-01" },
      { "Record Id": "zcrm_2", "Deal Name": `${TAG} Fresh start`, "Account Name": `${TAG} Newco`, Stage: "Qualification", Amount: "5000", "Deal Owner": "A Leaver" },
    ];
    const leadPlan = await plan("leads", (Papa.parse<Record<string, string>>(Papa.unparse(zohoLeads), { header: true, skipEmptyLines: true }).data), admin.id);
    const read = Object.fromEntries(leadPlan.readAs.map((r) => [r.from, r.to]));
    ok("Zoho's headings are read as Deskzo's, and said", read["Deal Name"] === "Title" && read["Account Name"] === "Company" && read["Deal Owner"] === "Owner" && read["Closing Date"] === "Expected close" && read["Record Id"] === "Old system ID" && read["Created Time"] === "Created on", JSON.stringify(leadPlan.readAs));
    ok("  First and Last Name aren't flagged, and nothing is unknown", leadPlan.unknownColumns.length === 0, leadPlan.unknownColumns.join());
    const first = Object.fromEntries(leadPlan.rows[0]!.changes.map((c) => [c.field, c.to]));
    ok("the first is negotiation, at the existing company, with Ravi Kumar as a new contact", leadPlan.rows[0]!.action === "create" && first.Stage === "Negotiation" && first.Company === `${TAG} Customer` && first.Contact === "Ravi Kumar (new contact)" && first.Source === "REFERRAL", JSON.stringify(first));
    const second = Object.fromEntries(leadPlan.rows[1]!.changes.map((c) => [c.field, c.to]));
    ok("the second creates its company, and its owner who left gives it to whoever imports", second.Company === `${TAG} Newco (new company)` && second.Owner === `${admin.name} (for A Leaver, not in Deskzo)` && second.Stage === "Qualifying" && leadPlan.notices.some((n) => n.text.startsWith("Owners who aren't Deskzo users")), JSON.stringify(second));

    section("Open documents: who may");

    const estimates: Record<string, string>[] = [
      { "Estimate Number": "ZZCM-EST-1", "Estimate Date": "05/10/2026", "Customer Name": `${TAG} Customer`, "Expiry Date": "04/11/2026", "Estimate Status": "Sent", "Item Name": "ZZCM-LAP", Quantity: "2", "Item Price": "50000", "Discount(%)": "", "Item Tax %": "", Total: "1,23,310" },
      { "Estimate Number": "ZZCM-EST-1", "Item Name": "Installation", Quantity: "1", "Item Price": "5000", "Discount(%)": "10", "Item Tax %": "18" },
      { "Estimate Number": "ZZCM-EST-2", "Estimate Date": "06/10/2026", "Customer Name": `${TAG} Customer`, "Item Name": "Support", Quantity: "1", "Item Price": "1000", "Item Tax %": "18", Total: "999" },
      { "Estimate Number": "ZZCM-EST-3", "Estimate Date": "06/10/2026", "Customer Name": "Nobody Ltd", "Item Name": "Support", Quantity: "1", "Item Price": "1000" },
      { "Estimate Number": "ZZCM-EST-4", "Estimate Date": "06/10/2026", "Customer Name": `${TAG} Vendor`, "Item Name": "Support", Quantity: "1", "Item Price": "1000" },
      { "Estimate Number": "ZZCM-EST-5", "Estimate Date": "06/10/2026", "Customer Name": `${TAG} Customer`, Quantity: "1", "Item Price": "1000" },
      { "Estimate Number": "ZZCM-EST-6", "Estimate Date": "07/10/2026", "Customer Name": `${TAG} Customer`, "Estimate Status": "Accepted", "Item Name": "Training", Quantity: "1", "Item Price": "2000", "Item Tax %": "18" },
    ];
    const proposals = file(estimates);
    actorId = seller.id;
    const refused = await documents.previewDocumentImport({ type: "PROPOSAL", ...proposals });
    ok("somebody who may raise proposals but not import finance data can't", !refused.ok && refused.error.includes("import finance data"));
    actorId = admin.id;
    const notYet = await documents.previewDocumentImport({ type: "DELIVERY_CHALLAN", ...proposals });
    ok("delivery challans aren't importable", !notYet.ok && notYet.error.includes("can't be imported yet"));

    section("Open documents: the preview");

    const preview = await documents.previewDocumentImport({ type: "PROPOSAL", ...proposals });
    if (!preview.ok) throw new Error(preview.error);
    const row = (n: string) => preview.data.rows.find((r) => r.label.startsWith(n) || r.key === n);
    ok("rows sharing a number are one document; the export's headings are read", preview.data.totalRows === 6 && preview.data.readAs.some((r) => r.from === "Estimate Number" && r.to === "Number"), `${preview.data.totalRows} documents`);
    const one = Object.fromEntries((row("ZZCM-EST-1")?.changes ?? []).map((c) => [c.field, c.to]));
    ok("two lines, taxed as the form taxes them, agreeing with the file's total", row("ZZCM-EST-1")?.action === "create" && one.Lines === "2" && one.Total === "₹1,23,310" && one["Valid until"] === "2026-11-04", JSON.stringify(one));
    ok("a total that doesn't agree is refused, with both figures", row("ZZCM-EST-2")?.action === "error" && /₹1,180.*₹999/.test(row("ZZCM-EST-2")?.error ?? ""), row("ZZCM-EST-2")?.error);
    ok("an unknown party is refused: import Companies first", row("ZZCM-EST-3")?.action === "error" && (row("ZZCM-EST-3")?.error ?? "").includes("Import Companies first"));
    ok("a vendor on a proposal is refused", row("ZZCM-EST-4")?.action === "error" && (row("ZZCM-EST-4")?.error ?? "").includes("is a vendor"));
    ok("a line with no item is refused", row("ZZCM-EST-5")?.action === "error" && (row("ZZCM-EST-5")?.error ?? "").includes("Item is required"));
    ok("an accepted one says so", Object.fromEntries((row("ZZCM-EST-6")?.changes ?? []).map((c) => [c.field, c.to])).Status === "accepted");

    section("Open documents: importing");

    const done = await documents.commitDocumentImport({ type: "PROPOSAL", ...proposals });
    ok("the good ones go in, the rest are named", done.ok && done.data.created === 2 && done.data.failed.length === 4, JSON.stringify(done.ok ? done.data : done));
    const doc = await db.tradeDocument.findUnique({ where: { docNumber: "ZZCM-EST-1" }, include: { lines: { orderBy: { sortOrder: "asc" } }, journalEntries: true } });
    ok("its own number, marked imported, issued as it was there", doc?.docType === "PROPOSAL" && doc.origin === "IMPORTED" && doc.status === "ISSUED" && doc.issueDate.toISOString().startsWith("2026-10-05") && !!doc.issuedAt);
    ok("  its total as the file's, its tax split from the party's location (Karnataka)", Number(doc?.total) === 123310 && Number(doc?.cgstAmount) + Number(doc?.sgstAmount) + Number(doc?.igstAmount) === 18810 && doc?.buyerGstin === "29ABCDE1234F1Z5", `${doc?.total} ${doc?.cgstAmount}/${doc?.sgstAmount}/${doc?.igstAmount}`);
    ok("  the first line is the catalogue's laptop, at its tax rate", doc?.lines[0]?.itemId === item.id && Number(doc?.lines[0]?.taxRatePercent) === 18 && doc?.lines.length === 2);
    ok("  nothing posted, nothing sent to the e-invoice portal", doc?.journalEntries.length === 0 && doc?.einvoiceStatus === "NOT_APPLICABLE");
    ok("the accepted one is accepted", (await db.tradeDocument.findUnique({ where: { docNumber: "ZZCM-EST-6" }, select: { status: true } }))?.status === "ACCEPTED");
    const again = await documents.previewDocumentImport({ type: "PROPOSAL", ...proposals });
    ok("the same file again changes nothing", again.ok && again.data.creates === 0 && again.data.skips === 2, again.ok ? `${again.data.creates}/${again.data.skips}` : again.error);
    const clash = await documents.previewDocumentImport({ type: "PROFORMA", ...file([{ Number: "ZZCM-EST-1", Date: "2026-10-05", Party: `${TAG} Customer`, Item: "x", Rate: "1" }]) });
    ok("a number another document holds is refused", clash.ok && clash.data.rows[0]?.action === "error" && (clash.data.rows[0]?.error ?? "").includes("already used by another document"));

    const po = await documents.commitDocumentImport({
      type: "PURCHASE_ORDER",
      ...file([
        { "Purchase Order Number": "ZZCM-PO-1", "Purchase Order Date": "2026-10-01", "Vendor Name": `${TAG} Vendor`, "Item Name": "ZZCM-LAP", Quantity: "5", Rate: "42000", "Tax %": "18" },
        { "Purchase Order Number": "ZZCM-PO-2", "Purchase Order Date": "2026-10-01", "Vendor Name": `${TAG} Customer`, "Item Name": "x", Rate: "1" },
      ]),
    });
    const order = await db.tradeDocument.findUnique({ where: { docNumber: "ZZCM-PO-1" }, select: { docType: true, origin: true, status: true, total: true, direction: true } });
    ok("a vendor PO comes in to its vendor; a customer on a PO is refused", po.ok && po.data.created === 1 && order?.docType === "PURCHASE_ORDER" && order.direction === "PURCHASE" && order.origin === "IMPORTED" && Number(order.total) === 247800 && po.data.failed[0]?.error.includes("isn't a vendor") === true, JSON.stringify(po.ok ? po.data : po));
    const audits = await db.auditLog.count({ where: { userId: admin.id, entityType: "TradeDocument", entityLabel: { endsWith: "(imported)" } } });
    ok("each document is audited as imported", audits === 3, audits);

    section("Open invoices, bills and credit notes");

    // The day the books start: the first of this month, or the day after a lock past it.
    const lock = await db.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
    const firstOfMonth = `${new Date().toISOString().slice(0, 7)}-01`;
    const startDay = lock?.lockedUntil && lock.lockedUntil.toISOString().slice(0, 10) >= firstOfMonth ? new Date(lock.lockedUntil.getTime() + 86_400_000).toISOString().slice(0, 10) : firstOfMonth;
    const before = (days: number) => new Date(new Date(`${startDay}T00:00:00Z`).getTime() - days * 86_400_000).toISOString().slice(0, 10);
    const after = new Date(new Date(`${startDay}T00:00:00Z`).getTime() + 5 * 86_400_000).toISOString().slice(0, 10);
    const invoiceDay = before(20);
    const valueBefore = (await trade.tradeDocumentSummary("INVOICE")).reduce((t, g) => t + g.total, 0);

    const invoiceFile = file([
      { "Invoice Number": "ZZCM-INV-1", "Invoice Date": invoiceDay, "Customer Name": `${TAG} Customer`, "Due Date": before(5), "Item Name": "Support", Quantity: "1", "Item Price": "100000", "Item Tax %": "18", Balance: "50,000", Total: "118000" },
      { "Invoice Number": "ZZCM-INV-2", "Invoice Date": invoiceDay, "Customer Name": `${TAG} Customer`, "Item Name": "Training", Quantity: "1", "Item Price": "10000", "Item Tax %": "18" },
      { "Invoice Number": "ZZCM-INV-3", "Invoice Date": after, "Customer Name": `${TAG} Customer`, "Item Name": "Later", Quantity: "1", "Item Price": "100", "Item Tax %": "18" },
      { "Invoice Number": "ZZCM-INV-4", "Invoice Date": invoiceDay, "Customer Name": `${TAG} Customer`, "Item Name": "Paid", Quantity: "1", "Item Price": "100", "Item Tax %": "18", Balance: "0" },
      { "Invoice Number": "ZZCM-INV-5", "Invoice Date": invoiceDay, "Customer Name": `${TAG} Customer`, "Item Name": "Too much", Quantity: "1", "Item Price": "100", "Item Tax %": "18", Balance: "999999" },
    ]);
    const noDay = await documents.previewDocumentImport({ type: "INVOICE", ...invoiceFile });
    ok("invoices need the day the books start", !noDay.ok && noDay.error.includes("day your books start"));
    const invPreview = await documents.previewDocumentImport({ type: "INVOICE", ...invoiceFile, openingDate: startDay });
    if (!invPreview.ok) throw new Error(invPreview.error);
    const inv = (n: string) => invPreview.data.rows.find((r) => r.key === n || r.label.startsWith(n));
    const invFirst = Object.fromEntries((inv("ZZCM-INV-1")?.changes ?? []).map((c) => [c.field, c.to]));
    ok("the balance due and what was paid before Deskzo", invFirst["Balance due"] === "₹50,000" && invFirst["Paid before Deskzo"] === "₹68,000", JSON.stringify(invFirst));
    ok("  a blank balance is all of it", Object.fromEntries((inv("ZZCM-INV-2")?.changes ?? []).map((c) => [c.field, c.to]))["Balance due"] === "₹11,800");
    ok("  and the preview says where the balances go", invPreview.data.notices.some((n) => n.text.includes(`on ${startDay}, against Opening Balance Equity`)));
    ok("one dated after the books start is refused", inv("ZZCM-INV-3")?.action === "error" && (inv("ZZCM-INV-3")?.error ?? "").includes("dated after"));
    ok("one settled in the old system is refused", inv("ZZCM-INV-4")?.action === "error" && (inv("ZZCM-INV-4")?.error ?? "").includes("stays there"));
    ok("a balance over the total is refused", inv("ZZCM-INV-5")?.action === "error" && (inv("ZZCM-INV-5")?.error ?? "").includes("more than its total"));

    const invDone = await documents.commitDocumentImport({ type: "INVOICE", ...invoiceFile, openingDate: startDay });
    ok("the open ones go in", invDone.ok && invDone.data.created === 2 && invDone.data.failed.length === 3, JSON.stringify(invDone.ok ? invDone.data : invDone));
    const invOne = await db.tradeDocument.findUniqueOrThrow({ where: { docNumber: "ZZCM-INV-1" }, select: { id: true, origin: true, status: true, paidBefore: true, einvoiceStatus: true, total: true } });
    ok("part-paid, with what was paid before kept on it, and no e-invoice", invOne.origin === "IMPORTED" && invOne.status === "PARTIALLY_PAID" && Number(invOne.paidBefore) === 68000 && invOne.einvoiceStatus === "NOT_APPLICABLE");
    const accounts = new Map((await db.ledgerAccount.findMany({ where: { systemKey: { in: ["AR", "AP", "OPENING_BALANCE_EQUITY"] } }, select: { id: true, systemKey: true } })).map((a) => [a.id, a.systemKey]));
    const entriesOf = (documentId: string) =>
      db.journalEntry.findMany({ where: { documentId }, orderBy: { createdAt: "asc" }, select: { source: true, date: true, reversesId: true, lines: { select: { accountId: true, debit: true, credit: true, companyId: true } } } });
    const opening = await entriesOf(invOne.id);
    const ar = opening[0]?.lines.find((l) => accounts.get(l.accountId) === "AR");
    const obe = opening[0]?.lines.find((l) => accounts.get(l.accountId) === "OPENING_BALANCE_EQUITY");
    ok("its balance is posted on the start day: receivable against Opening Balance Equity, as its own entry", opening.length === 1 && opening[0]!.source === "INVOICE" && opening[0]!.date.toISOString().startsWith(startDay) && Number(ar?.debit) === 50000 && ar?.companyId === customer.id && Number(obe?.credit) === 50000 && opening[0]!.lines.length === 2, JSON.stringify(opening));
    const settlement = await receivable.getInvoiceSettlement(invOne.id);
    ok("its settlement: ₹50,000 due, ₹68,000 of it paid before Deskzo", settlement?.balance === 50000 && settlement.paidBefore === 68000 && settlement.paid === 68000, JSON.stringify(settlement && { balance: settlement.balance, paid: settlement.paid, paidBefore: settlement.paidBefore }));
    const gstr = await tax.gstr1({ month: Number(invoiceDay.slice(5, 7)), year: Number(invoiceDay.slice(0, 4)) });
    ok("it isn't in that month's GSTR-1 — it was reported from the old system", !!gstr && !JSON.stringify(gstr).includes("ZZCM-INV-1"));
    const valueAfter = (await trade.tradeDocumentSummary("INVOICE")).reduce((t, g) => t + g.total, 0);
    ok("  nor in the invoices list's issued value", Math.abs(valueAfter - valueBefore) < 0.01, `${valueBefore} → ${valueAfter}`);
    const septTie = await tieout.loadTieOut("AR", new Date(`${before(40)}T12:00:00Z`));
    ok("the close's tie-out leaves it out before the books start", !septTie.documents.some((d) => d.docNumber.startsWith("ZZCM-")));
    const paid = await receivable.recordInvoicePayment({ invoiceId: invOne.id, amount: "50000", paidOn: startDay, method: "BANK_TRANSFER" });
    ok("the customer pays the rest in Deskzo, and it's paid", paid.ok && (await db.tradeDocument.findUniqueOrThrow({ where: { id: invOne.id }, select: { status: true } })).status === "PAID", paid.ok ? "" : paid.error);
    const tie = await tieout.loadTieOut("AR", new Date(`${startDay}T12:00:00Z`));
    const tied = (n: string) => tie.documents.find((d) => d.docNumber === n);
    ok("from the start day the tie-out reads what came across, posted as it was", tied("ZZCM-INV-2")?.total === 11800 && tied("ZZCM-INV-2")?.posted === 11800 && tied("ZZCM-INV-1")?.total === 50000 && tied("ZZCM-INV-1")?.posted === 50000, JSON.stringify([tied("ZZCM-INV-1"), tied("ZZCM-INV-2")]));

    const billDone = await documents.commitDocumentImport({
      type: "BILL",
      openingDate: startDay,
      ...file([{ "Bill Number": "ZZCM-BILL-1", "Bill Date": invoiceDay, "Vendor Name": `${TAG} Vendor`, "Item Name": "Parts", Quantity: "1", Rate: "5000", "Tax %": "18" }]),
    });
    const bill = await db.tradeDocument.findUniqueOrThrow({ where: { docNumber: "ZZCM-BILL-1" }, select: { id: true, status: true } });
    const billEntry = (await entriesOf(bill.id))[0];
    const ap = billEntry?.lines.find((l) => accounts.get(l.accountId) === "AP");
    ok("a bill posts what we owe: payable against Opening Balance Equity", billDone.ok && bill.status === "ISSUED" && billEntry?.source === "BILL" && Number(ap?.credit) === 5900 && billEntry.lines.some((l) => accounts.get(l.accountId) === "OPENING_BALANCE_EQUITY" && Number(l.debit) === 5900));

    const creditFile = file([
      { "Credit Note Number": "ZZCM-CN-1", "Credit Note Date": invoiceDay, "Customer Name": `${TAG} Customer`, "Invoice Number": "ZZCM-INV-2", "Item Name": "Discount", Quantity: "1", Rate: "1000", "Tax %": "18", Balance: "1000" },
      { "Credit Note Number": "ZZCM-CN-2", "Credit Note Date": invoiceDay, "Customer Name": `${TAG} Customer`, "Invoice Number": "NOPE-1", "Item Name": "Discount", Quantity: "1", Rate: "1000", "Tax %": "18" },
    ]);
    const cnDone = await documents.commitDocumentImport({ type: "CREDIT_NOTE", ...creditFile, openingDate: startDay });
    const cn = await db.tradeDocument.findUnique({ where: { docNumber: "ZZCM-CN-1" }, select: { id: true, paidBefore: true } });
    const cnEntry = cn ? (await entriesOf(cn.id))[0] : null;
    ok("a credit note against an imported invoice: its credit left posted off the receivable", cnDone.ok && cnDone.data.created === 1 && Number(cn?.paidBefore) === 180 && cnEntry?.lines.some((l) => accounts.get(l.accountId) === "AR" && Number(l.credit) === 1000) === true, JSON.stringify(cnDone.ok ? cnDone.data : cnDone));
    ok("  against an invoice that isn't in Deskzo, refused", cnDone.ok && cnDone.data.failed.some((f) => f.error.includes("isn't in Deskzo")));
    const credits = await receivable.listAvailableCredits(customer.id);
    ok("  and ₹1,000 of it is there to use", credits.find((c) => c.docNumber === "ZZCM-CN-1")?.remaining === 1000, JSON.stringify(credits));

    const two = await db.tradeDocument.findUniqueOrThrow({ where: { docNumber: "ZZCM-INV-2" }, select: { id: true } });
    const cancelled = await trade.setTradeDocumentStatus(two.id, "CANCELLED", "Brought across in error");
    // A reversal names the entry it reverses, not the document.
    const twoOpening = await db.journalEntry.findFirst({ where: { documentId: two.id }, select: { id: true, reversedBy: { select: { id: true, lines: { select: { debit: true, credit: true } } } } } });
    ok("cancelling an imported invoice reverses its opening entry", cancelled.ok && !!twoOpening?.reversedBy && twoOpening.reversedBy.lines.some((l) => Number(l.credit) === 11800), cancelled.ok ? JSON.stringify(twoOpening) : cancelled.error);
    const againInv = await documents.previewDocumentImport({ type: "INVOICE", ...invoiceFile, openingDate: startDay });
    ok("the same file again brings in nothing new", againInv.ok && againInv.data.creates === 0 && againInv.data.skips === 2);

    section("Zoho's own headings on the other imports");

    const asRows = (rows: Record<string, string>[]) => Papa.parse<Record<string, string>>(Papa.unparse(rows), { header: true, skipEmptyLines: true }).data;
    const companies = await plan("companies", asRows([{ "Account Name": `${TAG} Zoho Co`, "Account Owner": admin.name, "Website URL": "https://zoho-co.test", Industry: "Retail", "Ticker Symbol": "ZZ" }]), admin.id);
    ok("a Zoho CRM Accounts file: Account Name as the name, Account Owner as the manager", companies.creates === 1 && companies.readAs.some((r) => r.from === "Account Name" && r.to === "Name") && companies.readAs.some((r) => r.from === "Account Owner" && r.to === "Account manager") && companies.unknownColumns.includes("Ticker Symbol"), JSON.stringify(companies.readAs));
    const contacts = await plan("contacts", asRows([{ "First Name": "Asha", "Last Name": "Rao", "Account Name": `${TAG} Customer`, Email: "asha@zzprobe-cm.invalid", Mobile: "9876500000" }]), admin.id);
    ok("a Zoho CRM Contacts file: first and last name joined, Account Name as the company", contacts.creates === 1 && contacts.rows[0]?.label.startsWith("Asha Rao") === true && contacts.unknownColumns.includes("Mobile"), JSON.stringify({ label: contacts.rows[0]?.label, unknown: contacts.unknownColumns, err: contacts.rows[0]?.error }));
    // Zoho's products carry no type, and a new item needs one: the file gains a Type column.
    const items = await plan("items", asRows([{ "Product Name": `${TAG} Router`, "Product Code": "ZZCM-ZR1", "Unit Price": "4500", "Usage Unit": "Nos", Type: "GOOD" }]), admin.id);
    ok("a Zoho CRM Products file (with a Type added): Product Code as the SKU, Unit Price as the price", items.creates === 1 && items.readAs.some((r) => r.from === "Product Code" && r.to === "SKU"), JSON.stringify({ readAs: items.readAs, row: items.rows[0] }));
    let clashed = "";
    await plan("companies", asRows([{ "Account Name": "A", "Company Name": "B" }]), admin.id).catch((e: Error) => (clashed = e.message));
    ok("two headings for one column refuse the file", clashed.includes("would both be read as Name"), clashed);
  } finally {
    await cleanup();
  }

  console.log(failures === 0 ? "\nAll CRM migration checks passed." : `\n${failures} CRM migration check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
