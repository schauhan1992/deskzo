import { listRenewalsPaged, type RenewalWindow } from "@/actions/renewal";
import { isModuleEnabled } from "@/actions/module";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { ColumnPicker } from "@/components/ui/table-columns";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { RenewalsTable } from "@/components/renewals/renewals-table";
import { RenewalSplitList } from "@/components/renewals/renewal-split-list";
import { CustomerNoticeButton } from "@/components/marketing/customer-notice-button";
import { RenewButton } from "@/components/renewals/renew-button";
import { CallButton } from "@/components/calls/call-button";
// A renewal row IS an order — the subscription and the order it was punched as are one record — so
// the order's detail is the renewal's detail.
import { OrderDetail } from "@/components/orders/order-detail";
import { SplitListShell, SplitListEmpty, SplitListPage, resolveSelected } from "@/components/ui/split-list";
import { ViewModeToggle } from "@/components/ui/view-mode-toggle";
import { getViewMode } from "@/actions/view-mode";
import { listAssignableUsers } from "@/actions/company";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";

export default async function RenewalsPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string; q?: string; page?: string; pageSize?: string; sel?: string }>;
}) {
  const enabled = await isModuleEnabled("renewals");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="renewals" />;
  }

  const params = await searchParams;
  const window = ["expired", "30", "60", "90"].includes(params.window ?? "")
    ? (params.window as RenewalWindow)
    : undefined;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const [viewMode, result, users] = await Promise.all([
    getViewMode("renewals"),
    listRenewalsPaged({ window, search: params.q, page, pageSize }),
    listAssignableUsers(),
  ]);
  const renewals = result.rows;
  const selected = viewMode === "split" ? resolveSelected(renewals, params.sel) : null;

  const expiredCount = result.expired;

  const selectedRenewal = selected ? renewals.find((r) => r.id === selected) ?? null : null;

  return (
    <SplitListPage active={viewMode === "split"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">Renewals</h1>
          <p className="mt-1 text-sm text-muted">
            {result.total} subscription(s) with an expiry date{expiredCount > 0 && ` · ${expiredCount} expired`}
          </p>
        </div>
        <ViewModeToggle viewKey="renewals" mode={viewMode} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search company name…" />
        <SelectParamFilter
          paramName="window"
          label="Window"
          allLabel="All"
          options={[
            { value: "expired", label: "Expired" },
            { value: "30", label: "Expiring in 30 days" },
            { value: "60", label: "Expiring in 60 days" },
            { value: "90", label: "Expiring in 90 days" },
          ]}
        />
        <ColumnPicker tableKey="renewals" className="ml-auto" />
      </div>

      {viewMode === "split" ? (
        <SplitListShell
          countLabel={`${result.total} subscription${result.total === 1 ? "" : "s"}`}
          listPane={<RenewalSplitList renewals={renewals} selectedId={selected} />}
        >
          {selected ? (
            <div>
              {/* The same per-row action the table has, for whoever works from the split view. */}
              {selectedRenewal && (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
                  <span className="text-xs text-subtle">
                    {selectedRenewal.company.owner?.name
                      ? `Account manager: ${selectedRenewal.company.owner.name}`
                      : "No account manager on this company"}
                  </span>
                  <div className="flex items-center gap-1">
                    <CallButton
                      companyId={selectedRenewal.company.id}
                      companyName={selectedRenewal.company.name}
                      companyProductId={selectedRenewal.id}
                      preferContact={selectedRenewal.company.contacts?.[0]}
                      size="icon"
                      variant="ghost"
                    />
                    <CustomerNoticeButton
                      companyProductId={selectedRenewal.id}
                      companyName={(selectedRenewal.endCustomer ?? selectedRenewal.company).name}
                    />
                    <RenewButton companyProductId={selectedRenewal.id} />
                  </div>
                </div>
              )}
              {/* Its own call button stands down — the strip above has one, next to the other
                  two things you'd do with a renewal. */}
              <OrderDetail id={selected} showCall={false} />
            </div>
          ) : (
            <SplitListEmpty message="No subscriptions match these filters." />
          )}
        </SplitListShell>
      ) : (
        <>
          <div className="mt-6">
            <RenewalsTable renewals={renewals} users={users} />
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
