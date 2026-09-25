"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type TradeDocumentType } from "@prisma/client";
import { db } from "@/lib/db";
import { ewayEnabled, intraStateThreshold } from "@/lib/eway/settings";
import { EWAY_CLAIM_STALE_MS } from "@/lib/eway/rules";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { getOrganisation, getEInvoiceConfig } from "@/lib/organisation";
import { validateEwayPayload, type EwayDocument } from "@/lib/eway/payload";
import { createEwayProvider } from "@/lib/eway/provider";
import {
  endOfIndianDay,
  ewayBillRequired,
  missingForGeneration,
  normaliseVehicleNumber,
  standingOf,
  startOfIndianDay,
  withinCancellationWindow,
} from "@/lib/eway/rules";
import { EWAY_DOC_TYPES, deliveryStateCode } from "@/lib/eway/documents";
import { apportionLineValues, documentGoodsValue } from "@/lib/eway/value";
import { subSupplyFor } from "@/lib/eway/sub-supply";
import type { ActionResult } from "@/actions/company";

/**
 * E-way bills, against the documents the goods travel on.
 *
 * ## Why a document and not a consignment
 *
 * Because that is what the portal asks for: every bill names a document type and number — INV for an
 * invoice, CHL for a delivery challan — and a roadside check compares the bill against the paper in
 * the driver's hand. The first version of this hung the bill on a consignment, which covered asset
 * movements and missed the larger half entirely: a hardware reseller's e-way bills come mostly from
 * **sales invoices**, and a consignment-shaped model had nowhere to put those.
 *
 * A consignment still raises one. It does it against the delivery challan it generates.
 *
 * ## The credentials are the e-invoice credentials
 *
 * Same portal operator, same GSTIN, same client id and secret, so this reads `getEInvoiceConfig`
 * rather than adding a second set for somebody to keep in step.
 */

async function gate() {
  const user = await requireUser();
  // Raising a bill is a filing on the company's GSTIN against a government portal — the same weight
  // as issuing the invoice it covers, so the same permission governs it.
  if (!(await can(user.id, "orders.process"))) {
    return { user, error: "You don't have access to despatch and its paperwork." };
  }
  return { user, error: null };
}

/** The GST state code from a GSTIN, which is its first two digits. */
function stateCodeFromGstin(gstin: string | null | undefined): string | null {
  const match = /^(\d{2})/.exec((gstin ?? "").trim());
  return match ? match[1]! : null;
}

/**
 * Whether the module is switched on at all.
 *
 * Checked on the reads rather than only in the nav, because a hidden link is not a boundary: the
 * document page renders its own panel and the list has its own URL. A refusal here means the panel
 * simply is not there, which is what "disabled" should look like.
 */
/**
 * Checked on every read **and every write**.
 *
 * It guarded the two reads and none of the six writes, so a switched-off module still filed bills
 * with NIC on the company's GSTIN — a kill switch that hid the screen and left the filing running
 * is worse than no kill switch, because somebody believes it worked.
 */
const DISABLED = "E-way bills are switched off for this organisation. An admin can turn them on under Settings.";


// ─── The list ─────────────────────────────────────────────────────────────────────────────────

export type EwayStatus = "NOT_GENERATED" | "GENERATED" | "EXPIRED" | "CANCELLED" | "FAILED";

export type EwayListRow = {
  documentId: string;
  docNumber: string;
  docType: TradeDocumentType;
  issueDate: Date;
  customerName: string;
  customerGstin: string | null;
  total: number;
  ewayBillNumber: string | null;
  validUntil: Date | null;
  status: EwayStatus;
  required: boolean;
  because: string;
};

export type EwayList = {
  rows: EwayListRow[];
  total: number;
  counts: { outstanding: number; generated: number; expired: number; cancelled: number };
};

/**
 * Documents that carry goods, with whatever bill they have.
 *
 * The default view is **outstanding**, because that is the only one that is a to-do list: a
 * document over the threshold with nothing valid covering it is either work nobody has done or a
 * lorry that should not have left.
 *
 * Outstanding is deliberately not the same as "no bill was ever raised". A bill that was cancelled,
 * and a bill that has expired, both leave the goods exactly as uncovered as a bill that was never
 * raised — and a roadside check treats all three the same. Reading the tab as "never generated"
 * would let a cancellation quietly retire a document from the list it most needs to be on. So the
 * other tabs overlap with this one on purpose: they answer "what happened", this one answers "what
 * still needs doing".
 */
