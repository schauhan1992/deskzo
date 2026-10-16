import { listTasks, listTasksPaged, countTasks } from "@/actions/task";
import { listTaskChallenges, taskFormOptions } from "@/actions/task-extras";
import { isModuleEnabled } from "@/actions/module";
import { auth } from "@/lib/auth";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { TasksWorkspace } from "@/components/tasks/tasks-workspace";
import { PRIORITY_LABELS, TASK_PRIORITIES, TASK_SORTS, type TaskSort } from "@/lib/tasks/rules";

/**
 * Tasks (owner, 16 Oct 2026): every task the viewer may see, as a table or a board by status, filtered
 * by status, priority, team, person, challenge, the viewer's stars and the due date.
 */
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    assignedTo?: string;
    status?: string;
    priority?: string;
    team?: string;
    challenge?: string;
    starred?: string;
    q?: string;
    dueFrom?: string;
    dueTo?: string;
    sort?: string;
    dir?: string;
    page?: string;
    pageSize?: string;
  }>;
}) {
  const enabled = await isModuleEnabled("tasks");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="tasks" />;
  }

  const [params, session] = await Promise.all([searchParams, auth()]);
  const userId = session!.user.id;
  const view = params.view === "board" ? "board" : "list";
  const sort = (TASK_SORTS as readonly string[]).includes(params.sort ?? "") ? (params.sort as TaskSort) : undefined;
  const dir = params.dir === "desc" ? ("desc" as const) : ("asc" as const);

  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const filters = {
    assignedToUserId: params.assignedTo,
    status: params.status,
    priority: (TASK_PRIORITIES as readonly string[]).includes(params.priority ?? "") ? params.priority : undefined,
    departmentId: params.team || undefined,
    challengeId: params.challenge || undefined,
    starred: params.starred === "1",
    search: params.q,
    dueFrom: params.dueFrom,
    dueTo: params.dueTo,
    sort,
    dir,
  };

  // The board shows everything that matches — a board with a hidden page 2 misreads the work — so only
  // the table is paged.
  const [result, options, challenges, counts] = await Promise.all([
    view === "board" ? listTasks(filters).then((rows) => ({ rows, total: rows.length })) : listTasksPaged({ ...filters, page, pageSize }),
    taskFormOptions(),
    listTaskChallenges(),
    countTasks(filters),
  ]);

  return (
    <div>
      <div>
        <h1 className="text-xl font-semibold text-text">Tasks</h1>
        <p className="mt-1 text-sm text-muted">
          {result.total} total · {counts.open} open{counts.overdue > 0 && ` · ${counts.overdue} overdue`}
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search tasks…" />
        <SelectParamFilter
          paramName="status"
          label="Status"
          allLabel="All"
          options={[
            { value: "open", label: "Open" },
            { value: "upcoming", label: "Upcoming" },
            { value: "todo", label: "To do" },
            { value: "in_progress", label: "In progress" },
            { value: "done", label: "Done" },
            { value: "cancelled", label: "Cancelled" },
          ]}
        />
        <SelectParamFilter paramName="priority" label="Priority" allLabel="Any" options={TASK_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))} />
        <SelectParamFilter paramName="team" label="Team" allLabel="Every team" options={options.departments.map((d) => ({ value: d.id, label: d.name }))} />
        <SelectParamFilter
          paramName="assignedTo"
          label="Assigned to"
          allLabel="Everyone"
          options={[{ value: "unassigned", label: "Unassigned" }, ...options.people.map((u) => ({ value: u.id, label: u.name }))]}
        />
        {challenges.length > 0 && (
          <SelectParamFilter
            paramName="challenge"
            label="Challenge"
            allLabel="Any"
            options={challenges.filter((c) => !c.archivedAt).map((c) => ({ value: c.id, label: c.name }))}
          />
        )}
        <SelectParamFilter paramName="starred" label="Starred" allLabel="All tasks" options={[{ value: "1", label: "Starred only" }]} />
        <DateRangePicker fromParam="dueFrom" toParam="dueTo" label="Due date" />
      </div>

      <div className="mt-6">
        <TasksWorkspace tasks={result.rows} options={options} challenges={challenges} viewerId={userId} view={view} sort={sort} dir={dir} />
      </div>

      {view === "list" && (
        <Pagination page={page} pageSize={pageSize} total={result.total} totalPages={totalPages(result.total, pageSize)} pageSizes={PAGE_SIZES} />
      )}
    </div>
  );
}
