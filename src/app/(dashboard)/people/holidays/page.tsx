import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { hrCapabilities, listHolidays, listLeaveTypes } from "@/actions/hr";
import { HrSettings } from "@/components/hr/hr-settings";
import { HolidayList } from "@/components/hr/holiday-list";
import { workspaceClock } from "@/lib/time/workspace";

export default async function HolidaysPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const enabled = await isModuleEnabled("hr");
  if (!enabled) return <ModuleDisabledNotice moduleKey="hr" />;

  const params = await searchParams;
  const year = Number(params.year) || (await workspaceClock()).parts(new Date()).year;

  const [caps, holidays, leaveTypes] = await Promise.all([
    hrCapabilities(),
    listHolidays(year),
    listLeaveTypes(true),
  ]);

  return (
    <div className="animate-fade-rise">
      <Link href="/people/leave" className="text-sm text-muted hover:text-text">
        ← Leave
      </Link>
      <div className="mt-2">
        <h1 className="text-xl font-semibold text-text">
          {caps.manage ? "Holidays & leave types" : "Holiday calendar"}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {caps.manage
            ? "What the company closes for, and what people may take. Both feed every leave calculation, so a change here changes what future requests cost."
            : "When the office is closed. A holiday inside a leave request costs you nothing; a restricted one is a normal working day, so taking it costs a day of leave."}
        </p>
      </div>

      <div className="mt-5 flex items-center gap-2 text-sm">
        {[year - 1, year, year + 1].map((y) => (
          <Link
            key={y}
            href={`/people/holidays?year=${y}`}
            className={`rounded-base border px-2.5 py-1 ${
              y === year ? "border-brand bg-brand-subtle text-brand" : "border-line text-muted hover:text-text"
            }`}
          >
            {y}
          </Link>
        ))}
      </div>

      <div className="mt-4">
        {/* Everyone can read the calendar — "when is the next holiday" is the most-asked HR
            question and there was never a reason to hide the answer. Editing is still HR's. */}
        {caps.manage ? (
          <HrSettings holidays={holidays} leaveTypes={leaveTypes} year={year} />
        ) : (
          <HolidayList holidays={holidays} leaveTypes={leaveTypes} year={year} />
        )}
      </div>
    </div>
  );
}
