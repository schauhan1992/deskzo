"use server";

import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { AuthError } from "next-auth";
import { headers } from "next/headers";
import { signIn } from "@/lib/auth";
import { db } from "@/lib/db";
import { logActivity } from "@/lib/activity";
import { clientIpFrom } from "@/lib/client-ip";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { accountsChanged } from "@/lib/platform/account-hooks";
import { clearFailures, lockoutState, recordFailure } from "@/lib/security/lockout";
import { tenantKey } from "@/lib/tenancy/cache";
import { tenantOrigin } from "@/lib/tenancy/resolve";

/**
 * "Forgot your password?" — from the sign-in page, for anybody with an account in this workspace,
 * the owner included.
 *
 *   · Asking always gets the same answer, whether or not the address has an account here: saying
 *     otherwise turns the form into a way to find out who works where.
 *   · The link is emailed by the platform (src/lib/platform/mailer.ts), works for an hour, once, and
 *     only its SHA-256 is kept. Asking again replaces the earlier links.
 *   · Setting a new password ends every signed-in session of that account and clears its lockouts —
 *     whoever had the old password is signed out wherever they are.
 *   · Two-factor stays on: a new password is not a way around it.
 *
 * Asks are limited per workspace and address as sign-in failures are (src/lib/security/lockout.ts).
 *
 * The same link is a new account's setup email (src/lib/account-setup.ts): three days rather than an hour,
 * for somebody who has no password yet. With `&link=1` it is the one-step invite of linked sign-in: its
 * page can also start linking the account to a workspace the person already uses — see
 * `setPasswordAndSignIn`. An admin's "Resend setup email" shares this form's per-address limit.
 */

const TTL_MS = 60 * 60_000;
const MIN_PASSWORD = 10;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** As our own proxy saw it, or null — then asks are limited per address asked for only (src/lib/client-ip.ts). */
async function callerIp(): Promise<string | null> {
  return clientIpFrom(await headers());
}

export async function requestPasswordReset(input: string): Promise<{ ok: true }> {
  const email = String(input ?? "").trim().toLowerCase();
  const workspace = await tenantKey();
  const ip = await callerIp();
  const keys = [`${workspace}|reset:${email}`, ...(ip ? [`${workspace}|reset-caller:${ip}`] : [])];
  if (lockoutState(keys).lockedOut || !email.includes("@")) return { ok: true };
  recordFailure(keys);

  const user = await db.user.findUnique({ where: { email }, select: { id: true, name: true, active: true } });
  if (!user?.active) return { ok: true };

  const token = randomBytes(32).toString("base64url");
  await db.$transaction(async (tx) => {
    await tx.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } });
    await tx.passwordResetToken.create({ data: { tokenHash: sha256(token), userId: user.id, expiresAt: new Date(Date.now() + TTL_MS), ip } });
  });
  const link = `${await tenantOrigin()}/reset-password?t=${encodeURIComponent(token)}`;
  await sendPlatformMail({
    to: email,
    subject: "Set a new password",
    text: [`Hello ${user.name},`, "", "Somebody — hopefully you — asked to set a new password for this account. The link works for an hour, once:", "", link, "", "If it wasn't you, ignore this; nothing has changed."].join("\n"),
  });
  return { ok: true };
}

/** The link spent and the password set — what `resetPassword` and `setPasswordAndSignIn` share. */
async function setPasswordFromLink(input: { token: string; password: string }): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
  const token = String(input?.token ?? "");
  const password = String(input?.password ?? "");
  if (password.length < MIN_PASSWORD) return { ok: false, error: `Choose a password of at least ${MIN_PASSWORD} characters.` };

  const row = await db.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: { select: { id: true, name: true, email: true, active: true } } } });
  if (!row || row.usedAt || row.expiresAt < new Date() || !row.user.active) {
    return { ok: false, error: "This link has expired or been used. Ask for a new one from the sign-in page." };
  }
  const now = new Date();
  const spent = await db.$transaction(async (tx) => {
    const claimed = await tx.passwordResetToken.updateMany({ where: { tokenHash: row.tokenHash, usedAt: null }, data: { usedAt: now } });
    if (claimed.count !== 1) return false;
    await tx.user.update({ where: { id: row.userId }, data: { passwordHash: await bcrypt.hash(password, 10), mustChangePassword: false } });
    // Everybody signed in as this account is signed out — whoever had the old password included.
    await tx.signIn.updateMany({ where: { userId: row.userId, endedAt: null }, data: { endedAt: now } });
    return true;
  });
  if (!spent) return { ok: false, error: "This link has expired or been used. Ask for a new one from the sign-in page." };
  await accountsChanged([row.userId], { revoke: "credentials", by: `user:${row.userId}` });

  const workspace = await tenantKey();
  clearFailures([`${workspace}|account:${row.user.email}`, `${workspace}|reset:${row.user.email}`]);
  await logActivity({
    kind: "PASSWORD_CHANGED",
    userId: row.user.id,
    userName: row.user.name,
    userEmail: row.user.email,
    summary: `${row.user.name} set a new password from an emailed link`,
  });
  return { ok: true, email: row.user.email };
}

export async function resetPassword(input: { token: string; password: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const set = await setPasswordFromLink(input);
  return set.ok ? { ok: true } : set;
}

/**
 * The invitation's setup page, when the person also typed the address of a workspace they already use:
 * the password is set exactly as `resetPassword` sets it, then they are signed in here with it — the
 * ordinary password sign-in, so each of this workspace's rules still applies (Microsoft sign-in
 * enforced, a blocked network, a two-factor code).
 *
 * The page then starts linking with `startLinkingWorkspace` and the same password, in its next request:
 * the first that carries the new session. This one cannot — the session is only in its response.
 * `signedIn: false` when the sign-in was refused; the password is set all the same, and linking waits
 * for Profile.
 */
export async function setPasswordAndSignIn(input: { token: string; password: string }): Promise<{ ok: true; signedIn: boolean } | { ok: false; error: string }> {
  const set = await setPasswordFromLink(input);
  if (!set.ok) return set;
  try {
    await signIn("credentials", { email: set.email, password: String(input?.password ?? ""), totpCode: "", redirect: false });
    return { ok: true, signedIn: true };
  } catch (err) {
    // The password is set whatever happens here, and the answer has to say so.
    if (!(err instanceof AuthError)) console.error(`[password-reset] signing in after setting a password failed: ${err instanceof Error ? err.name : "error"}`);
    return { ok: true, signedIn: false };
  }
}
