import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { cookies, headers } from "next/headers";
import type { StaffRole } from "@wroffy/control-client";
import { cidrContains, parseCidr, parseIp } from "@/lib/access/ip";
import { controlDb } from "@/lib/platform/control-db";
import { openForPlatform, sealForPlatform } from "@/lib/platform/kek";
import { clearFailures, lockoutState, recordFailure } from "@/lib/security/lockout";
import { staffTwoFactorPolicy } from "@/lib/platform/settings";
import { protocolFor, requestHost } from "@/lib/tenancy/host";
import { generateTotpSecret, totpQrCodeDataUrl, verifyTotpCode } from "@/lib/totp";

/**
 * Signing platform staff in to the console (admin.<domain>) — a sign-in of its own, nothing to do with
 * any workspace's.
 *
 *   · The cookie is `__Host-wroffy-console` over https: this host only, never a workspace's.
 *   · It holds a random token; the control plane holds its SHA-256 as a PlatformSession, checked on
 *     every request — thirty minutes idle, twelve hours at most, revocable from the console.
 *   · Two-factor, when an owner requires it (src/lib/platform/settings.ts — required in production
 *     unless they say otherwise): a first sign-in opens only the enrolment page, and a session is
 *     not a console session until its second factor is passed (`mfaAt`). When it is optional,
 *     somebody without an authenticator signs in with their password alone; somebody with one is
 *     still asked for its code. The policy is read on every request, so changing it applies at once.
 *   · Failed attempts lock out by address and by caller, in a namespace of their own ("console|").
 *   · PLATFORM_CONSOLE_IP_ALLOWLIST (comma-separated CIDRs), when set, refuses everywhere else. It
 *     needs TRUST_PROXY=1: the caller's address is only known from our own reverse proxy (callerIp).
 */

const COOKIE_SECURE = "__Host-wroffy-console";
const COOKIE_PLAIN = "wroffy-console";
const IDLE_MS = 30 * 60_000;
const MAX_MS = 12 * 60 * 60_000;
/** How often lastSeenAt is written — often enough for the idle limit, not on every request. */
const TOUCH_MS = 60_000;

export type Staff = { id: string; email: string; name: string; role: StaffRole };
export type StaffSession = {
  staff: Staff;
  sessionId: string;
  /** Through the second factor — or not asked for one: optional, and no authenticator set up. */
  mfaDone: boolean;
  enrolled: boolean;
  twoFactorRequired: boolean;
};

export class StaffRefused extends Error {}

/** Compared against when the address has no account, so both refusals take a bcrypt's time. */
const NOBODY_HASH = bcrypt.hashSync(randomBytes(16).toString("hex"), 10);

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function secureRequest(): Promise<boolean> {
  const host = requestHost(await headers());
  return typeof host === "string" && protocolFor(host) === "https";
}

/**
 * The caller's address as our own reverse proxy saw it — only when there is one (TRUST_PROXY=1), and
 * then the last X-Forwarded-For entry, the one it added: the entries before it are whatever the caller
 * chose to send. Without a trusted proxy no address is worth believing, so none is used — an
 * allowlist then refuses everybody rather than trusting a header anyone can write.
 */
async function callerIp(): Promise<string | null> {
  if (process.env.TRUST_PROXY !== "1") return null;
  const head = await headers();
  const hops = (head.get("x-forwarded-for") ?? "").split(",").map((hop) => hop.trim()).filter(Boolean);
  return hops.at(-1) || head.get("x-real-ip")?.trim() || null;
}

/** Whether the caller's address may reach the console at all. */
export async function consoleAddressAllowed(): Promise<boolean> {
  const list = process.env.PLATFORM_CONSOLE_IP_ALLOWLIST?.trim();
  if (!list) return true;
  const ip = parseIp(await callerIp());
  if (!ip) return false;
  return list
    .split(",")
    .map((c) => parseCidr(c.trim()))
    .some((cidr) => !!cidr && cidrContains(cidr, ip));
}

async function cookieName(): Promise<string> {
  return (await secureRequest()) ? COOKIE_SECURE : COOKIE_PLAIN;
}

export async function currentStaffSession(): Promise<StaffSession | null> {
  if (!(await consoleAddressAllowed())) return null;
  const token = (await cookies()).get(await cookieName())?.value;
  if (!token || token.length > 100) return null;
  const session = await controlDb().platformSession.findUnique({ where: { id: sha256(token) }, include: { user: true } });
  if (!session || session.revokedAt || !session.user.active) return null;
  const now = Date.now();
  if (session.expiresAt.getTime() <= now || now - session.lastSeenAt.getTime() > IDLE_MS) return null;
  if (now - session.lastSeenAt.getTime() > TOUCH_MS) {
    await controlDb().platformSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } }).catch(() => {});
  }
  const { user } = session;
  const required = (await staffTwoFactorPolicy()).mode === "required";
  return {
    staff: { id: user.id, email: user.email, name: user.name, role: user.role },
    sessionId: session.id,
    mfaDone: !!session.mfaAt || (!required && !user.totpEnabledAt),
    enrolled: !!user.totpEnabledAt,
    twoFactorRequired: required,
  };
}

