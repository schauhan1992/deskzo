import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { cookies, headers } from "next/headers";
import { cmsAudit } from "@/lib/cms/audit";
import type { CmsMe, CmsTwoFactorMode } from "@/lib/cms/types";
import { clientIpFrom } from "@/lib/client-ip";
import { controlDb } from "@/lib/platform/control-db";
import { openForPlatform, sealForPlatform, type PlatformSealPurpose } from "@/lib/platform/kek";
import { clearFailures, lockoutState, recordFailure } from "@/lib/security/lockout";
import { classifyHost, protocolFor, requestHost } from "@/lib/tenancy/host";
import { generateTotpSecret, totpQrCodeDataUrl, verifyTotpCode } from "@/lib/totp";

/**
 * Signing in to the website CMS (cms.<domain>) — a sign-in of its own, nothing to do with the staff
 * console's or any workspace's. Modelled on src/lib/platform/staff-session.ts:
 *
 *   · The cookie is `__Host-wroffy-cms` over https (`wroffy-cms` on plain http in development): this
 *     host only. It holds a random token; the control plane keeps its SHA-256 as a CmsSession,
 *     checked on every request — sixty minutes idle, twelve hours at most, revocable.
 *   · A session counts only on the CMS host: the same cookie presented anywhere else (it would not be
 *     sent, but a script could) is nobody. A staff or workspace session means nothing here.
 *   · Two-factor follows the CMS's own policy, read on every request (cms_settings "two-factor"):
 *     "optional" — only people who set up an authenticator are asked for its code; "required" —
 *     everybody, and whoever has none is sent to enrol before anything else opens. Until an admin
 *     chooses, it is required in production and optional elsewhere.
 *   · Failed sign-ins lock out per account and per known caller, in a namespace of their own ("cms|").
 */

const COOKIE_SECURE = "__Host-wroffy-cms";
const COOKIE_PLAIN = "wroffy-cms";
export const CMS_IDLE_MS = 60 * 60_000;
export const CMS_MAX_MS = 12 * 60 * 60_000;
/** How often lastSeenAt is written — often enough for the idle limit, not on every request. */
const TOUCH_MS = 60_000;
export const CMS_MIN_PASSWORD = 12;

/**
 * kek.ts names its purposes as a union that does not list the CMS's yet; the purpose is only the
 * seal's associated data, so the name is what matters, and no other seal uses it.
 */
const TOTP_PURPOSE: PlatformSealPurpose = "cms-totp";
const sealTotp = (secret: string) => sealForPlatform(TOTP_PURPOSE, secret);
const openTotp = (sealed: string) => openForPlatform(TOTP_PURPOSE, sealed);

export type CmsSessionState = {
  user: CmsMe;
  /** The stored hash of the cookie's token — server side only; never hand it to a client. */
  sessionId: string;
  /** Through two-factor, or not asked for it. Only then does anything but enrolment open. */
  mfaDone: boolean;
  enrolled: boolean;
  twoFactorRequired: boolean;
  /** Two-factor is required and they have no authenticator yet: only enrolment opens. */
  needsEnrolment: boolean;
};

/** Compared against when the address has no account (or no password yet), so both refusals take a bcrypt's time. */
const NOBODY_HASH = bcrypt.hashSync(randomBytes(16).toString("hex"), 10);

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

// ─── The two-factor policy ───────────────────────────────────────────────────────────────────────

const POLICY_KEY = "two-factor";

/** What the policy is until an admin chooses: required in production, optional elsewhere. */
export const cmsTwoFactorDefault = (): CmsTwoFactorMode => (process.env.NODE_ENV === "production" ? "required" : "optional");

export async function cmsTwoFactorPolicy(): Promise<{ mode: CmsTwoFactorMode; chosen: boolean }> {
  const row = await controlDb().cmsSetting.findUnique({ where: { key: POLICY_KEY }, select: { value: true } });
  if (row?.value === "required" || row?.value === "optional") return { mode: row.value, chosen: true };
  return { mode: cmsTwoFactorDefault(), chosen: false };
}

/** Stores the policy. The caller audits (it knows who). */
export async function storeCmsTwoFactorPolicy(mode: CmsTwoFactorMode, by: string): Promise<void> {
  await controlDb().cmsSetting.upsert({ where: { key: POLICY_KEY }, create: { key: POLICY_KEY, value: mode, updatedBy: by }, update: { value: mode, updatedBy: by } });
}

// ─── The request ─────────────────────────────────────────────────────────────────────────────────

