import { Prisma } from "@wroffy/control-client";
import { formatIstDateTime } from "@/lib/india-time";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { MAX_LINKED_WORKSPACES, originOf } from "@/lib/platform/linked/keys";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { subdomainHost, tenantById } from "@/lib/tenancy/registry";
import { isSystemAddress } from "@/lib/people";

/**
 * Link groups: one person's accounts in several workspaces (spec §4.6, §4.7, §4.9).
 *
 * A member is an account by its id in one workspace — never by its address, which nothing here
 * matches on. An account is in at most one group, a group holds at most one account per workspace
 * and at most MAX_LINKED_WORKSPACES, and a group left with one member is no link at all: it goes.
 * Joining and revoking run in Serializable control-plane transactions, so two requests racing on
 * the same group cannot leave it half-merged, over the cap, or down to one member.
 *
 * Also here: the platform's kill switch (`linkedSignIn.enabled`), each workspace's "allow switching
 * in" rule, and the platform audit every step writes — ids, codes and counts only, never an
 * address, a token, a hash or a name.
 */

export type LinkRefusal =
  | "disabled"
  | "not-member"
  | "view-as"
  | "support"
  | "reauth"
  | "reauth-sso"
  | "rate-limited"
  | "unknown-workspace"
  | "same-workspace"
  | "workspace-unavailable"
  | "already-linked"
  | "conflict"
  | "full"
  | "expired"
  | "used"
  | "wrong-browser"
  | "not-fresh"
  | "must-change-password"
  | "two-factor-setup"
  | "stale"
  | "cancelled";

/** A refusal the person is told about (spec §2.7). `workspace` is the name a message puts in "<name>". */
export class LinkRefused extends Error {
  constructor(
    public code: LinkRefusal,
    public workspace?: string,
  ) {
    super(`Linking refused: ${code}`);
    this.name = "LinkRefused";
  }
}

export type RevokeReason = "user" | "left" | "admin" | "deactivated" | "deleted" | "credentials" | "two-factor-reset" | "workspace-closed" | "data-reset";
export type LinkedWorkspaceState = "available" | "switching-off" | "billing-hold" | "unavailable";
export type LinkedWorkspace = {
  memberId: string;
  tenantId: string;
  name: string;
  host: string;
  origin: string;
  email: string;
  current: boolean;
  state: LinkedWorkspaceState;
  linkedAt: Date;
  lastSwitchedInAt: Date | null;
};

type Tx = Prisma.TransactionClient;

/** A Prisma error's code, or the error's name — what a log line may carry (never its message, which can quote values). */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return err instanceof Error ? err.name : "unknown";
}

// P2034: a write conflict or deadlock under Serializable. P2002: a racing request inserted the same member first.
const RETRYABLE = new Set(["P2034", "P2002"]);

/** One control-plane transaction, Serializable, tried once more when it lost a race — the second try reads the winner's rows. */
async function serializable<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await controlDb().$transaction(async (tx) => work(tx), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (err) {
      if (attempt < 2 && RETRYABLE.has(errorCode(err))) continue;
      throw err;
    }
  }
}

// ─── The kill switch ─────────────────────────────────────────────────────────────────────────────

const KILL_SWITCH = "linkedSignIn.enabled";
const ENABLED_MS = 30_000;
/** An unreadable switch counts as off, and is asked again sooner. */
const UNREADABLE_MS = 5_000;

/**
 * This process's copy of the platform's switch — one per install, no workspace's data. A save here
 * replaces it; a read that began before the save does not put its older answer back.
 */
let enabledCache: { on: boolean; at: number; ms: number } | null = null;

/** Linked sign-in is on: a control plane, and `linkedSignIn.enabled` not "0" (missing = on). Cached 30 s; never throws. */
export async function linkedSignInEnabled(): Promise<boolean> {
  if (!controlConfigured()) return false;
  const seen = enabledCache;
  const now = Date.now();
  if (seen && now >= seen.at && now - seen.at < seen.ms) return seen.on;
  let on = false;
  let ms = ENABLED_MS;
  try {
    const row = await controlDb().platformSetting.findUnique({ where: { key: KILL_SWITCH }, select: { value: true } });
    on = row?.value !== "0";
  } catch (err) {
    // A switch that can't be read must not be taken as on.
    console.error(`[linked] could not read ${KILL_SWITCH}, so linked sign-in is paused for now: ${errorCode(err)}`);
    ms = UNREADABLE_MS;
  }
  if (enabledCache === seen) enabledCache = { on, at: Date.now(), ms };
  return on;
}

