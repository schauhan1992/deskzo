"use server";

import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { mayAccess } from "@/lib/authz/access";
import { proRata, proRataMonths, canAddTo } from "@/lib/subscriptions/proration";
import { partyDetails } from "@/lib/proposals/party";
import { workspaceClock } from "@/lib/time/workspace";
import { createTradeDocument } from "@/actions/trade-document";
import type { ActionResult } from "@/actions/company";

/**
 * Turns a part-term quote into a draft proposal.
 *
 * The calculator works out what five extra seats cost from November to August, and until now the
 * only thing anybody could do with that number was copy it into an email. This writes the same
 * figure into a real document — same customer, same subscription, same arithmetic — so the quote
 * that goes out is one the system knows about, can be found again, and can be converted onward to a
 * proforma or an invoice.
 *
 * ## The price is recomputed here, never accepted
 *
 * This takes the four inputs the calculator takes — which subscription, how many seats, from when,
 * and which basis is on screen — and works the quote out again server-side. It deliberately does
 * not accept a unit price from the browser. An action that believed a price posted to it would let
 * anyone who can reach it raise a proposal at any figure they liked, and a proposal is a number a
 * customer is shown and may hold us to.
 *
 * ## Why it stops at draft
 *
 * `createTradeDocument` writes every document as DRAFT, and issuing is a separate act behind
 * `documents.issue` — issuing assigns the number for good, and for an invoice files with the IRP.
 * A button on a calculator should produce something to read over and correct, not something already
 * sent.
 */
