"use client";

import Link from "next/link";
import { ArrowUpRight, ChevronLeft, ChevronRight, ReceiptText } from "lucide-react";
import { consoleExportInvoices } from "@/actions/platform/console-billing";
import { EmptyState } from "@/components/console/kit/empty-state";
import { ExportCsvButton } from "@/components/console/kit/export-button";
import { DateRangeFilter, SearchField, SelectFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips } from "@/components/console/kit/filters";
import { Panel } from "@/components/console/kit/panel";
import { LabelPill } from "@/components/console/kit/status";
import { DataTable, TBody, TFoot, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useClock } from "@/components/time/clock-provider";
import { OutboundLink } from "@/components/ui/outbound-link";
import { formatMoney } from "@/lib/billing/money";
import { dayKeyLabel, plural } from "@/lib/console-shared/format";
import { INVOICE_STATUS, gatewayLabel } from "@/lib/console-shared/labels";
import { parseInvoiceFilters, withParams } from "@/lib/console-shared/params";
import type { Caps } from "@/lib/console-shared/roles";
import type { InvoiceListRow, InvoicesPage } from "@/lib/platform/revenue";
import type { Clock } from "@/lib/time/zone";
import { cn } from "@/lib/utils";

/**
 * The Billing hub's Invoices tab: every invoice the gateways sent, filtered in the URL, with the
 * totals for the whole filtered set — one line per currency, never added across currencies — and the
 * same set as CSV. Amounts are as the gateways recorded them; the books are the gateways' and the
 * accountant's. A client component, as the other tabs are, for the console's clock (`useClock`).
 */

const PATH = "/billing";

const STATUS_OPTIONS = (Object.keys(INVOICE_STATUS) as (keyof typeof INVOICE_STATUS)[]).map((key) => ({ value: key, label: INVOICE_STATUS[key].label }));
const GATEWAY_OPTIONS = [
  { value: "STRIPE", label: "Stripe" },
  { value: "RAZORPAY", label: "Razorpay" },
];
/** The currencies prices are set in today; any other the list holds is added from its totals. */
const COMMON_CURRENCIES = ["INR", "USD"];

/** "1 Sep 2026 – 30 Sep 2026", "from 1 Sep 2026", "until 30 Sep 2026". */
export function rangeLabel(from: string | undefined, to: string | undefined): string {
  if (from && to) return from === to ? dayKeyLabel(from) : `${dayKeyLabel(from)} – ${dayKeyLabel(to)}`;
  if (from) return `from ${dayKeyLabel(from)}`;
  return `until ${dayKeyLabel(to ?? "")}`;
}

/**
 * Previous / Next for the billing lists, as links that keep the tab and its filters (the lists are
 * fifty to a page, set by the loaders). The subscriptions and events tables use it too.
 */
export function ListPager({ page, pageSize, total, params, noun }: { page: number; pageSize: number; total: number; params: Record<string, string>; noun: string }) {
  if (total === 0) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const href = (n: number) => withParams(PATH, params, { page: n > 1 ? n : null });
  const step = "inline-flex h-8 items-center gap-1 rounded-base border border-line-strong bg-surface px-3 text-[13px] font-medium shadow-sm";
  return (
    <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
      <span className="text-muted tabular-nums">{pages > 1 ? `${first}–${last} of ${plural(total, noun)}` : plural(total, noun)}</span>
      {pages > 1 && (
        <div className="flex items-center gap-2">
          {page > 1 ? (
            <Link href={href(page - 1)} className={cn(step, "text-text hover:bg-surface-sunken")}>
              <ChevronLeft aria-hidden="true" className="h-4 w-4" />
              Previous
            </Link>
          ) : (
            <span aria-disabled="true" className={cn(step, "text-subtle opacity-60")}>
              <ChevronLeft aria-hidden="true" className="h-4 w-4" />
              Previous
            </span>
          )}
          <span className="text-muted tabular-nums">{`Page ${page} of ${pages}`}</span>
          {page < pages ? (
            <Link href={href(page + 1)} className={cn(step, "text-text hover:bg-surface-sunken")}>
              Next
              <ChevronRight aria-hidden="true" className="h-4 w-4" />
            </Link>
          ) : (
            <span aria-disabled="true" className={cn(step, "text-subtle opacity-60")}>
              Next
              <ChevronRight aria-hidden="true" className="h-4 w-4" />
            </span>
          )}
        </div>
      )}
    </nav>
  );
}

function IssuedCell({ at, clock }: { at: Date; clock: Clock }) {
  return (
    <time dateTime={at.toISOString()} title={clock.dateTime(at)} className="whitespace-nowrap">
      {clock.date(at)}
    </time>
  );
}

function period(row: InvoiceListRow, clock: Clock): string {
  if (!row.periodStart && !row.periodEnd) return "—";
  return `${clock.dayMonth(row.periodStart)} – ${clock.date(row.periodEnd)}`;
}

function InvoiceLinks({ row }: { row: InvoiceListRow }) {
  const name = row.number ?? row.externalId;
  const link = "inline-flex items-center gap-0.5 rounded-base text-xs font-medium text-brand hover:underline";
  if (!row.hostedUrl && !row.pdfUrl) return <span className="text-muted">—</span>;
  return (
    <span className="inline-flex items-center gap-3">
      {row.hostedUrl && (
        <OutboundLink href={row.hostedUrl} className={link} aria-label={`Invoice ${name} on ${gatewayLabel(row.gateway)} (opens in a new tab)`}>
          Invoice
          <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
        </OutboundLink>
      )}
      {row.pdfUrl && (
        <OutboundLink href={row.pdfUrl} className={link} aria-label={`PDF of invoice ${name} (opens in a new tab)`}>
          PDF
          <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
        </OutboundLink>
      )}
    </span>
  );
}

