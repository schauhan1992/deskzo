"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { deleteProjectType, saveProjectType } from "@/actions/project-document";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { IconButton } from "@/components/ui/icon-button";
import { Checkbox } from "@/components/ui/bulk-select";

type Milestone = { id?: string; name: string; note: string | null; dayOffset: number };
type Type = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  templateMilestones: Milestone[];
  _count: { projects: number };
};

/**
 * The kinds of work this business delivers, and the standard plan for each.
 *
 * A row rather than an enum so the list can grow without a migration — the alternative is that the
 * thirteenth kind of project gets filed under "Other" forever. Editing a template never touches a
 * project that already exists: a plan somebody has been working for three weeks is not something a
 * settings screen should rewrite underneath them.
 */
export function ProjectTypesManager({ types }: { types: Type[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-4">
      {types.length === 0 && (
        <p className="text-sm text-muted">
          None yet. Add the kinds of work you deliver — website development, mail migration, an implementation.
        </p>
      )}

      {types.map((t) => (
        <TypeRow key={t.id} type={t} />
      ))}

      <div className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
        <div className="min-w-48 flex-1 space-y-1.5">
          <Label htmlFor="new-type">Add a kind of project</Label>
          <Input
            id="new-type"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            placeholder="Mail migration"
          />
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={pending || !adding.trim()}
          onClick={() =>
            startTransition(async () => {
              const result = await saveProjectType({ name: adding, sortOrder: types.length });
              if (!result.ok) {
                alert(result.error);
                return;
              }
              setAdding("");
              router.refresh();
            })
          }
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function TypeRow({ type }: { type: Type }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<Milestone[]>(type.templateMilestones);
  const [pending, startTransition] = useTransition();

  const update = (i: number, patch: Partial<Milestone>) =>
    setSteps((prev) => prev.map((s, j) => (i === j ? { ...s, ...patch } : s)));

  return (
    <div className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-sm ${type.active ? "text-text" : "text-muted line-through"}`}>{type.name}</span>
            <span className="text-xs text-subtle">
              {type.templateMilestones.length} step{type.templateMilestones.length === 1 ? "" : "s"}
              {type._count.projects > 0 && ` · ${type._count.projects} project${type._count.projects === 1 ? "" : "s"}`}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <Checkbox
              checked={type.active}
              onChange={async () => {
                await saveProjectType({ id: type.id, name: type.name, active: !type.active });
                router.refresh();
              }}
            />
            Offered
          </label>
          <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
            {open ? "Close" : "Standard plan"}
          </Button>
          <IconButton
            icon={Trash2}
            label="Delete"
            tone="danger"
            onClick={async () => {
              const result = await deleteProjectType(type.id);
              if (!result.ok) alert(result.error);
              router.refresh();
            }}
          />
        </div>
      </div>

      {open && (
        <div className="mt-3 space-y-2 border-t border-line pt-3">
          <p className="text-xs text-subtle">
            Every new project of this kind starts with these, dated from its own start date. Changing them here
            leaves existing projects alone.
          </p>
          {/* Named per row rather than paired with a label: the wording that distinguishes these is
              the step's position, which only exists here in the map. */}
          {steps.map((s, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input
                value={s.name}
                onChange={(e) => update(i, { name: e.target.value })}
                placeholder="Step"
                aria-label={`Step ${i + 1} name`}
                className="min-w-40 flex-1"
              />
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  value={s.dayOffset}
                  onChange={(e) => update(i, { dayOffset: Number(e.target.value) })}
                  aria-label={`Step ${i + 1} days in`}
                  className="w-20"
                />
                <span className="text-xs text-subtle">days in</span>
              </div>
              <IconButton
                icon={Trash2}
                label="Remove step"
                tone="danger"
                onClick={() => setSteps((prev) => prev.filter((_, j) => j !== i))}
              />
            </div>
          ))}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setSteps((prev) => [...prev, { name: "", note: null, dayOffset: 0 }])}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add a step
            </Button>
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  await saveProjectType({
                    id: type.id,
                    name: type.name,
                    milestones: steps.map((s) => ({ name: s.name, note: s.note ?? undefined, dayOffset: s.dayOffset })),
                  });
                  router.refresh();
                })
              }
            >
              {pending ? "Saving…" : "Save plan"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
