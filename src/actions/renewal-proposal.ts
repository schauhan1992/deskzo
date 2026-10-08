"use server";

import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { viaCompanyScope } from "@/lib/authz/company-scope";
import { renewalGroup } from "@/lib/subscriptions/proration";
import { renewalOrderDraft } from "@/lib/subscriptions/renewal-order";
import { partyDetails } from "@/lib/proposals/party";
import { workspaceClock } from "@/lib/time/workspace";
import { formatOrderId } from "@/lib/order-id";
import { createTradeDocument } from "@/actions/trade-document";
import type { ActionResult } from "@/actions/company";

/**
 * The renewal quote, as a document, in one click.
 *
 * The renewals list already knows everything a renewal quote needs — the customer, the site, the
 * product, the seats including any added mid-term, the full-term price and the term that follows.
 * Until now the only way to get that in front of a customer was to retype it into the document form,
 * which is precisely where a twenty-seat renewal gets quoted for ten.
 *
 * ## The two numbers this exists to get right
 *
 * Both come from `renewalOrderDraft`, the same function the renewal order itself uses, so the quote
 * and the order cannot disagree:
 *
 *   · **The price** is `fullTermUnitPrice`, never `unitPrice`. On a subscription with seats added
 *     mid-term, `unitPrice` on those rows is a pro-rated figure — what eight months of a year cost —
 *     and quoting at it under-bills by the part of the year that had already gone.
 *   · **The quantity** covers the parent and everything co-terminating with it. Ten seats plus five
 *     added in November is a twenty-seat renewal.
 *
 * Nothing is accepted from the browser but the id. A quote is a number a customer is shown and may
 * hold us to, so it is worked out here or not at all.
 */
