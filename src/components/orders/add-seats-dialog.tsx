"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Plus } from "lucide-react";
import type { quoteAddon } from "@/actions/addon";
import { createAddon, quoteAddon as getQuote } from "@/actions/addon";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { formatCurrency, formatDate } from "@/lib/utils";

type Quote = NonNullable<Awaited<ReturnType<typeof quoteAddon>>>;

/**
 * Adding seats to a subscription that is already running.
 *
 * The pro-rated price is worked out as the quantity and date are typed, because that figure is the
 * first thing a customer queries — it belongs on screen before the order exists, not discovered on
 * the invoice a week later.
 */
export function AddSeatsDialog({
  subscription,
  label,
}: {
  subscription: { id: string; quantity: number; endDate: Date | string | null };
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [quantity, setQuantity] = useState("1");
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [annualOverride, setAnnualOverride] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [notes, setNotes] = useState("");

  // Held with the inputs it was quoted for, so the figure on screen always belongs to what is in
  // the boxes — rather than briefly showing the previous quantity's price.
  const [quoted, setQuoted] = useState<{ key: string; quote: Quote } | null>(null);
  const key = `${subscription.id}|${quantity}|${startDate}`;
  const quote = quoted?.key === key ? quoted.quote : null;

  useEffect(() => {
    if (!open) return;
    const qty = Number(quantity);
    if (!qty || qty <= 0 || !startDate) return;
    let cancelled = false;
    getQuote({ parentId: subscription.id, quantity: qty, startDate }).then((result) => {
      if (!cancelled && result) setQuoted({ key, quote: result });
    });
    return () => {
      cancelled = true;
    };
  }, [open, key, subscription.id, quantity, startDate]);

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        {label ?? "Add seats"}
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title="Add seats to this subscription">
        <div className="space-y-4">
          <p className="text-sm text-muted">
            The extra seats expire with the original
            {subscription.endDate && <> on {formatDate(subscription.endDate)}</>}, so the customer keeps one renewal
            date — and they are charged for the remaining days only.
          </p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="qty">How many extra</Label>
              <Input id="qty" type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              <p className="text-xs text-subtle">On top of the {subscription.quantity} already running.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="from">From</Label>
              <Input id="from" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              <p className="text-xs text-subtle">Usually the day they&apos;re provisioned.</p>
            </div>
          </div>

          {/* The figure, worked out live. */}
          {quote?.quote && quote.problems.length === 0 && (
            <Card className="px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-muted">Charge now</span>
                <span className="text-lg font-semibold tabular-nums text-text">
                  {formatCurrency(quote.quote.total)}
                </span>
              </div>
              <div className="mt-1 flex items-baseline justify-between gap-3 text-xs text-subtle">
                <span>Per seat</span>
                <span className="tabular-nums">{formatCurrency(quote.quote.unitPrice)}</span>
              </div>
              <p className="mt-2 text-xs text-muted">{quote.quote.workings}</p>
            </Card>
          )}

          {quote && quote.problems.length > 0 && (
            <Card className="border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
              {quote.problems.map((p) => (
                <p key={p.field} className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  {p.message}
                </p>
              ))}
            </Card>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="annual">Full-year price a seat</Label>
              <Input
                id="annual"
                type="number"
                value={annualOverride}
                onChange={(e) => setAnnualOverride(e.target.value)}
                placeholder={quote ? String(quote.annualUnitPrice) : ""}
              />
              <p className="text-xs text-subtle">
                Defaults to the original&apos;s. The renewal prices from this, not from the pro-rated figure.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cost">What we pay for it</Label>
              <Input
                id="cost"
                type="number"
                value={purchasePrice}
                onChange={(e) => setPurchasePrice(e.target.value)}
              />
              <p className="text-xs text-subtle">Pro-rated too, if the vendor bills that way.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="po">Their PO</Label>
              <Input id="po" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="anotes">Notes</Label>
            <Textarea id="anotes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <p className="text-xs text-subtle">
            This is raised as its own order and goes through the usual approval — extra seats are a sale, and the
            margin on them matters as much as on the original.
          </p>

          <div className="flex gap-2">
            <Button
              disabled={pending || !quote?.quote || (quote?.problems.length ?? 0) > 0}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await createAddon({
                    parentId: subscription.id,
                    quantity: Number(quantity),
                    startDate,
                    fullTermUnitPrice: annualOverride ? Number(annualOverride) : undefined,
                    purchasePrice: purchasePrice ? Number(purchasePrice) : undefined,
                    poNumber,
                    notes,
                  });
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  setOpen(false);
                  router.refresh();
                });
              }}
            >
              {pending ? "Adding…" : quote?.quote ? `Add for ${formatCurrency(quote.quote.total)}` : "Add"}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
