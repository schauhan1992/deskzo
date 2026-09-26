import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { StaffRole } from "@wroffy/control-client";
import { controlDb } from "@/lib/platform/control-db";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { PLATFORM_DOMAIN, protocolFor } from "@/lib/tenancy/host";

/**
 * Looking after the platform's staff — from the console (owners only) and `npm run platform:staff`.
 *
 * Nobody hands anybody a password. A new staff member gets a one-time link, valid for three days, to
 * choose their own; at their first sign-in they enrol two-factor before anything else opens. A reset
 * is the same link again. There is always at least one active owner: the last cannot be removed or
 * demoted, so the console can never lock everybody out of itself.
 */

const SETUP_TTL_MS = 3 * 24 * 60 * 60_000;
const MIN_PASSWORD = 12;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export class StaffChangeRefused extends Error {}

export function consoleOrigin(): string {
  const host = `admin.${PLATFORM_DOMAIN}${process.env.PLATFORM_PORT ? `:${process.env.PLATFORM_PORT}` : ""}`;
  return `${protocolFor(host)}://${host}`;
}

async function audit(actor: string, action: string, detail: Record<string, unknown>) {
  await controlDb().platformAuditLog.create({ data: { actorKind: actor.startsWith("script:") ? "SCRIPT" : "STAFF", actor: actor.replace(/^script:/, ""), action, detail: detail as never } });
}

/** A fresh one-time link to choose a password; the previous one stops working. */
export async function issuePasswordSetup(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await controlDb().platformUser.update({ where: { id: userId }, data: { passwordSetupHash: sha256(token), passwordSetupExpiresAt: new Date(Date.now() + SETUP_TTL_MS) } });
  return `${consoleOrigin()}/setup?t=${encodeURIComponent(token)}`;
}

export async function createStaff(input: { email: string; name: string; role: StaffRole }, actor: string): Promise<{ id: string; setupUrl: string }> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new StaffChangeRefused("That doesn't look like an email address.");
  if (name.length < 2) throw new StaffChangeRefused("Give their name.");
  if (await controlDb().platformUser.findUnique({ where: { email } })) throw new StaffChangeRefused("There is already a staff member with that address.");
  const user = await controlDb().platformUser.create({
    // Nobody signs in with this: the setup link replaces it.
    data: { email, name, role: input.role, passwordHash: await bcrypt.hash(randomBytes(32).toString("hex"), 10) },
    select: { id: true },
  });
  const setupUrl = await issuePasswordSetup(user.id);
  await audit(actor, "staff.create", { email, role: input.role });
  await sendPlatformMail({
    to: email,
    subject: "Your console account",
    text: [`Hello ${name},`, "", "You have been given an account on the platform console. Choose your password here — the link works once, for three days:", "", setupUrl, "", "At your first sign-in you will set up two-factor authentication."].join("\n"),
  }).catch((err) => console.error("[staff] the setup email could not be sent", err));
  return { id: user.id, setupUrl };
}

export async function completePasswordSetup(token: string, password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (password.length < MIN_PASSWORD) return { ok: false, error: `Choose a password of at least ${MIN_PASSWORD} characters.` };
  const user = await controlDb().platformUser.findUnique({ where: { passwordSetupHash: sha256(String(token ?? "")) } });
  if (!user || !user.active || !user.passwordSetupExpiresAt || user.passwordSetupExpiresAt < new Date()) {
    return { ok: false, error: "This link has expired or been used. Ask an owner for a new one." };
  }
  const now = new Date();
  await controlDb().$transaction(async (tx) => {
    await tx.platformUser.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(password, 10), passwordSetupHash: null, passwordSetupExpiresAt: null } });
    // Whoever had the old password is signed out wherever they are.
    await tx.platformSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
  });
  await audit(user.id, "staff.password.set", {});
  return { ok: true };
}

async function assertAnotherOwner(userId: string) {
  const others = await controlDb().platformUser.count({ where: { role: "OWNER", active: true, NOT: { id: userId } } });
  if (others === 0) throw new StaffChangeRefused("This is the last active owner. Make somebody else an owner first.");
}

export async function setStaffRole(userId: string, role: StaffRole, actor: string) {
  const user = await controlDb().platformUser.findUniqueOrThrow({ where: { id: userId } });
  if (user.role === "OWNER" && role !== "OWNER") await assertAnotherOwner(userId);
  await controlDb().platformUser.update({ where: { id: userId }, data: { role } });
  await audit(actor, "staff.role", { email: user.email, from: user.role, to: role });
}

export async function deactivateStaff(userId: string, actor: string) {
  const user = await controlDb().platformUser.findUniqueOrThrow({ where: { id: userId } });
  if (user.role === "OWNER") await assertAnotherOwner(userId);
  await controlDb().$transaction(async (tx) => {
    await tx.platformUser.update({ where: { id: userId }, data: { active: false, passwordSetupHash: null } });
    await tx.platformSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  });
  await audit(actor, "staff.deactivate", { email: user.email });
}

export async function endStaffSessions(userId: string, actor: string) {
  await controlDb().platformSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit(actor, "staff.sessions.end", { userId });
}

/** Their next sign-in enrols two-factor again — a lost phone. Signs them out everywhere. */
export async function resetStaffTwoFactor(userId: string, actor: string) {
  await controlDb().$transaction(async (tx) => {
    await tx.platformUser.update({ where: { id: userId }, data: { totpSecretCipher: null, totpEnabledAt: null } });
    await tx.platformSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  });
  await audit(actor, "staff.two-factor.reset", { userId });
}
