"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { TradeDocumentType } from "@prisma/client";
import { bulkUpdateTradeDocuments } from "@/actions/trade-document";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { CANCEL_REASON_MAX, CANCEL_REASON_MIN } from "@/lib/documents/cancel-reason";
import { BulkBar, Checkbox, useRowSelection } from "@/components/ui/bulk-select";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";
import {
  documentDirection,
  documentOriginLabels,
  documentOriginTone,
  manualStatuses,
  statusTone,
  tradeDocumentStatusLabels,
} from "@/lib/trade-documents";
import { isDraftNumber } from "@/lib/document-numbering";
import { documentTableKey } from "@/lib/tables/registry";
import { useColumns } from "@/components/ui/table-columns";
import type {
  TradeDocumentStatus,
  EInvoiceStatus,
  CompanyRelationshipType,
  DocumentOrigin,
  DocumentApprovalStatus,
} from "@prisma/client";
import { approvalStatusLabels, approvalStatusTone } from "@/lib/documents/approval";
import { companyPath } from "@/lib/record-links";

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
  company: { id: string; name: string; relationshipType: CompanyRelationshipType; companySeq: number };
  createdBy: { name: string };
  salesperson: { id: string; name: string } | null;
  /** Where it has got to in sign-off. Only shown where the type actually requires approval. */
  approvalStatus?: DocumentApprovalStatus;
  /** Which part of the app raised it. Null on a row written by a path that doesn't say. */
  origin?: DocumentOrigin | null;
  /** Where a conversion came from, so the Source cell can link to it rather than only name it. */
  sourceDocument?: { id: string; docNumber: string; docType: TradeDocumentType } | null;
  /** The branch it was raised from (on a purchase, the one buying); null on a row written before branches. */
  branch?: { id: string; name: string; code: string } | null;
};

/**
 * The selectable rows of a document list. Split out from the (server) list screen so the table can
 * hold selection state without turning the whole page into a client component.
 */