/** The switch as stored, read fresh — for the console's Settings page. `updatedBy`: a staff member's id, or a script's name. */
export type LinkedSignInSetting = { enabled: boolean; updatedBy: string | null; updatedAt: Date | null };

/** Fresh from the control plane (no cache). Off without one. Throws when it can't be read. */
export async function linkedSignInSetting(): Promise<LinkedSignInSetting> {
  if (!controlConfigured()) return { enabled: false, updatedBy: null, updatedAt: null };
  const row = await controlDb().platformSetting.findUnique({ where: { key: KILL_SWITCH }, select: { value: true, updatedBy: true, updatedAt: true } });
  return { enabled: row?.value !== "0", updatedBy: row?.updatedBy ?? null, updatedAt: row?.updatedAt ?? null };
}

/**
 * Saves the switch ("1" / "0") under `by`. This process follows at once; others within 30 seconds.
 * Writes no audit: the console's action records its own under the staff member.
 */
export async function saveLinkedSignInSetting(enabled: boolean, by: string): Promise<void> {
  const value = enabled ? "1" : "0";
  await controlDb().platformSetting.upsert({ where: { key: KILL_SWITCH }, create: { key: KILL_SWITCH, value, updatedBy: by }, update: { value, updatedBy: by } });
  enabledCache = { on: enabled, at: Date.now(), ms: ENABLED_MS };
}

/** The kill switch from scripts/linked-sign-in.ts: saved, and audited `link.kill-switch` as the script. */
export async function setLinkedSignInEnabled(on: boolean, by: string): Promise<void> {
  await saveLinkedSignInSetting(on, by);
  await linkAudit("link.kill-switch", null, by, { enabled: on }, "SCRIPT");
}

/** Forgets this process's copy — for a check suite that writes the setting directly. */
export function forgetLinkedSignInEnabled(): void {
  enabledCache = null;
}

// ─── Each workspace's rule ───────────────────────────────────────────────────────────────────────

/** "Allow switching into this workspace from linked accounts" — read fresh; on when never set. */
export async function switchInAllowed(tenantId: string): Promise<boolean> {
  if (!controlConfigured()) return false;
  const row = await controlDb().tenantSignInPolicy.findUnique({ where: { tenantId }, select: { allowSwitchIn: true } });
  return row?.allowSwitchIn ?? true;
}

/** Set from the workspace's Security settings, by one of its admins. */
export async function setSwitchInAllowed(tenantId: string, on: boolean, by: { id: string; name: string }): Promise<void> {
  const data = { allowSwitchIn: on, updatedByUserId: by.id, updatedByName: by.name };
  await controlDb().tenantSignInPolicy.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
  await linkAudit("link.policy", tenantId, `workspace:${by.id}`, { allowSwitchIn: on });
}

// ─── Members and groups ──────────────────────────────────────────────────────────────────────────

export async function memberOf(tenantId: string, userId: string): Promise<{ id: string; groupId: string; stamp: string } | null> {
  if (!controlConfigured()) return null;
  return controlDb().linkMember.findUnique({ where: { tenantId_userId: { tenantId, userId } }, select: { id: true, groupId: true, stamp: true } });
}

function stateOf(tenant: { status: string; suspendedFor: string | null }, allowSwitchIn: boolean, enabled: boolean, reachable: boolean): LinkedWorkspaceState {
  if (tenant.status === "SUSPENDED" && tenant.suspendedFor === "BILLING") return "billing-hold";
  if (tenant.status !== "ACTIVE" || !reachable) return "unavailable";
  if (!allowSwitchIn) return "switching-off";
  return enabled ? "available" : "unavailable";
}

/**
 * The person's own linked workspaces, as the account (tenantId, userId) — this one first, then by
 * name; [] when it is linked with none. Closed workspaces are left out. Hosts come from the registry.
 */
