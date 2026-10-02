import Link from "next/link";
import { listVendorsPaged, countVendorsOnboarding, listAssignableUsers } from "@/actions/company";
import { listIndustries } from "@/actions/industry";
import { isModuleEnabled } from "@/actions/module";
import { Button } from "@/components/ui/button";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
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
import { companySourceValues, vendorStatusValues, vendorStatusLabels } from "@/lib/validation/company";
import type { CompanySource, VendorStatus } from "@prisma/client";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { viewerReassignControls } from "@/lib/authz/reassign";
import { requireUser } from "@/lib/session";
import { listColumns } from "@/lib/custom-fields/server";
import { customFilterSetup, parseCustomFilters, type CustomFilterParams } from "@/lib/custom-fields/filters";
import { CustomFieldFilters } from "@/components/custom-fields/custom-field-filters";

// Search params reach Prisma's enum filters directly, so anything unrecognised is dropped rather
// than passed through — an unknown value would otherwise fail the query and 500 the page.
function asVendorStatus(value?: string) {
  return vendorStatusValues.includes(value as VendorStatus) ? (value as VendorStatus) : undefined;
}

function asCompanySource(value?: string) {
  return companySourceValues.includes(value as CompanySource) ? (value as CompanySource) : undefined;
}

export default async function CommissionPartiesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    assignedTo?: string;
    source?: string;
    industryId?: string;
    vendorStatus?: string;
    createdFrom?: string;
    createdTo?: string;
    page?: string;
    pageSize?: string;
    sel?: string;
    tab?: string;
  } & CustomFilterParams>;
}) {
  const enabled = await isModuleEnabled("commission_parties");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="commission_parties" />;
  }

  const params = await searchParams;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const vendorFilters = {
    relationshipType: "COMMISSION_PARTY" as const,
    search: params.q,
    assignedToUserId: params.assignedTo,
    source: asCompanySource(params.source),
    industryId: params.industryId,
    vendorStatus: asVendorStatus(params.vendorStatus),
    createdFrom: params.createdFrom,
    createdTo: params.createdTo,
    customFilters: parseCustomFilters(params),
  };
  const [viewMode, result, assignableUsers, industries, onboardingCount] = await Promise.all([
    getViewMode("commission-parties"),
    listVendorsPaged({ page, pageSize, ...vendorFilters }),
    listAssignableUsers(),
    listIndustries(),
    countVendorsOnboarding(vendorFilters),
  ]);

  const selected = viewMode === "split" ? resolveSelected(result.rows, params.sel) : null;
  // The workspace's own fields (src/lib/custom-fields): the columns the table can show — the split view
  // has none, so it asks for no values, but the picker still offers them — and the filter panel.
  const user = await requireUser();
  const [customColumns, fieldFilters] = await Promise.all([
    listColumns("COMPANY", user.id, viewMode === "split" ? [] : result.rows.map((c) => c.id)),
    customFilterSetup("COMPANY", user.id, vendorFilters.customFilters),
  ]);

  return (
    <SplitListPage active={viewMode === "split"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">Commission Parties</h1>
          <p className="mt-1 text-sm text-muted">
            {result.total} agents, brokers, and referral partners we pay commission to
            {onboardingCount > 0 && ` · ${onboardingCount} still onboarding`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ViewModeToggle viewKey="commission-parties" mode={viewMode} />
          <Link href="/commission-parties/new">
            <Button>New commission party</Button>
          </Link>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search company/agent name…" />
        <SelectParamFilter
          paramName="vendorStatus"
          label="Status"
          options={vendorStatusValues.map((s) => ({
            value: s,
            label: vendorStatusLabels[s],
          }))}
        />
        <SelectParamFilter paramName="source" label="Source" options={companySourceValues.map((s) => ({ value: s, label: s }))} />
        <SelectParamFilter
          paramName="industryId"
          label="Industry"
          options={industries.map((i) => ({ value: i.id, label: i.name }))}
        />
        <SelectParamFilter
          paramName="assignedTo"
          label="Assigned to"
          allLabel="Everyone"
          options={[
            { value: "unassigned", label: "Unassigned" },
            ...assignableUsers.map((u) => ({ value: u.id, label: u.name })),
          ]}
        />
        <DateRangePicker fromParam="createdFrom" toParam="createdTo" label="Added on" />
        <CustomFieldFilters setup={fieldFilters} />
        <ColumnPicker tableKey="commission-parties" className="ml-auto" customColumns={customColumns.columns} />
      </div>

      {viewMode === "split" ? (
        <SplitListShell
          countLabel={`${result.total} commission part${result.total === 1 ? "y" : "ies"}`}
          listPane={<CompanySplitList companies={result.rows} selectedId={selected} isVendor={true} />}
        >
          {selected ? (
            <CompanyDetail
              id={selected}
              tab={params.tab}
              basePath="/commission-parties"
              linkParams={splitLinkParams(params, selected)}
            />
          ) : (
            <SplitListEmpty message="No commission parties match these filters." />
          )}
        </SplitListShell>
      ) : (
        <div className="mt-6">
          <CompaniesTable
            companies={result.rows}
            assignableUsers={assignableUsers}
            mode="commission-parties"
            reassign={await viewerReassignControls()}
            customColumns={customColumns}
          />
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
