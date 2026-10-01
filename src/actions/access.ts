"use server";

import { revalidatePath } from "next/cache";
import type { Role } from "@/lib/roles";
import { db } from "@/lib/db";
import { rolePermits } from "@/lib/authz/role-permission";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import {
  actorContext,
  assertGrantWithinOwnAuthority,
  assertKeepsOwnAccessAdmin,
  assertMayActOnTarget,
  assertNotSelf,
  AuthzError,
  OWN_ACCESS_KEYS,
} from "@/lib/authz/guards";
import { recordPermissionChange } from "@/lib/authz/audit";
import { getPermissionDefinition, PERMISSIONS, type PermissionKey } from "@/lib/permissions";
import { getPreset, presetDiff } from "@/lib/authz/presets";

import type { ActionResult } from "@/actions/company";

/**
 * Per-user grants, role presets, and the super-admin flag.
 *
 * Kept apart from `src/actions/permission.ts`, which answers questions; everything here changes
 * who can do what. All of it runs through the guards in src/lib/authz/guards.ts — the rules that
 * are code rather than configuration, because a control you can switch off from inside the
 * application is one that eventually gets switched off.
 */

function refuse(err: unknown): ActionResult<never> {
  if (err instanceof AuthzError) return { ok: false, error: err.message };
  throw err;
}

async function mayAdminister() {
  const session = await requireUser();
  const actor = await actorContext(session.id);
  const allowed = actor.isSuperAdmin || (await can(actor.id, "permissions.manage"));
  return { actor, allowed };
}

// ─── Per-user grants ──────────────────────────────────────────────────────────────────────────

/**
 * Gives or denies one person one permission, regardless of their role.
 *
 * This is what makes the whole model usable in a real office: somebody covering maternity leave,
 * an accountant who also sells, a new joiner who should not touch payroll for a month. Without it
 * the only way to give one person one capability is to widen the entire role, which is how a
 * permission system quietly becomes decorative.
 */
/**
 * The moment a dated grant stops applying: the end of that day, where the reader lives.
 *
 * Built from local date parts rather than by appending \`T23:59:59.999Z\`, which is UTC — in India
 * that is half past five the following morning, so a grant given "until 30 Nov" quietly ran into
 * the 1st. Small, but it is an access grant outliving the day it was granted for, and the same
 * mistake in the e-way module expired every bill a day early.
 */
function expiryFromDate(date: string | null | undefined): Date | null {
  if (!date) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const end = new Date(Number(y), Number(m) - 1, Number(d));
  if (Number.isNaN(end.getTime())) return null;
  // Midnight at the end of that day.
  end.setDate(end.getDate() + 1);
  return end;
}

