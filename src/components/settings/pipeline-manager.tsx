"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { LeadStatus } from "@prisma/client";
import { deleteLeadStage, moveLeadStage, restoreLeadStage, retireLeadStage, saveLeadStage } from "@/actions/pipeline";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import {
  MAIN_PIPELINE_ID,
  PIPELINE_LIMITS,
  QUOTE_RULE,
  RULE_FIELDS,
  RULE_LIMIT,
  STAGE_COLORS,
  STAGE_COLOR_LABELS,
  kindOf,
  meaningLabel,
  meaningsFor,
  mustKeep,
  rehomeTargets,
  ruleFieldLabel,
  type LeadStageDef,
  type StageColor,
  type StageKind,
} from "@/lib/pipeline/rules";

type Stage = LeadStageDef & { leads: number };
type Draft = { id: string; label: string; status: LeadStatus; color: StageColor; requiredFields: string[] };

const KIND_LABELS: Record<StageKind, string> = { OPEN: "Open — still being worked", WON: "Won", LOST: "Lost" };
const PROCESS_KIND_LABELS: Record<StageKind, string> = { OPEN: "Open — still being worked", WON: "Done", LOST: "Dropped" };

const leadsText = (n: number) => (n === 0 ? "No leads" : `${n} lead${n === 1 ? "" : "s"}`);

/**
 * Settings → Pipeline (src/actions/pipeline.ts): one pipeline's stages in the order a lead moves through
 * them, each as the board shows it, with what it counts as and what it asks for first (its rule); a
 * dialog to add or change one, and one to retire one with its leads moved on. A pipeline that isn't
 * sales offers a process's meanings — start, under way, done, dropped.
 */
