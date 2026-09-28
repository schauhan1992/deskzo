import type { TransportMode, VehicleType } from "@/lib/eway/rules";
import { istDateParts } from "@/lib/india-time";

/**
 * The shape the e-way bill portal wants, built from what we hold.
 *
 * Kept apart from the provider for the same reason `einvoice/payload.ts` is: the translation is the
 * part with rules in it — codes, date formats, which of two fields a value belongs in — and it can
 * be read and checked without a portal.
 *
 * Almost every field the portal takes is a number standing for a word. `transMode: 1` is road.
 * `vehicleType: "R"` is a regular lorry. `supplyType: "O"` is outward. Written out here, once, so
 * that nothing downstream has to remember which.
 */

export type EwayParty = {
  gstin: string | null;
  tradeName: string;
  address1: string;
  address2?: string | null;
  place: string;
  pincode: string;
  /** The GST state code, e.g. "27" for Maharashtra. */
  stateCode: string;
};

export type EwayItem = {
  productName: string;
  hsnCode: string;
  quantity: number;
  unit: string;
  taxableValue: number;
  cgstRate?: number;
  sgstRate?: number;
  igstRate?: number;
};

export type EwayDocument = {
  /** Outward for a despatch, inward for something coming back to us. */
  supplyType: "OUTWARD" | "INWARD";
  /** Why it is moving — a sale, a job-work despatch, own use, and so on. */
  subSupplyType: "SUPPLY" | "JOB_WORK" | "OWN_USE" | "EXHIBITION" | "LINE_SALES" | "RECIPIENT_NOT_KNOWN" | "SKD_CKD" | "OTHERS";
  /** What travels with the goods. A movement that is not a sale goes on a challan. */
  documentType: "INVOICE" | "CHALLAN" | "BILL_OF_SUPPLY" | "OTHERS";
  documentNumber: string;
  documentDate: Date;

  from: EwayParty;
  to: EwayParty;

  items: EwayItem[];

  totalValue: number;
  cgstValue?: number;
  sgstValue?: number;
  igstValue?: number;
  totalInvoiceValue: number;

  transporterId?: string | null;
  transporterName?: string | null;
  /** The transporter's own consignment note — `lrNumber` on the consignment. */
  transportDocNumber?: string | null;
  transportDocDate?: Date | null;
  transportMode: TransportMode;
  distanceKm: number;
  vehicleNumber?: string | null;
  vehicleType: VehicleType;
};

const SUB_SUPPLY: Record<EwayDocument["subSupplyType"], number> = {
  SUPPLY: 1,
  JOB_WORK: 4,
  OWN_USE: 5,
  EXHIBITION: 6,
  LINE_SALES: 7,
  RECIPIENT_NOT_KNOWN: 8,
  SKD_CKD: 9,
  OTHERS: 8,
};

const DOC_TYPE: Record<EwayDocument["documentType"], string> = {
  INVOICE: "INV",
  CHALLAN: "CHL",
  BILL_OF_SUPPLY: "BIL",
  OTHERS: "OTH",
};

const TRANSPORT_MODE: Record<TransportMode, number> = { ROAD: 1, RAIL: 2, AIR: 3, SHIP: 4 };

/**
 * `dd/mm/yyyy` — the portal's format, and not the one anything else in this app uses. The Indian
 * date, whatever the server's clock: read with getDate() on a UTC server, a document issued before
 * 05:30 IST went to the portal dated the day before.
 */
export function portalDate(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const { year, month, day } = istDateParts(date);
  return `${p(day)}/${p(month + 1)}/${year}`;
}

