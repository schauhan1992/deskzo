import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { CmsRole, Prisma } from "@deskzo/control-client";
import { actorRef, cmsAudit, refLabels, type CmsActor } from "@/lib/cms/audit";
import { CMS_IDLE_MS, CMS_MIN_PASSWORD, sha256, storeCmsTwoFactorPolicy } from "@/lib/cms/session";
import { CMS_ROLES, CmsRefused, type CmsSessionRow, type CmsTwoFactorMode, type CmsUserRow } from "@/lib/cms/types";
import { deviceFromUserAgent } from "@/lib/console-shared/format";
import { controlDb } from "@/lib/platform/control-db";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { PLATFORM_DOMAIN, protocolFor } from "@/lib/tenancy/host";

/**
 * The CMS's accounts — from the CMS's own Users page (ADMIN), the platform console's "Website CMS"
 * page (an owner inviting the first admin) and `npm run cms:user`.
 *
 * Nobody hands anybody a password: a new account gets a one-time link, valid for three days, to
 * choose their own, and a reset is the same link again. There is always at least one active ADMIN —
 * the last cannot be demoted or switched off — so the CMS never locks everybody out of itself.
 */

const SETUP_TTL_MS = 3 * 24 * 60 * 60_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The CMS's own address: cms.<PLATFORM_DOMAIN>[:PLATFORM_PORT]. */
export function cmsOrigin(): string {
  const host = `cms.${PLATFORM_DOMAIN}${process.env.PLATFORM_PORT?.trim() ? `:${process.env.PLATFORM_PORT.trim()}` : ""}`;
  return `${protocolFor(host)}://${host}`;
}

function cleanName(raw: unknown): string {
  const name = String(raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (name.length < 2 || name.length > 120) throw new CmsRefused("Give their name (2 to 120 characters).");
  return name;
}

function cleanRole(raw: unknown): CmsRole {
  const role = String(raw ?? "").toUpperCase() as CmsRole;
  if (!(CMS_ROLES as readonly string[]).includes(role)) throw new CmsRefused("Choose a role: admin, editor, author or viewer.");
  return role;
}

async function userOrRefuse(userId: string) {
  const user = await controlDb().cmsUser.findUnique({ where: { id: String(userId ?? "").slice(0, 40) } });
  if (!user) throw new CmsRefused("That account no longer exists.");
  return user;
}

/** A fresh one-time link to choose a password; the previous one stops working. */
export async function issueCmsSetupLink(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await controlDb().cmsUser.update({ where: { id: userId }, data: { setupTokenHash: sha256(token), setupExpiresAt: new Date(Date.now() + SETUP_TTL_MS) } });
  return `${cmsOrigin()}/setup?t=${encodeURIComponent(token)}`;
}

async function mailSetupLink(to: string, name: string, url: string, why: "new" | "reset" | "reactivated"): Promise<boolean> {
  const opening =
    why === "new"
      ? "You have been given an account on the website CMS. Choose your password here — the link works once, for three days:"
      : why === "reactivated"
        ? "Your website CMS account has been switched back on. Choose a new password here — the link works once, for three days:"
        : "Here is a link to choose a new password for the website CMS. It works once, for three days:";
  try {
    await sendPlatformMail({ type: "ACCOUNT", to, subject: "Your website CMS account", text: [`Hello ${name},`, "", opening, "", url, "", "If you did not expect this, you can ignore it."].join("\n") });
    return true;
  } catch (err) {
    console.error(`[cms] a setup email could not be sent: ${(err as { code?: string } | null)?.code ?? (err instanceof Error ? err.name : "error")}`);
    return false;
  }
}

/**
 * A new CMS account. The setup link is emailed to them and returned to the caller — for the person
 * who invited them to pass on if the mail does not arrive. Shown once; never stored.
 */
export async function createCmsUser(input: { email: string; name: string; role: CmsRole }, actor: CmsActor): Promise<{ id: string; setupUrl: string; emailed: boolean }> {
  const email = String(input?.email ?? "").trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 254) throw new CmsRefused("That doesn't look like an email address.");
  const name = cleanName(input?.name);
  const role = cleanRole(input?.role);
  if (await controlDb().cmsUser.findUnique({ where: { email }, select: { id: true } })) throw new CmsRefused("There is already a CMS account with that address.");
  const user = await controlDb().cmsUser.create({ data: { email, name, role, createdBy: actorRef(actor) }, select: { id: true } });
  const setupUrl = await issueCmsSetupLink(user.id);
  await cmsAudit(actor, "user.create", "user", user.id, { email, role });
  const emailed = await mailSetupLink(email, name, setupUrl, "new");
  return { id: user.id, setupUrl, emailed };
}

