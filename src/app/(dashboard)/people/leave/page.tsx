import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { hrCapabilities, listLeaveTypes, listPeople } from "@/actions/hr";
import { listDepartmentOptions } from "@/actions/department";
import { allLeaveRequests, leaveApprovalQueue, leaveBalances, myLeaveRequests, upcomingLeave } from "@/actions/leave";
import { allShortLeaves, shortLeaveOverview } from "@/actions/short-leave";
import { LeaveWorkspace } from "@/components/hr/leave-workspace";
import { ShortLeavePanel } from "@/components/hr/short-leave-panel";
import { LeaveRegister } from "@/components/hr/leave-register";
import { ShortLeaveRegister } from "@/components/hr/short-leave-register";
import { TabNav } from "@/components/ui/tab-nav";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { Input, Label } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { financialYearLabel, financialYearOf } from "@/lib/hr/calendar";
import { workspaceClock } from "@/lib/time/workspace";

type Params = {
  view?: string;
  status?: string;
  typeId?: string;
  userId?: string;
  departmentId?: string;
  from?: string;
  to?: string;
  page?: string;
  pageSize?: string;
};

export default async function LeavePage({ searchParams }: { searchParams: Promise<Params> }) {
  const enabled = await isModuleEnabled("hr");
  if (!enabled) return <ModuleDisabledNotice moduleKey="hr" />;

  const params = await searchParams;
  const caps = await hrCapabilities();
  // Short leave has a tab of its own (owner, 21 Oct 2026): it was a card at the foot of Mine, and was
  // being missed.
  const view = params.view === "all" ? "all" : params.view === "short" ? "short" : "mine";
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const filters = {
    status: params.status,
    typeId: params.typeId,
    userId: params.userId,
    departmentId: params.departmentId,
    from: params.from,
    to: params.to,
  };

  const [balances, mine, queue, upcoming, leaveTypes, departments, people, register, shortLeave, shortRegister] = await Promise.all([
    leaveBalances(caps.userId),
    myLeaveRequests(view === "mine" ? filters : undefined),
    leaveApprovalQueue(view === "all" ? filters : undefined),
    upcomingLeave(30),
    listLeaveTypes(),
    listDepartmentOptions(),
    listPeople({ status: "active" }),
    view === "all"
      ? allLeaveRequests({ ...filters, page, pageSize })
      : Promise.resolve({ rows: [], total: 0, pendingCount: 0 }),
    view === "short" ? shortLeaveOverview() : Promise.resolve(null),
    view === "short" ? allShortLeaves({ ...filters, page, pageSize }) : Promise.resolve(null),
  ]);

  // The leave year we are in, from the workspace's today — as leaveBalances reads it.
  const fy = financialYearOf((await workspaceClock()).calendarDate(new Date()));
  const otherParams = Object.fromEntries(Object.entries(params).filter(([k]) => k !== "page")) as Record<string, string>;

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Leave</h1>
          <p className="mt-1 text-sm text-muted">
            Balances for {financialYearLabel(fy)}. Weekends and company holidays inside a request cost nothing.
          </p>
        </div>
        {caps.manage && (
          <div className="flex flex-col items-end gap-1">
            <Link href="/people/holidays" className="text-sm text-brand hover:underline">
              Holiday calendar &amp; leave types →
            </Link>
            <Link href="/people/leave/opening" className="text-sm text-brand hover:underline">
              Opening balances →
            </Link>
          </div>
        )}
      </div>

      <div className="mt-5">
        <TabNav
          basePath="/people/leave"
          paramName="view"
          activeKey={view}
          otherParams={otherParams}
          tabs={[
            { key: "mine", label: "Mine" },
            { key: "short", label: "Short leave" },
            { key: "all", label: caps.manage || caps.viewAll ? "Everyone" : "My team" },
          ]}
        />
      </div>

      {/* The filter bar applies to whichever list is on screen. Person and team only appear on the
          company view, because narrowing your own requests by person is not a thing. */}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <SelectParamFilter
          paramName="status"
          label="Status"
          options={[
            { value: "PENDING", label: "Pending" },
            { value: "APPROVED", label: "Approved" },
            { value: "REJECTED", label: "Rejected" },
            { value: "CANCELLED", label: "Cancelled" },
          ]}
        />
        {view !== "short" && (
          <SelectParamFilter
            paramName="typeId"
            label="Type"
            options={leaveTypes.map((t) => ({ value: t.id, label: `${t.code} — ${t.name}` }))}
          />
        )}
        {(view === "all" || (view === "short" && (caps.manage || caps.viewAll))) && (
          <>
            <SelectParamFilter
              paramName="departmentId"
              label="Team"
              options={departments.map((d) => ({ value: d.id, label: d.name }))}
            />
            <SelectParamFilter
              paramName="userId"
              label="Person"
              options={people.map((p) => ({ value: p.id, label: p.name }))}
            />
          </>
        )}
        <DateFilter paramName="from" label="From" value={params.from} />
        <DateFilter paramName="to" label="To" value={params.to} />
      </div>

      <div className="mt-5">
        {view === "short" ? (
          shortLeave && shortRegister ? (
            <div className="space-y-5">
              <ShortLeavePanel overview={shortLeave} />
              <div>
                <h2 className="mb-2 text-sm font-medium text-text">
                  {shortRegister.everyone ? "Everyone's short leave" : "Short leave — yours and your team's"}
                </h2>
                <ShortLeaveRegister rows={shortRegister.rows} total={shortRegister.total} />
                <Pagination
                  page={page}
                  pageSize={pageSize}
                  total={shortRegister.total}
                  totalPages={totalPages(shortRegister.total, pageSize)}
                  pageSizes={PAGE_SIZES}
                />
              </div>
            </div>
          ) : (
            <p className="text-sm text-subtle">Short leave isn&apos;t set up in this workspace yet — its tables come with the next update.</p>
          )
        ) : view === "all" ? (
          <>
            <LeaveRegister rows={register.rows} total={register.total} />
            <Pagination
              page={page}
              pageSize={pageSize}
              total={register.total}
              totalPages={totalPages(register.total, pageSize)}
              pageSizes={PAGE_SIZES}
            />
          </>
        ) : (
          <div className="space-y-5">
            <LeaveWorkspace
              balances={balances}
              mine={mine}
              queue={queue}
              upcoming={upcoming}
              leaveTypes={leaveTypes.map((t) => ({ id: t.id, name: t.name, code: t.code, paid: t.paid }))}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A date filter that navigates on change.
 *
 * Server-rendered as a plain input with a form around it rather than another client component —
 * there are already two filter primitives in this codebase and a third for one date field would be
 * a worse trade than five lines of form.
 */
function DateFilter({ paramName, label, value }: { paramName: string; label: string; value?: string }) {
  return (
    <form className="flex items-end gap-1.5">
      <div className="space-y-1">
        <Label htmlFor={paramName} className="text-xs">
          {label}
        </Label>
        <Input
          id={paramName}
          name={paramName}
          type="date"
          defaultValue={value ?? ""}
          className="h-9 w-40 text-sm"
        />
      </div>
      <button type="submit" className="mb-1 rounded-base border border-line px-2 py-1 text-xs text-muted hover:text-text">
        Apply
      </button>
    </form>
  );
}
