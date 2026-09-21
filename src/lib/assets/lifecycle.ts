import type {
  AssetKind,
  AssetMovementType,
  AssetOwnership,
  AssetStatus,
  ConsignmentReason,
  ConsignmentStatus,
} from "@prisma/client";

import { ewayBillRequired as ewayRequirement } from "@/lib/eway/rules";

/**
 * The rules an asset's life follows.
 *
 * Pure, because these are the decisions that go wrong quietly. An asset can be in the wrong place,
 * held by the wrong person, or — worst of all — a client's machine can end up capitalised on our
 * balance sheet. None of that throws an error at the time; it just produces a register nobody
 * trusts and a balance sheet that claims property we don't own.
 */

// ─── Who owns it ──────────────────────────────────────────────────────────────

export const ownershipLabels: Record<AssetOwnership, string> = {
  INTERNAL: "Ours — used internally",
  DEPLOYED: "Ours — at a client",
  CLIENT_OWNED: "The client's — we manage it",
};

export const ownershipTone: Record<AssetOwnership, "default" | "blue" | "amber" | "green"> = {
  INTERNAL: "blue",
  DEPLOYED: "amber",
  CLIENT_OWNED: "green",
};

/**
 * Whether this asset may carry a financial record.
 *
 * The single most important rule in the module. A client's laptop is something we look after, not
 * something we own — capitalising it would put somebody else's property on our balance sheet and
 * depreciate it against our profit. Nothing else here matters as much as this being right.
 */
export function mayBeCapitalised(ownership: AssetOwnership) {
  return ownership !== "CLIENT_OWNED";
}

/** Whether an owner company is required — and forbidden otherwise, so "ours" can't name an owner. */
export function requiresOwnerCompany(ownership: AssetOwnership) {
  return ownership === "CLIENT_OWNED";
}

export type OwnershipProblem = { field: "ownerCompanyId" | "fixedAssetId" | "siteCompanyId"; message: string };

/**
 * Checks an asset's ownership against everything hanging off it.
 *
 * Returns problems rather than throwing, so a form can show all of them at once instead of one per
 * save — and so the same function can be used to audit rows that already exist.
 */
export function checkOwnership(asset: {
  ownership: AssetOwnership;
  ownerCompanyId: string | null;
  fixedAssetId: string | null;
  siteCompanyId: string | null;
}): OwnershipProblem[] {
  const problems: OwnershipProblem[] = [];

  if (asset.ownership === "CLIENT_OWNED") {
    if (!asset.ownerCompanyId) {
      problems.push({ field: "ownerCompanyId", message: "A client-owned asset has to say whose it is." });
    }
    if (asset.fixedAssetId) {
      problems.push({
        field: "fixedAssetId",
        message:
          "This belongs to the client, so it can't carry a fixed-asset record. Capitalising it would put their property on our balance sheet.",
      });
    }
  } else if (asset.ownerCompanyId) {
    problems.push({
      field: "ownerCompanyId",
      message: "It's ours, so it can't also be owned by a company. Mark it client-owned, or clear the owner.",
    });
  }

  if (asset.ownership === "DEPLOYED" && !asset.siteCompanyId) {
    problems.push({ field: "siteCompanyId", message: "A deployed asset is at somebody's site — which one?" });
  }

  return problems;
}

// ─── Status ───────────────────────────────────────────────────────────────────

export const statusLabels: Record<AssetStatus, string> = {
  IN_STOCK: "In stock",
  ASSIGNED: "Assigned",
  IN_TRANSIT: "In transit",
  INSTALLED: "Installed",
  UNDER_REPAIR: "Under repair",
  RETIRED: "Retired",
  LOST: "Lost",
};

export const statusTone: Record<AssetStatus, "default" | "green" | "blue" | "red" | "amber"> = {
  IN_STOCK: "default",
  ASSIGNED: "blue",
  IN_TRANSIT: "amber",
  INSTALLED: "green",
  UNDER_REPAIR: "amber",
  RETIRED: "default",
  LOST: "red",
};

export const movementLabels: Record<AssetMovementType, string> = {
  RECEIVED: "Received",
  ASSIGNED: "Assigned",
  DISPATCHED: "Dispatched",
  DELIVERED: "Delivered",
  INSTALLED: "Installed",
  RETURNED: "Returned",
  SENT_FOR_REPAIR: "Sent for repair",
  BACK_FROM_REPAIR: "Back from repair",
  TRANSFERRED: "Transferred",
  SCRAPPED: "Scrapped",
  LOST: "Reported lost",
};

/**
 * Where a movement leaves the asset.
 *
 * Derived rather than set by hand, so the status can never disagree with the last thing that
 * happened — the commonest failure in an asset register is a status somebody forgot to change.
 */
