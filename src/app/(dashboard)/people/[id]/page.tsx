import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getPerson, hrCapabilities, hrTasksFor, personChecklist } from "@/actions/hr";
import { leaveBalances } from "@/actions/leave";
import { salaryHistory } from "@/actions/payroll";
import { listEmployeeDocuments, listEmployeeLetters, listEmploymentHistory } from "@/actions/employee-docs";
import { EmployeeFile } from "@/components/hr/employee-file";
import { availableLetters } from "@/lib/hr/letters";
import { serviceYears } from "@/lib/hr/settlement";
import { SalaryCard } from "@/components/hr/salary-card";
import { EmployeeRecord } from "@/components/hr/employee-record";
import { HrChecklist } from "@/components/hr/hr-checklist";
import { HrTasks } from "@/components/hr/hr-tasks";
import { handoverHistory } from "@/actions/handover";
import { HandoverHistory } from "@/components/people/handover-history";

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const enabled = await isModuleEnabled("hr");
  if (!enabled) return <ModuleDisabledNotice moduleKey="hr" />;

  const { id } = await params;
  const [person, caps] = await Promise.all([getPerson(id), hrCapabilities()]);
  if (!person) notFound();

  const [balances, structures, documents, history, letters, checklist, tasks, handovers] = await Promise.all([
    leaveBalances(id),
    salaryHistory(id),
    listEmployeeDocuments(id),
    listEmploymentHistory(id),
    listEmployeeLetters(id),
    personChecklist(id),
    hrTasksFor(id),
    handoverHistory(id),
  ]);

  const profile = person.employeeProfile;
  const letterOptions = availableLetters({
    joinedOn: profile?.joinedOn ?? null,
    confirmedOn: profile?.confirmedOn ?? null,
    exitedOn: profile?.exitedOn ?? null,
    employmentType: profile?.employmentType ?? null,
    // Passed so a gratuity statement isn't offered to somebody the Act doesn't cover — the same
    // rounding the settlement uses, rather than a second opinion about how long they were here.
    serviceYears:
      profile?.joinedOn && profile.exitedOn ? serviceYears(profile.joinedOn, profile.exitedOn) : 0,
  });

  return (
    <div className="animate-fade-rise">
      <Link href="/people" className="text-sm text-muted hover:text-text">
        ← People
      </Link>
      <div className="mt-3">
        <EmployeeRecord
          person={person}
          balances={balances}
          canManage={caps.manage}
          canHandOver={caps.handover}
          isSelf={caps.userId === person.id}
        />
      </div>

      {/* Pay sits behind its own permission, so the card only renders for payroll or for the
          person themselves — and salaryHistory returns nothing to anybody else regardless. */}
      {(caps.payroll || caps.userId === person.id) && structures.length >= 0 && (
        <div className="mt-5 max-w-md">
          <SalaryCard userId={person.id} name={person.name} structures={structures} canEdit={caps.payroll} />
        </div>
      )}

      {profile?.exitedOn && (caps.payroll || caps.userId === person.id) && (
        <div className="mt-5">
          <Link
            href={`/people/${person.id}/settlement`}
            className="inline-block rounded-base border border-line px-3 py-2 text-sm text-brand hover:underline"
          >
            Full &amp; final settlement →
          </Link>
        </div>
      )}

      {(handovers.length > 0 || caps.handover) && (
        <div className="mt-5 max-w-2xl">
          <HandoverHistory
            entries={handovers}
            personId={person.id}
            personName={person.name}
            canHandOver={caps.handover && caps.userId !== person.id}
          />
        </div>
      )}

      {/* Onboarding while they are here, offboarding once an exit is recorded — the same card, because
          it is the same question at two ends of the same employment. HR only: it reads as a list of
          what the company still owes the employee and vice versa, not as a to-do for them. */}
      {checklist && caps.manage && (
        <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <HrChecklist
            title={checklist.stage === "OFFBOARDING" ? "Offboarding" : "Onboarding"}
            subtitle={
              checklist.stage === "OFFBOARDING"
                ? "What still has to happen before this employment is properly closed."
                : "What is still missing before the machine works properly for them."
            }
            items={checklist.items}
          />
          <HrTasks
            userId={person.id}
            tasks={tasks}
            canManage={caps.manage}
            hasExited={Boolean(profile?.exitedOn)}
          />
        </div>
      )}

      <div className="mt-5">
        <EmployeeFile
          userId={person.id}
          userName={person.name}
          documents={documents}
          history={history}
          letters={letters}
          canManage={caps.manage}
          letterOptions={letterOptions}
        />
      </div>
    </div>
  );
}