export async function linkedWorkspacesFor(tenantId: string, userId: string): Promise<LinkedWorkspace[]> {
  const me = await memberOf(tenantId, userId);
  if (!me) return [];
  const [rows, enabled] = await Promise.all([
    controlDb().linkMember.findMany({
      where: { groupId: me.groupId },
      select: {
        id: true,
        tenantId: true,
        email: true,
        createdAt: true,
        lastSwitchedInAt: true,
        tenant: { select: { slug: true, name: true, status: true, suspendedFor: true, signInPolicy: { select: { allowSwitchIn: true } } } },
      },
    }),
    linkedSignInEnabled(),
  ]);
  const items = await Promise.all(
    rows
      .filter((r) => r.tenant.status !== "DEPROVISIONED")
      .map(async (r): Promise<LinkedWorkspace> => {
        // A workspace the registry can't open still shows, as unavailable, on its own address.
        const registered = await tenantById(r.tenantId).catch(() => null);
        const host = registered?.primaryHost ?? subdomainHost(r.tenant.slug);
        return {
          memberId: r.id,
          tenantId: r.tenantId,
          name: r.tenant.name,
          host,
          origin: originOf({ primaryHost: host }),
          email: r.email,
          current: r.id === me.id,
          state: stateOf(r.tenant, r.tenant.signInPolicy?.allowSwitchIn ?? true, enabled, !!registered),
          linkedAt: r.createdAt,
          lastSwitchedInAt: r.lastSwitchedInAt,
        };
      }),
  );
  return items.sort((a, b) => (a.current !== b.current ? (a.current ? -1 : 1) : a.name.localeCompare(b.name, "en", { sensitivity: "base" })));
}

export type JoinSide = { tenantId: string; userId: string; email: string; name: string; stamp: string; provenAt: Date };

const STAMP = /^[0-9a-f]{64}$/;
// Platform support's and the Automation account's addresses (src/lib/people.ts): nobody's, so never linked.
const isSupportAddress = (email: string) => isSystemAddress(email);

/**
 * Records a proven link between two accounts (spec §4.6), in one Serializable transaction:
 * neither in a group → a new group of two; one in a group → the other joins it; both in one group →
 * `already` (stamps, addresses, names and `provenAt` refreshed); two groups → the smaller merged
 * into the larger. Refuses `conflict` when that would put two accounts of one workspace in a group,
 * `full` past MAX_LINKED_WORKSPACES, `support` for a platform support address, `same-workspace`.
 * A new link is audited `link.created` for both workspaces.
 */
