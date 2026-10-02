import Link from "next/link";
import { listOrdersPaged } from "@/actions/order";
import { isModuleEnabled } from "@/actions/module";
import { Button } from "@/components/ui/button";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { OrdersTable } from "@/components/orders/orders-table";
import { OrderSplitList } from "@/components/orders/order-split-list";
import { OrderDetail } from "@/components/orders/order-detail";
import { SplitListShell, SplitListEmpty, SplitListPage, resolveSelected } from "@/components/ui/split-list";
import { ViewModeToggle } from "@/components/ui/view-mode-toggle";
import { getViewMode } from "@/actions/view-mode";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { ColumnPicker } from "@/components/ui/table-columns";
import { orderStatusValues, orderBusinessTypeValues, orderBusinessTypeLabels } from "@/lib/validation/order";
import { requireUser } from "@/lib/session";
import { listColumns } from "@/lib/custom-fields/server";
import { customFilterParams, customFilterSetup, parseCustomFilters, type CustomFilterParams } from "@/lib/custom-fields/filters";
import { CustomFieldFilters } from "@/components/custom-fields/custom-field-filters";
import type { OrderStatus, OrderBusinessType } from "@prisma/client";

const HANDOFF_FLAGS = [
  { value: "held", label: "In hand" },
  { value: "ready", label: "Ready for purchase" },
  { value: "review", label: "Price to approve" },
  { value: "vendorPo", label: "Vendor PO to cancel" },
] as const;

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    businessType?: string;
    channel?: string;
    flag?: string;
    q?: string;
    page?: string;
    pageSize?: string;
    sel?: string;
  } & CustomFilterParams>;
}) {
  const enabled = await isModuleEnabled("orders");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="orders" />;
  }

  const params = await searchParams;
  const status = orderStatusValues.includes(params.status as OrderStatus) ? (params.status as OrderStatus) : undefined;
  // Narrowed to the types the filter offers; ADDON is raised from a subscription rather than
  // picked from a list, so it is not among them.
  const businessType = orderBusinessTypeValues.includes(
    params.businessType as (typeof orderBusinessTypeValues)[number],
  )
    ? (params.businessType as OrderBusinessType)
    : undefined;
  const viaReseller = params.channel === "reseller" ? true : params.channel === "direct" ? false : undefined;
  const flag = HANDOFF_FLAGS.find((f) => f.value === params.flag)?.value;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const customFilters = parseCustomFilters(params);
  const [viewMode, result, user] = await Promise.all([
    getViewMode("orders"),
    listOrdersPaged({ status, businessType, viaReseller, search: params.q, page, pageSize, flag, customFilters }),
    requireUser(),
  ]);
  const pendingCount = result.pendingApproval;
  const selected = viewMode === "split" ? resolveSelected(result.rows, params.sel) : null;
  // The workspace's own fields (src/lib/custom-fields): the columns the table can show — the table's
  // alone, so the split view asks for no values, though the picker still offers them — and the filter panel.
  const [customColumns, fieldFilters] = await Promise.all([
    listColumns("ORDER", user.id, viewMode === "split" ? [] : result.rows.map((o) => o.id)),
    customFilterSetup("ORDER", user.id, customFilters),
  ]);

  const stageFilters: { label: string; value?: OrderStatus }[] = [
    { label: "All" },
    { label: "Pending Approval", value: "PENDING_APPROVAL" },
    { label: "Approved", value: "APPROVED" },
    { label: "Processing", value: "PROCESSING" },
    { label: "Fulfilled", value: "FULFILLED" },
    { label: "Rejected", value: "REJECTED" },
    { label: "Cancelled", value: "CANCELLED" },
  ];

  function queryFor(overrides: Record<string, string | undefined>) {
    const next = {
      // The field filters too, or a status chip would quietly drop them.
      ...customFilterParams(params),
      status: params.status,
      q: params.q,
      businessType: params.businessType,
      channel: params.channel,
      flag: params.flag,
      ...overrides,
    };
    return Object.fromEntries(Object.entries(next).filter(([, v]) => v)) as Record<string, string>;
  }

  return (
    <SplitListPage active={viewMode === "split"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">Orders</h1>
          <p className="mt-1 text-sm text-muted">
            {result.total} total{pendingCount > 0 && ` · ${pendingCount} awaiting accounts approval`}
          </p>
      </div>
        <div className="flex items-center gap-2">
          <ViewModeToggle viewKey="orders" mode={viewMode} />
          <Link href="/orders/new">
            <Button>Punch order</Button>
          </Link>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search customer name…" />
        <SelectParamFilter
          paramName="businessType"
          label="Type"
          options={orderBusinessTypeValues.map((t) => ({ value: t, label: orderBusinessTypeLabels[t] }))}
        />
        <SelectParamFilter
          paramName="channel"
          label="Channel"
          options={[
            { value: "direct", label: "Direct" },
            { value: "reseller", label: "Via reseller" },
          ]}
        />
        <CustomFieldFilters setup={fieldFilters} />
        <ColumnPicker tableKey="orders" className="ml-auto" customColumns={customColumns.columns} />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {stageFilters.map((f) => (
          <Link
            key={f.label}
            href={{ pathname: "/orders", query: queryFor({ status: f.value, flag: undefined }) }}
            className={`rounded-full px-3 py-1 text-sm ${
              !flag && (params.status === f.value || (!params.status && !f.value))
                ? "bg-brand text-brand-contrast"
                : "bg-surface text-muted border border-line-strong"
            }`}
          >
            {f.label}
          </Link>
        ))}
        {/* The hand-off views: sales's in-hand orders, purchase's queue, and what each is waiting on. */}
        {HANDOFF_FLAGS.map((f) => (
          <Link
            key={f.value}
            href={{ pathname: "/orders", query: queryFor({ flag: f.value, status: undefined }) }}
            className={`rounded-full px-3 py-1 text-sm ${
              flag === f.value ? "bg-brand text-brand-contrast" : "bg-surface text-muted border border-dashed border-line-strong"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      {viewMode === "split" ? (
        <SplitListShell
          countLabel={`${result.total} order${result.total === 1 ? "" : "s"}`}
          listPane={<OrderSplitList orders={result.rows} selectedId={selected} />}
        >
          {selected ? <OrderDetail id={selected} /> : <SplitListEmpty message="No orders match these filters." />}
        </SplitListShell>
      ) : (
        <>
          <div className="mt-6">
            <OrdersTable orders={result.rows} customColumns={customColumns} />
          </div>

          <Pagination
            page={page}
            pageSize={pageSize}
            total={result.total}
            totalPages={totalPages(result.total, pageSize)}
            pageSizes={PAGE_SIZES}
          />
        </>
      )}
    </SplitListPage>
  );
}
