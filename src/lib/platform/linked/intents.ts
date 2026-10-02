import { timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Prisma } from "@prisma/client";
import type { LinkIntent } from "@deskzo/control-client";
import { recordAudit } from "@/lib/audit";
import { decryptSecret } from "@/lib/crypto";
import { db } from "@/lib/db";
import { formatIstDateTime } from "@/lib/india-time";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { HOUR_MS, siteAllowance } from "@/lib/platform/find-workspaces";
import { joinGroup, linkAudit, linkedSignInEnabled, LinkRefused, memberOf, type JoinSide, type LinkRefusal } from "@/lib/platform/linked/groups";
import {
  LINK_COMPLETION_TTL_MS,
  LINK_INTENT_TTL_MS,
  MAX_LINKED_WORKSPACES,
  SSO_FRESH_MS,
  credentialStamp,
  mintToken,
  newBrowserSecret,
  originOf,
  sha256Hex,
  tokenHashOf,
  tokenMacValid,
} from "@/lib/platform/linked/keys";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { getCachedSecuritySettings } from "@/lib/security-settings";
import { clearFailures, lockoutState, recordFailure } from "@/lib/security/lockout";
import { tenantKey } from "@/lib/tenancy/cache";
import { isSystemAddress } from "@/lib/people";
import { isSsoSignIn, providerOfSignIn } from "@/lib/workplace/providers";
import { signInPolicyFor } from "@/lib/workplace/sign-in-rules-server";
import { SLUG_PATTERN, normaliseHost, protocolFor } from "@/lib/tenancy/host";
import { tenantById, tenantBySlug, tenantForHost } from "@/lib/tenancy/registry";
import { runAsTenant } from "@/lib/tenancy/resolve";
import type { Tenant } from "@/lib/tenancy/state";
import { verifyTotpCode } from "@/lib/totp";

/**
 * "Add a workspace": the linking protocol of spec §4.2, from asking at the source workspace (L1) to
 * proving at the target (L2, L3) to recording the link back at the source (L4).
 *
 * A server library: the actions (src/actions/linked-sign-in.ts) pass in who the session is, its
 * sid, the cookie secrets, the caller's address and the request's origin, and set the cookies this
 * returns — so every step runs from a script too. Workspace reads run as the workspace they are
 * about (`runAsTenant`), whichever host the request is on; the intent itself is one control-plane
 * row that both ends read.
 *
 * Nothing here looks an account up by its address: the source account is the session's user id,
 * the target account is whoever signs in at the target, and the link is the pair. Every refusal is
 * a `LinkRefused` with a §2.7 code; tokens, hashes, addresses and names never reach a log or an
 * audit's detail.
 */

export type IntentView = { sourceName: string; sourceHost: string; sourceEmail: string; targetName: string; expired: boolean };

/**
 * The password was right, but the account has two-factor and no code came with it — so the dialog
 * can ask for one (§8.4 `needs: "code"`). Still a `reauth` refusal to anything that doesn't look for
 * it. Never thrown for a wrong password.
 */
export class LinkNeedsCode extends LinkRefused {
  constructor() {
    super("reauth");
    this.name = "LinkNeedsCode";
  }
}

// ─── Shared pieces ───────────────────────────────────────────────────────────────────────────────

const ACCOUNT = {
  id: true,
  name: true,
  email: true,
  passwordHash: true,
  kind: true,
  active: true,
  role: true,
  isSuperAdmin: true,
  mustChangePassword: true,
  twoFactorEnabledAt: true,
  twoFactorSecretCipher: true,
} as const;
type Account = Prisma.UserGetPayload<{ select: typeof ACCOUNT }>;

/** The account, by its id in that workspace — never by its address. */
async function accountIn(tenant: Tenant, userId: string): Promise<Account | null> {
  return runAsTenant(tenant, async () => await db.user.findUnique({ where: { id: userId }, select: ACCOUNT }));
}

