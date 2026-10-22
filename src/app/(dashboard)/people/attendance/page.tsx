import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { attendanceMonth, myPunches, myToday } from "@/actions/attendance";
import { hrCapabilities, listPeople } from "@/actions/hr";
import { listDepartmentOptions } from "@/actions/department";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { AttendanceGrid } from "@/components/hr/attendance-grid";
import { MyPunches } from "@/components/hr/my-punches";
import { monthLabel } from "@/lib/hr/calendar";
import { workspaceClock } from "@/lib/time/workspace";

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{
    month?: string;
    year?: string;
    userId?: string;
    departmentId?: string;
    search?: string;
    flag?: string;
  }>;
}) {
  const enabled = await isModuleEnabled("hr");
  if (!enabled) return <ModuleDisabledNotice moduleKey="hr" />;

  const params = await searchParams;
  // This month in the workspace's zone — UTC's was last month until 05:30 IST on the 1st.
  const now = (await workspaceClock()).parts(new Date());
  const month = Math.min(12, Math.max(1, Number(params.month) || now.month + 1));
  const year = Math.min(2100, Math.max(2000, Number(params.year) || now.year));

  const [data, today, caps, departments, people, punches] = await Promise.all([
    attendanceMonth({
      year,
      month,
      userId: params.userId,
      departmentId: params.departmentId,
      search: params.search,
      flag: params.flag,
    }),
    myToday(),
    hrCapabilities(),
    listDepartmentOptions(),
    listPeople({ status: "active" }),
    myPunches({ year, month }),
  ]);
  const filtered = data.rows.length !== data.totalPeople;
  // Somebody who sees only themselves gets their own page: no team or person to pick, their in and out first.
  const own = data.scope === "self";
  const visible = data.visibleIds ? new Set(data.visibleIds) : null;
  const pickable = visible ? people.filter((p) => visible.has(p.id)) : people;

  return (
    <div className="animate-fade-rise">
      <div>
        <h1 className="text-xl font-semibold text-text">{own ? "My attendance" : "Manage attendance"}</h1>
        <p className="mt-1 text-sm text-muted">
          {own
            ? `${monthLabel(month, year)}. When you came in and left each day, and the hours in between.`
            : `${monthLabel(month, year)}. A dashed square is a working day nobody has recorded — not an absence.`}
          {!own && filtered && ` Showing ${data.rows.length} of ${data.totalPeople}.`}
        </p>
      </div>

      {own && (
        <div className="mt-5">
          <MyPunches days={punches} year={year} month={month} />
        </div>
      )}

      {!own && (
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="search" placeholder="Name or employee code" className="w-60" />
        <SelectParamFilter
          paramName="departmentId"
          label="Team"
          options={departments.map((d) => ({ value: d.id, label: d.name }))}
        />
        <SelectParamFilter
          paramName="userId"
          label="Person"
          options={pickable.map((p) => ({ value: p.id, label: p.name }))}
        />
        {/* The reason anybody opens this screen on the 1st of the month. */}
        <SelectParamFilter
          paramName="flag"
          label="Show"
          allLabel="Everyone"
          options={[
            { value: "absent", label: "Had an absence" },
            { value: "unrecorded", label: "Days not recorded" },
            { value: "leave", label: "Took leave" },
          ]}
        />
      </div>
      )}

      <div className="mt-4">
        <AttendanceGrid month={data} today={today} canMark={caps.manage || caps.viewAll} year={year} monthNumber={month} canSetHours={caps.manage} />
      </div>

      {/* Whoever sees more than themselves still has their own days — below the team's. */}
      {!own && (
        <div className="mt-6">
          <MyPunches days={punches} year={year} month={month} />
        </div>
      )}
    </div>
  );
}
