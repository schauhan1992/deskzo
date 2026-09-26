"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type TradeDocumentType, type TradeDocumentStatus, type DocumentOrigin } from "@prisma/client";
import { db } from "@/lib/db";
import { CATEGORY_SELECT } from "@/lib/customers/categories";
import { can } from "@/lib/authz/resolve";
import { canSeeCompany, companyScope, viaCompanyScope } from "@/lib/authz/company-scope";
import { countryFeatureAvailable, requireModuleUser } from "@/lib/modules-access";
import { recordAudit } from "@/lib/audit";
import { postDocumentToLedger, reverseDocumentPosting } from "@/lib/ledger/journal";
import { toPlain } from "@/lib/serialize";
import { getOrganisation, getEInvoiceConfig } from "@/lib/organisation";
import {
  computeDocument,
  resolveSupplyType,
  stateCodeFromGstin,
  GST_STATE_CODES,
} from "@/lib/gst-engine";
import { isDraftNumber } from "@/lib/document-numbering";
import { dateRangeFilter } from "@/lib/utils";
import { nextDocumentNumber } from "@/lib/trade-number";
import {
  documentDirection,
  documentListPath,
  isEInvoiceEligible,
  isEditable,
  conversionTargets,
  manualStatuses,
  tradeDocumentLabels,
} from "@/lib/trade-documents";
import {
  tradeDocumentSchema,
  updateTradeDocumentSchema,
  issueTradeDocumentSchema,
  cancelEInvoiceSchema,
  convertTradeDocumentSchema,
  bulkUpdateTradeDocumentsSchema,
  type TradeDocumentInput,
} from "@/lib/validation/trade-document";
import { validateForEInvoice, type EInvoiceDocument } from "@/lib/einvoice/payload";
import { createEInvoiceProvider, CANCELLATION_WINDOW_HOURS, isWithinCancellationWindow } from "@/lib/einvoice/provider";
import { approvalAfterEdit, approvalRequirement, mayIssue } from "@/lib/documents/approval";
import { approvalDocumentFor, approvalPolicyFor } from "@/lib/documents/approval-policy";
import type { ActionResult } from "@/actions/company";
import { findTradeDocumentFor } from "@/lib/documents/load";
import { OTHER_COUNTRY_CODE } from "@/lib/gst-engine";
import { isIndia } from "@/lib/geo/countries";
import { viewerHas } from "@/actions/permission";

/**
 * Builds the next number for a type from its own prefix and serial, bumping the serial inside the
 * caller's transaction so two people creating at the same moment queue on the row rather than both
 * taking the same number.
 *
 * The per-type setting is the format; `DocumentCounter` remains the financial-year GST series and
 * is still advanced alongside, so the statutory sequence stays intact even if someone rewrites the
 * prefix midway through a year.
 */
/** Bumps the serial past a number typed in by hand, so auto-generation doesn't collide with it. */
async function advanceSerialPast(docType: TradeDocumentType, docNumber: string) {
  const setting = await db.documentNumberSetting.findUnique({ where: { docType } });
  if (!setting) return;
  const trailing = /(\d+)\s*$/.exec(docNumber);
  if (!trailing) return;
  const used = Number(trailing[1]);
  if (Number.isFinite(used) && used >= setting.nextNumber) {
    await db.documentNumberSetting.update({ where: { docType }, data: { nextNumber: used + 1 } });
  }
}


function parseDate(value: string | undefined | null, fallback?: Date): Date | null {
  if (!value) return fallback ?? null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? (fallback ?? null) : date;
}

/** A state name typed on a location, mapped back to its GST code — a fallback when there's no GSTIN. */
function stateCodeFromName(name?: string | null) {
  if (!name) return null;
  const target = name.trim().toLowerCase();
  const found = Object.entries(GST_STATE_CODES).find(([, label]) => label.toLowerCase() === target);
  return found?.[0] ?? null;
}

type PartyContext = {
  sellerGstin: string | null;
  buyerGstin: string | null;
  placeOfSupplyCode: string | null;
  /** The two state codes whose match decides CGST+SGST vs IGST. */
  supplyStates: { seller: string | null; destination: string | null };
};

/**
 * Who's selling to whom. On a sales document that's us to the customer; on a purchase document the
 * vendor is the seller and we're the destination — the tax split is the same comparison either way,
 * which is why both cases funnel into one pair of state codes.
 */
async function resolveParties(
  docType: TradeDocumentType,
  companyId: string,
  locationId: string | null,
  placeOfSupplyOverride: string | null,
): Promise<PartyContext> {
  const org = await getOrganisation();
  const location = locationId
    ? await db.companyLocation.findUnique({ where: { id: locationId } })
    : await db.companyLocation.findFirst({
        where: { companyId },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      });

  const orgState = org.stateCode ?? stateCodeFromGstin(org.gstin);
  const partyGstin = location?.gstNumber?.trim() || null;
  // A location abroad is "Other Country" (96) — and its state must never reach the Indian lookup,
  // where Pakistan's Punjab would come back as India's code 03.
  const partyState =
    stateCodeFromGstin(partyGstin) ?? (location && !isIndia(location.country) ? OTHER_COUNTRY_CODE : stateCodeFromName(location?.state));

  if (documentDirection[docType] === "SALES") {
    const destination = placeOfSupplyOverride || partyState;
    return {
      sellerGstin: org.gstin,
      buyerGstin: partyGstin,
      placeOfSupplyCode: destination,
      supplyStates: { seller: orgState, destination },
    };
  }
  // Purchase: the vendor supplies us, so the place of supply is our own state.
  const destination = placeOfSupplyOverride || orgState;
  return {
    sellerGstin: partyGstin,
    buyerGstin: org.gstin,
    placeOfSupplyCode: destination,
    supplyStates: { seller: partyState, destination },
  };
}

function lineData(input: TradeDocumentInput["lines"][number], computed: ReturnType<typeof computeDocument>["lines"][number], index: number) {
  return {
    itemId: input.itemId || null,
    companyProductId: input.companyProductId || null,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    hsnCode: input.hsnCode || null,
    unit: input.unit || null,
    quantity: new Prisma.Decimal(input.quantity),
    unitPrice: new Prisma.Decimal(input.unitPrice),
    discountMode: input.discountMode,
    discountValue: new Prisma.Decimal(input.discountValue),
    discountAmount: new Prisma.Decimal(computed.discountAmount),
    taxRatePercent: new Prisma.Decimal(input.taxRatePercent),
    taxableValue: new Prisma.Decimal(computed.taxableValue),
    cgstAmount: new Prisma.Decimal(computed.cgstAmount),
    sgstAmount: new Prisma.Decimal(computed.sgstAmount),
    igstAmount: new Prisma.Decimal(computed.igstAmount),
    lineTotal: new Prisma.Decimal(computed.lineTotal),
    sortOrder: index,
  };
}

