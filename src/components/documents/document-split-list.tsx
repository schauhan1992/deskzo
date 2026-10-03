"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type {
  TradeDocumentStatus,
  EInvoiceStatus,
  CompanyRelationshipType,
  DocumentApprovalStatus,
} from "@prisma/client";
import { approvalStatusLabels, approvalStatusTone } from "@/lib/documents/approval";
import { Badge } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";
import { statusTone, tradeDocumentStatusLabels } from "@/lib/trade-documents";
import { isDraftNumber } from "@/lib/document-numbering";
import { SELECTED_PARAM } from "@/lib/view-mode";

type DocumentRow = {
  id: string;
  docNumber: string;
  status: TradeDocumentStatus;
  issueDate: Date | string;
  total: number;
  reference: string | null;
  einvoiceStatus: EInvoiceStatus;
  irn: string | null;
  company: { id: string; name: string; relationshipType: CompanyRelationshipType };
  createdBy: { name: string };
  approvalStatus?: DocumentApprovalStatus;
};

/**
 * The narrow list beside an open document. Deliberately a different shape to the full table: it has
 * about a third of the width, so it leads with the customer and the amount — the two things you
 * scan for — and drops the columns that only make sense side by side.
 *
 * Selection lives in the URL (`?sel=`) rather than component state, so a particular document in the
 * split view is a link somebody can send.
 */
export function DocumentSplitList({
  documents,
  selectedId,
  approvalEnabled = false,
  approvalRequiredIds,
}: {
  documents: DocumentRow[];
  selectedId: string | null;
  /** Off means nothing asked for approval, so nothing is said about it. See DocumentRows. */
  approvalEnabled?: boolean;
  /** Which documents need sign-off, when the type needs it only above a limit. Left out: all of them. */
  approvalRequiredIds?: string[];
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function hrefFor(id: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(SELECTED_PARAM, id);
    return `${pathname}?${params.toString()}`;
  }

  return (
    <div className="divide-y divide-line">
      {documents.map((doc) => {
        const active = doc.id === selectedId;
        return (
          <Link
            key={doc.id}
            href={hrefFor(doc.id)}
            scroll={false}
            aria-current={active ? "true" : undefined}
            className={`block px-4 py-3 transition-colors ${
              active ? "bg-brand-subtle" : "hover:bg-surface-sunken"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <span className={`truncate text-sm font-medium ${active ? "text-brand" : "text-text"}`}>
                {doc.company.name}
              </span>
              <span className="shrink-0 text-sm font-semibold text-text">{formatCurrency(doc.total)}</span>
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-subtle">
              <span className="font-mono">{isDraftNumber(doc.docNumber) ? "Draft" : doc.docNumber}</span>
              <span>·</span>
              <span>{formatCalendarDay(doc.issueDate)}</span>
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <Badge tone={statusTone[doc.status]}>{tradeDocumentStatusLabels[doc.status]}</Badge>
              {(approvalRequiredIds ? approvalRequiredIds.includes(doc.id) : approvalEnabled) && doc.approvalStatus && doc.approvalStatus !== "APPROVED" && (
                <Badge tone={approvalStatusTone[doc.approvalStatus]}>{approvalStatusLabels[doc.approvalStatus]}</Badge>
              )}
              {doc.irn && <Badge tone="green">IRN</Badge>}
            </div>
          </Link>
        );
      })}
      {documents.length === 0 && <p className="px-4 py-8 text-center text-sm text-subtle">Nothing here yet.</p>}
    </div>
  );
}
