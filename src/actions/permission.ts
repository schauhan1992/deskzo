"use server";

import { revalidatePath } from "next/cache";
import type { Role } from "@prisma/client";
import { db } from "@/lib/db";
import { rolePermits } from "@/lib/authz/role-permission";
import { requireUser } from "@/lib/session";
import { ROLES } from "@/lib/roles";
import { PERMISSIONS, getPermissionDefinition, permissionGroup, type PermissionKey } from "@/lib/permissions";
import { can, permissionsFor, explain, resolveUserPermissions, describeSource } from "@/lib/authz/resolve";
import { holdsFrom, resolveEveryone } from "@/lib/authz/bulk";
import { actorContext, assertGrantWithinOwnAuthority, AuthzError } from "@/lib/authz/guards";
import { recordPermissionChange } from "@/lib/authz/audit";
import type { ActionResult } from "@/actions/company";

/**
 * The action surface over the resolver in src/lib/authz/resolve.ts.
 *
 * Thin on purpose. The decisions live in the plain module so that scripts can exercise them without
 * a session and so that they are not, themselves, endpoints — see the note at the top of that file
 * about the permission oracle.
 */

/**
 * Kept with its original name and signature because 55 files import it, but the body has changed in
 * one important way: it no longer answers questions about *other* people.
 *
 * Passing an arbitrary userId used to make this a client-callable oracle — any signed-in user could
 * map out precisely which colleague held which capability, which is the reconnaissance step before
 * choosing an account to go after. It now refuses any id but the caller's own, except for a caller
 * who legitimately reviews access. Existing call sites all pass the session user's id, so none of
 * them change.
 */
export async function hasEffectivePermission(userId: string, key: PermissionKey | string): Promise<boolean> {
  const session = await requireUser();
  if (userId !== session.id) {
    const mayReview = await can(session.id, "permissions.view");
    if (!mayReview) return false;
  }
  return can(userId, key);
}

/** Every permission the signed-in user holds. Drives the sidebar. */
export async function navPermissions(userId: string): Promise<PermissionKey[]> {
  const session = await requireUser();
  if (userId !== session.id && !(await can(session.id, "permissions.view"))) return [];
  return permissionsFor(userId);
}

/**
 * The matrix behind the permission screen.
 *
 * ADMIN is now a real, configurable column rather than a hardcoded `true`. That is the user's
 * "admin can be given permissions at top level": a super admin can genuinely revoke `payroll.manage`
 * from admins, and it takes effect. A super admin remains outside the matrix entirely — the
 * resolver answers before it reads any of this.
 */
export async function getPermissionMatrix() {
  // Gated: this is the whole authorization policy in one object. Ungated it told any caller
  // exactly which role holds which capability — the map you would consult before deciding whose
  // account to go after.
  const session = await requireUser();
  if (!(await can(session.id, "permissions.view"))) return [];

  const rows = await db.rolePermission.findMany();
  const overrides = new Map(rows.map((r) => [`${r.role}:${r.permission}`, r.allowed]));

  return PERMISSIONS.map((perm) => ({
    key: perm.key,
    label: perm.label,
    description: perm.description,
    group: permissionGroup(perm),
    delegable: perm.delegable !== false,
    superAdminOnly: perm.superAdminOnly === true,
    selfExcluded: perm.selfExcluded === true,
    tier: perm.tier ?? "standard",
    defaultRoles: perm.defaultRoles as readonly Role[],
    roles: Object.fromEntries(
      ROLES.map((role) => [
        role,
        overrides.get(`${role}:${perm.key}`) ??
          // Absent an override, an admin holds everything and everyone else holds their defaults.
          (role === "ADMIN" ? true : (perm.defaultRoles as readonly Role[]).includes(role)),
      ]),
    ) as Record<Role, boolean>,

    /**
     * Where each answer came from, which the screen had no way to show.
     *
     * The matrix collapsed "on because the registry says so" and "on because somebody switched it
     * on" into one boolean, and they are different facts with different consequences. `applyPreset`
     * writes an explicit row for **every** key — deliberately, so a later change to a registry
     * default cannot silently move a role somebody had pinned — which means that after any preset
     * the entire column is pinned and the screen looked exactly as it did before. An admin could
     * not tell, and `resetRolePermission` sat there offering to undo something invisible.
     */
    explicit: Object.fromEntries(
      ROLES.map((role) => [role, overrides.has(`${role}:${perm.key}`)]),
    ) as Record<Role, boolean>,
  }));
}

/**
 * Changes what a role can do.
 *
 * Three guards that did not exist before: only a super admin may alter what ADMIN holds, nobody may
 * grant a permission they do not hold themselves, and every change is recorded.
 */