/** The sign-in behind a session, by its sid in that workspace. */
async function signInOf(tenant: Tenant, sid: string | undefined) {
  if (!sid) return null;
  return runAsTenant(tenant, async () => await db.signIn.findUnique({ where: { sid }, select: { userId: true, provider: true, at: true } }));
}

// Platform support's and the Automation account's addresses (src/lib/people.ts): nobody's, so never linked.
const isSupportAddress = (email: string) => isSystemAddress(email);

/** Only a person's own, active, ordinary account links — never platform support's. */
function mustBeMember(user: Account | null): asserts user is Account {
  if (!user || !user.active) throw new LinkRefused("not-member");
  if (user.kind !== "MEMBER" || isSupportAddress(user.email)) throw new LinkRefused("support");
}

/** A sign-in counts as a fresh proof only when it was a password or single sign-on — not a handoff, not a switch. */
const FRESH_PROVIDERS = new Set(["credentials", "microsoft-entra-id", "google", "zoho"]);

/** §4.8: L2, L3 and L4 share one budget per caller; unknown callers are not pooled into one. */
const openLimits = (ip: string | null) => (ip ? [{ key: `platform|link-open-caller:${ip}`, max: 60 }] : []);
const withinLimits = (limits: { key: string; max: number }[]) => limits.length === 0 || siteAllowance(limits, HOUR_MS);

function sameHash(given: string, stored: string | null): boolean {
  if (stored === null || given.length !== stored.length) return false;
  return timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(stored, "utf8"));
}

/** A Prisma error's code, or the error's name — what a log line may carry (never its message, which can quote values). */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return err instanceof Error ? err.name : "unknown";
}

function hostOf(origin: string): string | null {
  try {
    return normaliseHost(new URL(origin).host);
  } catch {
    return null;
  }
}

/**
 * The way back to the source (§4.1): the host the person asked from, while it still reaches the
 * source workspace — else the source's primary host. Rebuilt from the registry's answer, never
 * taken as given.
 */
async function wayBack(origin: string, source: Tenant): Promise<{ origin: string; host: string }> {
  const host = hostOf(origin);
  if (host && (await tenantForHost(host))?.id === source.id) return { origin: `${protocolFor(host)}://${host}`, host };
  return { origin: originOf(source), host: source.primaryHost };
}

/** The typed address → a workspace: a bare name is a slug; anything else a host, scheme and path dropped. */
async function workspaceAt(typed: string): Promise<Tenant | null> {
  const raw = String(typed ?? "").trim().toLowerCase();
  if (!raw || raw.length > 300) return null;
  if (SLUG_PATTERN.test(raw)) return tenantBySlug(raw);
  const host = normaliseHost(raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0]);
  return host ? tenantForHost(host) : null;
}

// The claims each token's MAC covers, read back from the row, in spec §4.1's order.
const intentClaims = (row: LinkIntent) => [row.sourceTenantId, row.sourceUserId, row.sourceOrigin, row.targetTenantId, row.expiresAt.toISOString()];
const completionClaims = (row: LinkIntent) => [row.tokenHash, row.sourceTenantId, row.targetTenantId, row.targetUserId ?? "", row.targetStamp ?? ""];

type Side = { tenantId: string; userId: string };

/**
 * §4.6's rules as `joinGroup` will apply them, read now without writing — so the person is told at
 * the target, before going back. Each side counts as its whole group, or as itself.
 */
async function groupRulesAllow(a: Side, b: Side): Promise<void> {
  const [ma, mb] = await Promise.all([memberOf(a.tenantId, a.userId), memberOf(b.tenantId, b.userId)]);
  if (ma && mb && ma.groupId === mb.groupId) throw new LinkRefused("already-linked");
  const tenantsOf = async (side: Side, member: { groupId: string } | null) =>
    member ? (await controlDb().linkMember.findMany({ where: { groupId: member.groupId }, select: { tenantId: true } })).map((m) => m.tenantId) : [side.tenantId];
  const [ours, theirs] = await Promise.all([tenantsOf(a, ma), tenantsOf(b, mb)]);
  const clash = ours.find((t) => theirs.includes(t));
  if (clash) throw new LinkRefused("conflict", (await controlDb().tenant.findUnique({ where: { id: clash }, select: { name: true } }))?.name);
  if (ours.length + theirs.length > MAX_LINKED_WORKSPACES) throw new LinkRefused("full");
}

