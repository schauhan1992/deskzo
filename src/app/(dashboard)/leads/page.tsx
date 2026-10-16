import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";
import Link from "next/link";
import { notFound } from "next/navigation";
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
import { leadStages, stagesOfLeads } from "@/lib/pipeline/server";
import type { LeadSource, LeadStatus } from "@prisma/client";
import { LEAD_SOURCE_LABELS, LEAD_SOURCE_VALUES } from "@/lib/leads/source";
import { viewerReassignControls } from "@/lib/authz/reassign";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { listColumns } from "@/lib/custom-fields/server";
import { customFilterParams, customFilterSetup, parseCustomFilters, type CustomFilterParams } from "@/lib/custom-fields/filters";
import { CustomFieldFilters } from "@/components/custom-fields/custom-field-filters";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    sel?: string;
    status?: string;
    stage?: string;
    /** The team pipeline shown, by its key; the first in use when not given (src/lib/pipeline). */
    pipeline?: string;
    q?: string;
    owner?: string;
    closeFrom?: string;
    closeTo?: string;
    source?: string;
    grade?: string;
    sort?: string;
    page?: string;
    pageSize?: string;
  } & CustomFilterParams>;
}) {
  if (!(await isModuleEnabled("leads"))) return <ModuleDisabledNotice moduleKey="leads" />;
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "leads.view"))) notFound();

  const params = await searchParams;
  const view = params.view === "list" ? "list" : "board";

  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  // One team pipeline at a time (owner, 14 Oct 2026): the board's columns are its stages. The first in
  // use — the main one, unless reordered — when none is asked for, or one no longer in use is.
  const pipelineData = await leadStages();
  const inUse = pipelineData.pipelines.filter((p) => !p.archived);
  const shown = inUse.find((p) => p.key === params.pipeline) ?? inUse[0] ?? pipelineData.pipelines[0]!;
  const filters = {
    status: params.status as LeadStatus | undefined,
    stage: params.stage || undefined,
    pipeline: shown.key,
    search: params.q,
    ownerUserId: params.owner,
    closeFrom: params.closeFrom,
    closeTo: params.closeTo,
    source: (LEAD_SOURCE_VALUES as readonly string[]).includes(params.source ?? "") ? (params.source as LeadSource) : undefined,
    grade: (["HOT", "WARM", "COLD"] as const).find((g) => g === params.grade),
    sort: params.sort === "score" ? ("score" as const) : undefined,
    customFilters: parseCustomFilters(params),
  };

  // The board shows the whole pipeline — a kanban with a hidden page 2 would misrepresent it — so
  // only the list view is paginated.
  const [viewMode, result, assignableUsers] = await Promise.all([
    getViewMode("leads"),
    view === "list" ? listLeadsPaged({ ...filters, page, pageSize }) : listLeads(filters).then((rows) => ({ rows, total: rows.length, contactDetails: false })),
    listAssignableUsers(),
  ]);

  // Prisma's Decimal is a class instance, not plain data — it can't cross the
  // Server → Client Component boundary as a prop, so serialize it to a string here.
  // The workspace's own stages (Settings → Pipeline, src/lib/pipeline): the board's columns, the filter's
  // choices, and the one each lead shows.
  const stageOf = await stagesOfLeads(result.rows);
  const activeStages = pipelineData.stages.filter((s) => !s.archived && s.pipelineId === shown.id);
  const leads = result.rows.map((lead) => ({
    ...lead,
    estimatedValue: lead.estimatedValue?.toString() ?? null,
    stage: stageOf.get(lead.id)!,
  }));

  const selected = view === "list" && viewMode === "split" ? resolveSelected(leads, params.sel) : null;

  // The workspace's own fields (src/lib/custom-fields): the columns the table can show — only the table
  // shows them, so neither the board nor the split list asks for values, though the picker still offers
  // them — and the filter panel, which narrows the board as well.
  const [customColumns, fieldFilters] = await Promise.all([
    listColumns("LEAD", user.id, view === "list" && viewMode !== "split" ? leads.map((l) => l.id) : []),
    customFilterSetup("LEAD", user.id, filters.customFilters),
  ]);

  return (
    <SplitListPage active={view === "list" && viewMode === "split"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">{slot(await getWording(), "Lead pipeline", "lead", "{one} pipeline")}</h1>
          <p className="mt-1 text-sm text-muted">{inUse.length > 1 ? `${result.total} in ${shown.name}` : `${result.total} total leads`}</p>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle
            view={view}
            mode={viewMode}
            otherParams={{
              ...customFilterParams(params),
              status: params.status,
              stage: params.stage,
              pipeline: params.pipeline,
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
          <Link href={inUse.length > 1 ? `/leads/new?pipeline=${encodeURIComponent(shown.key)}` : "/leads/new"}>
            <Button>{slot(await getWording(), "New lead", "lead", "New {one:lower}")}</Button>
          </Link>
        </div>
      </div>

      {inUse.length > 1 && (
        <nav aria-label="Pipelines" className="mt-4 flex flex-wrap items-center gap-2">
          {inUse.map((p) => (
            <Link
              key={p.id}
              href={`/leads?pipeline=${encodeURIComponent(p.key)}${view === "list" ? "&view=list" : ""}`}
              aria-current={p.id === shown.id ? "page" : undefined}
              className={`rounded-full border px-3 py-1 text-sm ${p.id === shown.id ? "border-brand bg-brand-subtle font-medium text-brand" : "border-line text-muted hover:text-text"}`}
            >
              {p.name}
            </Link>
          ))}
        </nav>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search title or company…" />
        <SelectParamFilter paramName="stage" label="Stage" options={activeStages.map((s) => ({ value: s.key, label: s.label }))} />
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
        <CustomFieldFilters setup={fieldFilters} />
        <ColumnPicker tableKey="leads" className="ml-auto" customColumns={customColumns.columns} />
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
              <LeadsListTable
                leads={leads}
                stages={activeStages}
                assignableUsers={assignableUsers}
                reassign={await viewerReassignControls()}
                customColumns={customColumns}
                contactDetails={result.contactDetails}
              />
              <Pagination
                page={page}
                pageSize={pageSize}
                total={result.total}
                totalPages={totalPages(result.total, pageSize)}
                pageSizes={PAGE_SIZES}
              />
            </>
          ) : (
            <LeadsBoard leads={leads} stages={activeStages} />
          )}
        </div>
      )}
    </SplitListPage>
  );
}
