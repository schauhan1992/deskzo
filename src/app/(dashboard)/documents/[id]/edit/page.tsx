import Link from "next/link";
import { notFound } from "next/navigation";
import { getTradeDocument, listDocumentParties } from "@/actions/trade-document";
import { listAssignableUsers } from "@/actions/company";
import { getNumberSetting } from "@/actions/document-number";
import { getOrganisation } from "@/lib/organisation";
import { stateCodeFromGstin } from "@/lib/gst-engine";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { DocumentForm } from "@/components/documents/document-form";
import { isEditable, tradeDocumentLabels } from "@/lib/trade-documents";

const asDateInput = (value: Date | string | null | undefined) =>
  value ? new Date(value).toISOString().slice(0, 10) : "";

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

  const [parties, salespeople, org, numberSetting] = await Promise.all([
    listDocumentParties(document.docType),
    listAssignableUsers(),
    getOrganisation(),
    getNumberSetting(document.docType),
  ]);
  const orgAddress = [org.legalName, org.addressLine1, org.addressLine2, [org.city, org.pincode].filter(Boolean).join(" "), org.state]
    .filter(Boolean)
    .join("\n");

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
        orgStateCode={org.stateCode ?? stateCodeFromGstin(org.gstin)}
        orgAddress={orgAddress}
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
          buyerGstin: document.buyerGstin ?? "",
          reverseCharge: document.reverseCharge,
          currency: document.currency,
          exchangeRate: Number(document.exchangeRate),
          issueDate: asDateInput(document.issueDate),
          dueDate: asDateInput(document.dueDate),
          validUntil: asDateInput(document.validUntil),
          reference: document.reference ?? "",
          salespersonId: document.salespersonId ?? "",
          notes: document.notes ?? "",
          terms: document.terms ?? "",
          dispatchFromAddress: document.dispatchFromAddress ?? orgAddress,
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
          })),
        }}
      />
    </div>
  );
}