export async function createProposalFromRenewal(input: {
  companyProductId: string;
}): Promise<ActionResult<{ id: string; docNumber: string | null; total: number }>> {
  const user = await requireModuleUser("renewals");
  // Asked before anything is read, as the add-on proposal does: the figures come off an order, and
  // what is made is a sales document.
  if (!(await can(user.id, "orders.view"))) return { ok: false, error: "That subscription no longer exists." };
  if (!(await can(user.id, "documents.issue"))) return { ok: false, error: "You don't have permission to raise or issue sales documents." };

  const product = await db.companyProduct.findFirst({
    /**
     * Scoped as well as filtered by id. The id is posted from the browser, and what this writes is a
     * customer-facing document carrying their name, their address and what they pay.
     */
    where: { id: input.companyProductId, ...(await viaCompanyScope(user.id)) },
    select: {
      id: true,
      orderSeq: true,
      quantity: true,
      unitPrice: true,
      fullTermUnitPrice: true,
      startDate: true,
      endDate: true,
      orderStatus: true,
      parentId: true,
      locationId: true,
      item: { select: { id: true, name: true, unit: true, taxRatePercent: true, hsnCode: true, billingCycle: true } },
      company: { select: { id: true, name: true } },
      renewedBy: { select: { orderSeq: true } },
      addons: {
        where: { orderStatus: { not: "CANCELLED" } },
        select: { id: true, quantity: true, unitPrice: true, fullTermUnitPrice: true, startDate: true },
      },
    },
  });
  if (!product) return { ok: false, error: "That subscription no longer exists." };

  /**
   * An addon is not renewed on its own.
   *
   * It co-terminates with its parent and comes back as part of that renewal — quoting it separately
   * would put the same seats on two documents.
   */
  if (product.parentId) {
    return {
      ok: false,
      error: "That's an addon. It renews as part of the subscription it was added to, so quote that instead.",
    };
  }
  if (product.orderStatus === "CANCELLED") return { ok: false, error: "That subscription was cancelled." };
  if (product.renewedBy) {
    return {
      ok: false,
      error: `Already renewed by ${formatOrderId(product.renewedBy.orderSeq)}. Quoting again would bill the same term twice.`,
    };
  }

  const group = renewalGroup([
    {
      id: product.id,
      quantity: product.quantity,
      unitPrice: product.unitPrice ? Number(product.unitPrice) : null,
      fullTermUnitPrice: product.fullTermUnitPrice ? Number(product.fullTermUnitPrice) : null,
      startDate: product.startDate,
      isAddon: false,
    },
    ...product.addons.map((a) => ({
      id: a.id,
      quantity: a.quantity,
      unitPrice: a.unitPrice ? Number(a.unitPrice) : null,
      fullTermUnitPrice: a.fullTermUnitPrice ? Number(a.fullTermUnitPrice) : null,
      startDate: a.startDate,
      isAddon: true,
    })),
  ]);

  const draft = renewalOrderDraft({
    quantity: product.quantity,
    unitPrice: product.unitPrice ? Number(product.unitPrice) : null,
    fullTermUnitPrice: product.fullTermUnitPrice ? Number(product.fullTermUnitPrice) : null,
    endDate: product.endDate,
    billingCycle: product.item.billingCycle,
    group,
  });

  if (!draft.term) {
    return { ok: false, error: "That subscription has no expiry date, so there is no next term to quote." };
  }
  if (!draft.unitPrice || draft.unitPrice <= 0) {
    return {
      ok: false,
      error: "There's no full-term price on that subscription to quote from. Set it on the order first.",
    };
  }

  const site = await db.companyLocation.findUnique({
    where: { id: product.locationId },
    select: { id: true, address: true, city: true, state: true, pincode: true, country: true, gstNumber: true, gstTreatment: true },
  });
  const party = partyDetails(site, product.company.name);
  if (!party.ok) return party;

  /**
   * The warnings the renewal dialog shows, carried onto the document's notes.
   *
   * `renewalOrderDraft` raises these for exactly the cases somebody should see before committing —
   * an addon with no full-term price of its own, a group it could not total. They belong on a
   * customer-facing draft too, where they are the reason to read it before issuing.
   */
  const warnings = draft.warnings.length > 0 ? `\n\nBefore issuing: ${draft.warnings.join(" ")}` : "";
  const seats = group.addonCount > 0 ? ` (${product.quantity} + ${draft.quantity - product.quantity} added mid-term)` : "";

  const result = await createTradeDocument({
    docType: "PROPOSAL",
    companyId: product.company.id,
    locationId: party.data.locationId,
    docNumber: "",
    placeOfSupplyCode: party.data.placeOfSupplyCode,
    gstTreatment: party.data.gstTreatment,
    buyerGstin: party.data.gstin,
    reverseCharge: false,
    currency: "INR",
    exchangeRate: 1,
    // Today on the workspace's calendar — toISOString() is UTC's, which before 05:30 in India is yesterday.
    issueDate: (await workspaceClock()).today(),
    dueDate: "",
    /**
     * A renewal quote is only good until the thing it renews has lapsed. The end date is a calendar
     * day held as midnight UTC, so its UTC date is the day.
     */
    validUntil: product.endDate!.toISOString().slice(0, 10),
    reference: formatOrderId(product.orderSeq),
    salespersonId: "",
    notes:
      `Renewal of ${formatOrderId(product.orderSeq)} — ${draft.quantity} × ${product.item.name}${seats}, ` +
      `expiring ${product.endDate!.toISOString().slice(0, 10)}. ` +
      `New term ${draft.term.startDate} to ${draft.term.endDate}, starting the day after the current one ends.` +
      warnings,
    terms: "",
    dispatchFromAddress: "",
    billing: party.data.address,
    shippingSameAsBilling: true,
    shipping: party.data.address,
    shippingGstin: "",
    shippingCharge: 0,
    shippingTaxRatePercent: 0,
    withholdingMode: "NONE",
    withholdingSection: "",
    withholdingRatePercent: 0,
    adjustmentLabel: "",
    adjustment: 0,
    sourceDocumentId: "",
    leadId: "",
    againstDocumentId: "",
    lines: [
      {
        itemId: product.item.id,
        /**
         * Pointed at the subscription being renewed.
         *
         * This is the link the renewals list reads to know a renewal has been quoted, and it is the
         * only thing that keeps the Stage column honest — without it, "Quoted" could only be guessed
         * at by matching company and item, which is wrong the moment a customer holds two of the
         * same product. It also survives conversion to a proforma or invoice, so the stage stays
         * right as the deal moves on.
         */
        companyProductId: product.id,
        name: product.item.name,
        description: `Renewal — ${draft.term.startDate} to ${draft.term.endDate}${seats}`,
        /**
         * The new term, as the line's service period — the same dates the description states. Set
         * here rather than left to the order default: `companyProductId` points at the subscription
         * being renewed, whose own term is the one ending.
         */
        servicePeriodFrom: draft.term.startDate,
        servicePeriodTo: draft.term.endDate,
        hsnCode: product.item.hsnCode ?? "",
        unit: product.item.unit ?? "",
        quantity: draft.quantity,
        unitPrice: draft.unitPrice,
        discountMode: "PERCENT",
        discountValue: 0,
        taxRatePercent: Number(product.item.taxRatePercent ?? 0),
      },
    ],
  }, "RENEWAL");

  if (!result.ok) return result;

  const created = await db.tradeDocument.findUnique({
    where: { id: result.data.id },
    select: { docNumber: true, total: true },
  });

  return {
    ok: true,
    data: { id: result.data.id, docNumber: created?.docNumber ?? null, total: Number(created?.total ?? 0) },
  };
}
