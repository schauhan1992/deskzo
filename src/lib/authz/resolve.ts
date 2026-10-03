import { cache } from "react";
import { SUPPORT_READONLY_ROLE, type Role } from "@/lib/roles";
import { db } from "@/lib/db";
import { getDownlineUserIds } from "@/lib/org-chart";
import { getPermissionDefinition, PERMISSIONS, type PermissionKey } from "@/lib/permissions";
import type { Clock } from "@/lib/time/zone";

/**
 * The one place that decides whether somebody may do something.
 *
 * A **plain module**, deliberately — not `"use server"`. Every export from one of those is a
 * client-callable endpoint, and `hasEffectivePermission(userId, key)` being one meant any signed-in
 * user could interrogate anybody else's permissions a key at a time. An authorization oracle is a
 * reconnaissance tool: it tells an attacker exactly which account to go after. The action layer
 * keeps a wrapper for compatibility, but it resolves the *session* rather than trusting a userId
 * from the caller.
 *
 * ## Precedence — the first rule that fires is final
 *
 *   0. Unknown key            → DENY, and throw in development.
 *   1. Super admin            → ALLOW everything. No table is read.
 *   2. Inactive account       → DENY everything.
 *   3. Per-user grant         → its `allowed`, final. A denial here beats the role.
 *   4. Own role               → an explicit override row is final; absence falls through.
 *   5. Downline inheritance   → ALLOW if a report's role grants it, for delegable keys only.
 *   6. Otherwise              → DENY.
 *
 * The asymmetry in rule 4 is the important one and it is deliberate: an **explicit** role denial is
 * final, while **implicit** absence from `defaultRoles` is not. Without it, an admin who unticks a
 * cell in the matrix would watch the downline silently put it back — which is what made the old
 * matrix a lie. Unticking now means something.
 */

export type PermissionSource =
  | { via: "superAdmin" }
  | { via: "inactive" }
  | { via: "userGrant"; allowed: boolean; grantedBy: string | null; expiresAt: Date | null; reason: string | null }
  | { via: "roleOverride"; role: Role; allowed: boolean }
  | { via: "roleDefault"; role: Role }
  | { via: "adminDefault" }
  | { via: "supportReadOnly"; allowed: boolean }
  | { via: "downline"; role: Role; through: { id: string; name: string } }
  | { via: "none" };

export type ResolvedPermissions = {
  userId: string;
  role: Role | null;
  isSuperAdmin: boolean;
  active: boolean;
  /** Every key the registry declares, mapped to why it is or is not held. */
  sources: Map<string, PermissionSource>;
};

function allowed(source: PermissionSource): boolean {
  switch (source.via) {
    case "superAdmin":
    case "roleDefault":
    case "adminDefault":
    case "downline":
      return true;
    case "userGrant":
      return source.allowed;
    case "roleOverride":
      return source.allowed;
    case "supportReadOnly":
      return source.allowed;
    case "inactive":
    case "none":
      return false;
  }
}

/** A permission that only lets somebody look: `leads.view`, `companies.viewAll`, `hr.viewReports`. */
export function isViewPermission(key: string): boolean {
  return /\.view(?:[A-Z]\w*)?$/.test(key);
}

/**
 * Resolves everything about one user in a single pass, memoised for the request.
 *
 * React's `cache()` scopes this to one render, so a request that draws the sidebar, gates the page
 * and runs three server actions resolves once rather than nine times. That matters more than it
 * sounds: the previous `hasEffectivePermission` ran its own downline walk *and* a query per role on
 * every single call, so going from 8 permission-gated nav items to a full registry would have put
 * dozens of round trips on every page.
 */