export async function createProposalFromAddonQuote(input: {
  parentId: string;
  quantity: number;
  startDate: string;
  /**
   * Which basis the salesperson is looking at.
   *
   * A display choice rather than a price, so it is safe to take from the browser — the figure is
   * still derived here from whichever basis this names. It has to be passed rather than assumed:
   * five months of a twelve-month term at ₹12,000 is ₹5,000 by the month and ₹4,931 by the day, and
   * a proposal carrying a different number from the one just read out on the phone is exactly the
   * drift this whole feature exists to stop.
   */
  basis?: "DAY" | "MONTH";
}): Promise<ActionResult<{ id: string; docNumber: string | null }>> {
  const user = await requireModuleUser("renewals");
  // Asked before anything is read: the price comes off an order, and what is made is a sales
  // document. Without "View orders" the subscription is as good as missing, as in `quoteAddon`.
  if (!(await can(user.id, "orders.view"))) return { ok: false, error: "That subscription no longer exists." };
  if (!(await can(user.id, "documents.issue"))) return { ok: false, error: "You don't have permission to raise or issue sales documents." };

  const parent = await db.companyProduct.findUnique({
    where: { id: input.parentId },
    select: {
      id: true,
      unitPrice: true,
      fullTermUnitPrice: true,
      startDate: true,
      endDate: true,
      orderStatus: true,
      parentId: true,
      locationId: true,
      item: { select: { id: true, name: true, type: true, unit: true, taxRatePercent: true, hsnCode: true } },
      company: { select: { id: true, name: true } },
    },
  });
  if (!parent) return { ok: false, error: "That subscription no longer exists." };
  // The same refusal for a record out of scope as for one that does not exist, matching `quoteAddon`
  // — a parent id must not be usable to find out which accounts are real. The access engine answers it.
  if (!(await mayAccess(user.id, "orders", "view", parent.id))) {
    return { ok: false, error: "That subscription no longer exists." };
  }

  const quantity = Math.trunc(Number(input.quantity));
  if (!Number.isFinite(quantity) || quantity < 1) return { ok: false, error: "Quantity must be at least one seat." };

  /**
   * The same refusals the calculator shows, applied again.
   *
   * The screen already hides the button when `canAddTo` objects, but the screen is not the gate:
   * this action is reachable directly, and a proposal for seats that cannot be sold is a quote the
   * business cannot honour.
   */
  const problems = canAddTo({
    parent: {
      startDate: parent.startDate,
      endDate: parent.endDate,
      orderStatus: parent.orderStatus,
      itemType: parent.item.type,
      parentId: parent.parentId,
    },
    addonStart: input.startDate,
    quantity,
  });
  if (problems.length > 0) return { ok: false, error: problems[0].message };

  // `canAddTo` returns early with a problem when either date is missing, so reaching here means both
  // are set — narrowed for the type checker rather than re-checked.
  if (!parent.startDate || !parent.endDate) {
    return { ok: false, error: "That subscription has no term on it, so there's nothing to pro-rate against." };
  }

  const annual = Number(parent.fullTermUnitPrice ?? parent.unitPrice ?? 0);
  if (!(annual > 0)) {
    return {
      ok: false,
      error: "There's no price on the original to pro-rate from. Set the full-term price on it first.",
    };
  }

  const byMonth = input.basis === "MONTH";
  const compute = byMonth ? proRataMonths : proRata;
  const quote = compute({
    fullTermUnitPrice: annual,
    quantity,
    addonStart: input.startDate,
    parentStart: parent.startDate,
    parentEnd: parent.endDate,
  });
  // Both bases report their count in `daysCharged`; on the month basis it is months.
  if (quote.daysCharged === 0) {
    return { ok: false, error: "There are no days left on that subscription. Renew it instead." };
  }

  /**
   * Where the customer is, taken from the order rather than typed.
   *
   * The subscription's own site, not the account's primary one — `CompanyProduct.locationId` is
   * required, so every order already records which site it was sold to. It matters: a customer with
   * offices in two states has a place of supply per order, and billing the head office's state for
   * seats delivered to the branch changes which tax applies — CGST/SGST against IGST.
   */
  const location = await db.companyLocation.findUnique({
    where: { id: parent.locationId },
    select: { id: true, address: true, city: true, state: true, pincode: true, country: true, gstNumber: true, gstTreatment: true },
  });

  // Shared with the renewal proposal button: two buttons deriving the place of supply slightly
  // differently produce two documents the accounts team cannot reconcile.
  const party = partyDetails(location, parent.company.name);
  if (!party.ok) return party;

  // Today on the workspace's calendar. The parent's end date is a calendar day held as midnight UTC,
  // so its UTC date is the day.
  const today = (await workspaceClock()).today();
  const expiry = parent.endDate.toISOString().slice(0, 10);
  const unitWord = byMonth ? "months" : "days";
  const address = party.data.address;

  const result = await createTradeDocument({
    docType: "PROPOSAL",
    companyId: parent.company.id,
    locationId: party.data.locationId,
    docNumber: "",
    placeOfSupplyCode: party.data.placeOfSupplyCode,
    gstTreatment: party.data.gstTreatment,
    buyerGstin: party.data.gstin,
    reverseCharge: false,
    currency: "INR",
    exchangeRate: 1,
    issueDate: today,
    dueDate: "",
    /** A part-term quote stops meaning anything once the term it is part of has ended. */
    validUntil: expiry,
    reference: "",
    salespersonId: "",
    /**
     * The workings, verbatim.
     *
     * The same sentence the order note and the calculator carry, so a customer querying the figure
     * gets the same explanation wherever they ask — and so the basis is recorded. The day and month
     * bases give different totals, and a proposal that does not say which one it used is one nobody
     * can reconcile against the invoice later.
     */
    notes: `${quantity} additional ${parent.item.name} from ${input.startDate}, co-terminating with the existing subscription on ${expiry}.\n\n${quote.workings}`,
    terms: "",
    dispatchFromAddress: "",
    billing: address,
    shippingSameAsBilling: true,
    shipping: address,
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
        itemId: parent.item.id,
        /**
         * Deliberately left empty. `companyProductId` marks a line as billing an order that already
         * exists, and these seats do not exist yet — pointing it at the parent would make the
         * proposal read as a second bill for the subscription already running.
         */
        companyProductId: "",
        name: parent.item.name,
        description: `Part term — ${quote.daysCharged} of ${quote.fullTermDays} ${unitWord}, ${input.startDate} to ${expiry}`,
        /** The part term the seats are charged for, co-terminating with the parent — as the description says. */
        servicePeriodFrom: input.startDate,
        servicePeriodTo: expiry,
        hsnCode: parent.item.hsnCode ?? "",
        unit: parent.item.unit ?? "",
        quantity,
        unitPrice: quote.unitPrice,
        discountMode: "PERCENT",
        discountValue: 0,
        taxRatePercent: Number(parent.item.taxRatePercent ?? 0),
      },
    ],
  }, "ADDON_CALCULATOR");

  if (!result.ok) return result;

  const created = await db.tradeDocument.findUnique({
    where: { id: result.data.id },
    select: { docNumber: true },
  });

  return { ok: true, data: { id: result.data.id, docNumber: created?.docNumber ?? null } };
}