export async function joinGroup(source: JoinSide, target: JoinSide): Promise<{ groupId: string; targetMemberId: string; merged: boolean; already: boolean }> {
  if (source.tenantId === target.tenantId) throw new LinkRefused("same-workspace");
  if (isSupportAddress(source.email) || isSupportAddress(target.email)) throw new LinkRefused("support");
  if (!STAMP.test(source.stamp) || !STAMP.test(target.stamp)) throw new Error("A linked account's stamp must be credentialStamp()'s 64 hex characters.");

  const joined = await serializable(async (tx) => {
    const find = (side: JoinSide) => tx.linkMember.findUnique({ where: { tenantId_userId: { tenantId: side.tenantId, userId: side.userId } }, select: { id: true, groupId: true } });
    const proven = (side: JoinSide) => ({ email: side.email, name: side.name, stamp: side.stamp, provenAt: side.provenAt });
    const refresh = (id: string, side: JoinSide) => tx.linkMember.update({ where: { id }, data: proven(side), select: { id: true } });
    const add = (groupId: string, side: JoinSide) => tx.linkMember.create({ data: { groupId, tenantId: side.tenantId, userId: side.userId, ...proven(side) }, select: { id: true } });
    const tenantsIn = async (groupId: string) => (await tx.linkMember.findMany({ where: { groupId }, select: { tenantId: true } })).map((m) => m.tenantId);
    const nameOf = async (tenantId: string) => (await tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }))?.name;

    const a = await find(source);
    const b = await find(target);

    if (a && b && a.groupId === b.groupId) {
      await refresh(a.id, source);
      await refresh(b.id, target);
      return { groupId: a.groupId, sourceMemberId: a.id, targetMemberId: b.id, merged: false, already: true };
    }

    if (!a && !b) {
      const group = await tx.linkGroup.create({ data: {}, select: { id: true } });
      const made = await add(group.id, source);
      const other = await add(group.id, target);
      return { groupId: group.id, sourceMemberId: made.id, targetMemberId: other.id, merged: false, already: false };
    }

    if (a && b) {
      const ours = await tenantsIn(a.groupId);
      const theirs = await tenantsIn(b.groupId);
      const clash = ours.find((t) => theirs.includes(t));
      if (clash) throw new LinkRefused("conflict", await nameOf(clash));
      if (ours.length + theirs.length > MAX_LINKED_WORKSPACES) throw new LinkRefused("full");
      // Fewer rows move. Both groups were proven the same way, so either may absorb the other.
      const [keep, drop] = ours.length >= theirs.length ? [a.groupId, b.groupId] : [b.groupId, a.groupId];
      await tx.linkMember.updateMany({ where: { groupId: drop }, data: { groupId: keep } });
      await tx.linkGroup.delete({ where: { id: drop } });
      await refresh(a.id, source);
      await refresh(b.id, target);
      return { groupId: keep, sourceMemberId: a.id, targetMemberId: b.id, merged: true, already: false };
    }

    // One side is in a group; the other joins it.
    const inGroup = (a ?? b)!;
    const joiner = a ? target : source;
    const tenants = await tenantsIn(inGroup.groupId);
    if (tenants.includes(joiner.tenantId)) throw new LinkRefused("conflict", await nameOf(joiner.tenantId));
    if (tenants.length + 1 > MAX_LINKED_WORKSPACES) throw new LinkRefused("full");
    const made = await add(inGroup.groupId, joiner);
    await refresh(inGroup.id, a ? source : target);
    return { groupId: inGroup.groupId, sourceMemberId: a ? a.id : made.id, targetMemberId: a ? made.id : inGroup.id, merged: false, already: false };
  });

  if (!joined.already) {
    const detail = (memberId: string, other: string) => ({ groupId: joined.groupId, memberId, other, ...(joined.merged ? { merged: true } : {}) });
    await linkAudit("link.created", source.tenantId, `workspace:${source.userId}`, detail(joined.sourceMemberId, target.tenantId));
    await linkAudit("link.created", target.tenantId, `workspace:${target.userId}`, detail(joined.targetMemberId, source.tenantId));
  }
  return { groupId: joined.groupId, targetMemberId: joined.targetMemberId, merged: joined.merged, already: joined.already };
}

// ─── Revocation ──────────────────────────────────────────────────────────────────────────────────

/** A workspace person ("user:<id>", "admin:<id>") is audited as "workspace:<id>", as support grants are; "sweep", "import", "reset" as they are. */
function actorOf(by: string): string {
  const person = /^(?:user|admin):(.+)$/.exec(by);
  return person ? `workspace:${person[1]}` : by;
}

type Removed = { id: string; groupId: string; tenantId: string; email: string };
const REMOVED_SELECT = { id: true, groupId: true, tenantId: true, email: true } as const;

/**
 * Removes one member (spec §4.7), and its group too when fewer than two would be left — that last
 * member's removal audited with `dissolved: true`. Each removal: platform audit `link.revoked`
 * (`{ reason, by, groupId }`) and an unlink notice to that account's address (owner decision 7).
 * False when there was nothing to remove.
 */
export async function revokeMember(memberId: string, reason: RevokeReason, by: string): Promise<boolean> {
  if (!controlConfigured()) return false;
  const removed = await serializable(async (tx) => {
    const member = await tx.linkMember.findUnique({ where: { id: memberId }, select: REMOVED_SELECT });
    if (!member) return null;
    const gone = await tx.linkMember.deleteMany({ where: { id: member.id } });
    if (gone.count !== 1) return null;
    const rest = await tx.linkMember.findMany({ where: { groupId: member.groupId }, select: REMOVED_SELECT });
    if (rest.length >= 2) return { member, dissolved: [] as Removed[] };
    // One account alone is no link: it goes, and the group with it.
    await tx.linkMember.deleteMany({ where: { groupId: member.groupId } });
    await tx.linkGroup.deleteMany({ where: { id: member.groupId } });
    return { member, dissolved: rest };
  });
  if (!removed) return false;

  const { member, dissolved } = removed;
  const actor = actorOf(by);
  await linkAudit("link.revoked", member.tenantId, actor, { reason, by, groupId: member.groupId });
  for (const other of dissolved) await linkAudit("link.revoked", other.tenantId, actor, { reason, by, groupId: member.groupId, dissolved: true });
  await sendUnlinkNotice(member, WHY[reason], CLOSED.has(reason));
  for (const other of dissolved) await sendUnlinkNotice(other, "The last workspace linked with it was unlinked.", false);
  return true;
}

