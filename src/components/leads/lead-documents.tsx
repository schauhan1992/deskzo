import Link from "next/link";
import { FileText } from "lucide-react";
import type { listLeadDocuments } from "@/actions/trade-document";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/lib/utils";
import { statusTone, tradeDocumentLabels, tradeDocumentStatusLabels } from "@/lib/trade-documents";

type Row = Awaited<ReturnType<typeof listLeadDocuments>>[number];

/**
 * Every proposal raised from this deal, and whatever those proposals became.
 *
 * A converted proposal keeps the lead, so an invoice raised off the back of one shows here too —
 * which is the point: "what did we actually send them, and where did it get to" is one question,
 * not two, and answering it from the deal saves going to the company and filtering by hand.
 */
export function LeadDocuments({
  documents,
  leadId,
  canCreate,
}: {
  documents: Row[];
  leadId: string;
  canCreate: boolean;
}) {
  const newProposalHref = `/documents/new?type=PROPOSAL&leadId=${leadId}`;

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-text">
          Proposals &amp; documents
          {documents.length > 0 && <span className="ml-1.5 text-xs font-normal text-subtle">{documents.length}</span>}
        </span>
        {canCreate && documents.length > 0 && (
          <Link href={newProposalHref}>
            <Button size="sm" variant="secondary">
              + Proposal
            </Button>
          </Link>
        )}
      </CardHeader>

      <CardContent className="p-0">
        {documents.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <FileText className="mx-auto h-6 w-6 text-subtle" />
            <p className="mt-2 text-sm text-muted">Nothing sent for this deal yet.</p>
            {canCreate && (
              <Link href={newProposalHref} className="mt-3 inline-block">
                <Button size="sm">Create proposal</Button>
              </Link>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-y border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2.5">Number</th>
                  <th className="px-4 py-2.5">Type</th>
                  <th className="px-4 py-2.5">Issued</th>
                  <th className="px-4 py-2.5">Valid until</th>
                  <th className="px-4 py-2.5">Owner</th>
                  <th className="px-4 py-2.5 text-right">Value</th>
                  <th className="px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => {
                  // Nothing sweeps issued quotations into EXPIRED when their date passes, so one
                  // that has run out still reads as "Issued". Flagged here rather than left for
                  // someone to work out from a date in a column they may not read.
                  const lapsed =
                    doc.validUntil && doc.status === "ISSUED" && new Date(doc.validUntil) < new Date();
                  return (
                    <tr key={doc.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                      <td className="px-4 py-2.5">
                        <Link href={`/documents/${doc.id}`} className="font-mono text-xs text-text hover:underline">
                          {doc.docNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-muted">{tradeDocumentLabels[doc.docType]}</td>
                      <td className="px-4 py-2.5 text-muted">{formatDate(doc.issueDate)}</td>
                      <td className="px-4 py-2.5 text-muted">
                        {doc.validUntil ? formatDate(doc.validUntil) : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-muted">{doc.salesperson?.name ?? "—"}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-text">
                        {formatCurrency(doc.total?.toString())}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge tone={statusTone[doc.status]}>{tradeDocumentStatusLabels[doc.status]}</Badge>
                          {lapsed && <Badge tone="amber">Past validity</Badge>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
