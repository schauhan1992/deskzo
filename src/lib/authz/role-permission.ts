import type { Role } from "@/lib/roles";
import { db } from "@/lib/db";
import { getPermissionDefinition, type PermissionDefinition, type PermissionKey, heldByDefault } from "@/lib/permissions";

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
  return row?.allowed ?? roleDefault(def, role);
}

/**
 * What a role holds with nothing stored for it: everything for Admin, unless a super admin takes it
 * away; the registry's defaults for every other role (a custom role's are none but the sections).
 * The one statement of it — the screens, the presets and account creation all ask here, and the
 * resolver applies the same two rules (src/lib/authz/resolve.ts rule 4).
 */
export function roleDefault(def: PermissionDefinition, role: Role): boolean {
  return role === "ADMIN" || heldByDefault(def, role);
}

/**
 * Everything one role grants, read once: its stored answers over its defaults — `rolePermits` for
 * every key at a time, for screens and checks that ask about many.
 */
export async function roleGrants(role: Role): Promise<(key: PermissionKey | string) => boolean> {
  const rows = await db.rolePermission.findMany({ where: { role }, select: { permission: true, allowed: true } });
  const stored = new Map(rows.map((r) => [r.permission, r.allowed]));
  return (key) => {
    const def = getPermissionDefinition(key);
    if (!def) return false;
    return stored.get(key) ?? roleDefault(def, role);
  };
}
