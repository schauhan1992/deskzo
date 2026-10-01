/**
 * Backend rebates and the margins around them (owner, 1 Oct 2026) — pure, so the order screens, the
 * approval checks, reconciliation and the rebates report all work them out the same way.
 *
 * An OEM or a distributor gives money back on a sale: an **upfront discount** — the distributor bills
 * at a lower "deal price" — or a **backend rebate**, paid later as a credit note or a payout. Three
 * margins follow from it:
 *
 *   front margin   what we sell for, less what we pay and the order's expenses — before any rebate;
 *                  what targets and incentives count (owner: rebates never count there)
 *   expected       the backend rebates the order is to earn
 *   net margin     front margin plus the rebates still to come or already received
 *
 * Selling below cost — a "negative call" — means a selling price per unit under the unit cost. It
 * needs a manager's approval at that cost, whatever rebate is expected (src/actions/order.ts).
 */

export type RebateBasisKey = "PURCHASE_VALUE" | "SALE_VALUE" | "AMOUNT";
export type RebatePayerKey = "DISTRIBUTOR" | "OEM";
export type RebateSettlementKey = "CREDIT_NOTE" | "PAYOUT";
export type DealRegStatusKey = "APPLIED" | "APPROVED" | "REJECTED";

export const REBATE_BASIS_LABELS: Record<RebateBasisKey, string> = {
  PURCHASE_VALUE: "% of what we pay",
  SALE_VALUE: "% of what we sell for",
  AMOUNT: "A fixed amount (₹)",
};
export const REBATE_PAYER_LABELS: Record<RebatePayerKey, string> = { DISTRIBUTOR: "The distributor", OEM: "The OEM" };
export const REBATE_SETTLEMENT_LABELS: Record<RebateSettlementKey, string> = {
  CREDIT_NOTE: "Credit note",
  PAYOUT: "Paid into the bank",
};
export const DEAL_REG_LABELS: Record<DealRegStatusKey, string> = {
  APPLIED: "Applied",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export type CostSource = "PURCHASE" | "DEAL" | "QUOTE";
export const COST_SOURCE_LABELS: Record<CostSource, string> = {
  PURCHASE: "what purchase paid",
  DEAL: "the deal price",
  QUOTE: "the distributor's quote",
};

/**
 * What one unit costs us, as far as is known: what purchase paid once it has bought, else the deal
 * price the distributor is to bill at, else the price the salesperson was quoted. Null: not known.
 */
export function unitCostOf(o: {
  purchasePrice?: number | null;
  dealPrice?: number | null;
  quotedPurchasePrice?: number | null;
}): { cost: number; from: CostSource } | null {
  if (o.purchasePrice != null) return { cost: o.purchasePrice, from: "PURCHASE" };
  if (o.dealPrice != null) return { cost: o.dealPrice, from: "DEAL" };
  if (o.quotedPurchasePrice != null) return { cost: o.quotedPurchasePrice, from: "QUOTE" };
  return null;
}

/** The front margin: sale less cost less the order's expenses, before any rebate. Null without both prices. */
export function frontMargin(o: { quantity: number; unitPrice: number | null; unitCost: number | null; expenses?: number }): number | null {
  if (o.unitPrice == null || o.unitCost == null) return null;
  return round2((o.unitPrice - o.unitCost) * o.quantity - (o.expenses ?? 0));
}

/**
 * One rebate's expected amount, in rupees: a percentage of what we pay or of what we sell for, or a
 * fixed amount. Null when what it is a percentage of isn't known yet.
 */
export function expectedRebate(
  r: { basis: RebateBasisKey; rate?: number | null; amount?: number | null },
  o: { quantity: number; unitPrice: number | null; unitCost: number | null },
): number | null {
  if (r.basis === "AMOUNT") return r.amount == null ? null : round2(r.amount);
  if (r.rate == null) return null;
  const base = r.basis === "PURCHASE_VALUE" ? o.unitCost : o.unitPrice;
  if (base == null) return null;
  return round2((base * o.quantity * r.rate) / 100);
}

/**
 * Where one rebate stands: expected, received so far, and what is still to come. A rebate written off
 * stops being due — what was received before it was written off still counts as received.
 */
export function rebateStanding(expected: number | null, received: number, writtenOff: boolean) {
  const exp = expected ?? 0;
  const outstanding = writtenOff ? 0 : Math.max(0, round2(exp - received));
  return { expected: exp, received: round2(received), outstanding, writtenOff, known: expected != null };
}

/** The net margin: front margin plus what the rebates bring — received, and still to come unless written off. */
export function netMargin(front: number | null, rebates: { received: number; outstanding: number }[]): number | null {
  if (front == null) return null;
  return round2(front + rebates.reduce((sum, r) => sum + r.received + r.outstanding, 0));
}

/** Sold below cost: the selling price per unit is under the unit cost. Unknown either way: not below. */
export function isBelowCost(unitPrice: number | null, unitCost: number | null): boolean {
  if (unitPrice == null || unitCost == null) return false;
  return round2(unitPrice) < round2(unitCost);
}

/** Whether a below-cost approval already given covers buying at this cost: approved at this cost or more. */
export function lossApprovalCovers(approvedCost: number | null, cost: number): boolean {
  return approvedCost != null && round2(cost) <= round2(approvedCost);
}

/**
 * Does an order need a manager's say before it goes on, at this cost? Below cost, and not already
 * approved at a cost this high.
 */
export function needsLossApproval(o: { unitPrice: number | null; unitCost: number | null; lossApprovedCost: number | null }): boolean {
  if (!isBelowCost(o.unitPrice, o.unitCost)) return false;
  return !lossApprovalCovers(o.lossApprovedCost, o.unitCost as number);
}

/** What a programme needs to suggest itself for an order. */
export type ProgrammeForMatch = {
  id: string;
  brandId: string | null;
  vendorId: string | null;
  needsDealRegistration: boolean;
  validFrom: Date | null;
  validTo: Date | null;
  active: boolean;
};

/**
 * The programmes that apply to an order: active, in date on `on` (India's calendar day, as
 * `yyyy-mm-dd`), for its item's brand (or any), through its distributor (or any), and — for one that
 * needs it — with the deal registration approved.
 */
export function matchingProgrammes<P extends ProgrammeForMatch>(
  programmes: P[],
  order: { brandId: string | null; vendorId: string | null; dealRegStatus: DealRegStatusKey | null; on: string },
): P[] {
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  return programmes.filter((p) => {
    if (!p.active) return false;
    if (p.brandId && p.brandId !== order.brandId) return false;
    if (p.vendorId && p.vendorId !== order.vendorId) return false;
    if (p.needsDealRegistration && order.dealRegStatus !== "APPROVED") return false;
    const from = day(p.validFrom);
    const to = day(p.validTo);
    if (from && order.on < from) return false;
    if (to && order.on > to) return false;
    return true;
  });
}