/** Everything a create or an update writes, with the tax engine run over the submitted lines. */
async function buildDocumentData(data: TradeDocumentInput) {
  const org = await getOrganisation();
  const parties = await resolveParties(
    data.docType,
    data.companyId,
    data.locationId || null,
    data.placeOfSupplyCode || null,
  );
  const supplyType = resolveSupplyType(parties.supplyStates.seller, parties.supplyStates.destination);
  const totals = computeDocument(
    data.lines.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountMode: l.discountMode,
      discountValue: l.discountValue,
      taxRatePercent: l.taxRatePercent,
    })),
    supplyType,
    {
      shippingCharge: data.shippingCharge,
      shippingTaxRatePercent: data.shippingTaxRatePercent,
      withholdingMode: data.withholdingMode,
      withholdingRatePercent: data.withholdingRatePercent,
      adjustment: data.adjustment,
      roundOff: org.roundOffTotals,
    },
  );
  const issueDate = parseDate(data.issueDate, new Date()) as Date;
  // "Same as billing" is stored resolved rather than as a flag alone, so a printed document and the
  // e-invoice payload don't each have to re-derive where the goods went.
  const shipping = data.shippingSameAsBilling ? data.billing : data.shipping;

  return {
    totals,
    parties,
    issueDate,
    scalars: {
      docType: data.docType,
      direction: documentDirection[data.docType],
      companyId: data.companyId,
      locationId: data.locationId || null,
      placeOfSupplyCode: parties.placeOfSupplyCode,
      sellerGstin: parties.sellerGstin,
      // The form's GSTIN wins over the location's: it's what was actually agreed for this document.
      buyerGstin: (data.buyerGstin || parties.buyerGstin) || null,
      gstTreatment: data.gstTreatment,
      reverseCharge: data.reverseCharge,
      currency: data.currency,
      // Stored beside the amounts, not looked up later: the rate that matters is the one agreed
      // on the day, and a document reopened next year must still post at that rate.
      exchangeRate: data.exchangeRate,
      issueDate,
      dueDate: parseDate(data.dueDate),
      validUntil: parseDate(data.validUntil),
      reference: data.reference || null,
      salespersonId: data.salespersonId || null,
      notes: data.notes || null,
      terms: data.terms || null,

      dispatchFromAddress: data.dispatchFromAddress || null,
      billingAttention: data.billing.attention || null,
      billingLine1: data.billing.line1 || null,
      billingLine2: data.billing.line2 || null,
      billingCity: data.billing.city || null,
      billingState: data.billing.state || null,
      billingStateCode: data.billing.stateCode || null,
      billingPincode: data.billing.pincode || null,
      billingCountry: data.billing.country || "India",
      billingPhone: data.billing.phone || null,

      shippingSameAsBilling: data.shippingSameAsBilling,
      shippingAttention: shipping.attention || null,
      shippingLine1: shipping.line1 || null,
      shippingLine2: shipping.line2 || null,
      shippingCity: shipping.city || null,
      shippingState: shipping.state || null,
      shippingStateCode: shipping.stateCode || null,
      shippingPincode: shipping.pincode || null,
      shippingCountry: shipping.country || "India",
      shippingPhone: shipping.phone || null,
      shippingGstin: data.shippingGstin || null,

      subtotal: new Prisma.Decimal(totals.subtotal),
      discountTotal: new Prisma.Decimal(totals.discountTotal),
      taxableValue: new Prisma.Decimal(totals.taxableValue),
      cgstAmount: new Prisma.Decimal(totals.cgstAmount),
      sgstAmount: new Prisma.Decimal(totals.sgstAmount),
      igstAmount: new Prisma.Decimal(totals.igstAmount),
      shippingCharge: new Prisma.Decimal(totals.shippingCharge),
      shippingTaxRatePercent: new Prisma.Decimal(data.shippingTaxRatePercent),
      withholdingMode: data.withholdingMode,
      withholdingSection: data.withholdingSection || null,
      withholdingRatePercent: new Prisma.Decimal(data.withholdingRatePercent),
      withholdingAmount: new Prisma.Decimal(totals.withholdingAmount),
      adjustmentLabel: data.adjustmentLabel || null,
      adjustment: new Prisma.Decimal(totals.adjustment),
      roundOff: new Prisma.Decimal(totals.roundOff),
      total: new Prisma.Decimal(totals.total),
    },
    lines: data.lines.map((line, index) => lineData(line, totals.lines[index], index)),
  };
}

function revalidateDocument(docType: TradeDocumentType, id?: string) {
  revalidatePath(documentListPath[docType]);
  if (id) revalidatePath(`/documents/${id}`, "layout");
}

/** A reference to the document a conversion or credit note came from, checked to belong to the same party. */
async function validateLinkedDocument(
  linkedId: string,
  companyId: string,
  expected: TradeDocumentType[],
): Promise<string | null> {
  const linked = await db.tradeDocument.findUnique({
    where: { id: linkedId },
    select: { companyId: true, docType: true, status: true },
  });
  if (!linked) return "The linked document no longer exists.";
  if (linked.companyId !== companyId) return "The linked document belongs to a different party.";
  if (!expected.includes(linked.docType)) return "That document can't be linked to this one.";
  return null;
}

/**
 * A document may only be attributed to a lead belonging to the same party.
 *
 * Worth checking rather than trusting, because the link decides which deal a quotation counts
 * towards — and the company on the form can be changed after it was opened from a lead, which
 * would otherwise file the proposal under someone else's pipeline.
 */
async function validateLinkedLead(leadId: string | undefined, companyId: string): Promise<string | null> {
  if (!leadId) return null;
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { companyId: true } });
  if (!lead) return "That lead no longer exists.";
  if (lead.companyId !== companyId) return "That lead belongs to a different company.";
  return null;
}


