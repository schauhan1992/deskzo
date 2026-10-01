"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  acceptPriceIncrease,
  holdOrder,
  releaseOrder,
  scheduleRelease,
  sendBackPriceIncrease,
  setOrderQuote,
  settleVendorPo,
} from "@/actions/order";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { CompanyCombobox } from "@/components/ui/company-combobox";
import { istTodayKey, shortDay, type ReleaseState } from "@/lib/orders/handoff-rules";
import { formatCurrency } from "@/lib/utils";

/**
 * The controls for an order's hand-off to purchase and its distributor price, each a small client
 * island on the order page (src/components/orders/order-detail.tsx decides who sees which):
 *
 *   · `OrderHandoffPanel` — sales sends an in-hand order to purchase now, schedules it, or holds it;
 *   · `OrderPriceReview` — sales accepts purchase's higher price or sends it back;
 *   · `OrderQuoteEditor` — sales adds, changes or removes the distributor price before purchase buys;
 *   · `VendorPoSettle` — purchase says what became of the vendor PO on a cancelled order.
 */

function useAction() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void) {
    setError(null);
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
  return { isPending, error, run };
}

const tomorrowKey = () => new Date(Date.parse(`${istTodayKey(new Date())}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export function OrderHandoffPanel({
  orderId,
  purchaseRelease,
  releaseOn,
}: {
  orderId: string;
  purchaseRelease: ReleaseState;
  releaseOn: Date | string | null;
}) {
  const { isPending, error, run } = useAction();
  const [date, setDate] = useState(() => (releaseOn ? new Date(releaseOn).toISOString().slice(0, 10) : tomorrowKey()));
  if (purchaseRelease === "RELEASED") return null;

  return (
    <div className="space-y-2 rounded-md border border-warning bg-warning-bg p-3">
      <p className="text-sm font-medium text-text">
        {purchaseRelease === "HELD"
          ? "In hand — not yet sent to purchase"
          : `Goes to purchase on ${releaseOn ? shortDay(releaseOn) : "its day"}`}
      </p>
      <p className="text-xs text-muted">Purchase can&apos;t process it until it&apos;s sent. You can change this until then.</p>
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button type="button" size="sm" disabled={isPending} onClick={() => run(() => releaseOrder(orderId))}>
        {isPending ? "Saving…" : "Send to purchase now"}
      </Button>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={`release-on-${orderId}`} className="text-xs">
            {purchaseRelease === "SCHEDULED" ? "Move to" : "Or schedule for"}
          </Label>
          <Input
            id={`release-on-${orderId}`}
            type="date"
            min={tomorrowKey()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-40"
          />
        </div>
        <Button type="button" variant="secondary" size="sm" disabled={isPending || !date} onClick={() => run(() => scheduleRelease(orderId, date))}>
          Schedule
        </Button>
        {purchaseRelease === "SCHEDULED" && (
          <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={() => run(() => holdOrder(orderId))}>
            Hold instead
          </Button>
        )}
      </div>
    </div>
  );
}

export type PendingIncrease = {
  price: number;
  /** What the price is above: the salesperson's distributor price, or a price sales already accepted. */
  ceiling: number | null;
  quantity: number;
  vendorName: string | null;
  reason: string;
  requestedBy: string | null;
  requestedAt: Date | string;
};

export function OrderPriceReview({
  orderId,
  pending,
  canDecide,
}: {
  orderId: string;
  pending: PendingIncrease;
  /** The salesperson, or an approver — and not the purchaser who proposed it. */
  canDecide: boolean;
}) {
  const { isPending, error, run } = useAction();
  const [showSendBack, setShowSendBack] = useState(false);
  const [note, setNote] = useState("");
  const over = pending.ceiling !== null ? Math.round((pending.price - pending.ceiling) * 100) / 100 : null;

  return (
    <div className="space-y-2 rounded-md border border-warning bg-warning-bg p-3">
      <p className="text-sm font-medium text-text">{canDecide ? "Purchase needs a higher price" : "Waiting for sales approval"}</p>
      <p className="text-sm text-text">
        {pending.requestedBy ?? "Purchase"} can get this at {formatCurrency(pending.price)}
        {pending.vendorName ? ` from ${pending.vendorName}` : ""}
        {over !== null ? `, ${formatCurrency(over)} a unit above ${formatCurrency(pending.ceiling)}` : ""}
        {over !== null && pending.quantity > 1 ? ` (${formatCurrency(over * pending.quantity)} on the order)` : ""}.
      </p>
      <p className="text-sm text-muted">&ldquo;{pending.reason}&rdquo;</p>
      {error && <p className="text-sm text-danger">{error}</p>}
      {canDecide && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={isPending} onClick={() => run(() => acceptPriceIncrease(orderId))}>
            {isPending ? "Saving…" : "Accept this price"}
          </Button>
          <Button type="button" variant="secondary" size="sm" disabled={isPending} onClick={() => setShowSendBack(true)}>
            Send back
          </Button>
        </div>
      )}
      {canDecide && <p className="text-xs text-subtle">Or cancel the order below, if it no longer makes sense at this price.</p>}

      <Dialog open={showSendBack} onClose={() => setShowSendBack(false)} title="Send the price back to purchase">
        <p className="text-sm text-muted">Purchase is told, and looks again. Say what you&apos;d like them to try.</p>
        <Textarea
          aria-label="Note to purchase"
          className="mt-2"
          placeholder="Try the other distributor; the customer won't pay more…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowSendBack(false)} disabled={isPending}>
            Keep it waiting
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={isPending || note.trim().length < 3}
            onClick={() => run(() => sendBackPriceIncrease(orderId, note), () => setShowSendBack(false))}
          >
            {isPending ? "Sending…" : "Send back"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

export type QuoteValues = {
  price: number | null;
  vendorId: string | null;
  vendorName: string | null;
  contact: string | null;
  quotedOn: Date | string | null;
  remarks: string | null;
};

export function OrderQuoteEditor({
  orderId,
  quote,
  vendors,
}: {
  orderId: string;
  quote: QuoteValues;
  vendors: { id: string; name: string }[];
}) {
  const { isPending, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState(quote.price !== null ? String(quote.price) : "");
  const [vendorId, setVendorId] = useState(quote.vendorId ?? "");
  const [vendorName, setVendorName] = useState(quote.vendorName ?? "");
  const [contact, setContact] = useState(quote.contact ?? "");
  const [quotedOn, setQuotedOn] = useState(quote.quotedOn ? new Date(quote.quotedOn).toISOString().slice(0, 10) : "");
  const [remarks, setRemarks] = useState(quote.remarks ?? "");

  const save = (remove: boolean) =>
    run(
      () =>
        setOrderQuote(
          remove
            ? { orderId }
            : { orderId, quotedPurchasePrice: price, quoteVendorId: vendorId, quoteVendorName: vendorName, quoteContact: contact, quotedOn, quoteRemarks: remarks },
        ),
      () => setOpen(false),
    );

  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {quote.price === null ? "Add distributor price" : "Change"}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Distributor price">
        <div className="space-y-3">
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor={`quote-price-${orderId}`} className="text-xs">Price per unit</Label>
              <Input id={`quote-price-${orderId}`} type="number" step="0.01" min={0} value={price} onChange={(e) => setPrice(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`quote-on-${orderId}`} className="text-xs">Date quoted</Label>
              <Input
                id={`quote-on-${orderId}`}
                type="date"
                max={istTodayKey(new Date())}
                value={quotedOn}
                onChange={(e) => setQuotedOn(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`quote-vendor-${orderId}`} className="text-xs">Distributor</Label>
            <CompanyCombobox
              id={`quote-vendor-${orderId}`}
              companies={vendors}
              value={vendorId}
              onSelect={(v) => {
                setVendorId(v?.id ?? "");
                if (v) setVendorName("");
              }}
              placeholder="Search vendors…"
            />
            {!vendorId && (
              <Input
                aria-label="Distributor's name, if not in the CRM"
                placeholder="…or type their name"
                value={vendorName}
                onChange={(e) => setVendorName(e.target.value)}
              />
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor={`quote-contact-${orderId}`} className="text-xs">Contact at the distributor</Label>
            <Input id={`quote-contact-${orderId}`} value={contact} onChange={(e) => setContact(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`quote-remarks-${orderId}`} className="text-xs">Remarks</Label>
            <Textarea id={`quote-remarks-${orderId}`} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap justify-between gap-2">
          {quote.price !== null ? (
            <Button type="button" variant="ghost" size="sm" className="text-danger" disabled={isPending} onClick={() => save(true)}>
              Remove price
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="button" size="sm" disabled={isPending || price === ""} onClick={() => save(false)}>
              {isPending ? "Saving…" : "Save price"}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

export function VendorPoSettle({ orderId }: { orderId: string }) {
  const { isPending, error, run } = useAction();
  return (
    <div className="space-y-2 rounded-md border border-danger bg-danger-bg p-3">
      <p className="text-sm font-medium text-text">Vendor PO to cancel</p>
      <p className="text-xs text-muted">This order was cancelled after purchase placed it. Say what became of our PO with the vendor.</p>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={isPending} onClick={() => run(() => settleVendorPo(orderId, "CANCELLED"))}>
          Vendor PO cancelled
        </Button>
        <Button type="button" variant="secondary" size="sm" disabled={isPending} onClick={() => run(() => settleVendorPo(orderId, "NOT_NEEDED"))}>
          Not needed
        </Button>
      </div>
    </div>
  );
}
