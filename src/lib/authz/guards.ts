import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can, resolveUserPermissions } from "@/lib/authz/resolve";
import { getPermissionDefinition, type PermissionKey } from "@/lib/permissions";

/**
 * The rules that are code, not configuration.
 *
 * Everything else in this module is a setting an admin can change. These are not, and that is the
 * point: a control you can switch off from inside the application is a control that eventually
 * gets switched off. There is exactly one active admin on this installation, so "the last one is
 * demoted by accident" is not a hypothetical — it is one careless click from being the end of
 * anybody administering anything.
 */

export class AuthzError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthzError";
  }
}

/**
 * Refuses to let the last super admin disappear.
 *
 * Runs inside the caller's transaction, so the check and the write cannot be separated by another
 * request doing the same thing. Two admins demoting each other simultaneously would otherwise both
 * see "one other remains" and both succeed.
 *
 * Note the shape of the query. `SELECT count(*) ... FOR UPDATE` is not valid Postgres — row locking
 * is rejected with an aggregate — so the rows are selected and locked, and counted here. Dropping
 * `FOR UPDATE` instead would compile and reintroduce exactly the race this exists to prevent.
 */
export async function assertSuperAdminRemains(tx: Prisma.TransactionClient, excludingUserId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "users"
    WHERE "isSuperAdmin" = true AND "active" = true AND "id" <> ${excludingUserId}
    FOR UPDATE
  `;
  if (rows.length === 0) {
    throw new AuthzError(
      "That would leave nobody with super admin access, and nobody could put it back. Promote someone else first.",
    );
  }
}

/**
 * An ordinary admin may not act on a super admin.
 *
 * Without this, the tier is decorative: an admin could simply deactivate the super admin and
 * inherit an unguarded system.
 */
export function assertMayActOnTarget(
  actor: { id: string; isSuperAdmin: boolean },
  target: { id: string; isSuperAdmin: boolean },
) {
  if (target.isSuperAdmin && !actor.isSuperAdmin) {
    throw new AuthzError("Only a super admin can change another super admin's account.");
  }
}

/**
 * Nobody changes their own role, super-admin flag or active status.
 *
 * Generalises the existing self-deactivation guard, whose absence on the *role* path was the
 * two-click lockout: the sole admin demotes themselves to SALES and there is no longer any account
 * that can undo it.
 */
export function assertNotSelf(actorId: string, targetId: string, what: string) {
  if (actorId === targetId) {
    throw new AuthzError(`You can't change your own ${what}. Ask another admin.`);
  }
}

/**
 * You may only grant what you hold yourself.
 *
 * This is the rule that stops delegation from being escalation. Without it, the moment a super
 * admin grants somebody the ability to manage permissions, that person can grant themselves
 * everything else — and `permissions.manage` becomes a synonym for super admin.
 */
export async function assertGrantWithinOwnAuthority(
  actor: { id: string; isSuperAdmin: boolean },
  key: PermissionKey | string,
) {
  if (actor.isSuperAdmin) return;

  const def = getPermissionDefinition(key);
  if (!def) throw new AuthzError(`Unknown permission "${key}".`);

  if (def.superAdminOnly) {
    throw new AuthzError(`"${def.label}" can only be granted by a super admin.`);
  }
  if (!(await can(actor.id, key))) {
    throw new AuthzError(`You can't grant "${def.label}" because you don't hold it yourself.`);
  }
}

/**
 * The two keys that open and change the access screens. Taking either away from your own role is a
 * door you shut behind yourself: without View, Staff & roles no longer opens for you; without Change,
 * it opens read-only. Either way the change can't be undone from where it was made.
 */
export const OWN_ACCESS_KEYS = ["permissions.view", "permissions.manage"] as const;

/**
 * Nobody takes away their own way into the access screens through their role.
 *
 * The role path's version of `assertNotSelf`: somebody holding `permissions.manage` through their
 * role could untick it, or "Review who can do what", for that role and lock themselves out with it —
 * and if they were the only one holding it, nobody but the super admin could put it back. Refused
 * only when they hold the key *through that role*; somebody who also holds it personally keeps it
 * whatever the role says, so for them the change is just a change. A super admin holds everything
 * outside the permission system and is never caught by this.
 *
 * `allowedAfter` is what the role will grant once the change is made.
 */
export async function assertKeepsOwnAccessAdmin(
  actor: { id: string; role: string; isSuperAdmin: boolean },
  role: string,
  key: PermissionKey | string,
  allowedAfter: boolean,
) {
  if (actor.isSuperAdmin || allowedAfter || actor.role !== role) return;
  if (!(OWN_ACCESS_KEYS as readonly string[]).includes(key)) return;
  const resolved = await resolveUserPermissions(actor.id);
  const source = resolved.sources.get(key);
  const throughRole =
    source?.via === "roleDefault" ||
    source?.via === "adminDefault" ||
    (source?.via === "roleOverride" && source.allowed);
  if (!throughRole) return;
  const def = getPermissionDefinition(key);
  throw new AuthzError(
    `You can't take "${def?.label ?? key}" away from your own role — you'd lose the access you need to put it back. Ask another admin.`,
  );
}

/**
 * Separation of duties, as a property of the permission rather than a rule each action re-remembers.
 *
 * `selfExcluded` keys are the ones where approving your own work defeats the point — an order you
 * punched, an expense you claimed, an incentive you earned.
 */
export function assertNotOwnRecord(key: PermissionKey | string, actorId: string, recordOwnerId: string | null) {
  const def = getPermissionDefinition(key);
  if (!def?.selfExcluded) return;
  if (recordOwnerId && recordOwnerId === actorId) {
    throw new AuthzError(`You can't ${def.label.toLowerCase()} on something you raised yourself.`);
  }
}

/** The actor's own authorization facts, read from the database rather than the session token. */
export async function actorContext(userId: string) {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, role: true, active: true, isSuperAdmin: true },
  });
  if (!row) throw new AuthzError("That account no longer exists.");
  return row;
}
