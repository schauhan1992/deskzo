/**
 * check:write-scope — a permission says what somebody may do, never whose records they may do it to.
 *
 * Section 12 of docs/permission-redesign.md listed the writes that checked a permission and nothing
 * else: any holder of "Issue documents", "Record payments", "Approve orders"… could act on another
 * account's record by sending its id. An audit then found the same in receivables, vendor credits,
 * consignments and projects. This drives the real actions, as a rep, against records on a peer's
 * account the rep can't open, and proves each one answers as a missing record — and that the rep's own
 * records still work, so a refusal here is the scope and not something else.
 *
 * Two people, both on the SALES role, given by name every permission the actions ask for — and not
 * "See all companies", so each reaches only their own accounts (TEAM, with nobody reporting). Their
 * accounts, a vendor each, and on the peer's side one of everything. Ledger-posting writes are only
 * ever refused here, never carried out. Everything is named ZZPROBE_WS and removed in a finally.
 *
 *   npm run check:write-scope
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
    const user = () => ({ id: actorId, role: "SALES", name: "Zzprobe Rep", email: `rep${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_WS";
const MAIL = "@zzprobe-ws.invalid";
const BRANCH_CODE = "ZZPWS";
let failures = 0;
let skips = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

/** Runs an action; a module outside this workspace's plan is a skip, any other throw a failure. */
async function attempt<T>(label: string, run: () => Promise<T>): Promise<{ value: T } | null> {
  try {
    return { value: await run() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not part of this workspace's plan/.test(message)) {
      console.log(` skip  ${label} — ${message}`);
      skips += 1;
      return null;
    }
    ok(label, false, `threw: ${message}`);
    return null;
  }
}
type Result = { ok: boolean; error?: string };
/** An action that must answer as if the record were missing. */
async function refused(label: string, run: () => Promise<Result>, words: string) {
  const r = await attempt(label, run);
  if (r) ok(label, !r.value.ok && (r.value.error ?? "").includes(words), r.value.ok ? "it went through" : r.value.error);
}

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const companyIds = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  await db.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  await db.projectStakeholder.deleteMany({ where: { project: { companyId: { in: companyIds } } } });
  await db.project.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.consignment.deleteMany({ where: { consignmentNumber: { startsWith: TAG } } });
  await db.vendorCredit.deleteMany({ where: { vendorId: { in: companyIds } } });
  await db.paymentAllocation.deleteMany({ where: { payment: { companyId: { in: companyIds } } } });
  await db.payment.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.creditNoteApplication.deleteMany({ where: { invoice: { companyId: { in: companyIds } } } });
  await db.tradeDocument.deleteMany({ where: { companyId: { in: companyIds }, againstDocumentId: { not: null } } });
  await db.tradeDocument.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.companyProduct.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.contact.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.companyLocation.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.item.deleteMany({ where: { sku: { startsWith: TAG } } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.branch.deleteMany({ where: { code: BRANCH_CODE } });
}

const GRANTS = [
  "documents.view", "documents.issue", "documents.void", "payments.view", "payments.record", "payments.delete", "payments.manage",
  "orders.view", "orders.approve", "orders.process", "products.edit", "products.delete", "assets.manage", "rebates.view",
  "rebates.manage", "projects.view", "projects.manage", "contacts.view", "leads.view",
];

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const docs = require("../src/actions/trade-document") as typeof import("../src/actions/trade-document");
  const payments = require("../src/actions/payment") as typeof import("../src/actions/payment");
  const orders = require("../src/actions/order") as typeof import("../src/actions/order");
  const companies = require("../src/actions/company") as typeof import("../src/actions/company");
  const bank = require("../src/actions/bank") as typeof import("../src/actions/bank");
  const payables = require("../src/actions/payable") as typeof import("../src/actions/payable");
  const receivables = require("../src/actions/receivable") as typeof import("../src/actions/receivable");
  const credits = require("../src/actions/vendor-credit") as typeof import("../src/actions/vendor-credit");
  const consignments = require("../src/actions/consignment") as typeof import("../src/actions/consignment");
  const projects = require("../src/actions/project") as typeof import("../src/actions/project");
  const { mayAddTo } = require("../src/lib/authz/access") as typeof import("../src/lib/authz/access");
  /* eslint-enable @typescript-eslint/no-require-imports */

  await cleanup();
  try {
    section("The fixture");
    const branch = await db.branch.create({ data: { name: `${TAG} branch`, code: BRANCH_CODE } });
    const person = (key: string) =>
      db.user.create({ data: { name: `Zzprobe ${key}`, email: `${key.toLowerCase()}${MAIL}`, role: "SALES", passwordHash: "x".repeat(60), branchId: branch.id } });
    const rep = await person("Rep");
    const peer = await person("Peer");
    const boss = await person("Boss");
    for (const u of [rep, peer]) {
      for (const permission of GRANTS) await db.userPermission.create({ data: { userId: u.id, permission, allowed: true, reason: TAG } });
      for (const permission of ["companies.viewAll", "projects.viewAll"]) await db.userPermission.create({ data: { userId: u.id, permission, allowed: false, reason: TAG } });
    }
    // Somebody who reaches every account, for the controls a narrower rule would wrongly refuse.
    for (const permission of [...GRANTS, "companies.viewAll"]) await db.userPermission.create({ data: { userId: boss.id, permission, allowed: true, reason: TAG } });
    const account = (key: string, ownerUserId: string, relationshipType: "CLIENT" | "DISTRIBUTOR") =>
      db.company.create({ data: { name: `${TAG} ${key}`, normalizedName: `${TAG} ${key}`.toLowerCase(), createdById: ownerUserId, ownerUserId, relationshipType, stage: "CUSTOMER", vendorStatus: relationshipType === "CLIENT" ? null : "ACTIVE" } });
    const mine = await account("Mine", rep.id, "CLIENT");
    const theirs = await account("Theirs", peer.id, "CLIENT");
    const vendorMine = await account("VendorMine", rep.id, "DISTRIBUTOR");
    const vendorTheirs = await account("VendorTheirs", peer.id, "DISTRIBUTOR");
    const location = new Map<string, string>();
    for (const c of [mine, theirs, vendorMine, vendorTheirs]) location.set(c.id, (await db.companyLocation.create({ data: { companyId: c.id, label: "Head Office", isPrimary: true } })).id);
    const item = await db.item.create({ data: { name: `${TAG} Licence`, sku: `${TAG}-1`, type: "SUBSCRIPTION", sellingPrice: 100, createdById: rep.id } });

    let n = 0;
    const doc = (companyId: string, owner: string, docType: "PROPOSAL" | "INVOICE" | "CREDIT_NOTE" | "BILL", status: "DRAFT" | "ISSUED", extra: object = {}) =>
      db.tradeDocument.create({
        data: { docNumber: `${TAG}-${(n += 1)}`, docType, direction: docType === "BILL" ? "PURCHASE" : "SALES", status, companyId, salespersonId: owner, createdById: owner, branchId: branch.id, total: 1000, ...extra },
      });
    const myDraft = await doc(mine.id, rep.id, "PROPOSAL", "DRAFT");
    const theirDraft = await doc(theirs.id, peer.id, "PROPOSAL", "DRAFT");
    const theirInvoice = await doc(theirs.id, peer.id, "INVOICE", "ISSUED");
    const theirCreditNote = await doc(theirs.id, peer.id, "CREDIT_NOTE", "ISSUED", { againstDocumentId: theirInvoice.id });
    const myBill = await doc(vendorMine.id, rep.id, "BILL", "ISSUED");
    const theirBill = await doc(vendorTheirs.id, peer.id, "BILL", "ISSUED");
    const theirOrder = await db.companyProduct.create({
      data: { companyId: theirs.id, locationId: location.get(theirs.id)!, itemId: item.id, addedByUserId: peer.id, orderStatus: "PENDING_APPROVAL" },
    });
    const cheque = (companyId: string, owner: string) =>
      db.payment.create({ data: { companyId, amount: 100, paidOn: new Date(), method: "CHEQUE", recordedByUserId: owner, branchId: branch.id } });
    const myCheque = await cheque(mine.id, rep.id);
    const theirPayment = await cheque(theirs.id, peer.id);
    const theirAllocation = await db.paymentAllocation.create({ data: { paymentId: theirPayment.id, companyProductId: theirOrder.id, amount: 10, allocatedByUserId: peer.id } });
    const theirApplication = await db.creditNoteApplication.create({ data: { creditNoteId: theirCreditNote.id, invoiceId: theirInvoice.id, amount: 10, appliedByUserId: peer.id } });
    const theirContact = await db.contact.create({ data: { companyId: theirs.id, name: `${TAG} Their Contact` } });
    const theirConsignment = await db.consignment.create({ data: { consignmentNumber: `${TAG}-C1`, reason: "SALE_DELIVERY", toCompanyId: theirs.id, createdById: peer.id } });
    const internalConsignment = await db.consignment.create({ data: { consignmentNumber: `${TAG}-C2`, reason: "INTERNAL_TRANSFER", createdById: peer.id } });
    const theirCredit = await db.vendorCredit.create({
      data: { vendorId: vendorTheirs.id, form: "CREDIT_NOTE", reference: `${TAG}-VC`, date: new Date(), taxableAmount: 100, total: 118, createdById: peer.id },
    });
    const myProject = await db.project.create({ data: { code: `${TAG}-P1`, companyId: mine.id, name: `${TAG} project`, managerId: rep.id, createdById: rep.id } });
    actorId = rep.id;
    ok("a rep and a peer, each reaching only their own accounts", true);

    section("Adding to an account (the engine)");
    ok("a document for the rep's own customer: yes", await mayAddTo(rep.id, "documents", mine));
    ok("...for the peer's: no", !(await mayAddTo(rep.id, "documents", theirs)));
    ok("a payment against the peer's customer: no", !(await mayAddTo(rep.id, "payments", theirs)));
    ok("an order on the peer's customer: no", !(await mayAddTo(rep.id, "orders", theirs)));

    section("Sales and purchase documents");
    const ownDelete = await attempt("deleting the rep's own draft", () => docs.deleteTradeDocument(myDraft.id));
    if (ownDelete) ok("deleting the rep's own draft goes through — the control", ownDelete.value.ok, ownDelete.value.ok ? "" : ownDelete.value.error);
    await refused("deleting the peer's draft", () => docs.deleteTradeDocument(theirDraft.id), "no longer exists");
    ok("...which is still there", (await db.tradeDocument.count({ where: { id: theirDraft.id } })) === 1);
    await refused("issuing the peer's draft", () => docs.issueTradeDocument({ id: theirDraft.id, generateEInvoice: false }), "no longer exists");
    await refused("reporting the peer's invoice for an IRN", () => docs.generateEInvoice(theirInvoice.id), "no longer exists");
    await refused("converting the peer's proposal", () => docs.convertTradeDocument({ id: theirDraft.id, target: "PROFORMA" }), "no longer exists");
    await refused("cancelling the peer's invoice", () => docs.setTradeDocumentStatus(theirInvoice.id, "CANCELLED", "Raised against the wrong customer"), "no longer exists");
    ok("...which is still issued", (await db.tradeDocument.findUnique({ where: { id: theirInvoice.id }, select: { status: true } }))?.status === "ISSUED");

    section("Payments");
    await refused("recording a payment against the peer's customer", () => payments.recordPayment({ companyId: theirs.id, amount: 50, paidOn: "2026-10-01", method: "UPI" }), "Company not found");
    await refused("allocating the peer's payment", () => payments.allocatePayment({ paymentId: theirPayment.id, companyProductId: theirOrder.id, amount: 5 }), "Payment not found");
    await refused("taking an allocation off the peer's payment", () => payments.deleteAllocation(theirAllocation.id), "Allocation not found");
    await refused("deleting the peer's payment", () => payments.deletePayment(theirPayment.id), "Payment not found");
    await attempt("bulk-deleting the peer's payment", () => payments.bulkDeletePayments([theirPayment.id]));
    ok("...which is still there after both", (await db.payment.count({ where: { id: theirPayment.id } })) === 1);

    section("Orders and a customer's products");
    await refused("approving the peer's order", () => orders.approveOrder({ orderId: theirOrder.id, approved: true }), "Order not found");
    await refused("fulfilling the peer's order", () => orders.fulfillOrder(theirOrder.id), "Order not found");
    await refused("removing the peer's order", () => companies.removeCompanyProduct(theirOrder.id), "Product not found");
    await refused(
      "adding an order to the peer's customer",
      () => companies.addCompanyProduct({ companyId: theirs.id, locationId: location.get(theirs.id)!, itemId: item.id, vendorId: vendorTheirs.id, quantity: 1 }),
      "Company not found",
    );
    ok("...and the order is still awaiting approval", (await db.companyProduct.findUnique({ where: { id: theirOrder.id }, select: { orderStatus: true } }))?.orderStatus === "PENDING_APPROVAL");

    section("Vendors");
    const ownStatus = await attempt("the rep's own vendor's status", () => companies.setVendorStatus(vendorMine.id, "INACTIVE"));
    if (ownStatus) ok("changing the rep's own vendor's status goes through — the control", ownStatus.value.ok, ownStatus.value.ok ? "" : ownStatus.value.error);
    await refused("changing the peer's vendor's status", () => companies.setVendorStatus(vendorTheirs.id, "INACTIVE"), "Company not found");
    ok("...which is still active", (await db.company.findUnique({ where: { id: vendorTheirs.id }, select: { vendorStatus: true } }))?.vendorStatus === "ACTIVE");

    section("Banking");
    const cheques = await attempt("uncleared cheques", () => bank.unclearedCheques());
    if (cheques) {
      const ids = new Set(cheques.value.map((c: { id: string }) => c.id));
      ok("uncleared cheques list the rep's own", ids.has(myCheque.id));
      ok("...and not the peer's", !ids.has(theirPayment.id));
    }
    await refused("clearing the peer's cheque", () => bank.clearCheque({ paymentId: theirPayment.id, clearedOn: "2026-10-02" }), "no longer exists");

    section("Payables");
    const aging = await attempt("payables aging", () => payables.payablesAging());
    if (aging) {
      const vendors = new Set(aging.value.rows.map((r: { id: string }) => r.id));
      ok("the aging lists the rep's own vendor", vendors.has(vendorMine.id));
      ok("...and not the peer's", !vendors.has(vendorTheirs.id));
    }
    const statement = await attempt("the peer's vendor statement", () => payables.vendorStatement(vendorTheirs.id));
    if (statement) ok("the peer's vendor statement answers as missing", statement.value === null);
    const openBills = await attempt("the peer's open bills", () => payables.listOpenBills(vendorTheirs.id));
    if (openBills) ok("the peer's open bills are none", openBills.value.length === 0);
    const settlement = await attempt("the peer's bill settlement", () => payables.getBillSettlement(theirBill.id));
    if (settlement) ok("the peer's bill settlement answers as missing", settlement.value === null);
    const mySettlement = await attempt("the rep's own bill settlement", () => payables.getBillSettlement(myBill.id));
    if (mySettlement) ok("...the rep's own is there — the control", mySettlement.value !== null);
    await refused("paying the peer's bill", () => payables.recordBillPayment({ billId: theirBill.id, amount: "10", paidOn: "2026-10-01", method: "UPI" }), "no longer exists");

    section("Receivables");
    await refused("recording a payment on the peer's invoice", () => receivables.recordInvoicePayment({ invoiceId: theirInvoice.id, amount: 10, paidOn: "2026-10-01", method: "UPI" }), "no longer exists");
    await refused("applying the peer's payment to their invoice", () => receivables.applyPaymentToInvoice(theirPayment.id, theirInvoice.id, 5), "no longer exists");
    await refused("applying the peer's credit note", () => receivables.applyCreditNote({ creditNoteId: theirCreditNote.id, invoiceId: theirInvoice.id, amount: 5 }), "credit note");
    await refused("taking the peer's credit note off their invoice", () => receivables.removeCreditNoteApplication(theirApplication.id), "no longer exists");
    ok("...which is still applied", (await db.creditNoteApplication.count({ where: { id: theirApplication.id } })) === 1);

    section("Vendor credits");
    const listed = await attempt("vendor credits", () => credits.listVendorCredits());
    if (listed?.value) ok("the list leaves out the peer's vendor's credit", !listed.value.credits.some((c: { id: string }) => c.id === theirCredit.id));
    const read = await attempt("the peer's vendor credit", () => credits.getVendorCredit(theirCredit.id));
    if (read) ok("the peer's vendor credit answers as missing", read.value === null);
    const options = await attempt("the peer's vendor's credit options", () => credits.vendorCreditOptions(vendorTheirs.id));
    if (options) ok("the peer's vendor's credit options answer as missing", options.value === null);
    await refused("cancelling the peer's vendor credit", () => credits.cancelVendorCredit({ vendorCreditId: theirCredit.id, reason: "Recorded twice by mistake" }), "no longer exists");
    await refused("settling the peer's vendor credit", () => credits.settleVendorCredit({ vendorCreditId: theirCredit.id, allocations: [], applications: [{ billId: theirBill.id, amount: 5 }] }), "no longer exists");
    ok("...which is still standing", (await db.vendorCredit.findUnique({ where: { id: theirCredit.id }, select: { cancelledAt: true } }))?.cancelledAt === null);

    section("Consignments");
    const consignmentList = await attempt("consignments", () => consignments.listConsignments());
    if (consignmentList) {
      const ids = new Set(consignmentList.value.map((c: { id: string }) => c.id));
      ok("the list keeps a transfer between our own sites", ids.has(internalConsignment.id));
      ok("...and leaves out the one going to the peer's customer", !ids.has(theirConsignment.id));
    }
    const one = await attempt("the peer's consignment", () => consignments.getConsignment(theirConsignment.id));
    if (one) ok("the peer's consignment answers as missing", one.value === null);
    actorId = boss.id;
    const bossOne = await attempt("the peer's consignment, for somebody who reaches every account", () => consignments.getConsignment(theirConsignment.id));
    if (bossOne) ok("somebody who reaches every account opens it — the control", bossOne.value !== null);
    const bossList = await attempt("consignments, for somebody who reaches every account", () => consignments.listConsignments());
    if (bossList) ok("...and lists both", [theirConsignment.id, internalConsignment.id].every((id) => bossList.value.some((c: { id: string }) => c.id === id)));
    actorId = rep.id;
    await refused("cancelling the peer's consignment", () => consignments.cancelConsignment(theirConsignment.id, "Not needed"), "no longer exists");
    await refused("raising a challan on the peer's consignment", () => consignments.raiseDeliveryChallan(theirConsignment.id), "no longer exists");
    await refused("sending a consignment to the peer's customer", () => consignments.createConsignment({ reason: "SALE_DELIVERY", assetIds: ["none"], toCompanyId: theirs.id }), "no longer exists");
    await refused("naming the peer's contact on one to the rep's customer", () => consignments.createConsignment({ reason: "SALE_DELIVERY", assetIds: ["none"], toCompanyId: mine.id, toContactId: theirContact.id }), "doesn't belong");

    section("Projects");
    const formOptions = await attempt("project form options for the peer's customer", () => projects.projectFormOptions(theirs.id));
    if (formOptions) {
      ok("the peer's customer's contacts are not listed", formOptions.value.contacts.length === 0);
      ok("...nor the peer's customer in the picker", !formOptions.value.companies.some((c: { id: string }) => c.id === theirs.id));
      ok("...while the rep's own customer is", formOptions.value.companies.some((c: { id: string }) => c.id === mine.id));
    }
    await refused("a project for the peer's customer", () => projects.saveProject({ companyId: theirs.id, name: `${TAG} theirs` }), "no longer exists");
    await refused("moving the rep's project to the peer's customer", () => projects.saveProject({ id: myProject.id, companyId: theirs.id, name: myProject.name }), "no longer exists");
    await refused("the peer's contact as a stakeholder on the rep's project", () => projects.addStakeholder({ projectId: myProject.id, contactId: theirContact.id, role: "CUSTOMER_SPONSOR" }), "isn't one of this customer's");
  } finally {
    await cleanup();
    const left = (await db.user.count({ where: { email: { endsWith: MAIL } } })) + (await db.company.count({ where: { name: { startsWith: TAG } } }));
    ok("nothing of the fixture is left behind", left === 0, left);
    await db.$disconnect();
  }

  console.log(failures === 0 ? `\nAll write-scope checks passed${skips ? ` (${skips} skipped: module not in this workspace's plan)` : ""}.` : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