async function requestIsOnCmsHost(): Promise<{ onCms: boolean; secure: boolean }> {
  const host = requestHost(await headers());
  if (typeof host !== "string") return { onCms: false, secure: false };
  return { onCms: classifyHost(host).kind === "cms", secure: protocolFor(host) === "https" };
}

async function cookieName(): Promise<string> {
  return (await requestIsOnCmsHost()).secure ? COOKIE_SECURE : COOKIE_PLAIN;
}

async function callerIp(): Promise<string | null> {
  return clientIpFrom(await headers());
}

/** Whether a user's session state lets them past two-factor. */
function mfaState(mode: CmsTwoFactorMode, enrolled: boolean, mfaAt: Date | null) {
  const required = mode === "required";
  return {
    twoFactorRequired: required,
    needsEnrolment: required && !enrolled,
    // Required: an authenticator and its code in this session. Optional: its code if they have one.
    mfaDone: enrolled ? !!mfaAt : !required,
  };
}

/** The CMS session this request carries, or null — on any host but the CMS's, always null. */
export async function currentCmsSession(): Promise<CmsSessionState | null> {
  const { onCms } = await requestIsOnCmsHost();
  if (!onCms) return null;
  const token = (await cookies()).get(await cookieName())?.value;
  if (!token || token.length > 100) return null;
  const session = await controlDb().cmsSession.findUnique({ where: { id: sha256(token) }, include: { user: true } });
  if (!session || session.revokedAt || !session.user.active) return null;
  const now = Date.now();
  if (session.expiresAt.getTime() <= now || now - session.lastSeenAt.getTime() > CMS_IDLE_MS) return null;
  if (now - session.lastSeenAt.getTime() > TOUCH_MS) {
    await controlDb().cmsSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } }).catch(() => {});
  }
  const { user } = session;
  const enrolled = !!user.totpEnabledAt && !!user.totpSecretCipher;
  const policy = await cmsTwoFactorPolicy();
  return {
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    sessionId: session.id,
    enrolled,
    ...mfaState(policy.mode, enrolled, session.mfaAt),
  };
}

// ─── Signing in and out ──────────────────────────────────────────────────────────────────────────

export type CmsSignInResult = { ok: true; next: "/" | "/enrol" } | { ok: false; error: string; needsCode?: boolean };

export async function signInCms(input: { email: string; password: string; code?: string }): Promise<CmsSignInResult> {
  if (!(await requestIsOnCmsHost()).onCms) return { ok: false, error: "Sign in at the CMS's own address." };
  const email = String(input?.email ?? "").trim().toLowerCase().slice(0, 254);
  // By caller only when the caller is known: one shared "unknown" bucket would let anybody lock everybody out.
  const ip = await callerIp();
  const keys = [`cms|account:${email}`, ...(ip ? [`cms|caller:${ip}`] : [])];
  const locked = lockoutState(keys);
  if (locked.lockedOut) return { ok: false, error: `Too many attempts. Try again in ${Math.ceil(locked.retryInSeconds / 60)} minute(s).` };
  const refuse = (needsCode = false): CmsSignInResult => {
    recordFailure(keys);
    return { ok: false, error: "That email, password or code is not right.", needsCode };
  };

  const user = email ? await controlDb().cmsUser.findUnique({ where: { email } }) : null;
  // Compared either way, so a wrong address, no password yet and a wrong password take the same time.
  const passwordOk = await bcrypt.compare(String(input?.password ?? "").slice(0, 200), user?.passwordHash ?? NOBODY_HASH);
  if (!user || !user.active || !user.passwordHash || !passwordOk) return refuse();

  const policy = await cmsTwoFactorPolicy();
  const enrolled = !!user.totpEnabledAt && !!user.totpSecretCipher;
  let mfaAt: Date | null = null;
  // Whoever has an authenticator is asked for its code, whatever the policy.
  if (enrolled) {
    const code = String(input?.code ?? "").trim();
    if (!code) return { ok: false, error: "Enter the code from your authenticator.", needsCode: true };
    if (!verifyTotpCode(openTotp(user.totpSecretCipher!), code)) return refuse(true);
    mfaAt = new Date();
  }
  clearFailures(keys);

  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const head = await headers();
  await controlDb().cmsSession.create({
    data: { id: sha256(token), userId: user.id, expiresAt: new Date(now.getTime() + CMS_MAX_MS), mfaAt, ip, userAgent: head.get("user-agent")?.slice(0, 300) ?? null },
  });
  await controlDb().cmsUser.update({ where: { id: user.id }, data: { lastSignInAt: now } });
  await cmsAudit({ kind: "cms", id: user.id, name: user.name, email: user.email }, "auth.sign-in", "user", user.id, { twoFactor: !!mfaAt });
  const secure = (await requestIsOnCmsHost()).secure;
  (await cookies()).set(secure ? COOKIE_SECURE : COOKIE_PLAIN, token, { httpOnly: true, sameSite: "strict", path: "/", secure, maxAge: CMS_MAX_MS / 1000 });
  return { ok: true, next: policy.mode === "required" && !enrolled ? "/enrol" : "/" };
}