export const resolveUserPermissions = cache(async (userId: string): Promise<ResolvedPermissions> => {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, active: true, isSuperAdmin: true, kind: true },
  });

  const sources = new Map<string, PermissionSource>();

  /**
   * The workspace's Automation account (src/lib/automation-user.ts) holds nothing, whatever its role
   * and whatever is granted to it. Nobody signs in as it, and the postings it makes never ask the
   * permission system. It can't be a super admin (the database refuses that), so rule 1 is not skipped.
   */
  if (!user || user.kind === "AUTOMATION") {
    for (const def of PERMISSIONS) sources.set(def.key, { via: "none" });
    return { userId, role: null, isSuperAdmin: false, active: false, sources };
  }

  // Rule 1. Before any table read, so no configuration change can lock a super admin out of the
  // screen that would undo it.
  if (user.isSuperAdmin) {
    for (const def of PERMISSIONS) sources.set(def.key, { via: "superAdmin" });
    return { userId, role: user.role, isSuperAdmin: true, active: user.active, sources };
  }

  // Rule 2. Previously a deactivated user still appeared in downline walks, so a switched-off admin
  // sitting under somebody kept handing that person every permission an admin has.
  if (!user.active) {
    for (const def of PERMISSIONS) sources.set(def.key, { via: "inactive" });
    return { userId, role: user.role, isSuperAdmin: false, active: false, sources };
  }

  /**
   * The platform's support staff on a read-only grant (src/lib/platform/support.ts): every "view"
   * permission and nothing else — computed, like the admin's, so each new view permission is theirs on
   * the day it ships and each new change permission never is. No grant, override or downline applies.
   */
  if (user.role === SUPPORT_READONLY_ROLE) {
    for (const def of PERMISSIONS) sources.set(def.key, { via: "supportReadOnly", allowed: isViewPermission(def.key) });
    return { userId, role: user.role, isSuperAdmin: false, active: true, sources };
  }

  const [userRows, roleRows] = await Promise.all([
    db.userPermission.findMany({
      where: { userId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      select: { permission: true, allowed: true, grantedById: true, expiresAt: true, reason: true },
    }),
    db.rolePermission.findMany({ where: { role: user.role }, select: { permission: true, allowed: true } }),
  ]);

  const userGrants = new Map(userRows.map((r) => [r.permission, r]));
  const roleOverrides = new Map(roleRows.map((r) => [r.permission, r.allowed]));

  // The downline is walked at most once, and only if some key actually falls through to rule 5.
  let downlineRoles: { role: Role; through: { id: string; name: string } }[] | null = null;
  const loadDownline = async () => {
    if (downlineRoles) return downlineRoles;
    const ids = await getDownlineUserIds(userId);
    if (ids.length === 0) {
      downlineRoles = [];
      return downlineRoles;
    }
    const reports = await db.user.findMany({
      where: { id: { in: ids }, active: true },
      select: { id: true, name: true, role: true },
    });
    downlineRoles = reports
      // Never inherit upward from an admin. Previously `roles.includes("ADMIN") return true` meant
      // that re-parenting a retiring admin under somebody made that person an admin in all but name.
      .filter((r) => r.role !== "ADMIN")
      .map((r) => ({ role: r.role, through: { id: r.id, name: r.name } }));
    return downlineRoles;
  };

  // Downline role overrides are read in one query rather than per report.
  let downlineOverrides: Map<string, boolean> | null = null;
  const loadDownlineOverrides = async (roles: Role[]) => {
    if (downlineOverrides) return downlineOverrides;
    const rows = await db.rolePermission.findMany({
      where: { role: { in: roles } },
      select: { role: true, permission: true, allowed: true },
    });
    downlineOverrides = new Map(rows.map((r) => [`${r.role}:${r.permission}`, r.allowed]));
    return downlineOverrides;
  };

  for (const def of PERMISSIONS) {
    // Rule 3.
    const grant = userGrants.get(def.key);
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
    const override = roleOverrides.get(def.key);
    if (override !== undefined) {
      sources.set(def.key, { via: "roleOverride", role: user.role, allowed: override });
      continue;
    }

    // An admin holds everything unless explicitly denied above. Expressed here rather than by
    // seeding a row per key, because a seeded backfill silently misses every key added afterwards —
    // the admin would quietly lose each new capability on the day it shipped.
    if (user.role === "ADMIN") {
      sources.set(def.key, { via: "adminDefault" });
      continue;
    }

    if ((def.defaultRoles as readonly Role[]).includes(user.role)) {
      sources.set(def.key, { via: "roleDefault", role: user.role });
      continue;
    }

    // Rule 5.
    if (def.delegable === false) {
      sources.set(def.key, { via: "none" });
      continue;
    }

    const reports = await loadDownline();
    if (reports.length === 0) {
      sources.set(def.key, { via: "none" });
      continue;
    }

    const overrides = await loadDownlineOverrides(Array.from(new Set(reports.map((r) => r.role))));
    let inherited: PermissionSource | null = null;
    for (const report of reports) {
      const explicit = overrides.get(`${report.role}:${def.key}`);
      const grants = explicit !== undefined ? explicit : (def.defaultRoles as readonly Role[]).includes(report.role);
      if (grants) {
        inherited = { via: "downline", role: report.role, through: report.through };
        break;
      }
    }
    sources.set(def.key, inherited ?? { via: "none" });
  }

  return { userId, role: user.role, isSuperAdmin: false, active: true, sources };
});

