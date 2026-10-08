"use server";

import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { refuseWhileViewingAs, requireUser } from "@/lib/session";
import { wouldCreateCycle } from "@/lib/org-chart";
import { hasEffectivePermission } from "@/actions/permission";
import { PERMISSIONS, heldByDefault } from "@/lib/permissions";
import { actorContext, assertGrantWithinOwnAuthority, assertMayActOnTarget, assertNotSelf, assertSuperAdminRemains, AuthzError } from "@/lib/authz/guards";
import { updateUserAssignmentSchema, createUserSchema } from "@/lib/validation/user";
import type { ActionResult } from "@/actions/company";
import { seatProblem } from "@/lib/seats";
import { accountsChanged } from "@/lib/platform/account-hooks";
import { awaitingSetup, mayPassOnSetupLink, sendSetupInvitation, type SetupInvitation } from "@/lib/account-setup";
import { AWAITING_SETUP, noPasswordYet } from "@/lib/no-password";
import { clearFailures, lockoutState, recordFailure } from "@/lib/security/lockout";
import { tenantKey } from "@/lib/tenancy/cache";
import { currentTenant, tenantOrigin } from "@/lib/tenancy/resolve";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { recordAudit } from "@/lib/audit";
import { logActivity } from "@/lib/activity";
import { signInPolicyFor } from "@/lib/workplace/sign-in-rules-server";
import { lockedOut, waysIn } from "@/lib/workplace/sign-in-rules";
import { ADMIN_RESET_LINK_TTL_MS, adminResetMail, temporaryPassword, temporaryResetNotice } from "@/lib/admin-password";

function refuse(err: unknown): ActionResult<never> {
  if (err instanceof AuthzError) return { ok: false, error: err.message };
  throw err;
}

/**
 * `setupPending`: nobody has chosen a password for the account yet — "Invitation pending" (src/lib/account-setup.ts).
 * `setupLinkIssued`: a setup or password link has been issued for it before, so the list offers to resend one.
 */
