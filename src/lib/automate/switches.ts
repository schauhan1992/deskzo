import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { requestWakeHere } from "@/lib/automate/wake";

/**
 * Deskzo Automate's two kill switches. Either one stops every run from starting or moving on until it
 * is lifted; runs keep their place and carry on afterwards.
 *
 *   · The workspace's own (`automation_settings`), set by its admins on the Automate page.
 *   · The platform's (`automate.enabled` = "0" in the control plane), set by staff in the console —
 *     every workspace at once. Read fresh by the worker each pass; one it can't read counts as paused.
 */

const PLATFORM_SWITCH = "automate.enabled";

export type PauseState = { paused: boolean; pausedAt: Date | null; pausedById: string | null };

/** The workspace's switch, inside it. A workspace without the table yet is not paused — it has nothing to run either. */
export async function workspacePause(): Promise<PauseState> {
  try {
    const row = await db.automationSettings.findUnique({ where: { id: "global" }, select: { pausedAt: true, pausedById: true } });
    return { paused: !!row?.pausedAt, pausedAt: row?.pausedAt ?? null, pausedById: row?.pausedById ?? null };
  } catch (err) {
    if (notMigratedYet(err)) return { paused: false, pausedAt: null, pausedById: null };
    throw err;
  }
}

export async function setWorkspacePaused(paused: boolean, byUserId: string): Promise<void> {
  const data = paused ? { pausedAt: new Date(), pausedById: byUserId } : { pausedAt: null, pausedById: null };
  await db.automationSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  // Lifted: whatever waited is looked at on the next pass.
  if (!paused) await requestWakeHere();
}

/** The platform's switch, as stored. Not paused without a control plane. */
export async function platformPause(): Promise<{ paused: boolean; updatedBy: string | null; updatedAt: Date | null }> {
  if (!controlConfigured()) return { paused: false, updatedBy: null, updatedAt: null };
  const row = await controlDb().platformSetting.findUnique({ where: { key: PLATFORM_SWITCH }, select: { value: true, updatedBy: true, updatedAt: true } });
  return { paused: row?.value === "0", updatedBy: row?.updatedBy ?? null, updatedAt: row?.updatedAt ?? null };
}

/** For the worker: paused when switched off, and when the switch can't be read. */
export async function platformPausedForWorker(): Promise<boolean> {
  try {
    return (await platformPause()).paused;
  } catch (err) {
    console.error(`[automate] could not read ${PLATFORM_SWITCH}, so every workflow waits this pass`, err instanceof Error ? err.message : err);
    return true;
  }
}

/** Saves the platform's switch under `by` (a staff member's id). The console's action audits it. */
export async function setPlatformPaused(paused: boolean, by: string): Promise<void> {
  const value = paused ? "0" : "1";
  await controlDb().platformSetting.upsert({ where: { key: PLATFORM_SWITCH }, create: { key: PLATFORM_SWITCH, value, updatedBy: by }, update: { value, updatedBy: by } });
}
