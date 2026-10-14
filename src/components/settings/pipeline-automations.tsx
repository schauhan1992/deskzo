"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { deleteAutomation, saveAutomation, setAutomationActive, type ManagedAutomation } from "@/actions/pipeline-automations";
import type { ManagedStage } from "@/actions/pipeline";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { ACTION_LABELS, AUTOMATION_LIMITS, MERGE_TAGS, OWNER, RULES, describeAction, type ActionType, type AutomationAction } from "@/lib/pipeline/automation-rules";

type Trigger = "LEAD_CREATED" | "STAGE_ENTERED";
type Draft = { id: string; name: string; trigger: Trigger; stageId: string; active: boolean; actions: AutomationAction[] };

const blank = (type: ActionType): AutomationAction =>
  type === "TASK"
    ? { type, title: "Call {{contact}} about {{lead}}", dueInDays: 1, assignTo: OWNER }
    : type === "EMAIL"
      ? { type, subject: "Thank you, {{contact}}", body: "Hello {{contact}},\n\nThank you for your interest. I'll be in touch shortly.\n\n{{owner}}" }
      : type === "ASSIGN"
        ? { type, userId: RULES }
        : { type, to: OWNER, message: "{{lead}} is now at {{stage}}." };

/**
 * A pipeline's automations (src/actions/pipeline-automations.ts): each says when it runs and what it does,
 * in plain words, with whether it is on and what went wrong last time; a dialog to make or change one.
 */
