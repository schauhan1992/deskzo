import type { Prisma } from "@prisma/client";
import { notMigratedYet } from "@/lib/not-migrated";
import { requestWakeHere } from "@/lib/automate/wake";

/**
 * Recording that something happened, for workflows to start from (Deskzo Automate's event log).
 *
 * Called inside the business write's own transaction — `emitEvent(tx, …)` — so the event exists
 * exactly when the change does: a rolled-back change leaves none. The insert sits behind a savepoint,
 * so a workspace whose database doesn't have the table yet loses the event, never the change.
 *
 * The payload carries ids and the fields that changed, never a whole record. An event a run caused
 * names that run and is one level deeper, which is how workflows are kept from feeding each other
 * for ever (src/lib/automate/engine.ts).
 */

export type EmitInput = {
  /** "task.created" — the trigger types are listed in src/lib/automate/triggers.ts. */
  type: string;
  recordType?: string;
  recordId?: string;
  payload: Record<string, unknown>;
  actorUserId?: string | null;
  causedByRunId?: string | null;
  depth?: number;
};

export async function emitEvent(tx: Prisma.TransactionClient, input: EmitInput): Promise<void> {
  await tx.$executeRawUnsafe(`SAVEPOINT "automate_emit"`);
  try {
    await tx.automationEvent.create({
      data: {
        type: input.type,
        recordType: input.recordType ?? null,
        recordId: input.recordId ?? null,
        payload: input.payload as Prisma.InputJsonValue,
        actorUserId: input.actorUserId ?? null,
        causedByRunId: input.causedByRunId ?? null,
        depth: input.depth ?? 0,
      },
    });
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT "automate_emit"`);
  } catch (err) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT "automate_emit"`);
    if (notMigratedYet(err)) console.warn(`[automate] the ${input.type} event was not recorded: this workspace has not been migrated yet`);
    else console.error(`[automate] the ${input.type} event was not recorded`, err instanceof Error ? err.message : err);
    return;
  }
  // Outside the transaction, and harmless if it rolls back after all: the worker just finds nothing.
  // A few seconds ahead, so the transaction has committed by the time the worker looks.
  void requestWakeHere(new Date(Date.now() + 3_000));
}