export async function ewayDocuments(params: {
  docType?: string;
  status?: string;
  from?: string;
  to?: string;
  q?: string;
  page: number;
  pageSize: number;
}): Promise<ActionResult<EwayList>> {
  const { error } = await gate();
  if (error) return { ok: false, error };
  if (!(await ewayEnabled())) return { ok: false, error: DISABLED };

  const docType =
    params.docType && EWAY_DOC_TYPES.includes(params.docType as TradeDocumentType)
      ? [params.docType as TradeDocumentType]
      : EWAY_DOC_TYPES;

  const where: Prisma.TradeDocumentWhereInput = {
    docType: { in: docType },
    direction: "SALES",
    // A draft is our workings; nothing has moved against it.
    status: { not: "DRAFT" },
    ...(params.from || params.to
      ? {
          issueDate: {
            ...(params.from ? { gte: new Date(params.from) } : {}),
            ...(params.to ? { lte: new Date(params.to) } : {}),
          },
        }
      : {}),
    ...(params.q
      ? {
          OR: [
            { docNumber: { contains: params.q, mode: "insensitive" as const } },
            { company: { name: { contains: params.q, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  /**
   * Counted across everything, not across the newest 500.
   *
   * The cap was a performance guard and it silently broke the only thing this screen is for. At
   * ~40 documents a day it fills in under a fortnight, so an invoice from three weeks ago whose
   * goods moved with no bill sat outside the window: absent from "Needs a bill", absent from the
   * count, absent from the banner. The screen reported nothing outstanding while a penalty-bearing
   * gap sat in the database — the one wrong answer nobody would have queried.
   *
   * Outstanding work is unbounded by nature, so the where-clause narrows it instead: a document
   * that already has a live bill is settled and does not need loading to be counted. Paging is
   * applied to the rows, the counts come from the whole set.
   */
  const documents = await db.tradeDocument.findMany({
    where,
    orderBy: { issueDate: "desc" },
    select: {
      id: true,
      docNumber: true,
      docType: true,
      issueDate: true,
      total: true,
      buyerGstin: true,
      sellerGstin: true,
      shippingStateCode: true,
      billingStateCode: true,
      placeOfSupplyCode: true,
      company: { select: { name: true } },
      lines: { select: { quantity: true, unitPrice: true, taxableValue: true } },
      consignments: { select: { declaredValue: true, interstate: true, reason: true } },
      ewayBills: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  const threshold = await intraStateThreshold();
  const org = await getOrganisation();
  const now = new Date();

  const all: EwayListRow[] = documents.map((d) => {
    const bill = d.ewayBills[0] ?? null;
    // Ours, whether or not this particular document recorded it — older rows predate the field.
    const sellerState = stateCodeFromGstin(d.sellerGstin) ?? stateCodeFromGstin(org.gstin);
    const buyerState = deliveryStateCode(d);
    const interstate =
      sellerState && buyerState ? sellerState !== buyerState : d.consignments.some((c) => c.interstate);

    /**
     * The value of the goods, not the value of the paperwork.
     *
     * A delivery challan totals nil — that is what makes it a challan. Deciding the threshold on
     * that number put every asset movement in the app under "not required", which is the one wrong
     * answer nobody would have queried.
     */
    const goodsValue = bill
      ? Number(bill.declaredValue)
      : documentGoodsValue({
          total: d.total,
          consignmentValues: d.consignments.map((c) => c.declaredValue),
          lines: d.lines,
        });

    const requirement = ewayBillRequired(
      // The reason decides inter-state job work on its own, before any value is looked at.
      { declaredValue: goodsValue, interstate, reason: d.consignments[0]?.reason ?? null },
      { intraStateThreshold: threshold },
    );

    let status: EwayStatus = "NOT_GENERATED";
    if (bill?.status === "CANCELLED") status = "CANCELLED";
    else if (bill?.status === "FAILED") status = "FAILED";
    else if (bill?.ewayBillNumber) {
      status = bill.validUntil && bill.validUntil.getTime() <= now.getTime() ? "EXPIRED" : "GENERATED";
    }

    return {
      documentId: d.id,
      docNumber: d.docNumber,
      docType: d.docType,
      issueDate: d.issueDate,
      customerName: d.company.name,
      customerGstin: d.buyerGstin,
      total: goodsValue,
      ewayBillNumber: bill?.ewayBillNumber ?? null,
      validUntil: bill?.validUntil ?? null,
      status,
      required: requirement.required,
      because: requirement.because,
    };
  });

  /**
   * Counted before filtering, so each tab says how many are in that state rather than how many are
   * in the one already being looked at.
   */
  const outstanding = (r: EwayListRow) =>
    r.required && (r.status === "NOT_GENERATED" || r.status === "EXPIRED" || r.status === "CANCELLED" || r.status === "FAILED");

  const counts = {
    outstanding: all.filter(outstanding).length,
    generated: all.filter((r) => r.status === "GENERATED").length,
    expired: all.filter((r) => r.status === "EXPIRED").length,
    cancelled: all.filter((r) => r.status === "CANCELLED").length,
  };

  const filtered =
    params.status === "all"
      ? all
      : params.status === "generated"
        ? all.filter((r) => r.status === "GENERATED")
        : params.status === "expired"
          ? all.filter((r) => r.status === "EXPIRED")
          : params.status === "cancelled"
            ? all.filter((r) => r.status === "CANCELLED")
            : // The default, and the only view that is a to-do list.
              all.filter(outstanding);

  const start = (params.page - 1) * params.pageSize;
  return {
    ok: true,
    data: { rows: filtered.slice(start, start + params.pageSize), total: filtered.length, counts },
  };
}

// ─── One document ─────────────────────────────────────────────────────────────────────────────

export type EwayBillView = {
  id: string;
  status: string;
  ewayBillNumber: string | null;
  ewayBillDate: Date | null;
  validUntil: Date | null;
  error: string | null;
  cancelReason: string | null;
  associated: boolean;
  declaredValue: number;
  interstate: boolean;
  distanceKm: number;
  transporterId: string | null;
  transporterName: string | null;
  transportMode: "ROAD" | "RAIL" | "AIR" | "SHIP";
  vehicleType: "REGULAR" | "OVER_DIMENSIONAL_CARGO";
  vehicleNumber: string | null;
  transportDocNumber: string | null;
};

export type EwayDocumentView = {
  documentId: string;
  docNumber: string;
  docType: TradeDocumentType;
  issueDate: Date;
  customerName: string;
  total: number;
  interstate: boolean;
  required: boolean;
  because: string;
  bill: EwayBillView | null;
  standing: ReturnType<typeof standingOf>;
  missing: string[];
  /** Fixed by editing the document, not by filling in the transport form. */
  missingOnDocument: string[];
  canCancel: boolean;
  configured: boolean;
  provider: string | null;
};

async function loadDocument(documentId: string) {
  return db.tradeDocument.findUnique({
    where: { id: documentId },
    include: {
      company: { select: { name: true } },
      lines: { select: { name: true, hsnCode: true, quantity: true, unitPrice: true, unit: true, taxableValue: true } },
      // A challan totals nil on purpose, so the value of what is moving has to come from the
      // movement itself — see `documentGoodsValue`.
      consignments: { select: { declaredValue: true, interstate: true, reason: true } },
      ewayBills: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { transporter: { select: { name: true, gstin: true } } },
      },
    },
  });
}

export async function ewayForDocument(documentId: string): Promise<ActionResult<EwayDocumentView>> {
  const { error } = await gate();
  if (error) return { ok: false, error };
  if (!(await ewayEnabled())) return { ok: false, error: DISABLED };

  const doc = await loadDocument(documentId);
  if (!doc) return { ok: false, error: "That document no longer exists." };

  const bill = doc.ewayBills[0] ?? null;
  const org = await getOrganisation();
  const sellerState = stateCodeFromGstin(doc.sellerGstin) ?? stateCodeFromGstin(org.gstin);
  const buyerState = deliveryStateCode(doc);
  /**
   * Whether it crosses a state line, from whoever actually knows.
   *
   * The two state codes settle it when both are on the document. A delivery challan often carries
   * neither — an unregistered consignee has no GSTIN and a repair going back to a workshop has no
   * place-of-supply — and then the consignment’s own flag, which somebody ticked when they raised
   * the movement, is a better answer than silently assuming local.
   */
  const fromStates = sellerState && buyerState ? sellerState !== buyerState : null;
  const fromConsignment = doc.consignments.some((c) => c.interstate);
  const interstate = bill?.interstate ?? fromStates ?? fromConsignment;
  const declaredValue = bill
    ? Number(bill.declaredValue)
    : documentGoodsValue({
        total: doc.total,
        consignmentValues: doc.consignments.map((c) => c.declaredValue),
        lines: doc.lines,
      });

  const shape = {
    declaredValue,
    interstate,
    reason: doc.consignments[0]?.reason ?? null,
    distanceKm: bill?.distanceKm ?? null,
    vehicleNumber: bill?.vehicleNumber ?? null,
    transporterId: bill?.transporter?.gstin ?? null,
    vehicleType: bill?.vehicleType ?? ("REGULAR" as const),
  };

  const threshold = await intraStateThreshold();
  const requirement = ewayBillRequired(shape, { intraStateThreshold: threshold });
  const config = await getEInvoiceConfig();

  return {
    ok: true,
    data: {
      documentId: doc.id,
      docNumber: doc.docNumber,
      docType: doc.docType,
      issueDate: doc.issueDate,
      customerName: doc.partyName ?? doc.company.name,
      // The goods, not the paperwork — a challan totals nil and still moves six lakhs of kit.
      total: declaredValue,
      interstate,
      required: requirement.required,
      because: requirement.because,
      bill: bill
        ? {
            id: bill.id,
            status: bill.status,
            ewayBillNumber: bill.ewayBillNumber,
            ewayBillDate: bill.ewayBillDate,
            validUntil: bill.validUntil,
            error: bill.error,
            cancelReason: bill.cancelReason,
            associated: bill.associated,
            declaredValue: Number(bill.declaredValue),
            interstate: bill.interstate,
            distanceKm: bill.distanceKm,
            transporterId: bill.transporterId,
            transporterName: bill.transporter?.name ?? null,
            transportMode: bill.transportMode,
            vehicleType: bill.vehicleType,
            vehicleNumber: bill.vehicleNumber,
            transportDocNumber: bill.transportDocNumber,
          }
        : null,
      standing: standingOf(
        {
          ...shape,
          status: "DISPATCHED",
          ewayBillNumber: bill?.ewayBillNumber,
          ewayBillValidUntil: bill?.validUntil,
          ewayBillStatus: bill?.status,
        },
        new Date(),
        { intraStateThreshold: threshold },
      ),
      missing: missingForGeneration(shape),
      /**
       * The other half of what would stop a bill.
       *
       * `missingForGeneration` knows about the lorry and the distance. It cannot know that the
       * document has no delivery pincode, and the portal refuses on that just as flatly — which is
       * how "Raise the e-way bill" came to be a button that was always enabled and always failed.
       * Kept as its own list because it is fixed on the document rather than in the transport form,
       * and sending somebody to the wrong screen is barely better than not telling them.
       */
      missingOnDocument: [
        ...(/^\d{6}$/.test(doc.shippingPincode ?? doc.billingPincode ?? "") ? [] : ["a six-digit delivery pincode"]),
        ...(buyerState ? [] : ["a delivery state"]),
      ],
      canCancel:
        Boolean(bill?.ewayBillNumber) &&
        bill?.status === "GENERATED" &&
        !bill.associated &&
        withinCancellationWindow(bill?.ewayBillDate, new Date()),
      configured: config !== null,
      provider: config?.provider ?? null,
    },
  };
}

/** Part A, plus the transport details. Saved without touching the portal. */
export async function saveEwayDetails(input: {
  documentId: string;
  declaredValue: number;
  interstate: boolean;
  distanceKm: number;
  transporterId: string | null;
  transportMode: "ROAD" | "RAIL" | "AIR" | "SHIP";
  vehicleType: "REGULAR" | "OVER_DIMENSIONAL_CARGO";
  vehicleNumber: string | null;
  transportDocNumber: string | null;
}): Promise<ActionResult<{ id: string }>> {
  const { user, error } = await gate();
  if (error) return { ok: false, error };

  if (!(await ewayEnabled())) return { ok: false, error: DISABLED };

  const doc = await db.tradeDocument.findUnique({ where: { id: input.documentId }, select: { id: true } });
  if (!doc) return { ok: false, error: "That document no longer exists." };

  if (!Number.isFinite(input.declaredValue) || input.declaredValue < 0) {
    return { ok: false, error: "The value of the goods should be a positive number." };
  }
  if (!Number.isInteger(input.distanceKm) || input.distanceKm < 1 || input.distanceKm > 5000) {
    return { ok: false, error: "The distance should be a whole number of kilometres, up to 5000." };
  }

  const existing = await db.ewayBill.findFirst({
    where: { documentId: doc.id, status: { not: "CANCELLED" } },
    orderBy: { createdAt: "desc" },
  });

  // A bill already at the portal is not ours to edit — Part B goes through the portal's own update.
  if (existing?.ewayBillNumber) {
    return { ok: false, error: "This document already has an e-way bill. Change the vehicle through Part B instead." };
  }

  const data = {
    declaredValue: new Prisma.Decimal(input.declaredValue.toFixed(2)),
    interstate: input.interstate,
    distanceKm: input.distanceKm,
    transporterId: input.transporterId || null,
    transportMode: input.transportMode,
    vehicleType: input.vehicleType,
    vehicleNumber: normaliseVehicleNumber(input.vehicleNumber),
    transportDocNumber: input.transportDocNumber?.trim() || null,
    status: "REQUIRED" as const,
  };

  const saved = existing
    ? await db.ewayBill.update({ where: { id: existing.id }, data, select: { id: true } })
    : await db.ewayBill.create({ data: { ...data, documentId: doc.id, createdById: user.id }, select: { id: true } });

  revalidatePath(`/documents/${doc.id}`);
  revalidatePath("/sales/eway-bills");
  return { ok: true, data: { id: saved.id } };
}

type LoadedDoc = NonNullable<Awaited<ReturnType<typeof loadDocument>>>;

function toEwayPayload(
  doc: LoadedDoc,
  bill: LoadedDoc["ewayBills"][number],
  org: Awaited<ReturnType<typeof getOrganisation>>,
): { doc: EwayDocument } | { problems: string[] } {
  const value = Number(bill.declaredValue);

  /**
   * The document's own lines, with the value taken from the bill.
   *
   * A delivery challan carries no value on purpose — nothing is supplied, so the taxable value is
   * nil. The portal asks a different question: what are these goods worth to move. Taking the
   * challan's zero would declare ₹0 of goods on a six-lakh movement, which is exactly the kind of
   * understatement a check looks for.
   */
  const lineValues = apportionLineValues(doc.lines, value);

  const payload: EwayDocument = {
    supplyType: "OUTWARD",
    // Derived from why the goods are moving — see src/lib/eway/sub-supply.ts. Every challan used
    // to be declared as job work regardless.
    subSupplyType: subSupplyFor(doc.docType, doc.consignments[0]?.reason ?? null),
    documentType: doc.docType === "INVOICE" ? "INVOICE" : doc.docType === "CREDIT_NOTE" ? "OTHERS" : "CHALLAN",
    documentNumber: doc.docNumber,
    documentDate: doc.issueDate,
    from: {
      gstin: org.gstin ?? null,
      tradeName: org.tradeName || org.legalName || "",
      address1: org.addressLine1 ?? "",
      address2: org.addressLine2 ?? null,
      place: org.city ?? "",
      pincode: org.pincode ?? "",
      stateCode: stateCodeFromGstin(org.gstin) ?? "",
    },
    to: {
      gstin: doc.buyerGstin,
      tradeName: doc.partyName ?? doc.company.name,
      address1: doc.shippingLine1 ?? doc.billingLine1 ?? "",
      place: doc.shippingCity ?? doc.billingCity ?? "",
      pincode: doc.shippingPincode ?? doc.billingPincode ?? "",
      stateCode: deliveryStateCode(doc) ?? "",
    },
    items: doc.lines.map((l, i) => ({
      productName: l.name,
      hsnCode: l.hsnCode ?? "",
      quantity: Number(l.quantity),
      unit: l.unit ?? "NOS",
      taxableValue: lineValues[i]!,
    })),
    totalValue: value,
    totalInvoiceValue: value,
    transporterId: bill.transporter?.gstin ?? null,
    transporterName: bill.transporter?.name ?? null,
    transportDocNumber: bill.transportDocNumber,
    transportMode: bill.transportMode,
    distanceKm: bill.distanceKm,
    vehicleNumber: normaliseVehicleNumber(bill.vehicleNumber),
    vehicleType: bill.vehicleType,
  };

  const problems = validateEwayPayload(payload);
  if (problems.length > 0 && doc.lines.length === 0) {
    problems.unshift("This document has no lines, so there is nothing to itemise on the bill.");
  }
  return problems.length > 0 ? { problems } : { doc: payload };
}

export async function generateEwayBill(
  documentId: string,
): Promise<ActionResult<{ ewayBillNumber: string; validUntil: Date }>> {
  const { user, error } = await gate();
  if (error) return { ok: false, error };

  if (!(await ewayEnabled())) return { ok: false, error: DISABLED };

  const config = await getEInvoiceConfig();
  if (!config) {
    return {
      ok: false,
      error: "The e-way bill portal isn't set up. It uses the same credentials as e-invoicing — Settings → Organisation.",
    };
  }

  const doc = await loadDocument(documentId);
  if (!doc) return { ok: false, error: "That document no longer exists." };

  const bill = doc.ewayBills[0] ?? null;
  if (!bill) return { ok: false, error: "Fill in the transport details first." };

  /**
   * A bill that has run out is not a bill this document still has.
   *
   * Refusing on "there is already a number here" left an expired document with no move at all:
   * raising was refused as a duplicate, editing Part A was refused because a bill existed, and
   * cancelling was not offered because the 24-hour window had passed. The document sat on the
   * outstanding list permanently and the only way out was the NIC portal by hand — which this app
   * then also refused to record. A lorry that breaks down for a day should not do that.
   *
   * So a live bill blocks a second one; an expired or cancelled one does not, and the new bill is
   * written over the spent row rather than beside it.
   */
  const spent =
    bill.status === "CANCELLED" || (bill.validUntil !== null && bill.validUntil.getTime() <= Date.now());
  if (bill.ewayBillNumber && !spent) {
    return { ok: false, error: `This document already has e-way bill ${bill.ewayBillNumber}.` };
  }
  if (bill.ewayBillNumber && bill.associated) {
    return {
      ok: false,
      error: `E-way bill ${bill.ewayBillNumber} was raised on the portal and has expired. Raise its replacement there too, then record it here.`,
    };
  }

  const missing = missingForGeneration({
    declaredValue: Number(bill.declaredValue),
    interstate: bill.interstate,
    distanceKm: bill.distanceKm,
    vehicleNumber: bill.vehicleNumber,
    transporterId: bill.transporter?.gstin ?? null,
  });
  if (missing.length > 0) return { ok: false, error: `Fill in ${missing.join(", ")} first.` };

  const org = await getOrganisation();
  const built = toEwayPayload(doc, bill, org);
  if ("problems" in built) return { ok: false, error: built.problems.join(" ") };

  /**
   * Claimed before the portal is called, in one statement the database settles.
   *
   * Everything above is a read, so two requests arriving together both got through all of it: both
   * saw no number on the row, both called NIC, and NIC issued **two live e-way bills for one
   * consignment**. The second overwrote the first in our row, so the first existed only on the
   * portal — not shown here, not cancellable from here, and still attached to the same goods. That
   * is the discrepancy a roadside check is looking for, and a double click on a slow connection is
   * enough to cause it.
   *
   * `updateMany` with the guard in the `where` is the whole mechanism: Postgres serialises the two
   * updates, the loser matches nothing and `count` comes back 0. A row claimed longer ago than
   * `EWAY_CLAIM_STALE_MS` is reclaimable, so a request that died mid-flight does not leave the
   * document permanently unable to raise a bill.
   */
  const claim = await db.ewayBill.updateMany({
    where: {
      id: bill.id,
      ewayBillNumber: bill.ewayBillNumber,
      OR: [{ generatingAt: null }, { generatingAt: { lt: new Date(Date.now() - EWAY_CLAIM_STALE_MS) } }],
    },
    data: { generatingAt: new Date() },
  });
  if (claim.count === 0) {
    return {
      ok: false,
      error: "This bill is already being raised. Give it a moment and refresh before trying again.",
    };
  }

  let result: Awaited<ReturnType<ReturnType<typeof createEwayProvider>["generate"]>>;
  try {
    result = await createEwayProvider(config).generate(built.doc);
  } catch (cause) {
    // Released on the way out, whatever happened — otherwise a thrown provider holds the claim for
    // the full stale window and the document cannot be retried for two minutes.
    await db.ewayBill.update({ where: { id: bill.id }, data: { generatingAt: null } });
    throw cause;
  }

  if (!result.ok) {
    // Recorded, not swallowed: "we tried and it said this" is a different thing to do about than
    // "nobody has tried".
    await db.ewayBill.update({
      where: { id: bill.id },
      data: { status: "FAILED", error: result.error, generatingAt: null },
    });
    revalidatePath(`/documents/${doc.id}`);
    return { ok: false, error: result.error };
  }

  await db.ewayBill.update({
    where: { id: bill.id },
    data: {
      ewayBillNumber: result.ewayBillNumber,
      ewayBillDate: result.ewayBillDate,
      validUntil: result.validUntil,
      status: "GENERATED",
      error: null,
      associated: false,
      generatingAt: null,
    },
  });

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "EwayBill",
    entityId: bill.id,
    entityLabel: `E-way bill ${result.ewayBillNumber} for ${doc.docNumber}`,
  });

  revalidatePath(`/documents/${doc.id}`);
  revalidatePath("/sales/eway-bills");
  return { ok: true, data: { ewayBillNumber: result.ewayBillNumber, validUntil: result.validUntil } };
}

/**
 * Records a bill raised on the portal by hand.
 *
 * Somebody was at the portal anyway, or the API was down, and the bill exists without this app
 * having made it. Recording it keeps the list honest — a document showing "not generated" when a
 * bill is sitting in a folder is worse than no list at all.
 *
 * Marked `associated`, because a bill we did not raise is one we cannot cancel or update through
 * the API. Offering buttons that would fail is worse than saying so.
 */
/**
 * Read a bill back from the portal, so associating one is twelve digits rather than a transcription.
 *
 * Deliberately does not write anything. It answers "what does NIC hold against this number" and
 * hands it to the screen for somebody to look at before they commit it — because the portal will
 * also happily return a bill raised against a different document, and that is worth seeing before
 * it is attached to this one.
 */
export async function lookupEwayBill(ewayBillNumber: string): Promise<
  ActionResult<{
    ewayBillNumber: string;
    ewayBillDate: Date;
    validUntil: Date;
    status: "GENERATED" | "CANCELLED";
    documentNumber: string | null;
    vehicleNumber: string | null;
    transporterName: string | null;
  }>
> {
  const { error } = await gate();
  if (error) return { ok: false, error };
  if (!(await ewayEnabled())) return { ok: false, error: DISABLED };

  const config = await getEInvoiceConfig();
  if (!config) return { ok: false, error: "The portal isn't set up, so a bill can't be looked up. Enter the dates by hand." };

  const result = await createEwayProvider(config).fetch(ewayBillNumber.replace(/\s/g, ""));
  if (!result.ok) return { ok: false, error: result.error };

  const { ok: _ok, ...data } = result;
  return { ok: true, data };
}

export async function associateEwayBill(input: {
  documentId: string;
  ewayBillNumber: string;
  ewayBillDate: string;
  validUntil: string;
}): Promise<ActionResult<{ id: string }>> {
  const { user, error } = await gate();
  if (error) return { ok: false, error };

  if (!(await ewayEnabled())) return { ok: false, error: DISABLED };

  const number = input.ewayBillNumber.replace(/\s/g, "");
  if (!/^\d{12}$/.test(number)) return { ok: false, error: "An e-way bill number is 12 digits." };

  // The day it was raised is a point; the day it runs until is a span that ends at midnight.
  const raised = startOfIndianDay(input.ewayBillDate);
  const until = endOfIndianDay(input.validUntil);
  if (!raised || !until) {
    return { ok: false, error: "Give the date it was raised and the last date it covers." };
  }
  if (until <= raised) return { ok: false, error: "It can't expire before it was raised." };

  const doc = await db.tradeDocument.findUnique({
    where: { id: input.documentId },
    select: {
      id: true,
      docNumber: true,
      total: true,
      // The same three sources `ewayForDocument` uses. Reading `total` alone recorded a six-lakh
      // challan as ₹0 of goods, and a bill worth nothing is dropped from the outstanding list the
      // moment it expires — so the movement it covered disappeared from the only screen that
      // would have flagged it.
      lines: { select: { quantity: true, unitPrice: true, taxableValue: true } },
      consignments: { select: { declaredValue: true, interstate: true } },
    },
  });
  if (!doc) return { ok: false, error: "That document no longer exists." };

  const existing = await db.ewayBill.findFirst({
    where: { documentId: doc.id, status: { not: "CANCELLED" } },
    orderBy: { createdAt: "desc" },
  });

  const data = {
    ewayBillNumber: number,
    ewayBillDate: raised,
    validUntil: until,
    status: "GENERATED" as const,
    associated: true,
    error: null,
  };

  const saved = existing
    ? await db.ewayBill.update({ where: { id: existing.id }, data, select: { id: true } })
    : await db.ewayBill.create({
        data: {
          ...data,
          documentId: doc.id,
          declaredValue: new Prisma.Decimal(
            documentGoodsValue({
              total: doc.total,
              consignmentValues: doc.consignments.map((c) => c.declaredValue),
              lines: doc.lines,
            }).toFixed(2),
          ),
          interstate: doc.consignments.some((c) => c.interstate),
          // Unknown and not worth inventing: this bill was not built here, and its validity came
          // from the portal rather than from our arithmetic.
          distanceKm: 1,
          createdById: user.id,
        },
        select: { id: true },
      });

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "EwayBill",
    entityId: saved.id,
    entityLabel: `Recorded e-way bill ${number} against ${doc.docNumber} (raised on the portal)`,
  });

  revalidatePath(`/documents/${doc.id}`);
  revalidatePath("/sales/eway-bills");
  return { ok: true, data: { id: saved.id } };
}

/** Part B: the vehicle, on a bill already issued. */
export async function updateEwayVehicle(input: {
  documentId: string;
  vehicleNumber: string;
  reasonCode: string;
  reasonNote?: string | null;
}): Promise<ActionResult<{ vehicleNumber: string }>> {
  const { user, error } = await gate();
  if (error) return { ok: false, error };

  if (!(await ewayEnabled())) return { ok: false, error: DISABLED };

  const config = await getEInvoiceConfig();
  if (!config) return { ok: false, error: "The portal isn't set up in Settings." };

  const bill = await db.ewayBill.findFirst({
    where: { documentId: input.documentId, status: "GENERATED" },
    orderBy: { createdAt: "desc" },
  });
  if (!bill?.ewayBillNumber) return { ok: false, error: "There is no live e-way bill on this document." };
  if (bill.associated) {
    return { ok: false, error: "This bill was raised on the portal, so its vehicle has to be changed there too." };
  }

  const vehicleNumber = normaliseVehicleNumber(input.vehicleNumber);
  if (!vehicleNumber) return { ok: false, error: "That doesn't look like a vehicle number." };

  const org = await getOrganisation();
  const result = await createEwayProvider(config).updateVehicle({
    ewayBillNumber: bill.ewayBillNumber,
    vehicleNumber,
    reasonCode: input.reasonCode,
    reasonNote: input.reasonNote?.trim() || "Vehicle assigned",
    fromPlace: org.city ?? "",
    fromStateCode: stateCodeFromGstin(org.gstin) ?? "",
    transportMode: bill.transportMode,
  });
  if (!result.ok) return { ok: false, error: result.error };

  // Stored only after the portal accepts it: our screen and the bill a check would see must not be
  // able to differ.
  await db.ewayBill.update({ where: { id: bill.id }, data: { vehicleNumber } });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "EwayBill",
    entityId: bill.id,
    entityLabel: `Vehicle ${vehicleNumber} on e-way bill ${bill.ewayBillNumber}`,
  });

  revalidatePath(`/documents/${input.documentId}`);
  return { ok: true, data: { vehicleNumber } };
}

export async function cancelEwayBill(input: {
  documentId: string;
  reasonCode: string;
  remark: string;
}): Promise<ActionResult<{ cancelled: true }>> {
  const { user, error } = await gate();
  if (error) return { ok: false, error };
  if (!(await ewayEnabled())) return { ok: false, error: DISABLED };

  const config = await getEInvoiceConfig();
  if (!config) return { ok: false, error: "The portal isn't set up in Settings." };

  const bill = await db.ewayBill.findFirst({
    where: { documentId: input.documentId, status: "GENERATED" },
    orderBy: { createdAt: "desc" },
  });
  if (!bill?.ewayBillNumber) return { ok: false, error: "There is no e-way bill to cancel." };
  if (bill.associated) {
    return { ok: false, error: "This bill was raised on the portal, so it has to be cancelled there." };
  }
  /**
   * Checked here as well as at the portal. The portal is the authority and will refuse it anyway,
   * but saying *why* before the round trip beats an error code.
   */
  if (!withinCancellationWindow(bill.ewayBillDate, new Date())) {
    return {
      ok: false,
      error: "An e-way bill can only be cancelled within 24 hours of being raised. This one is past that.",
    };
  }
  if (!input.remark.trim()) return { ok: false, error: "The portal wants a reason in words." };

  const result = await createEwayProvider(config).cancel(bill.ewayBillNumber, input.reasonCode, input.remark.trim());
  if (!result.ok) return { ok: false, error: result.error };

  await db.ewayBill.update({
    where: { id: bill.id },
    // The number stays: a cancelled bill is a fact about this despatch, and clearing it would leave
    // no record that one was ever raised.
    data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: input.remark.trim() },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "EwayBill",
    entityId: bill.id,
    entityLabel: `Cancelled e-way bill ${bill.ewayBillNumber} — ${input.remark.trim()}`,
  });

  revalidatePath(`/documents/${input.documentId}`);
  revalidatePath("/sales/eway-bills");
  return { ok: true, data: { cancelled: true } };
}

// ─── Settings ─────────────────────────────────────────────────────────────────────────────────

export type EwaySettings = {
  /** The module's own switch, separate from e-invoicing even though they share a login. */
  enabled: boolean;
  /** Null means the central ₹50,000 applies within the state too, which is the common case. */
  intraStateThreshold: number | null;
  configured: boolean;
  provider: string | null;
  username: string | null;
  gstin: string | null;
  stateCode: string | null;
};

/**
 * What the module is running on, said plainly.
 *
 * Deliberately shows the username and never the password: the credentials are the e-invoice
 * credentials, they are stored encrypted, and a settings screen that could print one back would
 * make the encryption decorative.
 */
export async function ewaySettings(): Promise<ActionResult<EwaySettings>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "Only an admin can change this." };

  const [row, org] = await Promise.all([
    db.organisationSettings.findUnique({
      where: { id: "global" },
      select: {
        ewayEnabled: true,
        ewayIntraStateThreshold: true,
        einvoiceEnabled: true,
        einvoiceProvider: true,
        einvoiceUsername: true,
      },
    }),
    getOrganisation(),
  ]);

  return {
    ok: true,
    data: {
      enabled: Boolean(row?.ewayEnabled),
      intraStateThreshold: row?.ewayIntraStateThreshold ? Number(row.ewayIntraStateThreshold) : null,
      configured: Boolean(row?.einvoiceEnabled),
      provider: row?.einvoiceProvider ?? null,
      username: row?.einvoiceUsername ?? null,
      gstin: org.gstin,
      stateCode: org.stateCode,
    },
  };
}

