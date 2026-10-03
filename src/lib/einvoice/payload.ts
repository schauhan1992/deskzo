/**
 * Builds the IRP (e-invoice) request body in the government's INV-01 schema.
 *
 * The field names are the portal's, not ours — they're terse and non-obvious (`AssAmt` is the
 * assessable/taxable value, `Pos` is place of supply, `Stcd` a state code), so the mapping lives
 * here alone and the rest of the app keeps its own vocabulary.
 */
import { gstNumberProblem } from "@/lib/document-numbering";
import { indiaClock } from "@/lib/time/zone";

export type EInvoiceParty = {
  gstin: string | null;
  legalName: string;
  address1: string | null;
  address2?: string | null;
  city: string | null;
  pincode: string | null;
  stateCode: string | null;
  phone?: string | null;
  email?: string | null;
  /**
   * The seller's branch name, so a problem says which branch to fix — with several GSTINs, "your
   * organisation's GSTIN" no longer names one. For messages only; never sent to the IRP.
   */
  label?: string | null;
};

export type EInvoiceLine = {
  description: string;
  isService: boolean;
  hsnCode: string | null;
  quantity: number;
  unit: string | null;
  unitPrice: number;
  grossAmount: number;
  discountAmount: number;
  taxableValue: number;
  taxRatePercent: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  lineTotal: number;
};

export type EInvoiceDocument = {
  docType: "INVOICE" | "CREDIT_NOTE";
  docNumber: string;
  issueDate: Date;
  reverseCharge: boolean;
  placeOfSupplyCode: string | null;
  seller: EInvoiceParty;
  buyer: EInvoiceParty;
  lines: EInvoiceLine[];
  taxableValue: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  roundOff: number;
  total: number;
  /** Set for a credit note — the invoice it reduces. */
  againstDocNumber?: string | null;
  againstDocDate?: Date | null;
};

/**
 * The portal wants DD/MM/YYYY, not ISO — and the Indian day, whatever zone the workspace keeps. Read
 * from the host's calendar, an invoice issued before 05:30 IST went to the IRP dated the day before on
 * a UTC server (X6).
 */
function irpDate(date: Date) {
  const { year, month, day } = indiaClock.parts(date);
  return `${String(day).padStart(2, "0")}/${String(month + 1).padStart(2, "0")}/${year}`;
}

const DOC_TYPE: Record<EInvoiceDocument["docType"], string> = { INVOICE: "INV", CREDIT_NOTE: "CRN" };

/** A GSTIN-less buyer can't be reported as B2B; the portal treats those as B2C. */
function supplyCategory(doc: EInvoiceDocument) {
  return doc.buyer.gstin ? "B2B" : "B2C";
}

