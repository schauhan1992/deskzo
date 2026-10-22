import Link from "next/link";
import { notFound } from "next/navigation";
import type { StockDocumentType } from "@prisma/client";
import { Plus } from "lucide-react";
import { inventoryCapabilities, listStockDocuments, listWarehouses } from "@/actions/inventory";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TabNav } from "@/components/ui/tab-nav";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Pagination } from "@/components/ui/pagination";
import { resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { formatCalendarDay } from "@/lib/time/zone";
import { InventoryNotReady } from "@/components/inventory/not-ready";
import {
  STOCK_DOCUMENT_STATUSES,
  STOCK_DOCUMENT_TYPES,
  isStockDocumentType,
  stockStatusLabel,
  stockStatusTone,
  stockTypeLabel,
  stockTypeNeeds,
  stockTypeNew,
  stockTypePlural,
} from "@/components/inventory/labels";

export type StockListParams = { type?: string; status?: string; warehouse?: string; from?: string; to?: string; q?: string; page?: string; pageSize?: string };

const PAGE_SIZES = [25, 50, 100] as const;

/**
 * Inventory's vouchers as a list (owner, 22 Oct 2026): every kind under its tab, or one kind alone when the
 * page is that kind's own (`fixedType` — Purchases › Goods receipts). Filters and pages live in the address,
 * so a filtered list is a link somebody can send; the page itself is read on the server, a page at a time.
 */
export async function StockDocumentsView({ params, basePath, fixedType, title, intro }: { params: StockListParams; basePath: string; fixedType?: StockDocumentType; title: string; intro: string }) {
  const caps = await inventoryCapabilities();
  if (!caps.view) notFound();
  if (!caps.migrated) return <InventoryNotReady title={title} />;

  const type = fixedType ?? (isStockDocumentType(params.type) ? params.type : undefined);
  const page = resolvePage(params.page);
  const pageSize = Math.min(100, resolvePageSize(params.pageSize));
  const [result, warehouses] = await Promise.all([
    listStockDocuments({ type, status: params.status, warehouseId: params.warehouse, from: params.from, to: params.to, search: params.q, page, pageSize }),
    listWarehouses({ includeClosed: true }),
  ]);
  if (!result) return <InventoryNotReady title={title} />;

  const may = (t: StockDocumentType) => caps[stockTypeNeeds[t]];
  const creatable = (fixedType ? [fixedType] : STOCK_DOCUMENT_TYPES).filter(may);
  const pendingHref = { pathname: basePath, query: { ...(type && !fixedType ? { type } : {}), status: "PENDING_APPROVAL" } };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">{title}</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">{intro}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {creatable.map((t) => (
            <Link key={t} href={`/items/stock/new?type=${t}`}>
              <Button size="sm" variant={t === (fixedType ?? type) ? "primary" : "secondary"}>
                <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                {stockTypeNew[t]}
              </Button>
            </Link>
          ))}
        </div>
      </div>

      {result.pending > 0 && params.status !== "PENDING_APPROVAL" && (
        <Link
          href={pendingHref}
          className="flex items-center justify-between rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning hover:brightness-105"
        >
          <span>
            {result.pending} {result.pending === 1 ? "voucher is" : "vouchers are"} waiting for approval
            {caps.approve ? " — yours to approve, unless you wrote them." : "."}
          </span>
          <span className="font-medium">Show them →</span>
        </Link>
      )}

      {!fixedType && (
        <TabNav
          tabs={[{ key: "ALL", label: "All" }, ...STOCK_DOCUMENT_TYPES.map((t) => ({ key: t, label: stockTypePlural[t] }))]}
          activeKey={type ?? "ALL"}
          paramName="type"
          basePath={basePath}
          defaultKey="ALL"
          otherParams={{ status: params.status, warehouse: params.warehouse, from: params.from, to: params.to, q: params.q }}
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Number, reference or reason…" className="w-64" />
        <SelectParamFilter paramName="status" label="Status" allLabel="Any status" options={STOCK_DOCUMENT_STATUSES.map((s) => ({ value: s, label: stockStatusLabel[s] }))} />
        <SelectParamFilter paramName="warehouse" label="Warehouse" allLabel="Every warehouse" options={warehouses.map((w) => ({ value: w.id, label: `${w.name}${w.active ? "" : " (closed)"}` }))} />
        <DateRangePicker fromParam="from" toParam="to" label="Dated" />
      </div>

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Number</th>
              <th className="px-4 py-2.5">Date</th>
              {!fixedType && <th className="px-4 py-2.5">Kind</th>}
              <th className="px-4 py-2.5">Warehouse</th>
              <th className="px-4 py-2.5">Vendor / reason</th>
              <th className="px-4 py-2.5 text-right">Lines</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5">By</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((d) => (
              <tr key={d.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                <td className="px-4 py-2">
                  <Link href={`/items/stock/${d.id}`} className="font-mono text-xs font-medium text-brand hover:underline">
                    {d.number}
                  </Link>
                  {d.reference && <div className="text-xs text-subtle">Ref {d.reference}</div>}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-muted">{formatCalendarDay(d.date)}</td>
                {!fixedType && <td className="px-4 py-2 text-muted">{stockTypeLabel[d.type]}</td>}
                <td className="px-4 py-2 text-muted">
                  {d.warehouse.name}
                  {d.toWarehouse && <> → {d.toWarehouse.name}</>}
                </td>
                <td className="max-w-[260px] truncate px-4 py-2 text-muted">
                  {d.company ? d.company.name : (d.reason ?? "—")}
                  {d.purchaseOrder && <div className="text-xs text-subtle">PO {d.purchaseOrder.docNumber}</div>}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-muted">{d._count.lines}</td>
                <td className="px-4 py-2">
                  <Badge tone={stockStatusTone[d.status]}>{stockStatusLabel[d.status]}</Badge>
                </td>
                <td className="px-4 py-2 text-muted">{d.createdBy.name}</td>
              </tr>
            ))}
            {result.rows.length === 0 && (
              <tr>
                <td colSpan={fixedType ? 7 : 8} className="px-4 py-12 text-center text-subtle">
                  {params.q || params.status || params.warehouse || params.from || params.to
                    ? "Nothing matches these filters."
                    : `No ${(type ? stockTypePlural[type] : "stock vouchers").toLowerCase()} yet.`}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <Pagination page={page} pageSize={pageSize} total={result.total} totalPages={totalPages(result.total, pageSize)} pageSizes={PAGE_SIZES} label="vouchers" />
    </div>
  );
}
