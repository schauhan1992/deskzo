import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { automateSwitches, getDraftingAvailability, listAutomationWorkflows } from "@/actions/automate";
import { DescribeWorkflowButton } from "@/components/automate/describe-workflow";
import { ImportWorkflowButton } from "@/components/automate/import-workflow";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/automate/status-badge";
import { NewWorkflowButton, WorkflowControls, WorkspacePauseSwitch } from "@/components/automate/automate-controls";
import { triggerByType } from "@/lib/automate/triggers";
import { runPath, runRef, workflowPath, workflowRef } from "@/lib/automate/refs";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * Automate › Workflows: each workflow, whether it is on, what starts it, who it runs as, and how its
 * last run went — with pause, switch on and run now, and the workspace's kill switch. A name opens it
 * in the builder (Phase 3); a new one starts empty or from a template.
 */
export default async function AutomateWorkflowsPage() {
  if (!(await isModuleEnabled("automate"))) return <ModuleDisabledNotice moduleKey="automate" />;

  let data;
  try {
    data = await Promise.all([listAutomationWorkflows(), automateSwitches(), workspaceClock(), getDraftingAvailability()]);
  } catch (err) {
    if (notMigratedYet(err)) return <NotReady />;
    throw err;
  }
  const [workflows, switches, clock, drafting] = data;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Workflows</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Work that runs on its own — on a schedule, when something happens, or when somebody presses Run — as the person who owns it, with every run recorded.
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <Link href="/automate/templates" className="inline-flex h-8 items-center rounded-base border border-line-strong bg-surface px-3 text-[13px] font-medium text-text shadow-sm hover:bg-surface-sunken">
            From a template
          </Link>
          <DescribeWorkflowButton availability={drafting} />
          <ImportWorkflowButton />
          <NewWorkflowButton />
          <WorkspacePauseSwitch paused={switches.workspacePaused} />
        </div>
      </div>

      {switches.platformPaused && (
        <p className="rounded-base bg-warning-bg px-3 py-2 text-sm text-warning">Deskzo has paused every workflow for now. Runs keep their place and carry on when it is lifted.</p>
      )}
      {switches.workspacePaused && (
        <p className="rounded-base bg-warning-bg px-3 py-2 text-sm text-warning">
          Every workflow in this workspace is paused{switches.pausedAt ? ` since ${clock.dateTimeShort(switches.pausedAt)}` : ""}. Nothing starts or moves on until you let them run again.
        </p>
      )}

      <Card className="overflow-x-auto p-0">
        {workflows.length === 0 ? (
          <p className="p-6 text-sm text-muted">
            No workflows yet.{" "}
            <Link href="/automate/templates" className="text-brand hover:underline">
              Start from a template
            </Link>{" "}
            or make a new one.
          </p>
        ) : (
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs font-medium text-muted">
              <tr>
                <th className="px-4 py-2">Workflow</th>
                <th className="px-4 py-2">State</th>
                <th className="px-4 py-2">Starts</th>
                <th className="px-4 py-2">Runs as</th>
                <th className="px-4 py-2">Last run</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {workflows.map((w) => (
                <tr key={w.id} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-3">
                    <Link href={workflowPath(w.seq)} className="font-medium text-text hover:underline">
                      {w.name}
                    </Link>
                    <span className="ml-1.5 text-xs text-subtle">
                      {workflowRef(w.seq)}
                      {w.version !== null ? ` · v${w.version}` : ""}
                      {w.source === "MIGRATED" ? " · from a pipeline" : ""}
                    </span>
                    {w.description && <span className="block text-xs text-muted">{w.description}</span>}
                    {w.pausedReason && <span className="mt-1 block text-xs text-warning">{w.pausedReason}</span>}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={w.status} />
                    {w.failureStreak > 0 && <span className="mt-1 block text-xs text-danger">{w.failureStreak} failed in a row</span>}
                  </td>
                  <td className="px-4 py-3 text-muted">{w.trigger ? (triggerByType(w.trigger)?.label ?? w.trigger) : "Not published"}</td>
                  <td className="px-4 py-3 text-muted">{w.ownerName}</td>
                  <td className="px-4 py-3">
                    {w.lastRun ? (
                      <Link href={runPath(w.lastRun.seq)} className="inline-flex items-center gap-1.5 hover:underline">
                        <StatusBadge status={w.lastRun.status} />
                        <span className="text-xs text-muted">
                          {runRef(w.lastRun.seq)} · {clock.dateTimeShort(w.lastRun.at)}
                        </span>
                      </Link>
                    ) : (
                      <span className="text-xs text-subtle">None yet</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <WorkflowControls id={w.id} status={w.status} trigger={w.trigger} published={w.version !== null} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <p className="text-xs text-subtle">
        <Link href="/automate/runs" className="hover:underline">
          Every run →
        </Link>
      </p>
    </div>
  );
}

function NotReady() {
  return (
    <div className="max-w-md">
      <h1 className="text-xl font-semibold text-text">Workflows</h1>
      <p className="mt-2 text-sm text-muted">Automate is still being set up for this workspace. It will be here after the next update.</p>
    </div>
  );
}