/**
 * Who may write to a trade document.
 *
 * This module had no permission check of any kind: every one of its writes was reachable by any
 * signed-in session, including `generateEInvoice`, which registers an invoice with the government
 * against the company's GSTIN and cannot be undone after twenty-four hours. `check:rbac` passed it
 * because its bar is "resolves a session or checks a permission", which is deliberately lower than
 * correctness — resolving a session is not authorising anything.
 *
 * Reads stay on `requireModuleUser(["sales_documents", "purchase_documents"])` for the *permission* half: who may see a quote is a different
 * question from who may issue one, and gating reads on `documents.issue` would empty the document
 * lists embedded in the company, lead and project screens. The reads are narrowed instead by the
 * account scope below, which answers "whose customer is this" rather than "what may you do".
 */
async function mayWrite(key: "documents.issue" | "documents.void") {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  if (!(await can(user.id, key))) {
    return {
      user,
      error:
        key === "documents.void"
          ? "You don't have permission to delete or cancel a document."
          : "You don't have permission to raise or issue sales documents.",
    };
  }
  return { user, error: null as string | null };
}

/**
 * @param origin which part of the app is raising this — see `TradeDocument.origin`.
 *
 * A separate parameter rather than a field on the validated input, so the document form cannot
 * round-trip it and a caller has to state it deliberately. It is provenance for a column people
 * read, not a security claim: nothing is authorised on the strength of it.
 */
export async function createTradeDocument(
  input: unknown,
  origin: DocumentOrigin = "MANUAL",
): Promise<ActionResult<{ id: string }>> {
  const gate = await mayWrite("documents.issue");
  if (gate.error) return { ok: false, error: gate.error };
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  const parsed = tradeDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const company = await db.company.findUnique({
    where: { id: data.companyId },
    select: { id: true, name: true, ownerUserId: true },
  });
  if (!company) return { ok: false, error: "That party no longer exists." };

  if (data.locationId) {
    const location = await db.companyLocation.findUnique({ where: { id: data.locationId }, select: { companyId: true } });
    if (!location || location.companyId !== data.companyId) {
      return { ok: false, error: "That location doesn't belong to this party." };
    }
  }
  if (data.againstDocumentId) {
    if (data.docType !== "CREDIT_NOTE") return { ok: false, error: "Only a credit note is raised against an invoice." };
    const error = await validateLinkedDocument(data.againstDocumentId, data.companyId, ["INVOICE"]);
    if (error) return { ok: false, error };
  }
  if (data.docType === "CREDIT_NOTE" && !data.againstDocumentId) {
    return { ok: false, error: "A credit note must name the invoice it reduces." };
  }
  if (data.sourceDocumentId) {
    const error = await validateLinkedDocument(data.sourceDocumentId, data.companyId, [
      "PROPOSAL",
      "PROFORMA",
      "PURCHASE_ORDER",
    ]);
    if (error) return { ok: false, error };
  }
  const leadError = await validateLinkedLead(data.leadId, data.companyId);
  if (leadError) return { ok: false, error: leadError };

  const built = await buildDocumentData(data);
  // Zoho assigns the number when the document is created, not when it's issued, so it's visible and
  // editable on the form. A typed-in number is kept as-is and the serial is pushed past it.
  const docNumber = data.docNumber?.trim()
    ? data.docNumber.trim()
    : await db.$transaction((tx) => nextDocumentNumber(tx, data.docType, built.issueDate));
  if (data.docNumber?.trim()) await advanceSerialPast(data.docType, docNumber);

  const existing = await db.tradeDocument.findUnique({ where: { docNumber }, select: { id: true } });
  if (existing) return { ok: false, error: `${docNumber} is already used by another document.` };

  const created = await db.tradeDocument.create({
    data: {
      ...built.scalars,
      docNumber,
      status: "DRAFT",
      origin,
      // Only India has the government's e-invoice system; elsewhere it never applies.
      einvoiceStatus: isEInvoiceEligible(data.docType) && (await countryFeatureAvailable("einvoice")) ? "PENDING" : "NOT_APPLICABLE",
      sourceDocumentId: data.sourceDocumentId || null,
      againstDocumentId: data.againstDocumentId || null,
      leadId: data.leadId || null,
      createdById: user.id,
      salespersonId: data.salespersonId || company.ownerUserId || user.id,
      lines: { create: built.lines },
    },
    select: { id: true },
  });

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "TradeDocument",
    entityId: created.id,
    entityLabel: `${tradeDocumentLabels[data.docType]} for ${company.name}`,
  });
  revalidateDocument(data.docType, created.id);
  return { ok: true, data: { id: created.id } };
}

export async function updateTradeDocument(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await mayWrite("documents.issue");
  if (gate.error) return { ok: false, error: gate.error };
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  const parsed = updateTradeDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, ...data } = parsed.data;

  const existing = await db.tradeDocument.findUnique({
    where: { id },
    select: { id: true, status: true, approvalStatus: true, docType: true, companyId: true, docNumber: true },
  });
  if (!existing) return { ok: false, error: "That document no longer exists." };
  if (!isEditable(existing.status)) {
    return { ok: false, error: "An issued document can't be edited — raise a credit note instead." };
  }
  if (data.docType !== existing.docType) {
    return { ok: false, error: "A document's type can't be changed after it's created." };
  }
  if (data.locationId) {
    const location = await db.companyLocation.findUnique({ where: { id: data.locationId }, select: { companyId: true } });
    if (!location || location.companyId !== data.companyId) {
      return { ok: false, error: "That location doesn't belong to this party." };
    }
  }

  const leadError = await validateLinkedLead(data.leadId, data.companyId);
  if (leadError) return { ok: false, error: leadError };

  if (data.docNumber?.trim() && data.docNumber.trim() !== existing.docNumber) {
    const clash = await db.tradeDocument.findUnique({ where: { docNumber: data.docNumber.trim() }, select: { id: true } });
    if (clash && clash.id !== id) return { ok: false, error: `${data.docNumber.trim()} is already used by another document.` };
  }

  const built = await buildDocumentData(data);
  // Lines are replaced wholesale: the form submits the full set every time, and matching them up
  // row by row would only add a way for the stored totals to drift from the stored lines.
  await db.$transaction(async (tx) => {
    await tx.tradeDocumentLine.deleteMany({ where: { documentId: id } });
    await tx.tradeDocument.update({
      where: { id },
      data: {
        ...built.scalars,
        ...(data.docNumber?.trim() ? { docNumber: data.docNumber.trim() } : {}),
        leadId: data.leadId || null,
        /**
         * An approved document that is then edited is not the document that was approved.
         *
         * Without this the whole feature is decoration: get a ₹1,000 quote signed off, edit it to
         * ₹10,00,000, and the record still shows somebody else's name against a figure they never
         * saw. A pending one is left alone — nothing has been agreed to yet, and knocking it back
         * would quietly withdraw a request somebody is working through.
         */
        approvalStatus: approvalAfterEdit(existing.approvalStatus),
        ...(existing.approvalStatus === "APPROVED"
          ? { approvedById: null, approvedAt: null, approvalNote: null, submittedById: null, submittedAt: null }
          : {}),
        lines: { create: built.lines },
      },
    });
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "TradeDocument",
    entityId: id,
    entityLabel: tradeDocumentLabels[existing.docType],
  });
  revalidateDocument(existing.docType, id);
  return { ok: true, data: { id } };
}