export function statusAfter(movement: AssetMovementType): AssetStatus {
  switch (movement) {
    case "RECEIVED":
    case "RETURNED":
    case "BACK_FROM_REPAIR":
      return "IN_STOCK";
    case "ASSIGNED":
      return "ASSIGNED";
    case "DISPATCHED":
    case "TRANSFERRED":
      return "IN_TRANSIT";
    case "DELIVERED":
    case "INSTALLED":
      return "INSTALLED";
    case "SENT_FOR_REPAIR":
      return "UNDER_REPAIR";
    case "SCRAPPED":
      return "RETIRED";
    case "LOST":
      return "LOST";
  }
}

/**
 * Whether a movement makes sense from where the asset currently is.
 *
 * Deliberately permissive about the messy middle and strict at the ends: reality involves assets
 * turning up in odd states, but nothing may move after it has been scrapped, and something already
 * out for repair should not be dispatched to a customer.
 */
export function canMove(from: AssetStatus, movement: AssetMovementType): { ok: true } | { ok: false; reason: string } {
  if (from === "RETIRED" && movement !== "RECEIVED") {
    return { ok: false, reason: "This asset has been retired. Receive it back into stock first if it has resurfaced." };
  }
  if (from === "UNDER_REPAIR" && !["BACK_FROM_REPAIR", "SCRAPPED", "LOST", "RETURNED"].includes(movement)) {
    return { ok: false, reason: "It's away being repaired — bring it back before moving it anywhere else." };
  }
  if (from === "LOST" && !["RECEIVED", "SCRAPPED"].includes(movement)) {
    return { ok: false, reason: "It's recorded as lost. Receive it back into stock if it has been found." };
  }
  if (movement === "BACK_FROM_REPAIR" && from !== "UNDER_REPAIR") {
    return { ok: false, reason: "It wasn't away for repair." };
  }
  return { ok: true };
}

// ─── Cover ────────────────────────────────────────────────────────────────────

export type CoverState = {
  key: "WARRANTY" | "AMC" | "BOTH" | "NONE" | "EXPIRED";
  label: string;
  tone: "green" | "amber" | "red" | "default";
  /** Days until whichever cover runs out last; negative once everything has. */
  daysLeft: number | null;
};

/**
 * Whether somebody else will pay to fix it.
 *
 * Warranty and AMC are checked together because the practical question is one question — if a
 * machine breaks today, is it covered — and the answer is yes if either is live. Reporting them
 * separately makes somebody do that arithmetic in their head at the moment they least want to.
 */
export function coverState(
  asset: { warrantyEndsOn: Date | string | null; amcEndsOn: Date | string | null },
  now: Date = new Date(),
): CoverState {
  const days = (d: Date | string | null) =>
    d === null ? null : Math.ceil((new Date(d).getTime() - now.getTime()) / 86400000);

  const warranty = days(asset.warrantyEndsOn);
  const amc = days(asset.amcEndsOn);
  const warrantyLive = warranty !== null && warranty >= 0;
  const amcLive = amc !== null && amc >= 0;

  if (warrantyLive && amcLive) {
    return { key: "BOTH", label: "Warranty & AMC", tone: "green", daysLeft: Math.max(warranty, amc) };
  }
  if (warrantyLive) return { key: "WARRANTY", label: "Under warranty", tone: "green", daysLeft: warranty };
  if (amcLive) return { key: "AMC", label: "Under AMC", tone: "green", daysLeft: amc };

  // Nothing live. Distinguish "it ran out" from "there never was any" — they need different actions.
  if (warranty !== null || amc !== null) {
    const lapsed = Math.max(warranty ?? -Infinity, amc ?? -Infinity);
    return { key: "EXPIRED", label: "Cover expired", tone: "red", daysLeft: lapsed };
  }
  return { key: "NONE", label: "No cover recorded", tone: "default", daysLeft: null };
}

/** Assets whose cover runs out inside the window — what a renewals conversation is built from. */
export function coverExpiringWithin<
  T extends { id: string; warrantyEndsOn: Date | string | null; amcEndsOn: Date | string | null },
>(assets: T[], days: number, now: Date = new Date()): T[] {
  return assets.filter((a) => {
    const state = coverState(a, now);
    if (state.daysLeft === null) return false;
    // Already lapsed counts: an expired AMC is more urgent than one expiring next month, not less.
    return state.daysLeft <= days;
  });
}

// ─── Logistics ────────────────────────────────────────────────────────────────

export const consignmentReasonLabels: Record<ConsignmentReason, string> = {
  SALE_DELIVERY: "Delivering a sale",
  DEPLOYMENT: "Deploying our kit to a client",
  REPAIR_OUT: "Out for repair",
  REPAIR_RETURN: "Back from repair",
  RETURN_TO_VENDOR: "Returning to the vendor",
  INTERNAL_TRANSFER: "Between our own sites",
  COLLECTION: "Collecting from a client",
};

