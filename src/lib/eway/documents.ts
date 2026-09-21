import type { TradeDocumentType } from "@prisma/client";
import { stateCodeFromGstin } from "@/lib/gst-engine";

/**
 * Which documents goods actually travel on.
 *
 * Lives here rather than beside the actions because a `"use server"` module may only export async
 * functions — every export there is a public endpoint, and a constant isn't callable. Pages and
 * client components read it from here; `src/actions/eway.ts` imports the same list, so there is
 * still only one.
 *
 * A proposal or a proforma is a price, not a movement. A purchase document covers goods coming in,
 * where the supplier raises the bill, not us.
 */
export const EWAY_DOC_TYPES: TradeDocumentType[] = ["INVOICE", "CREDIT_NOTE", "DELIVERY_CHALLAN"];

/** True when this document could need an e-way bill at all — a draft has moved nothing. */
export function carriesGoods(docType: TradeDocumentType, status: string) {
  return EWAY_DOC_TYPES.includes(docType) && status !== "DRAFT";
}

/**
 * The GST state code the goods are going to.
 *
 * Four places can answer this and they are not interchangeable, so they are tried in the order of
 * how directly each one states the delivery:
 *
 *   1. `shippingStateCode` — written on the document as the place of delivery;
 *   2. `placeOfSupplyCode` — the state the tax was worked out against, which is the delivery state
 *      for goods and is set on every invoice this app issues;
 *   3. the buyer's own GSTIN, whose first two digits are their state;
 *   4. `billingStateCode`, last because a bill-to address is frequently a head office that the
 *      goods will never see.
 *
 * Missing the place of supply is what made a perfectly ordinary invoice — "Place of supply: 29 —
 * Karnataka", printed on the same screen — report that it had no delivery state.
 */
export function deliveryStateCode(doc: {
  shippingStateCode?: string | null;
  placeOfSupplyCode?: string | null;
  buyerGstin?: string | null;
  billingStateCode?: string | null;
}): string | null {
  return (
    doc.shippingStateCode ||
    doc.placeOfSupplyCode ||
    stateCodeFromGstin(doc.buyerGstin) ||
    doc.billingStateCode ||
    null
  );
}
