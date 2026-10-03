import Link from "next/link";
import { AlertTriangle, Settings2 } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { ewayDocuments } from "@/actions/eway";
import { transporterOptions } from "@/actions/transporter";
import { EwayRowActions } from "@/components/logistics/eway-row-actions";
import { Badge, Card } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tab-nav";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Pagination } from "@/components/ui/pagination";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay, indiaClock } from "@/lib/time/zone";
import { lastValidDay } from "@/lib/eway/rules";

const PAGE_SIZES = [25, 50, 100] as const;

/**
 * The last day a bill covers, as the law counts it: India's day, in every workspace. Not the day of
 * `validUntil` itself, which is the midnight after it — a day the bill does not cover.
 */
const coveredTo = (validUntil: Date) => formatCalendarDay(lastValidDay(new Date(validUntil)));

const DOC_LABEL: Record<string, string> = {
  INVOICE: "Invoice",
  CREDIT_NOTE: "Credit note",
  DELIVERY_CHALLAN: "Delivery challan",
};

/**
 * Every document that carries goods, and whether it has the bill it needs.
 *
 * The list is built round one question — what has moved, or is about to, without a valid e-way bill
 * — so that is the tab it opens on. A list that opened on "all" would put a compliance gap on page
 * four between two documents that are perfectly in order.
 */
export default async function EwayBillsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    docType?: string;
    from?: string;
    to?: string;
    q?: string;
    page?: string;
    pageSize?: string;
  }>;
}) {
  const enabled = await isModuleEnabled("sales_documents");
  if (!enabled) return <ModuleDisabledNotice moduleKey="sales_documents" />;

  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const pageSize = PAGE_SIZES.includes(Number(sp.pageSize) as (typeof PAGE_SIZES)[number])
    ? Number(sp.pageSize)
    : PAGE_SIZES[0];
  const status = sp.status ?? "pending";

  const [result, transporters] = await Promise.all([
    ewayDocuments({
      status,
      docType: sp.docType,
      from: sp.from,
      to: sp.to,
      q: sp.q,
      page,
      pageSize,
    }),
    // Fetched once for the page rather than per row: the same dozen carriers answer every one.
    transporterOptions(),
  ]);

  if (!result.ok) {
    return <Card className="px-6 py-10 text-center text-sm text-muted">{result.error}</Card>;
  }

  const { rows, total, counts } = result.data;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="animate-fade-rise space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">E-way bills</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            A consignment worth more than ₹50,000 needs an e-way bill before it moves, whoever it belongs to and
            whether or not it is being sold. Invoices, credit notes and delivery challans all count — so all three are
            here.
          </p>
        </div>
        <Link
          href="/settings/eway"
          className="inline-flex items-center gap-1.5 rounded-base border border-line px-3 py-1.5 text-sm text-muted hover:text-text"
        >
          <Settings2 className="h-4 w-4" />
          Settings
        </Link>
      </div>

      <TabNav
        basePath="/sales/eway-bills"
        paramName="status"
        activeKey={status}
        otherParams={{ docType: sp.docType, from: sp.from, to: sp.to, q: sp.q }}
        tabs={[
          { key: "pending", label: `Needs a bill (${counts.outstanding})` },
          { key: "generated", label: `Live (${counts.generated})` },
          { key: "expired", label: `Expired (${counts.expired})` },
          { key: "cancelled", label: `Cancelled (${counts.cancelled})` },
          { key: "all", label: "All" },
        ]}
      />

      <div className="flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Document number or customer…" className="w-64" />
        <SelectParamFilter
          paramName="docType"
          label="Type"
          allLabel="All types"
          options={[
            { value: "INVOICE", label: "Invoices" },
            { value: "DELIVERY_CHALLAN", label: "Delivery challans" },
            { value: "CREDIT_NOTE", label: "Credit notes" },
          ]}
        />
        <DateRangePicker fromParam="from" toParam="to" label="Period" />
      </div>

      {status === "pending" && counts.outstanding > 0 && (
        <p className="flex items-start gap-2 rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {counts.outstanding} {counts.outstanding === 1 ? "document has" : "documents have"} nothing valid covering
          {counts.outstanding === 1 ? " it" : " them"} — never raised, expired, or cancelled. Goods that have already
          moved against these are a penalty waiting to be found.
        </p>
      )}

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-subtle">
              <th className="px-4 py-2.5 font-medium">Date</th>
              <th className="px-4 py-2.5 font-medium">Document</th>
              <th className="px-4 py-2.5 font-medium">Customer</th>
              <th className="px-4 py-2.5 font-medium">Customer GSTIN</th>
              <th className="px-4 py-2.5 font-medium">E-way bill</th>
              <th className="px-4 py-2.5 font-medium">Valid until</th>
              <th className="px-4 py-2.5 text-right font-medium">Value of goods</th>
              <th className="px-4 py-2.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.documentId} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                {/* The document's day as the e-way bill states it: India's. */}
                <td className="whitespace-nowrap px-4 py-2.5 text-muted">{indiaClock.date(r.issueDate)}</td>
                <td className="px-4 py-2.5">
                  <Link href={`/documents/${r.documentId}`} className="font-medium text-text hover:text-brand">
                    {r.docNumber}
                  </Link>
                  <span className="ml-2 text-xs text-subtle">{DOC_LABEL[r.docType] ?? r.docType}</span>
                </td>
                <td className="px-4 py-2.5 text-text">{r.customerName}</td>
                <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-muted">
                  {/*
                    Blank rather than a dash, because a missing GSTIN is the thing itself: an
                    unregistered buyer is precisely when the seller has to raise the bill.
                  */}
                  {r.customerGstin ?? <span className="font-sans text-subtle">Unregistered</span>}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  {r.ewayBillNumber ? (
                    <span className="font-mono text-xs text-text">{r.ewayBillNumber}</span>
                  ) : r.required ? (
                    <Badge tone="red">Needed</Badge>
                  ) : (
                    <span className="text-xs text-subtle" title={r.because}>
                      Not required
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted">
                  {r.status === "CANCELLED" ? (
                    <Badge>Cancelled</Badge>
                  ) : r.status === "EXPIRED" ? (
                    <Badge tone="amber">Expired {r.validUntil ? coveredTo(r.validUntil) : ""}</Badge>
                  ) : (
                    (r.validUntil && coveredTo(r.validUntil)) || "—"
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-text">
                  {formatCurrency(r.total)}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right">
                  <EwayRowActions
                    documentId={r.documentId}
                    docNumber={r.docNumber}
                    status={r.status}
                    required={r.required}
                    transporters={transporters.ok ? transporters.data : []}
                  />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-sm text-muted">
                  {status === "pending"
                    ? "Nothing is waiting for an e-way bill."
                    : "No documents match those filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        totalPages={totalPages}
        pageSizes={PAGE_SIZES}
        label="documents"
      />
    </div>
  );
}