export function DocumentRows({
  docType,
  documents,
  eInvoiced,
  approvalEnabled = false,
  approvalRequiredIds,
  branchColumn = false,
}: {
  docType: TradeDocumentType;
  documents: DocumentRow[];
  eInvoiced: boolean;
  /**
   * Whether this type needs signing off.
   *
   * Passed in rather than read per row: with approval switched off every document would read
   * "Not submitted", which is a column of noise about a document nobody asked to be approved.
   */
  approvalEnabled?: boolean;
  /** Which documents need sign-off, when the type needs it only above a limit. Left out: all of them. */
  approvalRequiredIds?: string[];
  /**
   * More than one branch. Off, the Branch column is not drawn even where a stored preference from a
   * multi-branch past asks for it — the picker stops offering it too (`ColumnPicker`'s `omit`).
   */
  branchColumn?: boolean;
}) {
  const router = useRouter();
  const selection = useRowSelection(documents);
  const isSales = documentDirection[docType] === "SALES";
  /**
   * Per document type, not one key for all seven.
   *
   * The e-invoice column exists only on the two types the IRP takes, and the last column is the
   * salesperson on a sales document and whoever raised it on a purchase one — so a shared key
   * would offer toggles that do nothing and label one of them wrongly on half the screens.
   */
  const cols = useColumns(documentTableKey(docType));

  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  // Cancelling asks why — one reason for all of them (src/lib/documents/cancellation.ts).
  const [reason, setReason] = useState("");
  const needsReason = status === "CANCELLED";

  function run(action: "issue" | "status" | "delete") {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await bulkUpdateTradeDocuments({ documentIds: selection.ids, action, status, ...(action === "status" && needsReason ? { reason } : {}) });
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
      setReason("");
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
        {needsReason && (
          <Input
            aria-label="Reason for cancelling"
            placeholder="Reason for cancelling"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={CANCEL_REASON_MAX}
            className="h-9 w-64"
          />
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={!status || isPending || (needsReason && reason.trim().length < CANCEL_REASON_MIN)}
          onClick={() => run("status")}
        >
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
              {cols.show("select") && (
                <th className="w-10 px-4 py-2.5">
                  <Checkbox
                    checked={selection.allSelected}
                    onChange={selection.toggleAll}
                    aria-label="Select all documents on this page"
                  />
                </th>
              )}
              {cols.show("date") && <th className="px-4 py-2.5">Date</th>}
              {cols.show("number") && <th className="px-4 py-2.5">Number</th>}
              {cols.show("reference") && <th className="px-4 py-2.5">Reference #</th>}
              {cols.show("party") && <th className="px-4 py-2.5">Party</th>}
              {branchColumn && cols.show("branch") && <th className="px-4 py-2.5">{isSales ? "Branch" : "Buying branch"}</th>}
              {cols.show("status") && <th className="px-4 py-2.5">Status</th>}
              {cols.show("origin") && <th className="px-4 py-2.5">Source</th>}
              {cols.show("amount") && <th className="px-4 py-2.5 text-right">Amount</th>}
              {/* Two gates, and they are not the same question. `isEInvoiceEligible` decides
                  whether this document is reported to the IRP at all; the registry decides
                  whether somebody wants the column on screen. */}
              {eInvoiced && cols.show("einvoice") && <th className="px-4 py-2.5">e-Invoice</th>}
              {cols.show("owner") && (
                <th className="px-4 py-2.5">{isSales ? "Salesperson" : "Raised by"}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <tr key={doc.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                {cols.show("select") && (
                  <td className="px-4 py-2.5">
                    <Checkbox
                      checked={selection.isSelected(doc.id)}
                      onChange={() => selection.toggle(doc.id)}
                      aria-label={`Select ${doc.docNumber}`}
                    />
                  </td>
                )}
                {cols.show("date") && (
                  <td className="px-4 py-2.5 whitespace-nowrap text-muted">{formatCalendarDay(doc.issueDate)}</td>
                )}
                {cols.show("number") && (
                  <td className="px-4 py-2.5 font-mono text-xs">
                    <Link href={`/documents/${doc.id}`} className="text-brand hover:underline">
                      {isDraftNumber(doc.docNumber) ? "Draft" : doc.docNumber}
                    </Link>
                  </td>
                )}
                {cols.show("reference") && (
                  <td className="px-4 py-2.5 text-subtle">{doc.reference || "—"}</td>
                )}
                {cols.show("party") && (
                  <td className="px-4 py-2.5">
                    <Link href={companyPath(doc.company.companySeq)} className="text-text hover:underline">
                      {doc.company.name}
                    </Link>
                    {doc.company.relationshipType === "RESELLER" && (
                      <Badge tone="blue" className="ml-2">
                        Reseller
                      </Badge>
                    )}
                  </td>
                )}
                {branchColumn && cols.show("branch") && (
                  <td className="px-4 py-2.5 font-mono text-xs text-muted" title={doc.branch?.name}>
                    {doc.branch?.code ?? "—"}
                  </td>
                )}
                {cols.show("status") && (
                  <td className="px-4 py-2.5">
                    <Badge tone={statusTone[doc.status]}>{tradeDocumentStatusLabels[doc.status]}</Badge>
                  {/* Under the status rather than instead of it: the two answer different
                      questions — what the customer did with it, and whether it may go to the
                      customer at all. Approved is left unsaid, because a document that cleared
                      sign-off is simply a document again. */}
                    {(approvalRequiredIds ? approvalRequiredIds.includes(doc.id) : approvalEnabled) && doc.approvalStatus && doc.approvalStatus !== "APPROVED" && (
                      <span className="mt-1 block">
                        <Badge tone={approvalStatusTone[doc.approvalStatus]}>
                          {approvalStatusLabels[doc.approvalStatus]}
                        </Badge>
                      </span>
                    )}
                  </td>
                )}
                {cols.show("origin") && (
                  <td className="px-4 py-2.5">
                    {doc.origin ? (
                    <>
                      <Badge tone={documentOriginTone[doc.origin]}>{documentOriginLabels[doc.origin]}</Badge>
                      {/* A conversion names what it came from, because "Converted" on its own only
                          raises the question. */}
                      {doc.origin === "CONVERSION" && doc.sourceDocument && (
                        <Link
                          href={`/documents/${doc.sourceDocument.id}`}
                          className="mt-0.5 block font-mono text-[11px] text-muted hover:text-text hover:underline"
                        >
                          {doc.sourceDocument.docNumber}
                        </Link>
                      )}
                    </>
                    ) : (
                      /* Not "Entered by hand": a blank means nothing said where this came from,
                         and guessing would be worse than admitting it. */
                      <span className="text-subtle" title="This document was written by a path that doesn't record where it came from.">
                        Not recorded
                      </span>
                    )}
                  </td>
                )}
                {cols.show("amount") && (
                  <td className="px-4 py-2.5 text-right font-medium text-text">
                    {formatCurrency(doc.total, doc.currency)}
                  </td>
                )}
                {eInvoiced && cols.show("einvoice") && (
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
                {cols.show("owner") && (
                  <td className="px-4 py-2.5 text-muted">
                    {isSales ? (doc.salesperson?.name ?? "—") : doc.createdBy.name}
                  </td>
                )}
              </tr>
            ))}
            {documents.length === 0 && (
              <tr>
                <td colSpan={cols.count} className="px-4 py-10 text-center text-subtle">
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
