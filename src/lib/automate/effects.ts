import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { ActionContext } from "@/lib/automate/action-types";

/**
 * Doing an action once, however often its step is tried (Deskzo Automate).
 *
 * The action's write and an `automation_effects` row under `runId:stepId` commit together. A retry —
 * after a worker died, or a lease ran out and another took the run over — finds the row and gets the
 * first try's output back, with `fresh` false, instead of a second lead or task. Side effects that
 * can't share the transaction (a notification) go after it, and only when `fresh`: told at most once
 * rather than twice.
 */

type Written<T> = { output: T; recordType?: string; recordId?: string };

export async function withEffect<T>(ctx: ActionContext, write: (tx: Prisma.TransactionClient) => Promise<Written<T>>): Promise<{ output: T; fresh: boolean }> {
  const done = await db.automationEffect.findUnique({ where: { key: ctx.key }, select: { output: true } });
  if (done) return { output: done.output as T, fresh: false };
  try {
    const output = await db.$transaction(async (tx) => {
      const written = await write(tx);
      await tx.automationEffect.create({
        data: {
          key: ctx.key,
          runId: ctx.runId,
          recordType: written.recordType ?? null,
          recordId: written.recordId ?? null,
          output: written.output as Prisma.InputJsonValue,
        },
      });
      return written.output;
    });
    return { output, fresh: true };
  } catch (err) {
    // Another worker finished the same step a moment ago: its output is the one that stands.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const again = await db.automationEffect.findUnique({ where: { key: ctx.key }, select: { output: true } });
      if (again) return { output: again.output as T, fresh: false };
    }
    throw err;
  }
}