/** What the target's pages show: where the request came from, as the registry knows it. Null when the source is gone. */
async function viewOf(row: LinkIntent, target: Tenant, now: Date): Promise<IntentView | null> {
  const source = await tenantById(row.sourceTenantId);
  if (!source) return null;
  const back = await wayBack(row.sourceOrigin, source);
  return { sourceName: source.name, sourceHost: back.host, sourceEmail: row.sourceEmail, targetName: target.name, expired: row.expiresAt <= now };
}

/**
 * Ends an intent unfinished: `failedAt` and the code on the row, `link.failed` for the source
 * (whose request it is), and the refusal to throw. A row already ended keeps its first reason.
 */
async function failed(row: LinkIntent, code: LinkRefusal, workspace?: string): Promise<LinkRefused> {
  await controlDb().linkIntent.updateMany({ where: { tokenHash: row.tokenHash, failedAt: null, completedAt: null }, data: { failedAt: new Date(), failure: code } });
  await linkAudit("link.failed", row.sourceTenantId, `workspace:${row.sourceUserId}`, { code, other: row.targetTenantId });
  return new LinkRefused(code, workspace);
}

// ─── L1: ask, at the source ──────────────────────────────────────────────────────────────────────

/**
 * L1.2: the person proves again that they are this account — its password (and code), counted on
 * the sign-in lockout keys exactly as `checkCredentials` counts them; or, asked for, a single sign-on
 * (Microsoft, Google or Zoho) on this very session under 10 minutes old.
 */
async function reauthenticate(source: Tenant, user: Account, input: { sid: string; password?: string; totpCode?: string; sso?: boolean; ip: string | null }): Promise<void> {
  // As at sign-in: the person's sign-in rule, their role's, or the company's setting says what proves them.
  const policy = await runAsTenant(source, async () => await signInPolicyFor(user));
  if (input.sso) {
    const signIn = await signInOf(source, input.sid);
    // A rule names the ways that count; without one, any single sign-on does, as it always has.
    const via = providerOfSignIn(signIn?.provider);
    const allowedVia = policy.method ? !!via && policy.providers.includes(via) : isSsoSignIn(signIn?.provider);
    const fresh = !!signIn && signIn.userId === user.id && allowedVia && Date.now() - signIn.at.getTime() <= SSO_FRESH_MS;
    if (!fresh) throw new LinkRefused("reauth-sso");
    return;
  }
  if (!policy.password) throw new LinkRefused("reauth-sso");

  const workspace = await runAsTenant(source, async () => await tenantKey());
  const keys = [`${workspace}|account:${user.email.trim().toLowerCase()}`, ...(input.ip ? [`${workspace}|caller:${input.ip}`] : [])];
  if (lockoutState(keys).lockedOut) throw new LinkRefused("rate-limited");

  const password = typeof input.password === "string" ? input.password : "";
  if (!password) throw new LinkRefused("reauth");
  if (!(await bcrypt.compare(password, user.passwordHash))) {
    recordFailure(keys);
    throw new LinkRefused("reauth");
  }
  if (user.twoFactorEnabledAt) {
    const code = typeof input.totpCode === "string" ? input.totpCode.trim() : "";
    // Not a failure: the password was right. The failures are cleared only once the code is too, so
    // a known password can't reset the count between guessed codes.
    if (!code) throw new LinkNeedsCode();
    const cipher = user.twoFactorSecretCipher;
    const secret = cipher ? await runAsTenant(source, async () => await decryptSecret(cipher)) : null;
    if (!secret || !verifyTotpCode(secret, code)) {
      recordFailure(keys);
      throw new LinkRefused("reauth");
    }
  }
  clearFailures(keys);
}

