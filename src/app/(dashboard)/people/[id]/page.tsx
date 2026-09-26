import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { db } from "@/lib/db";
import { canonicalise, parseRecordRef } from "@/lib/record-url";
import { formatUserId } from "@/lib/order-id";
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
import { isModuleEntitled } from "@/lib/modules-access";

export default async function PersonPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const enabled = await isModuleEnabled("hr");
  if (!enabled) return <ModuleDisabledNotice moduleKey="hr" />;

  const [{ id }, query] = await Promise.all([params, searchParams]);
  /**
   * The sequence resolves to the cuid before the action runs, so every check that action already
   * made still happens — this translates the reference, it does not bypass anything. A sequence
   * matching nothing falls through as the original segment and the action answers null, which is
   * the same refusal a bad cuid gets.
   */
  const ref = parseRecordRef(id);
  const resolved =
    ref.kind === "seq"
      ? ((await db.user.findUnique({ where: { userSeq: ref.seq }, select: { id: true } }))?.id ?? id)
      : ref.id;

  const [person, caps] = await Promise.all([getPerson(resolved), hrCapabilities()]);
  if (!person) notFound();

  // After the check, never before — see `canonicalise`.
  canonicalise(id, "/people", formatUserId(person.userSeq), query);

  /**
   * `person.id`, not `id`.
   *
   * `id` is whatever is in the URL, and for this route the canonical form is the sequence — so on
   * `/people/USR-000001` these eight were each handed the string "USR-000001" as a user id. Most
   * answered empty, which looks like a person with no documents and no leave rather than a bug;
   * `leaveBalances` opens the year's balance on first read, so it tried to *write* a row against
   * that string and the page died on a foreign-key violation.
   */
  // Salary is the payroll module's: a plan without it shows no salary card, and asks for none.
  const payrollInPlan = await isModuleEntitled("payroll");
  const [balances, structures, documents, history, letters, checklist, tasks, handovers] = await Promise.all([
    leaveBalances(person.id),
    payrollInPlan ? salaryHistory(person.id) : Promise.resolve([]),
    listEmployeeDocuments(person.id),
    listEmploymentHistory(person.id),
    listEmployeeLetters(person.id),
    personChecklist(person.id),
    hrTasksFor(person.id),
    handoverHistory(person.id),
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
      {payrollInPlan && (caps.payroll || caps.userId === person.id) && (
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
