import Link from "next/link";
import type { itemInventory } from "@/actions/inventory";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { ItemTrackingForm, ItemUnitsEditor } from "@/components/inventory/item-stock-controls";
import { movementTypeLabel, qty, rupees, sourceTypeLabel } from "@/components/inventory/labels";
import { formatCalendarDay } from "@/lib/time/zone";

type Stock = NonNullable<Awaited<ReturnType<typeof itemInventory>>>;

/**
 * An item's stock under Finance → Accounts (owner, 22 Oct 2026): where it is — warehouse by warehouse, batch by
 * batch — what is held for orders, which serial numbers are in, its last fifty movements with their value and
 * where each came from, and how the item is tracked.
 */
export function ItemStockBreakdown({ stock }: { stock: Stock }) {
  const reserved = stock.reservations.reduce((t, r) => t + Number(r.quantity), 0);
  const value = stock.balances.reduce((t, b) => t + Number(b.value), 0);
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Where it is</CardHeader>
      <CardContent className="space-y-3 text-sm">
        {stock.balances.length === 0 ? (
          <p className="text-subtle">None on hand.</p>
        ) : (
          <ul className="space-y-1.5">
            {stock.balances.map((b, i) => (
              <li key={`${b.warehouse.id}-${b.batch?.id ?? i}`} className="flex justify-between gap-3">
                <span className="text-muted">
                  {b.warehouse.name}
                  {b.batch && (
                    <span className="block text-xs text-subtle">
                      Batch {b.batch.batchNo}
                      {b.batch.expiryDate && ` · expires ${formatCalendarDay(b.batch.expiryDate)}`}
                    </span>
                  )}
                </span>
                <span className={`text-right tabular-nums ${Number(b.quantity) < 0 ? "text-danger" : "text-text"}`}>
                  {qty(b.quantity)}
                  <span className="block text-xs text-subtle">{rupees(b.value)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {stock.balances.length > 0 && (
          <div className="flex justify-between border-t border-line pt-2 text-xs text-muted">
            <span>Value at cost</span>
            <span className="tabular-nums">{rupees(value)}</span>
          </div>
        )}
        {reserved > 0 && (
          <div className="border-t border-line pt-2">
            <div className="flex justify-between text-xs text-muted">
              <span>Held for orders</span>
              <span className="tabular-nums">{qty(reserved)}</span>
            </div>
            <ul className="mt-1 space-y-0.5 text-xs text-subtle">
              {stock.reservations.map((r, i) => (
                <li key={`${r.sourceId}-${i}`}>
                  {qty(r.quantity)} · {r.note ?? r.sourceType} · {r.warehouse.name}
                </li>
              ))}
            </ul>
          </div>
        )}
        {stock.item.trackSerials && (
          <div className="border-t border-line pt-2">
            <div className="text-xs text-muted">Serial numbers in stock ({stock.serials.length}{stock.serials.length === 200 ? "+" : ""})</div>
            <p className="mt-1 break-words font-mono text-xs text-subtle">{stock.serials.map((s) => s.serialNo).join(", ") || "—"}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ItemStockMovements({ stock, dateOf }: { stock: Stock; dateOf: (d: Date) => string }) {
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs uppercase tracking-wide text-muted">
        <tr>
          <th className="py-1.5">Date</th>
          <th className="py-1.5">Movement</th>
          <th className="py-1.5">Warehouse</th>
          <th className="py-1.5 text-right">Change</th>
          <th className="py-1.5 text-right">Value</th>
          <th className="py-1.5 pl-3">From</th>
        </tr>
      </thead>
      <tbody>
        {stock.movements.map((m) => (
          <tr key={m.id} className="border-t border-line align-top">
            <td className="whitespace-nowrap py-1.5 text-muted">{m.movementDate ? formatCalendarDay(m.movementDate) : dateOf(m.createdAt)}</td>
            <td className="py-1.5 text-muted">
              {movementTypeLabel[m.type]}
              {m.reversesId && <Badge className="ml-1">reversal</Badge>}
              {m.batch && <div className="text-xs text-subtle">Batch {m.batch.batchNo}</div>}
              {m.serialNumbers.length > 0 && <div className="text-xs text-subtle">{m.serialNumbers.join(", ")}</div>}
            </td>
            <td className="py-1.5 text-muted">{m.warehouse?.name ?? "—"}</td>
            <td className={`py-1.5 text-right font-medium tabular-nums ${Number(m.quantityChange) >= 0 ? "text-success" : "text-danger"}`}>
              {Number(m.quantityChange) > 0 ? "+" : ""}
              {qty(m.quantityChange)}
            </td>
            <td className="py-1.5 text-right tabular-nums text-muted">{m.value == null ? "—" : rupees(m.value)}</td>
            <td className="py-1.5 pl-3 text-muted">
              {m.tradeDocument ? (
                <Link href={`/documents/${m.tradeDocument.id}`} className="font-mono text-xs text-brand hover:underline">
                  {m.tradeDocument.docNumber}
                </Link>
              ) : m.stockDocument ? (
                <Link href={`/items/stock/${m.stockDocument.id}`} className="font-mono text-xs text-brand hover:underline">
                  {m.stockDocument.number}
                </Link>
              ) : (
                <span className="text-xs">{m.sourceType ? sourceTypeLabel[m.sourceType] : "—"}</span>
              )}
              <div className="text-xs text-subtle">
                {m.createdBy.name}
                {m.reason && ` · ${m.reason}`}
              </div>
            </td>
          </tr>
        ))}
        {stock.movements.length === 0 && (
          <tr>
            <td colSpan={6} className="py-4 text-center text-subtle">
              No stock movements yet.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export function ItemTrackingCard({ stock }: { stock: Stock }) {
  const { item } = stock;
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">How it&apos;s tracked</CardHeader>
      <CardContent className="space-y-4 text-sm">
        {stock.canManage ? (
          <ItemTrackingForm
            itemId={item.id}
            initial={{
              trackBatches: item.trackBatches,
              trackExpiry: item.trackExpiry,
              trackSerials: item.trackSerials,
              barcode: item.barcode ?? "",
              reorderQuantity: item.reorderQuantity == null ? "" : String(item.reorderQuantity),
            }}
            hasStock={Number(item.stockQuantity) !== 0}
          />
        ) : (
          <ul className="space-y-1 text-muted">
            <li>Batches: {item.trackBatches ? `yes${item.trackExpiry ? ", with expiry dates" : ""}` : "no"}</li>
            <li>Serial numbers: {item.trackSerials ? "yes" : "no"}</li>
            {item.barcode && <li>Barcode: <span className="font-mono">{item.barcode}</span></li>}
            {item.reorderQuantity != null && <li>Reorder quantity: {qty(item.reorderQuantity)}</li>}
          </ul>
        )}
        <div className="border-t border-line pt-3">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Other units</div>
          <ItemUnitsEditor itemId={item.id} baseUnit={item.unit} units={stock.item.unitConversions.map((u) => ({ id: u.id, unit: u.unit, factor: Number(u.factor) }))} canManage={stock.canManage} />
        </div>
      </CardContent>
    </Card>
  );
}