/**
 * L1 — "Add a workspace", asked at the source by its signed-in account. Returns the target's
 * `/link/start` URL (the token in its fragment) and the secret for this browser's `deskzo.link`
 * cookie, which alone can finish it (L4).
 */
export async function createLinkIntent(input: {
  source: Tenant;
  userId: string;
  sid: string | undefined;
  viewingAs: boolean;
  workspace: string;
  password?: string;
  totpCode?: string;
  sso?: boolean;
  ip: string | null;
  origin: string;
}): Promise<{ url: string; browserSecret: string }> {
  const { source } = input;

  // L1.1: the person's own ordinary account, the feature on, within the budget.
  if (input.viewingAs) throw new LinkRefused("view-as");
  const user = await accountIn(source, input.userId);
  mustBeMember(user);
  // A workspace from the environment has no control-plane row to link.
  if (source.source !== "control" || !(await linkedSignInEnabled())) throw new LinkRefused("disabled");
  const asks = [{ key: `platform|link-ask:${source.id}:${user.id}`, max: 5 }, ...(input.ip ? [{ key: `platform|link-ask-caller:${input.ip}`, max: 20 }] : [])];
  if (!withinLimits(asks)) throw new LinkRefused("rate-limited");
  // Only the session that asked finishes (L4); a session without a sid can't be told apart.
  const sid = input.sid;
  if (!sid) throw new LinkRefused("not-fresh");

  // L1.2
  await reauthenticate(source, user, { ...input, sid });

  // L1.3: the workspace typed, open, and not already in this account's group or a full one.
  const target = await workspaceAt(input.workspace);
  if (!target) throw new LinkRefused("unknown-workspace");
  if (target.id === source.id) throw new LinkRefused("same-workspace");
  if (target.status !== "ACTIVE" || target.source !== "control") throw new LinkRefused("workspace-unavailable");
  const mine = await memberOf(source.id, user.id);
  if (mine) {
    const there = await controlDb().linkMember.findUnique({ where: { groupId_tenantId: { groupId: mine.groupId, tenantId: target.id } }, select: { id: true } });
    if (there) throw new LinkRefused("already-linked");
    if ((await controlDb().linkMember.count({ where: { groupId: mine.groupId } })) >= MAX_LINKED_WORKSPACES) throw new LinkRefused("full");
  }

  // L1.4: the intent, MAC-bound for the target to verify.
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LINK_INTENT_TTL_MS);
  const sourceOrigin = (await wayBack(input.origin, source)).origin;
  const { token, hash } = mintToken("link-intent", target.id, [source.id, user.id, sourceOrigin, target.id, expiresAt.toISOString()]);
  const browser = newBrowserSecret();
  await controlDb().linkIntent.create({
    data: {
      tokenHash: hash,
      sourceTenantId: source.id,
      sourceUserId: user.id,
      sourceSid: sid,
      sourceOrigin,
      sourceStamp: credentialStamp(source.id, user),
      sourceEmail: user.email,
      sourceName: user.name,
      browserSecretHash: browser.hash,
      targetTenantId: target.id,
      expiresAt,
      ip: input.ip,
    },
    select: { tokenHash: true },
  });

  // L1.5
  await linkAudit("link.intent", source.id, `workspace:${user.id}`, { other: target.id });
  return { url: `${originOf(target)}/link/start#i=${token}`, browserSecret: browser.secret };
}

// ─── L2: present, at the target ──────────────────────────────────────────────────────────────────

/**
 * L2 — the target's `/link/start` presents the token, once, in one browser: that browser's secret
 * (for `deskzo.link-in`) is returned, and only it can confirm (L3). Signing out any session here
 * and sending the person to sign in is the action's part.
 */
