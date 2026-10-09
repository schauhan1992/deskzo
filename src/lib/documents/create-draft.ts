import { Prisma, type TradeDocumentType, type DocumentOrigin } from "@prisma/client";
import { db } from "@/lib/db";
import { countryFeatureAvailable } from "@/lib/modules-access";
import { recordAudit } from "@/lib/audit";
import { computeDocument, GST_STATE_CODES, OTHER_COUNTRY_CODE, resolveSupplyType, stateCodeFromGstin } from "@/lib/gst-engine";
import { gstNumberProblem } from "@/lib/document-numbering";
import { workspaceClock } from "@/lib/time/workspace";
import { advanceSerialPast, nextDocumentNumber } from "@/lib/trade-number";
import { branchIdentity, defaultBranchIdFor, ensureHeadOffice, type BranchWithRegistration } from "@/lib/branches/identity";
import type { BranchIdentity } from "@/lib/branches/format";
import { documentDirection, isEInvoiceEligible, tradeDocumentLabels } from "@/lib/trade-documents";
import type { TradeDocumentInput } from "@/lib/validation/trade-document";
import type { ActionResult } from "@/actions/company";
import { isIndia } from "@/lib/geo/countries";
import { periodDay } from "@/lib/documents/service-period";

/**
 * Building and raising trade documents — the parts of src/actions/trade-document.ts that decide what a
 * document holds rather than who may write it. Not a "use server" module: nothing here checks a
 * permission, so nothing here may be an endpoint.
 */

export function parseDate(value: string | undefined | null, fallback?: Date): Date | null {
  if (!value) return fallback ?? null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? (fallback ?? null) : date;
}

/** A state name typed on a location, mapped back to its GST code — a fallback when there's no GSTIN. */
export function stateCodeFromName(name?: string | null) {
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
export async function resolveParties(
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

export function branchWithRegistration(id: string): Promise<BranchWithRegistration | null> {
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
export async function resolveDocumentBranch(input: {
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
export async function checkLineLinks(
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

export function lineData(input: TradeDocumentInput["lines"][number], computed: ReturnType<typeof computeDocument>["lines"][number], index: number) {
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

/** The bank account a document names must be one of the organisation's. A retired one is allowed: it is
 *  offered only to the document that already names it. */
export async function bankAccountRefusal(bankAccountId: string | undefined): Promise<string | null> {
  if (!bankAccountId) return null;
  const account = await db.organisationBankAccount.findUnique({ where: { id: bankAccountId }, select: { id: true } });
  return account ? null : "That bank account isn't there any more — pick another.";
}

/**
 * Everything a create or an update writes, with the tax engine run over the submitted lines — as
 * raised from (or, on a purchase, bought by) `branch`. Resolve the branch first: this reads through
 * `db` and must not run inside a transaction.
 */
export async function buildDocumentData(data: TradeDocumentInput, branch: { id: string }) {
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
      // Only when sent, and only on a sale: written by name, as the column may not be there yet.
      ...(isSales && data.bankAccountId !== undefined ? { bankAccountId: data.bankAccountId || null } : {}),

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

/** A reference to the document a conversion or credit note came from, checked to belong to the same party. */
export async function validateLinkedDocument(
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
export async function validateLinkedLead(leadId: string | undefined, companyId: string): Promise<string | null> {
  if (!leadId) return null;
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { companyId: true } });
  if (!lead) return "That lead no longer exists.";
  if (lead.companyId !== companyId) return "That lead belongs to a different company.";
  return null;
}

/**
 * Raises a draft document: everything `createTradeDocument` does once it has decided the caller may —
 * the party's site, linked documents and lead checked, the branch resolved, lines priced and taxed,
 * the number allocated with the document, the audit written.
 *
 * Here rather than in the action so a job with no session can raise a draft the same way, as the
 * Automation account: recurring billing (src/lib/recurring-billing/run.ts). Whoever calls it has
 * already answered *may they*; nothing here asks. `branchFor` is whose home branch the document
 * defaults to when it names none — the actor's, unless the caller acts for somebody else.
 */
export async function createDraftDocument(
  actor: { id: string; branchFor?: string },
  data: TradeDocumentInput,
  origin: DocumentOrigin,
): Promise<ActionResult<{ id: string }>> {
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
  const bankError = await bankAccountRefusal(data.bankAccountId);
  if (bankError) return { ok: false, error: bankError };
  const links = await checkLineLinks(data.lines, data.companyId, null);
  if ("error" in links) return { ok: false, error: links.error };

  const typedNumber = data.docNumber?.trim() || null;
  const numberProblem = typedNumber ? gstNumberProblem(data.docType, typedNumber) : null;
  if (numberProblem) return { ok: false, error: numberProblem };

  // Before the transaction: these read through `db`, and resolving may create the head office.
  const picked = await resolveDocumentBranch({
    userId: actor.branchFor ?? actor.id,
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
        createdById: actor.id,
        salespersonId: data.salespersonId || company.ownerUserId || actor.id,
        lines: { create: built.lines },
      },
      select: { id: true },
    });
    return { created };
  });
  if ("clash" in outcome) return { ok: false, error: `${outcome.clash} is already used by another document.` };
  const { created } = outcome;

  await recordAudit({
    userId: actor.id,
    action: "CREATE",
    entityType: "TradeDocument",
    entityId: created.id,
    entityLabel: `${tradeDocumentLabels[data.docType]} for ${company.name}`,
  });
  return { ok: true, data: { id: created.id } };
}
