"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp } from "lucide-react";
import { deletePipeline, movePipeline, restorePipeline, retirePipeline, savePipeline, type ManagedPipeline, type ManagedStage } from "@/actions/pipeline";
import type { ManagedAutomation } from "@/actions/pipeline-automations";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { PipelineManager } from "@/components/settings/pipeline-manager";
import { PipelineAutomations } from "@/components/settings/pipeline-automations";
import { MAIN_PIPELINE_ID, PIPELINE_LIMITS } from "@/lib/pipeline/rules";

type Draft = { id: string; name: string; sales: boolean; nextPipelineId: string };

const leadsText = (n: number) => (n === 0 ? "no leads" : `${n} lead${n === 1 ? "" : "s"}`);

/**
 * Settings → Pipeline, with several pipelines (owner, 14 Oct 2026): the team pipelines along the top,
 * and the one chosen below — what it is called, whether it counts as sales, where its won leads carry
 * on — then its stages (`PipelineManager`) and its automations (`PipelineAutomations`).
 */
export function TeamPipelines({
  pipelines,
  stages,
  stored,
  multi,
  fields,
  automations,
  people,
  automationsReady,
}: {
  pipelines: ManagedPipeline[];
  stages: ManagedStage[];
  stored: boolean;
  multi: boolean;
  fields: { key: string; label: string }[];
  automations: ManagedAutomation[];
  people: { id: string; name: string }[];
  automationsReady: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const active = pipelines.filter((p) => !p.archived);
  const retired = pipelines.filter((p) => p.archived);
  const [chosenId, setChosenId] = useState<string>(active[0]?.id ?? MAIN_PIPELINE_ID);
  const chosen = pipelines.find((p) => p.id === chosenId) ?? active[0] ?? pipelines[0];
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showRetired, setShowRetired] = useState(false);

  function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      after?.();
      router.refresh();
    });
  }

  if (!multi || !chosen) {
    return <PipelineManager stages={stages} stored={stored} />;
  }

  const editing = draft?.id ? pipelines.find((p) => p.id === draft.id) : undefined;
  const nextOf = (p: ManagedPipeline) => (p.nextPipelineId ? pipelines.find((x) => x.id === p.nextPipelineId)?.name : null);
  const index = active.findIndex((p) => p.id === chosen.id);

  return (
    <div className="space-y-5">
      {error && !draft && (
        <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Pipelines">
        {active.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={p.id === chosen.id}
            onClick={() => {
              setError(null);
              setChosenId(p.id);
            }}
            className={`rounded-full border px-3 py-1 text-sm ${p.id === chosen.id ? "border-brand bg-brand-subtle font-medium text-brand" : "border-line text-muted hover:text-text"}`}
          >
            {p.name}
          </button>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending || active.length >= PIPELINE_LIMITS.pipelines}
          onClick={() => {
            setError(null);
            setDraft({ id: "", name: "", sales: false, nextPipelineId: "" });
          }}
        >
          Add a pipeline
        </Button>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm">
          <div className="min-w-0 space-y-1">
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-text">{chosen.name}</span>
              {chosen.id === MAIN_PIPELINE_ID && <Badge tone="default">Main</Badge>}
              <Badge tone={chosen.sales ? "green" : "blue"}>{chosen.sales ? "Counts as sales" : "Not sales"}</Badge>
              {chosen.archived && <Badge tone="red">Retired</Badge>}
            </p>
            <p className="text-xs text-subtle">
              {chosen.sales
                ? "Won leads count towards targets, wins and the forecast, and make their company a customer."
                : "A process, not a sale: its stages start, are under way, are done or dropped, and nothing counts it as sales."}
            </p>
            <p className="text-xs text-subtle">
              {nextOf(chosen) ? `Won leads carry on into ${nextOf(chosen)}.` : "Won leads stay here."} {leadsText(chosen.leads)}, {chosen.open} open.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Button type="button" variant="ghost" size="sm" aria-label={`Move ${chosen.name} earlier`} disabled={isPending || index <= 0} onClick={() => run(() => movePipeline(chosen.id, "up"))}>
              <ArrowUp className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Move ${chosen.name} later`}
              disabled={isPending || index < 0 || index === active.length - 1}
              onClick={() => run(() => movePipeline(chosen.id, "down"))}
            >
              <ArrowDown className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isPending}
              onClick={() => {
                setError(null);
                setDraft({ id: chosen.id, name: chosen.name, sales: chosen.sales, nextPipelineId: chosen.nextPipelineId ?? "" });
              }}
            >
              Change
            </Button>
            {chosen.id !== MAIN_PIPELINE_ID &&
              (chosen.leads === 0 ? (
                <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={() => run(() => deletePipeline(chosen.id), () => setChosenId(MAIN_PIPELINE_ID))}>
                  Delete
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isPending || chosen.open > 0}
                  title={chosen.open > 0 ? "Move or close its open leads first." : undefined}
                  onClick={() => run(() => retirePipeline(chosen.id), () => setChosenId(MAIN_PIPELINE_ID))}
                >
                  Retire
                </Button>
              ))}
          </div>
        </CardContent>
      </Card>

      <section className="space-y-3" aria-labelledby="pipeline-stages">
        <h3 id="pipeline-stages" className="text-sm font-semibold text-text">
          Stages
        </h3>
        <PipelineManager stages={stages} stored={stored} pipelineId={chosen.id} sales={chosen.sales} fields={fields} rules />
      </section>

      <section className="space-y-3" aria-labelledby="pipeline-automations">
        <div>
          <h3 id="pipeline-automations" className="text-sm font-semibold text-text">
            Automations
          </h3>
          <p className="mt-1 text-sm text-muted">
            When a lead arrives in {chosen.name} or moves into one of its stages: make a task, email the contact from the owner&apos;s mailbox, give the lead to someone, or tell
            someone.
          </p>
        </div>
        <PipelineAutomations
          pipelineId={chosen.id}
          stages={stages.filter((s) => s.pipelineId === chosen.id && !s.archived)}
          automations={automations.filter((a) => a.pipelineId === chosen.id)}
          people={people}
          ready={automationsReady}
        />
      </section>

      {retired.length > 0 && (
        <div className="space-y-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowRetired((v) => !v)} aria-expanded={showRetired}>
            {showRetired ? "Hide" : "Show"} retired pipelines ({retired.length})
          </Button>
          {showRetired &&
            retired.map((p) => (
              <Card key={p.id}>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                  <p className="text-muted">
                    {p.name} · retired · {leadsText(p.leads)}
                  </p>
                  <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={() => run(() => restorePipeline(p.id))}>
                    Restore
                  </Button>
                </CardContent>
              </Card>
            ))}
        </div>
      )}

      {draft && (
        <Dialog open onClose={() => setDraft(null)} title={draft.id ? `Change ${editing?.name ?? "the pipeline"}` : "Add a pipeline"}>
          {error && (
            <p role="alert" className="mb-3 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="pipeline-name" className="text-xs">
                Name
              </Label>
              <Input id="pipeline-name" placeholder="Partner onboarding" maxLength={PIPELINE_LIMITS.label} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={draft.sales}
                disabled={draft.id === MAIN_PIPELINE_ID}
                onChange={(e) => setDraft({ ...draft, sales: e.target.checked })}
              />
              <span>
                <span className="font-medium text-text">Counts as sales</span>
                <span className="block text-xs text-subtle">
                  Won leads count towards targets, wins and the forecast, and make their company a customer. Leave it off for partner onboarding, vendor approval and
                  the like.
                </span>
              </span>
            </label>
            {editing && editing.sales !== draft.sales && editing.leads > 0 && (
              <p className="text-xs text-warning">
                {draft.sales
                  ? `Its ${leadsText(editing.leads)} will count as sales from now on — including any already won.`
                  : `Its ${leadsText(editing.leads)} will stop counting as sales — what was won here comes off targets and wins.`}
              </p>
            )}
            <div className="space-y-1">
              <Label htmlFor="pipeline-next" className="text-xs">
                When a lead is won, carry it on into
              </Label>
              <Select id="pipeline-next" value={draft.nextPipelineId} onChange={(e) => setDraft({ ...draft, nextPipelineId: e.target.value })}>
                <option value="">Nowhere — it stays here</option>
                {active
                  .filter((p) => p.id !== draft.id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </Select>
              <p className="text-xs text-subtle">A new lead starts at that pipeline&apos;s first stage, with the same company, contact, owner and value.</p>
            </div>
            {!draft.id && (
              <p className="text-xs text-subtle">
                It starts with {draft.sales ? "New, Contacted, Qualified, Proposal sent, Won and Lost" : "Start, Under way, Done and Dropped"} — rename, add or retire stages
                after.
              </p>
            )}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)} disabled={isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isPending || !draft.name.trim()}
              onClick={() =>
                run(
                  async () => {
                    const saved = await savePipeline({ ...(draft.id ? { id: draft.id } : {}), name: draft.name, sales: draft.sales, nextPipelineId: draft.nextPipelineId || null });
                    if (saved.ok) setChosenId(saved.data.id);
                    return saved;
                  },
                  () => setDraft(null),
                )
              }
            >
              {isPending ? "Saving…" : draft.id ? "Save" : "Add the pipeline"}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