export async function presentLinkIntent(target: Tenant, token: string, ip: string | null): Promise<{ targetSecret: string; view: IntentView }> {
  if (!controlConfigured() || !(await linkedSignInEnabled())) throw new LinkRefused("disabled");
  // L2.3: the per-caller budget, counted before any lookup.
  if (!withinLimits(openLimits(ip))) throw new LinkRefused("rate-limited");

  // L2.1: the row by the token's hash, trusted only once its MAC — for this workspace — holds.
  const hash = tokenHashOf(token);
  const row = hash ? await controlDb().linkIntent.findUnique({ where: { tokenHash: hash } }) : null;
  if (!row || row.targetTenantId !== target.id || !tokenMacValid("link-intent", target.id, token, intentClaims(row))) throw new LinkRefused("used");
  const now = new Date();
  if (row.expiresAt <= now) throw new LinkRefused("expired");
  if (row.presentedAt || row.failedAt) throw new LinkRefused("used");
  const view = await viewOf(row, target, now);
  if (!view) throw new LinkRefused("workspace-unavailable");

  const browser = newBrowserSecret();
  const spent = await controlDb().linkIntent.updateMany({
    where: { tokenHash: row.tokenHash, targetTenantId: target.id, presentedAt: null, failedAt: null, expiresAt: { gt: now } },
    data: { presentedAt: now, targetBrowserHash: browser.hash },
  });
  if (spent.count !== 1) throw new LinkRefused("used");
  return { targetSecret: browser.secret, view };
}

/** For `/link/confirm`: the request this browser presented here, while it can still be confirmed. */
export async function linkIntentFor(target: Tenant, targetSecret: string | null): Promise<IntentView | null> {
  if (!targetSecret || !controlConfigured()) return null;
  const row = await controlDb().linkIntent.findUnique({ where: { targetBrowserHash: sha256Hex(targetSecret) } });
  if (!row || row.targetTenantId !== target.id || row.provenAt || row.failedAt) return null;
  return viewOf(row, target, new Date());
}

// ─── L3: prove, at the target ────────────────────────────────────────────────────────────────────

/**
 * L3 — the account that has just signed in at the target confirms. Records it on the intent with a
 * one-minute completion token (MAC-bound for the source) and returns the URL back to the source's
 * `/link/complete`, the token in its fragment.
 */
export async function proveLinkIntent(
  target: Tenant,
  input: { targetSecret: string | null; userId: string; sid: string | undefined; viewingAs: boolean; ip: string | null },
): Promise<{ url: string }> {
  if (!controlConfigured()) throw new LinkRefused("disabled");

  // L3.1: the person's own ordinary account here; the request this browser presented, still open.
  if (input.viewingAs) throw new LinkRefused("view-as");
  const user = await accountIn(target, input.userId);
  mustBeMember(user);
  if (!(await linkedSignInEnabled())) throw new LinkRefused("disabled");
  if (!withinLimits(openLimits(input.ip))) throw new LinkRefused("rate-limited");
  const row = input.targetSecret ? await controlDb().linkIntent.findUnique({ where: { targetBrowserHash: sha256Hex(input.targetSecret) } }) : null;
  if (!row || row.targetTenantId !== target.id || !row.presentedAt) throw new LinkRefused("wrong-browser");
  const now = new Date();
  if (row.provenAt || row.failedAt) throw new LinkRefused("used");
  if (row.expiresAt <= now) throw new LinkRefused("expired");

  // L3.2: a real sign-in, made after the request was presented — not a session that was already here.
  const signIn = await signInOf(target, input.sid);
  if (!signIn || signIn.userId !== user.id || !FRESH_PROVIDERS.has(signIn.provider) || signIn.at < row.presentedAt) throw new LinkRefused("not-fresh");
  if (user.mustChangePassword) throw new LinkRefused("must-change-password", target.name);
  const security = await runAsTenant(target, async () => await getCachedSecuritySettings());
  if (security?.enforceTwoFactor && !user.twoFactorEnabledAt) throw new LinkRefused("two-factor-setup", target.name);
  // The proof goes back there, so the source must still be open to take it.
  const source = await tenantById(row.sourceTenantId);
  if (!source || source.status !== "ACTIVE") throw new LinkRefused("workspace-unavailable", source?.name);

  // L3.3
  await groupRulesAllow({ tenantId: row.sourceTenantId, userId: row.sourceUserId }, { tenantId: target.id, userId: user.id });

  // L3.4: who proved it, and the token that carries that back — only for the browser that presented it.
  const targetStamp = credentialStamp(target.id, user);
  const completion = mintToken("link-completion", row.sourceTenantId, [row.tokenHash, row.sourceTenantId, target.id, user.id, targetStamp]);
  const proven = await controlDb().linkIntent.updateMany({
    where: { tokenHash: row.tokenHash, targetTenantId: target.id, targetBrowserHash: row.targetBrowserHash, provenAt: null, failedAt: null, expiresAt: { gt: now } },
    data: { targetUserId: user.id, targetEmail: user.email, targetName: user.name, targetStamp, provenAt: now, completionHash: completion.hash },
  });
  if (proven.count !== 1) throw new LinkRefused("used");
  // No member exists here yet, so the row is filed under the account that approved.
  await runAsTenant(target, async () =>
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "LinkedSignIn", entityId: user.id, entityLabel: "Approved linking this account with another workspace" }),
  );
  await linkAudit("link.proven", target.id, `workspace:${user.id}`, { other: row.sourceTenantId });

  // L3.5
  const back = await wayBack(row.sourceOrigin, source);
  return { url: `${back.origin}/link/complete#c=${completion.token}` };
}

