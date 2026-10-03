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
import { getOrganisation, eInvoiceConfigFor } from "@/lib/organisation";
import {
  computeDocument,
  resolveSupplyType,
  stateCodeFromGstin,
  GST_STATE_CODES,
} from "@/lib/gst-engine";
import { GST_NUMBERED_TYPES, gstNumberProblem, isDraftNumber } from "@/lib/document-numbering";
import { workspaceClock } from "@/lib/time/workspace";
import { calendarDayRange } from "@/lib/time/zone";
import { advanceSerialPast, isAutoNumberOf, nextDocumentNumber, seriesFor } from "@/lib/trade-number";
import { branchFilter, branchIdentity, defaultBranchIdFor, ensureHeadOffice, type BranchWithRegistration } from "@/lib/branches/identity";
import { branchLabel, type BranchIdentity } from "@/lib/branches/format";
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
import { periodDay } from "@/lib/documents/service-period";
import { releaseBillingMilestones, syncBillingMilestones } from "@/lib/projects/billing-sync";
import { moduleAccessFor } from "@/lib/modules-access";

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

/**
 * Both sides of a document, as GSTINs and states. "Ours" is the branch's registration whichever way the
 * goods go: the seller on a sale, the buyer on a purchase. `partyGstin` is the location's on file — the
 * form's own GSTIN field overrides it in `buildDocumentData`.
 */
type PartyContext = {
  ourGstin: string | null;
  partyGstin: string | null;
  placeOfSupplyCode: string | null;
  /** The two state codes whose match decides CGST+SGST vs IGST. */
  supplyStates: { seller: string | null; destination: string | null };
};

/**
 * Who's selling to whom. On a sales document that's our branch to the customer; on a purchase document
 * the vendor is the seller and our branch is the destination — the tax split is the same comparison
 * either way, which is why both cases funnel into one pair of state codes. "Our" state is the branch's
 * GST state, not the registered office's: a Bengaluru branch billing a Bengaluru customer is intra-state
 * whatever state the company is registered in.
 */
async function resolveParties(
  docType: TradeDocumentType,
  companyId: string,
  locationId: string | null,
  placeOfSupplyOverride: string | null,
  identity: BranchIdentity,
): Promise<PartyContext> {
  const location = locationId
    ? await db.companyLocation.findUnique({ where: { id: locationId } })
    : await db.companyLocation.findFirst({
        where: { companyId },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      });

  const ourState = identity.stateCode;
  const partyGstin = location?.gstNumber?.trim() || null;
  // A location abroad is "Other Country" (96) — and its state must never reach the Indian lookup,
  // where Pakistan's Punjab would come back as India's code 03.
  const partyState =
    stateCodeFromGstin(partyGstin) ?? (location && !isIndia(location.country) ? OTHER_COUNTRY_CODE : stateCodeFromName(location?.state));

  if (documentDirection[docType] === "SALES") {
    const destination = placeOfSupplyOverride || partyState;
    return {
      ourGstin: identity.gstin,
      partyGstin,
      placeOfSupplyCode: destination,
      supplyStates: { seller: ourState, destination },
    };
  }
  // Purchase: the vendor supplies our branch, so the place of supply is the buying branch's state.
  const destination = placeOfSupplyOverride || ourState;
  return {
    ourGstin: identity.gstin,
    partyGstin,
    placeOfSupplyCode: destination,
    supplyStates: { seller: partyState, destination },
  };
}

function branchWithRegistration(id: string): Promise<BranchWithRegistration | null> {
  return db.branch.findUnique({ where: { id }, include: { gstRegistration: true } });
}

/**
 * The branch a document is raised from (on a purchase, bought by) — spec §5.1:
 *
 *   1. A credit note: always its invoice's, since it must go out under the GSTIN the invoice did. Any
 *      other branch asked for is refused. Allowed on a branch deactivated since, while its GSTIN is live.
 *   2. An update: the branch asked for, else the draft's own.
 *   3. A create: the branch asked for, else the user's home branch, else the head office.
 *   4. It must exist and be active — except (1), and a draft keeping the branch it already had (it can
 *      be saved there, not issued).
 *
 * A document written before branches (null) is the head office's. Runs before any transaction: the
 * helpers here use their own connection and may write (`ensureHeadOffice` adopts unassigned rows).
 */
