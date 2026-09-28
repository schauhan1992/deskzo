import type { LinkSwitchStage, Prisma } from "@wroffy/control-client";
import { db } from "@/lib/db";
import { doorCheck } from "@/lib/access/record";
import { requestFacts } from "@/lib/access/request";
import { logActivity } from "@/lib/activity";
import { can } from "@/lib/authz/resolve";
import { decryptSecret } from "@/lib/crypto";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { siteAllowance } from "@/lib/platform/find-workspaces";
import { linkAudit, linkedSignInEnabled, memberOf, revokeMember, switchInAllowed, type RevokeReason } from "@/lib/platform/linked/groups";
import {
  SWITCH_FINISH_TTL_MS,
  SWITCH_MAX_CODE_ATTEMPTS,
  SWITCH_TICKET_TTL_MS,
  credentialStamp,
  mintToken,
  originOf,
  sha256Hex,
  tokenHashOf,
  tokenMacValid,
} from "@/lib/platform/linked/keys";
import { getCachedSecuritySettings } from "@/lib/security-settings";
import { clearFailures, lockoutState, recordFailure } from "@/lib/security/lockout";
import { tenantKey } from "@/lib/tenancy/cache";
import { tenantById } from "@/lib/tenancy/registry";
import { runAsTenant } from "@/lib/tenancy/resolve";
import type { Tenant } from "@/lib/tenancy/state";
import { verifyTotpCode } from "@/lib/totp";

/**
 * Switching between linked workspaces (spec §4.3, §4.5): a ticket from the workspace the person is in,
 * and everything else decided by the workspace they are going to.
 *
 *   S1 `issueSwitchTicket`   — at the source: a 60-second `link-switch` token for one member of the caller's group.
 *   S2 `presentSwitchTicket` — at the target: spent once, then every check of §4.5, in order, against the
 *                              target's own database and settings; the result is a refusal, Microsoft
 *                              sign-in, a two-factor code, or a READY ticket.
 *   S3 `verifySwitchCode`    — at the target: the code, five tries per ticket and the sign-in lockout.
 *   S4 `linkedAccount`       — the "linked" sign-in provider: READY → DONE once, and the account checks again.
 *
 * Nothing here trusts an earlier step. Each function reads the ticket row and the account again, and
 * the only thing that makes a session is S4. The secret S2 hands the browser (its cookie, and S4's
 * proof) is itself a `link-switch` token over the row's claims, so a row edited in the control plane
 * after it was presented signs nobody in either — the same guarantee the ticket itself gives.
 *
 * Owner decision 3 (a change from the spec): an account that can manage users or security — it holds
 * `users.manage` or `security.manage` as the target's own resolver decides — is only switched into
 * when it has two-factor on, like the super admin. Otherwise `manager-two-factor`.
 */

export type SwitchRefusal =
  | "disabled"
  | "not-member"
  | "view-as"
  | "support"
  | "stale"
  | "inactive"
  | "must-change-password"
  | "switching-off"
  | "billing-hold"
  | "workspace-unavailable"
  | "network"
  | "locked-out"
  | "two-factor-setup"
  | "super-admin-two-factor"
  /** Owner decision 3: the account holds users.manage or security.manage and has no two-factor. */
  | "manager-two-factor"
  | "ticket"
  | "code"
  | "rate-limited";

export type SwitchState =
  | { state: "signed-in" }
  | { state: "ready"; proof: string }
  | { state: "code"; presentSecret: string; workspace: string; email: string; triesLeft: number }
  | { state: "sso"; presentSecret: string; workspace: string; email: string }
  /** `retryInMinutes`: only with `locked-out`, for the "<n> minutes" of its message. */
  | { state: "refused"; reason: SwitchRefusal; workspace: string; retryInMinutes?: number };

/** A refusal at S1, told to the person (spec §2.7). `workspace` is the name a message puts in "<name>". */
export class SwitchRefused extends Error {
  constructor(
    public code: SwitchRefusal,
    public workspace?: string,
  ) {
    super(`Switch refused: ${code}`);
    this.name = "SwitchRefused";
  }
}

// §4.8: per account at the source, per caller at the target.
const RATE_WINDOW_MS = 600_000;
const ISSUE_MAX = 30;
const PRESENT_MAX = 120;

/** Revocations a switch makes on its own account are audited as the switch's. */
const BY_SWITCH = "switch";

