import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { listAutomationRuns } from "@/actions/automate";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Card } from "@/components/ui/card";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { StatusBadge } from "@/components/automate/status-badge";
import { runPath, runRef } from "@/lib/automate/refs";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspaceClock } from "@/lib/time/workspace";

/** Automate › Runs (Phase 1): the latest 200 runs, newest first, filtered by state or workflow. */
export default async function AutomateRunsPage({ searchParams }: { searchParams: Promise<{ status?: string; workflow?: string }> }) {
  if (!(await isModuleEnabled("automate"))) return <ModuleDisabledNotice moduleKey="automate" />;
  const params = await searchParams;

  let data;
  try {
    data = await Promise.all([listAutomationRuns({ status: params.status, workflowId: params.workflow }), workspaceClock()]);
  } catch (err) {
    if (notMigratedYet(err)) return <p className="text-sm text-muted">Automate is still being set up for this workspace.</p>;
    throw err;
  }
  const [runs, clock] = data;
  const took = (from: Date | null, to: Date | null) => {
    if (!from || !to) return "—";
    const s = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
    return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-text">Runs</h1>
        <p className="mt-1 text-sm text-muted">Every time a workflow ran, and how each one went. Open a run for its steps.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SelectParamFilter
          paramName="status"
          label="State"
          allLabel="Any"
          options={[
            { value: "FAILED", label: "Failed" },
            { value: "NEEDS_ATTENTION", label: "Needs a decision" },
            { value: "RUNNING", label: "Running" },
            { value: "WAITING", label: "Waiting" },
            { value: "QUEUED", label: "Queued" },
            { value: "SUCCEEDED", label: "Succeeded" },
            { value: "CANCELLED", label: "Cancelled" },
          ]}
        />
        {params.workflow && (
          <Link href="/automate/runs" className="text-xs text-muted hover:underline">
            Showing one workflow · show all
          </Link>
        )}
      </div>
      <Card className="overflow-x-auto p-0">
        {runs.length === 0 ? (
          <p className="p-6 text-sm text-muted">No runs{params.status || params.workflow ? " match" : " yet"}.</p>
        ) : (
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs font-medium text-muted">
              <tr>
                <th className="px-4 py-2">Run</th>
                <th className="px-4 py-2">Workflow</th>
                <th className="px-4 py-2">State</th>
                <th className="px-4 py-2">Started</th>
                <th className="px-4 py-2">Took</th>
                <th className="px-4 py-2">Steps</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-3">
                    <Link href={runPath(r.seq)} className="font-medium text-text hover:underline">
                      {runRef(r.seq)}
                    </Link>
                    {r.isTest && <span className="ml-1.5 text-xs text-subtle">test</span>}
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/automate/runs?workflow=${encodeURIComponent(r.workflowId)}`} className="text-muted hover:underline">
                      {r.workflowName}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={r.status} />
                    {r.status === "WAITING" && <span className="mt-1 block text-xs text-muted">until {clock.dateTimeShort(r.runAfter)}</span>}
                    {r.error && <span className="mt-1 block max-w-xs truncate text-xs text-danger" title={r.error}>{r.error}</span>}
                  </td>
                  <td className="px-4 py-3 text-muted">{clock.dateTimeShort(r.startedAt ?? r.createdAt)}</td>
                  <td className="px-4 py-3 text-muted">{took(r.startedAt, r.finishedAt)}</td>
                  <td className="px-4 py-3 text-muted">{r.stepsUsed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