export async function deleteTradeDocument(id: string): Promise<ActionResult<{ id: string }>> {
  const gate = await mayWrite("documents.void");
  if (gate.error) return { ok: false, error: gate.error };
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  const existing = await db.tradeDocument.findUnique({
    where: { id },
    select: { id: true, status: true, docType: true, docNumber: true, conversions: { select: { id: true } } },
  });
  if (!existing) return { ok: false, error: "That document no longer exists." };
  if (!isEditable(existing.status)) {
    return { ok: false, error: "Only a draft can be deleted. Cancel the document instead." };
  }
  if (existing.conversions.length > 0) {
    return { ok: false, error: "Other documents were created from this one, so it can't be deleted." };
  }

  await db.tradeDocument.delete({ where: { id } });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "TradeDocument",
    entityId: id,
    entityLabel: `Deleted draft ${tradeDocumentLabels[existing.docType].toLowerCase()}`,
  });
  revalidateDocument(existing.docType);
  return { ok: true, data: { id } };
}

/**
 * Commits a draft: it takes the next number in its series, is stamped with the issue time, and stops
 * being editable. For an invoice or credit note this is also where the IRN is requested, so a user
 * doesn't have to remember a second step.
 */
export async function issueTradeDocument(input: unknown): Promise<ActionResult<{ id: string; docNumber: string; einvoiceError?: string }>> {
  const gate = await mayWrite("documents.issue");
  if (gate.error) return { ok: false, error: gate.error };
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  const parsed = issueTradeDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, generateEInvoice: withEInvoice } = parsed.data;

  const existing = await db.tradeDocument.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      approvalStatus: true,
      docType: true,
      issueDate: true,
      total: true,
      docNumber: true,
      lines: { select: { id: true } },
    },
  });
  if (!existing) return { ok: false, error: "That document no longer exists." };
  if (existing.status !== "DRAFT") return { ok: false, error: "This document has already been issued." };
  if (existing.lines.length === 0) return { ok: false, error: "Add at least one line before issuing." };

  /**
   * Sign-off, where this type needs it.
   *
   * The gate sits on issuing rather than on drafting or editing, because issuing is the irreversible
   * half — it commits the number to a GST series and, for an invoice, files with the portal. Up to
   * that point a document can be changed freely, which is what makes sending one back useful.
   */
  // Measured against the document as it stands now, so an approved small quote edited up past the
  // limit needs approving again — its old approval was withdrawn by the edit (`approvalAfterEdit`).
  const [approvalPolicy, approvalFacts] = await Promise.all([approvalPolicyFor(existing.docType), approvalDocumentFor(existing.id)]);
  const approvalGate = mayIssue({
    policy: approvalPolicy,
    approvalStatus: existing.approvalStatus,
    document: approvalFacts ?? undefined,
  });
  if (!approvalGate.may) return { ok: false, error: approvalGate.why ?? "This needs approving first." };
  // Recorded when approval is on for the type but this one was under its limits — so "who let this
  // through unapproved?" has an answer in the log rather than a gap.
  const underLimits =
    approvalPolicy.enabled && approvalFacts && existing.approvalStatus !== "APPROVED" && !approvalRequirement(approvalPolicy, approvalFacts).required;

  // The number was assigned at creation, so issuing only commits the document — it doesn't take a
  // new serial. A document still carrying a DRAFT- marker (created before numbering moved forward)
  // gets one now.
  const docNumber = isDraftNumber(existing.docNumber)
    ? await db.$transaction(async (tx) => {
        const number = await nextDocumentNumber(tx, existing.docType, existing.issueDate);
        await tx.tradeDocument.update({ where: { id }, data: { docNumber: number } });
        return number;
      })
    : existing.docNumber;

  // Issuing and posting happen together: a document can't reach the customer without its ledger
  // entry, and an entry must never exist for a document that then failed to issue.
  const posting = await db.$transaction(async (tx) => {
    await tx.tradeDocument.update({ where: { id }, data: { status: "ISSUED", issuedAt: new Date() } });
    return postDocumentToLedger(tx, id, user.id);
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "TradeDocument",
    entityId: id,
    entityLabel: `Issued ${tradeDocumentLabels[existing.docType]} ${docNumber}`      + (posting ? ` · posted as ${posting.entryNumber}` : "")
      + (underLimits ? " · under the approval limits, so no sign-off was needed" : ""),
  });

  let einvoiceError: string | undefined;
  if (withEInvoice && isEInvoiceEligible(existing.docType)) {
    const org = await getOrganisation();
    // Below the configured threshold the invoice is simply not reportable, which is a normal
    // outcome rather than a failure — it stays NOT_APPLICABLE and nothing is sent to the portal.
    if (org.einvoiceMinValue !== null && Number(existing.total) < org.einvoiceMinValue) {
      await db.tradeDocument.update({ where: { id }, data: { einvoiceStatus: "NOT_APPLICABLE" } });
    } else {
      const result = await generateEInvoice_internal(id);
      if (!result.ok) einvoiceError = result.error;
    }
  }

  revalidateDocument(existing.docType, id);
  return { ok: true, data: { id, docNumber, einvoiceError } };
}