const TICKET = {
  tokenHash: true,
  targetTenantId: true,
  targetUserId: true,
  memberId: true,
  groupId: true,
  sourceTenantId: true,
  sourceUserId: true,
  expiresAt: true,
  usedAt: true,
  stage: true,
  attempts: true,
  finishBy: true,
  completedAt: true,
} as const;
type Ticket = Prisma.LinkSwitchTicketGetPayload<{ select: typeof TICKET }>;

const ACCOUNT = {
  id: true,
  name: true,
  email: true,
  role: true,
  kind: true,
  active: true,
  isSuperAdmin: true,
  passwordHash: true,
  mustChangePassword: true,
  twoFactorEnabledAt: true,
  twoFactorSecretCipher: true,
} as const;

/** By id, so the listing's support filter (src/lib/db.ts) leaves every account in. Inside runAsTenant. */
async function readAccount(userId: string) {
  return await db.user.findUnique({ where: { id: userId }, select: ACCOUNT });
}
type Account = NonNullable<Awaited<ReturnType<typeof readAccount>>>;

/** The ticket's claims, in §4.1's order — what its MAC covers. */
function ticketClaims(t: Ticket): string[] {
  return [t.targetTenantId, t.targetUserId, t.memberId, t.groupId, t.sourceTenantId, t.sourceUserId, t.expiresAt.toISOString()];
}

/** What the presented secret's MAC covers: the ticket it was spent from, its claims, and when it must be finished by. */
function presentClaims(t: Ticket, finishBy: Date): string[] {
  return ["present", t.tokenHash, ...ticketClaims(t), finishBy.toISOString()];
}

function refused(reason: SwitchRefusal, workspace: string, retryInMinutes?: number): SwitchState {
  return retryInMinutes ? { state: "refused", reason, workspace, retryInMinutes } : { state: "refused", reason, workspace };
}

/** The sign-in lockout's keys for this account at the workspace in hand (as `checkCredentials` counts them). */
async function lockoutKeys(email: string, ip: string | null): Promise<string[]> {
  const workspace = await tenantKey();
  return [`${workspace}|account:${email.trim().toLowerCase()}`, ...(ip ? [`${workspace}|caller:${ip}`] : [])];
}

/** Why, in the target's own activity log — which never names the other workspace. */
const LOG_TEXT: Record<SwitchRefusal, string> = {
  disabled: "linked sign-in is paused",
  "not-member": "the account is not linked",
  "view-as": "it came from a view-as session",
  support: "not a member account",
  stale: "the account's password or address changed since it was linked, so it was unlinked",
  inactive: "the account is switched off or no longer exists",
  "must-change-password": "the account must set a new password first",
  "switching-off": "switching in is turned off here",
  "billing-hold": "the workspace is on hold for billing",
  "workspace-unavailable": "the workspace is not open",
  network: "the network is not allowed",
  "locked-out": "too many failed attempts",
  "two-factor-setup": "two-factor is required here and the account has none",
  "super-admin-two-factor": "a super admin account without two-factor",
  "manager-two-factor": "an account that manages users or security, without two-factor",
  ticket: "the switch was expired, already used or not valid here",
  code: "too many wrong two-factor codes",
  "rate-limited": "too many switches",
};

type Refusal = { reason: SwitchRefusal; user?: Account | null; revoke?: RevokeReason; retryInMinutes?: number; closed?: boolean };

/**
 * Ends a ticket this request holds (spec §4.3 S2.3): stage REFUSED, the account unlinked when the
 * refusal says so, `LOGIN_FAILED` in the target's log and `link.switch-refused` in the platform's.
 * Run inside runAsTenant(target). A workspace that is not open (`closed`) gets no row in its database.
 */
async function refuse(target: Tenant, ticket: Ticket, from: LinkSwitchStage[], refusal: Refusal): Promise<SwitchState> {
  const { reason, user } = refusal;
  await controlDb().linkSwitchTicket.updateMany({ where: { tokenHash: ticket.tokenHash, stage: { in: from } }, data: { stage: "REFUSED", refusal: reason } });
  if (refusal.revoke) await revokeMember(ticket.memberId, refusal.revoke, BY_SWITCH);
  if (!refusal.closed) {
    await logActivity({
      kind: "LOGIN_FAILED",
      // Always explicit, null included: logActivity would otherwise ask auth(), which S4 runs inside.
      userId: user?.id ?? null,
      userName: user?.name ?? null,
      userEmail: user?.email ?? null,
      summary: `Switch-in from a linked workspace refused${user ? ` for ${user.name}` : ""}: ${LOG_TEXT[reason]}`,
      metadata: { reason, via: "linked" },
    });
  }
  await linkAudit("link.switch-refused", target.id, `workspace:${ticket.targetUserId}`, { reason, from: ticket.sourceTenantId, memberId: ticket.memberId });
  return refused(reason, target.name, refusal.retryInMinutes);
}

