import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Prisma, StaffRole } from "@wroffy/control-client";
import { deviceFromUserAgent, istDayKey } from "@/lib/console-shared/format";
import type { StaffFilters } from "@/lib/console-shared/params";
import type { ConsoleRole } from "@/lib/console-shared/types";
import { auditQuery, type AuditRowView } from "@/lib/platform/audit-query";
import { controlDb } from "@/lib/platform/control-db";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { staffTwoFactorPolicy } from "@/lib/platform/settings";
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
/** A session unused this long is over, whatever its expiry says — the idle limit in staff-session.ts. */
const IDLE_MS = 30 * 60_000;
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

// ─── Sessions, switching back on, the staff board, My account ───────────────────────────────────

/**
 * A console session as the console lists it. `id` is the SHA-256 of the cookie's token — it cannot be
 * turned back into one, so handing it to a "Sign out" button grants nothing. The raw user agent stays
 * in the database; `device` is enough to recognise one's own ("Chrome on Windows").
 */
export type StaffSessionView = { id: string; userId: string; createdAt: Date; lastSeenAt: Date; expiresAt: Date; mfa: boolean; ip: string | null; device: string };

/** A session that still lets somebody in: not ended, not expired, not idle past the limit. */
function liveSessionWhere(now: Date): Prisma.PlatformSessionWhereInput {
  return { revokedAt: null, expiresAt: { gt: now }, lastSeenAt: { gt: new Date(now.getTime() - IDLE_MS) } };
}

/** Live sessions — one staff member's, or everybody's — most recently used first. */
export async function listStaffSessions(userId?: string, now = new Date()): Promise<StaffSessionView[]> {
  const rows = await controlDb().platformSession.findMany({
    where: { ...(userId ? { userId } : {}), ...liveSessionWhere(now) },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true, userId: true, createdAt: true, lastSeenAt: true, expiresAt: true, mfaAt: true, ip: true, userAgent: true },
  });
  return rows.map((s) => ({
    id: s.id,
    userId: s.userId,
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    expiresAt: s.expiresAt,
    mfa: s.mfaAt !== null,
    ip: s.ip,
    device: deviceFromUserAgent(s.userAgent),
  }));
}

/**
 * Ends one session: whoever holds it is signed out at their next request. `onlyUserId` limits it to
 * that staff member's own sessions — somebody else's is refused exactly as an ended one is, so the
 * answer says nothing about sessions that are not theirs.
 */
export async function endStaffSession(sessionId: string, actor: string, onlyUserId?: string, now = new Date()): Promise<void> {
  const session = await controlDb().platformSession.findUnique({ where: { id: sessionId }, select: { userId: true } });
  const ended = session
    ? await controlDb().platformSession.updateMany({ where: { id: sessionId, revokedAt: null, ...(onlyUserId ? { userId: onlyUserId } : {}) }, data: { revokedAt: now } })
    : { count: 0 };
  if (!session || ended.count === 0) throw new StaffChangeRefused("That session has already ended.");
  await audit(actor, "staff.session.end", { userId: session.userId, session: sessionId.slice(0, 8) });
}

/**
 * Switches a staff member back on. They come back as a new starter would: the password they had can
 * never work again (a random one replaces it), their authenticator is forgotten (they enrol again),
 * anything left of their old sessions is ended, and a new one-time link — emailed to them as
 * `createStaff` does, and returned for the owner to pass on — lets them choose a password.
 */
export async function reactivateStaff(userId: string, actor: string): Promise<{ setupUrl: string }> {
  const user = await controlDb().platformUser.findUniqueOrThrow({ where: { id: userId }, select: { email: true, name: true, active: true } });
  if (user.active) throw new StaffChangeRefused(`${user.name} is already switched on.`);
  // Hashed before the transaction: bcrypt takes a while, and a transaction should not wait on it.
  const passwordHash = await bcrypt.hash(randomBytes(32).toString("hex"), 10);
  const now = new Date();
  await controlDb().$transaction(async (tx) => {
    // Conditional, so two owners clicking at once switch them on once.
    const switched = await tx.platformUser.updateMany({
      where: { id: userId, active: false },
      data: { active: true, passwordHash, passwordSetupHash: null, passwordSetupExpiresAt: null, totpSecretCipher: null, totpEnabledAt: null },
    });
    if (switched.count !== 1) throw new StaffChangeRefused(`${user.name} is already switched on.`);
    await tx.platformSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
  });
  const setupUrl = await issuePasswordSetup(userId);
  await audit(actor, "staff.reactivate", { email: user.email });
  await sendPlatformMail({
    to: user.email,
    subject: "Your console account",
    text: [
      `Hello ${user.name},`,
      "",
      "Your account on the platform console has been switched back on. Choose a new password here — the link works once, for three days:",
      "",
      setupUrl,
      "",
      "Your old password no longer works. At your first sign-in you will set up two-factor authentication again.",
    ].join("\n"),
  }).catch((err) => console.error("[staff] the setup email could not be sent", err));
  return { setupUrl };
}