/** Assembles the portal's view of a document from what's stored, including both parties' addresses. */
async function loadEInvoiceDocument(id: string): Promise<{ doc: EInvoiceDocument } | { error: string }> {
  const document = await db.tradeDocument.findUnique({
    where: { id },
    include: {
      company: { select: { name: true } },
      location: true,
      lines: { orderBy: { sortOrder: "asc" } },
      againstDocument: { select: { docNumber: true, issueDate: true } },
    },
  });
  if (!document) return { error: "That document no longer exists." };
  if (!isEInvoiceEligible(document.docType)) {
    return { error: "Only a tax invoice or a credit note is reported to the portal." };
  }

  const org = await getOrganisation();
  const location = document.location;

  return {
    doc: {
      docType: document.docType as "INVOICE" | "CREDIT_NOTE",
      docNumber: document.docNumber,
      issueDate: document.issueDate,
      reverseCharge: document.reverseCharge,
      placeOfSupplyCode: document.placeOfSupplyCode,
      seller: {
        gstin: org.gstin,
        legalName: org.legalName,
        address1: org.addressLine1,
        address2: org.addressLine2,
        city: org.city,
        pincode: org.pincode,
        stateCode: org.stateCode ?? stateCodeFromGstin(org.gstin),
        phone: org.phone,
        email: org.email,
      },
      buyer: {
        gstin: document.buyerGstin,
        legalName: document.partyName ?? document.company.name,
        // The document's own billing address, falling back to the location it was taken from.
        address1: document.billingLine1 ?? location?.address ?? null,
        address2: document.billingLine2,
        city: document.billingCity ?? location?.city ?? null,
        pincode: document.billingPincode ?? location?.pincode ?? null,
        stateCode:
          document.billingStateCode ??
          stateCodeFromGstin(document.buyerGstin) ??
          stateCodeFromName(location?.state),
      },
      lines: document.lines.map((line) => ({
        description: line.description ? `${line.name} — ${line.description}` : line.name,
        // The portal wants goods and services distinguished; a line with no HSN and no unit is
        // treated as a service, which is what our subscription lines are.
        isService: !line.unit,
        hsnCode: line.hsnCode,
        quantity: Number(line.quantity),
        unit: line.unit,
        unitPrice: Number(line.unitPrice),
        grossAmount: Number(line.quantity) * Number(line.unitPrice),
        discountAmount: Number(line.discountAmount),
        taxableValue: Number(line.taxableValue),
        taxRatePercent: Number(line.taxRatePercent),
        cgstAmount: Number(line.cgstAmount),
        sgstAmount: Number(line.sgstAmount),
        igstAmount: Number(line.igstAmount),
        lineTotal: Number(line.lineTotal),
      })),
      taxableValue: Number(document.taxableValue),
      cgstAmount: Number(document.cgstAmount),
      sgstAmount: Number(document.sgstAmount),
      igstAmount: Number(document.igstAmount),
      roundOff: Number(document.roundOff),
      total: Number(document.total),
      againstDocNumber: document.againstDocument?.docNumber ?? null,
      againstDocDate: document.againstDocument?.issueDate ?? null,
    },
  };
}

/**
 * Shared by the "issue and report" path and the standalone retry button. A portal failure is stored
 * on the document rather than thrown, so the invoice stays issued and the error is visible and
 * retryable instead of disappearing into a stack trace.
 */
async function generateEInvoice_internal(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await countryFeatureAvailable("einvoice"))) return { ok: false, error: "E-invoicing is India's, and this workspace is set up for another country." };
  const loaded = await loadEInvoiceDocument(id);
  if ("error" in loaded) return { ok: false, error: loaded.error };

  const config = await getEInvoiceConfig();
  if (!config) {
    return { ok: false, error: "E-invoicing is switched off — turn it on in Settings → Organisation." };
  }

  const problems = validateForEInvoice(loaded.doc);
  if (problems.length > 0) {
    const message = problems.join(" ");
    await db.tradeDocument.update({ where: { id }, data: { einvoiceStatus: "FAILED", einvoiceError: message } });
    return { ok: false, error: message };
  }

  const provider = createEInvoiceProvider(config);
  const result = await provider.generate(loaded.doc);
  if (!result.ok) {
    await db.tradeDocument.update({ where: { id }, data: { einvoiceStatus: "FAILED", einvoiceError: result.error } });
    return { ok: false, error: result.error };
  }

  await db.tradeDocument.update({
    where: { id },
    data: {
      einvoiceStatus: "GENERATED",
      irn: result.irn,
      ackNo: result.ackNo,
      ackDate: result.ackDate,
      signedQrCode: result.signedQrCode,
      einvoiceError: null,
    },
  });
  return { ok: true };
}

export async function generateEInvoice(id: string): Promise<ActionResult<{ id: string }>> {
  const gate = await mayWrite("documents.issue");
  if (gate.error) return { ok: false, error: gate.error };
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  if (!(await countryFeatureAvailable("einvoice"))) return { ok: false, error: "E-invoicing is India's, and this workspace is set up for another country." };
  const document = await db.tradeDocument.findUnique({
    where: { id },
    select: { status: true, docType: true, irn: true, total: true },
  });
  if (!document) return { ok: false, error: "That document no longer exists." };
  if (document.status === "DRAFT") return { ok: false, error: "Issue the document before reporting it to the portal." };
  if (document.irn) return { ok: false, error: "This document already has an IRN." };
  const org = await getOrganisation();
  if (org.einvoiceMinValue !== null && Number(document.total) < org.einvoiceMinValue) {
    return {
      ok: false,
      error: `This document is below the ${org.einvoiceMinValue} minimum set for e-invoicing, so it isn't reported to the portal.`,
    };
  }

  const result = await generateEInvoice_internal(id);
  revalidateDocument(document.docType, id);
  if (!result.ok) return { ok: false, error: result.error };

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "TradeDocument",
    entityId: id,
    entityLabel: "Generated IRN",
  });
  return { ok: true, data: { id } };
}

