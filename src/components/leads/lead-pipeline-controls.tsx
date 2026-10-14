"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { moveLeadToPipeline, updateLeadDetails } from "@/actions/lead";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";

export type LeadDetailsValues = { title: string; description: string; estimatedValue: string; expectedCloseDate: string; contactId: string };
export type MoveTarget = { id: string; name: string; stages: { id: string; label: string }[] };

/**
 * A lead's own details — title, description, value, expected close date, contact — edited from its page
 * (`updateLeadDetails`), which is what a stage's rule asks for before the lead moves on; and, with more
 * than one pipeline, moving it to another team's (`moveLeadToPipeline`).
 */
export function LeadPipelineControls({
  leadId,
  details,
  contacts,
  moveTargets,
}: {
  leadId: string;
  details: LeadDetailsValues;
  contacts: { id: string; name: string }[];
  /** Other pipelines in use, each with its open stages; empty when the lead can't move (closed, or only one pipeline). */
  moveTargets: MoveTarget[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<LeadDetailsValues | null>(null);
  const [moving, setMoving] = useState<{ pipelineId: string; stageId: string } | null>(null);
  const target = moving ? moveTargets.find((t) => t.id === moving.pipelineId) : undefined;

  function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, after: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      after();
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          setError(null);
          setEditing(details);
        }}
      >
        Edit
      </Button>
      {moveTargets.length > 0 && (
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setError(null);
            setMoving({ pipelineId: moveTargets[0]!.id, stageId: moveTargets[0]!.stages[0]?.id ?? "" });
          }}
        >
          Move to pipeline
        </Button>
      )}

      {editing && (
        <Dialog open onClose={() => setEditing(null)} title="Edit the lead">
          {error && (
            <p role="alert" className="mb-3 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="lead-edit-title" className="text-xs">
                Title
              </Label>
              <Input id="lead-edit-title" maxLength={200} value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="lead-edit-value" className="text-xs">
                  Value
                </Label>
                <Input
                  id="lead-edit-value"
                  inputMode="decimal"
                  value={editing.estimatedValue}
                  onChange={(e) => setEditing({ ...editing, estimatedValue: e.target.value.replace(/[^\d.]/g, "") })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="lead-edit-close" className="text-xs">
                  Expected close date
                </Label>
                <Input id="lead-edit-close" type="date" value={editing.expectedCloseDate} onChange={(e) => setEditing({ ...editing, expectedCloseDate: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="lead-edit-contact" className="text-xs">
                Contact
              </Label>
              <Select id="lead-edit-contact" value={editing.contactId} onChange={(e) => setEditing({ ...editing, contactId: e.target.value })}>
                <option value="">No specific contact</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="lead-edit-description" className="text-xs">
                Description
              </Label>
              <Textarea id="lead-edit-description" rows={4} maxLength={5000} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)} disabled={isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isPending || editing.title.trim().length < 2}
              onClick={() => run(() => updateLeadDetails({ leadId, ...editing }), () => setEditing(null))}
            >
              {isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </Dialog>
      )}

      {moving && target && (
        <Dialog open onClose={() => setMoving(null)} title="Move to another pipeline">
          {error && (
            <p role="alert" className="mb-3 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="lead-move-pipeline" className="text-xs">
                Pipeline
              </Label>
              <Select
                id="lead-move-pipeline"
                value={moving.pipelineId}
                onChange={(e) => setMoving({ pipelineId: e.target.value, stageId: moveTargets.find((t) => t.id === e.target.value)?.stages[0]?.id ?? "" })}
              >
                {moveTargets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="lead-move-stage" className="text-xs">
                Stage
              </Label>
              <Select id="lead-move-stage" value={moving.stageId} onChange={(e) => setMoving({ ...moving, stageId: e.target.value })}>
                {target.stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </div>
            <p className="text-xs text-subtle">Its history stays with it, and the move is noted on its timeline. The new pipeline&apos;s automations run as for a lead arriving.</p>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setMoving(null)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="button" size="sm" disabled={isPending || !moving.stageId} onClick={() => run(() => moveLeadToPipeline({ leadId, ...moving }), () => setMoving(null))}>
              {isPending ? "Moving…" : `Move to ${target.name}`}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