export async function signOutCms(): Promise<void> {
  const session = await currentCmsSession();
  if (session) {
    await controlDb().cmsSession.update({ where: { id: session.sessionId }, data: { revokedAt: new Date() } });
    await cmsAudit({ kind: "cms", ...session.user }, "auth.sign-out", "user", session.user.id);
  }
  (await cookies()).delete(await cookieName());
}

// ─── Two-factor enrolment ────────────────────────────────────────────────────────────────────────

/**
 * The enrolment page's QR code and secret, for the signed-in user's authenticator — made once and kept
 * sealed. Null when there is no session, or they already have one set up. For a server page to render
 * to its own user; no action hands this out.
 */
export async function cmsEnrolmentChallenge(): Promise<{ qr: string; secret: string } | null> {
  const session = await currentCmsSession();
  if (!session || session.enrolled) return null;
  const user = await controlDb().cmsUser.findUniqueOrThrow({ where: { id: session.user.id } });
  let secret = user.totpSecretCipher ? openTotp(user.totpSecretCipher) : null;
  if (!secret) {
    secret = generateTotpSecret();
    await controlDb().cmsUser.update({ where: { id: user.id }, data: { totpSecretCipher: sealTotp(secret) } });
  }
  return { qr: await totpQrCodeDataUrl(`${user.email} (Wroffy CMS)`, secret), secret };
}

/** Finishes enrolment with a code from the new authenticator. Their other sessions end. */
export async function finishCmsEnrolment(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await currentCmsSession();
  if (!session || session.enrolled) return { ok: false, error: "Sign in again." };
  const user = await controlDb().cmsUser.findUniqueOrThrow({ where: { id: session.user.id } });
  if (!user.totpSecretCipher || !verifyTotpCode(openTotp(user.totpSecretCipher), String(code ?? "").slice(0, 12))) {
    return { ok: false, error: "That code is not right — check the time on your phone." };
  }
  const now = new Date();
  await controlDb().$transaction(async (tx) => {
    await tx.cmsUser.update({ where: { id: user.id }, data: { totpEnabledAt: now } });
    await tx.cmsSession.update({ where: { id: session.sessionId }, data: { mfaAt: now } });
    await tx.cmsSession.updateMany({ where: { userId: user.id, revokedAt: null, NOT: { id: session.sessionId } }, data: { revokedAt: now } });
  });
  await cmsAudit({ kind: "cms", ...session.user }, "auth.two-factor.enrolled", "user", user.id);
  return { ok: true };
}

/**
 * Removes the signed-in user's own authenticator, proven with a current code from it — a stolen
 * session alone cannot. Their other sessions end; where two-factor is required they enrol again next.
 */
export async function removeOwnCmsTwoFactor(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await currentCmsSession();
  if (!session || !session.mfaDone || !session.enrolled) return { ok: false, error: "There is no authenticator to remove." };
  const user = await controlDb().cmsUser.findUniqueOrThrow({ where: { id: session.user.id } });
  if (!user.totpSecretCipher || !verifyTotpCode(openTotp(user.totpSecretCipher), String(code ?? "").slice(0, 12))) {
    return { ok: false, error: "That code is not right — check the time on your phone." };
  }
  const now = new Date();
  await controlDb().$transaction(async (tx) => {
    await tx.cmsUser.update({ where: { id: user.id }, data: { totpSecretCipher: null, totpEnabledAt: null } });
    await tx.cmsSession.update({ where: { id: session.sessionId }, data: { mfaAt: null } });
    await tx.cmsSession.updateMany({ where: { userId: user.id, revokedAt: null, NOT: { id: session.sessionId } }, data: { revokedAt: now } });
  });
  await cmsAudit({ kind: "cms", ...session.user }, "auth.two-factor.removed", "user", user.id, { by: "self" });
  return { ok: true };
}
