import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import {
  attendanceExceptionCandidates,
  attendanceExceptionHistory,
  attendanceExceptionQueue,
  canApproveAttendanceExceptions,
} from "@/actions/attendance-exceptions";
import { AttendanceExceptions } from "@/components/hr/attendance-exceptions";
import { SelectParamFilter } from "@/components/ui/select-param-filter";

/**
 * People › Attendance exceptions (owner, 22 Oct 2026): requests to clock in or out away from the office's GPS area,
 * granting one, and the record of every one — for whoever holds "Approve attendance location exceptions".
 */
export default async function AttendanceExceptionsPage({ searchParams }: { searchParams: Promise<{ status?: string; userId?: string }> }) {
  const enabled = await isModuleEnabled("hr");
  if (!enabled) return <ModuleDisabledNotice moduleKey="hr" />;
  if (!(await canApproveAttendanceExceptions())) notFound();

  const params = await searchParams;
  const [queue, history, people] = await Promise.all([
    attendanceExceptionQueue(),
    attendanceExceptionHistory({ status: params.status || undefined, userId: params.userId || undefined }),
    attendanceExceptionCandidates(),
  ]);

  return (
    <div className="animate-fade-rise">
      <h1 className="text-xl font-semibold text-text">Attendance exceptions</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Where an office checks location, somebody outside its area — or whose GPS won&apos;t settle — can&apos;t clock in or out without an exception.
        Approve their request or grant one; each allows one clock-in and one clock-out, and every clocking it allows is marked as such in
        attendance. Offices&apos; areas are set in Settings › People › Attendance locations.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SelectParamFilter
          paramName="status"
          label="History"
          allLabel="Every status"
          options={[
            { value: "PENDING", label: "Awaiting decision" },
            { value: "APPROVED", label: "Approved" },
            { value: "REJECTED", label: "Refused" },
            { value: "REVOKED", label: "Revoked or withdrawn" },
          ]}
        />
        <SelectParamFilter paramName="userId" label="Person" options={people.map((p) => ({ value: p.id, label: p.name }))} />
      </div>
      <div className="mt-5">
        <AttendanceExceptions queue={queue} history={history} people={people} />
      </div>
    </div>
  );
}
