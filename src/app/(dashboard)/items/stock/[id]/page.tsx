import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { getStockDocument, inventoryCapabilities } from "@/actions/inventory";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { StockDocumentActions } from "@/components/inventory/stock-document-actions";
import { movementTypeLabel, qty, rupees, stockStatusLabel, stockStatusTone, stockTypeLabel } from "@/components/inventory/labels";
import { formatCalendarDay } from "@/lib/time/zone";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * One stock voucher (owner, 22 Oct 2026): what it says, what it moved and at what value, the ledger entries it
 * wrote under perpetual inventory, and who did what when. What can be done next is StockDocumentActions'.
 */
export default async function StockVoucherPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isModuleEnabled("items"))) return <ModuleDisabledNotice moduleKey="items" />;
  const { id } = await params;
  const [doc, caps, clock] = await Promise.all([getStockDocument(id), inventoryCapabilities(), workspaceClock()]);
  if (!doc) notFound();

  const isGrn = doc.type === "GRN";
  const isCount = doc.type === "PHYSICAL_COUNT";
  // At cost, once: a transfer's arrival repeats its departure's value, and a reversal undoes, rather than adds.
  const value = doc.movements.filter((m) => !m.reversesId && m.type !== "TRANSFER_IN").reduce((t, m) => t + Math.abs(Number(m.value ?? 0)), 0);
  const timeline = [
    { label: "Written", who: doc.createdBy.name, at: doc.createdAt },
    { label: "Sent for approval", who: doc.submittedBy, at: doc.submittedAt },
    { label: "Approved", who: doc.approvedBy, at: doc.approvedAt },
    { label: doc.type === "TRANSFER" ? "Sent" : "Posted", who: doc.postedBy, at: doc.postedAt },
    { label: "Received", who: null, at: doc.receivedAt },
    { label: "Cancelled", who: doc.cancelledBy, at: doc.cancelledAt, note: doc.cancelReason },
  ].filter((t) => t.at);

  return (
    <div className="space-y-5">
      <div>
        <Link href={isGrn ? "/items/receipts" : "/items/stock"} className="text-sm text-muted hover:text-text">
          ← {isGrn ? "Goods receipts" : "Stock vouchers"}
        </Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-xl font-semibold text-text">
                {stockTypeLabel[doc.type]} <span className="font-mono">{doc.number}</span>
              </h1>
              <Badge tone={stockStatusTone[doc.status]}>{stockStatusLabel[doc.status]}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted">
              {formatCalendarDay(doc.date)} · {doc.warehouse.name}
              {doc.toWarehouse && <> → {doc.toWarehouse.name}</>}
              {doc.company && <> · {doc.company.name}</>}
            </p>
          </div>
          <StockDocumentActions
            id={doc.id}
            type={doc.type}
            status={doc.status}
            needsApproval={doc.needsApproval}
            can={{ ...doc.can, receive: caps.transfer }}
          />
        </div>
      </div>

      {doc.status === "PENDING_APPROVAL" && (
        <p className="rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
          Waiting for somebody other than {doc.createdBy.name} who may approve stock adjustments.
          {!doc.can.approve && caps.approve ? " You wrote it, so it isn't yours to approve." : ""}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="text-sm font-medium text-text">Lines</CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-5 py-2">Item</th>
                  {isGrn && <th className="px-3 py-2 text-right">Ordered</th>}
                  {isGrn && <th className="px-3 py-2 text-right">Received</th>}
                  {isGrn && <th className="px-3 py-2 text-right">Rejected</th>}
                  {isCount && <th className="px-3 py-2 text-right">Books</th>}
                  {isCount && <th className="px-3 py-2 text-right">Counted</th>}
                  <th className="px-3 py-2 text-right">{isGrn ? "Accepted" : isCount ? "Difference" : "Quantity"}</th>
                  {(isGrn || doc.type === "ADJUSTMENT") && <th className="px-5 py-2 text-right">Unit cost</th>}
                </tr>
              </thead>
              <tbody>
                {doc.lines.map((l) => (
                  <tr key={l.id} className="border-b border-line align-top last:border-0">
                    <td className="px-5 py-2">
                      <Link href={`/items/${l.item.id}`} className="text-text hover:underline">
                        {l.item.name}
                      </Link>
                      <div className="text-xs text-subtle">
                        {l.item.sku && <span className="mr-2 font-mono">{l.item.sku}</span>}
                        {(l.batch?.batchNo ?? l.batchNo) && <span className="mr-2">Batch {l.batch?.batchNo ?? l.batchNo}</span>}
                        {(l.batch?.expiryDate ?? l.expiryDate) && <span className="mr-2">expires {formatCalendarDay(l.batch?.expiryDate ?? l.expiryDate)}</span>}
                        {l.serialNumbers.length > 0 && <span>Serials {l.serialNumbers.join(", ")}</span>}
                      </div>
                      {l.note && <div className="text-xs text-muted">{l.note}</div>}
                    </td>
                    {isGrn && <td className="px-3 py-2 text-right tabular-nums text-muted">{qty(l.orderedQty)}</td>}
                    {isGrn && <td className="px-3 py-2 text-right tabular-nums text-muted">{qty(l.receivedQty)}</td>}
                    {isGrn && <td className="px-3 py-2 text-right tabular-nums text-muted">{qty(l.rejectedQty)}</td>}
                    {isCount && <td className="px-3 py-2 text-right tabular-nums text-muted">{doc.status === "POSTED" ? qty(l.systemQty) : "at posting"}</td>}
                    {isCount && <td className="px-3 py-2 text-right tabular-nums text-muted">{qty(l.countedQty)}</td>}
                    <td className="px-3 py-2 text-right tabular-nums text-text">
                      {isCount && doc.status !== "POSTED" ? "—" : `${Number(l.quantity) > 0 && (isCount || doc.type === "ADJUSTMENT") ? "+" : ""}${qty(l.quantity)}`}
                      {l.unit && <span className="ml-1 text-xs text-subtle">{l.unit}</span>}
                    </td>
                    {(isGrn || doc.type === "ADJUSTMENT") && <td className="px-5 py-2 text-right tabular-nums text-muted">{l.unitCost == null ? "—" : rupees(l.unitCost)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader className="text-sm font-medium text-text">Details</CardHeader>
            <CardContent className="space-y-2 text-sm">
              {doc.purchaseOrder && (
                <Row label="Purchase order">
                  <Link href={`/documents/${doc.purchaseOrder.id}`} className="text-brand hover:underline">
                    {doc.purchaseOrder.docNumber}
                  </Link>
                </Row>
              )}
              {doc.bill && (
                <Row label="Vendor bill">
                  <Link href={`/documents/${doc.bill.id}`} className="text-brand hover:underline">
                    {doc.bill.docNumber}
                  </Link>
                </Row>
              )}
              {doc.reference && <Row label="Reference">{doc.reference}</Row>}
              {doc.reason && <Row label="Reason">{doc.reason}</Row>}
              {doc.movements.length > 0 && <Row label="Value moved">{rupees(value)}</Row>}
              {doc.notes && <p className="whitespace-pre-line border-t border-line pt-2 text-muted">{doc.notes}</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="text-sm font-medium text-text">History</CardHeader>
            <CardContent>
              <ol className="space-y-2 text-sm">
                {timeline.map((t) => (
                  <li key={t.label}>
                    <span className="text-text">{t.label}</span>
                    {t.who && <span className="text-muted"> by {t.who}</span>}
                    <div className="text-xs text-subtle">{clock.dateTime(t.at)}</div>
                    {"note" in t && t.note && <div className="text-xs text-muted">“{t.note}”</div>}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>

      {doc.movements.length > 0 && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Stock it moved</CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-5 py-2">Item</th>
                  <th className="px-3 py-2">Movement</th>
                  <th className="px-3 py-2">Warehouse</th>
                  <th className="px-3 py-2">Batch</th>
                  <th className="px-3 py-2 text-right">Quantity</th>
                  <th className="px-5 py-2 text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {doc.movements.map((m) => (
                  <tr key={m.id} className="border-b border-line last:border-0">
                    <td className="px-5 py-1.5 text-text">{m.item.name}</td>
                    <td className="px-3 py-1.5 text-muted">
                      {movementTypeLabel[m.type]}
                      {m.reversesId && <Badge className="ml-2">reversal</Badge>}
                    </td>
                    <td className="px-3 py-1.5 text-muted">{m.warehouse?.name ?? "—"}</td>
                    <td className="px-3 py-1.5 text-muted">{m.batch?.batchNo ?? "—"}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${Number(m.quantityChange) >= 0 ? "text-success" : "text-danger"}`}>
                      {Number(m.quantityChange) > 0 ? "+" : ""}
                      {qty(m.quantityChange)}
                    </td>
                    <td className="px-5 py-1.5 text-right tabular-nums text-muted">{rupees(m.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {doc.journalEntries.length > 0 && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Ledger entries</CardHeader>
          <CardContent className="flex flex-wrap gap-2 text-sm">
            {doc.journalEntries.map((e) => (
              <Link key={e.id} href={`/accounting/journal?q=${encodeURIComponent(e.entryNumber)}`} className="rounded-base border border-line px-2 py-1 font-mono text-xs text-brand hover:bg-surface-sunken">
                {e.entryNumber}
                {e.reversesId && <span className="ml-1 font-sans text-subtle">(reversal)</span>}
              </Link>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className="text-right text-text">{children}</span>
    </div>
  );
}
