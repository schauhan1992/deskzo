"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, RefreshCw } from "lucide-react";
import type { renewalDraft } from "@/actions/renewal-order";
import { createRenewalOrder, renewalDraft as loadDraft } from "@/actions/renewal-order";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { formatCurrency, formatDate } from "@/lib/utils";
import { formatOrderId } from "@/lib/order-id";

type Loaded = NonNullable<Awaited<ReturnType<typeof renewalDraft>>>;

/**
 * Punching the renewal, once the customer has said yes.
 *
 * Everything is prefilled from the expiring subscription and shown before it is committed, because
 * the two numbers people get wrong are exactly the two this fills in: the quantity (which includes
 * seats added mid-term) and the price (which is the full-term one, not what was last charged).
 */
export function RenewButton({ companyProductId }: { companyProductId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [loaded, setLoaded] = useState<{ id: string; data: Loaded } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ orderSeq: number } | null>(null);

  const [quantity, setQuantity] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [notes, setNotes] = useState("");

  const data = loaded?.id === companyProductId ? loaded.data : null;

  useEffect(() => {
    if (!open || data) return;
    let cancelled = false;
    loadDraft(companyProductId).then((result) => {
      if (cancelled || !result) return;
      setLoaded({ id: companyProductId, data: result });
      setQuantity(String(result.draft.quantity));
      setUnitPrice(result.draft.unitPrice === null ? "" : String(result.draft.unitPrice));
      setStartDate(result.draft.term?.startDate ?? "");
      setEndDate(result.draft.term?.endDate ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [open, companyProductId, data]);

  const value = Number(quantity) * Number(unitPrice || 0);

  const close = () => {
    setOpen(false);
    setDone(null);
    setError(null);
    setPoNumber("");
    setNotes("");
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Punch the renewal order"
        aria-label="Punch the renewal order"
        className="rounded p-1 text-subtle hover:bg-surface-sunken hover:text-brand"
      >
        <RefreshCw className="h-4 w-4" />
      </button>

      <Dialog open={open} onClose={close} title="Renew this subscription">
        {done ? (
          <div className="space-y-4">
            <p className="flex items-center gap-2 text-sm text-success">
              <Check className="h-4 w-4" />
              {formatOrderId(done.orderSeq)} raised, waiting for approval.
            </p>
            <p className="text-xs text-muted">
              It goes through the same route as any other order — a renewal is a sale, and the margin on it matters as
              much as on a new one.
            </p>
            <div className="flex gap-2">
              <Button onClick={() => router.push("/orders")}>Open orders</Button>
              <Button variant="secondary" onClick={close}>
                Done
              </Button>
            </div>
          </div>
        ) : !data ? (
          <p className="py-6 text-sm text-subtle">Working out the renewal…</p>
        ) : data.alreadyRenewed ? (
          <div className="space-y-4">
            <p className="text-sm text-text">
              Already renewed by{" "}
              <span className="font-mono">{formatOrderId(data.alreadyRenewed.orderSeq)}</span>{" "}
              <Badge tone="blue">{data.alreadyRenewed.status.toLowerCase().replaceAll("_", " ")}</Badge>
            </p>
            <p className="text-xs text-muted">
              One renewal per subscription — a second would bill the same term twice. Cancel that order first if it
              was wrong.
            </p>
            <div className="flex gap-2">
              <Button onClick={() => router.push("/orders")}>Open orders</Button>
              <Button variant="secondary" onClick={close}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
            <Card className="bg-surface-sunken px-3 py-2.5">
              <p className="text-sm font-medium text-text">{data.product.itemName}</p>
              <p className="mt-0.5 text-xs text-muted">
                {data.product.companyName}
                {data.product.endCustomerName && ` · for ${data.product.endCustomerName}`}
                {data.product.locationLabel && ` · ${data.product.locationLabel}`}
              </p>
              <p className="mt-0.5 text-xs text-subtle">
                Renewing {formatOrderId(data.product.orderSeq)}, which expires{" "}
                {data.product.endDate ? formatDate(data.product.endDate) : "—"}
              </p>
            </Card>

            {data.draft.warnings.length > 0 && (
              <Card className="border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
                {data.draft.warnings.map((w) => (
                  <p key={w} className="flex items-start gap-1.5">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    {w}
                  </p>
                ))}
              </Card>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="rq">Quantity</Label>
                <Input id="rq" type="number" min={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
                <p className="text-xs text-subtle">
                  {data.product.unit ? `${data.product.unit}s. ` : ""}Includes anything added mid-term.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rp">Price each, full term</Label>
                <Input id="rp" type="number" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
                <p className="text-xs text-subtle">
                  Never the pro-rated figure a mid-term addition was charged — that covers part of a year.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="rs">New term starts</Label>
                <Input id="rs" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="re">and ends</Label>
                <Input id="re" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
            </div>
            <p className="text-xs text-subtle">
              Starts the day after the old one ends, so there is no gap in cover and no day billed twice.
            </p>

            {value > 0 && (
              <Card className="px-3 py-2.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm text-muted">Order value</span>
                  <span className="text-lg font-semibold tabular-nums text-text">{formatCurrency(value)}</span>
                </div>
              </Card>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="rpo">Their PO</Label>
                <Input id="rpo" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="rn">Notes</Label>
              <Textarea id="rn" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>

            {error && <p className="text-sm text-danger">{error}</p>}

            <p className="text-xs text-subtle">
              Raised as a normal order, pending approval. The old subscription stays as it is — history, not something
              to edit.
            </p>

            <div className="flex gap-2">
              <Button
                disabled={pending || !quantity || !startDate || !endDate}
                onClick={() => {
                  setError(null);
                  startTransition(async () => {
                    const result = await createRenewalOrder({
                      companyProductId,
                      quantity: Number(quantity),
                      unitPrice: unitPrice === "" ? null : Number(unitPrice),
                      startDate,
                      endDate,
                      poNumber,
                      notes,
                    });
                    if (!result.ok) {
                      setError(result.error);
                      return;
                    }
                    setDone({ orderSeq: result.data.orderSeq });
                    router.refresh();
                  });
                }}
              >
                {pending ? "Punching…" : value > 0 ? `Punch renewal — ${formatCurrency(value)}` : "Punch renewal"}
              </Button>
              <Button variant="secondary" onClick={close}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
