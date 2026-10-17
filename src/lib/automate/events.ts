import type { Prisma } from "@prisma/client";
import { notMigratedYet } from "@/lib/not-migrated";
import { requestWakeHere } from "@/lib/automate/wake";

/**
 * Recording that something happened, for workflows to start from (Deskzo Automate's event log).
 *
 * Called inside the business write's own transaction — `emitEvent(tx, …)` — so the event exists
 * exactly when the change does: a rolled-back change leaves none.
 *
 * Everything an event needs — reading the record's fields and writing the row — happens behind one
 * savepoint (`emitEvents`), so nothing about recording it can ever fail the change itself: a
 * workspace whose database doesn't have the table, or a column a payload reads, yet loses the event,
 * never the change. A failed query inside a Postgres transaction would otherwise abort the whole of it.
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

/**
 * Builds and records events behind a savepoint. `build` reads whatever the payload needs with the same
 * `tx`, and returns the events (or none). Any failure is rolled back to the savepoint and logged.
 */
export async function emitEvents(tx: Prisma.TransactionClient, label: string, build: () => Promise<EmitInput | EmitInput[] | null>): Promise<void> {
  await tx.$executeRawUnsafe(`SAVEPOINT "automate_emit"`);
  let recorded = 0;
  try {
    const built = await build();
    for (const input of !built ? [] : Array.isArray(built) ? built : [built]) {
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
      recorded += 1;
    }
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT "automate_emit"`);
  } catch (err) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT "automate_emit"`);
    if (notMigratedYet(err)) console.warn(`[automate] the ${label} event was not recorded: this workspace has not been migrated yet`);
    else console.error(`[automate] the ${label} event was not recorded`, err instanceof Error ? err.message : err);
    return;
  }
  // Outside the transaction, and harmless if it rolls back after all: the worker just finds nothing.
  // A few seconds ahead, so the transaction has committed by the time the worker looks.
  if (recorded) void requestWakeHere(new Date(Date.now() + 3_000));
}

/** One event whose payload is already in hand. */
export async function emitEvent(tx: Prisma.TransactionClient, input: EmitInput): Promise<void> {
  await emitEvents(tx, input.type, async () => input);
}
