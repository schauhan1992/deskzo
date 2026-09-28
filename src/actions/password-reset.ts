"use server";

import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { headers } from "next/headers";
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

export async function resetPassword(input: { token: string; password: string }): Promise<{ ok: true } | { ok: false; error: string }> {
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
  return { ok: true };
}