export async function listUsers() {
  await requireUser();
  const [users, pending] = await Promise.all([
    db.user.findMany({
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
    }),
    db.user.findMany({ where: AWAITING_SETUP, select: { id: true, _count: { select: { passwordResetTokens: true } } } }),
  ]);
  const issued = new Map(pending.map((p) => [p.id, p._count.passwordResetTokens > 0]));
  return users.map((user) => ({ ...user, setupPending: issued.has(user.id), setupLinkIssued: issued.get(user.id) ?? false }));
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

/**
 * A new account, and its setup email: the person chooses their own password from a one-time link
 * (src/lib/account-setup.ts). Until then the account has no usable password, and nobody can sign in as it.
 *
 * With "This person already uses another workspace on this platform" ticked, the email is the one-step
 * invite of linked sign-in: the same link with `&link=1`, whose page also offers to link the two.
 *
 * `emailed: false` comes with the link itself (`setupUrl`) for the admin to pass on — shown once, never
 * stored — unless the link couldn't be issued either, when "Resend setup email" tries again.
 *
 * Optional, from Staff & roles' Add staff form: a job title (the HR record's designation), a work phone, and
 * `active: false` for an account made switched off — no seat and no email until somebody switches it on,
 * answered with `startsSwitchedOff`. Everything else about the account is as without them.
 */
export async function createUser(
  input: unknown,
): Promise<ActionResult<{ id: string } & SetupInvitation & { startsSwitchedOff?: true }>> {
  const session = await requireUser();
  const admin = await actorContext(session.id);
  if (!(await hasEffectivePermission(admin.id, "users.manage"))) {
    return { ok: false, error: "You can't create users." };
  }
  const parsed = createUserSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { name, email, role, departmentId, usesAnotherWorkspace, jobTitle, phone, active } = parsed.data;

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
   * It stopped at ADMIN — but MANAGEMENT carries 47 of the 74 keys by default, and the creator can
   * end up choosing the account's password: when the setup email can't be sent, the setup link comes
   * back to them to pass on. So somebody holding only `users.manage` could create a MANAGEMENT
   * account, set it up themselves, sign in as it, and hold far more than they were given. (This was
   * true of the temporary password the creator chose before, which `mustChangePassword` didn't help:
   * they were the one who would be asked to change it.)
   *
   * So the creator must already hold everything the new account would start with — the same test
   * `assertGrantWithinOwnAuthority` applies one key at a time when granting directly.
   */
  if (!admin.isSuperAdmin) {
    const wouldHold = PERMISSIONS.filter((def) => heldByDefault(def, role));
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

  // A switched-off account takes no seat (src/lib/seats.ts) — it asks for one when it is switched on.
  const startsActive = active !== false;
  if (startsActive) {
    const seats = await seatProblem();
    if (seats) return { ok: false, error: seats };
  }

  let user: { id: string; name: string; email: string };
  try {
    user = await db.$transaction(async (tx) => {
      const made = await tx.user.create({
        data: {
          name: name.trim(),
          email: email.trim().toLowerCase(),
          role,
          departmentId: departmentId || null,
          phone: phone?.trim() || null,
          active: startsActive,
          // No usable password until they choose one from the setup link.
          passwordHash: noPasswordYet(),
        },
        select: { id: true, name: true, email: true },
      });
      // A job title is the HR record's designation, made with the account as converting a candidate does.
      if (jobTitle?.trim()) {
        await tx.employeeProfile.create({ data: { userId: made.id, designation: jobTitle.trim() } });
      }
      return made;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "A user with this email already exists." };
    }
    throw err;
  }
  await accountsChanged([user.id], { by: `admin:${admin.id}` });
  revalidatePath("/settings/access");
  // Switched off: no email yet. "Send setup email" offers it once somebody switches them on — the same
  // rule as resending, which refuses a switched-off account.
  if (!startsActive) return { ok: true, data: { id: user.id, emailed: false, startsSwitchedOff: true } };
  // With the tick, the one-step invite: set up here, and link it to the workspace they already use. The account
  // is made exactly as without it — the role chosen here — and the admin never learns which workspace.
  const invitation = await sendSetupInvitation(user, { by: admin, linking: usesAnotherWorkspace === true });
  return { ok: true, data: { id: user.id, ...invitation } };
}

/**
 * "Resend setup email", for somebody who hasn't chosen a password yet: a new link replaces the unused one
 * (the earlier email's link stops working), mailed as when they were added. Always the plain setup email —
 * linking to another workspace can be done from Profile once they're in.
 *
 * The rules of any re-issued password link: `users.manage`, an ordinary admin can't act on a super admin,
 * not for a switched-off account, and asks for one address share one limit with "Forgot your password?"
 * (src/actions/password-reset.ts). Somebody who has set a password gets a reset instead
 * (`sendPasswordResetEmail`, `resetPasswordToTemporary` below).
 */
export async function resendSetupEmail(id: string): Promise<ActionResult<SetupInvitation>> {
  const session = await requireUser();
  const admin = await actorContext(session.id);
  if (!(await hasEffectivePermission(admin.id, "users.manage"))) {
    return { ok: false, error: "You can't send setup emails." };
  }
  const target = await db.user.findUnique({
    where: { id: String(id ?? "") },
    select: { id: true, name: true, email: true, active: true, kind: true, isSuperAdmin: true },
  });
  if (!target || target.kind !== "MEMBER") return { ok: false, error: "That user no longer exists." };
  try {
    assertMayActOnTarget(admin, target);
  } catch (err) {
    return refuse(err);
  }
  if (!target.active) return { ok: false, error: "Activate them first — a switched-off account can't be set up." };
  if (!(await awaitingSetup(target.id))) {
    return { ok: false, error: "They've already chosen a password. To reset it, send them a password reset email." };
  }

  const keys = [`${await tenantKey()}|reset:${target.email.trim().toLowerCase()}`];
  const limit = lockoutState(keys);
  if (limit.lockedOut) {
    return { ok: false, error: `Too many setup emails for this address. Try again in ${Math.ceil(limit.retryInSeconds / 60)} minutes.` };
  }
  recordFailure(keys);

  const invitation = await sendSetupInvitation(target, { by: admin });
  if (!invitation.emailed && !invitation.setupUrl) return { ok: false, error: "The setup email couldn't be sent. Try again in a while." };
  revalidatePath("/settings/access");
  return { ok: true, data: invitation };
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

  const target = await db.user.findUnique({ where: { id }, select: { id: true, isSuperAdmin: true, active: true } });
  if (!target) return { ok: false, error: "That user no longer exists." };
  // Switching somebody back on takes a seat again.
  if (active && !target.active) {
    const seats = await seatProblem();
    if (seats) return { ok: false, error: seats };
  }

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

  await accountsChanged([id], { revoke: active ? undefined : "deactivated", by: `admin:${admin.id}` });
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
  await accountsChanged([id], { revoke: "two-factor-reset", by: `admin:${admin.id}` });
  revalidatePath("/settings/access");
  return { ok: true, data: null };
}

// ─── An admin resetting somebody's password ────────────────────────────────────────────────────────

/**
 * Who an admin may reset a password for, and the account, or why not. Both ways share it:
 *
 *   · `users.manage`, as themselves (never while viewing as somebody), and never their own (Profile is
 *     for that);
 *   · an ordinary admin can't act on the super admin, and a switched-off account can't sign in anyway;
 *   · somebody who hasn't chosen a password yet needs their setup email, not a reset;
 *   · somebody whose sign-in rule is single sign-on only would get a password that lets them in nowhere.
 */
async function passwordTarget(id: string): Promise<
  | { ok: true; admin: Awaited<ReturnType<typeof actorContext>>; target: { id: string; name: string; email: string; role: string; isSuperAdmin: boolean } }
  | { ok: false; error: string }
> {
  const session = await requireUser();
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };
  const admin = await actorContext(session.id);
  if (!(await hasEffectivePermission(admin.id, "users.manage"))) return { ok: false, error: "You can't reset passwords." };
  const target = await db.user.findUnique({
    where: { id: String(id ?? "") },
    select: { id: true, name: true, email: true, role: true, active: true, kind: true, isSuperAdmin: true },
  });
  if (!target || target.kind !== "MEMBER") return { ok: false, error: "That user no longer exists." };
  if (target.id === admin.id) return { ok: false, error: "That's you. Change your own password from your profile." };
  try {
    assertMayActOnTarget(admin, target);
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.message };
    throw err;
  }
  if (!target.active) return { ok: false, error: "Switch them on first. A switched-off account can't sign in." };
  if (await awaitingSetup(target.id)) {
    return { ok: false, error: "They haven't chosen a password yet. Send their setup email instead." };
  }
  const policy = await signInPolicyFor(target);
  if (!policy.password) {
    return {
      ok: false,
      error: lockedOut(policy)
        ? "Their sign-in rule names a sign-in that's switched off, so nothing lets them in. Change how they sign in first."
        : `They sign in with ${waysIn(policy)} only, so a password wouldn't let them in.`,
    };
  }
  return { ok: true, admin, target };
}

