/**
 * Our purchase order to the vendor, from the order (owner, 15 Oct 2026 — src/lib/orders/vendor-po.ts,
 * src/actions/order-vendor-po.ts, src/lib/documents/write-permission.ts).
 *
 *   · "Raise purchase orders": Purchase, Accounts and Management by default, not Sales; an admin can
 *     take it away. Every write on a purchase order asks it — and only on a purchase order.
 *   · "Create vendor PO" in the Purchasing box: once a vendor and price are saved and sales has nothing
 *     waiting; a draft to the vendor, the order's item at the purchase price, delivered to our address,
 *     its line pointing at the order. One live PO an order; invoicing never counts it.
 *   · Issuing it fills the order's "Our PO to vendor"; cancelling it empties it, and a new one may follow.
 *   · The buttons: a PO's own buttons follow the new permission; turning it into a bill doesn't.
 *
 * Everything is named ZZPROBE_VPO and removed in a finally.
 *
 *   npm run check:vendor-po
 */
import "dotenv/config";
import Module from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";
import { documentWriteKey } from "../src/lib/documents/write-permission";
import { PERMISSION_REGISTRY } from "../src/lib/permissions";

let actorId = "";
const roles = new Map<string, string>();
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    return { useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }), usePathname: () => "/orders", useSearchParams: () => new URLSearchParams() };
  }
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: roles.get(actorId) ?? "PURCHASE", name: "Zzprobe Vpo", email: `vpo${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_VPO";
const MAIL = "@zzprobe-vpo.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const userIds = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  const companyIds = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  const orderIds = (await db.companyProduct.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } })).map((o) => o.id);
  const docIds = (await db.tradeDocument.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } })).map((x) => x.id);
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { entityId: { in: [...orderIds, ...docIds] } }] } });
  await db.journalEntry.deleteMany({ where: { documentId: { in: docIds } } });
  await db.tradeDocument.deleteMany({ where: { id: { in: docIds } } });
  await db.companyProduct.deleteMany({ where: { id: { in: orderIds } } });
  await db.companyLocation.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.item.deleteMany({ where: { sku: { startsWith: TAG } } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  // Required, not imported: an import is hoisted above the session stub, and this one reaches the real session.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { vendorPoRefusal } = require("../src/lib/orders/vendor-po") as typeof import("../src/lib/orders/vendor-po");
  section("The rules, without a database");

  const ready = { orderStatus: "PROCESSING", purchaseRelease: "RELEASED", vendorId: "v", purchasePrice: 900, pendingPurchasePrice: null };
  ok("an order with a saved vendor and price can have its PO", vendorPoRefusal(ready) === null);
  ok("  not before the vendor and price are saved", vendorPoRefusal({ ...ready, vendorId: null })?.includes("Save the vendor") === true);
  ok("  nor while sales has a higher price to accept", vendorPoRefusal({ ...ready, pendingPurchasePrice: 1200 })?.includes("sales") === true);
  ok("  nor before it comes to purchase", vendorPoRefusal({ ...ready, purchaseRelease: "HELD" }) !== null);
  ok("  nor before accounts approve it, or once it's fulfilled", vendorPoRefusal({ ...ready, orderStatus: "PENDING_APPROVAL" }) !== null && vendorPoRefusal({ ...ready, orderStatus: "FULFILLED" }) !== null);
  ok("a purchase order's every write asks \"Raise purchase orders\"", documentWriteKey("PURCHASE_ORDER", "issue") === "purchase.raiseOrders" && documentWriteKey("PURCHASE_ORDER", "void") === "purchase.raiseOrders");
  ok("  every other type the sales-document pair, the vendor's bill included", documentWriteKey("BILL", "issue") === "documents.issue" && documentWriteKey("INVOICE", "void") === "documents.void" && documentWriteKey("PROPOSAL", "issue") === "documents.issue");
  const entry = PERMISSION_REGISTRY.find((p) => p.key === "purchase.raiseOrders");
  ok("held by default by Purchase, Accounts and Management — not Sales", !!entry && ["PURCHASE", "ACCOUNTS", "MANAGEMENT"].every((r) => (entry.defaultRoles as readonly string[]).includes(r)) && !(entry.defaultRoles as readonly string[]).includes("SALES"));

  /* eslint-disable @typescript-eslint/no-require-imports */
  const { can, explain } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
  const vpo = require("../src/lib/orders/vendor-po") as typeof import("../src/lib/orders/vendor-po");
  const { createVendorPoForOrder } = require("../src/actions/order-vendor-po") as typeof import("../src/actions/order-vendor-po");
  const documents = require("../src/actions/trade-document") as typeof import("../src/actions/trade-document");
  const { orderBilling } = require("../src/lib/orders/billing") as typeof import("../src/lib/orders/billing");
  const { branchIdentity } = require("../src/lib/branches/identity") as typeof import("../src/lib/branches/identity");

  await cleanup();
  try {
    const person = async (key: string, role: "PURCHASE" | "SALES" | "ACCOUNTS", branchId: string | null = null) => {
      const u = await db.user.create({ data: { name: `Zzprobe ${key}`, email: `${key}${MAIL}`, role, passwordHash: "x".repeat(60), branchId } });
      roles.set(u.id, role);
      return u;
    };
    // The purchaser buys for a branch with an address of its own, so "Ship to" has something to show.
    const buyingBranch = await db.branch.findFirst({ where: { active: true, addressLine1: { not: null } }, select: { id: true, addressLine1: true } });
    const purchaser = await person("purchaser", "PURCHASE", buyingBranch?.id ?? null);
    const seller = await person("seller", "SALES");
    const accounts = await person("accounts", "ACCOUNTS");
    // Purchase, with the new permission taken away from this one person.
    const barred = await person("barred", "PURCHASE");
    await db.userPermission.create({ data: { userId: barred.id, permission: "purchase.raiseOrders", allowed: false, reason: TAG } });

    const customer = await db.company.create({
      data: { name: `${TAG} Customer`, normalizedName: `${TAG} customer`.toLowerCase(), createdById: seller.id, ownerUserId: seller.id, relationshipType: "CLIENT", stage: "CUSTOMER" },
    });
    const site = await db.companyLocation.create({
      data: { companyId: customer.id, label: "Head Office", isPrimary: true, address: "1 MG Road", city: "Bengaluru", state: "Karnataka", pincode: "560001", country: "India" },
    });
    const vendor = await db.company.create({
      data: { name: `${TAG} Distributor`, normalizedName: `${TAG} distributor`.toLowerCase(), createdById: purchaser.id, ownerUserId: purchaser.id, relationshipType: "DISTRIBUTOR", stage: "CUSTOMER" },
    });
    await db.companyLocation.create({
      data: { companyId: vendor.id, label: "Warehouse", address: "9 Ring Road", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" },
    });
    const vendorBilling = await db.companyLocation.create({
      data: { companyId: vendor.id, label: "Accounts", isBilling: true, address: "4 Park Lane", city: "Mumbai", state: "Maharashtra", pincode: "400001", country: "India" },
    });
    const ups = await db.item.create({ data: { name: `${TAG} UPS 3KVA`, sku: `${TAG}-1`, type: "GOOD", sellingPrice: 1200, taxRatePercent: 18, hsnCode: "85044090", unit: "Nos", createdById: seller.id } });
    const order = (o: { vendorId?: string | null; price?: number | null; status?: "APPROVED" | "PROCESSING"; release?: "RELEASED" | "HELD" }) =>
      db.companyProduct.create({
        data: {
          companyId: customer.id,
          locationId: site.id,
          itemId: ups.id,
          addedByUserId: seller.id,
          quantity: 3,
          unitPrice: 1200,
          orderStatus: o.status ?? "PROCESSING",
          purchaseRelease: o.release ?? "RELEASED",
          vendorId: o.vendorId === undefined ? vendor.id : o.vendorId,
          purchasePrice: o.price === undefined ? 900 : o.price,
        },
      });
    const good = await order({});
    const unsourced = await order({ vendorId: null, price: null, status: "APPROVED" });
    const held = await order({ release: "HELD", status: "APPROVED" });
    const waiting = await order({});
    await db.companyProduct.update({
      where: { id: waiting.id },
      data: { pendingPurchasePrice: 1100, pendingVendorId: vendor.id, priceIncreaseReason: "Distributor price went up", priceReviewRequestedAt: new Date(), priceReviewRequestedById: purchaser.id },
    });

    section("Who holds it");

    ok("a purchaser holds it, from their role — so it's a tick in Roles", (await can(purchaser.id, "purchase.raiseOrders")) && (await explain(purchaser.id, "purchase.raiseOrders")).via === "roleDefault");
    ok("  and so does accounts", await can(accounts.id, "purchase.raiseOrders"));
    ok("a salesperson doesn't, though they raise sales documents", !(await can(seller.id, "purchase.raiseOrders")) && (await can(seller.id, "documents.issue")));
    ok("taken away from one purchaser, they don't", !(await can(barred.id, "purchase.raiseOrders")) && (await can(barred.id, "orders.process")));

    section("Create vendor PO");

    actorId = seller.id;
    let made = await createVendorPoForOrder(good.id);
    ok("a salesperson can't — the Purchasing box is purchase's", !made.ok && made.error.includes("process orders"), made.ok ? "made one" : made.error);
    actorId = barred.id;
    made = await createVendorPoForOrder(good.id);
    ok("  nor a purchaser without \"Raise purchase orders\"", !made.ok && made.error.includes("raise purchase orders"), made.ok ? "made one" : made.error);

    actorId = purchaser.id;
    made = await createVendorPoForOrder(unsourced.id);
    ok("not before the vendor and price are saved", !made.ok && made.error.includes("Save the vendor"), made.ok ? "made one" : made.error);
    made = await createVendorPoForOrder(held.id);
    ok("  nor while sales holds the order", !made.ok, made.ok ? "made one" : made.error);
    made = await createVendorPoForOrder(waiting.id);
    ok("  nor while a higher price waits for sales", !made.ok && made.error.includes("sales"), made.ok ? "made one" : made.error);

    made = await createVendorPoForOrder(good.id);
    ok("a purchaser makes one from a sourced order", made.ok, made.ok ? made.data.docNumber : made.error);
    const poId = made.ok ? made.data.id : "";
    const po = await db.tradeDocument.findUnique({
      where: { id: poId },
      select: {
        docType: true,
        status: true,
        companyId: true,
        locationId: true,
        branchId: true,
        reference: true,
        createdById: true,
        shippingSameAsBilling: true,
        shippingLine1: true,
        shippingCity: true,
        billingLine1: true,
        docNumber: true,
        lines: { select: { companyProductId: true, itemId: true, quantity: true, unitPrice: true, taxRatePercent: true } },
      },
    });
    ok("  a draft purchase order to the vendor, at its billing address", po?.docType === "PURCHASE_ORDER" && po.status === "DRAFT" && po.companyId === vendor.id && po.locationId === vendorBilling.id && po.billingLine1 === "4 Park Lane");
    const line = po?.lines[0];
    ok("  one line: the order's item and quantity at the purchase price, pointing at the order", po?.lines.length === 1 && line?.companyProductId === good.id && line.itemId === ups.id && Number(line.quantity) === 3 && Number(line.unitPrice) === 900 && Number(line.taxRatePercent) === 18);
    const us = await branchIdentity(po?.branchId ?? null);
    ok("  raised from the branch the purchaser buys for", !buyingBranch || po?.branchId === buyingBranch.id, buyingBranch ? "" : "no branch has an address here — the head office's is used");
    ok(
      "  delivered to our own address, as Ship to",
      po?.shippingSameAsBilling === false && (po.shippingLine1 ?? "") === (us.addressLine1 ?? "") && (po.shippingCity ?? "") === (us.city ?? "") && (!buyingBranch || !!po.shippingLine1),
      `${po?.shippingLine1} / ${us.addressLine1}`,
    );
    ok("  saying which order it's for, raised by the purchaser", po?.reference?.startsWith("ORD-") === true && po.createdById === purchaser.id, po?.reference);
    ok("  the order's \"Our PO to vendor\" waits for it to be issued", (await db.companyProduct.findUnique({ where: { id: good.id }, select: { ourPoNumber: true } }))?.ourPoNumber === null);
    ok("  the order shows it as its PO", (await vpo.livePurchaseOrders([good.id])).get(good.id)?.id === poId);
    const billing = (await orderBilling([good.id])).get(good.id);
    ok("  and invoicing doesn't count it — a PO bills nothing", billing?.status === "NOT_INVOICED" && billing.drafts.length === 0 && billing.invoices.length === 0);
    made = await createVendorPoForOrder(good.id);
    ok("a second press is refused, naming the PO it has", !made.ok && !!po && made.error.includes(po.docNumber), made.ok ? "made another" : made.error);

    section("Writing a purchase order asks the new permission");

    actorId = seller.id;
    let result: { ok: boolean; error?: string } = await documents.createTradeDocument({ docType: "PURCHASE_ORDER" });
    ok("a salesperson can't raise a PO from the form", !result.ok && result.error?.includes("raise purchase orders") === true, result.error);
    result = await documents.issueTradeDocument({ id: poId, generateEInvoice: false });
    ok("  nor issue one", !result.ok && result.error?.includes("raise purchase orders") === true, result.error);
    result = await documents.updateTradeDocument({ id: poId, docType: "INVOICE" });
    ok("  nor edit one — not even by calling it something else", !result.ok && result.error?.includes("raise purchase orders") === true, result.error);
    result = await documents.deleteTradeDocument(poId);
    ok("  nor delete the draft", !result.ok && result.error?.includes("raise purchase orders") === true, result.error);

    actorId = purchaser.id;
    result = await documents.createTradeDocument({ docType: "PROPOSAL" });
    ok("a purchaser still can't raise a sales document", !result.ok && result.error?.includes("sales documents") === true, result.error);

    const issued = await documents.issueTradeDocument({ id: poId, generateEInvoice: false });
    ok("a purchaser issues the PO", issued.ok, issued.ok ? issued.data.docNumber : issued.error);
    const poNumber = issued.ok ? issued.data.docNumber : "";
    ok("  and its number fills the order's \"Our PO to vendor\"", (await db.companyProduct.findUnique({ where: { id: good.id }, select: { ourPoNumber: true } }))?.ourPoNumber === poNumber && !!poNumber);
    result = await documents.convertTradeDocument({ id: poId, target: "BILL" });
    ok("turning it into the vendor's bill still asks \"Raise and issue sales documents\"", !result.ok && result.error?.includes("sales documents") === true, result.error);

    result = await documents.setTradeDocumentStatus(poId, "CANCELLED", "The distributor is out of stock");
    ok("a purchaser cancels the PO", result.ok, result.error);
    ok("  and the order's PO number goes with it", (await db.companyProduct.findUnique({ where: { id: good.id }, select: { ourPoNumber: true } }))?.ourPoNumber === null);
    ok("  so the order has no PO", !(await vpo.livePurchaseOrders([good.id])).has(good.id));
    made = await createVendorPoForOrder(good.id);
    ok("  and a new one can be raised", made.ok, made.ok ? made.data.docNumber : made.error);
    if (made.ok) {
      result = await documents.deleteTradeDocument(made.data.id);
      ok("  a draft PO a purchaser deletes", result.ok, result.error);
    }

    // A number typed by hand isn't touched by a PO that never held it.
    await db.companyProduct.update({ where: { id: good.id }, data: { ourPoNumber: "TYPED/1" } });
    await vpo.syncOrdersWithPurchaseOrder(poId);
    ok("a cancelled PO leaves a number someone typed alone", (await db.companyProduct.findUnique({ where: { id: good.id }, select: { ourPoNumber: true } }))?.ourPoNumber === "TYPED/1");

    section("The buttons");

    const { DocumentActions } = await import("../src/components/documents/document-actions");
    const bar = (canConvert: boolean) =>
      renderToStaticMarkup(
        createElement(DocumentActions, {
          id: poId,
          docType: "PURCHASE_ORDER" as const,
          status: "ISSUED" as const,
          einvoiceStatus: "NOT_APPLICABLE" as const,
          hasIrn: false,
          einvoiceEnabled: false,
          canCancelIrn: false,
          canIssue: true,
          canVoid: true,
          canConvert,
        }),
      );
    ok("a PO doesn't offer its bill to somebody who can't raise one", !/Convert to vendor bill/i.test(bar(false)));
    ok("  and does to somebody who can", /Convert to vendor bill/i.test(bar(true)));

    const { OrderActionsPanel } = await import("../src/components/orders/order-actions-panel");
    const panel = (vendorPo: import("../src/components/orders/order-actions-panel").OrderVendorPo | null, saved = true) =>
      renderToStaticMarkup(
        createElement(OrderActionsPanel, {
          order: {
            id: good.id,
            orderSeq: 1,
            quantity: 3,
            unitPrice: 1200,
            item: { name: "UPS", sellingPrice: 1200, taxRatePercent: 18 },
            allocations: [],
            orderStatus: "PROCESSING" as const,
            vendorId: saved ? vendor.id : null,
            purchasePrice: saved ? 900 : null,
            ourPoNumber: null,
            addedByUserId: seller.id,
          } as never,
          purchase: { purchaseRelease: "RELEASED", releaseOn: null, priceCeiling: null, quotePrice: null, pendingIncrease: false, paid: 0, vendorName: vendor.name },
          currentUserId: purchaser.id,
          canApprove: false,
          canProcess: true,
          canRecordPayments: false,
          canDeletePayments: false,
          vendorOptions: [{ id: vendor.id, name: vendor.name, paymentTerms: "NET_30" as const }],
          companyId: customer.id,
          companyName: customer.name,
          vendorPo,
        }),
      );
    // The attribute, not the class: every button's class names `disabled:` styles.
    const disabledPo = /<button[^>]*\sdisabled=""[^>]*>Create vendor PO/;
    const offered = panel({ canRaise: true, canOpen: true, live: null });
    ok("the Purchasing box offers \"Create vendor PO\"", /Create vendor PO/.test(offered) && !disabledPo.test(offered));
    ok("  pressable only once the vendor and price are saved", disabledPo.test(panel({ canRaise: true, canOpen: true, live: null }, false)));
    ok("  not to somebody without the permission", !/Create vendor PO/.test(panel({ canRaise: false, canOpen: true, live: null })));
    ok("  nor where the plan has no purchase orders", !/Create vendor PO/.test(panel(null)));
    const withPo = panel({ canRaise: true, canOpen: true, live: { id: poId, docNumber: "PO/ZZ/1", status: "DRAFT" } });
    ok("once it has one, the box links to it instead", !/Create vendor PO/.test(withPo) && withPo.includes(`/documents/${poId}`) && withPo.includes("PO/ZZ/1") && /check it and issue it/.test(withPo));
  } finally {
    await cleanup();
  }

  console.log(failures === 0 ? "\nAll vendor PO checks passed." : `\n${failures} vendor PO check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
