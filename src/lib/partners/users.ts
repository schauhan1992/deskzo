import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { Prisma, type PartnerRole } from "@wroffy/control-client";
import { deviceFromUserAgent } from "@/lib/console-shared/format";
import { actorRef, partnerAudit, refLabels, type PartnerActor } from "@/lib/partners/audit";
import { PARTNER_IDLE_MS, sha256 } from "@/lib/partners/session";
import { PARTNER_LIMITS, PARTNER_MIN_PASSWORD, PARTNER_ROLES, PartnerRefused, type PartnerSessionRow, type PartnerUserRow } from "@/lib/partners/types";
import { controlDb } from "@/lib/platform/control-db";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { PLATFORM_DOMAIN, protocolFor } from "@/lib/tenancy/host";

/**
 * The partner portal's accounts — from the portal's own Team page (a partner's ADMIN), the console's
 * partner page (staff inviting a partner's first admin) and `npm run partners -- user …`.
 *
 * Every function takes the partner's id and refuses a user of any other partner with the same words
 * as a user that does not exist, so one partner can never reach another's people, nor learn that
 * they exist. At most 50 active users a partner.
 *
 * Nobody hands anybody a password: a new account gets a one-time link, valid for three days, to
 * choose their own, and a reset is the same link again. A partner always keeps at least one active
 * ADMIN — the last cannot be demoted or switched off — so it never locks itself out of its own team.
 *
 * An address is one account across the whole portal. One already in use — by this partner or any
 * other — is refused in words that say nothing about where it is used.
 */

const SETUP_TTL_MS = 3 * 24 * 60 * 60_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ADDRESS_TAKEN = "That address can't be invited. Ask platform support if it should be.";
const TERMINATED = "This partner is terminated, so its people cannot sign in.";

/** The portal's own address: partners.<PLATFORM_DOMAIN>[:PLATFORM_PORT]. */
export function partnerOrigin(): string {
  const host = `partners.${PLATFORM_DOMAIN}${process.env.PLATFORM_PORT?.trim() ? `:${process.env.PLATFORM_PORT.trim()}` : ""}`;
  return `${protocolFor(host)}://${host}`;
}

const cleanId = (value: unknown) => String(value ?? "").slice(0, 40);

