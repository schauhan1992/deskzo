import { z } from "zod";
import { db } from "@/lib/db";
import { mayAccess, type AccessAction, type AccessRecord } from "@/lib/authz/access";
import { ActionError, type ActionContext } from "@/lib/automate/action-types";

/**
 * What Deskzo Automate's actions share: how they name records and people, and the one question every
 * action on a record asks first — whether the workflow's owner may act on it now (src/lib/authz/access.ts).
 * A record that isn't there and one out of their reach are refused in the same words, as a page refuses
 * them, so a workflow is never a way of finding out what exists.
 */

/** A record's id, usually from the trigger: `{{trigger.lead.id}}`. */
export const recordIdField = (what: string) => z.string().trim().min(1, `Say which ${what}.`).max(60);

/** "owner" (the workflow's owner), or a person's id. */
export const personField = z.string().trim().min(1, "Choose who.").max(40);

export function notReached(what: string): ActionError {
  return new ActionError(`The ${what} isn't there, or the workflow's owner can't reach it.`, "PERMANENT");
}

/** Refuses unless the workflow's owner may act this way on this record now. */
export async function reach(ctx: ActionContext, record: AccessRecord, action: AccessAction, id: string, what: string): Promise<void> {
  if (!(await mayAccess(ctx.actorId, record, action, id))) throw notReached(what);
}

export type Person = { id: string; name: string; email: string | null };

/** "owner" or a person's id, as somebody active — or refused, saying who it was meant to be. */
export async function activePerson(ctx: ActionContext, who: string, role: string): Promise<Person> {
  const id = who === "owner" ? ctx.actorId : who;
  const person = await db.user.findUnique({ where: { id }, select: { id: true, name: true, email: true, active: true } });
  if (!person?.active) throw new ActionError(`The ${role} isn't an active user.`, "PERMANENT");
  return { id: person.id, name: person.name, email: person.email };
}

/** "by workflow "Welcome new leads"", for the audit and the timeline. */
export function byWorkflow(ctx: ActionContext): string {
  return `by workflow “${ctx.workflowName}”`;
}