export async function cancelEInvoice(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await mayWrite("documents.void");
  if (gate.error) return { ok: false, error: gate.error };
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  if (!(await countryFeatureAvailable("einvoice"))) return { ok: false, error: "E-invoicing is India's, and this workspace is set up for another country." };
  const parsed = cancelEInvoiceSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, reason, remark } = parsed.data;

  const document = await db.tradeDocument.findUnique({
    where: { id },
    select: { irn: true, ackDate: true, docType: true, einvoiceStatus: true },
  });
  if (!document) return { ok: false, error: "That document no longer exists." };
  if (!document.irn || document.einvoiceStatus !== "GENERATED") {
    return { ok: false, error: "There's no active IRN on this document to cancel." };
  }
  // The portal refuses a cancellation after 24 hours — say so here rather than making the user wait
  // for a round trip to be told the same thing in portal-speak.
  if (!isWithinCancellationWindow(document.ackDate)) {
    return {
      ok: false,
      error: `The ${CANCELLATION_WINDOW_HOURS}-hour cancellation window has passed — raise a credit note instead.`,
    };
  }

  const config = await getEInvoiceConfig();
  if (!config) return { ok: false, error: "E-invoicing is switched off." };

  const provider = createEInvoiceProvider(config);
  const result = await provider.cancel(document.irn, reason, remark);
  if (!result.ok) return { ok: false, error: result.error };

  await db.$transaction(async (tx) => {
    await tx.tradeDocument.update({
      where: { id },
      data: {
        einvoiceStatus: "CANCELLED",
        einvoiceCancelledAt: new Date(),
        einvoiceCancelReason: remark,
        status: "CANCELLED",
      },
    });
    await reverseDocumentPosting(tx, id, user.id);
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "TradeDocument",
    entityId: id,
    entityLabel: "Cancelled IRN",
  });
  revalidateDocument(document.docType, id);
  return { ok: true, data: { id } };
}

/**
 * Proposal → proforma → invoice, or PO → bill. The new document is a fresh draft copied from the
 * source and linked back to it, so the original stays exactly as it was sent to the customer.
 */
export async function convertTradeDocument(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await mayWrite("documents.issue");
  if (gate.error) return { ok: false, error: gate.error };
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  const parsed = convertTradeDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, target } = parsed.data;

  const source = await db.tradeDocument.findUnique({
    where: { id },
    include: { lines: { orderBy: { sortOrder: "asc" } } },
  });
  if (!source) return { ok: false, error: "That document no longer exists." };
  if (!conversionTargets[source.docType]?.includes(target)) {
    return { ok: false, error: `A ${tradeDocumentLabels[source.docType].toLowerCase()} can't become a ${tradeDocumentLabels[target].toLowerCase()}.` };
  }
  if (source.status === "CANCELLED" || source.status === "REJECTED") {
    return { ok: false, error: "A cancelled or rejected document can't be converted." };
  }
  // A credit note is a correction, not a conversion — it carries `againstDocumentId`, and the
  // amounts are usually different, so it's raised through the normal create path.
  const isCreditNote = target === "CREDIT_NOTE";

  const created = await db.tradeDocument.create({
    data: {
      docNumber: await db.$transaction((tx) => nextDocumentNumber(tx, target, new Date())),
      docType: target,
      direction: documentDirection[target],
      status: "DRAFT",
      // Not a parameter: this path exists only to convert, so the origin is a fact about the path.
      origin: "CONVERSION",
      companyId: source.companyId,
      locationId: source.locationId,
      placeOfSupplyCode: source.placeOfSupplyCode,
      sellerGstin: source.sellerGstin,
      buyerGstin: source.buyerGstin,
      gstTreatment: source.gstTreatment,
      reverseCharge: source.reverseCharge,
      currency: source.currency,
      exchangeRate: source.exchangeRate,
      dispatchFromAddress: source.dispatchFromAddress,
      billingAttention: source.billingAttention,
      billingLine1: source.billingLine1,
      billingLine2: source.billingLine2,
      billingCity: source.billingCity,
      billingState: source.billingState,
      billingStateCode: source.billingStateCode,
      billingPincode: source.billingPincode,
      billingCountry: source.billingCountry,
      billingPhone: source.billingPhone,
      shippingSameAsBilling: source.shippingSameAsBilling,
      shippingAttention: source.shippingAttention,
      shippingLine1: source.shippingLine1,
      shippingLine2: source.shippingLine2,
      shippingCity: source.shippingCity,
      shippingState: source.shippingState,
      shippingStateCode: source.shippingStateCode,
      shippingPincode: source.shippingPincode,
      shippingCountry: source.shippingCountry,
      shippingPhone: source.shippingPhone,
      shippingGstin: source.shippingGstin,
      shippingCharge: source.shippingCharge,
      shippingTaxRatePercent: source.shippingTaxRatePercent,
      withholdingMode: source.withholdingMode,
      withholdingSection: source.withholdingSection,
      withholdingRatePercent: source.withholdingRatePercent,
      withholdingAmount: source.withholdingAmount,
      adjustmentLabel: source.adjustmentLabel,
      adjustment: source.adjustment,
      issueDate: new Date(),
      reference: source.reference,
      notes: source.notes,
      terms: source.terms,
      subtotal: source.subtotal,
      discountTotal: source.discountTotal,
      taxableValue: source.taxableValue,
      cgstAmount: source.cgstAmount,
      sgstAmount: source.sgstAmount,
      igstAmount: source.igstAmount,
      roundOff: source.roundOff,
      total: source.total,
      einvoiceStatus: isEInvoiceEligible(target) ? "PENDING" : "NOT_APPLICABLE",
      sourceDocumentId: isCreditNote ? null : source.id,
      againstDocumentId: isCreditNote ? source.id : null,
      // The deal follows the conversion. A proposal that becomes an invoice is still that deal
      // closing, and the lead's own page should show the whole chain rather than losing sight of
      // it the moment the quotation turns into something billable.
      leadId: source.leadId,
      createdById: user.id,
      salespersonId: source.salespersonId,
      lines: {
        create: source.lines.map((line, index) => ({
          itemId: line.itemId,
          companyProductId: line.companyProductId,
          name: line.name,
          description: line.description,
          hsnCode: line.hsnCode,
          unit: line.unit,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountMode: line.discountMode,
          discountValue: line.discountValue,
          discountAmount: line.discountAmount,
          taxRatePercent: line.taxRatePercent,
          taxableValue: line.taxableValue,
          cgstAmount: line.cgstAmount,
          sgstAmount: line.sgstAmount,
          igstAmount: line.igstAmount,
          lineTotal: line.lineTotal,
          sortOrder: index,
        })),
      },
    },
    select: { id: true },
  });

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "TradeDocument",
    entityId: created.id,
    entityLabel: `${tradeDocumentLabels[target]} from ${source.docNumber}`,
  });
  revalidateDocument(target, created.id);
  revalidateDocument(source.docType, source.id);
  return { ok: true, data: { id: created.id } };
}