/**
 * A ticket whose MAC is wrong for its row — made or edited without the platform key. Ended, and
 * recorded without trusting anything the row names (no account, no source).
 */
async function refuseUnsigned(target: Tenant, where: Prisma.LinkSwitchTicketWhereInput, spentAt?: Date): Promise<void> {
  const ended = await controlDb().linkSwitchTicket.updateMany({ where, data: { stage: "REFUSED", refusal: "ticket", ...(spentAt ? { usedAt: spentAt } : {}) } });
  if (ended.count === 0) return;
  await runAsTenant(target, async () => {
    await logActivity({
      kind: "LOGIN_FAILED",
      userId: null,
      summary: "Switch-in from a linked workspace refused: its ticket was not signed by the platform",
      metadata: { reason: "ticket", via: "linked" },
    });
  });
  await linkAudit("link.switch-refused", target.id, BY_SWITCH, { reason: "ticket", macValid: false });
}

type Verdict = { ok: true; user: Account } | ({ ok: false } & Refusal);

/**
 * Rules 1–8 of §4.5, in order, against the target's own database and settings, read fresh. Inside
 * runAsTenant(target). Also re-checks that the account the ticket came from is still in the group:
 * an account unlinked since S1 does not switch anywhere.
 */
async function accountChecks(target: Tenant, ticket: Ticket, ip: string | null): Promise<Verdict> {
  // 1. The workspace is open (fresh, not the registry's copy) and linked sign-in is on.
  const tenant = await controlDb().tenant.findUnique({ where: { id: target.id }, select: { status: true, suspendedFor: true } });
  if (tenant?.status !== "ACTIVE") {
    return { ok: false, reason: tenant?.status === "SUSPENDED" && tenant.suspendedFor === "BILLING" ? "billing-hold" : "workspace-unavailable", closed: true };
  }
  const user = await readAccount(ticket.targetUserId);
  if (!(await linkedSignInEnabled())) return { ok: false, reason: "disabled", user };

  // 2. This workspace lets linked accounts in.
  if (!(await switchInAllowed(target.id))) return { ok: false, reason: "switching-off", user };

  // 3. The member is still this account, here, in the ticket's group — and so is the one it came from.
  const [member, source] = await Promise.all([
    controlDb().linkMember.findUnique({ where: { id: ticket.memberId }, select: { tenantId: true, userId: true, groupId: true, stamp: true } }),
    memberOf(ticket.sourceTenantId, ticket.sourceUserId),
  ]);
  if (!member || member.tenantId !== target.id || member.userId !== ticket.targetUserId || member.groupId !== ticket.groupId || source?.groupId !== ticket.groupId) {
    return { ok: false, reason: "ticket", user };
  }

  // 4. A member account that exists and is switched on. Otherwise the link goes too (§4.7, lazily).
  if (!user) return { ok: false, reason: "inactive", revoke: "deleted" };
  if (user.kind !== "MEMBER") return { ok: false, reason: "support", user, revoke: "deleted" };
  if (!user.active) return { ok: false, reason: "inactive", user, revoke: "deactivated" };

  // 5. Its address and password are the ones that were proven when it was linked.
  if (credentialStamp(target.id, user) !== member.stamp) return { ok: false, reason: "stale", user, revoke: "credentials" };

  // 6.
  if (user.mustChangePassword) return { ok: false, reason: "must-change-password", user };

  // 7. The sign-in lockout, on the same keys a password sign-in here counts.
  const locked = lockoutState(await lockoutKeys(user.email, ip));
  if (locked.lockedOut) return { ok: false, reason: "locked-out", user, retryInMinutes: Math.ceil(locked.retryInSeconds / 60) };

  // 8. A network this account may not use at all (super admins are exempt, as at sign-in).
  if (await doorCheck(user)) return { ok: false, reason: "network", user };

  return { ok: true, user };
}

