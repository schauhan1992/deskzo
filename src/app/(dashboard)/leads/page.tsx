import Link from "next/link";
import { listLeads, listLeadsPaged } from "@/actions/lead";
import { listAssignableUsers } from "@/actions/company";
import { Button } from "@/components/ui/button";
import { ViewToggle } from "@/components/leads/view-toggle";
import { LeadsBoard } from "@/components/leads/leads-board";
import { LeadsListTable } from "@/components/leads/leads-list-table";
import { LeadSplitList } from "@/components/leads/lead-split-list";
import { LeadDetail } from "@/components/leads/lead-detail";
import { SplitListShell, SplitListEmpty, SplitListPage, resolveSelected } from "@/components/ui/split-list";
import { getViewMode } from "@/actions/view-mode";
import { ExportLeadsButton } from "@/components/leads/export-leads-button";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { ColumnPicker } from "@/components/ui/table-columns";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { leadStatusValues } from "@/lib/validation/lead";
import type { LeadSource, LeadStatus } from "@prisma/client";
import { LEAD_SOURCE_LABELS, LEAD_SOURCE_VALUES } from "@/lib/leads/source";
import { viewerReassignControls } from "@/lib/authz/reassign";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { NoAccessNotice } from "@/components/settings/module-disabled-notice";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    sel?: string;
    status?: string;
    q?: string;
    owner?: string;
    closeFrom?: string;
    closeTo?: string;
    source?: string;
    grade?: string;
    sort?: string;
    page?: string;
    pageSize?: string;
  }>;
}) {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "leads.view"))) return <NoAccessNotice title="Lead pipeline" permission="leads.view" />;

  const params = await searchParams;
  const view = params.view === "list" ? "list" : "board";

  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const filters = {
    status: params.status as LeadStatus | undefined,
    search: params.q,
    ownerUserId: params.owner,
    closeFrom: params.closeFrom,
    closeTo: params.closeTo,
    source: (LEAD_SOURCE_VALUES as readonly string[]).includes(params.source ?? "") ? (params.source as LeadSource) : undefined,
    grade: (["HOT", "WARM", "COLD"] as const).find((g) => g === params.grade),
    sort: params.sort === "score" ? ("score" as const) : undefined,
  };

  // The board shows the whole pipeline — a kanban with a hidden page 2 would misrepresent it — so
  // only the list view is paginated.
  const [viewMode, result, assignableUsers] = await Promise.all([
    getViewMode("leads"),
    view === "list" ? listLeadsPaged({ ...filters, page, pageSize }) : listLeads(filters).then((rows) => ({ rows, total: rows.length })),
    listAssignableUsers(),
  ]);

  // Prisma's Decimal is a class instance, not plain data — it can't cross the
  // Server → Client Component boundary as a prop, so serialize it to a string here.
  const leads = result.rows.map((lead) => ({
    ...lead,
    estimatedValue: lead.estimatedValue?.toString() ?? null,
  }));

  const selected = view === "list" && viewMode === "split" ? resolveSelected(leads, params.sel) : null;

  return (
    <SplitListPage active={view === "list" && viewMode === "split"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">Lead pipeline</h1>
          <p className="mt-1 text-sm text-muted">{result.total} total leads</p>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle
            view={view}
            mode={viewMode}
            otherParams={{
              status: params.status,
              q: params.q,
              owner: params.owner,
              closeFrom: params.closeFrom,
              closeTo: params.closeTo,
              source: params.source,
              grade: params.grade,
              sort: params.sort,
            }}
          />
          <ExportLeadsButton />
          <Link href="/leads/new">
            <Button>New lead</Button>
          </Link>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search title or company…" />
        <SelectParamFilter
          paramName="status"
          label="Status"
          options={leadStatusValues.map((s) => ({ value: s, label: s.replaceAll("_", " ") }))}
        />
        <SelectParamFilter
          paramName="owner"
          label="Owner"
          allLabel="Everyone"
          options={[{ value: "unassigned", label: "Unassigned" }, ...assignableUsers.map((u) => ({ value: u.id, label: u.name }))]}
        />
        <SelectParamFilter
          paramName="source"
          label="Source"
          options={LEAD_SOURCE_VALUES.map((s) => ({ value: s, label: LEAD_SOURCE_LABELS[s] }))}
        />
        <SelectParamFilter
          paramName="grade"
          label="Score"
          allLabel="Any"
          options={[
            { value: "HOT", label: "Hot (70+)" },
            { value: "WARM", label: "Warm (40–69)" },
            { value: "COLD", label: "Cold (under 40)" },
          ]}
        />
        <SelectParamFilter
          paramName="sort"
          label="Sort"
          allLabel="Recently updated"
          options={[{ value: "score", label: "Highest score" }]}
        />
        <DateRangePicker fromParam="closeFrom" toParam="closeTo" label="Expected close" />
        <ColumnPicker tableKey="leads" className="ml-auto" />
      </div>

      {view === "list" && viewMode === "split" ? (
        <SplitListShell
          countLabel={`${result.total} lead${result.total === 1 ? "" : "s"}`}
          listPane={<LeadSplitList leads={leads} selectedId={selected} />}
        >
          {selected ? <LeadDetail id={selected} /> : <SplitListEmpty message="No leads match these filters." />}
        </SplitListShell>
      ) : (
        <div className="mt-6">
          {view === "list" ? (
            <>
              <LeadsListTable leads={leads} assignableUsers={assignableUsers} reassign={await viewerReassignControls()} />
              <Pagination
                page={page}
                pageSize={pageSize}
                total={result.total}
                totalPages={totalPages(result.total, pageSize)}
                pageSizes={PAGE_SIZES}
              />
            </>
          ) : (
            <LeadsBoard leads={leads} />
          )}
        </div>
      )}
    </SplitListPage>
  );
}
