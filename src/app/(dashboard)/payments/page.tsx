import Link from "next/link";
import { currentUser } from "@/lib/session";
import { listOrdersWithPaymentsPaged, listPaymentsPaged, type PaymentStatusFilter } from "@/actions/payment";
import { listCompanyOptions } from "@/actions/company";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { Badge, Card } from "@/components/ui/card";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { PaymentsRowAction } from "@/components/payments/payments-row-action";
import { RecordPaymentButton } from "@/components/payments/record-payment-button";
import { PaymentsReceivedTable } from "@/components/payments/payments-received-table";
import { formatCurrency } from "@/lib/utils";
import { getPaymentStatus } from "@/lib/gst";
import { formatOrderId } from "@/lib/order-id";
import { companyPath } from "@/lib/record-links";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    q?: string;
    page?: string;
    pageSize?: string;
    ppage?: string;
    ppageSize?: string;
  }>;
}) {
  const enabled = await isModuleEnabled("payments");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="payments" />;
  }

  const sessionUser = await currentUser();
  const userId = sessionUser!.id;
  const [params, canRecord, canDelete] = await Promise.all([
    searchParams,
    hasEffectivePermission(userId, "payments.record"),
    hasEffectivePermission(userId, "payments.delete"),
  ]);

  const status = ["unpaid", "partial", "paid"].includes(params.status ?? "")
    ? (params.status as PaymentStatusFilter)
    : undefined;
  // Two independent lists on one screen, so each gets its own page params.
  const orderPage = resolvePage(params.page);
  const orderPageSize = resolvePageSize(params.pageSize);
  const paymentPage = resolvePage(params.ppage);
  const paymentPageSize = resolvePageSize(params.ppageSize);

  const [orderResult, companies, paymentResult] = await Promise.all([
    listOrdersWithPaymentsPaged({ status, search: params.q, page: orderPage, pageSize: orderPageSize }),
    canRecord ? listCompanyOptions() : Promise.resolve([]),
    listPaymentsPaged({ page: paymentPage, pageSize: paymentPageSize }),
  ]);

  const orders = orderResult.rows;
  const payments = paymentResult.rows;
  const totalOutstanding = orderResult.outstanding;
  const totalUnallocated = paymentResult.unallocated;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">Payments</h1>
          <p className="mt-1 text-sm text-muted">
            {orderResult.total} order(s) · {formatCurrency(String(totalOutstanding))} outstanding
            {totalUnallocated > 0 && ` · ${formatCurrency(String(totalUnallocated))} unallocated`}
          </p>
        </div>
        <RecordPaymentButton companies={companies} canRecord={canRecord} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {/*
          Both page numbers, because these filters narrow both lists on this screen and resetting
          only one would leave the other stranded on a page that no longer exists.
        */}
        <SearchParamInput
          paramName="q"
          placeholder="Search company name…"
          resetParams={["page", "ppage"]}
        />
        <SelectParamFilter
          paramName="status"
          label="Status"
          allLabel="All"
          resetParams={["page", "ppage"]}
          options={[
            { value: "unpaid", label: "Unpaid" },
            { value: "partial", label: "Partially paid" },
            { value: "paid", label: "Paid" },
          ]}
        />
      </div>

      <Card className="mt-6">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5">Order ID</th>
                <th className="px-4 py-2.5">Company</th>
                <th className="px-4 py-2.5">Product</th>
                <th className="px-4 py-2.5">Qty</th>
                <th className="px-4 py-2.5">Total</th>
                <th className="px-4 py-2.5">Paid</th>
                <th className="px-4 py-2.5">Balance</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const paymentStatus = getPaymentStatus(o.total, o.paid);
                return (
                  <tr key={o.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                    <td className="px-4 py-2.5 font-mono text-xs text-muted">{formatOrderId(o.orderSeq)}</td>
                    <td className="px-4 py-2.5">
                      <Link href={`${companyPath(o.company.companySeq)}?tab=products`} className="font-medium text-text hover:underline">
                        {o.company.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-muted">
                      {o.item.name}
                      {o.item.unit ? ` (${o.item.unit})` : ""}
                    </td>
                    <td className="px-4 py-2.5 text-muted">{o.quantity}</td>
                    <td className="px-4 py-2.5 text-muted">{formatCurrency(String(o.total))}</td>
                    <td className="px-4 py-2.5 text-muted">{formatCurrency(String(o.paid))}</td>
                    <td className="px-4 py-2.5 text-muted">{formatCurrency(String(Math.max(o.balance, 0)))}</td>
                    <td className="px-4 py-2.5">
                      <Badge tone={paymentStatus.tone}>{paymentStatus.label}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <PaymentsRowAction
                        order={{
                          id: o.id,
                          orderSeq: o.orderSeq,
                          quantity: o.quantity,
                          item: o.item,
                          allocations: o.allocations,
                        }}
                        companyId={o.company.id}
                        companyName={o.company.name}
                        canRecord={canRecord}
                        canDelete={canDelete}
                      />
                    </td>
                  </tr>
                );
              })}
              {orders.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-subtle">
                    No orders match this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Pagination
        page={orderPage}
        pageSize={orderPageSize}
        total={orderResult.total}
        totalPages={totalPages(orderResult.total, orderPageSize)}
        pageSizes={PAGE_SIZES}
        label="orders"
      />

      <PaymentsReceivedTable payments={payments} canRecord={canRecord} canDelete={canDelete} />

      <Pagination
        page={paymentPage}
        pageSize={paymentPageSize}
        total={paymentResult.total}
        totalPages={totalPages(paymentResult.total, paymentPageSize)}
        pageSizes={PAGE_SIZES}
        pageParam="ppage"
        pageSizeParam="ppageSize"
        label="payments"
      />
    </div>
  );
}