export async function setTradeDocumentStatus(id: string, status: TradeDocumentStatus): Promise<ActionResult<{ id: string }>> {
  const gate = await mayWrite("documents.void");
  if (gate.error) return { ok: false, error: gate.error };
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  const document = await db.tradeDocument.findUnique({
    where: { id },
    select: { docType: true, status: true, docNumber: true, einvoiceStatus: true },
  });
  if (!document) return { ok: false, error: "That document no longer exists." };
  if (document.status === "DRAFT") return { ok: false, error: "Issue the document before changing its status." };
  if (!manualStatuses[document.docType].includes(status)) {
    return { ok: false, error: "That status can't be set on this document." };
  }
  // Cancelling a reported invoice has to go through the portal, or our records and the IRP's diverge.
  if (status === "CANCELLED" && document.einvoiceStatus === "GENERATED") {
    return { ok: false, error: "This invoice has an active IRN — cancel that with the portal first." };
  }

  await db.$transaction(async (tx) => {
    await tx.tradeDocument.update({ where: { id }, data: { status } });
    // A cancelled document is reversed rather than unposted: the original entry stays in the
    // journal and a dated reversal sits beside it, which is what an audit trail means.
    if (status === "CANCELLED") await reverseDocumentPosting(tx, id, user.id);
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "TradeDocument",
    entityId: id,
    entityLabel: `${document.docNumber} → ${status.toLowerCase().replace(/_/g, " ")}`,
  });
  revalidateDocument(document.docType, id);
  return { ok: true, data: { id } };
}

/**
 * The account-scope guard for a function handed a `companyId` by its caller.
 *
 * Filtering achieves nothing on these — the caller has already named the party — so the company is
 * looked up for its account manager and the answer is a refusal rather than a shorter list. A party
 * that no longer exists is refused the same way, so a company id can't be used to find out which
 * accounts are real.
 */
async function maySeeParty(userId: string, companyId: string): Promise<boolean> {
  const company = await db.company.findUnique({ where: { id: companyId }, select: { ownerUserId: true } });
  return company !== null && (await canSeeCompany(userId, company.ownerUserId));
}

/** Full document for the detail and print views, with Decimals flattened for the client. */
export async function getTradeDocument(id: string) {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  if (!(await viewerHas("documents.view"))) return null;
  return findTradeDocumentFor(user.id, id);
}

/**
 * Everything raised from one deal — proposals first, then whatever they became.
 *
 * Ordered newest first so the current quotation is the one at the top, which is what someone
 * opening a lead is almost always after.
 */
export async function listLeadDocuments(leadId: string) {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  if (!(await viewerHas("documents.view"))) return [];
  const rows = await db.tradeDocument.findMany({
    // Scoped through the party rather than through the lead: a document is only ever raised for the
    // lead's own company (`validateLinkedLead` keeps the two in step), so the party is the same
    // path every other query here takes, and it needs no join the document doesn't already have.
    where: { leadId, ...(await viaCompanyScope(user.id)) },
    orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      docNumber: true,
      docType: true,
      status: true,
      issueDate: true,
      validUntil: true,
      total: true,
      currency: true,
      salesperson: { select: { id: true, name: true } },
    },
  });
  return toPlain(rows);
}

