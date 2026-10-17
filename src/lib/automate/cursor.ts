import type { Definition, Step } from "@/lib/automate/definition";

/**
 * Where a run has got to in its definition (Deskzo Automate). Pure.
 *
 * A stack of frames, one per list of steps it is inside: the top level, then each branch path it
 * took. A frame says which branch (by step id) and which path (-1 for else), and the index of the
 * step it is on. Stored on the run and saved after every step, so a run picks up exactly where it was.
 */

export type Frame = { branch?: string; path?: number; index: number };
export type Cursor = { frames: Frame[] };

export function startCursor(): Cursor {
  return { frames: [{ index: 0 }] };
}

function listOf(definition: Definition, frames: Frame[], depth: number): Step[] | null {
  let list: Step[] = definition.steps;
  for (let i = 1; i <= depth; i++) {
    const parent = frames[i - 1]!;
    const frame = frames[i]!;
    const owner = list[parent.index];
    if (!owner || owner.type !== "branch" || owner.id !== frame.branch) return null;
    const path = frame.path ?? -1;
    const next = path === -1 ? owner.else : owner.paths[path]?.steps;
    if (!next) return null;
    list = next;
  }
  return list;
}

/**
 * The step to run now, with the cursor tidied: a list that has run out hands back to the list it is
 * in, one step on. Null when the run has nothing left. A cursor that no longer fits the definition
 * (it never should: a run keeps its version) also reads as nothing left.
 */
export function currentStep(definition: Definition, cursor: Cursor): { step: Step | null; cursor: Cursor } {
  const frames = cursor.frames.map((f) => ({ ...f }));
  while (frames.length > 0) {
    const depth = frames.length - 1;
    const list = listOf(definition, frames, depth);
    if (!list) return { step: null, cursor: { frames } };
    const frame = frames[depth]!;
    if (frame.index < list.length) return { step: list[frame.index]!, cursor: { frames } };
    frames.pop();
    if (frames.length > 0) frames[frames.length - 1]!.index += 1;
  }
  return { step: null, cursor: { frames } };
}

/** One step on, in the same list. */
export function advance(cursor: Cursor): Cursor {
  const frames = cursor.frames.map((f) => ({ ...f }));
  frames[frames.length - 1]!.index += 1;
  return { frames };
}

/** Into a branch's path (-1 for else), at its first step. The branch is the step the cursor is on. */
export function enterBranch(cursor: Cursor, branchId: string, path: number): Cursor {
  return { frames: [...cursor.frames.map((f) => ({ ...f })), { branch: branchId, path, index: 0 }] };
}

export function isCursor(value: unknown): value is Cursor {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as Cursor).frames) &&
    (value as Cursor).frames.every((f) => f && typeof f.index === "number" && f.index >= 0)
  );
}
