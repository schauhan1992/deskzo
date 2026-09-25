import type { Role } from "@/lib/roles";
import { db } from "@/lib/db";
import { getPermissionDefinition, type PermissionKey } from "@/lib/permissions";

/**
 * What a *role* grants, with no user involved.
 *
 * This lived in `src/actions/permission.ts`, which makes it a server action — an endpoint any
 * signed-in session could call, one cell at a time, to read back the entire authorisation policy.
 * `getPermissionMatrix` sits three functions below it and is gated on `permissions.view` for
 * precisely that reason ("the map you would consult before deciding whose account to go after");
 * this was the same map through a slower door, and it only ever had three callers, all of them
 * server-side.
 *
 * So it lives here instead, where it is a function rather than an endpoint, and there is nothing
 * left to gate.
 */
export async function rolePermits(role: Role, key: PermissionKey | string): Promise<boolean> {
  const def = getPermissionDefinition(key);
  if (!def) return false;

  const row = await db.rolePermission.findUnique({ where: { role_permission: { role, permission: key } } });

  /**
   * An admin holds everything unless a super admin has explicitly taken it away, which is why the
   * fallback differs by role rather than by definition.
   */
  if (role === "ADMIN") return row?.allowed ?? true;
  return row?.allowed ?? (def.defaultRoles as readonly Role[]).includes(role);
}
