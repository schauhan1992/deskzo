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
import {
  companySourceValues,
  vendorRelationshipTypeValues,
  relationshipTypeLabels,
  vendorStatusValues,
  vendorStatusLabels,
} from "@/lib/validation/company";
import type { CompanySource, VendorStatus } from "@prisma/client";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { viewerReassignControls } from "@/lib/authz/reassign";

// Search params reach Prisma's enum filters directly, so anything outside the allowed set is
// dropped rather than passed through: an unknown value would 500 the query, and a relationship
// type this module doesn't own (notably COMMISSION_PARTY) would pull that module's records in here.
function asVendorRelationshipType(value?: string) {
  return vendorRelationshipTypeValues.find((t) => t === value);
}

function asVendorStatus(value?: string) {
  return vendorStatusValues.includes(value as VendorStatus) ? (value as VendorStatus) : undefined;
}

function asCompanySource(value?: string) {
  return companySourceValues.includes(value as CompanySource) ? (value as CompanySource) : undefined;
}

export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    assignedTo?: string;
    source?: string;
    industryId?: string;
    relationshipType?: string;
    vendorStatus?: string;
    createdFrom?: string;
    createdTo?: string;
    page?: string;
    pageSize?: string;
    sel?: string;
    tab?: string;
  }>;
}) {
  const enabled = await isModuleEnabled("vendors");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="vendors" />;
  }

  const params = await searchParams;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const vendorFilters = {
    search: params.q,
    assignedToUserId: params.assignedTo,
    source: asCompanySource(params.source),
    industryId: params.industryId,
    relationshipType: asVendorRelationshipType(params.relationshipType),
    vendorStatus: asVendorStatus(params.vendorStatus),
    createdFrom: params.createdFrom,
    createdTo: params.createdTo,
  };
  const [viewMode, result, assignableUsers, industries, onboardingCount] = await Promise.all([
    getViewMode("vendors"),
    listVendorsPaged({ page, pageSize, ...vendorFilters }),
    listAssignableUsers(),
    listIndustries(),
    countVendorsOnboarding(vendorFilters),
  ]);

  const selected = viewMode === "split" ? resolveSelected(result.rows, params.sel) : null;

  return (
    <SplitListPage active={viewMode === "split"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">Vendors</h1>
          <p className="mt-1 text-sm text-muted">
            {result.total} vendor, OEM, distributor, and partner companies
            {onboardingCount > 0 && ` · ${onboardingCount} still onboarding`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ViewModeToggle viewKey="vendors" mode={viewMode} />
          <Link href="/vendors/new">
            <Button>New vendor</Button>
          </Link>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search company name…" />
        <SelectParamFilter
          paramName="relationshipType"
          label="Type"
          options={vendorRelationshipTypeValues.map((t) => ({
            value: t,
            label: relationshipTypeLabels[t],
          }))}
        />
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
        <ColumnPicker tableKey="vendors" className="ml-auto" />
      </div>

      {viewMode === "split" ? (
        <SplitListShell
          countLabel={`${result.total} vendor${result.total === 1 ? "" : "s"}`}
          listPane={<CompanySplitList companies={result.rows} selectedId={selected} isVendor={true} />}
        >
          {selected ? (
            <CompanyDetail id={selected} tab={params.tab} basePath="/vendors" linkParams={splitLinkParams(params, selected)} />
          ) : (
            <SplitListEmpty message="No vendors match these filters." />
          )}
        </SplitListShell>
      ) : (
        <div className="mt-6">
          <CompaniesTable companies={result.rows} assignableUsers={assignableUsers} mode="vendors" reassign={await viewerReassignControls()} />
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
