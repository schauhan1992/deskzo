"use server";

import { revalidatePath } from "next/cache";
import { db, getTenantDb } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { runBackup } from "@/lib/backup/run";
import { dataResetEnabled, keptTables, RESET_PHRASE, resetAllData, resetOverview } from "@/lib/data-reset";
import { workspaceAccountsReset } from "@/lib/platform/account-hooks";
import { forgetAutomationUser } from "@/lib/automation-user";
import type { ActionResult } from "@/actions/company";

/**
 * TEMPORARY — the "reset all data" button on the Backups page. See src/lib/data-reset.ts, including
 * what to remove before production.
 *
 * Only the super admin, and only with `ENABLE_DATA_RESET=true`. Not a permission: a key can be
 * granted, and this must not be something anybody can be given.
 */

/** The super admin, or why the reset isn't available to this person — the panel isn't shown at all then. */
async function superAdmin(): Promise<{ user: { id: string; email: string } } | { refused: string }> {
  const session = await requireUser();
  if (!dataResetEnabled()) return { refused: "Resetting data is switched off — ENABLE_DATA_RESET=true isn't set." } as const;
  const user = await db.user.findUnique({ where: { id: session.id }, select: { id: true, name: true, email: true, isSuperAdmin: true } });
  return user?.isSuperAdmin ? { user } : ({ refused: "Only the super admin can reset data." } as const);
}

export async function getDataResetOverview() {
  const who = await superAdmin();
  if ("refused" in who) return null;
  const { user } = who;
  const overview = await resetOverview(await getTenantDb());
  return { ...overview, kept: keptTables().map((k) => k.what), you: user.email, phrase: RESET_PHRASE };
}

export async function resetAllDataNow(input: { confirm: string; backupFirst: boolean }): Promise<ActionResult<{ backup: string | null; tablesEmptied: number; usersRemoved: number }>> {
  const who = await superAdmin();
  if ("refused" in who) return { ok: false, error: who.refused };
  const { user } = who;
  if (typeof input?.confirm !== "string" || input.confirm.trim().toUpperCase() !== RESET_PHRASE) {
    return { ok: false, error: `Type ${RESET_PHRASE} to confirm.` };
  }

  // A copy first, so a reset pressed by mistake is a restore rather than a loss.
  let backup: string | null = null;
  if (input.backupFirst !== false) {
    const taken = await runBackup({ kind: "FULL", triggeredById: user.id });
    if (!taken.ok) return { ok: false, error: `The backup before the reset failed, so nothing was reset: ${taken.error}` };
    backup = taken.filename;
  }

  let outcome;
  try {
    outcome = await resetAllData(await getTenantDb(), user.id);
  } catch (err) {
    console.error("data reset failed", err);
    return { ok: false, error: `The reset failed and nothing was changed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Every account the reset deleted loses its links to other workspaces, and the email index follows.
  // Here, from the workspace's own request, not in resetAllData: that also runs against scratch
  // databases in check:data-reset, where "the current workspace" would be the developer's own.
  await workspaceAccountsReset("reset");
  // The reset removed the Automation account with every other user; the next posting makes it again.
  await forgetAutomationUser();

  // The audit log was just emptied with everything else; this is its first line.
  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "Database",
    entityId: "all",
    entityLabel: `All data reset — ${outcome.tablesEmptied} tables emptied, ${outcome.usersRemoved} users removed${backup ? `, backup ${backup} taken first` : ", no backup taken"}`,
  });
  revalidatePath("/", "layout");
  return { ok: true, data: { backup, ...outcome } };
}