export function PipelineManager({
  stages: all,
  stored,
  pipelineId = MAIN_PIPELINE_ID,
  sales = true,
  fields = [],
  rules = false,
  quotes = false,
}: {
  stages: Stage[];
  stored: boolean;
  pipelineId?: string;
  sales?: boolean;
  /** The workspace's own lead fields, which a stage's rule may ask for. */
  fields?: { key: string; label: string }[];
  /** Whether stages can have rules yet (the workspace has the team pipelines). */
  rules?: boolean;
  /** Whether the workspace raises quotations (Sales Documents), so a sales stage may ask for one. */
  quotes?: boolean;
}) {
  const stages = all.filter((s) => s.pipelineId === pipelineId);
  const kinds = sales ? KIND_LABELS : PROCESS_KIND_LABELS;
  const customLabels = new Map(fields.map((f) => [f.key, f.label]));
  // An issued quotation is a sales stage's to ask for, and only where quotations are raised at all.
  const ruleOptions = [
    ...RULE_FIELDS.filter((f) => f.key !== QUOTE_RULE || (sales && quotes)).map((f) => ({ key: f.key as string, label: f.label as string })),
    ...fields.map((f) => ({ key: `cf:${f.key}`, label: f.label })),
  ];
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [retiring, setRetiring] = useState<{ stage: Stage; moveTo: string } | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const active = stages.filter((s) => !s.archived);
  const retired = stages.filter((s) => s.archived);
  const editing = draft?.id ? stages.find((s) => s.id === draft.id) : undefined;

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

  if (!stored) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted">
          This workspace is still being updated to have its own stages. Leads keep the stages they always had in the meantime — come back in a few minutes.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {error && !draft && !retiring && (
        <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">{active.length} stages, in the order a lead moves through them — the leads board shows them as columns.</p>
        <Button
          type="button"
          size="sm"
          disabled={active.length >= PIPELINE_LIMITS.stages}
          onClick={() => {
            setError(null);
            setDraft({ id: "", label: "", status: sales ? "QUALIFYING" : "CONTACTED", color: "blue", requiredFields: [] });
          }}
        >
          Add a stage
        </Button>
      </div>

      <div className="space-y-2">
        {active.map((s, index) => {
          const keep = mustKeep(s, stages, sales);
          return (
            <Card key={s.id}>
              <CardContent className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm">
                <div className="min-w-0 space-y-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge tone={s.color}>{s.label}</Badge>
                    <span className="text-muted">counts as {meaningLabel(s.status, sales).toLowerCase()}</span>
                  </p>
                  <p className="text-xs text-subtle">{meaningsFor(sales).find((m) => m.status === s.status)?.hint}</p>
                  {s.requiredFields.length > 0 && (
                    <p className="text-xs text-subtle">Asks for {s.requiredFields.map((k) => ruleFieldLabel(k, customLabels).toLowerCase()).join(", ")} first</p>
                  )}
                  <p className="text-xs text-subtle">{leadsText(s.leads)}</p>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Move ${s.label} up`}
                    disabled={isPending || index === 0}
                    onClick={() => run(() => moveLeadStage(s.id, "up"))}
                  >
                    <ArrowUp className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Move ${s.label} down`}
                    disabled={isPending || index === active.length - 1}
                    onClick={() => run(() => moveLeadStage(s.id, "down"))}
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
                      setDraft({ id: s.id, label: s.label, status: s.status, color: s.color, requiredFields: s.requiredFields });
                    }}
                  >
                    Change
                  </Button>
                  {s.leads === 0 && !keep ? (
                    <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={() => run(() => deleteLeadStage(s.id))}>
                      Delete
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={isPending || !!keep}
                      title={keep ?? undefined}
                      onClick={() => {
                        setError(null);
                        setRetiring({ stage: s, moveTo: rehomeTargets(s, stages)[0]?.id ?? "" });
                      }}
                    >
                      Retire
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {retired.length > 0 && (
        <div className="space-y-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowRetired((v) => !v)} aria-expanded={showRetired}>
            {showRetired ? "Hide" : "Show"} retired stages ({retired.length})
          </Button>
          {showRetired &&
            retired.map((s) => (
              <Card key={s.id}>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                  <p className="flex flex-wrap items-center gap-2 text-muted">
                    <Badge tone={s.color}>{s.label}</Badge>
                    counts as {meaningLabel(s.status, sales).toLowerCase()} · retired
                  </p>
                  <div className="flex items-center gap-1">
                    <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={() => run(() => restoreLeadStage(s.id))}>
                      Restore
                    </Button>
                    {s.leads === 0 && (
                      <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={() => run(() => deleteLeadStage(s.id))}>
                        Delete
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
        </div>
      )}

      {draft && (
        <Dialog open onClose={() => setDraft(null)} title={draft.id ? `Change ${editing?.label ?? "the stage"}` : "Add a stage"}>
          {error && (
            <p role="alert" className="mb-3 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="pipeline-stage-label" className="text-xs">
                Name
              </Label>
              <Input
                id="pipeline-stage-label"
                placeholder="Site visit"
                maxLength={PIPELINE_LIMITS.label}
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pipeline-stage-meaning" className="text-xs">
                Counts as
              </Label>
              <Select id="pipeline-stage-meaning" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as LeadStatus })}>
                {(["OPEN", "WON", "LOST"] as const).map((kind) => (
                  <optgroup key={kind} label={kinds[kind]}>
                    {meaningsFor(sales).filter((m) => m.kind === kind).map((m) => (
                      <option
                        key={m.status}
                        value={m.status}
                        // A stage with leads in it can't become won or lost, or open again: that would close or reopen deals in bulk.
                        disabled={!!editing && editing.leads > 0 && kindOf(editing.status) !== m.kind}
                      >
                        {m.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
              <p className="text-xs text-subtle">{meaningsFor(sales).find((m) => m.status === draft.status)?.hint}</p>
              {editing && editing.leads > 0 && editing.status !== draft.status && (
                <p className="text-xs text-warning">
                  {leadsText(editing.leads)} in this stage will count as {meaningLabel(draft.status, sales).toLowerCase()} from now on, with a note on each.
                </p>
              )}
            </div>
            {rules && (
              <fieldset className="space-y-1">
                <legend className="text-xs font-medium text-text">Before a lead moves here, it must have</legend>
                <div className="grid gap-1 sm:grid-cols-2">
                  {ruleOptions.map((o) => {
                    const checked = draft.requiredFields.includes(o.key);
                    return (
                      <label key={o.key} className="flex cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!checked && draft.requiredFields.length >= RULE_LIMIT}
                          onChange={() => setDraft({ ...draft, requiredFields: checked ? draft.requiredFields.filter((k) => k !== o.key) : [...draft.requiredFields, o.key] })}
                        />
                        {o.label}
                      </label>
                    );
                  })}
                </div>
                <p className="text-xs text-subtle">Nothing ticked: a lead can move here as it is. A lead missing one is stopped, and told what to fill in.</p>
              </fieldset>
            )}
            <fieldset className="space-y-1">
              <legend className="text-xs font-medium text-text">Colour</legend>
              <div className="flex flex-wrap gap-2">
                {STAGE_COLORS.map((c) => (
                  <label key={c} className="flex cursor-pointer items-center gap-1.5 text-sm">
                    <input type="radio" name="pipeline-stage-color" value={c} checked={draft.color === c} onChange={() => setDraft({ ...draft, color: c })} />
                    <Badge tone={c}>{draft.label.trim() || STAGE_COLOR_LABELS[c]}</Badge>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="button" size="sm" disabled={isPending || !draft.label.trim()} onClick={() =>
                run(
                  () =>
                    saveLeadStage({
                      ...(draft.id ? { id: draft.id } : { pipelineId }),
                      label: draft.label,
                      status: draft.status,
                      color: draft.color,
                      ...(rules ? { requiredFields: draft.requiredFields } : {}),
                    }),
                  () => setDraft(null),
                )
              }>
              {isPending ? "Saving…" : draft.id ? "Save" : "Add the stage"}
            </Button>
          </div>
        </Dialog>
      )}

      {retiring && (
        <Dialog open onClose={() => setRetiring(null)} title={`Retire ${retiring.stage.label}`}>
          {error && (
            <p role="alert" className="mb-3 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          <div className="space-y-3 text-sm">
            <p className="text-muted">It will no longer be offered or shown on the board. It can be restored later.</p>
            {retiring.stage.leads > 0 && (
              <div className="space-y-1">
                <Label htmlFor="pipeline-retire-target" className="text-xs">
                  Move its {leadsText(retiring.stage.leads).toLowerCase()} to
                </Label>
                <Select id="pipeline-retire-target" value={retiring.moveTo} onChange={(e) => setRetiring({ ...retiring, moveTo: e.target.value })}>
                  {rehomeTargets(retiring.stage, stages).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-subtle">
                  {kindOf(retiring.stage.status) === "OPEN"
                    ? "Any open stage. Moving to one that counts as something else leaves a note on each lead."
                    : `Another ${kinds[kindOf(retiring.stage.status)].toLowerCase()} stage — when each lead was closed stays as it was.`}
                </p>
              </div>
            )}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setRetiring(null)} disabled={isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isPending || (retiring.stage.leads > 0 && !retiring.moveTo)}
              onClick={() => run(() => retireLeadStage(retiring.stage.id, retiring.moveTo || null), () => setRetiring(null))}
            >
              {isPending ? "Retiring…" : "Retire"}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
