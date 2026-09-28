"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { refuseWhileViewingAs, requireUser } from "@/lib/session";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { generateTotpSecret, verifyTotpCode, totpQrCodeDataUrl } from "@/lib/totp";
import {
  beginTwoFactorSchema,
  changePasswordSchema,
  confirmTwoFactorSchema,
  disableTwoFactorSchema,
  updateOwnContactSchema,
} from "@/lib/validation/profile";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import type { ActionResult } from "@/actions/company";
import { accountsChanged } from "@/lib/platform/account-hooks";

export async function getOwnProfile() {
  const user = await requireUser();
  const dbUser = await db.user.findUnique({
    where: { id: user.id },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      department: { select: { name: true } },
      manager: { select: { name: true } },
      mustChangePassword: true,
      twoFactorEnabledAt: true,
      photoUpdatedAt: true,
    },
  });
  return dbUser;
}

/**
 * Somebody's own work number.
 *
 * Their own only — there is no id parameter, and there should not be. Editing a colleague's
 * contact details is a Users & Access job, and an action that took an id would be a way for
 * anybody signed in to change whose number appears on whose quotes.
 */
export async function updateOwnContact(input: unknown): Promise<ActionResult<null>> {
  const user = await requireUser();
  const parsed = updateOwnContactSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  await db.user.update({
    where: { id: user.id },
    data: { phone: parsed.data.phone?.trim() || null },
  });

  revalidatePath("/profile");
  return { ok: true, data: null };
}

export async function changeOwnPassword(input: unknown): Promise<ActionResult<null>> {
  const user = await requireUser();
  // Changing the credentials of a borrowed account turns "see their screen" into "take their
  // account", and would be filed as the user doing it to themselves.
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };
  const parsed = changePasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { currentPassword, newPassword } = parsed.data;

  const dbUser = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  const valid = await bcrypt.compare(currentPassword, dbUser.passwordHash);
  if (!valid) {
    return { ok: false, error: "Current password is incorrect." };
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false } });
  // A new password unlinks this account from its other workspaces too (owner decision 4): "change your password" is the way to be safe.
  await accountsChanged([user.id], { revoke: "credentials", by: `user:${user.id}` });

  revalidatePath("/profile");
  return { ok: true, data: null };
}

/**
 * Start enrolling an authenticator.
 *
 * ## Why this asks for the password
 *
 * Because it is a credential change, and `disableOwnTwoFactor` two functions below has always
 * asked. Without it, a stolen session cookie was enough to take the account: the old version wrote
 * a fresh secret and set `twoFactorEnabledAt: null` in the same update, which silently switched the
 * victim's second factor **off**, and a follow-up confirm with a code from the attacker's own phone
 * switched it back on pointing at them. The victim was never told, their authenticator simply
 * stopped verifying, and because the confirm step re-satisfied `enforceTwoFactor` even the
 * re-enrolment prompt in the dashboard layout never fired.
 *
 * ## Why the new secret goes somewhere else
 *
 * An enrolment that is started and abandoned must leave the account exactly as it was. The pending
 * secret is proved first and promoted second.
 */
export async function beginTwoFactorSetup(input?: unknown): Promise<ActionResult<{ secret: string; qrCodeDataUrl: string }>> {
  const user = await requireUser();
  // Changing the credentials of a borrowed account turns "see their screen" into "take their
  // account", and would be filed as the user doing it to themselves.
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };

  const parsed = beginTwoFactorSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const dbUser = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  if (!(await bcrypt.compare(parsed.data.currentPassword, dbUser.passwordHash))) {
    return { ok: false, error: "Current password is incorrect." };
  }

  const secret = generateTotpSecret();
  await db.user.update({
    where: { id: user.id },
    data: { twoFactorPendingCipher: await encryptSecret(secret) },
  });
  const qrCodeDataUrl = await totpQrCodeDataUrl(user.email, secret);
  return { ok: true, data: { secret, qrCodeDataUrl } };
}

export async function confirmTwoFactorSetup(input: unknown): Promise<ActionResult<null>> {
  const user = await requireUser();
  // Changing the credentials of a borrowed account turns "see their screen" into "take their
  // account", and would be filed as the user doing it to themselves.
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };
  const parsed = confirmTwoFactorSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const dbUser = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  if (!dbUser.twoFactorPendingCipher) {
    return { ok: false, error: "Start setup again — no pending authenticator to confirm." };
  }
  const secret = await decryptSecret(dbUser.twoFactorPendingCipher);
  if (!verifyTotpCode(secret, parsed.data.code)) {
    return { ok: false, error: "That code didn't match. Check the time on your phone and try again." };
  }

  // Promoted only now: until this line the account was still answering to whatever it had before.
  await db.user.update({
    where: { id: user.id },
    data: {
      twoFactorSecretCipher: dbUser.twoFactorPendingCipher,
      twoFactorPendingCipher: null,
      twoFactorEnabledAt: new Date(),
    },
  });

  // Told, not just recorded. Somebody whose second factor changed without them doing it is the one
  // person who can raise the alarm, and they cannot if nothing reaches them.
  await notifyUser({
    userId: user.id,
    type: "SECURITY_ALERT",
    title: "Your authenticator was changed",
    message: "A new authenticator app was set up on your account. If this wasn't you, change your password now.",
    link: "/profile",
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "User",
    entityId: user.id,
    entityLabel: "Enrolled a new two-factor authenticator",
  });

  revalidatePath("/profile");
  return { ok: true, data: null };
}

export async function disableOwnTwoFactor(input: unknown): Promise<ActionResult<null>> {
  const user = await requireUser();
  // Changing the credentials of a borrowed account turns "see their screen" into "take their
  // account", and would be filed as the user doing it to themselves.
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };
  const parsed = disableTwoFactorSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const dbUser = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  const valid = await bcrypt.compare(parsed.data.currentPassword, dbUser.passwordHash);
  if (!valid) {
    return { ok: false, error: "Current password is incorrect." };
  }

  await db.user.update({
    where: { id: user.id },
    data: { twoFactorSecretCipher: null, twoFactorPendingCipher: null, twoFactorEnabledAt: null },
  });
  await accountsChanged([user.id], { revoke: "two-factor-reset", by: `user:${user.id}` });

  await notifyUser({
    userId: user.id,
    type: "SECURITY_ALERT",
    title: "Two-factor was switched off",
    message: "Two-factor authentication was turned off on your account. If this wasn't you, change your password now.",
    link: "/profile",
  });

  revalidatePath("/profile");
  return { ok: true, data: null };
}
