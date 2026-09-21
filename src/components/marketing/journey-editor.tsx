"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import type { MessageChannel } from "@prisma/client";
import type { listAudiences, listTemplates, listJourneys } from "@/actions/marketing";
import { previewTrigger, saveJourney } from "@/actions/marketing";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { TRIGGERS, triggerByKey } from "@/lib/marketing/triggers";
import { exitLabels, parseExitConditions, type ExitCondition } from "@/lib/marketing/journey";

type Audience = Awaited<ReturnType<typeof listAudiences>>[number];
type Template = Awaited<ReturnType<typeof listTemplates>>[number];
type Journey = Awaited<ReturnType<typeof listJourneys>>[number];

type Step = {
  order: number;
  delayDays: number;
  channel: MessageChannel;
  templateId: string;
  taskTitle: string;
  taskDetail: string;
  taskDueDays: number;
  taskAssignee: string;
};

const blankStep = (order: number): Step => ({
  order,
  delayDays: order === 1 ? 0 : 7,
  channel: "TASK",
  templateId: "",
  taskTitle: "",
  taskDetail: "",
  taskDueDays: 3,
  taskAssignee: "OWNER",
});

/**
 * Building a sequence.
 *
 * The trigger's own description of what it enrols — and what it leaves out — is shown as it is
 * chosen, because that is the part people argue about afterwards. A renewal trigger that counted
 * addon seats separately would start four conversations about one expiry date, and nobody would
 * notice until a customer said so.
 */
