import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil, PhoneCall } from "lucide-react";
import { auth } from "@/lib/auth";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getWorkbook, runWorkbook } from "@/actions/workspace";
import { listAssignableUsers } from "@/actions/company";
import { getViewMode } from "@/actions/view-mode";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { SplitListShell, SplitListEmpty, SplitListPage, resolveSelected, splitLinkParams } from "@/components/ui/split-list";
import { ViewModeToggle } from "@/components/ui/view-mode-toggle";
import { CompanySplitList } from "@/components/companies/company-split-list";
import { CompanyDetail } from "@/components/companies/company-detail";
import { WorkbookResults } from "@/components/workspace/workbook-results";
import { DuplicateWorkbookButton } from "@/components/workspace/duplicate-button";
import { AssignWorkbook } from "@/components/workspace/assign-workbook";
import { StartActivity } from "@/components/workspace/start-activity";
import { ActivityDashboard } from "@/components/workspace/activity-dashboard";
import { activityReport } from "@/actions/calling-activity";
import { countActiveFilters, filterLabels, type WorkbookFilters } from "@/lib/workspace/filters";
import { can } from "@/lib/authz/resolve";
import { isModuleEntitled } from "@/lib/modules-access";

export default async function WorkbookPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; page?: string; pageSize?: string; sel?: string; tab?: string }>;
}) {
  const enabled = await isModuleEnabled("workspace");
  if (!enabled) return <ModuleDisabledNotice moduleKey="workspace" />;

  const [{ id }, query] = await Promise.all([params, searchParams]);
  const workbook = await getWorkbook(id);
  if (!workbook) notFound();

  const page = resolvePage(query.page);
  const pageSize = resolvePageSize(query.pageSize);

  const isActivity = workbook.mode === "COLD_CALLING";
  // A calling campaign is the Calls module's: without it in the plan, none is started or reported.
  const callsInPlan = await isModuleEntitled("calls");

  const [session, viewMode, result, users, report] = await Promise.all([
    auth(),
    getViewMode("workspace"),
    // A campaign's rows are its frozen records, not the live filter — that's the whole point of
    // starting one, so the segment isn't re-run here.
    isActivity
      ? Promise.resolve({ rows: [], total: 0 })
      : runWorkbook({ filters: workbook.filters, page, pageSize, search: query.q }),
    listAssignableUsers(),
    isActivity && callsInPlan ? activityReport(id) : Promise.resolve(null),
  ]);

  const selected = !isActivity && viewMode === "split" ? resolveSelected(result.rows, query.sel) : null;

  // Named rather than listed in full: the point is to see at a glance what narrows this list, and
  // the exact values are one click away in the editor.
  const activeKeys = (Object.keys(workbook.filters) as (keyof WorkbookFilters)[]).filter((key) => {
    const value = workbook.filters[key];
    if (value === undefined || value === null || value === "" || value === false) return false;
    return Array.isArray(value) ? value.length > 0 : true;
  });

  const canAssign = workbook.canEdit || (session ? await can(session.user.id, "workspace.manageAny") : false);

  return (
    <SplitListPage active={!isActivity && viewMode === "split"}>
      <Link href="/workspace" className="text-sm text-muted hover:text-text">
        ← Workspace
      </Link>

      <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-text">{workbook.name}</h1>
          {workbook.description && viewMode === "list" && (
            <p className="mt-1 text-sm text-muted">{workbook.description}</p>
          )}
          <p className="mt-1 text-xs text-subtle">
            {isActivity
              ? `${report?.totals.records ?? 0} record(s) frozen · calling activity`
              : `${result.total.toLocaleString("en-IN")} compan${result.total === 1 ? "y" : "ies"} today`}{" "}
            · {countActiveFilters(workbook.filters)} filter(s) · built by {workbook.owner.name}
            {!workbook.shared && " · private"}
          </p>
          <div className="mt-2">
            <AssignWorkbook
              workbookId={workbook.id}
              assignees={workbook.assignees}
              users={users}
              canAssign={canAssign}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!isActivity && <ViewModeToggle viewKey="workspace" mode={viewMode} />}
          {!isActivity && workbook.canEdit && callsInPlan && (
            <StartActivity workbookId={workbook.id} matchCount={result.total} users={users} />
          )}
          {isActivity && (
            <Link href={`/workspace/${workbook.id}/call`}>
              <Button>
                <PhoneCall className="mr-1.5 h-3.5 w-3.5" />
                Open my queue
              </Button>
            </Link>
          )}
          <DuplicateWorkbookButton id={workbook.id} />
          {workbook.canEdit && (
            <Link href={`/workspace/${workbook.id}/edit`}>
              <Button variant="secondary">
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Edit filters
              </Button>
            </Link>
          )}
        </div>
      </div>

      {activeKeys.length > 0 && viewMode === "list" && !isActivity && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {activeKeys.map((key) => (
            <Badge key={key} tone="blue">
              {filterLabels[key] ?? key}
            </Badge>
          ))}
        </div>
      )}

      {!isActivity && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <SearchParamInput paramName="q" placeholder="Search within this list…" />
        </div>
      )}

      {isActivity && report ? (
        <div className="mt-5">
          <ActivityDashboard report={report} currentUserId={session?.user.id} />
        </div>
      ) : viewMode === "split" ? (
        <SplitListShell
          countLabel={`${result.total} compan${result.total === 1 ? "y" : "ies"}`}
          listPane={<CompanySplitList companies={result.rows} selectedId={selected} />}
        >
          {selected ? (
            <CompanyDetail
              id={selected}
              tab={query.tab}
              basePath={`/workspace/${workbook.id}`}
              linkParams={splitLinkParams(query, selected)}
            />
          ) : (
            <SplitListEmpty message="Nothing in this list yet. Loosen a filter and it will fill." />
          )}
        </SplitListShell>
      ) : (
        <>
          <div className="mt-4">
            <WorkbookResults rows={result.rows} filters={workbook.filters} />
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
