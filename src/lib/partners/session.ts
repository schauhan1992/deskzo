import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { cookies, headers } from "next/headers";
import { clientIpFrom } from "@/lib/client-ip";
import { partnerAudit, type PartnerActor } from "@/lib/partners/audit";
import { partnerTwoFactorPolicy } from "@/lib/partners/settings";
import type { PartnerMe, PartnerTwoFactorMode } from "@/lib/partners/types";
import { controlDb } from "@/lib/platform/control-db";
import { openForPlatform, sealForPlatform } from "@/lib/platform/kek";
import { clearFailures, lockoutState, recordFailure } from "@/lib/security/lockout";
import { PLATFORM_DOMAIN, classifyHost, protocolFor, requestHost } from "@/lib/tenancy/host";
import { generateTotpSecret, totpQrCodeDataUrl, verifyTotpCode } from "@/lib/totp";

/**
 * Signing in to the partner portal (partners.<domain>) — a sign-in of its own, nothing to do with
 * the staff console's, the CMS's or any workspace's. Modelled on src/lib/cms/session.ts:
 *
 *   · The cookie is `__Host-deskzo-partners` over https (`deskzo-partners` on plain http in
 *     development): this host only. It holds a random token; the control plane keeps its SHA-256 as a
 *     PartnerSession, checked on every request — sixty minutes idle, twelve hours at most, revocable.
 *   · A session counts only on the partners host: the same cookie presented anywhere else (it would
 *     not be sent, but a script could) is nobody. A staff, CMS or workspace session means nothing here.
 *   · A session is nobody once its user is switched off or its partner is TERMINATED — whatever the
 *     cookie says, checked on every request.
 *   · Two-factor follows the portal's own policy, read on every request (platform setting
 *     partners.twoFactor, set by owners in the console): "optional" — only people who set up an
 *     authenticator are asked for its code; "required" — everybody, and whoever has none is sent to
 *     enrol before anything else opens. Until an owner chooses, it is required in production and
 *     optional elsewhere.
 *   · Failed sign-ins lock out per account and per known caller, in a namespace of their own ("partner|").
 */

const COOKIE_SECURE = "__Host-deskzo-partners";
const COOKIE_PLAIN = "deskzo-partners";
export const PARTNER_IDLE_MS = 60 * 60_000;
export const PARTNER_MAX_MS = 12 * 60 * 60_000;
/** How often lastSeenAt is written — often enough for the idle limit, not on every request. */
const TOUCH_MS = 60_000;

const sealTotp = (secret: string) => sealForPlatform("partner-totp", secret);
const openTotp = (sealed: string) => openForPlatform("partner-totp", sealed);

export type PartnerSessionState = {
  user: PartnerMe;
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

/** The partner fields every session carries (PartnerMe.partner), read with the session in one query. */
const PARTNER_OF_ME = { id: true, slug: true, displayName: true, kind: true, status: true, parentId: true, territories: true } as const;

/**
 * Whether a user has an authenticator set up. `totpEnabledAt` alone: it is set only once a code from
 * the sealed secret has been checked, and cleared together with it — and reading it never touches
 * the secret. (Were it ever set without a secret, sign-in asks for a code that cannot pass: shut, not open.)
 */
const hasAuthenticator = (user: { totpEnabledAt: Date | null }) => !!user.totpEnabledAt;

const actorOf = (user: PartnerMe): PartnerActor => ({ kind: "partner", id: user.id, name: user.name, email: user.email, partnerId: user.partner.id });

// ─── The request ─────────────────────────────────────────────────────────────────────────────────

async function requestIsOnPartnersHost(): Promise<{ onPartners: boolean; secure: boolean }> {
  const host = requestHost(await headers());
  if (typeof host !== "string") return { onPartners: false, secure: false };
  return { onPartners: classifyHost(host).kind === "partners", secure: protocolFor(host) === "https" };
}

async function cookieName(): Promise<string> {
  return (await requestIsOnPartnersHost()).secure ? COOKIE_SECURE : COOKIE_PLAIN;
}

async function callerIp(): Promise<string | null> {
  return clientIpFrom(await headers());
}

/** Whether a user's session state lets them past two-factor. */
function mfaState(mode: PartnerTwoFactorMode, enrolled: boolean, mfaAt: Date | null) {
  const required = mode === "required";
  return {
    twoFactorRequired: required,
    needsEnrolment: required && !enrolled,
    // Required: an authenticator and its code in this session. Optional: its code if they have one.
    mfaDone: enrolled ? !!mfaAt : !required,
  };
}

/** The portal session this request carries, or null — on any host but the portal's, always null. */
export async function currentPartnerSession(): Promise<PartnerSessionState | null> {
  const { onPartners } = await requestIsOnPartnersHost();
  if (!onPartners) return null;
  const token = (await cookies()).get(await cookieName())?.value;
  if (!token || token.length > 100) return null;
  const session = await controlDb().partnerSession.findUnique({
    where: { id: sha256(token) },
    select: {
      id: true,
      expiresAt: true,
      lastSeenAt: true,
      mfaAt: true,
      revokedAt: true,
      user: { select: { id: true, email: true, name: true, role: true, active: true, totpEnabledAt: true, partner: { select: PARTNER_OF_ME } } },
    },
  });
  if (!session || session.revokedAt || !session.user.active || session.user.partner.status === "TERMINATED") return null;
  const now = Date.now();
  if (session.expiresAt.getTime() <= now || now - session.lastSeenAt.getTime() > PARTNER_IDLE_MS) return null;
  if (now - session.lastSeenAt.getTime() > TOUCH_MS) {
    await controlDb().partnerSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) }, select: { id: true } }).catch(() => {});
  }
  const { user } = session;
  const enrolled = hasAuthenticator(user);
  const policy = await partnerTwoFactorPolicy();
  return {
    user: { id: user.id, email: user.email, name: user.name, role: user.role, partner: { ...user.partner, territories: [...user.partner.territories] } },
    sessionId: session.id,
    enrolled,
    ...mfaState(policy.mode, enrolled, session.mfaAt),
  };
}