/** The account's own member, if it has one. */
export async function revokeLinksForUser(tenantId: string, userId: string, reason: RevokeReason, by: string): Promise<boolean> {
  const member = await memberOf(tenantId, userId);
  return member ? revokeMember(member.id, reason, by) : false;
}

/** Every member in the workspace — a data reset, a closed workspace, an admin's "unlink everyone". How many were removed. */
export async function revokeWorkspaceLinks(tenantId: string, reason: RevokeReason, by: string): Promise<number> {
  if (!controlConfigured()) return 0;
  const members = await controlDb().linkMember.findMany({ where: { tenantId }, select: { id: true } });
  let count = 0;
  for (const m of members) if (await revokeMember(m.id, reason, by)) count += 1;
  return count;
}

/** The workspace's linked accounts, for its admins: ids and dates only — never where they are linked to. */
export async function linkedUsersOf(tenantId: string): Promise<{ memberId: string; userId: string; linkedAt: Date; lastSwitchedInAt: Date | null }[]> {
  if (!controlConfigured()) return [];
  const rows = await controlDb().linkMember.findMany({ where: { tenantId }, select: { id: true, userId: true, createdAt: true, lastSwitchedInAt: true }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => ({ memberId: r.id, userId: r.userId, linkedAt: r.createdAt, lastSwitchedInAt: r.lastSwitchedInAt }));
}

// ─── Notices and the audit ───────────────────────────────────────────────────────────────────────

/** Why, in the unlink notice. It goes to the account's own address and names only that account's workspace. */
const WHY: Record<RevokeReason, string> = {
  user: "It was unlinked from Profile → Linked workspaces in one of your other workspaces.",
  left: "It was unlinked from all your other workspaces, from its own Profile page.",
  admin: "An administrator of that workspace unlinked it.",
  deactivated: "Your account there was switched off.",
  deleted: "Your account there no longer exists.",
  credentials: "The password or email address of your account there changed.",
  "two-factor-reset": "Two-factor sign-in for your account there was reset or turned off.",
  "workspace-closed": "The workspace was closed.",
  "data-reset": "The workspace's data was reset.",
};
/** Reasons after which the account can't simply sign in there and change its password. */
const CLOSED = new Set<RevokeReason>(["deactivated", "deleted", "workspace-closed", "data-reset"]);

async function sendUnlinkNotice(member: Removed, why: string, closed: boolean): Promise<void> {
  if (isSupportAddress(member.email)) return;
  try {
    const tenant = await tenantById(member.tenantId);
    if (!tenant) return;
    const text = [
      `${tenant.name} (${tenant.primaryHost}) is no longer linked with your other workspaces, so you can't switch into it or out of it from the workspace header.`,
      "",
      `Why: ${why}`,
      `When: ${formatIstDateTime(new Date())} IST`,
      "",
      closed
        ? `If you didn't expect this, ask an administrator of ${tenant.name}.`
        : `If you didn't expect this, sign in to ${tenant.name} directly and change your password, or ask its administrator.`,
    ].join("\n");
    await sendPlatformMail({ to: member.email, subject: "A workspace was unlinked", text });
  } catch (err) {
    // The unlink stands; only the notice is lost.
    console.warn(`[linked] could not send an unlink notice: ${errorCode(err)}`);
  }
}

/**
 * One platform audit row (spec §4.9) — `actorKind` SYSTEM with `actor` "workspace:<userId>" for what a
 * workspace's people did, SCRIPT for the kill switch. Never throws: an audit that can't be written
 * must not undo what it records.
 */
export async function linkAudit(action: string, tenantId: string | null, actor: string, detail?: Record<string, unknown>, actorKind: "SYSTEM" | "SCRIPT" = "SYSTEM"): Promise<void> {
  if (!controlConfigured()) return;
  try {
    await controlDb().platformAuditLog.create({
      data: { actorKind, actor, action, tenantId, ...(detail ? { detail: detail as Prisma.InputJsonValue } : {}) },
      select: { id: true },
    });
  } catch (err) {
    console.error(`[linked] could not write the platform audit (${action}): ${errorCode(err)}`);
  }
}
