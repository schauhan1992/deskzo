import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { hrCapabilities } from "@/actions/hr";
import { listDepartmentOptions, listManagerOptions } from "@/actions/department";
import { listCandidates } from "@/actions/candidate";
import { Card } from "@/components/ui/card";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { HiringBoard } from "@/components/hr/hiring-board";
import { candidateStatusLabels } from "@/lib/hr/onboarding";

export default async function HiringPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; search?: string }>;
}) {
  const enabled = await isModuleEnabled("hr");
  if (!enabled) return <ModuleDisabledNotice moduleKey="hr" />;

  const caps = await hrCapabilities();
  if (!caps.manage) {
    return (
      <Card className="px-6 py-10 text-center text-sm text-muted">
        Hiring is HR&apos;s. Offers, salaries and candidates&apos; personal details sit behind the same permission as
        the rest of the personnel file.
      </Card>
    );
  }

  const params = await searchParams;
  const [candidates, departments, managers] = await Promise.all([
    listCandidates(params),
    listDepartmentOptions(),
    listManagerOptions(),
  ]);

  const accepted = candidates.filter((c) => c.status === "ACCEPTED");
  // The number HR is actually chasing: accepted offers whose intake form has not come back.
  const awaitingDetails = candidates.filter((c) => c.status !== "PROSPECT" && !c.intakeSubmittedAt).length;
  // One reading of the clock, taken once rather than per candidate.
  const cutoff = new Date().getTime() + 30 * 86400000;
  const joiningSoon = accepted.filter(
    (c) => c.expectedJoining && new Date(c.expectedJoining).getTime() < cutoff,
  ).length;

  return (
    <div className="animate-fade-rise">
      <div>
        <h1 className="text-xl font-semibold text-text">Hiring</h1>
        <p className="mt-1 text-sm text-muted">
          Everyone offered a job but not yet on the payroll. Nobody here has a login — an account is created at the
          moment they are converted, which is also when their details, documents and offer letter move onto a real
          employee record.
        </p>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="In the pipeline" value={candidates.length} hint="matching this filter" />
        <Stat label="Offers accepted" value={accepted.length} hint="waiting to be converted" />
        <Stat label="Joining within 30 days" value={joiningSoon} hint="prepare their setup now" />
        <Stat
          label="Details outstanding"
          value={awaitingDetails}
          hint={awaitingDetails > 0 ? "chase the intake form" : "every offer has its form back"}
        />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="search" placeholder="Name, email or role" className="w-72" />
        <SelectParamFilter
          paramName="status"
          label="Status"
          allLabel="Live only"
          options={Object.entries(candidateStatusLabels).map(([value, label]) => ({ value, label }))}
        />
      </div>

      <div className="mt-4">
        <HiringBoard candidates={candidates} departments={departments} managers={managers} />
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-text">{value}</div>
      <div className="mt-0.5 text-xs text-muted">{hint}</div>
    </Card>
  );
}
