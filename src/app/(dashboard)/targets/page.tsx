import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listTargets, targetCapabilities, targetOptions } from "@/actions/target";
import { listSchemes } from "@/actions/incentive";
import { Card } from "@/components/ui/card";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { TargetCard } from "@/components/targets/target-card";
import { SetTargetsDialog } from "@/components/targets/set-targets-dialog";
import { METRICS, scopeLabels } from "@/lib/targets/metrics";
import type { TargetScope } from "@prisma/client";

export default async function TargetsPage({
  searchParams,
}: {
  searchParams: Promise<{ metric?: string; scope?: string; show?: string; departmentId?: string }>;
}) {
  const enabled = await isModuleEnabled("targets");
  if (!enabled) return <ModuleDisabledNotice moduleKey="targets" />;

  const params = await searchParams;
  const [targets, caps, options, schemes] = await Promise.all([
    listTargets(params),
    targetCapabilities(),
    targetOptions(),
    // Empty for anybody who may not manage incentives, which is what hides the picker.
    listSchemes(),
  ]);

  // Counted from the measured figures, so the summary can't disagree with the cards below it.
  const atRisk = targets.filter((t) => t.progress.status === "AT_RISK").length;
  const behind = targets.filter((t) => t.progress.status === "BEHIND").length;
  const met = targets.filter((t) => t.progress.status === "MET").length;
  const onTrack = targets.filter((t) => t.progress.status === "ON_TRACK" || t.progress.status === "AHEAD").length;

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Targets</h1>
          <p className="mt-1 text-sm text-muted">
            What people and teams have been asked to hit, against what actually happened. Nothing is stored except the
            target — the achievement is worked out from the records each time this page loads, so a cancelled invoice
            reduces it the moment it&apos;s cancelled.
          </p>
        </div>
        {caps.manage && <SetTargetsDialog options={options} />}
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Met" value={met} tone="success" hint="already there" />
        <Stat label="On track" value={onTrack} tone="success" hint="at or ahead of pace" />
        <Stat label="Behind" value={behind} tone="warning" hint="catchable with a good week" />
        <Stat label="At risk" value={atRisk} tone="danger" hint="well behind, past half way" />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <SelectParamFilter
          paramName="metric"
          label="Measure"
          options={METRICS.map((m) => ({ value: m.key, label: m.label }))}
        />
        <SelectParamFilter
          paramName="scope"
          label="Whose"
          options={(Object.keys(scopeLabels) as TargetScope[]).map((s) => ({ value: s, label: scopeLabels[s] }))}
        />
        <SelectParamFilter
          paramName="show"
          label="Period"
          allLabel="Current & upcoming"
          options={[
            { value: "past", label: "Finished" },
            { value: "all", label: "Everything" },
          ]}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        {targets.map((t) => (
          <TargetCard key={t.id} target={t} showWho schemes={caps.manage ? schemes : undefined} />
        ))}
      </div>

      {targets.length === 0 && (
        <Card className="mt-4 px-6 py-10 text-center text-sm text-subtle">
          No targets set for this period. A sales person&apos;s number, a caller&apos;s connections, a team&apos;s
          collections — whatever the team is actually judged on.
        </Card>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number;
  hint: string;
  tone: "success" | "warning" | "danger";
}) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div
        className={`mt-1 text-2xl font-semibold tabular-nums ${
          value === 0 ? "text-text" : tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : "text-danger"
        }`}
      >
        {value}
      </div>
      <div className="mt-0.5 text-xs text-muted">{hint}</div>
    </Card>
  );
}