export async function setRolePermission(
  role: Role,
  key: PermissionKey | string,
  allowed: boolean,
): Promise<ActionResult<null>> {
  const session = await requireUser();
  const actor = await actorContext(session.id);

  if (!actor.isSuperAdmin && !(await can(actor.id, "permissions.manage"))) {
    return { ok: false, error: "You can't change role permissions." };
  }

  const def = getPermissionDefinition(key);
  if (!def) return { ok: false, error: "Unknown permission." };

  // Admins are configurable now, but only from above. Otherwise an admin could quietly widen the
  // admin role and every other admin inherits it.
  if (role === "ADMIN" && !actor.isSuperAdmin) {
    return { ok: false, error: "Only a super admin can change what admins can do." };
  }

  try {
    await assertGrantWithinOwnAuthority(actor, key);
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.message };
    throw err;
  }

  const before = await rolePermits(role, key);
  await db.rolePermission.upsert({
    where: { role_permission: { role, permission: key } },
    update: { allowed },
    create: { role, permission: key, allowed },
  });

  await recordPermissionChange({
    actorUserId: actor.id,
    subjectType: "ROLE",
    subjectRole: role,
    permission: key,
    fromAllowed: before,
    toAllowed: allowed,
    changeKind: allowed ? "GRANT" : "REVOKE",
    detail: `${def.label} for ${role}`,
  });

  revalidatePath("/settings/access");
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

/** Clears a role override, returning the role to the registry default. */
export async function resetRolePermission(role: Role, key: PermissionKey | string): Promise<ActionResult<null>> {
  const session = await requireUser();
  const actor = await actorContext(session.id);
  if (!actor.isSuperAdmin && !(await can(actor.id, "permissions.manage"))) {
    return { ok: false, error: "You can't change role permissions." };
  }
  if (role === "ADMIN" && !actor.isSuperAdmin) {
    return { ok: false, error: "Only a super admin can change what admins can do." };
  }

  /**
   * The same authority check `setRolePermission` makes, because resetting is a grant too.
   *
   * Returning a key to its registry default restores it for every role the default covers. Without
   * this, an admin refused by `setRolePermission` ("you can't grant what you don't hold") simply
   * used the reset arrow beside it and got the same outcome — the guard was a step to walk around
   * rather than a boundary.
   */
  try {
    await assertGrantWithinOwnAuthority(actor, key);
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.message };
    throw err;
  }

  await db.rolePermission.deleteMany({ where: { role, permission: key } });
  await recordPermissionChange({
    actorUserId: actor.id,
    subjectType: "ROLE",
    subjectRole: role,
    permission: key,
    changeKind: "RESET_TO_DEFAULT",
    detail: `${key} for ${role} returned to its default`,
  });
  revalidatePath("/settings/access");
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

/**
 * Everything about one person's access, and why — the effective-permissions drawer.
 *
 * "Why does she have this" is the question an access review actually asks, and it was previously
 * unanswerable: the matrix showed role defaults while the enforcement path walked the downline, so
 * the screen and the behaviour disagreed. Both now read the same resolver.
 */
export async function effectivePermissionsFor(userId: string) {
  const session = await requireUser();
  if (userId !== session.id && !(await can(session.id, "permissions.view"))) return null;

  const resolved = await resolveUserPermissions(userId);
  const target = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, role: true, active: true, isSuperAdmin: true },
  });
  if (!target) return null;

  return {
    user: target,
    permissions: PERMISSIONS.map((def) => {
      const source = resolved.sources.get(def.key) ?? { via: "none" as const };
      return {
        key: def.key,
        label: def.label,
        group: permissionGroup(def),
        tier: def.tier ?? "standard",
        held: source.via !== "none" && source.via !== "inactive" && !(source.via === "userGrant" && !source.allowed) && !(source.via === "roleOverride" && !source.allowed),
        via: source.via,
        why: describeSource(source),
      };
    }),
  };
}

/** Why one specific permission resolves the way it does. */
export async function explainPermission(userId: string, key: PermissionKey | string) {
  const session = await requireUser();
  if (userId !== session.id && !(await can(session.id, "permissions.view"))) return null;
  const source = await explain(userId, key);
  return { source, why: describeSource(source) };
}

// ─── The reverse index ────────────────────────────────────────────────────────

