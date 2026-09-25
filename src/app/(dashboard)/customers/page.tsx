import { listCustomersPaged, listAssignableUsers } from "@/actions/company";
import { portalStateFor } from "@/lib/portal/state";
import { listIndustries } from "@/actions/industry";
import { listCustomerCategories } from "@/actions/customer-category";
import { categoryFilterOptions } from "@/lib/customers/categories";
import { CompaniesTable } from "@/components/companies/companies-table";
import { CompanySplitList } from "@/components/companies/company-split-list";
import { CompanyDetail } from "@/components/companies/company-detail";
import { SplitListShell, SplitListEmpty, SplitListPage, resolveSelected, splitLinkParams } from "@/components/ui/split-list";
import { ViewModeToggle } from "@/components/ui/view-mode-toggle";
import { getViewMode } from "@/actions/view-mode";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { ColumnPicker } from "@/components/ui/table-columns";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { companySourceValues } from "@/lib/validation/company";
import type { CompanySource } from "@prisma/client";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { viewerReassignControls } from "@/lib/authz/reassign";

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    assignedTo?: string;
    source?: string;
    industryId?: string;
    category?: string;
    createdFrom?: string;
    createdTo?: string;
    page?: string;
    pageSize?: string;
    sel?: string;
    tab?: string;
  }>;
}) {
  const params = await searchParams;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const [viewMode, result, assignableUsers, industries, categories] = await Promise.all([
    getViewMode("customers"),
    listCustomersPaged({
      page,
      pageSize,
      search: params.q,
      assignedToUserId: params.assignedTo,
      source: params.source as CompanySource | undefined,
      industryId: params.industryId,
      categoryId: params.category,
      createdFrom: params.createdFrom,
      createdTo: params.createdTo,
    }),
    listAssignableUsers(),
    listIndustries(),
    listCustomerCategories(),
  ]);

  /**
   * Portal state for this page of customers, in two queries rather than one per row.
   *
   * Resolved here rather than inside the table because it depends on the global portal settings,
   * which a client component has no business reading.
   */
  const portal = await portalStateFor(result.rows);
  const rows = result.rows.map((c) => ({ ...c, portal: portal.get(c.id) ?? null }));

  const selected = viewMode === "split" ? resolveSelected(rows, params.sel) : null;

  return (
    <SplitListPage active={viewMode === "split"}>
      <div>
        <h1 className="text-xl font-semibold text-text">Customer</h1>
        <p className="mt-1 text-sm text-muted">
          {result.total} {result.total === 1 ? "company has" : "companies have"} actually purchased from us — at least one order
          on file, active or expired.
        </p>
      </div>
      <ViewModeToggle viewKey="customers" mode={viewMode} />

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search company name…" />
        <SelectParamFilter paramName="source" label="Source" options={companySourceValues.map((s) => ({ value: s, label: s }))} />
        <SelectParamFilter
          paramName="industryId"
          label="Industry"
          options={industries.map((i) => ({ value: i.id, label: i.name }))}
        />
        <SelectParamFilter paramName="category" label="Category" options={categoryFilterOptions(categories)} />
        <SelectParamFilter
          paramName="assignedTo"
          label="Caller"
          allLabel="Everyone"
          options={[
            { value: "unassigned", label: "Unassigned" },
            ...assignableUsers.map((u) => ({ value: u.id, label: u.name })),
          ]}
        />
        <DateRangePicker fromParam="createdFrom" toParam="createdTo" label="Added on" />
        <ColumnPicker tableKey="customers" className="ml-auto" />
      </div>

      {viewMode === "split" ? (
        <SplitListShell
          countLabel={`${result.total} customer${result.total === 1 ? "" : "s"}`}
          listPane={<CompanySplitList companies={rows} selectedId={selected} isVendor={false} />}
        >
          {selected ? (
            <CompanyDetail id={selected} tab={params.tab} basePath="/customers" linkParams={splitLinkParams(params, selected)} />
          ) : (
            <SplitListEmpty message="No customers match these filters." />
          )}
        </SplitListShell>
      ) : (
        <div className="mt-6">
          <CompaniesTable companies={rows} assignableUsers={assignableUsers} mode="customers" reassign={await viewerReassignControls()} />
          <Pagination
            page={page}
            pageSize={pageSize}
            total={result.total}
            totalPages={totalPages(result.total, pageSize)}
            pageSizes={PAGE_SIZES}
          />
        </div>
      )}
    </SplitListPage>
  );
}
