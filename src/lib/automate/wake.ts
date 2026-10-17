import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { currentTenant } from "@/lib/tenancy/resolve";

/**
 * Which workspaces have Automate work due (control plane `automation_wake`), so the platform worker
 * opens only those rather than every workspace's database on every pass.
 *
 *   · Anything that makes work due — an event, a new run, a delay, a retry, a schedule — asks for a
 *     wake at a time: the row keeps the earlier of what it had and what was asked, and its `version`
 *     goes up.
 *   · The worker reads the due rows, works each workspace, then settles the row to that workspace's
 *     next due time — but only if `version` is still the one it read. A wake asked for while it
 *     worked is never pushed back.
 *
 * Without a control plane (an installation from before workspaces, a check suite), or with the table
 * not there yet, there is no list: asking does nothing and the worker looks at every workspace.
 * Never throws — a lost wake is caught by the worker's slow sweep.
 */

export type DueWake = { tenantId: string; version: number };

function missingTable(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /automation_wake|P2021|42P01/.test(text);
}

/** Ask for the worker to look at a workspace at `at` (now, when not given). */
export async function requestWake(tenantId: string, at: Date = new Date()): Promise<void> {
  if (!controlConfigured()) return;
  try {
    await controlDb().$executeRaw`
      INSERT INTO "automation_wake" ("tenantId", "nextDueAt", "version", "updatedAt")
      VALUES (${tenantId}, ${at}, 1, now())
      ON CONFLICT ("tenantId") DO UPDATE
        SET "nextDueAt" = LEAST("automation_wake"."nextDueAt", EXCLUDED."nextDueAt"),
            "version" = "automation_wake"."version" + 1,
            "updatedAt" = now()`;
  } catch (err) {
    if (!missingTable(err)) console.error(`[automate] could not ask for a wake for ${tenantId}`, err);
  }
}

/** The same, for the workspace this code is running as. */
export async function requestWakeHere(at: Date = new Date()): Promise<void> {
  try {
    await requestWake((await currentTenant()).id, at);
  } catch (err) {
    console.error("[automate] could not ask for a wake", err);
  }
}

/** Workspaces due now, or null when there is no list to read (look at every workspace instead). */
export async function dueWakes(now: Date = new Date()): Promise<DueWake[] | null> {
  if (!controlConfigured()) return null;
  try {
    return await controlDb().automationWake.findMany({
      where: { nextDueAt: { lte: now } },
      select: { tenantId: true, version: true },
      orderBy: { nextDueAt: "asc" },
      take: 200,
    });
  } catch (err) {
    if (!missingTable(err)) console.error("[automate] could not read the wake list", err);
    return null;
  }
}

/** After working a workspace: its next due time, or no row when nothing is due — unless a newer wake came in. */
export async function settleWake(tenantId: string, readVersion: number | null, next: Date | null): Promise<void> {
  if (!controlConfigured()) return;
  try {
    if (readVersion === null) {
      // Worked without reading the list (a sweep): only ever move a wake earlier.
      if (next) await requestWake(tenantId, next);
      return;
    }
    if (next) {
      await controlDb().automationWake.updateMany({ where: { tenantId, version: readVersion }, data: { nextDueAt: next } });
    } else {
      await controlDb().automationWake.deleteMany({ where: { tenantId, version: readVersion } });
    }
  } catch (err) {
    if (!missingTable(err)) console.error(`[automate] could not settle the wake for ${tenantId}`, err);
  }
}

/** Rows for workspaces that are gone, or waiting past `staleMs` — for the console's health page. */
export async function overdueWakes(staleMs: number, now: Date = new Date()): Promise<{ tenantId: string; nextDueAt: Date }[]> {
  if (!controlConfigured()) return [];
  try {
    return await controlDb().automationWake.findMany({
      where: { nextDueAt: { lt: new Date(now.getTime() - staleMs) } },
      select: { tenantId: true, nextDueAt: true },
      orderBy: { nextDueAt: "asc" },
      take: 50,
    });
  } catch {
    return [];
  }
}