export function buildEInvoicePayload(doc: EInvoiceDocument) {
  return {
    Version: "1.1",
    TranDtls: {
      TaxSch: "GST",
      SupTyp: supplyCategory(doc),
      RegRev: doc.reverseCharge ? "Y" : "N",
      IgstOnIntra: "N",
    },
    DocDtls: {
      Typ: DOC_TYPE[doc.docType],
      No: doc.docNumber,
      Dt: irpDate(doc.issueDate),
    },
    // No DispDtls: the goods leave from the seller's own address — CA question C10.
    SellerDtls: {
      Gstin: doc.seller.gstin ?? "",
      LglNm: doc.seller.legalName,
      Addr1: doc.seller.address1 ?? "",
      ...(doc.seller.address2 ? { Addr2: doc.seller.address2 } : {}),
      Loc: doc.seller.city ?? "",
      Pin: Number(doc.seller.pincode ?? 0),
      Stcd: doc.seller.stateCode ?? "",
      ...(doc.seller.phone ? { Ph: doc.seller.phone } : {}),
      ...(doc.seller.email ? { Em: doc.seller.email } : {}),
    },
    BuyerDtls: {
      // The portal expects the literal "URP" (unregistered person) rather than a blank GSTIN.
      Gstin: doc.buyer.gstin ?? "URP",
      LglNm: doc.buyer.legalName,
      Pos: doc.placeOfSupplyCode ?? doc.buyer.stateCode ?? "",
      Addr1: doc.buyer.address1 ?? "",
      ...(doc.buyer.address2 ? { Addr2: doc.buyer.address2 } : {}),
      Loc: doc.buyer.city ?? "",
      Pin: Number(doc.buyer.pincode ?? 0),
      Stcd: doc.buyer.stateCode ?? "",
    },
    ...(doc.againstDocNumber
      ? {
          RefDtls: {
            PrecDocDtls: [
              {
                InvNo: doc.againstDocNumber,
                InvDt: irpDate(doc.againstDocDate ?? doc.issueDate),
              },
            ],
          },
        }
      : {}),
    ItemList: doc.lines.map((line, index) => ({
      SlNo: String(index + 1),
      PrdDesc: line.description.slice(0, 300),
      IsServc: line.isService ? "Y" : "N",
      HsnCd: line.hsnCode ?? "",
      Qty: line.quantity,
      Unit: (line.unit ?? "OTH").slice(0, 3).toUpperCase(),
      UnitPrice: line.unitPrice,
      TotAmt: line.grossAmount,
      Discount: line.discountAmount,
      AssAmt: line.taxableValue,
      GstRt: line.taxRatePercent,
      IgstAmt: line.igstAmount,
      CgstAmt: line.cgstAmount,
      SgstAmt: line.sgstAmount,
      TotItemVal: line.lineTotal,
    })),
    ValDtls: {
      AssVal: doc.taxableValue,
      CgstVal: doc.cgstAmount,
      SgstVal: doc.sgstAmount,
      IgstVal: doc.igstAmount,
      RndOffAmt: doc.roundOff,
      TotInvVal: doc.total,
    },
  };
}

/**
 * Checks the document carries everything the portal will insist on, so a user sees one clear list
 * of what's missing instead of a cryptic rejection code from the IRP.
 */
export function validateForEInvoice(doc: EInvoiceDocument): string[] {
  const problems: string[] = [];
  // Named by branch when the caller says which one — each has its own GSTIN, state and address.
  const branch = doc.seller.label?.trim();
  if (!doc.seller.gstin) {
    problems.push(
      branch
        ? `The GSTIN of branch ${branch} isn't set (Settings → Branches & GST registrations).`
        : "Your organisation's GSTIN isn't set (Settings → Organisation).",
    );
  }
  if (!doc.seller.stateCode) {
    problems.push(
      branch
        ? `The state code of branch ${branch} isn't set (Settings → Branches & GST registrations).`
        : "Your organisation's state code isn't set.",
    );
  }
  if (!doc.seller.address1 || !doc.seller.city || !doc.seller.pincode) {
    problems.push(
      branch
        ? `The address of branch ${branch} is incomplete (address, city and PIN are required).`
        : "Your organisation's registered address is incomplete.",
    );
  }
  // The IRP refuses a number over 16 characters or of the wrong shape, and says so only as a code.
  const numberProblem = gstNumberProblem(doc.docType, doc.docNumber);
  if (numberProblem) problems.push(numberProblem);
  if (!doc.buyer.legalName) problems.push("The customer has no legal name.");
  if (!doc.buyer.address1 || !doc.buyer.city || !doc.buyer.pincode) {
    problems.push("The customer's billing address is incomplete (address, city and PIN are required).");
  }
  if (!doc.buyer.stateCode) problems.push("The customer's state code is missing — set a GSTIN or state on their location.");
  if (doc.lines.length === 0) problems.push("The document has no line items.");
  const missingHsn = doc.lines.filter((l) => !l.hsnCode).length;
  if (missingHsn > 0) problems.push(`${missingHsn} line(s) have no HSN/SAC code.`);
  if (doc.total <= 0) problems.push("The document total must be greater than zero.");
  return problems;
}
