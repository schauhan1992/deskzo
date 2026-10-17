"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { FilePlus2, Link2, Unlink } from "lucide-react";
import { createInvoicesForOrders, invoiceLinesToLink, linkInvoiceLine, unlinkInvoiceLine, type LinkableInvoiceLine } from "@/actions/order-billing";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatOrderId } from "@/lib/order-id";
import { orderPath } from "@/lib/record-links";
import { documentPath } from "@/lib/trade-documents";
import { formatCurrency } from "@/lib/utils";
import { useWording } from "@/components/terms/wording-provider";
import { slot } from "@/lib/terms/dictionary";
import {
  billingStatusLabels,
  billingStatusTones,
  quantityLabel,
  type BilledDocument,
  type OrderBilling,
  type OrderBillingStatus,
} from "@/lib/orders/billing-rules";

export type PoSibling = { id: string; orderSeq: number; itemName: string; status: OrderBillingStatus; remaining: number; ordered: number };

/**
 * An order's invoicing (owner, 15 Oct 2026): how much of it is billed and by which invoices, a tax
 * invoice started from it — or from every order on the same customer PO, as one invoice or one per
 * product — and, for an order punched after its invoice, a link to that invoice.
 */
export function OrderInvoicingCard({
  order,
  billing,
  showDocuments,
  canInvoice,
  closed,
  po,
  siblings,
}: {
  order: { id: string; orderSeq: number; unit: string | null };
  billing: OrderBilling;
  /** May open invoices — without it, the status alone. */
  showDocuments: boolean;
  /** May raise invoices, in a plan that has them. */
  canInvoice: boolean;
  /** Cancelled or rejected: nothing more is invoiced. */
  closed: boolean;
  po: string | null;
  siblings: PoSibling[];
}) {
  const router = useRouter();
  const wording = useWording();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string[] | null>(null);
  const [linking, setLinking] = useState<LinkableInvoiceLine[] | null>(null);
  const unit = order.unit ? ` ${order.unit}` : "";
  const toBill = siblings.filter((s) => s.status === "NOT_INVOICED" || s.status === "PART_INVOICED");
  const allOnPo = [order.id, ...toBill.map((s) => s.id)];

  const run = (work: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) =>
    start(async () => {
      setError(null);
      const res = await work();
      if (!res.ok) return setError(res.error ?? "That didn't work.");
      after?.();
      router.refresh();
    });

  const docLink = (d: BilledDocument) =>
    showDocuments ? (
      <Link href={documentPath(d.documentId)} className="font-mono text-xs text-brand hover:underline">
        {d.docNumber}
      </Link>
    ) : (
      <span className="font-mono text-xs text-text">{d.docNumber}</span>
    );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <span className="text-sm font-medium text-text">Invoicing</span>
        <Badge tone={billingStatusTones[billing.status]}>{billingStatusLabels[billing.status]}</Badge>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {billing.status === "INSTALMENTS" ? (
          <p className="text-muted">Billed by its recurring billing schedule — {billing.invoices.length} invoice(s) raised so far.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2 text-center">
            <Figure label="Ordered" value={`${quantityLabel(billing.ordered)}${unit}`} />
            <Figure label="Invoiced" value={`${quantityLabel(billing.invoiced)}${unit}`} />
            <Figure label="To bill" value={`${quantityLabel(billing.remaining)}${unit}`} strong={billing.remaining > 0} />
          </div>
        )}

        {(billing.invoices.length > 0 || billing.drafts.length > 0 || billing.creditNotes.length > 0) && (
          <ul role="list" className="divide-y divide-line rounded-base border border-line">
            {[...billing.invoices, ...billing.drafts, ...billing.creditNotes].map((d) => (
              <li key={d.lineId} className="flex items-center gap-2 px-3 py-1.5">
                {docLink(d)}
                <span className="text-xs text-muted">
                  {d.docType === "CREDIT_NOTE" ? "Credit note" : d.status === "DRAFT" ? "Draft — not issued yet" : "Invoice"} · {quantityLabel(d.quantity)}
                  {unit}
                </span>
                {canInvoice && d.docType === "INVOICE" && d.status !== "DRAFT" && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      if (window.confirm(`Stop counting ${d.docNumber} as billing ${formatOrderId(order.orderSeq)}? The invoice itself isn't changed.`)) {
                        run(() => unlinkInvoiceLine(order.id, d.lineId));
                      }
                    }}
                    className="ml-auto grid h-6 w-6 place-items-center rounded-base text-subtle hover:bg-surface-sunken hover:text-danger"
                    title={slot(wording, "Unlink this invoice from the order", "order", "Unlink this invoice from the {one:lower}")}
                    aria-label={`Unlink ${d.docNumber}`}
                  >
                    <Unlink className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {canInvoice && !closed && (
          <div className="flex flex-wrap gap-2">
            <Link href={`/documents/new?type=INVOICE&orders=${order.id}`}>
              <Button size="sm">
                <FilePlus2 className="h-3.5 w-3.5" /> Create tax invoice
              </Button>
            </Link>
            <Button
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setError(null);
                  setLinking(await invoiceLinesToLink(order.id));
                })
              }
            >
              <Link2 className="h-3.5 w-3.5" /> Link an invoice already raised
            </Button>
          </div>
        )}

        {linking && (
          <div className="rounded-base border border-line p-2">
            <p className="mb-1.5 text-xs text-muted">
              Lines of this customer&apos;s issued invoices that bill no order yet. Linking only records which invoice billed this order — the
              invoice isn&apos;t changed.
            </p>
            {linking.length === 0 ? (
              <p className="text-xs text-subtle">None — every issued invoice line of this customer already bills an order.</p>
            ) : (
              <ul role="list" className="max-h-56 divide-y divide-line overflow-y-auto">
                {linking.map((l) => (
                  <li key={l.lineId} className="flex items-center gap-2 py-1.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-text">
                        <span className="font-mono">{l.docNumber}</span> · {l.name}
                        {l.sameProduct && <Badge tone="green" className="ml-1.5">Same product</Badge>}
                      </span>
                      <span className="block text-[11px] text-subtle">
                        {quantityLabel(l.quantity)} · {formatCurrency(l.amount)}
                      </span>
                    </span>
                    <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => linkInvoiceLine(order.id, l.lineId), () => setLinking(null))}>
                      Link
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-1.5 text-right">
              <button type="button" className="text-xs text-muted hover:text-text" onClick={() => setLinking(null)}>
                Close
              </button>
            </div>
          </div>
        )}

        {po && siblings.length > 0 && (
          <div className="border-t border-line pt-3">
            <p className="text-xs font-medium uppercase tracking-wide text-subtle">
              {slot(wording, "Customer PO", "customer", "{one} PO")} {po}
            </p>
            <ul role="list" className="mt-1.5 space-y-1">
              {siblings.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate">
                    <Link href={orderPath(s.orderSeq)} className="font-mono text-text hover:underline">
                      {formatOrderId(s.orderSeq)}
                    </Link>{" "}
                    <span className="text-muted">{s.itemName}</span>
                  </span>
                  <Badge tone={billingStatusTones[s.status]}>{billingStatusLabels[s.status]}</Badge>
                </li>
              ))}
            </ul>
            {canInvoice && !closed && toBill.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                <Link href={`/documents/new?type=INVOICE&orders=${allOnPo.join(",")}`}>
                  <Button size="sm" variant="secondary">One invoice for all {allOnPo.length}</Button>
                </Link>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => run(() => createInvoicesForOrders(allOnPo, "EACH").then((r) => (r.ok ? (setMade(r.data.ids), r) : r)))}
                >
                  One invoice per product
                </Button>
              </div>
            )}
          </div>
        )}

        {made && made.length > 0 && (
          <p className="rounded-base bg-success-bg px-2.5 py-1.5 text-xs text-success">
            {made.length} draft invoice{made.length === 1 ? "" : "s"} made — check and issue each:{" "}
            {made.map((id, i) => (
              <Link key={id} href={documentPath(id)} className="underline">
                {i + 1}
              </Link>
            )).reduce<React.ReactNode[]>((all, el, i) => (i ? [...all, ", ", el] : [el]), [])}
          </p>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
      </CardContent>
    </Card>
  );
}

function Figure({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-base bg-surface-sunken px-2 py-1.5">
      <div className="text-[11px] text-subtle">{label}</div>
      <div className={strong ? "font-semibold text-text" : "text-text"}>{value}</div>
    </div>
  );
}

/** The order's invoicing at a glance, for a list row: the status, and the invoice when there is just one. */
export function BillingChip({ status, invoices }: { status: OrderBillingStatus; invoices: { documentId: string; docNumber: string }[] }) {
  const single = invoices.length === 1 && status === "INVOICED";
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <Badge tone={billingStatusTones[status]}>{billingStatusLabels[status]}</Badge>
      {single && (
        <Link href={documentPath(invoices[0]!.documentId)} className="font-mono text-[11px] text-brand hover:underline">
          {invoices[0]!.docNumber}
        </Link>
      )}
    </span>
  );
}