/** What a setup link's page shows before a password is chosen: whose it is, or that it no longer works. */
export async function cmsSetupLinkInfo(token: string): Promise<{ valid: true; name: string; email: string; firstTime: boolean } | { valid: false }> {
  const t = String(token ?? "");
  if (!t || t.length > 100) return { valid: false };
  const user = await controlDb().cmsUser.findUnique({ where: { setupTokenHash: sha256(t) }, select: { name: true, email: true, active: true, setupExpiresAt: true, passwordHash: true } });
  if (!user || !user.active || !user.setupExpiresAt || user.setupExpiresAt < new Date()) return { valid: false };
  return { valid: true, name: user.name, email: user.email, firstTime: !user.passwordHash };
}

/** Choosing a password from a one-time link. Signs them out everywhere they were signed in. */
export async function completeCmsPasswordSetup(token: string, password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const pw = String(password ?? "");
  if (pw.length < CMS_MIN_PASSWORD) return { ok: false, error: `Choose a password of at least ${CMS_MIN_PASSWORD} characters.` };
  if (pw.length > 200) return { ok: false, error: "Choose a password of at most 200 characters." };
  const t = String(token ?? "");
  const user = t && t.length <= 100 ? await controlDb().cmsUser.findUnique({ where: { setupTokenHash: sha256(t) } }) : null;
  if (!user || !user.active || !user.setupExpiresAt || user.setupExpiresAt < new Date()) {
    return { ok: false, error: "This link has expired or been used. Ask a CMS admin for a new one." };
  }
  const passwordHash = await bcrypt.hash(pw, 10);
  const now = new Date();
  const used = await controlDb().$transaction(async (tx) => {
    // Conditional on the hash still being there: two tabs submitting at once use the link once.
    const set = await tx.cmsUser.updateMany({ where: { id: user.id, setupTokenHash: user.setupTokenHash }, data: { passwordHash, setupTokenHash: null, setupExpiresAt: null } });
    if (set.count !== 1) return false;
    await tx.cmsSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
    return true;
  });
  if (!used) return { ok: false, error: "This link has expired or been used. Ask a CMS admin for a new one." };
  await cmsAudit({ kind: "cms", id: user.id, name: user.name, email: user.email }, "auth.password.set", "user", user.id);
  return { ok: true };
}

/**
 * Locks the active admins' rows for the rest of the transaction and refuses when `userId` is the last
 * of them — so two admins demoting each other at once cannot leave none.
 */