type Next = { next: "sso" } | { next: "code" } | { next: "ready" } | { next: "refused"; reason: SwitchRefusal };

/** Rules 9–11 of §4.5: the target's sign-in policy for this account. Inside runAsTenant(target). */
async function policyFor(user: Account): Promise<Next> {
  const security = await getCachedSecuritySettings();
  // 9. Microsoft-only for everyone but admins, as at the sign-in page: a ticket makes no session then.
  if (security?.enforceSso && user.role !== "ADMIN") return { next: "sso" };
  // 11. Every new session here asks the account's own code.
  if (user.twoFactorEnabledAt) return { next: "code" };
  // 10.
  if (security?.enforceTwoFactor) return { next: "refused", reason: "two-factor-setup" };
  if (user.isSuperAdmin) return { next: "refused", reason: "super-admin-two-factor" };
  // Owner decision 3: whoever can manage people or security here is not reached on another workspace's password alone.
  if ((await can(user.id, "users.manage")) || (await can(user.id, "security.manage"))) return { next: "refused", reason: "manager-two-factor" };
  return { next: "ready" };
}

/** Moves a ticket on from one of `from` — false when it had already moved (a second tab, a race). */
async function moveStage(tokenHash: string, from: LinkSwitchStage[], data: Prisma.LinkSwitchTicketUpdateManyMutationInput, stillOpen = false): Promise<boolean> {
  const moved = await controlDb().linkSwitchTicket.updateMany({
    where: { tokenHash, stage: { in: from }, ...(stillOpen ? { completedAt: null, finishBy: { gt: new Date() } } : {}) },
    data,
  });
  return moved.count === 1;
}

/**
 * The ticket a browser's secret stands for, at `stage`, for this workspace and not past `finishBy` —
 * with the secret's MAC checked against the row as it is now. `mark`: end a row whose MAC fails.
 */
async function presentedTicket(target: Tenant, secret: string | null, stage: LinkSwitchStage, mark: boolean): Promise<Ticket | null> {
  if (!controlConfigured() || typeof secret !== "string" || !tokenHashOf(secret)) return null;
  const presentHash = sha256Hex(secret);
  const ticket = await controlDb().linkSwitchTicket.findUnique({ where: { presentHash }, select: TICKET });
  if (!ticket || ticket.targetTenantId !== target.id || ticket.stage !== stage || ticket.completedAt || !ticket.finishBy || ticket.finishBy <= new Date()) return null;
  if (!tokenMacValid("link-switch", target.id, secret, presentClaims(ticket, ticket.finishBy))) {
    if (mark) await refuseUnsigned(target, { presentHash, stage });
    return null;
  }
  return ticket;
}

// ─── S1: issue, at the source ────────────────────────────────────────────────────────────────────

/**
 * A switch ticket from the account (source, userId) to one member of its group (spec §4.3 S1).
 * Throws SwitchRefused. The URL is built from the registry; the token rides in its fragment.
 */
export async function issueSwitchTicket(
  source: Tenant,
  input: { userId: string; sid: string | undefined; memberId: string; viewingAs: boolean; ip: string | null },
): Promise<{ url: string }> {
  if (input.viewingAs) throw new SwitchRefused("view-as");
  if (!(await linkedSignInEnabled())) throw new SwitchRefused("disabled");
  if (!siteAllowance([{ key: `platform|switch:${source.id}:${input.userId}`, max: ISSUE_MAX }], RATE_WINDOW_MS)) throw new SwitchRefused("rate-limited");

  const user = await runAsTenant(source, async () => await readAccount(input.userId));
  if (!user) throw new SwitchRefused("not-member");
  if (user.kind !== "MEMBER") throw new SwitchRefused("support");
  if (!user.active) throw new SwitchRefused("inactive", source.name);
  if (user.mustChangePassword) throw new SwitchRefused("must-change-password", source.name);

  const mine = await memberOf(source.id, user.id);
  if (!mine) throw new SwitchRefused("not-member");
  if (credentialStamp(source.id, user) !== mine.stamp) {
    await revokeMember(mine.id, "credentials", BY_SWITCH);
    throw new SwitchRefused("stale", source.name);
  }

  const member =
    typeof input.memberId === "string" && input.memberId
      ? await controlDb().linkMember.findUnique({ where: { id: input.memberId }, select: { id: true, groupId: true, tenantId: true, userId: true } })
      : null;
  // Only another workspace in the caller's own group.
  if (!member || member.groupId !== mine.groupId || member.tenantId === source.id) throw new SwitchRefused("not-member");

  const target = await tenantById(member.tenantId).catch(() => null);
  if (!target) throw new SwitchRefused("workspace-unavailable");
  if (target.status !== "ACTIVE") throw new SwitchRefused(target.holdReason === "BILLING" ? "billing-hold" : "workspace-unavailable", target.name);
  if (!(await switchInAllowed(target.id))) throw new SwitchRefused("switching-off", target.name);

  const expiresAt = new Date(Date.now() + SWITCH_TICKET_TTL_MS);
  const claims = [target.id, member.userId, member.id, member.groupId, source.id, user.id, expiresAt.toISOString()];
  const { token, hash } = mintToken("link-switch", target.id, claims);
  await controlDb().linkSwitchTicket.create({
    data: {
      tokenHash: hash,
      targetTenantId: target.id,
      targetUserId: member.userId,
      memberId: member.id,
      groupId: member.groupId,
      sourceTenantId: source.id,
      sourceUserId: user.id,
      sourceSid: input.sid ?? "",
      expiresAt,
      ip: input.ip,
    },
    select: { tokenHash: true },
  });
  return { url: `${originOf(target)}/switch#t=${token}` };
}

