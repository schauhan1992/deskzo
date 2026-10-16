import type { Role } from "@/lib/roles";
import { db } from "@/lib/db";
import { PERMISSIONS, heldByDefault } from "@/lib/permissions";
import { isHeld, type PermissionSource } from "@/lib/authz/resolve";
import { inactiveRoleKeys } from "@/lib/authz/role-registry";

/**
 * Resolving everybody at once.
 *
 * ## Why this exists separately
 *
 * `resolveUserPermissions` is right for one person and wrong for a hundred. It is memoised per
 * request, so a hundred distinct users means a hundred resolutions, each doing a user lookup and its
 * permission queries (it used to walk the org chart too, before managers stopped inheriting from their
 * reports). The roster and the "who can do X" screen both need every active person, and on this
 * database — 101 users — that was several hundred round trips and a request that did not finish.
 *
 * So the same data is fetched in **four queries**, and the precedence is applied per user from that.
 *
 * ## Why the precedence is written out again, and how it is kept honest
 *
 * Two implementations of an authorization rule is exactly the shape of bug this codebase keeps
 * finding, so it is not done lightly and it is not left to trust: `check:rbac` asserts that this
 * function and `resolveUserPermissions` agree, key for key, for every user in the database. If
 * somebody changes one and not the other, the check fails.
 *
 * This is a **read-only reporting path**. Nothing gates on it — `can()` is still the only gate — so
 * a disagreement shows up as a wrong number on a screen rather than as somebody getting in.
 */

export type BulkResolved = {
  userId: string;
  role: Role;
  isSuperAdmin: boolean;
  active: boolean;
  sources: Map<string, PermissionSource>;
};

export async function resolveEveryone(): Promise<Map<string, BulkResolved>> {
  const now = new Date();

  const [users, userRows, roleRows, switchedOff] = await Promise.all([
    db.user.findMany({
      select: { id: true, role: true, active: true, isSuperAdmin: true },
    }),
    db.userPermission.findMany({
      where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { userId: true, permission: true, allowed: true, grantedById: true, expiresAt: true, reason: true },
    }),
    db.rolePermission.findMany({ select: { role: true, permission: true, allowed: true } }),
    inactiveRoleKeys(),
  ]);

  const grantsByUser = new Map<string, Map<string, (typeof userRows)[number]>>();
  for (const row of userRows) {
    const map = grantsByUser.get(row.userId) ?? new Map();
    map.set(row.permission, row);
    grantsByUser.set(row.userId, map);
  }

  const roleOverride = new Map<string, boolean>();
  for (const row of roleRows) roleOverride.set(`${row.role}:${row.permission}`, row.allowed);

  const resolved = new Map<string, BulkResolved>();

  for (const user of users) {
    const sources = new Map<string, PermissionSource>();

    // Rule 1, then rule 2 — both before anything else is consulted.
    if (user.isSuperAdmin) {
      for (const def of PERMISSIONS) sources.set(def.key, { via: "superAdmin" });
      resolved.set(user.id, { userId: user.id, role: user.role, isSuperAdmin: true, active: user.active, sources });
      continue;
    }
    if (!user.active) {
      for (const def of PERMISSIONS) sources.set(def.key, { via: "inactive" });
      resolved.set(user.id, { userId: user.id, role: user.role, isSuperAdmin: false, active: false, sources });
      continue;
    }
    // Rule 2b.
    if (switchedOff.has(user.role)) {
      for (const def of PERMISSIONS) sources.set(def.key, { via: "roleInactive", role: user.role });
      resolved.set(user.id, { userId: user.id, role: user.role, isSuperAdmin: false, active: false, sources });
      continue;
    }

    const grants = grantsByUser.get(user.id);

    for (const def of PERMISSIONS) {
      // Rule 3.
      const grant = grants?.get(def.key);
      if (grant) {
        sources.set(def.key, {
          via: "userGrant",
          allowed: grant.allowed,
          grantedBy: grant.grantedById,
          expiresAt: grant.expiresAt,
          reason: grant.reason,
        });
        continue;
      }

      // Rule 4.
      const override = roleOverride.get(`${user.role}:${def.key}`);
      if (override !== undefined) {
        sources.set(def.key, { via: "roleOverride", role: user.role, allowed: override });
        continue;
      }

      if (user.role === "ADMIN") {
        sources.set(def.key, { via: "adminDefault" });
        continue;
      }

      if (heldByDefault(def, user.role)) {
        sources.set(def.key, { via: "roleDefault", role: user.role });
        continue;
      }

      // Rule 5: nothing else grants it. Managers no longer inherit from their reports (resolve.ts).
      sources.set(def.key, { via: "none" });
    }

    resolved.set(user.id, { userId: user.id, role: user.role, isSuperAdmin: false, active: user.active, sources });
  }

  return resolved;
}

/** The single-user path's own "does this count as held" test, so the two can't drift apart. */
export function holdsFrom(source: PermissionSource | undefined): boolean {
  return isHeld(source);
}
