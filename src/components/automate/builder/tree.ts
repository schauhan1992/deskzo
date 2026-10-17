import { childLists, mapChildLists, type Definition, type Step } from "@/lib/automate/definition";
import type { Catalog } from "@/lib/automate/catalog";

/**
 * The builder's draft as a tree it edits (Deskzo Automate, Phase 3) — pure, so every change is a new
 * draft and undo is just the old one. Steps are found by id: ids are unique across a workflow, and a
 * step keeps its id for life, because later steps refer to its output by it.
 *
 * A place in the tree — where a new step goes — is a slot: the top-level list, or one of a step's
 * lists by the key src/lib/automate/definition.ts `childLists` gives it: a branch's paths (0, 1…) and
 * else (-1), an approval's approved (0) and rejected (1), a for-each's steps (0), a parallel step's
 * paths (0, 1, 2).
 */

export type Slot = { branchId: string | null; path: number | null };
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

/** An approval's lists exist once the builder shows them, so a step can be added to either. */
function withLists(step: Step): Step {
  return step.type === "approval" ? { ...step, approved: step.approved ?? [], rejected: step.rejected ?? [] } : step;
}

function mapSteps(steps: Step[], fn: (list: Step[], slot: Slot) => Step[], slot: Slot = ROOT): Step[] {
  return fn(steps, slot).map((step) => mapChildLists(withLists(step), (list, path) => mapSteps(list, fn, { branchId: step.id, path })));
}

const sameSlot = (a: Slot, b: Slot) => a.branchId === b.branchId && a.path === b.path;

export function allSteps(steps: Step[], out: Step[] = []): Step[] {
  for (const step of steps) {
    out.push(step);
    for (const list of childLists(step)) allSteps(list.steps, out);
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
  const copy = (s: Step): Step => mapChildLists({ ...(JSON.parse(JSON.stringify(s)) as Step), id: fresh(s.id) }, (list) => list.map(copy));
  return copy(step);
}

export type DataRef = { ref: string; label: string; group: string };

/** What a step's outputs offer the steps after it. */
function outputsOf(step: Step, catalog: Catalog): DataRef[] {
  const name = (fallback: string) => step.name || fallback;
  switch (step.type) {
    case "action": {
      const action = catalog.actions.find((a) => a.key === step.action);
      return (action?.outputs ?? []).map((field) => ({ ref: `steps.${step.id}.output.${field}`, label: `${name(action?.label || step.id)} › ${field}`, group: "Earlier steps" }));
    }
    case "transform":
      return Object.keys(step.set).map((field) => ({ ref: `steps.${step.id}.output.${field}`, label: `${name(step.id)} › ${field}`, group: "Earlier steps" }));
    case "approval":
      return ["decision", "decidedBy", "comment", "timedOut"].map((field) => ({ ref: `steps.${step.id}.output.${field}`, label: `${name("Approval")} › ${field}`, group: "Earlier steps" }));
    case "waitForEvent":
      return [
        { ref: `steps.${step.id}.output.timedOut`, label: `${name("Wait")} › timed out`, group: "Earlier steps" },
        ...(catalog.triggers.find((t) => t.type === step.event)?.paths ?? []).map((p) => ({ ref: `steps.${step.id}.output.event.${p.ref.slice("trigger.".length)}`, label: `${name("Wait")} › event › ${p.label}`, group: "Earlier steps" })),
      ];
    case "forEach":
      return [{ ref: `steps.${step.id}.output.count`, label: `${name("For each")} › count`, group: "Earlier steps" }];
    default:
      return [];
  }
}

/**
 * What a step may read: the trigger's fields, and the outputs of the steps that have run by then — the
 * ones before it on its own path, and before the lists it sits in; inside a for-each, the item this
 * time round; after a parallel step, its paths' steps. As the publish check sees it
 * (src/lib/automate/validate.ts), so the picker never offers what publishing would refuse.
 */
export function dataBefore(draft: Draft, stepId: string | null, catalog: Catalog): DataRef[] {
  const trigger = catalog.triggers.find((t) => t.type === draft.trigger.type);
  const out: DataRef[] = (trigger?.paths ?? []).map((p) => ({ ...p, group: "What started it" }));
  if (stepId === null) return out;
  const before: Step[] = [];
  const loops: Step[] = [];
  const walk = (steps: Step[], seen: Step[], around: Step[]): boolean => {
    const here = [...seen];
    for (const step of steps) {
      if (step.id === stepId) {
        before.push(...here);
        loops.push(...around.filter((s) => s.type === "forEach"));
        return true;
      }
      for (const list of childLists(step)) {
        // An approval's own output is there inside its lists; a for-each's item, inside its steps.
        if (walk(list.steps, step.type === "approval" ? [...here, step] : here, [...around, step])) return true;
      }
      here.push(step);
      if (step.type === "parallel") for (const inner of allSteps(step.paths.flatMap((p) => p.steps))) here.push(inner);
    }
    return false;
  };
  walk(draft.steps, [], []);
  for (const loop of loops) {
    out.push({ ref: `steps.${loop.id}.output.item`, label: `${loop.name || "For each"} › the item`, group: "This time round" });
    out.push({ ref: `steps.${loop.id}.output.index`, label: `${loop.name || "For each"} › which item (from 0)`, group: "This time round" });
  }
  for (const step of before) out.push(...outputsOf(step, catalog));
  return out;
}
