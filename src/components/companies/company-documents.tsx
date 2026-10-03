import Link from "next/link";
import type { TradeDocumentType } from "@prisma/client";
import { listCompanyDocuments } from "@/actions/trade-document";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";
import { statusTone, tradeDocumentLabels, tradeDocumentStatusLabels } from "@/lib/trade-documents";
import { isDraftNumber } from "@/lib/document-numbering";

type Document = Awaited<ReturnType<typeof listCompanyDocuments>>[number];

/** The order documents are raised in, so the list reads as the deal progressed rather than alphabetically. */
const SALES_ORDER: TradeDocumentType[] = ["PROPOSAL", "PROFORMA", "INVOICE", "CREDIT_NOTE"];
const PURCHASE_ORDER: TradeDocumentType[] = ["PURCHASE_ORDER", "BILL"];

export function CompanyDocuments({
  companyId,
  documents,
  isVendor,
  managedByResellerName,
}: {
  companyId: string;
  documents: Document[];
  isVendor: boolean;
  /** Set when this company's orders are billed to a reseller, which is why it has no invoices of its own. */
  managedByResellerName?: string | null;
}) {
  const groups = (isVendor ? PURCHASE_ORDER : SALES_ORDER)
    .map((docType) => ({ docType, rows: documents.filter((d) => d.docType === docType) }))
    // A company can end up on both sides of the relationship, so anything outside its usual
    // direction still shows rather than quietly disappearing from the 360 view.
    .concat(
      (isVendor ? SALES_ORDER : PURCHASE_ORDER)
        .map((docType) => ({ docType, rows: documents.filter((d) => d.docType === docType) }))
        .filter((g) => g.rows.length > 0),
    );

  const newDocType: TradeDocumentType = isVendor ? "PURCHASE_ORDER" : "PROPOSAL";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {documents.length === 0
            ? "No documents raised for this company yet."
            : `${documents.length} document(s) · ${formatCurrency(
                documents
                  .filter((d) => d.status !== "DRAFT" && d.status !== "CANCELLED")
                  .reduce((sum, d) => sum + d.total, 0),
              )} issued`}
        </p>
        <Link href={`/documents/new?type=${newDocType}&companyId=${companyId}`}>
          <Button size="sm">New {tradeDocumentLabels[newDocType].toLowerCase()}</Button>
        </Link>
      </div>

      {managedByResellerName && (
        <p className="rounded-base border border-line bg-surface-sunken px-3 py-2 text-xs text-muted">
          Orders for this customer are billed to {managedByResellerName}, so the invoices sit on the reseller&apos;s
          profile, not here.
        </p>
      )}

      {groups.map((group) => (
        <div key={group.docType}>
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-sm font-medium text-text">{tradeDocumentLabels[group.docType]}s</h3>
            <span className="text-xs text-subtle">{group.rows.length}</span>
          </div>

          {group.rows.length === 0 ? (
            <p className="text-sm text-subtle">None.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-sm">
                <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-3 py-2">Number</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                    <th className="px-3 py-2">Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((doc) => (
                    <tr key={doc.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                      <td className="px-3 py-2 font-mono text-xs">
                        <Link href={`/documents/${doc.id}`} className="text-text hover:underline">
                          {isDraftNumber(doc.docNumber) ? "Draft" : doc.docNumber}
                        </Link>
                        {doc.irn && (
                          <Badge tone="green" className="ml-2">
                            IRN
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={statusTone[doc.status]}>{tradeDocumentStatusLabels[doc.status]}</Badge>
                      </td>
                      <td className="px-3 py-2 text-muted">{formatCalendarDay(doc.issueDate)}</td>
                      <td className="px-3 py-2 text-right font-medium text-text">{formatCurrency(doc.total)}</td>
                      <td className="px-3 py-2 text-subtle">{doc.reference ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
