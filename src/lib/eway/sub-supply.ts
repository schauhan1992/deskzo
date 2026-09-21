import type { ConsignmentReason, TradeDocumentType } from "@prisma/client";
import type { EwayDocument } from "@/lib/eway/payload";

/**
 * What the portal is told the movement is *for*.
 *
 * Every delivery challan was declared as sub-supply type 4, **Job Work**, whatever was actually
 * happening — a laptop going back to the vendor, stock moving between our own offices, kit being
 * deployed at a client, all filed as job work. It is the field a roadside officer reads to decide
 * whether the paperwork matches the load, and it is wrong on most of them.
 *
 * Job work has a specific meaning: goods sent to a third party to have something done to them and
 * returned. That is `REPAIR_OUT` and `REPAIR_RETURN`, and nothing else on this list.
 */
export function subSupplyFor(
  docType: TradeDocumentType,
  reason: ConsignmentReason | null | undefined,
): EwayDocument["subSupplyType"] {
  // An invoice or credit note is a supply, whatever movement it happens to be attached to.
  if (docType !== "DELIVERY_CHALLAN") return "SUPPLY";

  switch (reason) {
    case "REPAIR_OUT":
    case "REPAIR_RETURN":
      return "JOB_WORK";
    case "INTERNAL_TRANSFER":
      // Our own goods between our own places — the portal's "own use", not a supply to anybody.
      return "OWN_USE";
    case "SALE_DELIVERY":
      // A challan raised for a sale still moves goods that are being supplied.
      return "SUPPLY";
    case "DEPLOYMENT":
    case "RETURN_TO_VENDOR":
    case "COLLECTION":
      /**
       * None of the portal's named categories fits, and picking a near-miss is worse than saying so:
       * "Others" is a real option on the form and it is what a human filing this by hand would
       * choose. Deploying our own kit to a client is not a supply, not job work and not own use.
       */
      return "OTHERS";
    default:
      // A challan with no consignment behind it — raised by hand. Nothing is known about intent.
      return "OTHERS";
  }
}