function cleanName(raw: unknown): string {
  const name = String(raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (name.length < 2 || name.length > 120) throw new PartnerRefused("Give their name (2 to 120 characters).");
  return name;
}

function cleanRole(raw: unknown): PartnerRole {
  const role = String(raw ?? "").toUpperCase() as PartnerRole;
  if (!(PARTNER_ROLES as readonly string[]).includes(role)) throw new PartnerRefused("Choose a role: admin, finance, sales or viewer.");
  return role;
}

const isUniqueViolation = (err: unknown) =>
  (err instanceof Prisma.PrismaClientKnownRequestError || (err instanceof Error && err.name === "PrismaClientKnownRequestError")) && (err as { code?: unknown }).code === "P2002";

/** One of this partner's users — or the same refusal for somebody else's and for nobody's. */
async function userOrRefuse(partnerId: string, userId: string) {
  const id = cleanId(userId);
  const pid = cleanId(partnerId);
  const user = id && pid
    ? await controlDb().partnerUser.findFirst({
        where: { id, partnerId: pid },
        select: { id: true, partnerId: true, email: true, name: true, role: true, active: true, partner: { select: { status: true } } },
      })
    : null;
  if (!user) throw new PartnerRefused("That account no longer exists.");
  return user;
}

/** Whether they have chosen a password — asked of the database, so the hash itself is never read. */
async function hasPassword(userId: string): Promise<boolean> {
  return (await controlDb().partnerUser.count({ where: { id: userId, passwordHash: { not: null } } })) > 0;
}

/**
 * Locks the partner's row for the rest of the transaction — so two invitations at once cannot both
 * take the fiftieth place — and refuses a partner that is gone or terminated.
 */
async function lockPartnerForUsers(tx: Prisma.TransactionClient, partnerId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT id, status::text AS status FROM partners WHERE id = ${partnerId} FOR UPDATE`;
  if (!rows[0]) throw new PartnerRefused("That partner no longer exists.");
  if (rows[0].status === "TERMINATED") throw new PartnerRefused(TERMINATED);
}

async function assertRoomForOneMore(tx: Prisma.TransactionClient, partnerId: string): Promise<void> {
  const active = await tx.partnerUser.count({ where: { partnerId, active: true } });
  if (active >= PARTNER_LIMITS.users) throw new PartnerRefused(`A partner can have at most ${PARTNER_LIMITS.users} active users. Switch somebody off first.`);
}

/** A fresh one-time link to choose a password; the previous one stops working. */
export async function issuePartnerSetupLink(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await controlDb().partnerUser.update({ where: { id: userId }, data: { setupTokenHash: sha256(token), setupExpiresAt: new Date(Date.now() + SETUP_TTL_MS) }, select: { id: true } });
  return `${partnerOrigin()}/setup?t=${encodeURIComponent(token)}`;
}

async function mailSetupLink(to: string, name: string, url: string, why: "new" | "reset" | "reactivated"): Promise<boolean> {
  const opening =
    why === "new"
      ? "You have been given an account on the partner portal. Choose your password here — the link works once, for three days:"
      : why === "reactivated"
        ? "Your partner portal account has been switched back on. Choose a new password here — the link works once, for three days:"
        : "Here is a link to choose a new password for the partner portal. It works once, for three days:";
  try {
    await sendPlatformMail({ to, subject: "Partner portal: your account", text: [`Hello ${name},`, "", opening, "", url, "", "If you did not expect this, you can ignore it."].join("\n") });
    return true;
  } catch (err) {
    console.error(`[partners] a setup email could not be sent: ${(err as { code?: string } | null)?.code ?? (err instanceof Error ? err.name : "error")}`);
    return false;
  }
}

/**
 * A new portal account for one partner. The setup link is emailed to them and returned to the
 * caller — for the person who invited them to pass on if the mail does not arrive. Shown once;
 * never stored.
 */
export async function createPartnerUser(partnerId: string, input: { email: string; name: string; role: PartnerRole }, actor: PartnerActor): Promise<{ id: string; setupUrl: string; emailed: boolean }> {
  const email = String(input?.email ?? "").trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 254) throw new PartnerRefused("That doesn't look like an email address.");
  const name = cleanName(input?.name);
  const role = cleanRole(input?.role);
  const pid = cleanId(partnerId);
  if (!pid) throw new PartnerRefused("That partner no longer exists.");
  let id: string;
  try {
    id = await controlDb().$transaction(async (tx) => {
      await lockPartnerForUsers(tx, pid);
      if (await tx.partnerUser.findUnique({ where: { email }, select: { id: true } })) throw new PartnerRefused(ADDRESS_TAKEN);
      await assertRoomForOneMore(tx, pid);
      const made = await tx.partnerUser.create({ data: { partnerId: pid, email, name, role, createdBy: actorRef(actor) }, select: { id: true } });
      return made.id;
    });
  } catch (err) {
    // Two invitations of one address at once: the second meets the unique index, and hears the same.
    if (isUniqueViolation(err)) throw new PartnerRefused(ADDRESS_TAKEN);
    throw err;
  }
  const setupUrl = await issuePartnerSetupLink(id);
  await partnerAudit(actor, pid, "user.invite", "user", id, { email, role });
  const emailed = await mailSetupLink(email, name, setupUrl, "new");
  return { id, setupUrl, emailed };
}

/** What a setup link's page shows before a password is chosen: whose it is, or that it no longer works. */
export async function partnerSetupLinkInfo(token: string): Promise<{ valid: true; name: string; email: string; firstTime: boolean } | { valid: false }> {
  const t = String(token ?? "");
  if (!t || t.length > 100) return { valid: false };
  const user = await controlDb().partnerUser.findUnique({
    where: { setupTokenHash: sha256(t) },
    select: { id: true, name: true, email: true, active: true, setupExpiresAt: true, partner: { select: { status: true } } },
  });
  if (!user || !user.active || !user.setupExpiresAt || user.setupExpiresAt < new Date() || user.partner.status === "TERMINATED") return { valid: false };
  return { valid: true, name: user.name, email: user.email, firstTime: !(await hasPassword(user.id)) };
}

/** Choosing a password from a one-time link. Signs them out everywhere they were signed in. */
export async function completePartnerPasswordSetup(token: string, password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const pw = String(password ?? "");
  if (pw.length < PARTNER_MIN_PASSWORD) return { ok: false, error: `Choose a password of at least ${PARTNER_MIN_PASSWORD} characters.` };
  if (pw.length > 200) return { ok: false, error: "Choose a password of at most 200 characters." };
  const expired = { ok: false as const, error: "This link has expired or been used. Ask your partner portal admin for a new one." };
  const t = String(token ?? "");
  if (!t || t.length > 100) return expired;
  const tokenHash = sha256(t);
  const user = await controlDb().partnerUser.findUnique({
    where: { setupTokenHash: tokenHash },
    select: { id: true, partnerId: true, email: true, name: true, active: true, setupExpiresAt: true, partner: { select: { status: true } } },
  });
  if (!user || !user.active || !user.setupExpiresAt || user.setupExpiresAt < new Date() || user.partner.status === "TERMINATED") return expired;
  const passwordHash = await bcrypt.hash(pw, 10);
  const now = new Date();
  const used = await controlDb().$transaction(async (tx) => {
    // Conditional on the hash still being there: two tabs submitting at once use the link once.
    const set = await tx.partnerUser.updateMany({ where: { id: user.id, setupTokenHash: tokenHash }, data: { passwordHash, setupTokenHash: null, setupExpiresAt: null } });
    if (set.count !== 1) return false;
    await tx.partnerSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
    return true;
  });
  if (!used) return expired;
  await partnerAudit({ kind: "partner", id: user.id, name: user.name, email: user.email, partnerId: user.partnerId }, user.partnerId, "auth.password.set", "user", user.id);
  return { ok: true };
}

/**
 * Locks the partner's active admins' rows for the rest of the transaction and refuses when `userId`
 * is the last of them — so two admins demoting each other at once cannot leave none.
 */
async function assertAnotherAdmin(tx: Prisma.TransactionClient, partnerId: string, userId: string): Promise<void> {
  const admins = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM partner_users WHERE "partnerId" = ${partnerId} AND role = 'ADMIN' AND active FOR UPDATE`;
  if (!admins.some((a) => a.id !== userId)) throw new PartnerRefused("This is the last active admin. Make somebody else an admin first.");
}

export async function setPartnerUserRole(partnerId: string, userId: string, roleInput: PartnerRole, actor: PartnerActor): Promise<void> {
  const role = cleanRole(roleInput);
  const user = await userOrRefuse(partnerId, userId);
  if (user.role === role) return;
  await controlDb().$transaction(async (tx) => {
    if (user.role === "ADMIN" && user.active) await assertAnotherAdmin(tx, user.partnerId, user.id);
    await tx.partnerUser.update({ where: { id: user.id }, data: { role }, select: { id: true } });
  });
  await partnerAudit(actor, user.partnerId, "user.role", "user", user.id, { email: user.email, from: user.role, to: role });
}

export async function deactivatePartnerUser(partnerId: string, userId: string, actor: PartnerActor): Promise<void> {
  const user = await userOrRefuse(partnerId, userId);
  if (actor.kind === "partner" && actor.id === user.id) throw new PartnerRefused("You can't switch yourself off. Ask another admin.");
  if (!user.active) throw new PartnerRefused(`${user.name} is already switched off.`);
  const now = new Date();
  await controlDb().$transaction(async (tx) => {
    if (user.role === "ADMIN") await assertAnotherAdmin(tx, user.partnerId, user.id);
    await tx.partnerUser.update({ where: { id: user.id }, data: { active: false, setupTokenHash: null, setupExpiresAt: null }, select: { id: true } });
    await tx.partnerSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
  });
  await partnerAudit(actor, user.partnerId, "user.deactivate", "user", user.id, { email: user.email });
}

/**
 * Switches an account back on as a new starter: the old password never works again, the
 * authenticator is forgotten, old sessions end, and a new setup link is emailed (and returned).
 * It takes one of the partner's fifty places again, so it is refused when they are all taken.
 */
export async function reactivatePartnerUser(partnerId: string, userId: string, actor: PartnerActor): Promise<{ setupUrl: string; emailed: boolean }> {
  const user = await userOrRefuse(partnerId, userId);
  if (user.active) throw new PartnerRefused(`${user.name} is already switched on.`);
  const now = new Date();
  await controlDb().$transaction(async (tx) => {
    await lockPartnerForUsers(tx, user.partnerId);
    await assertRoomForOneMore(tx, user.partnerId);
    const switched = await tx.partnerUser.updateMany({
      where: { id: user.id, active: false },
      data: { active: true, passwordHash: null, setupTokenHash: null, setupExpiresAt: null, totpSecretCipher: null, totpEnabledAt: null },
    });
    if (switched.count !== 1) throw new PartnerRefused(`${user.name} is already switched on.`);
    await tx.partnerSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
  });
  const setupUrl = await issuePartnerSetupLink(user.id);
  await partnerAudit(actor, user.partnerId, "user.reactivate", "user", user.id, { email: user.email });
  const emailed = await mailSetupLink(user.email, user.name, setupUrl, "reactivated");
  return { setupUrl, emailed };
}

/**
 * A new setup link for somebody — a lost first email, or a forgotten password. Emailed to them; the
 * link itself is returned only when `returnUrl` (an admin passing it on) and never otherwise.
 */
export async function newPartnerSetupLink(partnerId: string, userId: string, actor: PartnerActor, returnUrl: boolean): Promise<{ setupUrl: string | null; emailed: boolean }> {
  const user = await userOrRefuse(partnerId, userId);
  if (user.partner.status === "TERMINATED") throw new PartnerRefused(TERMINATED);
  if (!user.active) throw new PartnerRefused(`${user.name} is switched off. Switch them back on instead.`);
  const setupUrl = await issuePartnerSetupLink(user.id);
  await partnerAudit(actor, user.partnerId, "user.setup-link", "user", user.id, { email: user.email, returned: returnUrl });
  const emailed = await mailSetupLink(user.email, user.name, setupUrl, (await hasPassword(user.id)) ? "reset" : "new");
  return { setupUrl: returnUrl ? setupUrl : null, emailed };
}

/** A lost phone: their authenticator is forgotten and they are signed out everywhere. */
export async function resetPartnerUserTwoFactor(partnerId: string, userId: string, actor: PartnerActor): Promise<void> {
  const user = await userOrRefuse(partnerId, userId);
  const now = new Date();
  await controlDb().$transaction(async (tx) => {
    await tx.partnerUser.update({ where: { id: user.id }, data: { totpSecretCipher: null, totpEnabledAt: null }, select: { id: true } });
    await tx.partnerSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
  });
  await partnerAudit(actor, user.partnerId, "user.two-factor.reset", "user", user.id, { email: user.email });
}

/** Signs somebody out everywhere. */
export async function endPartnerUserSessions(partnerId: string, userId: string, actor: PartnerActor): Promise<{ ended: number }> {
  const user = await userOrRefuse(partnerId, userId);
  const ended = await controlDb().partnerSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await partnerAudit(actor, user.partnerId, "user.sessions.end", "user", user.id, { sessions: ended.count });
  return { ended: ended.count };
}

export async function renamePartnerUser(partnerId: string, userId: string, nameInput: string, actor: PartnerActor): Promise<void> {
  const name = cleanName(nameInput);
  const user = await userOrRefuse(partnerId, userId);
  await controlDb().partnerUser.update({ where: { id: user.id }, data: { name }, select: { id: true } });
  await partnerAudit(actor, user.partnerId, "account.rename", "user", user.id);
}

/**
 * Ends every session of every one of a partner's users — when it is terminated. The caller audits
 * (setPartnerStatus writes partner.status); pass `tx` to end them inside its transaction.
 */
export async function revokePartnerSessions(partnerId: string, tx?: Prisma.TransactionClient): Promise<number> {
  const pid = cleanId(partnerId);
  if (!pid) return 0;
  const ended = await (tx ?? controlDb()).partnerSession.updateMany({ where: { revokedAt: null, user: { partnerId: pid } }, data: { revokedAt: new Date() } });
  return ended.count;
}

// ─── Lists ───────────────────────────────────────────────────────────────────────────────────────

function liveSessionWhere(now: Date): Prisma.PartnerSessionWhereInput {
  return { revokedAt: null, expiresAt: { gt: now }, lastSeenAt: { gt: new Date(now.getTime() - PARTNER_IDLE_MS) } };
}

/** One partner's people, active first, then by name — optionally only one role, or only the active. */
export async function listPartnerUsers(partnerId: string, filter: { role?: PartnerRole; activeOnly?: boolean } = {}, now = new Date()): Promise<PartnerUserRow[]> {
  const pid = cleanId(partnerId);
  if (!pid) return [];
  const where: Prisma.PartnerUserWhereInput = { partnerId: pid, ...(filter.role ? { role: filter.role } : {}), ...(filter.activeOnly ? { active: true } : {}) };
  const [rows, withPassword] = await Promise.all([
    controlDb().partnerUser.findMany({
      where,
      orderBy: [{ active: "desc" }, { name: "asc" }],
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        active: true,
        totpEnabledAt: true,
        setupExpiresAt: true,
        lastSignInAt: true,
        createdAt: true,
        createdBy: true,
        _count: { select: { sessions: { where: liveSessionWhere(now) } } },
      },
    }),
    // Who has chosen a password, asked of the database: the hashes themselves are never read.
    controlDb().partnerUser.findMany({ where: { ...where, passwordHash: { not: null } }, select: { id: true } }),
  ]);
  const hasPasswordIds = new Set(withPassword.map((r) => r.id));
  const labels = await refLabels(rows.map((r) => r.createdBy));
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    active: r.active,
    twoFactor: !!r.totpEnabledAt,
    hasPassword: hasPasswordIds.has(r.id),
    setupPending: !!r.setupExpiresAt && r.setupExpiresAt > now,
    lastSignInAt: r.lastSignInAt,
    createdAt: r.createdAt,
    createdBy: labels.get(r.createdBy) ?? r.createdBy,
    liveSessions: r._count.sessions,
  }));
}