/**
 * Everybody who holds one permission, and how each of them came by it.
 *
 * The question an audit actually asks — "list everyone who can approve an invoice" — and the one
 * the role matrix cannot answer by construction. The matrix shows role defaults; it cannot show a
 * personal grant, a personal deny, `adminDefault`, or a key reaching somebody through a report. For
 * `payroll.manage`, whose `defaultRoles` is empty, the matrix shows the column off for all eight
 * roles, which reads as "nobody" while every admin in fact holds it.
 *
 * Costed deliberately: one `resolveUserPermissions` per active user, which at ~30 staff is thirty
 * memoised resolutions — the same call the access drawer already makes once. If this company grows
 * past a few hundred people it wants a different shape, and the honest place to notice that is here
 * rather than in a timeout.
 */
export async function holdersOf(key: PermissionKey | string) {
  const session = await requireUser();
  if (!(await can(session.id, "permissions.view"))) return null;

  const def = getPermissionDefinition(key);
  if (!def) return null;

  const [users, everyone] = await Promise.all([
    db.user.findMany({
      where: { active: true },
      orderBy: [{ role: "asc" }, { name: "asc" }],
      select: { id: true, name: true, email: true, role: true, isSuperAdmin: true },
    }),
    resolveEveryone(),
  ]);

  const holders: {
    id: string;
    name: string;
    email: string;
    role: string;
    via: string;
    why: string;
    expiresAt: Date | null;
  }[] = [];
  const denied: { id: string; name: string; role: string; why: string }[] = [];

  for (const user of users) {
    const source = everyone.get(user.id)?.sources.get(key) ?? { via: "none" as const };
    const held = holdsFrom(source);

    if (held) {
      holders.push({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        via: source.via,
        why: describeSource(source),
        expiresAt: source.via === "userGrant" ? (source.expiresAt ?? null) : null,
      });
    } else if (source.via === "userGrant" || source.via === "roleOverride") {
      // Told apart from "never had it", because somebody deliberately took this away and that is a
      // different fact — the one an access review is looking for.
      denied.push({ id: user.id, name: user.name, role: user.role, why: describeSource(source) });
    }
  }

  return {
    permission: { key: def.key, label: def.label, description: def.description, group: permissionGroup(def), tier: def.tier ?? "standard" },
    holders,
    denied,
    consideredUsers: users.length,
  };
}

/** Just the registry, for a picker. No resolution, so it is cheap. */
export async function permissionCatalogue() {
  const session = await requireUser();
  if (!(await can(session.id, "permissions.view"))) return [];
  return PERMISSIONS.map((def) => ({
    key: def.key,
    label: def.label,
    group: permissionGroup(def),
    tier: def.tier ?? "standard",
  }));
}

/**
 * The roster, with how much access each person actually has.
 *
 * "Holds 47 of 74" is the number that makes an access review start in the right place — it is the
 * difference between a sales executive and somebody who has quietly accumulated a manager's reach.
 * Neither the team table nor the matrix could show it; you had to open each drawer in turn.
 *
 * One resolution per person, memoised for the request. At this company's size that is thirty; the
 * comment on `holdersOf` says what to do if that ever stops being true.
 */
export async function accessRoster() {
  const session = await requireUser();
  if (!(await can(session.id, "permissions.view"))) return [];

  const [users, exceptions] = await Promise.all([
    db.user.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        active: true,
        isSuperAdmin: true,
        department: { select: { name: true } },
        manager: { select: { id: true, name: true } },
      },
    }),
    db.userPermission.groupBy({ by: ["userId"], _count: { _all: true } }),
  ]);

  const exceptionCount = new Map(exceptions.map((e) => [e.userId, e._count._all]));
  const now = Date.now();

  const soonRows = await db.userPermission.findMany({
    where: { expiresAt: { not: null } },
    select: { userId: true, expiresAt: true },
  });
  const lapsingSoon = new Set(
    soonRows
      .filter((r) => r.expiresAt !== null && r.expiresAt.getTime() - now <= 7 * 86_400_000)
      .map((r) => r.userId),
  );

  const total = PERMISSIONS.length;

  // One pass over the whole company rather than one resolution per person — see src/lib/authz/bulk.ts.
  const everyone = await resolveEveryone();

  return Promise.all(
    users.map(async (user) => {
      const resolved = everyone.get(user.id);
      let holds = 0;
      for (const def of PERMISSIONS) {
        if (holdsFrom(resolved?.sources.get(def.key))) holds += 1;
      }
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        active: user.active,
        isSuperAdmin: user.isSuperAdmin,
        department: user.department?.name ?? null,
        managerName: user.manager?.name ?? null,
        holds,
        total,
        exceptions: exceptionCount.get(user.id) ?? 0,
        // Amber on the roster rather than buried in a drawer: an expiry nobody notices is the
        // reason "temporary" access stops being temporary.
        lapsingSoon: lapsingSoon.has(user.id),
      };
    }),
  );
}
