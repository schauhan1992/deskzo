import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { notMigratedYet } from "@/lib/not-migrated";
import { currentTenant } from "@/lib/tenancy/resolve";
import type { ActionContext } from "@/lib/automate/action-types";

/**
 * Steps that reached outside Deskzo — an email, a webhook, a message — recorded in the control plane
 * before they are done (Deskzo Automate, Phase 8), because a workspace restored from a backup forgets
 * whatever its own database learned after the backup was taken.
 *
 * The workspace's own mark (`automation_effects`, src/lib/automate/effects.ts) stops a step being done
 * twice while the database remembers it. After a restore it may not: the backup can predate the step.
 * The run comes back as it was then, reaches the step again, and finds no mark. This record is outside
 * the database a restore rewinds, so the step is found here instead, and the run waits for a person
 * (UNKNOWN) rather than send it twice.
 *
 * Keyed by the run's idempotency key — the same for a run brought back by a restore, and for one made
 * again from the same event or the same schedule slot — and the step's key (for-each rounds apart).
 * Kept as long as a run may live (120 days). An installation without a control plane keeps none.
 */

const KEEP_MS = 120 * 86_400_000;

/** The step's key across a restore: the run's idempotency key in place of its id. */
export function sentKey(ctx: Pick<ActionContext, "key" | "runId" | "runKey">): string {
  return ctx.runKey ? `${ctx.runKey}${ctx.key.slice(ctx.runId.length)}` : ctx.key;
}

async function tenantIdHere(): Promise<string | null> {
  return controlConfigured() ? (await currentTenant()).id : null;
}

/**
 * Records that the step is being done. "seen": it was recorded before — done, or begun, before the
 * workspace was restored. "off": nothing kept here (no control plane, or not migrated yet).
 */
export async function noteSending(key: string): Promise<"new" | "seen" | "off"> {
  const tenantId = await tenantIdHere();
  if (!tenantId) return "off";
  try {
    const rows = await controlDb().$queryRaw<{ key: string }[]>`
      INSERT INTO "automation_sent_steps" ("tenantId", "key", "sentAt") VALUES (${tenantId}, ${key}, now())
      ON CONFLICT ("tenantId", "key") DO NOTHING
      RETURNING "key"`;
    return rows.length ? "new" : "seen";
  } catch (err) {
    if (notMigratedYet(err)) return "off";
    throw err;
  }
}

/** The step certainly wasn't done (a refusal, a failure that sent nothing), or a person says to do it again. */
export async function forgetSending(keys: string[]): Promise<void> {
  if (!keys.length) return;
  const tenantId = await tenantIdHere();
  if (!tenantId) return;
  try {
    await controlDb().automationSentStep.deleteMany({ where: { tenantId, key: { in: keys } } });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
}

/** Records older than any run may live — the platform worker's sweep. */
export async function pruneSent(now: Date = new Date()): Promise<number> {
  if (!controlConfigured()) return 0;
  try {
    return (await controlDb().automationSentStep.deleteMany({ where: { sentAt: { lt: new Date(now.getTime() - KEEP_MS) } } })).count;
  } catch (err) {
    if (notMigratedYet(err)) return 0;
    throw err;
  }
}