async function assertAnotherAdmin(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  const admins = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM cms_users WHERE role = 'ADMIN' AND active FOR UPDATE`;
  if (!admins.some((a) => a.id !== userId)) throw new CmsRefused("This is the last active admin. Make somebody else an admin first.");
}

export async function setCmsUserRole(userId: string, roleInput: CmsRole, actor: CmsActor): Promise<void> {
  const role = cleanRole(roleInput);
  const user = await userOrRefuse(userId);
  if (user.role === role) return;
  await controlDb().$transaction(async (tx) => {
    if (user.role === "ADMIN" && user.active) await assertAnotherAdmin(tx, user.id);
    await tx.cmsUser.update({ where: { id: user.id }, data: { role } });
  });
  await cmsAudit(actor, "user.role", "user", user.id, { email: user.email, from: user.role, to: role });
}

export async function deactivateCmsUser(userId: string, actor: CmsActor): Promise<void> {
  const user = await userOrRefuse(userId);
  if (actor.kind === "cms" && actor.id === user.id) throw new CmsRefused("You can't switch yourself off. Ask another admin.");
  if (!user.active) throw new CmsRefused(`${user.name} is already switched off.`);
  const now = new Date();
  await controlDb().$transaction(async (tx) => {
    if (user.role === "ADMIN") await assertAnotherAdmin(tx, user.id);
    await tx.cmsUser.update({ where: { id: user.id }, data: { active: false, setupTokenHash: null, setupExpiresAt: null } });
    await tx.cmsSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
  });
  await cmsAudit(actor, "user.deactivate", "user", user.id, { email: user.email });
}

/**
 * Switches an account back on as a new starter: the old password never works again, the
 * authenticator is forgotten, old sessions end, and a new setup link is emailed (and returned).
 */
export async function reactivateCmsUser(userId: string, actor: CmsActor): Promise<{ setupUrl: string; emailed: boolean }> {
  const user = await userOrRefuse(userId);
  if (user.active) throw new CmsRefused(`${user.name} is already switched on.`);
  const now = new Date();
  await controlDb().$transaction(async (tx) => {
    const switched = await tx.cmsUser.updateMany({
      where: { id: user.id, active: false },
      data: { active: true, passwordHash: null, setupTokenHash: null, setupExpiresAt: null, totpSecretCipher: null, totpEnabledAt: null },
    });
    if (switched.count !== 1) throw new CmsRefused(`${user.name} is already switched on.`);
    await tx.cmsSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
  });
  const setupUrl = await issueCmsSetupLink(user.id);
  await cmsAudit(actor, "user.reactivate", "user", user.id, { email: user.email });
  const emailed = await mailSetupLink(user.email, user.name, setupUrl, "reactivated");
  return { setupUrl, emailed };
}

/**
 * A new setup link for somebody — a lost first email, or a forgotten password. Emailed to them; the
 * link itself is returned only when `returnLink` (an admin passing it on) and never otherwise.
 */
export async function newCmsSetupLink(userId: string, actor: CmsActor, returnLink: boolean): Promise<{ setupUrl: string | null; emailed: boolean }> {
  const user = await userOrRefuse(userId);
  if (!user.active) throw new CmsRefused(`${user.name} is switched off. Switch them back on instead.`);
  const setupUrl = await issueCmsSetupLink(user.id);
  await cmsAudit(actor, "user.setup-link", "user", user.id, { email: user.email, returned: returnLink });
  const emailed = await mailSetupLink(user.email, user.name, setupUrl, user.passwordHash ? "reset" : "new");
  return { setupUrl: returnLink ? setupUrl : null, emailed };
}

/** A lost phone: their authenticator is forgotten and they are signed out everywhere. */
export async function resetCmsUserTwoFactor(userId: string, actor: CmsActor): Promise<void> {
  const user = await userOrRefuse(userId);
  const now = new Date();
  await controlDb().$transaction(async (tx) => {
    await tx.cmsUser.update({ where: { id: user.id }, data: { totpSecretCipher: null, totpEnabledAt: null } });
    await tx.cmsSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
  });
  await cmsAudit(actor, "user.two-factor.reset", "user", user.id, { email: user.email });
}

export async function endCmsUserSessions(userId: string, actor: CmsActor): Promise<number> {
  const user = await userOrRefuse(userId);
  const ended = await controlDb().cmsSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await cmsAudit(actor, "user.sessions.end", "user", user.id, { sessions: ended.count });
  return ended.count;
}

export async function renameCmsUser(userId: string, nameInput: string, actor: CmsActor): Promise<void> {
  const name = cleanName(nameInput);
  const user = await userOrRefuse(userId);
  await controlDb().cmsUser.update({ where: { id: user.id }, data: { name } });
  await cmsAudit(actor, "account.rename", "user", user.id);
}

export async function setCmsTwoFactorPolicy(mode: CmsTwoFactorMode, actor: CmsActor): Promise<void> {
  if (mode !== "optional" && mode !== "required") throw new CmsRefused("Two-factor is either optional or required.");
  await storeCmsTwoFactorPolicy(mode, actorRef(actor));
  await cmsAudit(actor, "security.two-factor-policy", "settings", "two-factor", { mode });
}

// ─── Lists ───────────────────────────────────────────────────────────────────────────────────────

function liveSessionWhere(now: Date): Prisma.CmsSessionWhereInput {
  return { revokedAt: null, expiresAt: { gt: now }, lastSeenAt: { gt: new Date(now.getTime() - CMS_IDLE_MS) } };
}

/** Everybody, active first, then by name — optionally only one role (the console lists the admins). */
export async function listCmsUsers(filter: { role?: CmsRole; activeOnly?: boolean } = {}, now = new Date()): Promise<CmsUserRow[]> {
  const rows = await controlDb().cmsUser.findMany({
    where: { ...(filter.role ? { role: filter.role } : {}), ...(filter.activeOnly ? { active: true } : {}) },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      active: true,
      totpEnabledAt: true,
      passwordHash: true,
      setupExpiresAt: true,
      lastSignInAt: true,
      createdAt: true,
      createdBy: true,
      _count: { select: { sessions: { where: liveSessionWhere(now) } } },
    },
  });
  const labels = await refLabels(rows.map((r) => r.createdBy));
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    active: r.active,
    twoFactor: !!r.totpEnabledAt,
    hasPassword: !!r.passwordHash,
    setupPending: !!r.setupExpiresAt && r.setupExpiresAt > now,
    lastSignInAt: r.lastSignInAt,
    createdAt: r.createdAt,
    createdBy: labels.get(r.createdBy) ?? r.createdBy,
    liveSessions: r._count.sessions,
  }));
}

/** A session's handle: names it for the UI without being its token or the stored hash of one. */
export const sessionHandle = (sessionId: string) => sha256(`cms-session-handle|${sessionId}`).slice(0, 24);

/** One person's live sessions, the current one first. */
export async function listCmsSessions(userId: string, currentSessionId: string | null = null, now = new Date()): Promise<CmsSessionRow[]> {
  const rows = await controlDb().cmsSession.findMany({
    where: { userId, ...liveSessionWhere(now) },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true, createdAt: true, lastSeenAt: true, expiresAt: true, mfaAt: true, ip: true, userAgent: true },
  });
  const mapped = rows.map((s) => ({
    handle: sessionHandle(s.id),
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    expiresAt: s.expiresAt,
    mfa: !!s.mfaAt,
    ip: s.ip,
    device: deviceFromUserAgent(s.userAgent),
    current: s.id === currentSessionId,
  }));
  return [...mapped.filter((s) => s.current), ...mapped.filter((s) => !s.current)];
}

/** Ends one of `userId`'s sessions by its handle. Somebody else's, or an ended one, is refused alike. */
export async function endCmsSessionByHandle(userId: string, handle: string, actor: CmsActor): Promise<void> {
  const h = String(handle ?? "").trim().toLowerCase();
  const live = /^[a-f0-9]{24}$/.test(h) ? await controlDb().cmsSession.findMany({ where: { userId, revokedAt: null }, select: { id: true } }) : [];
  const match = live.find((s) => sessionHandle(s.id) === h);
  if (!match) throw new CmsRefused("That session has already ended.");
  await controlDb().cmsSession.update({ where: { id: match.id }, data: { revokedAt: new Date() } });
  await cmsAudit(actor, "account.session.end", "user", userId, { session: h.slice(0, 8) });
}

/** Signs one person out everywhere except the session this request came with. */
export async function endOtherCmsSessions(userId: string, keepSessionId: string, actor: CmsActor): Promise<number> {
  const ended = await controlDb().cmsSession.updateMany({ where: { userId, revokedAt: null, NOT: { id: keepSessionId } }, data: { revokedAt: new Date() } });
  await cmsAudit(actor, "account.sessions.end-others", "user", userId, { sessions: ended.count });
  return ended.count;
}

const SELF_LINKS_PER_HOUR = 3;

/** "Email me a link to change my password": to their own address, never shown; three an hour. */
export async function emailOwnPasswordLink(userId: string, actor: CmsActor): Promise<void> {
  const user = await userOrRefuse(userId);
  const recent = await controlDb().cmsAuditLog.count({ where: { action: "account.password-link", entityId: user.id, at: { gt: new Date(Date.now() - 60 * 60_000) } } });
  if (recent >= SELF_LINKS_PER_HOUR) throw new CmsRefused("Several links have been sent in the last hour. Use the newest one, or try again later.");
  const url = await issueCmsSetupLink(user.id);
  await cmsAudit(actor, "account.password-link", "user", user.id);
  if (!(await mailSetupLink(user.email, user.name, url, "reset"))) throw new CmsRefused("The email could not be sent just now. Try again in a few minutes.");
}

/** Active CMS admins — none means the console's or the CLI's "first admin" is still to be made. */
export async function cmsAdminCount(): Promise<number> {
  return controlDb().cmsUser.count({ where: { role: "ADMIN", active: true } });
}
