import { childList, type Definition, type Step } from "@/lib/automate/definition";

/**
 * Where a run has got to in its definition (Deskzo Automate). Pure.
 *
 * A stack of frames, one per list of steps it is inside: the top level, then each list it went into —
 * a branch's path, an approval's approved or rejected steps, a for-each's steps, a parallel path. A
 * frame says whose list it is (`branch`, the step's id: the name is Phase 1's) and which (`path`, the
 * key src/lib/automate/definition.ts `childLists` gives it), and the index of the step it is on.
 * Stored on the run and saved after every step, so a run picks up exactly where it was.
 *
 *   · `iteration` of `of`: which time round a for-each this is. When its steps run out it goes round
 *     again, until the last.
 *   · `paths`: a parallel step carried out in one run (a test), its paths one after another.
 *   · `scope`: a parallel path running as a run of its own ends there, rather than going on after the
 *     parallel step — the run it belongs to does that.
 */

export type Frame = { branch?: string; path?: number; index: number; iteration?: number; of?: number; paths?: number; scope?: boolean };
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
    if (!owner || owner.id !== frame.branch) return null;
    const next = childList(owner, frame.path ?? -1);
    if (!next) return null;
    list = next;
  }
  return list;
}

/**
 * The step to run now, with the cursor tidied: a list that has run out goes round again (a for-each),
 * on to the next path (a parallel step in one run), ends the run (a parallel path of its own), or hands
 * back to the list it is in, one step on. Null when the run has nothing left. A cursor that no longer
 * fits the definition (it never should: a run keeps its version) also reads as nothing left.
 */
export function currentStep(definition: Definition, cursor: Cursor): { step: Step | null; cursor: Cursor } {
  const frames = cursor.frames.map((f) => ({ ...f }));
  while (frames.length > 0) {
    const depth = frames.length - 1;
    const list = listOf(definition, frames, depth);
    if (!list) return { step: null, cursor: { frames } };
    const frame = frames[depth]!;
    if (frame.index < list.length) return { step: list[frame.index]!, cursor: { frames } };
    if (frame.of !== undefined && (frame.iteration ?? 0) + 1 < frame.of) {
      frame.iteration = (frame.iteration ?? 0) + 1;
      frame.index = 0;
      continue;
    }
    if (frame.paths !== undefined && (frame.path ?? 0) + 1 < frame.paths) {
      frame.path = (frame.path ?? 0) + 1;
      frame.index = 0;
      continue;
    }
    if (frame.scope) return { step: null, cursor: { frames } };
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

/** Into one of the lists of the step the cursor is on, at its first step. */
export function enterList(cursor: Cursor, ownerId: string, path: number, extra: Omit<Frame, "branch" | "path" | "index"> = {}): Cursor {
  return { frames: [...cursor.frames.map((f) => ({ ...f })), { branch: ownerId, path, index: 0, ...extra }] };
}

/** Into a branch's path (-1 for else), at its first step. The branch is the step the cursor is on. */
export function enterBranch(cursor: Cursor, branchId: string, path: number): Cursor {
  return enterList(cursor, branchId, path);
}

/**
 * A step's key in this run: its id, and which time round each for-each around it is — "remind#2",
 * "remind#2.0". What an action's effect, an approval and a wait are recorded under, so each time round
 * is its own and a step done once is never done again.
 */
export function stepKey(cursor: Cursor, stepId: string): string {
  const rounds = cursor.frames.filter((f) => f.of !== undefined).map((f) => f.iteration ?? 0);
  return rounds.length ? `${stepId}#${rounds.join(".")}` : stepId;
}

export function isCursor(value: unknown): value is Cursor {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as Cursor).frames) &&
    (value as Cursor).frames.every((f) => f && typeof f.index === "number" && f.index >= 0)
  );
}