/**
 * The threshold inside our own state.
 *
 * Every state sets its own floor for movement that does not cross a border — ₹1,00,000 in
 * Maharashtra, ₹2,00,000 in Bihar, ₹50,000 in most — and getting it wrong is expensive in both
 * directions: too low and every desk that moves between offices raises a bill nobody needed, too
 * high and a real movement goes out bare. Inter-state is never affected; that floor is central and
 * not ours to set.
 */
/**
 * Turn e-way bills on or off.
 *
 * Its own switch rather than e-invoicing's, because plenty of businesses register for one and not
 * the other. Turning it off hides the module and stops anything being filed; it does not touch a
 * bill already raised, which belongs to the portal and to the lorry it is travelling on.
 */
export async function setEwayEnabled(input: { enabled: boolean }): Promise<ActionResult<{ enabled: boolean }>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "Only an admin can change this." };

  await db.organisationSettings.upsert({
    where: { id: "global" },
    create: { id: "global", ewayEnabled: input.enabled },
    update: { ewayEnabled: input.enabled },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "OrganisationSettings",
    entityId: "global",
    entityLabel: input.enabled ? "E-way bills enabled" : "E-way bills disabled",
  });

  revalidatePath("/settings/eway");
  revalidatePath("/sales/eway-bills");
  return { ok: true, data: { enabled: input.enabled } };
}

export async function saveEwayThreshold(input: { intraStateThreshold: number | null }): Promise<
  ActionResult<{ intraStateThreshold: number | null }>
> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "Only an admin can change this." };

  const value = input.intraStateThreshold;
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    return { ok: false, error: "The threshold should be a positive amount, or blank for the central ₹50,000." };
  }

  await db.organisationSettings.upsert({
    where: { id: "global" },
    create: {
      id: "global",
      ewayIntraStateThreshold: value === null ? null : new Prisma.Decimal(value.toFixed(2)),
    },
    update: { ewayIntraStateThreshold: value === null ? null : new Prisma.Decimal(value.toFixed(2)) },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "OrganisationSettings",
    entityId: "global",
    entityLabel:
      value === null
        ? "Intra-state e-way bill threshold reset to the central ₹50,000"
        : `Intra-state e-way bill threshold set to ₹${value.toLocaleString("en-IN")}`,
  });

  revalidatePath("/settings/eway");
  revalidatePath("/sales/eway-bills");
  return { ok: true, data: { intraStateThreshold: value } };
}
