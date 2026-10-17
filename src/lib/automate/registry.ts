import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { moduleAccessFor } from "@/lib/modules-access";
import { ActionError, type ActionDefinition } from "@/lib/automate/action-types";
import { notifyPerson } from "@/lib/automate/actions/notify-person";
import { taskCreate } from "@/lib/automate/actions/task-create";

/**
 * Every action a workflow can take (Deskzo Automate). Phase 2 adds the Deskzo actions — assign a lead,
 * email, change a stage — and Phase 4 the outside ones; each goes through `checkActor` here before
 * it runs, so a workflow can never do more than its owner may do now.
 */

export const ACTIONS: readonly ActionDefinition<never, unknown>[] = [taskCreate, notifyPerson] as unknown as ActionDefinition<never, unknown>[];

export function actionByKey(key: string): ActionDefinition<unknown, unknown> | null {
  return (ACTIONS.find((a) => a.key === key) as ActionDefinition<unknown, unknown> | undefined) ?? null;
}

/** Why this person may not take this action now, or null when they may. Inside the workspace (`runAsTenant`). */
export async function actorRefusal(actorId: string, action: ActionDefinition<unknown, unknown>): Promise<string | null> {
  const person = await db.user.findUnique({ where: { id: actorId }, select: { active: true } });
  if (!person?.active) return "The workflow's owner is no longer an active user.";
  const access = await moduleAccessFor(actorId, action.module);
  if (access === "not-entitled") return `"${action.label}" needs a module this workspace's plan doesn't include.`;
  if (access === "switched-off") return `"${action.label}" needs a module the workspace has switched off.`;
  if (access === "no-permission") return `The workflow's owner can't use "${action.label}".`;
  if (action.permission && !(await can(actorId, action.permission))) return `The workflow's owner doesn't hold the permission "${action.label}" needs.`;
  return null;
}

export async function checkActor(actorId: string, action: ActionDefinition<unknown, unknown>): Promise<void> {
  const refusal = await actorRefusal(actorId, action);
  if (refusal) throw new ActionError(refusal, "PERMANENT");
}
