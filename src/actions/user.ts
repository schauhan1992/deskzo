"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { wouldCreateCycle } from "@/lib/org-chart";
import { hasEffectivePermission } from "@/actions/permission";
import { PERMISSIONS } from "@/lib/permissions";
import { actorContext, assertGrantWithinOwnAuthority, assertMayActOnTarget, assertNotSelf, assertSuperAdminRemains, AuthzError } from "@/lib/authz/guards";
import { updateUserAssignmentSchema, createUserSchema } from "@/lib/validation/user";
import type { ActionResult } from "@/actions/company";

function refuse(err: unknown): ActionResult<never> {
  if (err instanceof AuthzError) return { ok: false, error: err.message };
  throw err;
}

export async function listUsers() {
  await requireUser();
  return db.user.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      active: true,
      mustChangePassword: true,
      twoFactorEnabledAt: true,
      departmentId: true,
      department: { select: { id: true, name: true } },
      managerId: true,
      manager: { select: { id: true, name: true } },
    },
  });
}

export async function updateUserAssignment(input: unknown): Promise<ActionResult<null>> {
  const session = await requireUser();
  const admin = await actorContext(session.id);
  if (!(await hasEffectivePermission(admin.id, "users.manage"))) {
    return { ok: false, error: "You can't change roles, departments or reporting lines." };
  }
  const parsed = updateUserAssignmentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, role, departmentId, managerId } = parsed.data;

  const target = await db.user.findUnique({
    where: { id },
    select: { id: true, name: true, role: true, isSuperAdmin: true, managerId: true },
  });
  if (!target) return { ok: false, error: "That user no longer exists." };

  /**
   * A role change is not the same act as a department change, and lumping them under one
   * permission would make `users.assignRole` decorative — somebody with `users.manage` could
   * simply promote themselves through this form instead. So the stricter key is required only
   * when the role is actually moving.
   */
  /**
   * Re-parenting somebody is a grant, and was priced as an org-chart edit.
   *
   * `resolve.ts` rule 5 hands a manager every delegable permission their active reports hold. So
   * moving a person under a new manager gives that manager the reports' access — without any grant
   * guard running, on a form that reads like an HR field. An HR administrator holding `users.manage`
   * could set herself as the accounts executive's manager in two clicks and inherit
   * `payments.record`, `payments.manage` and the rest on her next request.
   *
   * The same reasoning the role branch below already applies: the stricter key is required only
   * when the thing that confers access actually moves.
   */
  if (managerId !== target.managerId) {
    if (!(await hasEffectivePermission(admin.id, "permissions.manage"))) {
      return {
        ok: false,
        error:
          "Changing who somebody reports to also changes what their manager can do, so it needs permission to manage access.",
      };
    }
  }

  if (role !== target.role) {
    if (!(await hasEffectivePermission(admin.id, "users.assignRole"))) {
      return { ok: false, error: "Only a super admin can change somebody's role." };
    }
    try {
      assertNotSelf(admin.id, id, "role");
    } catch (err) {
      return refuse(err);
    }
  }

  try {
    assertMayActOnTarget(admin, target);
  } catch (err) {
    return refuse(err);
  }

  if (managerId) {
    if (managerId === id) {
      return { ok: false, error: "A user can't be their own reporting manager." };
    }
    // Walks *up* from the proposed manager rather than down from the user. Two reasons: it is
    // O(depth) instead of O(subtree), and — the one that matters — it terminates even when the
    // chart is already corrupt. The previous check walked the downline, which is the same traversal
    // that hangs on a cycle, so the only screen able to repair a bad reporting line was itself
    // taken out by the bad reporting line.
    if (await wouldCreateCycle(id, managerId)) {
      return { ok: false, error: "That would create a reporting loop — the selected manager already reports up through this user." };
    }
  }

  try {
    await db.$transaction(async (tx) => {
      // Demoting a super admin out of ADMIN would violate the CHECK constraint and, before that,
      // leave nobody able to administer anything. Checked inside the transaction so two admins
      // demoting each other cannot both see 'one other remains'.
      if (target.isSuperAdmin && role !== "ADMIN") await assertSuperAdminRemains(tx, id);
      await tx.user.update({ where: { id }, data: { role, departmentId, managerId } });
    });
  } catch (err) {
    return refuse(err);
  }

  revalidatePath("/settings/access");
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