async function resolveDocumentBranch(input: {
  userId: string;
  docType: TradeDocumentType;
  requestedBranchId: string | null | undefined;
  againstDocumentId: string | null | undefined;
  existing?: { branchId: string | null };
}): Promise<{ branch: BranchWithRegistration } | { error: string }> {
  const requested = input.requestedBranchId?.trim() || null;

  if (input.docType === "CREDIT_NOTE" && input.againstDocumentId) {
    const invoice = await db.tradeDocument.findUnique({ where: { id: input.againstDocumentId }, select: { branchId: true } });
    const branch = (invoice?.branchId ? await branchWithRegistration(invoice.branchId) : null) ?? (await ensureHeadOffice());
    if (requested && requested !== branch.id) return { error: "A credit note is raised by the branch that issued the invoice." };
    if (!branch.active && branch.gstRegistration && !branch.gstRegistration.active) {
      return {
        error: `Branch ${branch.name} is inactive, and so is its GSTIN ${branch.gstRegistration.gstin}. Reactivate the GSTIN under Settings → Branches & GST registrations to raise a credit note against this invoice.`,
      };
    }
    return { branch };
  }

  const draft = input.existing;
  const targetId = requested ?? (draft ? draft.branchId : await defaultBranchIdFor(input.userId));
  // A draft written before branches has none: it is the head office's.
  const branch = targetId ? await branchWithRegistration(targetId) : await ensureHeadOffice();
  if (!branch) return { error: "That branch no longer exists. Choose another one." };
  const keepsDraftBranch = draft !== undefined && (draft.branchId ? branch.id === draft.branchId : branch.isHeadOffice);
  if (!branch.active && !keepsDraftBranch) return { error: `Branch ${branch.name} is inactive. Choose another branch.` };
  return { branch };
}

/**
 * The links a save may write on its lines, checked rather than trusted — the form is not the only
 * thing that can post here.
 *
 *   · `companyProductId` must be one of this party's own orders (or, on a purchase, one it supplies):
 *     a line pointing at another customer's order would bill their subscription on this invoice.
 *   · `billingMilestoneId` is "Raise invoice"'s to set (src/actions/project.ts). A new document never
 *     carries one; an edited draft keeps a line's only while the stage still points at this document,
 *     so the form can round-trip it and nothing else can attach a stage to a document.
 */
async function checkLineLinks(
  lines: TradeDocumentInput["lines"],
  companyId: string,
  documentId: string | null,
): Promise<{ error: string } | { lines: TradeDocumentInput["lines"] }> {
  const orderIds = [...new Set(lines.map((l) => l.companyProductId).filter((v): v is string => !!v))];
  const orders = orderIds.length
    ? await db.companyProduct.findMany({ where: { id: { in: orderIds } }, select: { id: true, companyId: true, vendorId: true } })
    : [];
  for (const [index, line] of lines.entries()) {
    if (!line.companyProductId) continue;
    const order = orders.find((o) => o.id === line.companyProductId);
    if (!order) return { error: `Line ${index + 1} bills an order that no longer exists.` };
    if (order.companyId !== companyId && order.vendorId !== companyId) {
      return { error: `Line ${index + 1} bills an order that belongs to another party.` };
    }
  }

  const stageIds = documentId ? [...new Set(lines.map((l) => l.billingMilestoneId).filter((v): v is string => !!v))] : [];
  const linked = stageIds.length
    ? await db.projectBillingMilestone.findMany({ where: { id: { in: stageIds }, documentId }, select: { id: true } })
    : [];
  const keep = new Set(linked.map((s) => s.id));
  // One line per stage: the first that carries it. A second would bill the same stage twice over.
  const taken = new Set<string>();
  return {
    lines: lines.map((l) => {
      const stage = l.billingMilestoneId && keep.has(l.billingMilestoneId) && !taken.has(l.billingMilestoneId) ? l.billingMilestoneId : "";
      if (stage) taken.add(stage);
      return { ...l, billingMilestoneId: stage };
    }),
  };
}