export type StaffRow = {
  id: string;
  email: string;
  name: string;
  role: ConsoleRole;
  active: boolean;
  totpEnabledAt: Date | null;
  lastSignInAt: Date | null;
  createdAt: Date;
  /** Sessions that still let them in (not idle past the limit). */
  liveSessions: number;
};
export type StaffBoard = {
  asOf: Date;
  rows: StaffRow[];
  /** Of everybody, whatever the filters. */
  counts: { active: number; owners: number; noAuthenticator: number; signedInNow: number };
  policy: { mode: "required" | "off"; chosen: boolean };
};

/** The staff page: the members the filters pick, the counts over everybody, and the two-factor policy. */
export async function staffBoard(f: StaffFilters, now = new Date()): Promise<StaffBoard> {
  const control = controlDb();
  const q = typeof f.q === "string" ? f.q.trim().slice(0, 100) : "";
  const where: Prisma.PlatformUserWhereInput = {
    ...(f.status === "off" ? { active: false } : f.status === "all" ? {} : { active: true }),
    ...(f.role ? { role: f.role } : {}),
    ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const live = liveSessionWhere(now);
  const [users, active, owners, noAuthenticator, signedIn, policy] = await Promise.all([
    control.platformUser.findMany({
      where,
      orderBy: [{ active: "desc" }, { name: "asc" }],
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        active: true,
        totpEnabledAt: true,
        lastSignInAt: true,
        createdAt: true,
        _count: { select: { sessions: { where: live } } },
      },
    }),
    control.platformUser.count({ where: { active: true } }),
    control.platformUser.count({ where: { active: true, role: "OWNER" } }),
    control.platformUser.count({ where: { active: true, totpEnabledAt: null } }),
    control.platformSession.groupBy({ by: ["userId"], where: { ...live, user: { active: true } } }),
    staffTwoFactorPolicy(),
  ]);
  return {
    asOf: now,
    rows: users.map(({ _count, ...u }) => ({ ...u, liveSessions: _count.sessions })),
    counts: { active, owners, noAuthenticator, signedInNow: signedIn.length },
    policy,
  };
}

export type AccountOverview = {
  profile: { id: string; name: string; email: string; role: ConsoleRole; totpEnabledAt: Date | null; lastSignInAt: Date | null; createdAt: Date };
  /** Their live sessions, the one this request came with first. */
  sessions: (StaffSessionView & { current: boolean })[];
  /** What they did most recently: their last 20 audit entries. */
  recent: AuditRowView[];
  todayKey: string;
};

/** My account: the staff member's own profile, sessions and recent activity. */
export async function accountOverview(staffId: string, currentSessionId: string | null, now = new Date()): Promise<AccountOverview> {
  const [profile, sessions, recent] = await Promise.all([
    controlDb().platformUser.findUniqueOrThrow({
      where: { id: staffId },
      select: { id: true, name: true, email: true, role: true, totpEnabledAt: true, lastSignInAt: true, createdAt: true },
    }),
    listStaffSessions(staffId, now),
    auditQuery({ staff: staffId, limit: 20 }, now),
  ]);
  const marked = sessions.map((s) => ({ ...s, current: currentSessionId !== null && s.id === currentSessionId }));
  return {
    profile,
    // Stable: the rest keep their most-recently-used order.
    sessions: [...marked.filter((s) => s.current), ...marked.filter((s) => !s.current)],
    recent: recent.rows,
    todayKey: istDayKey(now),
  };
}