// ─── S2: present, at the target ──────────────────────────────────────────────────────────────────

/**
 * A ticket arriving at the target (spec §4.3 S2): spent once, by this workspace only, then every
 * check of §4.5. `signedInUserId`/`signedInOk`: the session this browser already holds here, and
 * whether the access gate lets it through — that session is reused rather than a new one made.
 */
export async function presentSwitchTicket(
  target: Tenant,
  token: string,
  input: { signedInUserId: string | null; signedInOk: boolean; ip: string | null },
): Promise<SwitchState> {
  const workspace = target.name;
  if (!controlConfigured()) return refused("disabled", workspace);
  if (input.ip && !siteAllowance([{ key: `platform|switch-in-caller:${input.ip}`, max: PRESENT_MAX }], RATE_WINDOW_MS)) return refused("rate-limited", workspace);

  const hash = tokenHashOf(token);
  if (!hash) return refused("ticket", workspace);
  const control = controlDb();
  const row = await control.linkSwitchTicket.findUnique({ where: { tokenHash: hash }, select: TICKET });
  // Made for another workspace: refused here and left unspent for its own.
  if (!row || row.targetTenantId !== target.id) return refused("ticket", workspace);

  const now = new Date();
  if (!tokenMacValid("link-switch", target.id, token, ticketClaims(row))) {
    // Spent as it is refused, so presenting it again is only a spent ticket.
    await refuseUnsigned(target, { tokenHash: hash, targetTenantId: target.id, usedAt: null }, now);
    return refused("ticket", workspace);
  }

  // The spend, once: pinned to the claims just verified, so the row spent is the row that was signed.
  const finishBy = new Date(now.getTime() + SWITCH_FINISH_TTL_MS);
  const present = mintToken("link-switch", target.id, presentClaims(row, finishBy));
  const spent = await control.linkSwitchTicket.updateMany({
    where: {
      tokenHash: hash,
      targetTenantId: target.id,
      usedAt: null,
      expiresAt: { equals: row.expiresAt, gt: now },
      targetUserId: row.targetUserId,
      memberId: row.memberId,
      groupId: row.groupId,
      sourceTenantId: row.sourceTenantId,
      sourceUserId: row.sourceUserId,
    },
    data: { usedAt: now, stage: "PRESENTED", presentHash: sha256Hex(present.token), finishBy },
  });
  if (spent.count !== 1) return refused("ticket", workspace);
  const ticket: Ticket = { ...row, usedAt: now, stage: "PRESENTED", finishBy };

  // S2.2: already signed in here as that account — no new session, no code.
  if (input.signedInOk && input.signedInUserId === ticket.targetUserId) {
    await moveStage(hash, ["PRESENTED"], { stage: "DONE", completedAt: now });
    return { state: "signed-in" };
  }

  return runAsTenant(target, async () => {
    const verdict = await accountChecks(target, ticket, input.ip);
    if (!verdict.ok) return refuse(target, ticket, ["PRESENTED"], verdict);
    const { user } = verdict;

    const policy = await policyFor(user);
    if (policy.next === "refused") return refuse(target, ticket, ["PRESENTED"], { reason: policy.reason, user });
    if (policy.next === "sso") {
      if (!(await moveStage(hash, ["PRESENTED"], { stage: "SSO" }, true))) return refused("ticket", workspace);
      await linkAudit("link.switch-sso", target.id, `workspace:${user.id}`, { from: ticket.sourceTenantId, memberId: ticket.memberId });
      return { state: "sso", presentSecret: present.token, workspace, email: user.email };
    }
    if (policy.next === "code") {
      if (!(await moveStage(hash, ["PRESENTED"], { stage: "CODE" }, true))) return refused("ticket", workspace);
      return { state: "code", presentSecret: present.token, workspace, email: user.email, triesLeft: SWITCH_MAX_CODE_ATTEMPTS - ticket.attempts };
    }
    if (!(await moveStage(hash, ["PRESENTED"], { stage: "READY" }, true))) return refused("ticket", workspace);
    return { state: "ready", proof: present.token };
  });
}