export const consignmentStatusLabels: Record<ConsignmentStatus, string> = {
  DRAFT: "Being packed",
  DISPATCHED: "Dispatched",
  IN_TRANSIT: "In transit",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

/**
 * Amber for anything still moving, because a consignment in motion is the one state somebody has to
 * keep watching — it is neither finished nor safely parked.
 */
export const consignmentStatusTone: Record<ConsignmentStatus, "default" | "green" | "blue" | "red" | "amber"> = {
  DRAFT: "default",
  DISPATCHED: "amber",
  IN_TRANSIT: "amber",
  DELIVERED: "green",
  CANCELLED: "red",
};

/** Still on the road: nobody has it yet, and somebody is waiting for it. */
export function isMoving(status: ConsignmentStatus) {
  return status === "DISPATCHED" || status === "IN_TRANSIT";
}

/**
 * Whether a supply is taking place, which decides what paperwork travels.
 *
 * Only a sale moves against a tax invoice. Everything else moves against a delivery challan, because
 * no supply is happening — raising an invoice for a laptop going out for repair would book revenue
 * that does not exist and charge GST nobody owes.
 */
export function isSupply(reason: ConsignmentReason) {
  return reason === "SALE_DELIVERY";
}

export function paperworkFor(reason: ConsignmentReason): "TAX_INVOICE" | "DELIVERY_CHALLAN" {
  return isSupply(reason) ? "TAX_INVOICE" : "DELIVERY_CHALLAN";
}

/**
 * Above this, goods in motion need an e-way bill — whether or not anything is being sold.
 *
 * Re-exported from `@/lib/eway/rules` rather than declared again. It was declared again, and the
 * two drifted: this copy hardcoded ₹50,000 and could not see `ewayIntraStateThreshold`, so a
 * business in a state with a ₹1,00,000 intra-state floor got one answer on the consignment board
 * and the opposite one on the e-way list, for the same goods. It also knew nothing about the
 * inter-state job-work rule. Two implementations of a compliance threshold is one too many.
 */
export { THRESHOLD as EWAY_BILL_THRESHOLD } from "@/lib/eway/rules";

export type EwayBillRequirement = {
  required: boolean;
  reason: string;
};

/**
 * Whether this consignment needs an e-way bill.
 *
 * The threshold applies to the *value of the goods moving*, not to the value of a sale — which is
 * the part people get wrong. Fifteen laptops going out for warranty repair are worth ₹9 lakh and
 * need a bill, even though nothing is being sold and no invoice exists.
 *
 * A thin adaptor over the canonical rule: this keeps the consignment board's `{ required, reason }`
 * shape and adds the sentence that only makes sense with a reason in hand — that a movement with no
 * sale behind it still needs one. Pass `intraStateThreshold` from settings; leaving it out means the
 * central ₹50,000, which is right for every inter-state movement and a safe floor for the rest.
 */
export function ewayBillRequired(
  params: {
    declaredValue: number | null;
    interstate: boolean;
    reason: ConsignmentReason;
  },
  options: { intraStateThreshold?: number } = {},
): EwayBillRequirement {
  const verdict = ewayRequirement(params, options);

  if (!verdict.required) return { required: false, reason: verdict.because };

  return {
    required: true,
    reason: isSupply(params.reason)
      ? verdict.because
      : `${verdict.because} Nothing is being sold, but the bill is still required — it is about the movement, not the sale.`,
  };
}

// ─── A client's estate ────────────────────────────────────────────────────────

/**
 * Of the machines that have ever left a company's site, the ones that are away from it *now*.
 *
 * An asset's site follows the machine, so sending one out for repair takes it off that client's
 * site list — and the customer waiting for it back would find nothing about it on their own page,
 * which is exactly when they ring. The test is the *latest* movement, not any movement: a machine
 * that passed through two years ago belongs wherever it went next, not here. And anything still
 * standing at the site is not away at all, however much history it has.
 */
export function awayFromSite<T extends { id: string; movements: { fromCompanyId: string | null }[] }>(params: {
  candidates: T[];
  companyId: string;
  /** Assets the estate already accounts for — their own, and ours still on their site. */
  stillHere: { id: string }[];
}): T[] {
  const here = new Set(params.stillHere.map((a) => a.id));
  return params.candidates.filter(
    (a) => !here.has(a.id) && a.movements[0]?.fromCompanyId === params.companyId,
  );
}

export const assetKindLabels: Record<AssetKind, string> = {
  LAPTOP: "Laptop",
  DESKTOP: "Desktop",
  SERVER: "Server",
  MONITOR: "Monitor",
  PRINTER: "Printer",
  NETWORK: "Network device",
  PHONE: "Phone",
  TABLET: "Tablet",
  PERIPHERAL: "Peripheral",
  SOFTWARE_LICENCE: "Software licence",
  OTHER: "Other",
};

/** A licence has no physical form, so movements and sites are meaningless for it. */
export function isPhysical(kind: AssetKind) {
  return kind !== "SOFTWARE_LICENCE";
}
