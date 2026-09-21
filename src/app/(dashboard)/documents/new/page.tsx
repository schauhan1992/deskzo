import { currentUser } from "@/lib/session";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { TradeDocumentType } from "@prisma/client";
import { listDocumentParties } from "@/actions/trade-document";
import { listAssignableUsers } from "@/actions/company";
import { leadDocumentDraft } from "@/actions/lead";
import { getNumberSetting, previewNextNumber } from "@/actions/document-number";
import { getOrganisation } from "@/lib/organisation";
import { stateCodeFromGstin } from "@/lib/gst-engine";
import { DocumentForm } from "@/components/documents/document-form";
import { blankLine, emptyDefaults } from "@/lib/document-draft";
import { Card } from "@/components/ui/card";
import {
  documentListPath,
  tradeDocumentLabels,
  tradeDocumentTypeValues,
} from "@/lib/trade-documents";

export default async function NewDocumentPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; companyId?: string; leadId?: string }>;
}) {
  const params = await searchParams;
  // A delivery challan is not in this list — it is raised from a consignment, so there is no blank
  // form for one. The cast narrows to the types that do have one.
  if (!tradeDocumentTypeValues.includes(params.type as (typeof tradeDocumentTypeValues)[number])) notFound();
  const docType = params.type as TradeDocumentType;

  const [parties, salespeople, org, numberSetting, nextNumber, lead, me] = await Promise.all([
    listDocumentParties(docType),
    listAssignableUsers(),
    getOrganisation(),
    getNumberSetting(docType),
    previewNextNumber(docType),
    params.leadId ? leadDocumentDraft(params.leadId) : Promise.resolve(null),
    currentUser(),
  ]);

  /**
   * The person writing the quote, when they are somebody a quote can be attributed to.
   *
   * Blank means "the account owner", which is the right answer for an accountant raising an
   * invoice against somebody else's customer — but wrong for the far commoner case of a
   * salesperson writing their own proposal and having to pick themselves from a list every time.
   */
  const defaultSalespersonId = me && salespeople.some((s) => s.id === me.id) ? me.id : "";
  const orgStateCode = org.stateCode ?? stateCodeFromGstin(org.gstin);
  const orgAddress = [org.legalName, org.addressLine1, org.addressLine2, [org.city, org.pincode].filter(Boolean).join(" "), org.state]
    .filter(Boolean)
    .join("\n");

  const defaults = emptyDefaults();
  defaults.docNumber = nextNumber;
  defaults.dispatchFromAddress = orgAddress;
  defaults.salespersonId = defaultSalespersonId;
  if (params.companyId && parties.some((p) => p.id === params.companyId)) {
    defaults.companyId = params.companyId;
  }

  // Raised from a lead: the deal decides the party, the salesperson and the opening set of lines.
  // The lead is only honoured if its company is one this document type can actually be raised
  // against — a sales document can't be addressed to a vendor, whatever the URL says.
  const fromLead = lead && parties.some((p) => p.id === lead.companyId) ? lead : null;
  if (fromLead) {
    defaults.companyId = fromLead.companyId;
    defaults.leadId = fromLead.id;
    defaults.reference = fromLead.title;
    defaults.salespersonId = fromLead.ownerUserId ?? "";
    if (fromLead.requirements.length > 0) {
      defaults.lines = fromLead.requirements.map((r) => ({
        ...blankLine(),
        itemId: r.item.id,
        name: r.item.name,
        // The requirement's own note is what the customer actually asked for on the call, so it
        // beats the catalogue blurb when there is one.
        description: r.notes ?? r.item.description ?? "",
        hsnCode: r.item.hsnCode ?? "",
        unit: r.item.unit ?? "",
        quantity: String(r.quantity),
        unitPrice: String(r.item.sellingPrice ?? 0),
        taxRatePercent: String(r.item.taxRatePercent ?? 18),
      }));
    }
  }

  return (
    <div>
      <div className="mb-5">
        <Link
          href={fromLead ? `/leads/${fromLead.id}` : documentListPath[docType]}
          className="text-sm text-muted hover:text-text"
        >
          ← {fromLead ? fromLead.title : `${tradeDocumentLabels[docType]}s`}
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-text">New {tradeDocumentLabels[docType].toLowerCase()}</h1>
        <p className="mt-1 text-sm text-muted">
          {fromLead
            ? fromLead.requirements.length > 0
              ? `Started from this lead's ${fromLead.requirements.length} required product${fromLead.requirements.length === 1 ? "" : "s"}, priced from the catalogue. Check the prices before you issue it.`
              : "Raised against this lead. It has no products listed yet, so the lines start empty."
            : "Saved as a draft first, so nothing reaches the customer until you issue it."}
        </p>
      </div>

      {!orgStateCode && (
        <Card className="mb-5 border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
          Your organisation&apos;s GSTIN and state aren&apos;t set, so every document will be taxed as inter-state
          (IGST). Set them under Settings → Organisation.
        </Card>
      )}

      <DocumentForm
        docType={docType}
        parties={parties}
        orgStateCode={orgStateCode}
        orgAddress={orgAddress}
        defaultTerms={org.invoiceTerms}
        roundOffTotals={org.roundOffTotals}
        numberSetting={numberSetting}
        salespeople={salespeople}
        defaults={defaults}
      />
    </div>
  );
}
