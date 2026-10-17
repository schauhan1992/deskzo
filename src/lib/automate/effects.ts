import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ActionError, type ActionContext, type FailureKind } from "@/lib/automate/action-types";

/**
 * Doing an action once, however often its step is tried (Deskzo Automate).
 *
 * The action's write and an `automation_effects` row under `runId:stepId` commit together. A retry —
 * after a worker died, or a lease ran out and another took the run over — finds the row and gets the
 * first try's output back, with `fresh` false, instead of a second lead or task. Side effects that
 * can't share the transaction (a notification) go after it, and only when `fresh`: told at most once
 * rather than twice.
 */

export type Written<T> = { output: T; recordType?: string; recordId?: string };

/**
 * What an earlier try of this step made, when it got as far as recording it — for an action that reads
 * before it writes (where a lead is now, who may take it), which must not decide afresh on a retry.
 */
export async function priorOutput<T>(ctx: ActionContext): Promise<{ output: T } | null> {
  const done = await db.automationEffect.findUnique({ where: { key: ctx.key }, select: { output: true } });
  if (!done) return null;
  if (isMarked(done.output)) throw unknownWhetherDone();
  return { output: done.output as T };
}

/** The step's record, in the transaction of what it made — for a write that runs its own transaction. */
export async function recordEffect<T>(tx: Prisma.TransactionClient, ctx: ActionContext, written: Written<T>): Promise<void> {
  await tx.automationEffect.create({
    data: {
      key: ctx.key,
      runId: ctx.runId,
      recordType: written.recordType ?? null,
      recordId: written.recordId ?? null,
      output: written.output as Prisma.InputJsonValue,
    },
  });
}

/** Whether an error is another worker having recorded the same step first. */
export function recordedAlready(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export async function withEffect<T>(ctx: ActionContext, write: (tx: Prisma.TransactionClient) => Promise<Written<T>>): Promise<{ output: T; fresh: boolean }> {
  const done = await priorOutput<T>(ctx);
  if (done) return { output: done.output, fresh: false };
  try {
    const output = await db.$transaction(async (tx) => {
      const written = await write(tx);
      await recordEffect(tx, ctx, written);
      return written.output;
    });
    return { output, fresh: true };
  } catch (err) {
    // Another worker finished the same step a moment ago: its output is the one that stands.
    if (recordedAlready(err)) {
      const again = await priorOutput<T>(ctx);
      if (again) return { output: again.output, fresh: false };
    }
    throw err;
  }
}

/** What a step did outside the database: its output, or why nothing was done and whether to try again. */
export type OutsideOutcome<T> = { ok: true; output: T; recordType?: string; recordId?: string } | { ok: false; error: string; kind: Exclude<FailureKind, "UNKNOWN"> };

/** The mark an effect row carries while the thing it records is being done. */
const SENDING = "$sending";

/**
 * Doing something outside the database once — an email, a calendar invitation — however often its
 * step is tried. It can't share a transaction with its record, so the record is written first, marked
 * as under way; the thing is done; and the record is then given its output.
 *
 *   · A try that finds the record finished gets the first try's output back, with `fresh` false.
 *   · A try that finds it still marked can't know whether the thing happened — the worker stopped
 *     between doing it and saying so — so the run waits for a person (UNKNOWN) rather than risk the
 *     customer getting the email twice.
 *   · A failure that certainly did nothing removes the mark, so the next try may do it.
 */
export async function withOutsideEffect<T>(ctx: ActionContext, act: () => Promise<OutsideOutcome<T>>): Promise<{ output: T; fresh: boolean }> {
  const done = await priorOutput<T>(ctx);
  if (done) return { output: done.output, fresh: false };
  try {
    await db.automationEffect.create({ data: { key: ctx.key, runId: ctx.runId, output: { [SENDING]: true } } });
  } catch (err) {
    // Another worker took the same step a moment ago, and is doing it, or did.
    if (recordedAlready(err)) throw unknownWhetherDone();
    throw err;
  }
  let outcome: OutsideOutcome<T>;
  try {
    outcome = await act();
  } catch (err) {
    // Thrown rather than answered: whether anything went out isn't known. The mark stays.
    throw new ActionError(`${err instanceof Error ? err.message : String(err)} — it isn't known whether it was done. Check before running it again.`, "UNKNOWN");
  }
  if (!outcome.ok) {
    await db.automationEffect.delete({ where: { key: ctx.key } });
    throw new ActionError(outcome.error, outcome.kind);
  }
  await db.automationEffect.update({
    where: { key: ctx.key },
    data: { output: outcome.output as Prisma.InputJsonValue, recordType: outcome.recordType ?? null, recordId: outcome.recordId ?? null },
  });
  return { output: outcome.output, fresh: true };
}

function unknownWhetherDone(): ActionError {
  return new ActionError("This step may have been done already — the worker stopped part way through it. Check, then run what's left by hand.", "UNKNOWN");
}

function isMarked(output: unknown): boolean {
  return !!output && typeof output === "object" && !Array.isArray(output) && (output as Record<string, unknown>)[SENDING] === true;
}