// ─── Signing in and out ──────────────────────────────────────────────────────────────────────────

export type PartnerSignInResult = { ok: true; next: "/" | "/enrol" } | { ok: false; error: string; needsCode?: boolean };

export async function signInPartner(input: { email: string; password: string; code?: string }): Promise<PartnerSignInResult> {
  if (!(await requestIsOnPartnersHost()).onPartners) return { ok: false, error: "Sign in at the partner portal's own address." };
  const email = String(input?.email ?? "").trim().toLowerCase().slice(0, 254);
  // By caller only when the caller is known: one shared "unknown" bucket would let anybody lock everybody out.
  const ip = await callerIp();
  const keys = [`partner|account:${email}`, ...(ip ? [`partner|caller:${ip}`] : [])];
  const locked = lockoutState(keys);
  if (locked.lockedOut) return { ok: false, error: `Too many attempts. Try again in ${Math.ceil(locked.retryInSeconds / 60)} minute(s).` };
  const refuse = (needsCode = false): PartnerSignInResult => {
    recordFailure(keys);
    return { ok: false, error: "That email, password or code is not right.", needsCode };
  };

  const user = email
    ? await controlDb().partnerUser.findUnique({
        where: { email },
        select: { id: true, email: true, name: true, role: true, active: true, passwordHash: true, totpSecretCipher: true, totpEnabledAt: true, partner: { select: PARTNER_OF_ME } },
      })
    : null;
  // Compared either way, so a wrong address, no password yet and a wrong password take the same time.
  const passwordOk = await bcrypt.compare(String(input?.password ?? "").slice(0, 200), user?.passwordHash ?? NOBODY_HASH);
  // A terminated partner's people are refused like a wrong password: the portal says nothing about whose account is whose.
  if (!user || !user.active || !user.passwordHash || !passwordOk || user.partner.status === "TERMINATED") return refuse();

  const policy = await partnerTwoFactorPolicy();
  const enrolled = hasAuthenticator(user);
  let mfaAt: Date | null = null;
  // Whoever has an authenticator is asked for its code, whatever the policy.
  if (enrolled) {
    const code = String(input?.code ?? "").trim();
    if (!code) return { ok: false, error: "Enter the code from your authenticator.", needsCode: true };
    if (!user.totpSecretCipher || !verifyTotpCode(openTotp(user.totpSecretCipher), code.slice(0, 12))) return refuse(true);
    mfaAt = new Date();
  }
  clearFailures(keys);

  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const head = await headers();
  await controlDb().partnerSession.create({
    data: { id: sha256(token), userId: user.id, expiresAt: new Date(now.getTime() + PARTNER_MAX_MS), mfaAt, ip, userAgent: head.get("user-agent")?.slice(0, 300) ?? null },
    select: { id: true },
  });
  await controlDb().partnerUser.update({ where: { id: user.id }, data: { lastSignInAt: now }, select: { id: true } });
  const me: PartnerMe = { id: user.id, email: user.email, name: user.name, role: user.role, partner: { ...user.partner, territories: [...user.partner.territories] } };
  await partnerAudit(actorOf(me), me.partner.id, "auth.sign-in", "user", user.id, { twoFactor: !!mfaAt });
  const secure = (await requestIsOnPartnersHost()).secure;
  (await cookies()).set(secure ? COOKIE_SECURE : COOKIE_PLAIN, token, { httpOnly: true, sameSite: "strict", path: "/", secure, maxAge: PARTNER_MAX_MS / 1000 });
  return { ok: true, next: policy.mode === "required" && !enrolled ? "/enrol" : "/" };
}

