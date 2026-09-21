"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { TradeDocumentType } from "@prisma/client";
import { bulkUpdateTradeDocuments } from "@/actions/trade-document";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { BulkBar, Checkbox, useRowSelection } from "@/components/ui/bulk-select";
import { formatCurrency, formatDate } from "@/lib/utils";
import { documentDirection, manualStatuses, statusTone, tradeDocumentStatusLabels } from "@/lib/trade-documents";
import { isDraftNumber } from "@/lib/document-numbering";
import type { TradeDocumentStatus, EInvoiceStatus, CompanyRelationshipType } from "@prisma/client";

/** Declared structurally rather than derived from one query, since both list screens feed this. */
type DocumentRow = {
  id: string;
  docNumber: string;
  status: TradeDocumentStatus;
  issueDate: Date | string;
  total: number;
  currency: string;
  reference: string | null;
  einvoiceStatus: EInvoiceStatus;
  irn: string | null;
  company: { id: string; name: string; relationshipType: CompanyRelationshipType };
  createdBy: { name: string };
  salesperson: { id: string; name: string } | null;
};

/**
 * The selectable rows of a document list. Split out from the (server) list screen so the table can
 * hold selection state without turning the whole page into a client component.
 */
export function DocumentRows({
  docType,
  documents,
  eInvoiced,
}: {
  docType: TradeDocumentType;
  documents: DocumentRow[];
  eInvoiced: boolean;
}) {
  const router = useRouter();
  const selection = useRowSelection(documents);
  const isSales = documentDirection[docType] === "SALES";

  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  function run(action: "issue" | "status" | "delete") {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await bulkUpdateTradeDocuments({ documentIds: selection.ids, action, status });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const { count, skipped } = result.data;
      setNotice(
        `${action === "issue" ? "Issued" : action === "delete" ? "Deleted" : "Updated"} ${count} document(s).` +
          (skipped > 0 ? ` ${skipped} skipped — not in a state to change.` : ""),
      );
      setStatus("");
      selection.clear();
      router.refresh();
    });
  }

  return (
    <>
      <BulkBar count={selection.count} onClear={selection.clear} error={error} notice={notice}>
        <Button size="sm" disabled={isPending} onClick={() => run("issue")}>
          Issue
        </Button>
        {/* Sits in the bulk bar between two buttons, with no caption but its first option. */}
        <Select
          aria-label="Status to apply"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-9 w-48"
        >
          <option value="">Status — no change</option>
          {manualStatuses[docType].map((s) => (
            <option key={s} value={s}>
              {tradeDocumentStatusLabels[s]}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="secondary" disabled={!status || isPending} onClick={() => run("status")}>
          Apply status
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={isPending}
          onClick={() => {
            if (confirm(`Delete ${selection.count} draft(s)? Issued documents are skipped.`)) run("delete");
          }}
        >
          Delete drafts
        </Button>
      </BulkBar>

      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="w-10 px-4 py-2.5">
                <Checkbox
                  checked={selection.allSelected}
                  onChange={selection.toggleAll}
                  aria-label="Select all documents on this page"
                />
              </th>
              <th className="px-4 py-2.5">Date</th>
              <th className="px-4 py-2.5">Number</th>
              <th className="px-4 py-2.5">Reference #</th>
              <th className="px-4 py-2.5">Party</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5 text-right">Amount</th>
              {eInvoiced && <th className="px-4 py-2.5">e-Invoice</th>}
              <th className="px-4 py-2.5">{isSales ? "Salesperson" : "Raised by"}</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <tr key={doc.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                <td className="px-4 py-2.5">
                  <Checkbox
                    checked={selection.isSelected(doc.id)}
                    onChange={() => selection.toggle(doc.id)}
                    aria-label={`Select ${doc.docNumber}`}
                  />
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap text-muted">{formatDate(doc.issueDate)}</td>
                <td className="px-4 py-2.5 font-mono text-xs">
                  <Link href={`/documents/${doc.id}`} className="text-brand hover:underline">
                    {isDraftNumber(doc.docNumber) ? "Draft" : doc.docNumber}
                  </Link>
                </td>
                <td className="px-4 py-2.5 text-subtle">{doc.reference || "—"}</td>
                <td className="px-4 py-2.5">
                  <Link href={`/companies/${doc.company.id}`} className="text-text hover:underline">
                    {doc.company.name}
                  </Link>
                  {doc.company.relationshipType === "RESELLER" && (
                    <Badge tone="blue" className="ml-2">
                      Reseller
                    </Badge>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={statusTone[doc.status]}>{tradeDocumentStatusLabels[doc.status]}</Badge>
                </td>
                <td className="px-4 py-2.5 text-right font-medium text-text">{formatCurrency(doc.total, doc.currency)}</td>
                {eInvoiced && (
                  <td className="px-4 py-2.5">
                    {doc.irn ? (
                      <Badge tone="green">IRN generated</Badge>
                    ) : doc.einvoiceStatus === "FAILED" ? (
                      <Badge tone="red">Failed</Badge>
                    ) : doc.einvoiceStatus === "CANCELLED" ? (
                      <Badge tone="default">Cancelled</Badge>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </td>
                )}
                <td className="px-4 py-2.5 text-muted">
                  {isSales ? (doc.salesperson?.name ?? "—") : doc.createdBy.name}
                </td>
              </tr>
            ))}
            {documents.length === 0 && (
              <tr>
                <td colSpan={eInvoiced ? 9 : 8} className="px-4 py-10 text-center text-subtle">
                  Nothing here yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