export function buildEwayPayload(doc: EwayDocument) {
  return {
    supplyType: doc.supplyType === "OUTWARD" ? "O" : "I",
    subSupplyType: String(SUB_SUPPLY[doc.subSupplyType]),
    docType: DOC_TYPE[doc.documentType],
    docNo: doc.documentNumber,
    docDate: portalDate(doc.documentDate),

    // "URP" — unregistered person — is what the portal expects where there is no GSTIN, rather
    // than a blank. A blank is a rejection.
    fromGstin: doc.from.gstin ?? "URP",
    fromTrdName: doc.from.tradeName,
    fromAddr1: doc.from.address1,
    fromAddr2: doc.from.address2 ?? "",
    fromPlace: doc.from.place,
    fromPincode: Number(doc.from.pincode),
    /**
     * Two state codes, and they are not the same question.
     *
     * `actFromStateCode` is where the goods physically start; `fromStateCode` is the state of the
     * supplier's registration. They differ whenever stock moves from a warehouse in another state,
     * and conflating them is how a bill comes back rejected for a reason nobody can find.
     */
    actFromStateCode: Number(doc.from.stateCode),
    fromStateCode: Number(doc.from.stateCode),

    toGstin: doc.to.gstin ?? "URP",
    toTrdName: doc.to.tradeName,
    toAddr1: doc.to.address1,
    toAddr2: doc.to.address2 ?? "",
    toPlace: doc.to.place,
    toPincode: Number(doc.to.pincode),
    actToStateCode: Number(doc.to.stateCode),
    toStateCode: Number(doc.to.stateCode),

    itemList: doc.items.map((i) => ({
      productName: i.productName,
      hsnCode: Number(i.hsnCode),
      quantity: i.quantity,
      qtyUnit: i.unit,
      taxableAmount: i.taxableValue,
      cgstRate: i.cgstRate ?? 0,
      sgstRate: i.sgstRate ?? 0,
      igstRate: i.igstRate ?? 0,
    })),

    totalValue: doc.totalValue,
    cgstValue: doc.cgstValue ?? 0,
    sgstValue: doc.sgstValue ?? 0,
    igstValue: doc.igstValue ?? 0,
    totInvValue: doc.totalInvoiceValue,

    transporterId: doc.transporterId ?? "",
    transporterName: doc.transporterName ?? "",
    transDocNo: doc.transportDocNumber ?? "",
    transDocDate: doc.transportDocDate ? portalDate(doc.transportDocDate) : "",
    transMode: String(TRANSPORT_MODE[doc.transportMode]),
    transDistance: String(doc.distanceKm),
    vehicleNo: doc.vehicleNumber ?? "",
    vehicleType: doc.vehicleType === "OVER_DIMENSIONAL_CARGO" ? "O" : "R",
  };
}

/**
 * What the portal would refuse, said before the round trip.
 *
 * Complements `missingForGeneration`, which asks whether the *consignment* is ready. This asks
 * whether the payload is well formed — a pincode that is not six digits, a state code that is not
 * two, an HSN that is not a number. The portal reports these one at a time as codes; reporting them
 * all at once in words saves a morning.
 */
export function validateEwayPayload(doc: EwayDocument): string[] {
  const problems: string[] = [];

  const pincode = (label: string, value: string) => {
    if (!/^\d{6}$/.test(value)) problems.push(`The ${label} pincode "${value}" is not six digits.`);
  };
  const stateCode = (label: string, value: string) => {
    if (!/^\d{1,2}$/.test(value)) problems.push(`The ${label} state code "${value}" is not a GST state code.`);
  };

  pincode("despatch", doc.from.pincode);
  pincode("delivery", doc.to.pincode);
  stateCode("despatch", doc.from.stateCode);
  stateCode("delivery", doc.to.stateCode);

  if (!doc.from.tradeName.trim()) problems.push("The despatch party has no name.");
  if (!doc.to.tradeName.trim()) problems.push("The delivery party has no name.");
  if (!doc.documentNumber.trim()) problems.push("There is no document number to travel with the goods.");

  if (doc.items.length === 0) {
    problems.push("There are no items on the consignment.");
  }
  for (const item of doc.items) {
    if (!/^\d{4,8}$/.test(item.hsnCode)) {
      problems.push(`"${item.productName}" has no usable HSN code (${item.hsnCode || "blank"}).`);
    }
    if (!(item.quantity > 0)) problems.push(`"${item.productName}" has no quantity.`);
  }

  if (!(doc.distanceKm > 0)) problems.push("The distance in kilometres is missing.");
  if (!doc.vehicleNumber && !doc.transporterId) {
    problems.push("Either a vehicle number or the transporter's GSTIN is needed.");
  }

  return problems;
}