export async function signOutPartner(): Promise<void> {
  const session = await currentPartnerSession();
  if (session) {
    await controlDb().partnerSession.update({ where: { id: session.sessionId }, data: { revokedAt: new Date() }, select: { id: true } });
    await partnerAudit(actorOf(session.user), session.user.partner.id, "auth.sign-out", "user", session.user.id);
  }
  (await cookies()).delete(await cookieName());
}

// ─── Two-factor enrolment ────────────────────────────────────────────────────────────────────────

/** The authenticator app's label: whose account, on which portal. */
const totpLabel = (email: string) => `${email} (partners.${PLATFORM_DOMAIN})`;

/**
 * The enrolment page's QR code and secret, for the signed-in user's authenticator — made once and kept
 * sealed. Null when there is no session, or they already have one set up. For a server page to render
 * to its own user; no action hands this out.
 */
export async function partnerEnrolmentChallenge(): Promise<{ qr: string; secret: string } | null> {
  const session = await currentPartnerSession();
  if (!session || session.enrolled) return null;
  const user = await controlDb().partnerUser.findUniqueOrThrow({ where: { id: session.user.id }, select: { id: true, email: true, totpSecretCipher: true } });
  let secret = user.totpSecretCipher ? openTotp(user.totpSecretCipher) : null;
  if (!secret) {
    secret = generateTotpSecret();
    await controlDb().partnerUser.update({ where: { id: user.id }, data: { totpSecretCipher: sealTotp(secret) }, select: { id: true } });
  }
  return { qr: await totpQrCodeDataUrl(totpLabel(user.email), secret), secret };
}

/** Finishes enrolment with a code from the new authenticator. Their other sessions end. */
export async function finishPartnerEnrolment(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await currentPartnerSession();
  if (!session || session.enrolled) return { ok: false, error: "Sign in again." };
  const user = await controlDb().partnerUser.findUniqueOrThrow({ where: { id: session.user.id }, select: { id: true, totpSecretCipher: true } });
  if (!user.totpSecretCipher || !verifyTotpCode(openTotp(user.totpSecretCipher), String(code ?? "").slice(0, 12))) {
    return { ok: false, error: "That code is not right — check the time on your phone." };
  }
  const now = new Date();
  await controlDb().$transaction(async (tx) => {
    await tx.partnerUser.update({ where: { id: user.id }, data: { totpEnabledAt: now }, select: { id: true } });
    await tx.partnerSession.update({ where: { id: session.sessionId }, data: { mfaAt: now }, select: { id: true } });
    await tx.partnerSession.updateMany({ where: { userId: user.id, revokedAt: null, NOT: { id: session.sessionId } }, data: { revokedAt: now } });
  });
  await partnerAudit(actorOf(session.user), session.user.partner.id, "auth.two-factor.enrolled", "user", user.id);
  return { ok: true };
}

/**
 * Removes the signed-in user's own authenticator, proven with a current code from it — a stolen
 * session alone cannot. Their other sessions end; where two-factor is required they enrol again next.
 */
export async function removeOwnPartnerTwoFactor(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await currentPartnerSession();
  if (!session || !session.mfaDone || !session.enrolled) return { ok: false, error: "There is no authenticator to remove." };
  const user = await controlDb().partnerUser.findUniqueOrThrow({ where: { id: session.user.id }, select: { id: true, totpSecretCipher: true } });
  if (!user.totpSecretCipher || !verifyTotpCode(openTotp(user.totpSecretCipher), String(code ?? "").slice(0, 12))) {
    return { ok: false, error: "That code is not right — check the time on your phone." };
  }
  const now = new Date();
  await controlDb().$transaction(async (tx) => {
    await tx.partnerUser.update({ where: { id: user.id }, data: { totpSecretCipher: null, totpEnabledAt: null }, select: { id: true } });
    await tx.partnerSession.update({ where: { id: session.sessionId }, data: { mfaAt: null }, select: { id: true } });
    await tx.partnerSession.updateMany({ where: { userId: user.id, revokedAt: null, NOT: { id: session.sessionId } }, data: { revokedAt: now } });
  });
  await partnerAudit(actorOf(session.user), session.user.partner.id, "auth.two-factor.removed", "user", user.id, { by: "self" });
  return { ok: true };
}
