import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { hrCapabilities, listDepartmentOptions, listPeople } from "@/actions/hr";
import { Card } from "@/components/ui/card";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { PeopleTable } from "@/components/hr/people-table";
import { employmentTypeLabels, employmentTypeValues } from "@/lib/validation/hr";

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; departmentId?: string; employmentType?: string; status?: string }>;
}) {
  const enabled = await isModuleEnabled("hr");
  if (!enabled) return <ModuleDisabledNotice moduleKey="hr" />;

  const params = await searchParams;
  const [people, departments, caps] = await Promise.all([
    listPeople(params),
    listDepartmentOptions(),
    hrCapabilities(),
  ]);

  const headcount = people.filter((p) => p.active && !p.employeeProfile?.exitedOn).length;
  const missingRecord = people.filter((p) => p.active && !p.employeeProfile).length;

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">People</h1>
          <p className="mt-1 text-sm text-muted">
            {caps.manage || caps.viewAll
              ? "Everyone on the payroll, their employment terms, and the records HR keeps."
              : "You and the people who report to you."}
          </p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Headcount" value={headcount} hint="active, not exited" />
        <Stat label="Listed here" value={people.length} hint="matching this filter" />
        <Stat
          label="No HR record"
          value={missingRecord}
          hint={missingRecord > 0 ? "a login with no employment details" : "every active login has one"}
        />
        <Stat label="Teams" value={departments.length} hint="departments on file" />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="search" placeholder="Name, email, code or designation" className="w-72" />
        <SelectParamFilter
          paramName="departmentId"
          label="Team"
          options={departments.map((d) => ({ value: d.id, label: d.name }))}
        />
        <SelectParamFilter
          paramName="employmentType"
          label="Type"
          options={employmentTypeValues.map((t) => ({ value: t, label: employmentTypeLabels[t] }))}
        />
        <SelectParamFilter
          paramName="status"
          label="Status"
          allLabel="Active"
          options={[
            { value: "all", label: "Everyone" },
            { value: "exited", label: "Exited" },
          ]}
        />
      </div>

      <div className="mt-4">
        <PeopleTable people={people} />
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className="mt-1 text-lg font-semibold text-text">{value.toLocaleString("en-IN")}</div>
      <div className="mt-0.5 text-xs text-muted">{hint}</div>
    </Card>
  );
}