/** A session's handle: names it for the UI without being its token or the stored hash of one. */
export const sessionHandle = (sessionId: string) => sha256(`partner-session-handle|${sessionId}`).slice(0, 24);

/**
 * One person's live sessions, the current one first. With `scope.partnerId` (the Team page), the
 * person must be that partner's, or it is refused like somebody who does not exist.
 */
export async function listPartnerSessions(userId: string, currentSessionId: string | null = null, scope: { partnerId?: string; now?: Date } = {}): Promise<PartnerSessionRow[]> {
  if (scope.partnerId !== undefined) await userOrRefuse(scope.partnerId, userId);
  const now = scope.now ?? new Date();
  const rows = await controlDb().partnerSession.findMany({
    where: { userId: cleanId(userId), ...liveSessionWhere(now) },
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

/** Ends one of a person's sessions by its handle. Somebody else's, or an ended one, is refused alike. */
export async function endPartnerSessionByHandle(partnerId: string, userId: string, handle: string, actor: PartnerActor): Promise<void> {
  const user = await userOrRefuse(partnerId, userId);
  const h = String(handle ?? "").trim().toLowerCase();
  const live = /^[a-f0-9]{24}$/.test(h) ? await controlDb().partnerSession.findMany({ where: { userId: user.id, revokedAt: null }, select: { id: true } }) : [];
  const match = live.find((s) => sessionHandle(s.id) === h);
  if (!match) throw new PartnerRefused("That session has already ended.");
  await controlDb().partnerSession.update({ where: { id: match.id }, data: { revokedAt: new Date() }, select: { id: true } });
  await partnerAudit(actor, user.partnerId, "account.session.end", "user", user.id, { session: h.slice(0, 8) });
}

/** Signs one person out everywhere except the session this request came with. */
export async function endOtherPartnerSessions(partnerId: string, userId: string, keepSessionId: string, actor: PartnerActor): Promise<number> {
  const user = await userOrRefuse(partnerId, userId);
  const ended = await controlDb().partnerSession.updateMany({ where: { userId: user.id, revokedAt: null, NOT: { id: String(keepSessionId ?? "") } }, data: { revokedAt: new Date() } });
  await partnerAudit(actor, user.partnerId, "account.sessions.end-others", "user", user.id, { sessions: ended.count });
  return ended.count;
}

const SELF_LINKS_PER_HOUR = 3;

/**
 * "Email me a link to change my password": to their own address, never shown; three an hour —
 * counted in the activity log, so the limit holds across processes and restarts.
 */
export async function emailOwnPartnerPasswordLink(partnerId: string, userId: string, actor: PartnerActor): Promise<void> {
  const user = await userOrRefuse(partnerId, userId);
  const recent = await controlDb().partnerAuditLog.count({ where: { action: "account.password-link", entityId: user.id, at: { gt: new Date(Date.now() - 60 * 60_000) } } });
  if (recent >= SELF_LINKS_PER_HOUR) throw new PartnerRefused("Several links have been sent in the last hour. Use the newest one, or try again later.");
  const url = await issuePartnerSetupLink(user.id);
  await partnerAudit(actor, user.partnerId, "account.password-link", "user", user.id);
  if (!(await mailSetupLink(user.email, user.name, url, "reset"))) throw new PartnerRefused("The email could not be sent just now. Try again in a few minutes.");
}

/** A partner's active admins — none means its first admin is still to be invited (the console's partner page). */
export async function partnerAdminCount(partnerId: string): Promise<number> {
  return controlDb().partnerUser.count({ where: { partnerId: cleanId(partnerId), role: "ADMIN", active: true } });
}

/** Whose user this is — for the console and the CLI, which name a user by id or address alone. Null for nobody. */
export async function partnerOfUser(userIdOrEmail: string): Promise<{ userId: string; partnerId: string; partnerSlug: string } | null> {
  const key = String(userIdOrEmail ?? "").trim();
  if (!key || key.length > 254) return null;
  const user = await controlDb().partnerUser.findFirst({
    where: key.includes("@") ? { email: key.toLowerCase() } : { id: key },
    select: { id: true, partnerId: true, partner: { select: { slug: true } } },
  });
  return user ? { userId: user.id, partnerId: user.partnerId, partnerSlug: user.partner.slug } : null;
}
