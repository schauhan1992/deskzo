"use server";

import { revalidatePath } from "next/cache";
import { refuseWhileViewingAs, requireUser } from "@/lib/session";
import { cancelWorkspaceReset, requestWorkspaceReset } from "@/lib/workspace-reset";
import type { ActionResult } from "@/actions/company";

/**
 * The workspace reset on Settings › Backups (owner, 22 Oct 2026 — src/lib/workspace-reset.ts): the super
 * admin schedules it, a day out; an admin who looks after backups can cancel it until it starts. Not
 * while viewing as somebody else — that would be somebody else's password confirming it.
 */
export async function scheduleWorkspaceReset(input: { confirm: string; password: string; code?: string }): Promise<ActionResult<{ runAfter: Date }> & { needsCode?: boolean }> {
  const user = await requireUser();
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };
  const outcome = await requestWorkspaceReset(user.id, { confirm: input?.confirm, password: input?.password, code: input?.code });
  if (!outcome.ok) return { ok: false, error: outcome.error, needsCode: outcome.needsCode };
  revalidatePath("/settings/backups");
  return { ok: true, data: { runAfter: outcome.runAfter } };
}

export async function cancelScheduledReset(): Promise<ActionResult<null>> {
  const user = await requireUser();
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };
  const outcome = await cancelWorkspaceReset(user.id);
  if (!outcome.ok) return outcome;
  revalidatePath("/settings/backups");
  return { ok: true, data: null };
}
