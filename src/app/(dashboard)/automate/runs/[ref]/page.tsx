import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { getAutomationRun } from "@/actions/automate";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/automate/status-badge";
import { RunControls } from "@/components/automate/automate-controls";
import { runRef } from "@/lib/automate/refs";
import { triggerByType } from "@/lib/automate/triggers";
import { workspaceClock } from "@/lib/time/workspace";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * One run (Automate, Phase 1): what started it, how it ended, and every try of every step — when, how
 * long, what went in and came out (redacted summaries, never the full values), and what went wrong.
 * Cancel, and retry from the failed step, are here.
 */
export default async function AutomateRunPage({ params }: { params: Promise<{ ref: string }> }) {
  if (!(await isModuleEnabled("automate"))) return <ModuleDisabledNotice moduleKey="automate" />;
  const { ref } = await params;
  let found;
  try {
    found = await Promise.all([getAutomationRun(decodeURIComponent(ref)), workspaceClock()]);
  } catch (err) {
    if (notMigratedYet(err)) notFound();
    throw err;
  }
  const [run, clock] = found;
  if (!run) notFound();

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-muted">
            <Link href="/automate/runs" className="hover:underline">
              Runs
            </Link>{" "}
            ›{" "}
            <Link href={`/automate/runs?workflow=${encodeURIComponent(run.workflowId)}`} className="hover:underline">
              {run.workflowName}
            </Link>
          </p>
          <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold text-text">
            {runRef(run.seq)} <StatusBadge status={run.status} />
          </h1>
          <p className="mt-1 text-sm text-muted">
            Version {run.version} · {triggerByType(run.trigger)?.label ?? run.trigger} · created {clock.dateTimeShort(run.createdAt)}
            {run.finishedAt ? ` · finished ${clock.dateTimeShort(run.finishedAt)}` : ""}
            {run.status === "WAITING" ? ` · waiting until ${clock.dateTimeShort(run.runAfter)}` : ""}
            {` · ${run.stepsUsed} step${run.stepsUsed === 1 ? "" : "s"} counted`}
          </p>
          {run.error && <p className="mt-2 rounded-base bg-danger-bg px-3 py-2 text-sm text-danger">{run.error}</p>}
        </div>
        <RunControls id={run.id} status={run.status} />
      </div>

      <Card className="overflow-x-auto p-0">
        {run.steps.length === 0 ? (
          <p className="p-6 text-sm text-muted">No step has run yet.</p>
        ) : (
          <table className="w-full min-w-[860px] text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs font-medium text-muted">
              <tr>
                <th className="px-4 py-2">Step</th>
                <th className="px-4 py-2">State</th>
                <th className="px-4 py-2">Started</th>
                <th className="px-4 py-2">Took</th>
                <th className="px-4 py-2">In</th>
                <th className="px-4 py-2">Out</th>
              </tr>
            </thead>
            <tbody>
              {run.steps.map((s) => (
                <tr key={s.id} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-3">
                    <span className="font-medium text-text">{s.stepId}</span>
                    <span className="block text-xs text-muted">
                      {s.type}
                      {s.attempt > 1 ? ` · try ${s.attempt}` : ""}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={s.status} />
                    {s.error && <span className="mt-1 block max-w-xs text-xs text-danger">{s.error}</span>}
                    {s.retryAt && <span className="mt-1 block text-xs text-muted">tried again at {clock.dateTimeShort(s.retryAt)}</span>}
                  </td>
                  <td className="px-4 py-3 text-muted">{clock.dateTimeShort(s.startedAt)}</td>
                  <td className="px-4 py-3 text-muted">{s.durationMs === null ? "—" : s.durationMs < 1000 ? `${s.durationMs} ms` : `${(s.durationMs / 1000).toFixed(1)} s`}</td>
                  <td className="px-4 py-3">
                    <Summary value={s.input} />
                  </td>
                  <td className="px-4 py-3">
                    <Summary value={s.output} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Summary({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-xs text-subtle">—</span>;
  return <pre className="max-w-[18rem] overflow-x-auto whitespace-pre-wrap break-words text-xs text-muted">{JSON.stringify(value, null, 2)}</pre>;
}
