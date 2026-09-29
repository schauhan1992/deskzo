import Link from "next/link";
import { notFound } from "next/navigation";
import { getTradeDocument, listDocumentParties } from "@/actions/trade-document";
import { listAssignableUsers } from "@/actions/company";
import { getNumberSetting } from "@/actions/document-number";
import { getOrganisation } from "@/lib/organisation";
import { listBranchChoices } from "@/lib/branches/identity";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { DocumentForm } from "@/components/documents/document-form";
import { isEditable, tradeDocumentLabels } from "@/lib/trade-documents";
import { istDateTimeInput } from "@/lib/india-time";
import { periodKey } from "@/lib/documents/service-period";

/**
 * A stored date as the Indian calendar day, for a date input. Right whether the date was saved at UTC
 * midnight (05:30 IST, the same day) or at India midnight (18:30 UTC the day before) — slicing the UTC
 * ISO string gave the previous day for the second.
 */
const asDateInput = (value: Date | string | null | undefined) => (value ? istDateTimeInput(value).slice(0, 10) : "");

export default async function EditDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [document, user] = await Promise.all([getTradeDocument(id), requireUser()]);
  if (!document) notFound();

  /**
   * Via the party the document was raised for — `document.companyId`, already loaded, so this is a
   * lookup of the company rather than of the document a second time.
   *
   * Placed above the "already issued" branch on purpose: that branch prints the document number,
   * which is a fact about somebody else's account and must not escape before the scope is checked.
   */
  const party = await db.company.findUnique({
    where: { id: document.companyId },
    select: { ownerUserId: true },
  });
  if (!party || !(await canSeeCompany(user.id, party.ownerUserId))) notFound();

  if (!isEditable(document.status)) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">{document.docNumber}</h1>
        <p className="mt-2 text-sm text-muted">
          This {tradeDocumentLabels[document.docType].toLowerCase()} has been issued, so it can no longer be edited.
          Raise a credit note if the amounts need to change.
        </p>
        <Link href={`/documents/${id}`} className="mt-3 inline-block text-sm text-brand hover:underline">
          ← Back to the document
        </Link>
      </div>
    );
  }

  const itemIds = [...new Set(document.lines.map((line) => line.itemId).filter((v): v is string => !!v))];
  const [parties, salespeople, org, branches, numberSetting, lineItems] = await Promise.all([
    listDocumentParties(document.docType),
    listAssignableUsers(),
    getOrganisation(),
    // The draft's own branch stays selectable even once deactivated: the picker must show what the
    // draft says, and a draft on an inactive branch can still be saved (just not issued).
    listBranchChoices({ include: document.branchId ? [document.branchId] : [] }),
    getNumberSetting(document.docType, document.branchId),
    // What each line's item is, so the form offers a service period where the item suggests one.
    itemIds.length ? db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, type: true, billingCycle: true } }) : [],
  ]);
  const itemOf = (id: string | null) => lineItems.find((item) => item.id === id);
  // Written before branches (null): the head office's.
  const branch = branches.find((b) => b.id === document.branchId) ?? branches.find((b) => b.isHeadOffice);
  const isSales = document.direction === "SALES";

  return (
    <div>
      <div className="mb-5">
        <Link href={`/documents/${id}`} className="text-sm text-muted hover:text-text">
          ← Back to the document
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-text">
          Edit {tradeDocumentLabels[document.docType].toLowerCase()}
        </h1>
      </div>

      <DocumentForm
        docType={document.docType}
        parties={parties}
        branches={branches}
        defaultTerms={org.invoiceTerms}
        roundOffTotals={org.roundOffTotals}
        numberSetting={numberSetting}
        salespeople={salespeople}
        defaults={{
          id: document.id,
          docNumber: document.docNumber,
          companyId: document.companyId,
          locationId: document.locationId ?? "",
          placeOfSupplyCode: document.placeOfSupplyCode ?? "",
          gstTreatment: document.gstTreatment,
          // The party's GSTIN: on a purchase that is the vendor's, stored as the seller's (spec §5.2).
          buyerGstin: (isSales ? document.buyerGstin : document.sellerGstin) ?? "",
          reverseCharge: document.reverseCharge,
          branchId: branch?.id ?? "",
          currency: document.currency,
          exchangeRate: Number(document.exchangeRate),
          issueDate: asDateInput(document.issueDate),
          dueDate: asDateInput(document.dueDate),
          validUntil: asDateInput(document.validUntil),
          reference: document.reference ?? "",
          salespersonId: document.salespersonId ?? "",
          notes: document.notes ?? "",
          terms: document.terms ?? "",
          dispatchFromAddress: document.dispatchFromAddress ?? branch?.dispatchAddress ?? "",
          billing: {
            attention: document.billingAttention ?? "",
            line1: document.billingLine1 ?? "",
            line2: document.billingLine2 ?? "",
            city: document.billingCity ?? "",
            state: document.billingState ?? "",
            stateCode: document.billingStateCode ?? "",
            pincode: document.billingPincode ?? "",
            country: document.billingCountry ?? "India",
            phone: document.billingPhone ?? "",
          },
          shippingSameAsBilling: document.shippingSameAsBilling,
          shipping: {
            attention: document.shippingAttention ?? "",
            line1: document.shippingLine1 ?? "",
            line2: document.shippingLine2 ?? "",
            city: document.shippingCity ?? "",
            state: document.shippingState ?? "",
            stateCode: document.shippingStateCode ?? "",
            pincode: document.shippingPincode ?? "",
            country: document.shippingCountry ?? "India",
            phone: document.shippingPhone ?? "",
          },
          shippingGstin: document.shippingGstin ?? "",
          shippingCharge: document.shippingCharge ? String(document.shippingCharge) : "",
          shippingTaxRatePercent: String(document.shippingTaxRatePercent ?? 18),
          withholdingMode: document.withholdingMode,
          withholdingSection: document.withholdingSection ?? "",
          withholdingRatePercent: document.withholdingRatePercent ? String(document.withholdingRatePercent) : "",
          adjustmentLabel: document.adjustmentLabel ?? "Adjustment",
          adjustment: document.adjustment ? String(document.adjustment) : "",
          sourceDocumentId: document.sourceDocumentId ?? "",
          againstDocumentId: document.againstDocumentId ?? "",
          // Carried through the edit rather than re-derived: saving a draft must not quietly
          // detach it from the deal it was raised for.
          leadId: document.leadId ?? "",
          lines: document.lines.map((line) => ({
            key: line.id,
            itemId: line.itemId ?? "",
            name: line.name,
            description: line.description ?? "",
            hsnCode: line.hsnCode ?? "",
            unit: line.unit ?? "",
            quantity: String(line.quantity),
            unitPrice: String(line.unitPrice),
            discountMode: line.discountMode,
            discountValue: String(line.discountValue),
            taxRatePercent: String(line.taxRatePercent),
            // The links and the period go back exactly as saved: the form replaces lines wholesale,
            // so whatever isn't round-tripped here would be deleted by the next save.
            companyProductId: line.companyProductId ?? "",
            itemType: itemOf(line.itemId)?.type ?? "",
            itemCycle: itemOf(line.itemId)?.billingCycle ?? "",
            servicePeriodFrom: periodKey(line.servicePeriodFrom),
            servicePeriodTo: periodKey(line.servicePeriodTo),
            // A saved period is somebody's decision, not a default to be replaced.
            periodSource: line.servicePeriodFrom ? ("typed" as const) : ("" as const),
            periodOpen: false,
            billingMilestoneId: line.billingMilestoneId ?? "",
          })),
        }}
      />
    </div>
  );
}