/** Paginated list for a single document type — one query behind all six list screens. */
export async function listTradeDocuments(params: {
  docType: TradeDocumentType;
  status?: TradeDocumentStatus;
  search?: string;
  /** Issue-date window, inclusive at both ends. */
  from?: string;
  to?: string;
  salespersonId?: string;
  /** A `DocumentOrigin`, or the literal "none" for documents that never recorded one. */
  origin?: string;
  page: number;
  pageSize: number;
}) {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  if (!(await viewerHas("documents.view"))) return { rows: [], total: 0 };
  const dateWindow = dateRangeFilter(params.from, params.to);
  const where: Prisma.TradeDocumentWhereInput = {
    // One `where` for the rows and the count both — a scope on the page that the pager doesn't
    // know about offers page 9 of a list that ends at page 2.
    //
    /**
     * The scope goes in `AND`, not spread into this literal.
     *
     * `viaCompanyScope` returns `{ company: { ownerUserId: { in: ids } } }`, so any later `company:`
     * key in the same object literal replaces it wholesale and the access scope silently disappears.
     * Nothing did that today, but a party filter is the obvious next addition and it would — the
     * same reasoning, and the same fix, as `listOrders` in src/actions/order.ts.
     */
    AND: [(await viaCompanyScope(user.id)) as Prisma.TradeDocumentWhereInput],
    docType: params.docType,
    ...(params.status ? { status: params.status } : {}),
    /**
     * The window is built in the server's own timezone, which is what `dateRangeFilter` does and
     * what all eleven other filtered lists use. Deliberately not `startOfIndianDay` here: doing it
     * for documents alone would make this list disagree with every other one about where a day ends.
     */
    ...(dateWindow ? { issueDate: dateWindow } : {}),
    ...(params.salespersonId ? { salespersonId: params.salespersonId } : {}),
    // "none" is a real answer, not an absent filter: it finds the documents written by a path that
    // never said where it came from, which is exactly what somebody auditing the Source column wants.
    ...(params.origin === "none"
      ? { origin: null }
      : params.origin
        ? { origin: params.origin as DocumentOrigin }
        : {}),
    ...(params.search
      ? {
          OR: [
            { docNumber: { contains: params.search, mode: "insensitive" as const } },
            { reference: { contains: params.search, mode: "insensitive" as const } },
            { company: { name: { contains: params.search, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.tradeDocument.findMany({
      where,
      orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      select: {
        id: true,
        docNumber: true,
        status: true,
        issueDate: true,
        dueDate: true,
        total: true,
        currency: true,
        einvoiceStatus: true,
        irn: true,
        reference: true,
        approvalStatus: true,
        origin: true,
        // What a conversion came from, so the Source column can link to it rather than only name it.
        sourceDocument: { select: { id: true, docNumber: true, docType: true } },
        company: { select: { id: true, name: true, relationshipType: true } },
        createdBy: { select: { name: true } },
        salesperson: { select: { id: true, name: true } },
      },
    }),
    db.tradeDocument.count({ where }),
  ]);

  return { rows: toPlain(rows), total };
}

/** Totals for the cards above a list — what's outstanding, and what's stuck in draft. */
export async function tradeDocumentSummary(docType: TradeDocumentType) {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  if (!(await viewerHas("documents.view"))) return [];
  // The same scope as the list under it, in both halves: a card reading "₹4.2 crore outstanding"
  // over a list of eleven invoices is the whole book by another route, and the count and the value
  // are separate queries that would each leak it on their own.
  const scope = await viaCompanyScope(user.id);
  // Counts group in SQL; the value cannot. Adding a dollar total to a rupee one gives a number
  // that is no currency at all, so the rupee equivalent is summed instead — each document at
  // the rate it was raised on, which is what the ledger did with it too.
  const [grouped, rows] = await Promise.all([
    db.tradeDocument.groupBy({
      by: ["status"],
      where: { docType, ...scope },
      _count: { _all: true },
    }),
    db.tradeDocument.findMany({
      where: { docType, ...scope },
      select: { status: true, total: true, exchangeRate: true },
    }),
  ]);

  const baseValue = new Map<string, number>();
  for (const r of rows) {
    const inr = Number(r.total) * (Number(r.exchangeRate) || 1);
    baseValue.set(r.status, (baseValue.get(r.status) ?? 0) + inr);
  }
  return grouped.map((g) => ({
    status: g.status,
    count: g._count._all,
    total: Math.round((baseValue.get(g.status) ?? 0) * 100) / 100,
  }));
}

/**
 * Parties for the document form's picker. Sales documents go to customers and resellers; purchase
 * documents go to vendors — mixing them is how a PO ends up addressed to a client.
 */
export async function listDocumentParties(docType: TradeDocumentType) {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  const salesTypes: Prisma.EnumCompanyRelationshipTypeFilter = { in: ["CLIENT", "RESELLER"] };
  const purchaseTypes: Prisma.EnumCompanyRelationshipTypeFilter = {
    in: ["VENDOR", "OEM", "DISTRIBUTOR", "PARTNER"],
  };
  return db.company.findMany({
    where: {
      // A picker over the customer book, so it is scoped like the book: without this it hands every
      // account name in the business to anybody who can open the new-document form. Purchase
      // parties narrow the same way — the roles that raise purchase documents hold
      // `companies.viewAll`, which is what makes that the same rule rather than a second one.
      ...(await companyScope(user.id)),
      relationshipType: documentDirection[docType] === "SALES" ? salesTypes : purchaseTypes,
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, relationshipType: true, customerCategory: { select: CATEGORY_SELECT } },
  });
}

/** The party's locations, with the GST details the form needs to show the place of supply. */
export async function listPartyLocations(companyId: string) {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  // The form only offers parties from `listDocumentParties`, which is now scoped — but this is a
  // server action reachable with any id, and a location carries the customer's address and GSTIN.
  if (!(await maySeeParty(user.id, companyId))) return [];
  return db.companyLocation.findMany({
    where: { companyId },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    select: { id: true, label: true, address: true, city: true, state: true, pincode: true, country: true, gstNumber: true, gstTreatment: true, isPrimary: true },
  });
}

/** Catalogue lookup for the line-item picker, pre-filled with price, tax rate, HSN and unit. */
export async function listDocumentItems(search?: string) {
  await requireModuleUser(["sales_documents", "purchase_documents"]);
  const rows = await db.item.findMany({
    where: {
      active: true,
      ...(search ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { sku: { contains: search, mode: "insensitive" } }] } : {}),
    },
    orderBy: { name: "asc" },
    take: 50,
    select: { id: true, name: true, sku: true, description: true, unit: true, hsnCode: true, sellingPrice: true, taxRatePercent: true },
  });
  return toPlain(rows);
}

/** Open invoices a credit note can be raised against, for the "against" picker. */
export async function listCreditableInvoices(companyId: string) {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  if (!(await viewerHas("documents.view"))) return [];
  if (!(await maySeeParty(user.id, companyId))) return [];
  const rows = await db.tradeDocument.findMany({
    where: { companyId, docType: "INVOICE", status: { notIn: ["DRAFT", "CANCELLED"] } },
    orderBy: { issueDate: "desc" },
    take: 50,
    select: { id: true, docNumber: true, issueDate: true, total: true },
  });
  return toPlain(rows);
}

/**
 * Every trade document raised for one company, for the 360 view on its profile. Sales and purchase
 * documents both come back: a company can be both sides of the relationship over time, and hiding
 * one of them on its own page is exactly the kind of gap the 360 view exists to close.
 */
export async function listCompanyDocuments(companyId: string) {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  if (!(await viewerHas("documents.view"))) return [];
  // The 360 view is only as private as the account it hangs off: every invoice ever raised for a
  // company, with its numbers and its totals, answered to whoever knew the id.
  if (!(await maySeeParty(user.id, companyId))) return [];
  const rows = await db.tradeDocument.findMany({
    where: { companyId },
    orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      docNumber: true,
      docType: true,
      direction: true,
      status: true,
      issueDate: true,
      dueDate: true,
      validUntil: true,
      total: true,
      reference: true,
      einvoiceStatus: true,
      irn: true,
      createdBy: { select: { name: true } },
    },
  });
  return toPlain(rows);
}

/**
 * Bulk issue / status / delete from a document list. Every row goes through the single-document
 * action, so numbering stays transactional, the e-invoice rules still apply, and a document that
 * isn't in a state to change is counted as skipped rather than failing the whole batch.
 */
export async function bulkUpdateTradeDocuments(input: unknown): Promise<ActionResult<{ count: number; skipped: number }>> {
  const gate = await mayWrite("documents.issue");
  if (gate.error) return { ok: false, error: gate.error };
  await requireModuleUser(["sales_documents", "purchase_documents"]);
  const parsed = bulkUpdateTradeDocumentsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { documentIds, action, status } = parsed.data;
  if (action === "status" && !status) return { ok: false, error: "Pick a status to apply." };

  const org = await getOrganisation();
  let changed = 0;
  let skipped = 0;

  for (const id of documentIds) {
    const result =
      action === "issue"
        ? await issueTradeDocument({ id, generateEInvoice: org.einvoiceEnabled })
        : action === "delete"
          ? await deleteTradeDocument(id)
          : await setTradeDocumentStatus(id, status as TradeDocumentStatus);
    if (result.ok) changed += 1;
    else skipped += 1;
  }

  return { ok: true, data: { count: changed, skipped } };
}
