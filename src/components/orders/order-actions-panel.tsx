"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { OrderStatus, PaymentTerms } from "@prisma/client";
import { approveOrder, processOrder, fulfillOrder, cancelOrder } from "@/actions/order";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { CompanyCombobox } from "@/components/ui/company-combobox";
import { PaymentsDialog, type PayableOrder } from "@/components/payments/payments-dialog";
import { paymentTermsLabels } from "@/lib/gst";
import { CreditBadge } from "@/components/credit/credit-badge";
import { MIN_OVERRIDE_REASON, type CreditRating, type TermsKey } from "@/lib/credit/engine";
import { formatCurrency } from "@/lib/utils";

type VendorOption = { id: string; name: string; paymentTerms: PaymentTerms };

/** The order's credit position while it awaits approval — see `orderCreditPosition`. */
export type OrderCredit = {
  rating: CreditRating;
  score: number | null;
  recommendedTerms: TermsKey;
  terms: TermsKey;
  limit: number;
  outstanding: number;
  overdue: number;
  concerns: string[];
  termsDecided: boolean;
  canOverride: boolean;
};

export function OrderActionsPanel({
  order,
  currentUserId,
  canApprove,
  canProcess,
  canRecordPayments,
  canDeletePayments,
  vendorOptions,
  companyId,
  companyName,
  credit = null,
}: {
  order: PayableOrder & { orderStatus: OrderStatus; vendorId: string | null; purchasePrice: unknown; ourPoNumber: string | null; addedByUserId: string };
  currentUserId: string;
  canApprove: boolean;
  canProcess: boolean;
  canRecordPayments: boolean;
  canDeletePayments: boolean;
  vendorOptions: VendorOption[];
  companyId: string;
  companyName: string;
  credit?: OrderCredit | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [approveNotes, setApproveNotes] = useState("");
  const [creditReason, setCreditReason] = useState("");
  const [showReject, setShowReject] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [showPayments, setShowPayments] = useState(false);

  const [vendorId, setVendorId] = useState(order.vendorId ?? "");
  const [purchasePrice, setPurchasePrice] = useState(order.purchasePrice ? String(order.purchasePrice) : "");
  const [ourPoNumber, setOurPoNumber] = useState(order.ourPoNumber ?? "");

  function handleApprove(approved: boolean, notes?: string) {
    setError(null);
    startTransition(async () => {
      const result = await approveOrder({ orderId: order.id, approved, notes: notes ?? "", creditOverrideReason: creditReason });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setShowReject(false);
      router.refresh();
    });
  }

  function handleProcess() {
    setError(null);
    startTransition(async () => {
      const result = await processOrder({ orderId: order.id, vendorId, purchasePrice, ourPoNumber });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function handleFulfill() {
    setError(null);
    startTransition(async () => {
      const result = await fulfillOrder(order.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function handleCancel() {
    setError(null);
    startTransition(async () => {
      const result = await cancelOrder(order.id, cancelReason);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setShowCancel(false);
      router.refresh();
    });
  }

  const canCancel =
    order.orderStatus !== "FULFILLED" &&
    order.orderStatus !== "CANCELLED" &&
    (order.addedByUserId === currentUserId || canApprove || canProcess);

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-danger">{error}</p>}

      {order.orderStatus === "PENDING_APPROVAL" && canApprove && (
        <div className="space-y-2 rounded-md border border-warning bg-warning-bg p-3">
          <p className="text-sm font-medium text-text">Awaiting your review</p>
          {credit && (
            <div className="space-y-1.5 rounded-md border border-line bg-surface p-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted">Credit</span>
                <CreditBadge rating={credit.rating} score={credit.score} />
                <span className="text-muted">
                  {paymentTermsLabels[credit.terms]} on this order · up to {paymentTermsLabels[credit.recommendedTerms]} suggested · owes{" "}
                  {formatCurrency(credit.outstanding)} of {formatCurrency(credit.limit)}
                  {credit.overdue > 0 && <span className="text-danger"> ({formatCurrency(credit.overdue)} overdue)</span>}
                </span>
              </div>
              {credit.termsDecided && <p className="text-muted">Its terms were approved as a credit override when it was punched.</p>}
              {credit.concerns.length > 0 && (
                <div className="space-y-1.5 text-warning">
                  <p className="font-medium">Approving this needs a credit override:</p>
                  <ul className="list-disc space-y-0.5 pl-4">
                    {credit.concerns.map((c) => (
                      <li key={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</li>
                    ))}
                  </ul>
                  {credit.canOverride ? (
                    <Textarea
                      aria-label="Why approve it anyway"
                      placeholder="Why approve it anyway — kept on the customer's credit record"
                      value={creditReason}
                      onChange={(e) => setCreditReason(e.target.value)}
                    />
                  ) : (
                    <p className="text-muted">Only someone who can override credit terms can approve it. You can still reject it.</p>
                  )}
                </div>
              )}
            </div>
          )}
          <Textarea
            aria-label="Approval notes"
            placeholder="Notes (optional)"
            value={approveNotes}
            onChange={(e) => setApproveNotes(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={isPending || (!!credit && credit.concerns.length > 0 && (!credit.canOverride || creditReason.trim().length < MIN_OVERRIDE_REASON))}
              onClick={() => handleApprove(true, approveNotes)}
            >
              {isPending ? "Saving…" : credit && credit.concerns.length > 0 ? "Approve with credit override" : "Approve"}
            </Button>
            <Button type="button" variant="danger" size="sm" disabled={isPending} onClick={() => setShowReject(true)}>
              Reject
            </Button>
          </div>
        </div>
      )}

      {(order.orderStatus === "APPROVED" || order.orderStatus === "PROCESSING") && canProcess && (
        <div className="space-y-2 rounded-md border border-info bg-info-bg p-3">
          <p className="text-sm font-medium text-text">Purchasing</p>
          <div className="space-y-1">
            <Label className="text-xs">Vendor</Label>
            <CompanyCombobox
              companies={vendorOptions.map((v) => ({
                id: v.id,
                name: v.name,
                hint: paymentTermsLabels[v.paymentTerms],
              }))}
              value={vendorId}
              onSelect={(vendor) => setVendorId(vendor?.id ?? "")}
              placeholder="Type to search vendors…"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="order-purchase-price" className="text-xs">Purchase price / unit</Label>
              <Input
                id="order-purchase-price"
                type="number"
                step="0.01"
                value={purchasePrice}
                onChange={(e) => setPurchasePrice(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="order-our-po" className="text-xs">Our PO to vendor</Label>
              <Input id="order-our-po" value={ourPoNumber} onChange={(e) => setOurPoNumber(e.target.value)} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={isPending} onClick={handleProcess}>
              {isPending ? "Saving…" : "Save purchasing details"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={isPending || !order.vendorId || order.purchasePrice === null}
              onClick={handleFulfill}
              title={!order.vendorId || order.purchasePrice === null ? "Save vendor and purchase price first" : undefined}
            >
              Mark fulfilled
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {(canRecordPayments || canDeletePayments) && (
          <Button type="button" variant="secondary" size="sm" onClick={() => setShowPayments(true)}>
            Payments
          </Button>
        )}
        {canCancel && (
          <Button type="button" variant="ghost" size="sm" className="text-danger" onClick={() => setShowCancel(true)}>
            Cancel order
          </Button>
        )}
      </div>

      <Dialog open={showReject} onClose={() => setShowReject(false)} title="Reject order">
        <p className="text-sm text-muted">This tells the sales person the order needs rework before it can proceed.</p>
        <Textarea
          aria-label="Reason for rejecting"
          className="mt-2"
          placeholder="Reason (optional)"
          value={approveNotes}
          onChange={(e) => setApproveNotes(e.target.value)}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowReject(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button type="button" variant="danger" size="sm" disabled={isPending} onClick={() => handleApprove(false, approveNotes)}>
            {isPending ? "Saving…" : "Reject"}
          </Button>
        </div>
      </Dialog>

      <Dialog open={showCancel} onClose={() => setShowCancel(false)} title="Cancel order">
        <p className="text-sm text-muted">This can&apos;t be undone.</p>
        <Textarea
          aria-label="Reason for cancelling"
          className="mt-2"
          placeholder="Reason (optional)"
          value={cancelReason}
          onChange={(e) => setCancelReason(e.target.value)}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowCancel(false)} disabled={isPending}>
            Keep order
          </Button>
          <Button type="button" variant="danger" size="sm" disabled={isPending} onClick={handleCancel}>
            {isPending ? "Cancelling…" : "Cancel order"}
          </Button>
        </div>
      </Dialog>

      {showPayments && (
        <PaymentsDialog
          order={order}
          open
          onClose={() => setShowPayments(false)}
          canRecord={canRecordPayments}
          canDelete={canDeletePayments}
          companyId={companyId}
          companyName={companyName}
        />
      )}
    </div>
  );
}
