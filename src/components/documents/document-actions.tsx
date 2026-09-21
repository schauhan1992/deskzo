"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TradeDocumentType, TradeDocumentStatus, EInvoiceStatus } from "@prisma/client";
import {
  issueTradeDocument,
  convertTradeDocument,
  generateEInvoice,
  cancelEInvoice,
  setTradeDocumentStatus,
  deleteTradeDocument,
} from "@/actions/trade-document";
import { Printer, Pencil, Send, ArrowRightLeft, FileCheck2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/menu";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import {
  conversionTargets,
  documentListPath,
  isEInvoiceEligible,
  manualStatuses,
  tradeDocumentLabels,
  tradeDocumentStatusLabels,
} from "@/lib/trade-documents";
import { CANCEL_REASONS } from "@/lib/einvoice/provider";

export function DocumentActions({
  id,
  docType,
  status,
  einvoiceStatus,
  hasIrn,
  einvoiceEnabled,
  canCancelIrn,
}: {
  id: string;
  docType: TradeDocumentType;
  status: TradeDocumentStatus;
  einvoiceStatus: EInvoiceStatus;
  hasIrn: boolean;
  einvoiceEnabled: boolean;
  /** False once the portal's 24-hour window has closed, so the button doesn't offer the impossible. */
  canCancelIrn: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("1");
  const [cancelRemark, setCancelRemark] = useState("");

  const isDraft = status === "DRAFT";
  const eligible = isEInvoiceEligible(docType);
  // A dead document isn't a starting point for anything — the server refuses these conversions, and
  // offering a button that always errors is worse than not offering it.
  const isDead = status === "CANCELLED" || status === "REJECTED";
  const targets = isDead ? [] : (conversionTargets[docType] ?? []);
  // Statuses you can set by hand, minus the one it already has — setting a document to where it
  // already is isn't an action. A rejected or cancelled document keeps these: the server allows the
  // reverse, and hiding them would make a mis-click permanent with no way back through the UI.
  const markable = isDraft ? [] : manualStatuses[docType].filter((s) => s !== status);
  const canCancelEInvoice = hasIrn && einvoiceStatus === "GENERATED" && canCancelIrn;
  const hasMoreActions = markable.length > 0 || canCancelEInvoice || isDraft;

  function run(fn: () => Promise<{ ok: true; data?: unknown } | { ok: false; error: string }>, after?: () => void) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      after?.();
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {/* One bar, in the order the work happens: the action that moves the document forward first,
          then the things you do with it, then the long tail behind More. */}
      <div className="flex flex-wrap items-center gap-2">
        {isDraft ? (
          <>
            <Button
              onClick={() =>
                run(
                  () => issueTradeDocument({ id, generateEInvoice: eligible && einvoiceEnabled }),
                  () => setNotice("Issued."),
                )
              }
              disabled={pending}
            >
              <Send className="mr-1.5 h-3.5 w-3.5" />
              {eligible && einvoiceEnabled ? "Issue & generate IRN" : "Issue"}
            </Button>
            <Button variant="secondary" onClick={() => router.push(`/documents/${id}/edit`)} disabled={pending}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              Edit
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={() => window.open(`/documents/${id}/print`, "_blank")}>
              <Printer className="mr-1.5 h-3.5 w-3.5" />
              Print / PDF
            </Button>

            {targets.map((target) => (
              <Button
                key={target}
                variant="secondary"
                disabled={pending}
                onClick={() =>
                  run(
                    () => convertTradeDocument({ id, target }),
                    () => setNotice(`Created a draft ${tradeDocumentLabels[target].toLowerCase()}.`),
                  )
                }
              >
                <ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" />
                Convert to {tradeDocumentLabels[target].toLowerCase()}
              </Button>
            ))}

            {eligible && einvoiceEnabled && !hasIrn && einvoiceStatus !== "CANCELLED" && (
              <Button
                variant="subtle"
                disabled={pending}
                onClick={() => run(() => generateEInvoice(id), () => setNotice("IRN generated."))}
              >
                <FileCheck2 className="mr-1.5 h-3.5 w-3.5" />
                {einvoiceStatus === "FAILED" ? "Retry IRN" : "Generate IRN"}
              </Button>
            )}
          </>
        )}

        {hasMoreActions && (
          <Menu>
            {(close) => (
              <>
                {markable.length > 0 && <MenuLabel>Mark as</MenuLabel>}
                {markable.map((s) => (
                  <MenuItem
                    key={s}
                    disabled={pending}
                    onClick={() => {
                      close();
                      run(() => setTradeDocumentStatus(id, s));
                    }}
                  >
                    {tradeDocumentStatusLabels[s]}
                  </MenuItem>
                ))}

                {canCancelEInvoice && (
                  <>
                    {markable.length > 0 && <MenuSeparator />}
                    <MenuItem
                      danger
                      disabled={pending}
                      onClick={() => {
                        close();
                        setCancelOpen(true);
                      }}
                    >
                      Cancel e-invoice
                    </MenuItem>
                  </>
                )}

                {isDraft && (
                  <>
                    {markable.length > 0 && <MenuSeparator />}
                    <MenuItem
                      danger
                      disabled={pending}
                      onClick={() => {
                        close();
                        if (!confirm("Delete this draft? This can't be undone.")) return;
                        run(() => deleteTradeDocument(id), () => router.push(documentListPath[docType]));
                      }}
                    >
                      Delete draft
                    </MenuItem>
                  </>
                )}
              </>
            )}
          </Menu>
        )}
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}
      {notice && <p className="text-sm text-success">{notice}</p>}

      <Dialog open={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancel this e-invoice">
        <div className="space-y-4">
          <p className="text-sm text-muted">
            This cancels the IRN with the government portal. It can only be done within 24 hours of generating it —
            after that, a credit note is the only way to reverse an invoice.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="cancelReason">Reason</Label>
            <Select id="cancelReason" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)}>
              {CANCEL_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cancelRemark">Remark</Label>
            <Input
              id="cancelRemark"
              value={cancelRemark}
              onChange={(e) => setCancelRemark(e.target.value)}
              maxLength={100}
              placeholder="Raised against the wrong customer"
            />
          </div>
          <div className="flex gap-2">
            <Button
              variant="danger"
              disabled={pending || !cancelRemark.trim()}
              onClick={() =>
                run(
                  () => cancelEInvoice({ id, reason: cancelReason, remark: cancelRemark }),
                  () => {
                    setCancelOpen(false);
                    setNotice("E-invoice cancelled with the portal.");
                  },
                )
              }
            >
              Cancel e-invoice
            </Button>
            <Button variant="secondary" onClick={() => setCancelOpen(false)}>
              Keep it
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