/** A console session with its second factor passed, in one of `roles` (any, when none are named). */
export async function requireStaff(roles?: readonly StaffRole[]): Promise<Staff> {
  const session = await currentStaffSession();
  if (!session || !session.mfaDone) throw new StaffRefused("Sign in to the console.");
  if (roles && roles.length && !roles.includes(session.staff.role)) throw new StaffRefused("Your role cannot do that.");
  return session.staff;
}

export type SignInResult = { ok: true; enrol: boolean } | { ok: false; error: string; needsCode?: boolean };

export async function signInStaff(input: { email: string; password: string; code?: string }): Promise<SignInResult> {
  if (!(await consoleAddressAllowed())) return { ok: false, error: "The console cannot be reached from this address." };
  const email = String(input.email ?? "").trim().toLowerCase();
  // By caller only when the caller is known: one shared "unknown" bucket would let anybody lock everybody out.
  const ip = await callerIp();
  const keys = [`console|account:${email}`, ...(ip ? [`console|caller:${ip}`] : [])];
  const locked = lockoutState(keys);
  if (locked.lockedOut) return { ok: false, error: `Too many attempts. Try again in ${Math.ceil(locked.retryInSeconds / 60)} minute(s).` };
  const refuse = (needsCode = false): SignInResult => {
    recordFailure(keys);
    return { ok: false, error: "That email, password or code is not right.", needsCode };
  };

  const user = await controlDb().platformUser.findUnique({ where: { email } });
  // Compared either way, so a wrong address and a wrong password take the same time.
  const passwordOk = await bcrypt.compare(String(input.password ?? ""), user?.passwordHash ?? NOBODY_HASH);
  if (!user || !user.active || !passwordOk) return refuse();
  let mfaAt: Date | null = null;
  if (user.totpEnabledAt) {
    const code = String(input.code ?? "").trim();
    if (!code) return { ok: false, error: "Enter the code from your authenticator.", needsCode: true };
    if (!user.totpSecretCipher || !verifyTotpCode(openForPlatform("staff-totp", user.totpSecretCipher), code)) return refuse(true);
    mfaAt = new Date();
  }
  clearFailures(keys);

  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const head = await headers();
  await controlDb().platformSession.create({
    data: { id: sha256(token), userId: user.id, expiresAt: new Date(now.getTime() + MAX_MS), mfaAt, ip, userAgent: head.get("user-agent")?.slice(0, 300) ?? null },
  });
  await controlDb().platformUser.update({ where: { id: user.id }, data: { lastSignInAt: now } });
  await controlDb().platformAuditLog.create({ data: { actorKind: "STAFF", actor: user.id, action: "staff.sign-in", detail: { twoFactor: !!mfaAt } } });
  (await cookies()).set(await cookieName(), token, { httpOnly: true, sameSite: "strict", path: "/", secure: await secureRequest(), maxAge: MAX_MS / 1000 });
  // Sent to enrol only where the policy asks for it; otherwise straight in.
  return { ok: true, enrol: !mfaAt && (await staffTwoFactorPolicy()).mode === "required" };
}

/** The enrolment page: a secret for this staff member's authenticator, made once and kept sealed. */
export async function enrolmentChallenge(): Promise<{ qr: string; secret: string } | null> {
  const session = await currentStaffSession();
  if (!session || session.enrolled) return null;
  const user = await controlDb().platformUser.findUniqueOrThrow({ where: { id: session.staff.id } });
  let secret = user.totpSecretCipher ? openForPlatform("staff-totp", user.totpSecretCipher) : null;
  if (!secret) {
    secret = generateTotpSecret();
    await controlDb().platformUser.update({ where: { id: user.id }, data: { totpSecretCipher: sealForPlatform("staff-totp", secret) } });
  }
  return { qr: await totpQrCodeDataUrl(`${user.email} (console)`, secret), secret };
}

export async function finishEnrolment(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await currentStaffSession();
  if (!session || session.enrolled) return { ok: false, error: "Sign in again." };
  const user = await controlDb().platformUser.findUniqueOrThrow({ where: { id: session.staff.id } });
  if (!user.totpSecretCipher || !verifyTotpCode(openForPlatform("staff-totp", user.totpSecretCipher), String(code ?? ""))) {
    return { ok: false, error: "That code is not right — check the time on your phone." };
  }
  const now = new Date();
  await controlDb().$transaction(async (tx) => {
    await tx.platformUser.update({ where: { id: user.id }, data: { totpEnabledAt: now } });
    await tx.platformSession.update({ where: { id: session.sessionId }, data: { mfaAt: now } });
    await tx.platformAuditLog.create({ data: { actorKind: "STAFF", actor: user.id, action: "staff.two-factor.enrolled" } });
  });
  return { ok: true };
}

export async function signOutStaff(): Promise<void> {
  const session = await currentStaffSession();
  if (session) await controlDb().platformSession.update({ where: { id: session.sessionId }, data: { revokedAt: new Date() } });
  (await cookies()).delete(await cookieName());
}
