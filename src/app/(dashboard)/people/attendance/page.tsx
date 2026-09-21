import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { attendanceMonth, myToday } from "@/actions/attendance";
import { hrCapabilities, listDepartmentOptions, listPeople } from "@/actions/hr";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { AttendanceGrid } from "@/components/hr/attendance-grid";
import { monthLabel } from "@/lib/hr/calendar";

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
  const now = new Date();
  const month = Math.min(12, Math.max(1, Number(params.month) || now.getUTCMonth() + 1));
  const year = Math.min(2100, Math.max(2000, Number(params.year) || now.getUTCFullYear()));

  const [data, today, caps, departments, people] = await Promise.all([
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
  ]);
  const filtered = data.rows.length !== data.totalPeople;

  const prev = month === 1 ? { month: 12, year: year - 1 } : { month: month - 1, year };
  const next = month === 12 ? { month: 1, year: year + 1 } : { month: month + 1, year };

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Attendance</h1>
          <p className="mt-1 text-sm text-muted">
            {monthLabel(month, year)}. A blank square is a working day nobody has recorded — not an absence.
          {filtered && ` Showing ${data.rows.length} of ${data.totalPeople}.`}
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Link
            href={`/people/attendance?month=${prev.month}&year=${prev.year}`}
            className="rounded-base border border-line px-2.5 py-1 text-muted hover:text-text"
          >
            ← {monthLabel(prev.month, prev.year)}
          </Link>
          <Link
            href={`/people/attendance?month=${next.month}&year=${next.year}`}
            className="rounded-base border border-line px-2.5 py-1 text-muted hover:text-text"
          >
            {monthLabel(next.month, next.year)} →
          </Link>
        </div>
      </div>

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
          options={people.map((p) => ({ value: p.id, label: p.name }))}
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

      <div className="mt-4">
        <AttendanceGrid month={data} today={today} canMark={caps.manage || caps.viewAll} />
      </div>
    </div>
  );
}
