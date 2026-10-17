import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { getWorkflowForBuilder } from "@/actions/automate";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { WorkflowBuilder } from "@/components/automate/builder/workflow-builder";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * One workflow in the builder (Automate, Phase 3), at its number: /automate/workflows/WF-0042. Its
 * draft, edited as a list of steps; tested on a real record; published as the version that runs.
 */
export default async function AutomateWorkflowPage({ params }: { params: Promise<{ ref: string }> }) {
  if (!(await isModuleEnabled("automate"))) return <ModuleDisabledNotice moduleKey="automate" />;
  const { ref } = await params;
  let workflow;
  try {
    workflow = await getWorkflowForBuilder(decodeURIComponent(ref));
  } catch (err) {
    if (notMigratedYet(err)) notFound();
    throw err;
  }
  if (!workflow) notFound();
  return <WorkflowBuilder key={workflow.id} workflow={workflow} />;
}
