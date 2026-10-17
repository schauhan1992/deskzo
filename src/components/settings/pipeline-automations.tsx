"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ManagedAutomation } from "@/actions/pipeline-automations";
import type { ManagedStage } from "@/actions/pipeline";
import { createPipelineWorkflow } from "@/actions/automate";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { describeAction } from "@/lib/pipeline/automation-rules";
import { workflowPath, workflowRef } from "@/lib/automate/refs";

/**
 * A pipeline's automations, now that they are workflows in Deskzo Automate (owner, 17 Oct 2026): what
 * each one did, in plain words, and a link to the workflow it became, where it is changed. A new one
 * starts as a workflow for this pipeline — "when a lead arrives", or "when it enters a stage".
 */
export function PipelineAutomations({
  pipelineId,
  stages,
  automations,
  people,
  ready,
  canAutomate,
}: {
  pipelineId: string;
  stages: ManagedStage[];
  automations: ManagedAutomation[];
  people: { id: string; name: string }[];
  ready: boolean;
  canAutomate: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [stageId, setStageId] = useState("");
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? "someone no longer here";
  const stageName = (id: string | null) => stages.find((s) => s.id === id)?.label ?? "a retired stage";

  if (!ready) return <p className="text-sm text-muted">This workspace is still being updated. Try again in a minute.</p>;

  const start = () =>
    startTransition(async () => {
      setError(null);
      const made = await createPipelineWorkflow(pipelineId, stageId || null);
      if (made.ok) router.push(made.data.path);
      else setError(made.error);
    });

  return (
    <div className="space-y-3">
      {automations.length > 0 && (
        <div className="space-y-2">
          {automations.map((a) => (
            <Card key={a.id}>
              <CardContent className="space-y-1 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium text-text">
                    {a.name}{" "}
                    <span className="font-normal text-muted">— when {a.trigger === "LEAD_CREATED" ? "a lead arrives" : `a lead enters ${stageName(a.stageId)}`}</span>
                  </p>
                  {a.workflow ? (
                    canAutomate ? (
                      <Link href={workflowPath(a.workflow.seq)} className="text-xs font-medium text-brand hover:underline">
                        Open {workflowRef(a.workflow.seq)} in Automate →
                      </Link>
                    ) : (
                      <span className="text-xs text-muted">Now {workflowRef(a.workflow.seq)} in Automate</span>
                    )
                  ) : (
                    <Badge>Moving to Automate</Badge>
                  )}
                </div>
                <ul className="list-disc pl-5 text-xs text-muted">
                  {a.actions.map((action, i) => (
                    <li key={i}>{describeAction(action, nameOf)}</li>
                  ))}
                </ul>
                {a.workflow && a.workflow.status !== "ACTIVE" && <p className="text-xs text-subtle">Off in Automate.</p>}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {canAutomate ? (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={stageId} onChange={(e) => setStageId(e.target.value)} className="w-auto">
            <option value="">When a lead arrives</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                When a lead enters {s.label}
              </option>
            ))}
          </Select>
          <Button type="button" size="sm" variant="secondary" disabled={isPending} onClick={start}>
            New workflow for this
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted">Automations are workflows in Automate now; a workspace admin makes and changes them there.</p>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
