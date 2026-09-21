"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { hasEffectivePermission } from "@/actions/permission";
import { auth } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { logActivity } from "@/lib/activity";
import { clearViewAsCookie, resolveViewAs, setViewAsCookie } from "@/lib/impersonation";
import { UnauthorizedError } from "@/lib/session";
import type { ActionResult } from "@/actions/company";

/**
 * Starting and ending a "view as" session.
 *
 * Both of these deliberately read the raw session rather than `requireUser()`: `requireUser()`
 * already resolves impersonation, so using it here would mean an admin two levels in could not tell
 * who they really were — and `stopViewingAs` would be asking the borrowed account for permission to
 * give itself back.
 */

async function requireAdminActor() {
  const session = await auth();
  if (!session?.user) throw new UnauthorizedError();
  const actor = await db.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, role: true, active: true, isSuperAdmin: true },
  });
  return actor;
}

export async function startViewingAs(targetUserId: string): Promise<ActionResult<{ name: string }>> {
  const actor = await requireAdminActor();
  if (!actor?.active) throw new UnauthorizedError();

  // Read from the database, not the JWT: an admin demoted five minutes ago still carries ADMIN in
  // their token until it is re-issued, and this is the last place that should trust a stale claim.
  if (!(await hasEffectivePermission(actor.id, "impersonation.use"))) {
    return { ok: false, error: "Only an administrator can view the app as another user." };
  }

  // No chaining. Already being someone else and then becoming a third person makes the audit trail
  // ambiguous about who authorised what, for no use anyone has asked for.
  if (await resolveViewAs(actor.id)) {
    return { ok: false, error: "Switch back to yourself first, then pick someone else." };
  }

  if (targetUserId === actor.id) {
    return { ok: false, error: "You're already yourself." };
  }

  const target = await db.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, name: true, active: true, isSuperAdmin: true },
  });
  if (!target) return { ok: false, error: "That user no longer exists." };
  if (!target.active) return { ok: false, error: `${target.name}'s account is deactivated.` };

  /**
   * An ordinary admin may not borrow a super admin's account.
   *
   * `assertMayActOnTarget` states this rule everywhere else, and its absence here made the whole
   * tier decorative by a different route: inside a borrowed super-admin session every gate that
   * reads `actor.isSuperAdmin` passes, so an admin holding nothing but `impersonation.use` could
   * view as the super admin and call `setSuperAdmin` **on their own account** — `assertNotSelf`
   * compares the borrowed id against the target, so it does not fire, and the promotion is
   * permanent. Viewing is not a lesser act than editing when what you are viewing is the authority
   * to edit.
   */
  if (target.isSuperAdmin && !actor.isSuperAdmin) {
    return { ok: false, error: "Only a super admin can view the app as another super admin." };
  }

  await setViewAsCookie(actor.id, target.id);

  // Recorded against the admin, under their own name, before the substitution takes effect — so
  // starting a session is visible even if nothing is changed during it.
  await recordAudit({
    userId: actor.id,
    action: "UPDATE",
    entityType: "User",
    entityId: target.id,
    entityLabel: `Started viewing the app as ${target.name}`,
  });
  // Attributed to the admin, not the borrowed account: the activity log's whole job here is to say
  // who was really at the keyboard.
  await logActivity({
    kind: "IMPERSONATION_STARTED",
    userId: actor.id,
    userName: actor.name,
    summary: `${actor.name} started viewing the app as ${target.name}`,
    entityType: "User",
    entityId: target.id,
    metadata: { targetUserId: target.id, targetName: target.name },
  });

  revalidatePath("/", "layout");
  return { ok: true, data: { name: target.name } };
}

export async function stopViewingAs(): Promise<ActionResult<null>> {
  const session = await auth();
  if (!session?.user) throw new UnauthorizedError();

  const context = await resolveViewAs(session.user.id);
  await clearViewAsCookie();

  if (context) {
    await recordAudit({
      userId: context.actor.id,
      action: "UPDATE",
      entityType: "User",
      entityId: context.user.id,
      entityLabel: `Stopped viewing the app as ${context.user.name}`,
    });
    await logActivity({
      kind: "IMPERSONATION_ENDED",
      userId: context.actor.id,
      userName: context.actor.name,
      summary: `${context.actor.name} stopped viewing the app as ${context.user.name}`,
      entityType: "User",
      entityId: context.user.id,
    });
  }

  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

/**
 * Who an admin can step into. Themselves excluded, deactivated accounts excluded — there is nothing
 * to see in an account that cannot sign in.
 */
export async function listViewAsTargets() {
  const actor = await requireAdminActor();
  if (!actor || !(await hasEffectivePermission(actor.id, "impersonation.use"))) return [];
  return db.user.findMany({
    // Filtered here as well as guarded in `startViewingAs`: offering a name that the next click
    // refuses is the invitation-to-a-locked-door problem, and this particular door is the one that
    // hands over the system.
    where: {
      active: true,
      id: { not: actor.id },
      ...(actor.isSuperAdmin ? {} : { isSuperAdmin: false }),
    },
    orderBy: [{ role: "asc" }, { name: "asc" }],
    select: { id: true, name: true, email: true, role: true, department: { select: { name: true } } },
  });
}