export async function createUser(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await requireUser();
  const admin = await actorContext(session.id);
  if (!(await hasEffectivePermission(admin.id, "users.manage"))) {
    return { ok: false, error: "You can't create users." };
  }
  const parsed = createUserSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { name, email, role, departmentId, temporaryPassword } = parsed.data;

  // The role picker already leaves ADMIN out (see the access page), but the form is not the
  // authority — this action is. Creating a fresh admin is the same escalation as promoting an
  // existing user, so it wants the same key.
  if (role === "ADMIN" && !(await hasEffectivePermission(admin.id, "users.assignRole"))) {
    return { ok: false, error: "Only a super admin can create an admin account." };
  }

  /**
   * The same rule for every other role, for the same reason.
   *
   * The comment above already argues that minting an admin is the escalation that promoting one is.
   * It stopped at ADMIN — but MANAGEMENT carries 47 of the 74 keys by default, and the creator
   * chooses the temporary password, so somebody holding only `users.manage` could create a
   * MANAGEMENT account, sign in as it, and hold far more than they were given. `mustChangePassword`
   * does not help: they are the one who would be asked to change it.
   *
   * So the creator must already hold everything the new account would start with — the same test
   * `assertGrantWithinOwnAuthority` applies one key at a time when granting directly.
   */
  if (!admin.isSuperAdmin) {
    const wouldHold = PERMISSIONS.filter((def) => (def.defaultRoles as readonly string[]).includes(role));
    for (const def of wouldHold) {
      try {
        await assertGrantWithinOwnAuthority(admin, def.key);
      } catch {
        return {
          ok: false,
          error: `A ${role} account starts with "${def.label}", which you don't hold yourself. Ask somebody who does to create it.`,
        };
      }
    }
  }

  const passwordHash = await bcrypt.hash(temporaryPassword, 10);

  try {
    const user = await db.user.create({
      data: {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        role,
        departmentId: departmentId || null,
        passwordHash,
        mustChangePassword: true,
      },
    });
    revalidatePath("/settings/access");
    return { ok: true, data: { id: user.id } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "A user with this email already exists." };
    }
    throw err;
  }
}

export async function setUserActive(id: string, active: boolean): Promise<ActionResult<null>> {
  const session = await requireUser();
  const admin = await actorContext(session.id);
  if (!(await hasEffectivePermission(admin.id, "users.manage"))) {
    return { ok: false, error: "You can't activate or deactivate users." };
  }
  if (id === admin.id && !active) {
    return { ok: false, error: "You can't deactivate your own account." };
  }

  const target = await db.user.findUnique({ where: { id }, select: { id: true, isSuperAdmin: true } });
  if (!target) return { ok: false, error: "That user no longer exists." };

  try {
    assertMayActOnTarget(admin, target);
    await db.$transaction(async (tx) => {
      // Deactivating is a demotion in everything but name: the resolver denies an inactive account
      // every permission, so switching off the last super admin leaves nobody who can switch them
      // back on.
      if (target.isSuperAdmin && !active) await assertSuperAdminRemains(tx, id);
      await tx.user.update({ where: { id }, data: { active } });
    });
  } catch (err) {
    return refuse(err);
  }

  revalidatePath("/settings/access");
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

export async function resetUserTwoFactor(id: string): Promise<ActionResult<null>> {
  const session = await requireUser();
  const admin = await actorContext(session.id);
  if (!(await hasEffectivePermission(admin.id, "users.manage"))) {
    return { ok: false, error: "You can't reset two-factor authentication." };
  }

  // Clearing somebody's second factor is a way to take their account, so a super admin's can only
  // be cleared by another super admin.
  const target = await db.user.findUnique({ where: { id }, select: { id: true, isSuperAdmin: true } });
  if (!target) return { ok: false, error: "That user no longer exists." };
  try {
    assertMayActOnTarget(admin, target);
  } catch (err) {
    return refuse(err);
  }

  await db.user.update({ where: { id }, data: { twoFactorSecretCipher: null, twoFactorEnabledAt: null } });
  revalidatePath("/settings/access");
  return { ok: true, data: null };
}