export async function setUserPermission(input: {
  userId: string;
  permission: PermissionKey | string;
  allowed: boolean;
  reason?: string;
  expiresAt?: string | null;
}): Promise<ActionResult<null>> {
  const { actor, allowed: mayManage } = await mayAdminister();
  if (!mayManage) return { ok: false, error: "You can't change permissions." };

  const def = getPermissionDefinition(input.permission);
  if (!def) return { ok: false, error: "Unknown permission." };

  const target = await db.user.findUnique({
    where: { id: input.userId },
    select: { id: true, name: true, isSuperAdmin: true },
  });
  if (!target) return { ok: false, error: "That user no longer exists." };

  try {
    assertMayActOnTarget(actor, target);
    // The rule that stops delegation from becoming escalation: you may only hand out what you hold.
    await assertGrantWithinOwnAuthority(actor, input.permission);
  } catch (err) {
    return refuse(err);
  }

  // A super admin already holds everything, so a row for them would be a lie that somebody later
  // reads as meaningful.
  if (target.isSuperAdmin) {
    return { ok: false, error: `${target.name} is a super admin and already holds every permission.` };
  }

  const existing = await db.userPermission.findUnique({
    where: { user_permission: { userId: input.userId, permission: input.permission } },
    select: { allowed: true },
  });

  await db.userPermission.upsert({
    where: { user_permission: { userId: input.userId, permission: input.permission } },
    update: {
      allowed: input.allowed,
      reason: input.reason?.trim() || null,
      grantedById: actor.id,
      expiresAt: expiryFromDate(input.expiresAt),
    },
    create: {
      userId: input.userId,
      permission: input.permission,
      allowed: input.allowed,
      reason: input.reason?.trim() || null,
      grantedById: actor.id,
      expiresAt: expiryFromDate(input.expiresAt),
    },
  });

  await recordPermissionChange({
    actorUserId: actor.id,
    subjectType: "USER",
    subjectUserId: input.userId,
    permission: input.permission,
    fromAllowed: existing?.allowed ?? null,
    toAllowed: input.allowed,
    changeKind: input.allowed ? "GRANT" : "REVOKE",
    detail: `${def.label} ${input.allowed ? "granted to" : "denied to"} ${target.name}${input.reason ? ` — ${input.reason}` : ""}`,
  });

  revalidatePath("/settings/access");
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

/** Removes a personal exception, returning the person to whatever their role gives them. */
export async function clearUserPermission(userId: string, permission: string): Promise<ActionResult<null>> {
  const { actor, allowed } = await mayAdminister();
  if (!allowed) return { ok: false, error: "You can't change permissions." };

  const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, isSuperAdmin: true } });
  if (!target) return { ok: false, error: "That user no longer exists." };

  const existing = await db.userPermission.findUnique({
    where: { user_permission: { userId, permission } },
    select: { allowed: true },
  });

  try {
    assertMayActOnTarget(actor, target);

    /**
     * Removing an exception is granting or revoking, depending on which way it pointed — and this
     * path checked neither.
     *
     * The dangerous half is a **deny**. A super admin who denies an ordinary admin `payments.delete`
     * writes a UserPermission row; that admin could then call this and remove it, because
     * `assertMayActOnTarget` only asks whether the *target* is a super admin and the target was
     * themselves. The deny evaporated and `adminDefault` handed the key straight back.
     */
    if (existing && !existing.allowed) {
      assertNotSelf(actor.id, userId, "own permission exceptions");
    }
    // And you may not restore, by deletion, a capability you could not have granted outright.
    await assertGrantWithinOwnAuthority(actor, permission);
  } catch (err) {
    return refuse(err);
  }

  await db.userPermission.deleteMany({ where: { userId, permission } });
  await recordPermissionChange({
    actorUserId: actor.id,
    subjectType: "USER",
    subjectUserId: userId,
    permission,
    changeKind: "RESET_TO_DEFAULT",
    detail: `${permission} for ${target.name} returned to their role default`,
  });
  revalidatePath("/settings/access");
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