// ─── S3: the two-factor code, at the target ──────────────────────────────────────────────────────

/** Whether `code` is the account's current authenticator code. A secret that can't be read matches nothing. */
async function codeMatches(cipher: string, code: string): Promise<boolean> {
  if (typeof code !== "string" || !code.trim()) return false;
  try {
    return verifyTotpCode(await decryptSecret(cipher), code);
  } catch {
    return false;
  }
}

/**
 * The code for a ticket at stage CODE (spec §4.3 S3), from the browser that presented it (its
 * `wroffy.switch` cookie). Five wrong codes end the ticket; each also counts on the sign-in lockout.
 */
export async function verifySwitchCode(target: Tenant, presentSecret: string | null, code: string, ip: string | null): Promise<SwitchState> {
  const workspace = target.name;
  const ticket = await presentedTicket(target, presentSecret, "CODE", true);
  if (!ticket || !presentSecret) return refused("ticket", workspace);
  const secret = presentSecret;
  const hash = ticket.tokenHash;

  return runAsTenant(target, async () => {
    // Everything again, the lockout included, before a code is even looked at.
    const verdict = await accountChecks(target, ticket, ip);
    if (!verdict.ok) return refuse(target, ticket, ["CODE"], verdict);
    const { user } = verdict;
    // Two-factor gone since the code was asked for (a reset unlinks too): this switch can't finish.
    if (!user.twoFactorEnabledAt || !user.twoFactorSecretCipher) return refuse(target, ticket, ["CODE"], { reason: "ticket", user });

    const keys = await lockoutKeys(user.email, ip);
    if (!(await codeMatches(user.twoFactorSecretCipher, code))) {
      recordFailure(keys);
      // Capped in the update itself: the column's CHECK stops at SWITCH_MAX_CODE_ATTEMPTS.
      const counted = await controlDb().linkSwitchTicket.updateMany({
        where: { tokenHash: hash, stage: "CODE", attempts: { lt: SWITCH_MAX_CODE_ATTEMPTS } },
        data: { attempts: { increment: 1 } },
      });
      const after = await controlDb().linkSwitchTicket.findUnique({ where: { tokenHash: hash }, select: { attempts: true } });
      const attempts = after?.attempts ?? SWITCH_MAX_CODE_ATTEMPTS;
      if (counted.count !== 1 || attempts >= SWITCH_MAX_CODE_ATTEMPTS) return refuse(target, ticket, ["CODE"], { reason: "code", user });
      const triesLeft = SWITCH_MAX_CODE_ATTEMPTS - attempts;
      await logActivity({
        kind: "LOGIN_FAILED",
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
        summary: `Switch-in from a linked workspace: wrong two-factor code for ${user.name}`,
        metadata: { reason: "code", via: "linked", triesLeft },
      });
      return { state: "code", presentSecret: secret, workspace, email: user.email, triesLeft };
    }

    clearFailures(keys);
    // The account is checked again after the code (rules 1–8), then the policy (9–11) as S2 would.
    const again = await accountChecks(target, ticket, ip);
    if (!again.ok) return refuse(target, ticket, ["CODE"], again);
    const policy = await policyFor(again.user);
    if (policy.next === "refused") return refuse(target, ticket, ["CODE"], { reason: policy.reason, user: again.user });
    if (policy.next === "sso") {
      if (!(await moveStage(hash, ["CODE"], { stage: "SSO" }, true))) return refused("ticket", workspace);
      await linkAudit("link.switch-sso", target.id, `workspace:${again.user.id}`, { from: ticket.sourceTenantId, memberId: ticket.memberId });
      return { state: "sso", presentSecret: secret, workspace, email: again.user.email };
    }
    if (policy.next !== "code") return refuse(target, ticket, ["CODE"], { reason: "ticket", user: again.user });
    if (!(await moveStage(hash, ["CODE"], { stage: "READY" }, true))) return refused("ticket", workspace);
    return { state: "ready", proof: secret };
  });
}