export function JourneyEditor({
  journey,
  audiences,
  templates,
}: {
  journey?: Journey;
  audiences: Audience[];
  templates: Template[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState<{ count: number; sample: string[] } | null>(null);

  const existingConfig = (journey?.triggerConfig ?? {}) as Record<string, unknown>;
  const [name, setName] = useState(journey?.name ?? "");
  const [trigger, setTrigger] = useState(journey?.trigger ?? TRIGGERS[0].key);
  const [days, setDays] = useState(String(existingConfig.days ?? triggerByKey[journey?.trigger ?? TRIGGERS[0].key]?.defaultDays ?? ""));
  const [audienceId, setAudienceId] = useState(journey?.audienceId ?? "");
  const [reEnrol, setReEnrol] = useState(journey?.reEnrolAfterDays === null || journey?.reEnrolAfterDays === undefined ? "" : String(journey.reEnrolAfterDays));
  const [exits, setExits] = useState<Set<ExitCondition>>(new Set(parseExitConditions(journey?.exitOn)));
  const [steps, setSteps] = useState<Step[]>(
    journey && journey.steps.length > 0
      ? journey.steps.map((s) => ({
          order: s.order,
          delayDays: s.delayDays,
          channel: s.channel,
          templateId: s.templateId ?? "",
          taskTitle: s.taskTitle ?? "",
          taskDetail: s.taskDetail ?? "",
          taskDueDays: s.taskDueDays ?? 3,
          taskAssignee: s.taskAssignee ?? "OWNER",
        }))
      : [blankStep(1)],
  );

  const definition = triggerByKey[trigger];
  const setStep = (index: number, patch: Partial<Step>) =>
    setSteps((current) => current.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        {journey ? "Edit" : <><Plus className="mr-1.5 h-3.5 w-3.5" />New journey</>}
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title={journey ? "Edit journey" : "New journey"}>
        <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
          <div className="space-y-1.5">
            <Label htmlFor="jname">Name</Label>
            <Input id="jname" value={name} onChange={(e) => setName(e.target.value)} placeholder="Renewals to chase" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="jtrigger">What starts it</Label>
            <Select
              id="jtrigger"
              value={trigger}
              onChange={(e) => {
                setTrigger(e.target.value);
                setDays(String(triggerByKey[e.target.value]?.defaultDays ?? ""));
                setCount(null);
              }}
            >
              {TRIGGERS.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.team} — {t.label}
                </option>
              ))}
            </Select>
            {definition && (
              <Card className="bg-surface-sunken px-3 py-2 text-xs">
                <p className="text-muted">{definition.enrols}</p>
                {definition.excludes && <p className="mt-1 text-subtle">Not: {definition.excludes}</p>}
              </Card>
            )}
          </div>

          {definition?.daysLabel && (
            <div className="space-y-1.5">
              <Label htmlFor="jdays">{definition.daysLabel}</Label>
              <Input
                id="jdays"
                type="number"
                className="max-w-32"
                value={days}
                onChange={(e) => {
                  setDays(e.target.value);
                  setCount(null);
                }}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="jaud">Narrow it further</Label>
            <Select
              id="jaud"
              value={audienceId}
              onChange={(e) => {
                setAudienceId(e.target.value);
                setCount(null);
              }}
            >
              <option value="">Everybody the trigger finds</option>
              {audiences.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>

          {count && (
            <Card className="bg-surface-sunken px-3 py-2 text-sm">
              <span className="font-semibold tabular-nums text-text">{count.count}</span> would be enrolled today.
              {count.sample.length > 0 && <span className="mt-0.5 block text-xs text-muted">{count.sample.join(" · ")}</span>}
            </Card>
          )}

          {/* ── Steps ── */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Steps</Label>
              <Button size="sm" variant="secondary" onClick={() => setSteps((c) => [...c, blankStep(c.length + 1)])}>
                <Plus className="mr-1 h-3 w-3" />
                Add
              </Button>
            </div>

            {steps.map((step, index) => (
              <Card key={step.order} className="space-y-3 px-3 py-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-text">Step {step.order}</span>
                  {steps.length > 1 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setSteps((c) => c.filter((_, i) => i !== index).map((s, i) => ({ ...s, order: i + 1 })))
                      }
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={`s${index}-ch`}>Do what</Label>
                    <Select
                      id={`s${index}-ch`}
                      value={step.channel}
                      onChange={(e) => setStep(index, { channel: e.target.value as MessageChannel })}
                    >
                      <option value="TASK">Create a task for one of ours</option>
                      <option value="EMAIL">Email the customer</option>
                      <option value="WHATSAPP">WhatsApp the customer</option>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`s${index}-d`}>Days after the previous step</Label>
                    <Input
                      id={`s${index}-d`}
                      type="number"
                      min={0}
                      value={String(step.delayDays)}
                      onChange={(e) => setStep(index, { delayDays: Number(e.target.value) })}
                    />
                  </div>
                </div>

                {step.channel === "TASK" || step.channel === "NOTIFICATION" ? (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor={`s${index}-t`}>Task title</Label>
                      <Input
                        id={`s${index}-t`}
                        value={step.taskTitle}
                        onChange={(e) => setStep(index, { taskTitle: e.target.value })}
                        placeholder="Call about the renewal — {{companyName}}"
                      />
                      <p className="text-xs text-subtle">
                        <span className="font-mono">{"{{companyName}}"}</span> is filled in. This needs no mail
                        provider at all.
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`s${index}-dt`}>Notes for whoever picks it up</Label>
                      <Textarea
                        id={`s${index}-dt`}
                        rows={2}
                        value={step.taskDetail}
                        onChange={(e) => setStep(index, { taskDetail: e.target.value })}
                      />
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor={`s${index}-a`}>Give it to</Label>
                        <Select
                          id={`s${index}-a`}
                          value={step.taskAssignee}
                          onChange={(e) => setStep(index, { taskAssignee: e.target.value })}
                        >
                          <option value="OWNER">The account manager</option>
                          <option value="ASSIGNEE">The caller</option>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`s${index}-dd`}>Due in (days)</Label>
                        <Input
                          id={`s${index}-dd`}
                          type="number"
                          min={0}
                          value={String(step.taskDueDays)}
                          onChange={(e) => setStep(index, { taskDueDays: Number(e.target.value) })}
                        />
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="space-y-1.5">
                    <Label htmlFor={`s${index}-tpl`}>Template</Label>
                    <Select
                      id={`s${index}-tpl`}
                      value={step.templateId}
                      onChange={(e) => setStep(index, { templateId: e.target.value })}
                    >
                      <option value="">Choose a template…</option>
                      {templates
                        .filter((t) => t.active && t.channel === step.channel)
                        .map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                    </Select>
                  </div>
                )}
              </Card>
            ))}
          </div>

          {/* ── Exits ── */}
          <div className="space-y-1.5">
            <Label>Stop the sequence if</Label>
            <div className="flex flex-wrap gap-3">
              {(["ORDERED", "RENEWED", "REPLIED", "TICKET_RAISED", "LEAD_WON", "LEAD_LOST"] as ExitCondition[]).map(
                (condition) => (
                  <label key={condition} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={exits.has(condition)}
                      onChange={() =>
                        setExits((current) => {
                          const next = new Set(current);
                          if (next.has(condition)) next.delete(condition);
                          else next.add(condition);
                          return next;
                        })
                      }
                      className="h-4 w-4 accent-brand"
                    />
                    {exitLabels[condition].toLowerCase()}
                  </label>
                ),
              )}
            </div>
            <p className="text-xs text-subtle">
              Unsubscribing and becoming uncontactable always stop it, whether or not they are ticked — those are not
              preferences to opt out of honouring.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="jre">May start again after (days)</Label>
            <Input
              id="jre"
              type="number"
              className="max-w-32"
              value={reEnrol}
              onChange={(e) => setReEnrol(e.target.value)}
              placeholder="never"
            />
            <p className="text-xs text-subtle">
              Blank means once per subject, for good — right for a welcome sequence. A renewal comes round every year,
              so that one wants 365.
            </p>
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <p className="text-xs text-subtle">
            Saving makes it a draft. Nothing is enrolled until you press Start on it.
          </p>

          <div className="flex flex-wrap gap-2">
            <Button
              disabled={pending || !name.trim()}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await saveJourney({
                    id: journey?.id,
                    name,
                    trigger,
                    triggerConfig: days ? { days: Number(days) } : {},
                    audienceId: audienceId || null,
                    exitOn: [...exits],
                    reEnrolAfterDays: reEnrol ? Number(reEnrol) : null,
                    steps: steps.map((s) => ({
                      order: s.order,
                      delayDays: s.delayDays,
                      channel: s.channel,
                      templateId: s.channel === "EMAIL" || s.channel === "WHATSAPP" ? s.templateId : null,
                      taskTitle: s.channel === "TASK" || s.channel === "NOTIFICATION" ? s.taskTitle : null,
                      taskDetail: s.taskDetail || null,
                      taskDueDays: s.taskDueDays,
                      taskAssignee: s.taskAssignee,
                    })),
                  });
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  setOpen(false);
                  router.refresh();
                });
              }}
            >
              {pending ? "Saving…" : "Save as draft"}
            </Button>
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => {
                startTransition(async () => {
                  const result = await previewTrigger({
                    trigger,
                    triggerConfig: days ? { days: Number(days) } : {},
                    audienceId: audienceId || null,
                  });
                  if (result) setCount(result);
                });
              }}
            >
              Who&apos;d it catch?
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
