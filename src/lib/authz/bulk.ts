import type { Role } from "@/lib/roles";
import { db } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import type { PermissionSource } from "@/lib/authz/resolve";

/**
 * Resolving everybody at once.
 *
 * ## Why this exists separately
 *
 * `resolveUserPermissions` is right for one person and wrong for a hundred. It is memoised per
 * request, so a hundred distinct users means a hundred resolutions, each doing a user lookup, two
 * permission queries and a breadth-first walk of the org chart that issues one query per level.
 * The roster and the "who can do X" screen both need every active person, and on this database —
 * 101 users — that was several hundred round trips and a request that did not finish.
 *
 * So the same data is fetched in **five queries**, the org chart is walked in memory, and the
 * precedence is applied per user from that.
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

  const [users, userRows, roleRows] = await Promise.all([
    db.user.findMany({
      select: { id: true, name: true, role: true, active: true, isSuperAdmin: true, managerId: true },
    }),
    db.userPermission.findMany({
      where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { userId: true, permission: true, allowed: true, grantedById: true, expiresAt: true, reason: true },
    }),
    db.rolePermission.findMany({ select: { role: true, permission: true, allowed: true } }),
  ]);

  const byId = new Map(users.map((u) => [u.id, u]));

  // Children by manager, so the downline walk is pointer-chasing rather than querying.
  const children = new Map<string, string[]>();
  for (const u of users) {
    if (!u.managerId) continue;
    const list = children.get(u.managerId) ?? [];
    list.push(u.id);
    children.set(u.managerId, list);
  }

  const grantsByUser = new Map<string, Map<string, (typeof userRows)[number]>>();
  for (const row of userRows) {
    const map = grantsByUser.get(row.userId) ?? new Map();
    map.set(row.permission, row);
    grantsByUser.set(row.userId, map);
  }

  const roleOverride = new Map<string, boolean>();
  for (const row of roleRows) roleOverride.set(`${row.role}:${row.permission}`, row.allowed);

  /** The same breadth-first walk `getDownlineUserIds` does, over the map instead of the database. */
  const downlineOf = (userId: string) => {
    const visited = new Set<string>([userId]);
    const out: { role: Role; through: { id: string; name: string } }[] = [];
    let frontier = [userId];
    for (let depth = 0; depth < 32 && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const childId of children.get(id) ?? []) {
          if (visited.has(childId)) continue;
          visited.add(childId);
          const child = byId.get(childId);
          if (!child) continue;
          // Deactivated accounts confer nothing, and an admin never confers upward — the two rules
          // `resolveUserPermissions` applies at the same point.
          if (child.active && child.role !== "ADMIN") {
            out.push({ role: child.role, through: { id: child.id, name: child.name } });
          }
          next.push(childId);
        }
      }
      frontier = next;
    }
    return out;
  };

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

    const grants = grantsByUser.get(user.id);
    let reports: ReturnType<typeof downlineOf> | null = null;

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

      if ((def.defaultRoles as readonly Role[]).includes(user.role)) {
        sources.set(def.key, { via: "roleDefault", role: user.role });
        continue;
      }

      if (def.delegable === false) {
        sources.set(def.key, { via: "none" });
        continue;
      }

      // Rule 5, and the walk is done at most once per person.
      reports ??= downlineOf(user.id);
      let inherited: PermissionSource | null = null;
      for (const report of reports) {
        const explicit = roleOverride.get(`${report.role}:${def.key}`);
        const grantsIt = explicit !== undefined ? explicit : (def.defaultRoles as readonly Role[]).includes(report.role);
        if (grantsIt) {
          inherited = { via: "downline", role: report.role, through: report.through };
          break;
        }
      }
      sources.set(def.key, inherited ?? { via: "none" });
    }

    resolved.set(user.id, { userId: user.id, role: user.role, isSuperAdmin: false, active: user.active, sources });
  }

  return resolved;
}

/** The same "does this count as held" test the single-user path uses. */
export function holdsFrom(source: PermissionSource | undefined): boolean {
  if (!source) return false;
  return (
    source.via !== "none" &&
    source.via !== "inactive" &&
    !(source.via === "userGrant" && !source.allowed) &&
    !(source.via === "roleOverride" && !source.allowed)
  );
}