/**
 * The one-click reset email: a link to the person's own address to choose a new password, for 24 hours,
 * once. Their current password keeps working until they use it, so a click on the wrong row locks nobody
 * out. It replaces any unused link they have, and shares the per-address limit of "Forgot your password?".
 * When the email can't be sent the link comes back, once, to an admin who holds everything the person
 * holds (`mayPassOnSetupLink`); anybody else is told to try again.
 */
export async function sendPasswordResetEmail(id: string): Promise<ActionResult<{ emailed: true } | { emailed: false; resetUrl: string }>> {
  const checked = await passwordTarget(id);
  if (!checked.ok) return checked;
  const { admin, target } = checked;

  const keys = [`${await tenantKey()}|reset:${target.email.trim().toLowerCase()}`];
  const limit = lockoutState(keys);
  if (limit.lockedOut) {
    return { ok: false, error: `Too many password emails for this address. Try again in ${Math.ceil(limit.retryInSeconds / 60)} minutes.` };
  }
  recordFailure(keys);

  const tenant = await currentTenant();
  const token = randomBytes(32).toString("base64url");
  await db.$transaction(async (tx) => {
    await tx.passwordResetToken.deleteMany({ where: { userId: target.id, usedAt: null } });
    await tx.passwordResetToken.create({
      data: { tokenHash: createHash("sha256").update(token).digest("hex"), userId: target.id, expiresAt: new Date(Date.now() + ADMIN_RESET_LINK_TTL_MS) },
    });
  });
  const url = `${await tenantOrigin(tenant)}/reset-password?t=${encodeURIComponent(token)}`;
  await recordAudit({ userId: admin.id, action: "UPDATE", entityType: "User", entityId: target.id, entityLabel: `${target.name} — sent a password reset email` });

  try {
    await sendPlatformMail({ type: "ACCOUNT", to: target.email, ...adminResetMail({ name: target.name, workspace: tenant.name, admin: admin.name, url }) });
    return { ok: true, data: { emailed: true } };
  } catch {
    if (await mayPassOnSetupLink(admin, target.id)) return { ok: true, data: { emailed: false, resetUrl: url } };
    return { ok: false, error: "The email couldn't be sent. Try again in a while." };
  }
}