// ─── S4: the session, from the "linked" sign-in provider ─────────────────────────────────────────

/**
 * The account a READY ticket signs in at this workspace — or nobody (spec §4.3 S4). The "linked"
 * provider in src/lib/auth.ts is this and nothing more. Spends the ticket (READY → DONE) once, then
 * checks the account again as if nothing before had: this is the only place a switch makes a session.
 */
export async function linkedAccount(proof: string, tenantId: string): Promise<{ id: string; name: string; email: string; role: string } | null> {
  if (typeof proof !== "string" || typeof tenantId !== "string" || !tokenHashOf(proof) || !controlConfigured()) return null;
  const control = controlDb();
  const presentHash = sha256Hex(proof);
  const now = new Date();
  const spent = await control.linkSwitchTicket.updateMany({
    where: { presentHash, targetTenantId: tenantId, stage: "READY", completedAt: null, finishBy: { gt: now } },
    data: { stage: "DONE", completedAt: now },
  });
  if (spent.count !== 1) return null;

  const ticket = await control.linkSwitchTicket.findUnique({ where: { presentHash }, select: TICKET });
  const target = await tenantById(tenantId).catch(() => null);
  if (!ticket?.finishBy || !target) {
    await control.linkSwitchTicket.updateMany({ where: { presentHash, stage: "DONE" }, data: { stage: "REFUSED", refusal: "workspace-unavailable" } });
    return null;
  }
  if (!tokenMacValid("link-switch", target.id, proof, presentClaims(ticket, ticket.finishBy))) {
    await refuseUnsigned(target, { presentHash, stage: "DONE" });
    return null;
  }

  return runAsTenant(target, async () => {
    const { ip } = await requestFacts();
    const verdict = await accountChecks(target, ticket, ip);
    if (!verdict.ok) {
      await refuse(target, ticket, ["DONE"], verdict);
      return null;
    }
    const { user } = verdict;
    const policy = await policyFor(user);
    if (policy.next === "refused") {
      await refuse(target, ticket, ["DONE"], { reason: policy.reason, user });
      return null;
    }
    // Microsoft-only since this ticket was presented, or two-factor turned on after S2 decided no code
    // was needed: the next switch takes the right path; this one ends.
    const decidedWithoutCode = policy.next === "code" && !!ticket.usedAt && !!user.twoFactorEnabledAt && user.twoFactorEnabledAt > ticket.usedAt;
    if (policy.next === "sso" || decidedWithoutCode) {
      await refuse(target, ticket, ["DONE"], { reason: "ticket", user });
      return null;
    }

    // The member keeps its stamp (it matched); its name and address follow the account's.
    await control.linkMember.updateMany({
      where: { id: ticket.memberId, tenantId: target.id, userId: user.id },
      data: { lastSwitchedInAt: now, name: user.name, email: user.email },
    });
    await linkAudit("link.switched", target.id, `workspace:${user.id}`, { from: ticket.sourceTenantId, memberId: ticket.memberId });
    return { id: user.id, name: user.name, email: user.email, role: user.role };
  });
}

// ─── The Microsoft path ──────────────────────────────────────────────────────────────────────────

/**
 * The account's current address for a ticket at stage SSO, within its `finishBy` — the `login_hint`
 * for the Microsoft sign-in that follows. Read-only; null for anything else.
 */
export async function ssoEmailFor(target: Tenant, presentSecret: string | null): Promise<string | null> {
  const ticket = await presentedTicket(target, presentSecret, "SSO", false);
  if (!ticket) return null;
  const user = await runAsTenant(target, async () => await db.user.findUnique({ where: { id: ticket.targetUserId }, select: { email: true } }));
  return user?.email ?? null;
}
