/**
 * Orders and the tax invoices that bill them (owner, 15 Oct 2026 — src/lib/orders/billing*.ts,
 * src/lib/orders/invoice-draft.ts, src/actions/order-billing.ts).
 *
 *   · An order's status from the issued invoices that bill it: not invoiced, part invoiced, invoiced —
 *     drafts and cancelled invoices bill nothing, instalment orders are billed by their schedule.
 *   · The "to invoice" filter, and grouping by the customer's PO.
 *   · One draft invoice for several orders on a PO, or one per order, each line billing what is left.
 *   · The warnings before billing an order again, or for more than is left.
 *   · Linking an order punched later to the issued invoice that billed it, and unlinking it.
 *   · Nobody without "Raise and issue sales documents" raises an invoice from an order.
 *
 * Everything is named ZZPROBE_OB and removed in a finally.
 *
 *   npm run check:order-billing
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";
import { billingStatusOf, invoiceTogetherRefusal, overBillingWarning } from "../src/lib/orders/billing-rules";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    return { useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }), usePathname: () => "/orders", useSearchParams: () => new URLSearchParams() };
  }
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "SALES", name: "Zzprobe Billing", email: `billing${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_OB";
const MAIL = "@zzprobe-ob.invalid";
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
  await db.recurringBilling.deleteMany({ where: { companyProductId: { in: orderIds } } });
  await db.tradeDocument.deleteMany({ where: { id: { in: docIds } } });
  await db.companyProduct.deleteMany({ where: { id: { in: orderIds } } });
  await db.companyLocation.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.item.deleteMany({ where: { sku: { startsWith: TAG } } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  section("The rules, without a database");

  ok("nothing billed is not invoiced", billingStatusOf(10, 0, false) === "NOT_INVOICED");
  ok("some of it is part invoiced", billingStatusOf(10, 4, false) === "PART_INVOICED");
  ok("all of it, or more, is invoiced", billingStatusOf(10, 10, false) === "INVOICED" && billingStatusOf(10, 12, false) === "INVOICED");
  ok("an instalment order is billed by its schedule, whatever the count", billingStatusOf(10, 30, true) === "INSTALMENTS");
  const full = { status: "INVOICED" as const, ordered: 10, invoiced: 10, remaining: 0, invoices: [{ docNumber: "INV/1" }] };
  ok("billing an invoiced order again warns, naming the invoice", overBillingWarning(full, 1)?.includes("INV/1") === true);
  const part = { status: "PART_INVOICED" as const, ordered: 10, invoiced: 4, remaining: 6, invoices: [{ docNumber: "INV/1" }] };
  ok("  billing more than is left warns", overBillingWarning(part, 7)?.includes("Only 6 of 10") === true);
  ok("  billing what is left doesn't", overBillingWarning(part, 6) === null);
  ok("  an order already on another draft warns", overBillingWarning({ ...part, drafts: [{ docNumber: "DRAFT-9" }] }, 6)?.includes("DRAFT-9") === true);
  ok("  an instalment order never warns", overBillingWarning({ ...full, status: "INSTALMENTS" }, 10) === null);
  ok("orders for two customers can't share an invoice", invoiceTogetherRefusal([{ companyId: "a", locationId: "x" }, { companyId: "b", locationId: "x" }]) !== null);
  ok("  nor for two sites of one customer", invoiceTogetherRefusal([{ companyId: "a", locationId: "x" }, { companyId: "a", locationId: "y" }]) !== null);
  ok("  one customer at one site can", invoiceTogetherRefusal([{ companyId: "a", locationId: "x" }, { companyId: "a", locationId: "x" }]) === null);

  /* eslint-disable @typescript-eslint/no-require-imports */
  const billing = require("../src/lib/orders/billing") as typeof import("../src/lib/orders/billing");
  const actions = require("../src/actions/order-billing") as typeof import("../src/actions/order-billing");
  const { invoiceStartFromOrders } = require("../src/lib/orders/invoice-draft") as typeof import("../src/lib/orders/invoice-draft");

  await cleanup();
  try {
    const issuer = await db.user.create({ data: { name: "Zzprobe Billing", email: `billing${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    for (const permission of ["documents.view", "documents.issue", "orders.view"]) {
      await db.userPermission.create({ data: { userId: issuer.id, permission, allowed: true, reason: TAG } });
    }
    const outsider = await db.user.create({ data: { name: "Zzprobe Outsider", email: `outsider${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    await db.userPermission.create({ data: { userId: outsider.id, permission: "documents.issue", allowed: false, reason: TAG } });
    const company = await db.company.create({
      data: { name: `${TAG} Customer`, normalizedName: `${TAG} customer`.toLowerCase(), createdById: issuer.id, ownerUserId: issuer.id, relationshipType: "CLIENT", stage: "CUSTOMER" },
    });
    const other = await db.company.create({
      data: { name: `${TAG} Other`, normalizedName: `${TAG} other`.toLowerCase(), createdById: issuer.id, ownerUserId: issuer.id, relationshipType: "CLIENT", stage: "CUSTOMER" },
    });
    const site = await db.companyLocation.create({
      data: { companyId: company.id, label: "Head Office", isPrimary: true, address: "1 MG Road", city: "Bengaluru", state: "Karnataka", pincode: "560001", country: "India" },
    });
    const branch = await db.companyLocation.create({
      data: { companyId: company.id, label: "Pune", address: "2 FC Road", city: "Pune", state: "Maharashtra", pincode: "411004", country: "India" },
    });
    const otherSite = await db.companyLocation.create({
      data: { companyId: other.id, label: "Head Office", isPrimary: true, address: "3 Park Street", city: "Kolkata", state: "West Bengal", pincode: "700016", country: "India" },
    });
    const licence = await db.item.create({ data: { name: `${TAG} Licence`, sku: `${TAG}-1`, type: "SERVICE", sellingPrice: 1000, taxRatePercent: 18, hsnCode: "997331", createdById: issuer.id } });
    const laptop = await db.item.create({ data: { name: `${TAG} Laptop`, sku: `${TAG}-2`, type: "GOOD", sellingPrice: 50000, taxRatePercent: 18, hsnCode: "84713010", createdById: issuer.id } });
    const order = (o: { itemId: string; quantity: number; price: number; po?: string | null; locationId?: string; companyId?: string; status?: "APPROVED" | "PENDING_APPROVAL" | "CANCELLED" }) =>
      db.companyProduct.create({
        data: {
          companyId: o.companyId ?? company.id,
          locationId: o.locationId ?? site.id,
          itemId: o.itemId,
          addedByUserId: issuer.id,
          quantity: o.quantity,
          unitPrice: o.price,
          poNumber: o.po === undefined ? "ZZPO-1" : o.po,
          orderStatus: o.status ?? "APPROVED",
        },
      });
    const a = await order({ itemId: licence.id, quantity: 10, price: 1000 });
    const b = await order({ itemId: laptop.id, quantity: 2, price: 50000 });
    const c = await order({ itemId: licence.id, quantity: 5, price: 900 });
    const elsewhere = await order({ itemId: licence.id, quantity: 1, price: 1000, locationId: branch.id });
    const waiting = await order({ itemId: licence.id, quantity: 1, price: 1000, po: null, status: "PENDING_APPROVAL" });
    const instalments = await order({ itemId: licence.id, quantity: 3, price: 1000, po: null });
    await db.recurringBilling.create({ data: { companyProductId: instalments.id, mode: "INSTALMENTS", cycle: "MONTHLY", setById: issuer.id } });
    const theirs = await order({ itemId: licence.id, quantity: 1, price: 1000, po: null, companyId: other.id, locationId: otherSite.id });
    actorId = issuer.id;

    section("Status and the to-invoice filter");

    let state = await billing.orderBilling([a.id, b.id, instalments.id]);
    ok("a new order is not invoiced", state.get(a.id)?.status === "NOT_INVOICED" && state.get(a.id)?.remaining === 10);
    ok("an instalment order is billed by its schedule", state.get(instalments.id)?.status === "INSTALMENTS");
    const toInvoiceIds = new Set(((await billing.toInvoiceWhere()).id as { in: string[] }).in);
    ok("sold orders not yet billed are to invoice", [a.id, b.id, c.id].every((id) => toInvoiceIds.has(id)));
    ok("  not one still awaiting approval", !toInvoiceIds.has(waiting.id));
    ok("  nor one billed in instalments", !toInvoiceIds.has(instalments.id));
    const groups = (await actions.listOrdersToInvoice({ search: TAG })).filter((g) => g.company.id === company.id);
    const po = groups.find((g) => g.po === "ZZPO-1");
    ok("the view groups a customer's orders by their PO", po?.orders.length === 4 && [a.id, b.id, c.id, elsewhere.id].every((id) => po.orders.some((o) => o.id === id)), JSON.stringify(groups.map((g) => [g.po, g.orders.length])));
    ok("  and knows when they span two sites", po?.oneSite === false);
    ok("  with what is left to bill, before GST", po?.orders.find((o) => o.id === b.id)?.amountToBill === 100000);

    section("Invoices from orders");

    const start = await invoiceStartFromOrders(issuer.id, [a.id, b.id, c.id], "2026-10-15");
    ok("the form starts from three orders on one PO", start.ok && start.lines.length === 3 && start.reference === "PO ZZPO-1");
    ok("  each line bills its order, at its price, for what is left", start.ok && start.lines.every((l) => [a.id, b.id, c.id].includes(l.companyProductId)) && start.lines.find((l) => l.companyProductId === c.id)?.unitPrice === 900);
    const twoSites = await invoiceStartFromOrders(issuer.id, [a.id, elsewhere.id], "2026-10-15");
    ok("orders at two sites don't start one invoice", !twoSites.ok);
    ok("  nor orders of two customers", !(await actions.createInvoicesForOrders([a.id, theirs.id], "ONE")).ok);

    const one = await actions.createInvoicesForOrders([a.id, b.id, c.id], "ONE");
    ok("one draft invoice for all three", one.ok && one.data.ids.length === 1, one.ok ? "" : one.error);
    const draftId = one.ok ? one.data.ids[0]! : "";
    const draft = await db.tradeDocument.findUnique({ where: { id: draftId }, select: { status: true, docType: true, lines: { select: { companyProductId: true, quantity: true } } } });
    ok("  a draft tax invoice, its lines linked to their orders", draft?.status === "DRAFT" && draft.docType === "INVOICE" && draft.lines.length === 3 && draft.lines.every((l) => !!l.companyProductId));
    state = await billing.orderBilling([a.id]);
    ok("a draft bills nothing yet", state.get(a.id)?.status === "NOT_INVOICED" && state.get(a.id)?.drafts.length === 1);
    ok("  but billing the order again warns that it's on a draft", overBillingWarning(state.get(a.id)!, 10)?.includes("draft") === true);

    // Issued — set directly: issuing posts to the books, which is the invoice suite's business, not this one's.
    await db.tradeDocument.update({ where: { id: draftId }, data: { status: "ISSUED" } });
    state = await billing.orderBilling([a.id, b.id, c.id]);
    ok("issued, all three are invoiced", [a.id, b.id, c.id].every((id) => state.get(id)?.status === "INVOICED"));
    ok("  and leave the to-invoice view", !new Set(((await billing.toInvoiceWhere()).id as { in: string[] }).in).has(a.id));
    ok("billing one again warns, naming the invoice", (overBillingWarning(state.get(b.id)!, 1) ?? "").length > 0);

    // Part of an order: 4 of 10 seats now.
    const partly = await order({ itemId: licence.id, quantity: 10, price: 1000, po: "ZZPO-2" });
    const firstPart = await actions.createInvoicesForOrders([partly.id], "EACH");
    if (firstPart.ok) {
      const lineId = (await db.tradeDocumentLine.findFirst({ where: { documentId: firstPart.data.ids[0]! }, select: { id: true } }))!.id;
      await db.tradeDocumentLine.update({ where: { id: lineId }, data: { quantity: 4 } });
      await db.tradeDocument.update({ where: { id: firstPart.data.ids[0]! }, data: { status: "ISSUED" } });
    }
    state = await billing.orderBilling([partly.id]);
    ok("4 of 10 invoiced is part invoiced, 6 to bill", state.get(partly.id)?.status === "PART_INVOICED" && state.get(partly.id)?.remaining === 6);
    const rest = await invoiceStartFromOrders(issuer.id, [partly.id], "2026-10-15");
    ok("  and the next invoice starts with the 6", rest.ok && rest.lines[0]?.quantity === 6);
    const cancelled = await db.tradeDocument.findFirst({ where: { id: firstPart.ok ? firstPart.data.ids[0] : "" } });
    if (cancelled) await db.tradeDocument.update({ where: { id: cancelled.id }, data: { status: "CANCELLED" } });
    ok("a cancelled invoice bills nothing", (await billing.orderBilling([partly.id])).get(partly.id)?.status === "NOT_INVOICED");

    const each = await actions.createInvoicesForOrders([elsewhere.id, partly.id], "EACH");
    ok("one per product: a draft for each order, even at different sites", each.ok && each.data.ids.length === 2);

    section("Linking an invoice raised before the order");

    const late = await order({ itemId: laptop.id, quantity: 1, price: 50000, po: null });
    // An invoice raised for the laptop before anyone punched the order: billing nothing, issued.
    const early = await actions.createInvoicesForOrders([late.id], "EACH");
    const earlyId = early.ok ? early.data.ids[0]! : "";
    await db.tradeDocumentLine.updateMany({ where: { documentId: earlyId }, data: { companyProductId: null } });
    await db.tradeDocument.update({ where: { id: earlyId }, data: { status: "ISSUED" } });
    const candidates = await actions.invoiceLinesToLink(late.id);
    const candidate = candidates.find((l) => l.documentId === earlyId);
    ok("the order is offered the customer's invoice lines that bill no order", !!candidate && candidate.sameProduct, JSON.stringify(candidates.map((x) => [x.docNumber, x.name])));
    const linked = candidate ? await actions.linkInvoiceLine(late.id, candidate.lineId) : null;
    ok("  linking it makes the order invoiced", linked?.ok === true && (await billing.orderBilling([late.id])).get(late.id)?.status === "INVOICED");
    const amounts = await db.tradeDocument.findUnique({ where: { id: earlyId }, select: { total: true, status: true } });
    ok("  without touching the invoice", amounts?.status === "ISSUED");
    ok("  a line already billing an order can't be taken by another", candidate ? !(await actions.linkInvoiceLine(partly.id, candidate.lineId)).ok : false);
    const unlinked = candidate ? await actions.unlinkInvoiceLine(late.id, candidate.lineId) : null;
    ok("unlinking it reopens the order", unlinked?.ok === true && (await billing.orderBilling([late.id])).get(late.id)?.status === "NOT_INVOICED");
    const theirsDraft = await actions.createInvoicesForOrders([theirs.id], "EACH");
    const theirsLine = theirsDraft.ok ? await db.tradeDocumentLine.findFirst({ where: { documentId: theirsDraft.data.ids[0]! }, select: { id: true } }) : null;
    ok("another customer's invoice can't be linked", theirsLine ? !(await actions.linkInvoiceLine(late.id, theirsLine.id)).ok : false);
    ok("  nor a draft", each.ok ? !(await actions.linkInvoiceLine(late.id, (await db.tradeDocumentLine.findFirst({ where: { documentId: each.data.ids[0]! } }))!.id)).ok : false);

    section("Drawn");

    {
      const { createElement } = require("react") as typeof import("react");
      const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
      const { OrderInvoicingCard } = require("../src/components/orders/order-invoicing") as typeof import("../src/components/orders/order-invoicing");
      const { OrdersToInvoice } = require("../src/components/orders/orders-to-invoice") as typeof import("../src/components/orders/orders-to-invoice");
      const partBilling = (await billing.orderBilling([partly.id])).get(partly.id)!;
      let card = "";
      let view = "";
      try {
        card = renderToStaticMarkup(
          createElement(OrderInvoicingCard, {
            order: { id: partly.id, orderSeq: partly.orderSeq, unit: "Seat" },
            billing: partBilling,
            showDocuments: true,
            canInvoice: true,
            closed: false,
            po: "ZZPO-1",
            siblings: [{ id: a.id, orderSeq: a.orderSeq, itemName: "Licence", status: "INVOICED", remaining: 0, ordered: 10 }],
          }),
        );
        view = renderToStaticMarkup(createElement(OrdersToInvoice, { groups: (await actions.listOrdersToInvoice({ search: TAG })).filter((g) => g.company.id === company.id), canInvoice: true }));
      } catch (err) {
        ok("the invoicing screens draw", false, err instanceof Error ? err.message : err);
      }
      ok("the order's card draws its status, quantities and the way to invoice it", card.includes("Invoicing") && card.includes("To bill") && card.includes(`orders=${partly.id}`) && card.includes("Link an invoice already raised"));
      ok("  and its PO's other orders", card.includes("Customer PO ZZPO-1"));
      ok("the to-invoice view draws a PO's orders with one invoice for all", view.includes("Customer PO") && view.includes("Invoice"));
    }

    section("Who may");

    actorId = outsider.id;
    ok("without \"Raise and issue sales documents\", no invoice from an order", !(await actions.createInvoicesForOrders([late.id], "EACH")).ok);
    ok("  and nothing to link", (await actions.invoiceLinesToLink(late.id)).length === 0);
  } finally {
    actorId = "";
    await cleanup();
  }

  console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll order billing checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