export function PipelineAutomations({
  pipelineId,
  stages,
  automations,
  people,
  ready,
}: {
  pipelineId: string;
  stages: ManagedStage[];
  automations: ManagedAutomation[];
  people: { id: string; name: string }[];
  ready: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? "someone no longer here";
  const stageName = (id: string | null) => stages.find((s) => s.id === id)?.label ?? "a retired stage";

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

  if (!ready) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted">This workspace is still being updated. Come back in a few minutes.</CardContent>
      </Card>
    );
  }

  const setAction = (i: number, next: AutomationAction) => draft && setDraft({ ...draft, actions: draft.actions.map((a, j) => (j === i ? next : a)) });
  const personOptions = (extra: { value: string; label: string }[]) => [
    ...extra,
    ...people.map((p) => ({ value: p.id, label: p.name })),
  ];

  return (
    <div className="space-y-3">
      {error && !draft && (
        <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={isPending || automations.length >= AUTOMATION_LIMITS.perPipeline}
          onClick={() => {
            setError(null);
            setDraft({ id: "", name: "", trigger: "LEAD_CREATED", stageId: stages[0]?.id ?? "", active: true, actions: [blank("TASK")] });
          }}
        >
          Add an automation
        </Button>
      </div>
      {automations.length === 0 && <p className="text-sm text-muted">No automations in this pipeline yet.</p>}
      {automations.map((a) => (
        <Card key={a.id}>
          <CardContent className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm">
            <div className="min-w-0 space-y-1">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-text">{a.name}</span>
                <Badge tone={a.active ? "green" : "default"}>{a.active ? "On" : "Off"}</Badge>
              </p>
              <p className="text-xs text-muted">{a.trigger === "LEAD_CREATED" ? "When a lead arrives in this pipeline" : `When a lead moves into ${stageName(a.stageId)}`}</p>
              <ul className="list-inside list-disc text-xs text-subtle">
                {a.actions.map((x, i) => (
                  <li key={i}>{describeAction(x, nameOf)}</li>
                ))}
              </ul>
              <p className="text-xs text-subtle">
                {a.runs === 0 ? "Not run yet." : `Run ${a.runs} time${a.runs === 1 ? "" : "s"}${a.lastRunAt ? `, last ${new Date(a.lastRunAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}` : ""}.`}
              </p>
              {a.lastError && <p className="text-xs text-warning">Last time: {a.lastError}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={() => run(() => setAutomationActive(a.id, !a.active))}>
                {a.active ? "Switch off" : "Switch on"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isPending}
                onClick={() => {
                  setError(null);
                  setDraft({ id: a.id, name: a.name, trigger: a.trigger, stageId: a.stageId ?? stages[0]?.id ?? "", active: a.active, actions: a.actions });
                }}
              >
                Change
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={() => run(() => deleteAutomation(a.id))}>
                Delete
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}

      {draft && (
        <Dialog open onClose={() => setDraft(null)} title={draft.id ? `Change ${draft.name || "the automation"}` : "Add an automation"} wide>
          {error && (
            <p role="alert" className="mb-3 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="automation-name" className="text-xs">
                Name
              </Label>
              <Input id="automation-name" placeholder="Welcome call" maxLength={AUTOMATION_LIMITS.name} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="automation-trigger" className="text-xs">
                  When
                </Label>
                <Select id="automation-trigger" value={draft.trigger} onChange={(e) => setDraft({ ...draft, trigger: e.target.value as Trigger })}>
                  <option value="LEAD_CREATED">A lead arrives in this pipeline</option>
                  <option value="STAGE_ENTERED">A lead moves into a stage</option>
                </Select>
              </div>
              {draft.trigger === "STAGE_ENTERED" && (
                <div className="space-y-1">
                  <Label htmlFor="automation-stage" className="text-xs">
                    Stage
                  </Label>
                  <Select id="automation-stage" value={draft.stageId} onChange={(e) => setDraft({ ...draft, stageId: e.target.value })}>
                    {stages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
            </div>

            <fieldset className="space-y-3">
              <legend className="text-xs font-medium text-text">Then, in order</legend>
              {draft.actions.map((a, i) => (
                <Card key={i}>
                  <CardContent className="space-y-2 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <Select
                        aria-label={`Step ${i + 1}`}
                        value={a.type}
                        onChange={(e) => setAction(i, blank(e.target.value as ActionType))}
                        className="max-w-xs"
                      >
                        {(Object.keys(ACTION_LABELS) as ActionType[]).map((t) => (
                          <option key={t} value={t}>
                            {ACTION_LABELS[t]}
                          </option>
                        ))}
                      </Select>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove step ${i + 1}`}
                        disabled={draft.actions.length === 1}
                        onClick={() => setDraft({ ...draft, actions: draft.actions.filter((_, j) => j !== i) })}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                    {a.type === "TASK" && (
                      <div className="grid gap-2 sm:grid-cols-[1fr_8rem_12rem]">
                        <Input aria-label="Task title" maxLength={AUTOMATION_LIMITS.title} value={a.title} onChange={(e) => setAction(i, { ...a, title: e.target.value })} />
                        <Input
                          aria-label="Due in days"
                          type="number"
                          min={0}
                          max={AUTOMATION_LIMITS.days}
                          value={a.dueInDays}
                          onChange={(e) => setAction(i, { ...a, dueInDays: Number(e.target.value) })}
                        />
                        <Select aria-label="Task for" value={a.assignTo} onChange={(e) => setAction(i, { ...a, assignTo: e.target.value })}>
                          {personOptions([{ value: OWNER, label: "The lead's owner" }]).map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </Select>
                      </div>
                    )}
                    {a.type === "EMAIL" && (
                      <div className="space-y-2">
                        <Input aria-label="Subject" maxLength={AUTOMATION_LIMITS.subject} value={a.subject} onChange={(e) => setAction(i, { ...a, subject: e.target.value })} />
                        <Textarea aria-label="Message" rows={5} maxLength={AUTOMATION_LIMITS.body} value={a.body} onChange={(e) => setAction(i, { ...a, body: e.target.value })} />
                        <p className="text-xs text-subtle">Sent to the lead&apos;s contact from the owner&apos;s own mailbox (My profile → Mailbox). Without one, it is skipped and noted here.</p>
                      </div>
                    )}
                    {a.type === "ASSIGN" && (
                      <Select aria-label="Give the lead to" value={a.userId} onChange={(e) => setAction(i, { ...a, userId: e.target.value })}>
                        {personOptions([{ value: RULES, label: "Whoever the assignment rules choose" }]).map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    )}
                    {a.type === "NOTIFY" && (
                      <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
                        <Select aria-label="Notify" value={a.to} onChange={(e) => setAction(i, { ...a, to: e.target.value })}>
                          {personOptions([{ value: OWNER, label: "The lead's owner" }]).map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </Select>
                        <Input aria-label="Message" maxLength={AUTOMATION_LIMITS.message} value={a.message} onChange={(e) => setAction(i, { ...a, message: e.target.value })} />
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={draft.actions.length >= AUTOMATION_LIMITS.actions}
                onClick={() => setDraft({ ...draft, actions: [...draft.actions, blank("TASK")] })}
              >
                Add a step
              </Button>
              <p className="text-xs text-subtle">Text can use {MERGE_TAGS.map((t) => `{{${t}}}`).join(", ")}.</p>
            </fieldset>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
              On
            </label>
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
                  () =>
                    saveAutomation({
                      ...(draft.id ? { id: draft.id } : {}),
                      pipelineId,
                      name: draft.name,
                      trigger: draft.trigger,
                      stageId: draft.trigger === "STAGE_ENTERED" ? draft.stageId : null,
                      actions: draft.actions,
                      active: draft.active,
                    }),
                  () => setDraft(null),
                )
              }
            >
              {isPending ? "Saving…" : draft.id ? "Save" : "Add the automation"}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
