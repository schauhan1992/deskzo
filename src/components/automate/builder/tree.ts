import type { Definition, Step } from "@/lib/automate/definition";
import type { Catalog } from "@/lib/automate/catalog";

/**
 * The builder's draft as a tree it edits (Deskzo Automate, Phase 3) — pure, so every change is a new
 * draft and undo is just the old one. Steps are found by id: ids are unique across a workflow, and a
 * step keeps its id for life, because later steps refer to its output by it.
 *
 * A place in the tree — where a new step goes — is a slot: the top-level list, or one path of a
 * branch (its index, or "else").
 */

export type Slot = { branchId: string | null; path: number | "else" | null };
export const ROOT: Slot = { branchId: null, path: null };

/** The draft as the builder holds it: a definition that may be unfinished. */
export type Draft = Definition;

export function emptyDraft(): Draft {
  return { schema: 1, trigger: { type: "manual" }, steps: [] as unknown as Definition["steps"] };
}

/** The draft from whatever was saved — a broken or empty one starts again from nothing. */
export function readDraft(raw: unknown): Draft {
  const d = raw as Partial<Definition> | null;
  if (!d || typeof d !== "object" || !d.trigger || !Array.isArray(d.steps)) return emptyDraft();
  return { schema: 1, trigger: d.trigger, steps: d.steps, ...(d.settings ? { settings: d.settings } : {}) } as Draft;
}

function mapSteps(steps: Step[], fn: (list: Step[], slot: Slot) => Step[], slot: Slot = ROOT): Step[] {
  const mine = fn(steps, slot);
  return mine.map((step) =>
    step.type === "branch"
      ? {
          ...step,
          paths: step.paths.map((p, i) => ({ ...p, steps: mapSteps(p.steps, fn, { branchId: step.id, path: i }) })),
          ...(step.else ? { else: mapSteps(step.else, fn, { branchId: step.id, path: "else" }) } : {}),
        }
      : step,
  );
}

const sameSlot = (a: Slot, b: Slot) => a.branchId === b.branchId && a.path === b.path;

export function allSteps(steps: Step[], out: Step[] = []): Step[] {
  for (const step of steps) {
    out.push(step);
    if (step.type === "branch") {
      for (const p of step.paths) allSteps(p.steps, out);
      if (step.else) allSteps(step.else, out);
    }
  }
  return out;
}

export function findStep(draft: Draft, id: string): Step | null {
  return allSteps(draft.steps).find((s) => s.id === id) ?? null;
}

export function updateStep(draft: Draft, id: string, change: (step: Step) => Step): Draft {
  return { ...draft, steps: mapSteps(draft.steps, (list) => list.map((s) => (s.id === id ? change(s) : s))) as Definition["steps"] };
}

export function removeStep(draft: Draft, id: string): Draft {
  return { ...draft, steps: mapSteps(draft.steps, (list) => list.filter((s) => s.id !== id)) as Definition["steps"] };
}

export function insertStep(draft: Draft, slot: Slot, index: number, step: Step): Draft {
  if (sameSlot(slot, ROOT)) return { ...draft, steps: [...draft.steps.slice(0, index), step, ...draft.steps.slice(index)] as Definition["steps"] };
  return { ...draft, steps: mapSteps(draft.steps, (list, here) => (sameSlot(here, slot) ? [...list.slice(0, index), step, ...list.slice(index)] : list)) as Definition["steps"] };
}

/** Moves a step up or down within its own list. */
export function moveStep(draft: Draft, id: string, by: -1 | 1): Draft {
  return {
    ...draft,
    steps: mapSteps(draft.steps, (list) => {
      const at = list.findIndex((s) => s.id === id);
      const to = at + by;
      if (at < 0 || to < 0 || to >= list.length) return list;
      const next = [...list];
      [next[at], next[to]] = [next[to]!, next[at]!];
      return next;
    }) as Definition["steps"],
  };
}

/** A new id for a step: its kind, numbered if taken — "assign", "assign2". */
export function newStepId(draft: Draft, base: string): string {
  const taken = new Set(allSteps(draft.steps).map((s) => s.id));
  const stem = base.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase().slice(0, 30) || "step";
  const start = /^[a-z]/.test(stem) ? stem : `s_${stem}`;
  if (!taken.has(start)) return start;
  for (let n = 2; ; n++) if (!taken.has(`${start}${n}`)) return `${start}${n}`;
}

/** Every step with an id, renamed copies get new ids — for "Duplicate step". */
export function cloneStep(draft: Draft, step: Step): Step {
  const ids = new Set(allSteps(draft.steps).map((s) => s.id));
  const fresh = (base: string) => {
    for (let n = 2; ; n++) {
      const id = `${base.replace(/\d+$/, "")}${n}`.slice(0, 40);
      if (!ids.has(id)) {
        ids.add(id);
        return id;
      }
    }
  };
  const copy = (s: Step): Step =>
    s.type === "branch"
      ? { ...s, id: fresh(s.id), paths: s.paths.map((p) => ({ ...p, steps: p.steps.map(copy) })), ...(s.else ? { else: s.else.map(copy) } : {}) }
      : ({ ...JSON.parse(JSON.stringify(s)), id: fresh(s.id) } as Step);
  return copy(step);
}

export type DataRef = { ref: string; label: string; group: string };

/**
 * What a step may read: the trigger's fields, and the outputs of the steps that have run by then — the
 * ones before it on its own path, and before the branches it sits in. As the publish check sees it
 * (src/lib/automate/validate.ts), so the picker never offers what publishing would refuse.
 */
export function dataBefore(draft: Draft, stepId: string | null, catalog: Catalog): DataRef[] {
  const trigger = catalog.triggers.find((t) => t.type === draft.trigger.type);
  const out: DataRef[] = (trigger?.paths ?? []).map((p) => ({ ...p, group: "What started it" }));
  if (stepId === null) return out;
  const before: Step[] = [];
  const walk = (steps: Step[], seen: Step[]): boolean => {
    const here = [...seen];
    for (const step of steps) {
      if (step.id === stepId) {
        before.push(...here);
        return true;
      }
      if (step.type === "branch") {
        for (const p of step.paths) if (walk(p.steps, here)) return true;
        if (step.else && walk(step.else, here)) return true;
      }
      here.push(step);
    }
    return false;
  };
  walk(draft.steps, []);
  for (const step of before) {
    if (step.type === "action") {
      const action = catalog.actions.find((a) => a.key === step.action);
      for (const field of action?.outputs ?? []) out.push({ ref: `steps.${step.id}.output.${field}`, label: `${step.name || action?.label || step.id} › ${field}`, group: "Earlier steps" });
    } else if (step.type === "transform") {
      for (const field of Object.keys(step.set)) out.push({ ref: `steps.${step.id}.output.${field}`, label: `${step.name || step.id} › ${field}`, group: "Earlier steps" });
    }
  }
  return out;
}