/**
 * Whether this user holds this permission.
 *
 * An unknown key throws in development and denies in production. It throws rather than warns
 * because a mistyped key is indistinguishable from a denied one at runtime — which is how
 * `payments.manage` disabled three modules for every non-admin without anybody noticing.
 */
export async function can(userId: string, key: PermissionKey | string): Promise<boolean> {
  if (!getPermissionDefinition(key)) {
    if (process.env.NODE_ENV !== "production") {
      throw new Error(`Unknown permission key "${key}". Add it to PERMISSIONS in src/lib/permissions.ts.`);
    }
    return false;
  }
  const resolved = await resolveUserPermissions(userId);
  return allowed(resolved.sources.get(key) ?? { via: "none" });
}

/** Every key this user holds — what the sidebar and the client-side gates are built from. */
export async function permissionsFor(userId: string): Promise<PermissionKey[]> {
  const resolved = await resolveUserPermissions(userId);
  return PERMISSIONS.filter((def) => allowed(resolved.sources.get(def.key) ?? { via: "none" })).map(
    // Widened back to the key union: `PERMISSIONS` carries the declared type, whose `key` is a plain
    // string, but every member of it came from the registry so the cast states a fact rather than a
    // hope. `check:rbac` asserts the two lists agree.
    (def) => def.key as PermissionKey,
  );
}

/**
 * Why this user does or does not hold this permission.
 *
 * Powers the "effective permissions" drawer in Settings. An admin looking at somebody who
 * unexpectedly has payroll access needs to be told *where it came from* — a role default, a
 * personal grant, or a report they inherited it through — because each has a different fix.
 */
export async function explain(userId: string, key: PermissionKey | string): Promise<PermissionSource> {
  const resolved = await resolveUserPermissions(userId);
  return resolved.sources.get(key) ?? { via: "none" };
}

/**
 * A one-line, human explanation of a source, for the drawer and the audit screen. A grant's end is
 * kept as the midnight that ends its last day, so the day named is the one before it, on the
 * workspace's clock.
 */
export function describeSource(source: PermissionSource, clock: Clock): string {
  switch (source.via) {
    case "superAdmin":
      return "Super admin — holds everything, and cannot be restricted.";
    case "inactive":
      return "The account is deactivated.";
    case "userGrant":
      return source.allowed
        ? `Granted to this person directly${source.reason ? ` — ${source.reason}` : ""}${source.expiresAt ? `, until ${clock.date(new Date(source.expiresAt.getTime() - 1))}` : ""}.`
        : `Denied to this person directly${source.reason ? ` — ${source.reason}` : ""}, overriding their role.`;
    case "roleOverride":
      return source.allowed
        ? `Switched on for ${source.role} in the permission matrix.`
        : `Switched off for ${source.role} in the permission matrix.`;
    case "roleDefault":
      return `Comes with the ${source.role} role.`;
    case "adminDefault":
      return "Admins hold everything not explicitly switched off.";
    case "supportReadOnly":
      return source.allowed ? "Platform support on a read-only grant: may look." : "Platform support on a read-only grant: may not change anything.";
    case "downline":
      return `Inherited from ${source.through.name}, who reports to them and holds it as ${source.role}.`;
    case "none":
      return "Not held.";
  }
}