export function InvoicesTab({ list, exportParams, caps }: { list: InvoicesPage; exportParams: Record<string, string>; caps: Caps }) {
  const clock = useClock();
  const params = { ...exportParams, tab: "invoices" };
  const f = parseInvoiceFilters(params);
  const remove = (...keys: string[]) => withParams(PATH, params, Object.fromEntries(keys.map((k) => [k, null])));
  const chips = [
    ...(f.status ? [{ key: "status", label: `Status: ${INVOICE_STATUS[f.status].label}`, removeHref: remove("status") }] : []),
    ...(f.gateway ? [{ key: "gateway", label: `Gateway: ${gatewayLabel(f.gateway)}`, removeHref: remove("gateway") }] : []),
    ...(f.currency ? [{ key: "currency", label: `Currency: ${f.currency}`, removeHref: remove("currency") }] : []),
    ...(f.tenant ? [{ key: "tenant", label: `Workspace: ${f.tenant}`, removeHref: remove("tenant") }] : []),
    ...(f.from || f.to ? [{ key: "issued", label: `Issued ${rangeLabel(f.from, f.to)}`, removeHref: remove("from", "to") }] : []),
  ];
  const clearHref = `${PATH}?tab=invoices`;
  const currencies = [...new Set([...COMMON_CURRENCIES, ...list.totals.map((t) => t.currency), ...(f.currency ? [f.currency] : [])])].sort();

  return (
    <div>
      <FilterBar trailing={caps.exportInvoices ? <ExportCsvButton action={consoleExportInvoices.bind(null, exportParams)} /> : undefined}>
        <SearchField param="tenant" label="Workspace address" placeholder="Workspace address, e.g. acme" />
        <SelectFilter param="status" label="Status" options={STATUS_OPTIONS} />
        <SelectFilter param="gateway" label="Gateway" options={GATEWAY_OPTIONS} />
        <SelectFilter param="currency" label="Currency" options={currencies.map((c) => ({ value: c, label: c }))} />
        <DateRangeFilter label="Issued" />
      </FilterBar>
      <FilterChips chips={chips} clearHref={chips.length > 0 ? clearHref : undefined} />

      <Panel
        padded={false}
        footer={
          list.rows.length > 0
            ? "As recorded from gateway webhooks — not accounting figures. Totals cover every invoice the filters match, one line per currency."
            : undefined
        }
      >
        {list.rows.length === 0 ? (
          chips.length > 0 ? (
            <EmptyState variant="filtered" title="No invoices match these filters" body="Try a wider date range, or another status or gateway." clearHref={clearHref} />
          ) : (
            <EmptyState icon={<ReceiptText className="h-5 w-5" />} title="No invoices yet" body="Invoices appear here as Stripe and Razorpay send them." />
          )
        ) : (
          <DataTable caption="Invoices" stickyHeader minWidth={1120}>
            <THead>
              <Th>Issued</Th>
              <Th>Workspace</Th>
              <Th>Number</Th>
              <Th>Gateway</Th>
              <Th>Period</Th>
              <Th numeric>Subtotal</Th>
              <Th numeric>Tax</Th>
              <Th numeric>Total</Th>
              <Th numeric>Paid</Th>
              <Th>Status</Th>
              <Th>Links</Th>
            </THead>
            <TBody>
              {list.rows.map((row) => (
                <Tr key={row.id}>
                  <Td muted>
                    <IssuedCell at={row.issuedAt} clock={clock} />
                  </Td>
                  <Td>
                    <Link href={`/workspaces/${row.tenant.slug}`} className="font-medium text-text hover:text-brand hover:underline">
                      {row.tenant.slug}
                    </Link>
                  </Td>
                  <Td mono nowrap>
                    {row.number ?? (
                      <span className="text-muted" title={row.externalId}>
                        {row.externalId.length > 18 ? `${row.externalId.slice(0, 18)}…` : row.externalId}
                      </span>
                    )}
                  </Td>
                  <Td nowrap>{gatewayLabel(row.gateway)}</Td>
                  <Td muted nowrap>
                    {period(row, clock)}
                  </Td>
                  <Td numeric>{formatMoney(row.subtotal, row.currency)}</Td>
                  <Td numeric muted>
                    {formatMoney(row.tax, row.currency)}
                  </Td>
                  <Td numeric className="font-medium">
                    {formatMoney(row.total, row.currency)}
                  </Td>
                  <Td numeric>{formatMoney(row.amountPaid, row.currency)}</Td>
                  <Td>
                    <LabelPill map={INVOICE_STATUS} value={row.status} />
                  </Td>
                  <Td nowrap>
                    <InvoiceLinks row={row} />
                  </Td>
                </Tr>
              ))}
            </TBody>
            <TFoot>
              {list.totals.map((t) => (
                <tr key={t.currency}>
                  <Td colSpan={5}>
                    {`Total in ${t.currency}`}
                    <span className="ml-1.5 font-normal text-muted">{`· ${plural(t.count, "invoice")}`}</span>
                  </Td>
                  <Td numeric muted>
                    —
                  </Td>
                  <Td numeric>{formatMoney(t.tax, t.currency)}</Td>
                  <Td numeric>{formatMoney(t.total, t.currency)}</Td>
                  <Td numeric>{formatMoney(t.paid, t.currency)}</Td>
                  <Td colSpan={2} />
                </tr>
              ))}
            </TFoot>
          </DataTable>
        )}
      </Panel>
      <ListPager page={list.page} pageSize={list.pageSize} total={list.total} params={params} noun="invoice" />
    </div>
  );
}
