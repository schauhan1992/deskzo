import Link from "next/link";
import { listCompaniesPaged, listAssignableUsers } from "@/actions/company";
import { listIndustries } from "@/actions/industry";
import { listCustomerCategories } from "@/actions/customer-category";
import { categoryFilterOptions } from "@/lib/customers/categories";
import { Button } from "@/components/ui/button";
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
import type { CompanyStage, CompanySource } from "@prisma/client";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { viewerReassignControls } from "@/lib/authz/reassign";

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<{
    stage?: string;
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
  // This is the raw CLIENT-track sourcing pool, not the customer list (see /customers) — every
  // company here has `hasOrders: false` by definition, so a `stage: "CUSTOMER"` row within it is
  // always a won deal that's still waiting on its first order, never a real paying customer.
  // Vendors/OEMs/distributors/partners/commission parties never appear here — they live in their
  // own modules (`listCompanies` defaults to `relationshipType: "CLIENT"`).
  const [viewMode, result, assignableUsers, industries, categories] = await Promise.all([
    getViewMode("companies"),
    listCompaniesPaged({
      page,
      pageSize,
      stage: params.stage as CompanyStage | undefined,
      hasOrders: false,
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

  const selected = viewMode === "split" ? resolveSelected(result.rows, params.sel) : null;

  const stageFilters: { label: string; value?: CompanyStage }[] = [
    { label: "All" },
    { label: "Prospects", value: "PROSPECT" },
    { label: "Leads", value: "LEAD" },
    { label: "Awaiting Order", value: "CUSTOMER" },
    { label: "Disqualified", value: "DISQUALIFIED" },
  ];

  function queryFor(overrides: Record<string, string | undefined>) {
    const next = {
      stage: params.stage,
      q: params.q,
      assignedTo: params.assignedTo,
      source: params.source,
      industryId: params.industryId,
      category: params.category,
      createdFrom: params.createdFrom,
      createdTo: params.createdTo,
      ...overrides,
    };
    return Object.fromEntries(Object.entries(next).filter(([, v]) => v)) as Record<string, string>;
  }

  return (
    <SplitListPage active={viewMode === "split"}>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text">Companies</h1>
        <div className="flex items-center gap-2">
          <ViewModeToggle viewKey="companies" mode={viewMode} />
          <Link href="/companies/new">
            <Button>New company</Button>
          </Link>
      </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search company name…" />
        <SelectParamFilter
          paramName="source"
          label="Source"
          options={companySourceValues.map((s) => ({ value: s, label: s }))}
        />
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
          options={[{ value: "unassigned", label: "Unassigned" }, ...assignableUsers.map((u) => ({ value: u.id, label: u.name }))]}
        />
        <DateRangePicker fromParam="createdFrom" toParam="createdTo" label="Added on" />
        <ColumnPicker tableKey="companies" className="ml-auto" />
      </div>

      <div className="mt-4 flex gap-2">
        {stageFilters.map((f) => (
          <Link
            key={f.label}
            href={{ pathname: "/companies", query: queryFor({ stage: f.value }) }}
            className={`rounded-full px-3 py-1 text-sm ${
              params.stage === f.value || (!params.stage && !f.value)
                ? "bg-brand text-brand-contrast"
                : "bg-surface text-muted border border-line-strong"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      {viewMode === "split" ? (
        <SplitListShell
          countLabel={`${result.total} compan${result.total === 1 ? "y" : "ies"}`}
          listPane={<CompanySplitList companies={result.rows} selectedId={selected} />}
        >
          {selected ? (
            <CompanyDetail
              id={selected}
              tab={params.tab}
              basePath="/companies"
              linkParams={splitLinkParams(params, selected)}
            />
          ) : (
            <SplitListEmpty message="No companies match these filters." />
          )}
        </SplitListShell>
      ) : (
        <div className="mt-6">
          <CompaniesTable companies={result.rows} assignableUsers={assignableUsers} reassign={await viewerReassignControls()} />
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
