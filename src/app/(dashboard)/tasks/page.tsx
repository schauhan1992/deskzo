import { listTasksPaged, countTasks } from "@/actions/task";
import { listAssignableUsers } from "@/actions/company";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { auth } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { TaskList } from "@/components/tasks/task-list";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{
    assignedTo?: string;
    status?: string;
    q?: string;
    dueFrom?: string;
    dueTo?: string;
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
  const done = params.status === "done" ? true : params.status === "open" ? false : undefined;

  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const filters = {
    assignedToUserId: params.assignedTo,
    done,
    search: params.q,
    dueFrom: params.dueFrom,
    dueTo: params.dueTo,
  };

  const [result, users, canDeleteAny, counts] = await Promise.all([
    listTasksPaged({ ...filters, page, pageSize }),
    listAssignableUsers(),
    hasEffectivePermission(userId, "tasks.delete"),
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
        <SearchParamInput paramName="q" placeholder="Search title…" />
        <SelectParamFilter
          paramName="status"
          label="Status"
          allLabel="All"
          options={[
            { value: "open", label: "Open" },
            { value: "done", label: "Done" },
          ]}
        />
        <SelectParamFilter
          paramName="assignedTo"
          label="Assigned to"
          allLabel="Everyone"
          options={[
            { value: "unassigned", label: "Unassigned" },
            ...users.map((u) => ({ value: u.id, label: u.name })),
          ]}
        />
        <DateRangePicker fromParam="dueFrom" toParam="dueTo" label="Due date" />
      </div>

      <Card className="mt-6 overflow-x-auto p-0">
        <div className="p-4">
          <TaskList
            tasks={result.rows}
            users={users}
            currentUserId={userId}
            canDeleteAny={canDeleteAny}
            showLinkedRecord
          />
        </div>
      </Card>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={result.total}
        totalPages={totalPages(result.total, pageSize)}
        pageSizes={PAGE_SIZES}
      />
    </div>
  );
}