/** "Cancel" on `/link/confirm`: the request ends as `cancelled`, if this browser presented it and it is still open. */
export async function cancelLinkIntent(target: Tenant, targetSecret: string | null): Promise<void> {
  if (!targetSecret || !controlConfigured()) return;
  const row = await controlDb().linkIntent.findUnique({ where: { targetBrowserHash: sha256Hex(targetSecret) } });
  if (!row || row.targetTenantId !== target.id) return;
  const ended = await controlDb().linkIntent.updateMany({
    where: { tokenHash: row.tokenHash, targetTenantId: target.id, failedAt: null, completedAt: null, completionSeenAt: null },
    data: { failedAt: new Date(), failure: "cancelled" },
  });
  if (ended.count === 1) await linkAudit("link.failed", row.sourceTenantId, `workspace:${row.sourceUserId}`, { code: "cancelled", other: target.id });
}

// ─── L4: record, at the source ───────────────────────────────────────────────────────────────────

/** The §4.9 notice, to each address once. A notice that can't be sent never undoes the link. */
async function sendLinkedNotice(addresses: string[], a: Tenant, b: Tenant, at: Date): Promise<void> {
  const text = [
    "Your accounts in these two workspaces were linked:",
    "",
    `  ${a.name} (${a.primaryHost})`,
    `  ${b.name} (${b.primaryHost})`,
    "",
    `When: ${formatIstDateTime(at)} IST`,
    "",
    "You can now switch between them from the workspace header.",
    "",
    "If this wasn't you, open Profile → Linked workspaces in either workspace, unlink them, and change your password.",
  ].join("\n");
  const seen = new Set<string>();
  for (const address of addresses) {
    const key = address.trim().toLowerCase();
    if (!key || seen.has(key) || isSupportAddress(key)) continue;
    seen.add(key);
    try {
      await sendPlatformMail({ to: address.trim(), subject: "Your workspaces were linked", text });
    } catch (err) {
      console.warn(`[linked] could not send a link notice: ${errorCode(err)}`);
    }
  }
}

/**
 * L4 — the completion token back at the source's `/link/complete`. Spent the moment it is seen,
 * before anything else is checked, so a copy of the URL is worth nothing afterwards; then it must
 * be this workspace's, within its minute, in the browser and the session that asked. Every refusal
 * after the spend ends the intent. Returns the target's name and its member id (for "Switch to").
 */