/** Every personal exception on one account, for the review drawer. */
export async function userPermissionOverrides(userId: string) {
  const session = await requireUser();
  if (userId !== session.id && !(await can(session.id, "permissions.view"))) return [];

  const rows = await db.userPermission.findMany({
    where: { userId },
    select: {
      permission: true,
      allowed: true,
      reason: true,
      expiresAt: true,
      createdAt: true,
      grantedBy: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  /**
   * Whether each row is still in force, worked out here.
   *
   * The resolver filters expired rows and this query did not, so the drawer listed a grant that
   * lapsed last year in success-green — directly contradicting the resolved row a few inches below
   * saying the person does not hold it. Deciding it here also keeps the clock out of render, where
   * reading it makes two renders disagree.
   */
  const now = Date.now();
  return rows.map((row) => ({
    ...row,
    expired: row.expiresAt !== null && row.expiresAt.getTime() <= now,
  }));
}

// ─── Presets ──────────────────────────────────────────────────────────────────────────────────

/** What applying this preset would change, so the click is informed rather than a gamble. */
export async function previewPreset(presetKey: string) {
  const { allowed } = await mayAdminister();
  if (!allowed) return null;

  const preset = getPreset(presetKey);
  if (!preset) return null;

  const rows = await db.rolePermission.findMany({ where: { role: preset.role } });
  const overrides = new Map(rows.map((r) => [r.permission, r.allowed]));
  const current: Record<string, boolean> = {};
  for (const def of PERMISSIONS) {
    current[def.key] = overrides.get(def.key) ?? (def.defaultRoles as readonly Role[]).includes(preset.role);
  }

  return { preset, ...presetDiff(preset, current) };
}

/**
 * Applies a preset to a role, in one transaction.
 *
 * Writes an explicit row for every key — including the ones being switched off — rather than
 * deleting rows to fall back on defaults. That matters: after applying a preset, what the role can
 * do is stated rather than inferred, so a later change to a registry default cannot silently move
 * a role that an admin thought they had pinned.
 */
export async function applyPreset(presetKey: string): Promise<ActionResult<{ granted: number; revoked: number }>> {
  const { actor, allowed } = await mayAdminister();
  if (!allowed) return { ok: false, error: "You can't change permissions." };

  const preset = getPreset(presetKey);
  if (!preset) return { ok: false, error: "Unknown preset." };
  if (preset.role === "ADMIN" && !actor.isSuperAdmin) {
    return { ok: false, error: "Only a super admin can change what admins can do." };
  }

  const wanted = new Set<string>(preset.permissions);

  // A preset may not hand out anything the person applying it does not hold.
  if (!actor.isSuperAdmin) {
    for (const key of preset.permissions) {
      try {
        await assertGrantWithinOwnAuthority(actor, key);
      } catch (err) {
        return refuse(err);
      }
    }
  }

  // Nor take away, from the applier's own role, their way back into these screens. A key the preset
  // leaves out falls back to its default below, so that is what the role holds afterwards.
  try {
    for (const key of OWN_ACCESS_KEYS) {
      const byDefault =
        preset.role === "ADMIN" || ((getPermissionDefinition(key)?.defaultRoles ?? []) as readonly Role[]).includes(preset.role);
      await assertKeepsOwnAccessAdmin(actor, preset.role, key, wanted.has(key) || byDefault);
    }
  } catch (err) {
    return refuse(err);
  }

  let granted = 0;
  let revoked = 0;

  /**
   * A preset states what a role *has*, not what it is forbidden.
   *
   * This used to write an explicit row for all seventy-four keys — `allowed: false` for every key
   * the preset did not mention. An explicit deny outranks both the registry default and downline
   * inheritance, so a single preset click permanently severed both for that role: a sales manager
   * who reached `expenses.approve` by managing an accounts executive lost it, with no row anywhere
   * saying why, and no amount of re-granting the report's access brought it back.
   *
   * Keys the preset grants get a row; keys it does not are *cleared*, so absence goes on meaning
   * "fall through to the default" — which is what makes a registry default useful at all.
   */
  await db.$transaction(async (tx) => {
    for (const def of PERMISSIONS) {
      const shouldHave = wanted.has(def.key);
      const was = await rolePermits(preset.role, def.key);
      if (was !== shouldHave) {
        if (shouldHave) granted += 1;
        else revoked += 1;
      }

      if (shouldHave) {
        await tx.rolePermission.upsert({
          where: { role_permission: { role: preset.role, permission: def.key } },
          update: { allowed: true },
          create: { role: preset.role, permission: def.key, allowed: true },
        });
      } else {
        await tx.rolePermission.deleteMany({ where: { role: preset.role, permission: def.key } });
      }
    }
  });

  await recordPermissionChange({
    actorUserId: actor.id,
    subjectType: "ROLE",
    subjectRole: preset.role,
    changeKind: "PRESET_APPLIED",
    detail: `Applied "${preset.label}" to ${preset.role}: ${granted} granted, ${revoked} revoked`,
  });

  revalidatePath("/settings/access");
  revalidatePath("/", "layout");
  return { ok: true, data: { granted, revoked } };
}

// ─── The super-admin flag ─────────────────────────────────────────────────────────────────────

/**
 * There is no action here that grants super admin, and that is the design.
 *
 * `setSuperAdmin` used to live at this point in the file: an existing super admin could promote
 * anybody from the access drawer. It is gone, along with its two buttons, because the account it
 * creates is the one account every permission check short-circuits for — it holds everything
 * unconditionally, no permission row is consulted for it, and it cannot be impersonated. One
 * account being outside the permission system is a decision somebody made once. A button that
 * makes more of them turns that decision into a habit, and the permission system stops describing
 * who can do what.
 *
 * So the rule is now enforced in two places that do not depend on this file being read:
 *
 *   · `users_one_super_admin`, a partial unique index, refuses to create a second.
 *   · `users_require_remaining_super_admin`, a trigger, refuses to remove the last.
 *
 * Exactly one, always. Moving it needs database access —
 * `npx tsx scripts/grant-super-admin.ts <email>` transfers it — which is the right bar for an
 * account that can do everything, and the same bar as restoring a backup or reading a dump.
 *
 * What a super admin *can* still do from the app is make somebody an **admin**: that is
 * `users.assignRole`, which is `superAdminOnly` in the registry, so only a super admin can hand it
 * out. An admin is inside the permission system and can be reviewed, narrowed and revoked, which is
 * precisely the difference.
 */

/** The authorization change history, for the access-review screen. */
export async function permissionChangeHistory(params: { userId?: string; role?: Role; limit?: number } = {}) {
  const session = await requireUser();
  if (!(await can(session.id, "permissions.view"))) return [];

  return db.permissionChange.findMany({
    where: {
      ...(params.userId ? { subjectUserId: params.userId } : {}),
      ...(params.role ? { subjectRole: params.role } : {}),
    },
    select: {
      id: true,
      changeKind: true,
      permission: true,
      fromAllowed: true,
      toAllowed: true,
      detail: true,
      createdAt: true,
      subjectType: true,
      subjectRole: true,
      actor: { select: { id: true, name: true } },
      subjectUser: { select: { id: true, name: true } },
      impersonatedByUserId: true,
    },
    orderBy: { createdAt: "desc" },
    take: params.limit ?? 100,
  });
}

/**
 * Every personal exception in the company, in one list.
 *
 * The screen an auditor opens first, and the one question the app could not answer without opening
 * thirty drawers one at a time: what temporary access is live right now, and what has quietly
 * lapsed. Sorted so the two things worth acting on are at the top — rows that have already expired,
 * then rows expiring soonest — with permanent exceptions last.
 *
 * A single query. No resolution: an exception is a stored fact, not a derived one.
 */
const EXCEPTION_PAGE = 100;

export async function listPermissionExceptions(params: { scope?: "dated" | "all"; limit?: number } = {}) {
  const session = await requireUser();
  if (!(await can(session.id, "permissions.view"))) {
    return { rows: [], total: 0, lapsed: 0, endingSoon: 0, shown: 0 };
  }

  const rows = await db.userPermission.findMany({
    select: {
      permission: true,
      allowed: true,
      reason: true,
      expiresAt: true,
      createdAt: true,
      user: { select: { id: true, name: true, email: true, role: true, active: true } },
      grantedBy: { select: { id: true, name: true } },
    },
  });

  const now = Date.now();

  const mapped = rows
    .map((row) => {
      const def = getPermissionDefinition(row.permission);
      return {
        userId: row.user.id,
        userName: row.user.name,
        userEmail: row.user.email,
        userRole: row.user.role,
        userActive: row.user.active,
        permission: row.permission,
        // A key removed from the registry leaves its rows behind; say so rather than showing blank.
        label: def?.label ?? `${row.permission} (no longer a permission)`,
        tier: def?.tier ?? "standard",
        allowed: row.allowed,
        reason: row.reason,
        grantedById: row.grantedBy?.id ?? null,
        grantedByName: row.grantedBy?.name ?? null,
        grantedOn: row.createdAt,
        expiresAt: row.expiresAt,
        expired: row.expiresAt !== null && row.expiresAt.getTime() <= now,
      };
    })
    .sort((a, b) => {
      // Lapsed first, then soonest to lapse, then the permanent ones.
      const rank = (r: typeof a) => (r.expired ? 0 : r.expiresAt ? 1 : 2);
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      if (a.expiresAt && b.expiresAt) return a.expiresAt.getTime() - b.expiresAt.getTime();
      return a.userName.localeCompare(b.userName);
    });

  const week = now + 7 * 86_400_000;
  const lapsed = mapped.filter((r) => r.expired).length;
  const endingSoon = mapped.filter((r) => !r.expired && r.expiresAt && r.expiresAt.getTime() <= week).length;

  /**
   * Capped, and the cap is stated.
   *
   * A company with a tidy permission story has a handful of these; this database has 737, and
   * rendering every one of them with its own row of buttons made the tab take nine seconds. The
   * sort above already puts what needs acting on first, so a cap costs nothing an administrator was
   * going to do — but a silently truncated list reads as "that is all of them", so the count comes
   * back with it.
   */
  /**
   * Everything, unless asked to narrow it.
   *
   * An earlier version of this defaulted to rows that carry an expiry, on the theory that dated
   * grants are the ones needing attention. That hid every permanent exception — which is to say it
   * hid the ones an audit most wants: a salesperson permanently granted payroll is a far worse fact
   * than a cover-for-leave grant that ends on Friday. The sort already puts what is urgent first.
   */
  const scoped = params.scope === "dated" ? mapped.filter((r) => r.expiresAt !== null) : mapped;
  const limit = params.limit ?? EXCEPTION_PAGE;

  return {
    rows: scoped.slice(0, limit),
    shown: Math.min(scoped.length, limit),
    total: mapped.length,
    lapsed,
    endingSoon,
  };
}

/**
 * Extends a live exception without re-stating it.
 *
 * "This cover is running another fortnight" should not require re-typing the reason and re-picking
 * the permission, which is how a temporary grant gets made permanent by accident.
 */
export async function extendUserPermission(input: {
  userId: string;
  permission: string;
  /** A date, or null to make it permanent. */
  expiresAt: string | null;
}): Promise<ActionResult<null>> {
  const { actor, allowed: mayManage } = await mayAdminister();
  if (!mayManage) return { ok: false, error: "You can't change permissions." };

  const row = await db.userPermission.findUnique({
    where: { user_permission: { userId: input.userId, permission: input.permission } },
    select: { allowed: true },
  });
  if (!row) return { ok: false, error: "That exception no longer exists." };

  const target = await db.user.findUnique({
    where: { id: input.userId },
    select: { id: true, name: true, isSuperAdmin: true },
  });
  if (!target) return { ok: false, error: "That user no longer exists." };

  try {
    assertMayActOnTarget(actor, target);
    // Extending a grant is granting; extending a deny is not, but shortening one is — so the
    // authority check applies either way rather than being reasoned about per case.
    await assertGrantWithinOwnAuthority(actor, input.permission);
    if (!row.allowed) assertNotSelf(actor.id, input.userId, "own permission exceptions");
  } catch (err) {
    return refuse(err);
  }

  await db.userPermission.update({
    where: { user_permission: { userId: input.userId, permission: input.permission } },
    data: { expiresAt: expiryFromDate(input.expiresAt) },
  });

  await recordPermissionChange({
    actorUserId: actor.id,
    subjectType: "USER",
    subjectUserId: input.userId,
    permission: input.permission,
    changeKind: row.allowed ? "GRANT" : "REVOKE",
    detail: input.expiresAt
      ? `${input.permission} for ${target.name} now runs until ${input.expiresAt}`
      : `${input.permission} for ${target.name} made permanent`,
  });

  revalidatePath("/settings/access");
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}
