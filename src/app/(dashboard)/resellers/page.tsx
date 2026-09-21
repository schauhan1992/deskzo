import Link from "next/link";
import { listResellersPaged, listAssignableUsers } from "@/actions/company";
import { listIndustries } from "@/actions/industry";
import { isModuleEnabled } from "@/actions/module";
import { Button } from "@/components/ui/button";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { ResellersTable } from "@/components/resellers/resellers-table";
import { ResellerSplitList } from "@/components/resellers/reseller-split-list";
import { CompanyDetail } from "@/components/companies/company-detail";
import { SplitListShell, SplitListEmpty, SplitListPage, resolveSelected, splitLinkParams } from "@/components/ui/split-list";
import { ViewModeToggle } from "@/components/ui/view-mode-toggle";
import { getViewMode } from "@/actions/view-mode";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { companySourceValues } from "@/lib/validation/company";
import type { CompanySource } from "@prisma/client";

function asCompanySource(value?: string) {
  return companySourceValues.includes(value as CompanySource) ? (value as CompanySource) : undefined;
}

export default async function ResellersPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    assignedTo?: string;
    source?: string;
    industryId?: string;
    createdFrom?: string;
    createdTo?: string;
    page?: string;
    pageSize?: string;
    sel?: string;
    tab?: string;
  }>;
}) {
  const enabled = await isModuleEnabled("resellers");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="resellers" />;
  }

  const params = await searchParams;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const [viewMode, result, assignableUsers, industries] = await Promise.all([
    getViewMode("resellers"),
    listResellersPaged({
      page,
      pageSize,
      search: params.q,
      assignedToUserId: params.assignedTo,
      source: asCompanySource(params.source),
      industryId: params.industryId,
      createdFrom: params.createdFrom,
      createdTo: params.createdTo,
    }),
    listAssignableUsers(),
    listIndustries(),
  ]);

  const endCustomerTotal = result.endCustomerTotal;
  const selected = viewMode === "split" ? resolveSelected(result.rows, params.sel) : null;

  return (
    <SplitListPage active={viewMode === "split"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">Resellers</h1>
          <p className="mt-1 text-sm text-muted">
            {result.total} channel partner(s) buying on behalf of {endCustomerTotal} end customer(s)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ViewModeToggle viewKey="resellers" mode={viewMode} />
          <Link href="/resellers/new">
            <Button>New reseller</Button>
          </Link>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search reseller name…" />
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
        <SelectParamFilter
          paramName="assignedTo"
          label="Account manager"
          allLabel="Everyone"
          options={[{ value: "unassigned", label: "Unassigned" }, ...assignableUsers.map((u) => ({ value: u.id, label: u.name }))]}
        />
        <DateRangePicker fromParam="createdFrom" toParam="createdTo" label="Added on" />
      </div>

      {viewMode === "split" ? (
        <SplitListShell
          countLabel={`${result.total} reseller${result.total === 1 ? "" : "s"}`}
          listPane={<ResellerSplitList resellers={result.rows} selectedId={selected} />}
        >
          {selected ? (
            <CompanyDetail
              id={selected}
              tab={params.tab}
              basePath="/resellers"
              linkParams={splitLinkParams(params, selected)}
            />
          ) : (
            <SplitListEmpty message="No resellers match these filters." />
          )}
        </SplitListShell>
      ) : (
        <>
          <div className="mt-6">
            <ResellersTable resellers={result.rows} />
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