export async function completeLinkIntent(
  source: Tenant,
  input: { completion: string; browserSecret: string | null; userId: string | null; sid: string | undefined; viewingAs: boolean; ip: string | null },
): Promise<{ workspace: string; memberId: string }> {
  if (!controlConfigured()) throw new LinkRefused("disabled");

  // L4.1: spend first; then trust the row only once its MAC — for this workspace — holds.
  const hash = tokenHashOf(input.completion);
  if (!hash) throw new LinkRefused("used");
  const now = new Date();
  const spent = await controlDb().linkIntent.updateMany({ where: { completionHash: hash, completionSeenAt: null }, data: { completionSeenAt: now } });
  if (spent.count !== 1) throw new LinkRefused("used");
  const row = await controlDb().linkIntent.findUnique({ where: { completionHash: hash } });
  if (!row) throw new LinkRefused("used");
  if (row.sourceTenantId !== source.id || !row.provenAt || !row.targetUserId || !row.targetStamp || !tokenMacValid("link-completion", source.id, input.completion, completionClaims(row))) {
    throw await failed(row, "used");
  }
  // Ended at the target in the meantime (Cancel): it keeps that reason.
  if (row.failedAt) throw new LinkRefused(row.failure === "cancelled" ? "cancelled" : "used");
  if (!withinLimits(openLimits(input.ip))) throw await failed(row, "rate-limited");

  // L4.2: within the minute; this browser; this session; the account unchanged; the feature on.
  if (now.getTime() > row.provenAt.getTime() + LINK_COMPLETION_TTL_MS) throw await failed(row, "expired");
  if (!input.browserSecret || !sameHash(sha256Hex(input.browserSecret), row.browserSecretHash)) throw await failed(row, "wrong-browser");
  if (!input.userId || input.userId !== row.sourceUserId || !input.sid || input.sid !== row.sourceSid) throw await failed(row, "wrong-browser");
  if (input.viewingAs) throw await failed(row, "view-as");
  const user = await accountIn(source, row.sourceUserId);
  if (!user || !user.active) throw await failed(row, "not-member");
  if (user.kind !== "MEMBER" || isSupportAddress(user.email)) throw await failed(row, "support");
  if (!sameHash(credentialStamp(source.id, user), row.sourceStamp)) throw await failed(row, "stale", source.name);
  if (!(await linkedSignInEnabled())) throw await failed(row, "disabled");
  // The account proven at the target, a minute ago: still there, and its credentials unchanged since.
  const target = await tenantById(row.targetTenantId);
  if (!target || target.status !== "ACTIVE") throw await failed(row, "workspace-unavailable", target?.name);
  const other = await accountIn(target, row.targetUserId);
  if (!other || !other.active || other.kind !== "MEMBER" || !sameHash(credentialStamp(target.id, other), row.targetStamp)) throw await failed(row, "stale", target.name);

  // L4.3
  const sourceSide: JoinSide = { tenantId: source.id, userId: user.id, email: user.email, name: user.name, stamp: row.sourceStamp, provenAt: row.createdAt };
  const targetSide: JoinSide = { tenantId: target.id, userId: other.id, email: other.email, name: other.name, stamp: row.targetStamp, provenAt: row.provenAt };
  let joined: Awaited<ReturnType<typeof joinGroup>>;
  try {
    joined = await joinGroup(sourceSide, targetSide);
  } catch (err) {
    if (err instanceof LinkRefused) throw await failed(row, err.code, err.workspace);
    throw err;
  }
  await controlDb().linkIntent.updateMany({ where: { tokenHash: row.tokenHash, completedAt: null }, data: { completedAt: new Date() } });

  // L4.4: the workspace's own record (never naming the other), and the notice to both addresses.
  // joinGroup has written `link.created` for both workspaces.
  const mine = await memberOf(source.id, user.id);
  await runAsTenant(source, async () =>
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "LinkedSignIn", entityId: mine?.id ?? user.id, entityLabel: "Linked this account with another workspace" }),
  );
  await sendLinkedNotice([user.email, other.email], source, target, now);
  return { workspace: target.name, memberId: joined.targetMemberId };
}