/**
 * The direct reset: a temporary password the app makes up (`temporaryPassword`), shown to the admin
 * once and never stored but as its hash. The person is signed out everywhere, any password link they
 * had stops working, their lockouts are cleared, and they must choose their own at next sign-in.
 * Two-factor stays on.
 *
 * Only for an admin who holds everything the person holds (`mayPassOnSetupLink`): the password is the
 * power to sign in as them, which must never be more than the admin could already do. The person is
 * emailed that it happened, without the password.
 */
export async function resetPasswordToTemporary(id: string): Promise<ActionResult<{ password: string }>> {
  const checked = await passwordTarget(id);
  if (!checked.ok) return checked;
  const { admin, target } = checked;
  if (!(await mayPassOnSetupLink(admin, target.id))) {
    return {
      ok: false,
      error: "They hold access you don't, so only the super admin can reset their password. You can still send them a reset email.",
    };
  }

  const password = temporaryPassword();
  const passwordHash = await bcrypt.hash(password, 10);
  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: target.id }, data: { passwordHash, mustChangePassword: true } });
    await tx.passwordResetToken.deleteMany({ where: { userId: target.id, usedAt: null } });
    await tx.signIn.updateMany({ where: { userId: target.id, endedAt: null }, data: { endedAt: now } });
  });
  await accountsChanged([target.id], { revoke: "credentials", by: `admin:${admin.id}` });
  const workspace = await tenantKey();
  const email = target.email.trim().toLowerCase();
  clearFailures([`${workspace}|account:${email}`, `${workspace}|reset:${email}`]);

  await recordAudit({ userId: admin.id, action: "UPDATE", entityType: "User", entityId: target.id, entityLabel: `${target.name} — password reset to a temporary one` });
  await logActivity({
    kind: "PASSWORD_CHANGED",
    userId: target.id,
    userName: target.name,
    userEmail: target.email,
    summary: `${target.name}'s password was reset to a temporary one by ${admin.name}`,
  });
  try {
    await sendPlatformMail({ type: "ACCOUNT", to: target.email, ...temporaryResetNotice({ name: target.name, workspace: (await currentTenant()).name, admin: admin.name }) });
  } catch {
    // The notice is a courtesy: the reset has happened, and the admin is passing the password on.
  }
  revalidatePath("/settings/access");
  return { ok: true, data: { password } };
}