function lineData(input: TradeDocumentInput["lines"][number], computed: ReturnType<typeof computeDocument>["lines"][number], index: number) {
  return {
    itemId: input.itemId || null,
    companyProductId: input.companyProductId || null,
    // Calendar days, stored as a @db.Date holds them; both or neither (the schema checked).
    servicePeriodFrom: periodDay(input.servicePeriodFrom),
    servicePeriodTo: periodDay(input.servicePeriodTo),
    billingMilestoneId: input.billingMilestoneId || null,
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

/**
 * Everything a create or an update writes, with the tax engine run over the submitted lines — as
 * raised from (or, on a purchase, bought by) `branch`. Resolve the branch first: this reads through
 * `db` and must not run inside a transaction.
 */
async function buildDocumentData(data: TradeDocumentInput, branch: { id: string }) {
  const identity = await branchIdentity(branch.id);
  const parties = await resolveParties(
    data.docType,
    data.companyId,
    data.locationId || null,
    data.placeOfSupplyCode || null,
    identity,
  );
  const isSales = documentDirection[data.docType] === "SALES";
  // The form's one GSTIN field is the *party's*, whichever side of the document they are on, and it wins
  // over the location's: it's what was actually agreed for this document. Ours is the branch's
  // registration — on a purchase that is the buyer, which is where the previous build put the vendor (X1).
  const partyGstin = data.buyerGstin || parties.partyGstin || null;
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
      roundOff: identity.roundOffTotals,
    },
  );
  // A document's dates are typed days, kept as their midnight UTC; left blank, it is dated today on
  // the workspace's calendar, held the same way — not the moment, whose UTC date is yesterday's
  // before 05:30 in India.
  const issueDate = parseDate(data.issueDate, (await workspaceClock()).calendarDate(new Date())) as Date;
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
      branchId: branch.id,
      // The branch's registration as of this save; issuing re-reads it (spec §3.5, §5.5).
      gstRegistrationId: identity.gstRegistrationId,
      placeOfSupplyCode: parties.placeOfSupplyCode,
      sellerGstin: isSales ? parties.ourGstin : partyGstin,
      buyerGstin: isSales ? partyGstin : parties.ourGstin,
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
  const links = await checkLineLinks(data.lines, data.companyId, null);
  if ("error" in links) return { ok: false, error: links.error };

  const typedNumber = data.docNumber?.trim() || null;
  const numberProblem = typedNumber ? gstNumberProblem(data.docType, typedNumber) : null;
  if (numberProblem) return { ok: false, error: numberProblem };

  // Before the transaction: these read through `db`, and resolving may create the head office.
  const picked = await resolveDocumentBranch({
    userId: user.id,
    docType: data.docType,
    requestedBranchId: data.branchId,
    againstDocumentId: data.againstDocumentId,
  });
  if ("error" in picked) return { ok: false, error: picked.error };
  const { branch } = picked;
  const built = await buildDocumentData({ ...data, lines: links.lines }, branch);
  // Only India has the government's e-invoice system; elsewhere it never applies.
  const einvoiceStatus = isEInvoiceEligible(data.docType) && (await countryFeatureAvailable("einvoice")) ? "PENDING" : "NOT_APPLICABLE";

  /**
   * Zoho assigns the number when the document is created, not when it's issued, so it's visible and
   * editable on the form. A typed-in number is kept as-is and its branch's series is pushed past it.
   *
   * Allocated in the transaction that creates the document (X12): a create that fails takes its number
   * back with it rather than leaving a gap. The one exception is an allocated number some other
   * document already holds — that transaction commits, so the series moves past a number nobody can
   * have anyway and the next attempt takes the one after it.
   */
  const outcome = await db.$transaction(async (tx) => {
    const docNumber = typedNumber ?? (await nextDocumentNumber(tx, data.docType, built.issueDate, branch.id));
    const clash = await tx.tradeDocument.findUnique({ where: { docNumber }, select: { id: true } });
    if (clash) return { clash: docNumber };
    if (typedNumber) await advanceSerialPast(tx, data.docType, typedNumber, branch.id, built.issueDate);

    const created = await tx.tradeDocument.create({
      data: {
        ...built.scalars,
        docNumber,
        status: "DRAFT",
        origin,
        einvoiceStatus,
        sourceDocumentId: data.sourceDocumentId || null,
        againstDocumentId: data.againstDocumentId || null,
        leadId: data.leadId || null,
        createdById: user.id,
        salespersonId: data.salespersonId || company.ownerUserId || user.id,
        lines: { create: built.lines },
      },
      select: { id: true },
    });
    return { created };
  });
  if ("clash" in outcome) return { ok: false, error: `${outcome.clash} is already used by another document.` };
  const { created } = outcome;

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
    select: {
      id: true,
      status: true,
      approvalStatus: true,
      docType: true,
      companyId: true,
      docNumber: true,
      issueDate: true,
      branchId: true,
      againstDocumentId: true,
    },
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
  const links = await checkLineLinks(data.lines, data.companyId, id);
  if ("error" in links) return { ok: false, error: links.error };

  // Typed in this save: the form sends the number back every time, so only a changed one counts.
  const typedNumber = data.docNumber?.trim() && data.docNumber.trim() !== existing.docNumber ? data.docNumber.trim() : null;
  if (typedNumber) {
    const numberProblem = gstNumberProblem(existing.docType, typedNumber);
    if (numberProblem) return { ok: false, error: numberProblem };
    const clash = await db.tradeDocument.findUnique({ where: { docNumber: typedNumber }, select: { id: true } });
    if (clash && clash.id !== id) return { ok: false, error: `${typedNumber} is already used by another document.` };
  }

  // Before the transaction, like the create. The invoice a credit note follows is the stored one: an
  // update never re-points it.
  const picked = await resolveDocumentBranch({
    userId: user.id,
    docType: existing.docType,
    requestedBranchId: data.branchId,
    againstDocumentId: existing.againstDocumentId,
    existing: { branchId: existing.branchId },
  });
  if ("error" in picked) return { ok: false, error: picked.error };
  const { branch } = picked;
  const built = await buildDocumentData({ ...data, lines: links.lines }, branch);

  // Lines are replaced wholesale: the form submits the full set every time, and matching them up
  // row by row would only add a way for the stored totals to drift from the stored lines.
  const outcome = await db.$transaction(async (tx) => {
    let docNumber = typedNumber;
    if (typedNumber) {
      await advanceSerialPast(tx, existing.docType, typedNumber, branch.id, built.issueDate);
    } else if (branch.id !== existing.branchId) {
      /**
       * Moved to another branch: a number its old series generated is renumbered from the new
       * branch's series — only when the two branches count in different series (under company-wide
       * numbering nothing changes), and never a number somebody typed. The old number becomes a gap,
       * exactly as a deleted draft's does (owner decision Q9; CA question C2).
       */
      const [before, after] = [await seriesFor(tx, existing.docType, existing.branchId), await seriesFor(tx, existing.docType, branch.id)];
      if (
        JSON.stringify(before.ref) !== JSON.stringify(after.ref) &&
        (await isAutoNumberOf(tx, existing.docType, existing.branchId, existing.docNumber, existing.issueDate))
      ) {
        docNumber = await nextDocumentNumber(tx, existing.docType, built.issueDate, branch.id);
        const clash = await tx.tradeDocument.findUnique({ where: { docNumber }, select: { id: true } });
        // Committed rather than rolled back, as on create: the series moves past a number that is taken.
        if (clash) return { clash: docNumber };
      }
    }

    await tx.tradeDocumentLine.deleteMany({ where: { documentId: id } });
    await tx.tradeDocument.update({
      where: { id },
      data: {
        ...built.scalars,
        ...(docNumber ? { docNumber } : {}),
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
    return { renumbered: !typedNumber && docNumber ? docNumber : null };
  });
  if ("clash" in outcome) return { ok: false, error: `${outcome.clash} is already used by another document.` };

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "TradeDocument",
    entityId: id,
    entityLabel: outcome.renumbered
      ? `${tradeDocumentLabels[existing.docType]} moved to ${branchLabel(branch)} · ${existing.docNumber} renumbered ${outcome.renumbered}`
      : tradeDocumentLabels[existing.docType],
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

  await db.$transaction(async (tx) => {
    // A project billing stage raised on this draft goes back to DUE, rather than reading INVOICED
    // with nothing behind it once the foreign key has cleared the link.
    await releaseBillingMilestones(id, tx);
    await tx.tradeDocument.delete({ where: { id } });
  });
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
      branchId: true,
      againstDocument: { select: { branchId: true } },
      lines: { select: { id: true } },
    },
  });
  if (!existing) return { ok: false, error: "That document no longer exists." };
  if (existing.status !== "DRAFT") return { ok: false, error: "This document has already been issued." };
  if (existing.lines.length === 0) return { ok: false, error: "Add at least one line before issuing." };

  /**
   * The branch, re-read now rather than trusted from the last save: it may have been deactivated, or
   * lost its registration, since the draft was written (spec §5.5). A draft from before branches is
   * the head office's.
   */
  const branch = (existing.branchId ? await branchWithRegistration(existing.branchId) : null) ?? (await ensureHeadOffice());
  // A credit note goes out from its invoice's branch even after that branch closed — it is the only
  // branch whose GSTIN can reduce that invoice.
  const followsInvoice =
    existing.docType === "CREDIT_NOTE" &&
    (existing.againstDocument?.branchId ? existing.againstDocument.branchId === branch.id : branch.isHeadOffice);
  if (!branch.active && !followsInvoice) {
    return { ok: false, error: `Branch ${branch.name} is inactive. Move this draft to an active branch, then issue it.` };
  }
  // A GST document needs a live GSTIN behind it. A company with no registration at all (unregistered, or
  // abroad) issues as it always has.
  if (GST_NUMBERED_TYPES.includes(existing.docType) && !branch.gstRegistration?.active && (await db.gstRegistration.count({ where: { active: true } })) > 0) {
    return {
      ok: false,
      error: branch.gstRegistration
        ? `Branch ${branch.name}'s GSTIN ${branch.gstRegistration.gstin} is inactive, so it can't issue a tax invoice. Choose another branch or reactivate the GSTIN.`
        : `Branch ${branch.name} has no GST registration, so it can't issue a tax invoice. Choose another branch or add its GSTIN.`,
    };
  }
  const ourGstin = branch.gstRegistration?.gstin ?? null;
  // The snapshot as it stands at issue — the same as the last save's unless the branch's registration
  // changed in between (it can only change within the branch's state, so the tax split still holds).
  // From here on it never changes.
  const snapshot = {
    branchId: branch.id,
    gstRegistrationId: branch.gstRegistrationId,
    ...(documentDirection[existing.docType] === "SALES" ? { sellerGstin: ourGstin } : { buyerGstin: ourGstin }),
  };

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
  // gets one now, from its branch's series.
  const docNumber = isDraftNumber(existing.docNumber)
    ? await db.$transaction(async (tx) => {
        const number = await nextDocumentNumber(tx, existing.docType, existing.issueDate, branch.id);
        await tx.tradeDocument.update({ where: { id }, data: { docNumber: number } });
        return number;
      })
    : existing.docNumber;

  // Issuing and posting happen together: a document can't reach the customer without its ledger
  // entry, and an entry must never exist for a document that then failed to issue.
  const posting = await db.$transaction(async (tx) => {
    await tx.tradeDocument.update({ where: { id }, data: { status: "ISSUED", issuedAt: new Date(), ...snapshot } });
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

/**
 * Assembles the portal's view of a document from what's stored, including both parties' addresses,
 * and the registration whose IRP login reports it.
 */
async function loadEInvoiceDocument(
  id: string,
): Promise<{ doc: EInvoiceDocument; gstRegistrationId: string | null } | { error: string }> {
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

  // The branch the document was raised from, not the live organisation: an invoice reported (or
  // re-tried) after a GSTIN change must still carry the GSTIN it was issued under (X3).
  const identity = await branchIdentity(document.branchId);
  const sellerGstin = document.sellerGstin ?? identity.gstin;
  const location = document.location;

  return {
    gstRegistrationId: document.gstRegistrationId,
    doc: {
      docType: document.docType as "INVOICE" | "CREDIT_NOTE",
      docNumber: document.docNumber,
      issueDate: document.issueDate,
      reverseCharge: document.reverseCharge,
      placeOfSupplyCode: document.placeOfSupplyCode,
      seller: {
        gstin: sellerGstin,
        legalName: identity.legalName,
        address1: identity.addressLine1,
        address2: identity.addressLine2,
        city: identity.city,
        pincode: identity.pincode,
        stateCode: identity.stateCode ?? stateCodeFromGstin(sellerGstin),
        phone: identity.phone,
        email: identity.email,
        label: identity.name,
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

  // The IRP login of the GSTIN the document was issued under; the error names what is missing.
  const got = await eInvoiceConfigFor(loaded.gstRegistrationId);
  if ("error" in got) return { ok: false, error: got.error };
  const { config } = got;

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
    select: { irn: true, ackDate: true, docType: true, einvoiceStatus: true, gstRegistrationId: true },
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

  // Always the registration the IRN was generated under — even one deactivated since, whose login is
  // kept for exactly this: an IRN can only be cancelled by the GSTIN that holds it.
  const got = await eInvoiceConfigFor(document.gstRegistrationId, { allowInactive: true });
  if ("error" in got) return { ok: false, error: got.error };

  const provider = createEInvoiceProvider(got.config);
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
    await syncBillingMilestones(id, tx);
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

  /**
   * The branch travels with the deal: a proposal from Pune becomes Pune's invoice, a Bengaluru PO
   * Bengaluru's bill, and a credit note stays with its invoice's branch (spec §5.1, §5.3). The GSTIN
   * snapshots come across with it, so place of supply and tax stay as the source worked them out. A
   * source from before branches is the head office's — resolved here, outside the transaction.
   */
  const { branchId, gstRegistrationId } = source.branchId
    ? { branchId: source.branchId, gstRegistrationId: source.gstRegistrationId }
    : await ensureHeadOffice().then((ho) => ({ branchId: ho.id, gstRegistrationId: ho.gstRegistrationId }));
  // Dated today on the workspace's calendar, as a typed day is kept: its midnight UTC.
  const issueDate = (await workspaceClock()).calendarDate(new Date());

  // The number comes from the source branch's series in the transaction that creates the document, so
  // a create that fails gives it back (X12).
  const created = await db.$transaction(async (tx) => await tx.tradeDocument.create({
    data: {
      docNumber: await nextDocumentNumber(tx, target, issueDate, branchId),
      docType: target,
      direction: documentDirection[target],
      status: "DRAFT",
      // Not a parameter: this path exists only to convert, so the origin is a fact about the path.
      origin: "CONVERSION",
      companyId: source.companyId,
      locationId: source.locationId,
      branchId,
      gstRegistrationId,
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
      issueDate,
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
          // The period travels with the line: a quote for a year's cover is invoiced for that year,
          // and credited against it. The billing stage does not — "Raise invoice" links a stage to
          // one document, and a copy would claim a stage it doesn't hold.
          servicePeriodFrom: line.servicePeriodFrom,
          servicePeriodTo: line.servicePeriodTo,
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
  }));

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
    // A project billing stage raised on it follows: paid, or released for a fresh invoice.
    await syncBillingMilestones(id, tx);
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
      branch: { select: { id: true, name: true, code: true } },
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
  /** One branch's documents; the head office's include those written before branches. */
  branchId?: string;
  page: number;
  pageSize: number;
}) {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  if (!(await viewerHas("documents.view"))) return { rows: [], total: 0 };
  const dateWindow = calendarDayRange(params.from, params.to);
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
     * same reasoning, and the same fix, as `listOrders` in src/actions/order.ts. The branch filter
     * joins it there for the same reason: the head office's is an `OR`, which a search would replace.
     */
    AND: [
      (await viaCompanyScope(user.id)) as Prisma.TradeDocumentWhereInput,
      ...(params.branchId ? [await branchFilter(params.branchId)] : []),
    ],
    docType: params.docType,
    ...(params.status ? { status: params.status } : {}),
    /**
     * The window is the days themselves, both ends in: an issue date is a typed day kept as its
     * midnight UTC, so it is compared by calendar day (`calendarDayRange`) — the same day in every
     * zone. It was built in the server's own timezone, which happened to agree only on a server in UTC.
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
        company: { select: { id: true, name: true, relationshipType: true, companySeq: true } },
        createdBy: { select: { name: true } },
        salesperson: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true, code: true } },
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
    // The type and cycle decide whether the line offers a service period, and the one it starts with.
    select: { id: true, name: true, sku: true, description: true, unit: true, hsnCode: true, sellingPrice: true, taxRatePercent: true, type: true, billingCycle: true },
  });
  return toPlain(rows);
}

/**
 * A customer's orders, for the document form's "Bills order" picker on a line: picking one fills the
 * line from the order and links it (`companyProductId`), and the order's term becomes the line's
 * service period.
 *
 * Orders are the Orders module's, so outside the plan, switched off, or without `orders.view`, there
 * are none to offer — the line is simply typed or taken from the catalogue, as before. Scoped to
 * parties this person can see, like the locations beside it. Cancelled and rejected orders are left
 * out; everything else, newest term first.
 */
export async function listPartyOrders(companyId: string) {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  if (!(await viewerHas("documents.view"))) return [];
  if ((await moduleAccessFor(user.id, "orders")) !== "available") return [];
  if (!(await maySeeParty(user.id, companyId))) return [];
  const rows = await db.companyProduct.findMany({
    where: { companyId, orderStatus: { notIn: ["REJECTED", "CANCELLED"] } },
    orderBy: [{ startDate: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: 100,
    select: {
      id: true,
      orderSeq: true,
      quantity: true,
      unitPrice: true,
      startDate: true,
      endDate: true,
      item: {
        select: { id: true, name: true, description: true, unit: true, hsnCode: true, sellingPrice: true, taxRatePercent: true, type: true, billingCycle: true },
      },
    },
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
    // The branch, so the form can lock its picker to it: a credit note follows its invoice (null = the head office).
    select: { id: true, docNumber: true, issueDate: true, total: true, branchId: true },
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
      branch: { select: { id: true, name: true, code: true } },
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
