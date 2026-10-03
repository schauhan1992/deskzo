"use server";

import { revalidatePath } from "next/cache";
import type { DeviceStatus, IpRuleAction, Prisma, UnknownNetworkAction } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { toPlain } from "@/lib/serialize";
import { pageSlice } from "@/lib/pagination";
import { logActivity } from "@/lib/activity";
import { notifyUser } from "@/lib/notify";
import { OPEN_POLICY, decideAccess, networkStanding, type RolePolicy } from "@/lib/access/decide";
import { deviceKindFrom } from "@/lib/access/device";
import { hashDeviceToken, validDeviceToken } from "@/lib/access/device-token";
import { cidrSize, normaliseIp, parseCidr } from "@/lib/access/ip";
import { geoDatabaseInfo } from "@/lib/access/geo";
import { activeIpRules, clearAccessCache, sessionKey } from "@/lib/access/gate";
import { requestFacts } from "@/lib/access/request";
import { workspaceClock } from "@/lib/time/workspace";
import type { ActionResult } from "@/actions/company";

/**
 * Devices, networks and sign-ins — the screens behind Settings → Security.
 *
 * Three permissions, because they are three different trusts: `security.manage` writes the rules,
 * `access.approveDevices` works the approval queue, `access.viewSignIns` reads where people were.
 * Location is personal data about staff; being able to approve a laptop is not a reason to see
 * where its owner was on Tuesday.
 *
 * Every change clears the gate's cache, so it applies to the next request in this process.
 */

const REFRESH = "/settings/security/access";
/** A role key no role has: only the rules that apply to everybody match it. */
const EVERYBODY = "*";

async function standing(userId: string) {
  const [manage, approve, view] = await Promise.all([
    can(userId, "security.manage"),
    can(userId, "access.approveDevices"),
    can(userId, "access.viewSignIns"),
  ]);
  return { manage, approve, view };
}

/** Where the person asking is right now — for the checks that stop a rule locking its author out. */
async function hereAndNow(userId: string) {
  const facts = await requestFacts();
  const device = validDeviceToken(facts.deviceToken)
    ? await db.userDevice.findUnique({
        where: { userId_tokenHash: { userId, tokenHash: hashDeviceToken(facts.deviceToken) } },
        select: { status: true, locationSessionId: true },
      })
    : null;
  return { ip: normaliseIp(facts.ip), kind: deviceKindFrom(facts.userAgent, facts.mobileHint), device };
}

// ─── Overview ────────────────────────────────────────────────────────────────

export async function accessOverview() {
  const user = await requireUser();
  const s = await standing(user.id);
  if (!s.manage && !s.approve && !s.view) return null;
  const since = new Date(Date.now() - 24 * 3_600_000);
  const [pendingDevices, reviewNetworks, signInsToday, flaggedToday] = await Promise.all([
    db.userDevice.count({ where: { status: "PENDING", user: { active: true } } }),
    s.manage ? db.networkAddress.count({ where: { alertedAt: { not: null }, dismissedAt: null } }) : Promise.resolve(0),
    s.view ? db.signIn.count({ where: { at: { gte: since } } }) : Promise.resolve(0),
    s.view ? db.signIn.count({ where: { at: { gte: since }, flags: { isEmpty: false } } }) : Promise.resolve(0),
  ]);
  return toPlain({ can: s, pendingDevices, reviewNetworks, signInsToday, flaggedToday, geo: s.manage ? geoDatabaseInfo() : null });
}

// ─── Rules per role ──────────────────────────────────────────────────────────

export async function listRolePolicies() {
  const user = await requireUser();
  if (!(await can(user.id, "security.manage"))) return null;
  const [roles, policies, counts] = await Promise.all([
    db.role.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { key: true, name: true } }),
    db.roleAccessPolicy.findMany(),
    db.user.groupBy({ by: ["role"], where: { active: true }, _count: { _all: true } }),
  ]);
  const byRole = new Map(policies.map((p) => [p.roleKey, p]));
  const people = new Map(counts.map((c) => [c.role, c._count._all]));
  return roles.map((r) => {
    const p = byRole.get(r.key);
    const policy: RolePolicy = p
      ? { allowMobile: p.allowMobile, allowTablet: p.allowTablet, allowComputer: p.allowComputer, requireDeviceApproval: p.requireDeviceApproval, unknownNetwork: p.unknownNetwork, requireLocation: p.requireLocation }
      : OPEN_POLICY;
    return { roleKey: r.key, name: r.name, people: people.get(r.key) ?? 0, policy };
  });
}

const NETWORK_ACTIONS: UnknownNetworkAction[] = ["ALLOW", "ALERT", "HOLD", "BLOCK"];

export async function saveRolePolicy(roleKey: string, input: RolePolicy): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await can(user.id, "security.manage"))) return { ok: false, error: "You can't change the access rules." };
  const role = await db.role.findUnique({ where: { key: roleKey }, select: { key: true, name: true } });
  if (!role) return { ok: false, error: "That role no longer exists." };
  if (!NETWORK_ACTIONS.includes(input.unknownNetwork)) return { ok: false, error: "Pick what happens on an unknown network." };
  if (!input.allowMobile && !input.allowTablet && !input.allowComputer) {
    return { ok: false, error: "Allow at least one kind of device, or nobody on this role can use the app at all." };
  }
  const policy: RolePolicy = {
    allowMobile: input.allowMobile === true,
    allowTablet: input.allowTablet === true,
    allowComputer: input.allowComputer === true,
    requireDeviceApproval: input.requireDeviceApproval === true,
    unknownNetwork: input.unknownNetwork,
    requireLocation: input.requireLocation === true,
  };

  /**
   * The rule may not lock out the person writing it. The super admin is never held, so this is for
   * everybody else — tightening your own role from a device or a network it would then refuse
   * leaves nobody but the super admin able to undo it.
   */
  const me = await db.user.findUnique({ where: { id: user.id }, select: { role: true, isSuperAdmin: true } });
  if (me && me.role === roleKey && !me.isSuperAdmin) {
    const here = await hereAndNow(user.id);
    const verdict = decideAccess({
      sessionEnded: false,
      exempt: false,
      policy,
      network: networkStanding(here.ip, roleKey, await activeIpRules(), new Date()),
      device: { kind: here.kind, status: here.device?.status ?? null },
      // Location is asked for, not refused, so it cannot lock anybody out.
      locationShared: true,
    });
    if (!verdict.ok) {
      const why = {
        NETWORK_BLOCKED: "the network you're on is blocked",
        NETWORK_NOT_ALLOWED: "the network you're on has no allow rule",
        NETWORK_HELD: "the network you're on has no allow rule",
        DEVICE_KIND: "this kind of device would no longer be allowed",
        DEVICE_BLOCKED: "this device is blocked",
        DEVICE_PENDING: "this device hasn't been approved",
        SESSION_ENDED: "your session would end",
        LOCATION_NEEDED: "",
        // Not reachable: this preview passes no lock. Here so every reason has an answer.
        LOCKED: "your access is locked",
      }[verdict.reason];
      return { ok: false, error: `That would lock you out: you're on ${role.name} and ${why}. Fix that first, or have the super admin make the change.` };
    }
  }

  await db.roleAccessPolicy.upsert({
    where: { roleKey },
    create: { roleKey, ...policy, updatedById: user.id },
    update: { ...policy, updatedById: user.id },
  });
  clearAccessCache();
  await logActivity({
    kind: "SECURITY_POLICY_CHANGED",
    summary: `Access rules for ${role.name} changed: ${[
      [policy.allowMobile && "phones", policy.allowTablet && "tablets", policy.allowComputer && "computers"].filter(Boolean).join(", ") || "no devices",
      policy.requireDeviceApproval ? "devices need approval" : null,
      `unknown networks: ${policy.unknownNetwork.toLowerCase()}`,
      policy.requireLocation ? "location at sign-in" : null,
    ]
      .filter(Boolean)
      .join("; ")}`,
    metadata: { roleKey, ...policy },
  });
  revalidatePath(REFRESH);
  return { ok: true, data: null };
}

// ─── Network rules ───────────────────────────────────────────────────────────

export async function listIpRules() {
  const user = await requireUser();
  if (!(await can(user.id, "security.manage"))) return null;
  const rules = await db.ipRule.findMany({
    orderBy: [{ action: "asc" }, { createdAt: "desc" }],
    include: { createdBy: { select: { name: true } } },
  });
  const now = Date.now();
  const clock = await workspaceClock();
  return toPlain(
    rules.map((r) => ({
      ...r,
      expired: r.expiresAt !== null && r.expiresAt.getTime() <= now,
      // Stored as the midnight that ends the day, so the day shown is the one before it.
      untilText: r.expiresAt ? clock.date(new Date(r.expiresAt.getTime() - 1)) : null,
    })),
  );
}

export async function saveIpRule(input: {
  id?: string;
  cidr: string;
  action: IpRuleAction;
  label: string;
  roleKeys: string[];
  /** yyyy-mm-dd, a day on the workspace's clock, or blank. */
  expiresOn?: string | null;
}): Promise<ActionResult<{ id: string; cidr: string }>> {
  const user = await requireUser();
  if (!(await can(user.id, "security.manage"))) return { ok: false, error: "You can't change the network rules." };
  const cidr = parseCidr(input.cidr);
  if (!cidr) return { ok: false, error: "That isn't an address or a range. Try 203.0.113.7 or 203.0.113.0/24." };
  if (input.action !== "ALLOW" && input.action !== "BLOCK") return { ok: false, error: "Allow or block?" };
  const label = input.label.trim().slice(0, 120);
  if (!label) return { ok: false, error: "Give the rule a name — \"Pune office\", \"Home broadband\"." };
  // Allowing the whole internet (or most of it) makes every "unknown network" rule meaningless.
  if (input.action === "ALLOW" && cidr.prefix < (cidr.version === 4 ? 8 : 16)) {
    return { ok: false, error: `${cidr.text} covers ${cidrSize(cidr).toString()} addresses — far more than any office. Narrow it down.` };
  }
  const roleKeys = [...new Set(input.roleKeys)];
  if (roleKeys.length) {
    const found = await db.role.count({ where: { key: { in: roleKeys } } });
    if (found !== roleKeys.length) return { ok: false, error: "One of those roles no longer exists." };
  }
  let expiresAt: Date | null = null;
  if (input.expiresOn?.trim()) {
    expiresAt = (await workspaceClock()).endOfDay(input.expiresOn);
    if (!expiresAt || expiresAt.getTime() <= Date.now()) return { ok: false, error: "The end date has to be a day in the future." };
  }

  // A block that would take in the address the admin is on now, on their own role, is refused —
  // the same reason a role rule may not lock its author out.
  if (input.action === "BLOCK") {
    const me = await db.user.findUnique({ where: { id: user.id }, select: { role: true, isSuperAdmin: true } });
    const here = await hereAndNow(user.id);
    const trial = networkStanding(here.ip, me?.role ?? "", [{ cidr: cidr.text, action: "BLOCK", label, roleKeys, expiresAt }], new Date());
    if (me && !me.isSuperAdmin && trial.standing === "BLOCKED") {
      return { ok: false, error: `That would block the network you're on now (${here.ip}). You'd be signed out with no way back in.` };
    }
  }

  const data = { cidr: cidr.text, action: input.action, label, roleKeys, expiresAt };
  const saved = input.id
    ? await db.ipRule.update({ where: { id: input.id }, data, select: { id: true, cidr: true } })
    : await db.ipRule.create({ data: { ...data, createdById: user.id }, select: { id: true, cidr: true } });
  clearAccessCache();
  await logActivity({
    kind: "SECURITY_POLICY_CHANGED",
    summary: `${input.action === "ALLOW" ? "Allowed" : "Blocked"} ${cidr.text} (${label})${roleKeys.length ? ` for ${roleKeys.join(", ")}` : " for everybody"}`,
    metadata: { ruleId: saved.id, ...data, expiresAt: expiresAt?.toISOString() ?? null },
  });
  revalidatePath(REFRESH);
  return { ok: true, data: saved };
}

export async function deleteIpRule(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await can(user.id, "security.manage"))) return { ok: false, error: "You can't change the network rules." };
  const rule = await db.ipRule.findUnique({ where: { id } });
  if (!rule) return { ok: false, error: "That rule is already gone." };
  await db.ipRule.delete({ where: { id } });
  clearAccessCache();
  await logActivity({ kind: "SECURITY_POLICY_CHANGED", summary: `Removed the rule ${rule.action === "ALLOW" ? "allowing" : "blocking"} ${rule.cidr} (${rule.label})` });
  revalidatePath(REFRESH);
  return { ok: true, data: null };
}

// ─── Networks seen ───────────────────────────────────────────────────────────

/**
 * Every address a signed-in person has come from, with where it is and where it stands. "To review"
 * is the ones somebody was flagged or held on, that nobody has allowed, blocked or set aside.
 */
export async function listNetworks(params: { view?: string; q?: string; page?: number; pageSize?: number } = {}) {
  const user = await requireUser();
  if (!(await can(user.id, "security.manage"))) return null;
  const q = params.q?.trim();
  const where: Prisma.NetworkAddressWhereInput = {
    ...(params.view === "all" ? {} : { alertedAt: { not: null }, dismissedAt: null }),
    ...(q
      ? {
          OR: [
            { ip: { contains: q, mode: "insensitive" } },
            { city: { contains: q, mode: "insensitive" } },
            { country: { contains: q, mode: "insensitive" } },
            { lastUserName: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 50;
  const [rows, total, rules] = await Promise.all([
    db.networkAddress.findMany({ where, orderBy: { lastSeenAt: "desc" }, ...pageSlice(page, pageSize) }),
    db.networkAddress.count({ where }),
    activeIpRules(),
  ]);
  const now = new Date();
  return toPlain({
    total,
    rows: rows.map((r) => {
      // Stood against rules that apply to everybody: a role-specific rule is shown on the rule list.
      const s = networkStanding(r.ip, EVERYBODY, rules.filter((x) => x.roleKeys.length === 0), now);
      return { ...r, standing: s.standing, rule: s.rule };
    }),
  });
}

export async function allowNetwork(ip: string, label: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await can(user.id, "security.manage"))) return { ok: false, error: "You can't change the network rules." };
  const address = normaliseIp(ip);
  if (!address) return { ok: false, error: "That isn't an address." };
  const result = await saveIpRule({ cidr: address, action: "ALLOW", label: label.trim() || `Allowed from the review list`, roleKeys: [] });
  if (!result.ok) return result;
  await db.networkAddress.updateMany({ where: { ip: address }, data: { heldAt: null, dismissedAt: new Date() } });
  return { ok: true, data: null };
}

export async function blockNetwork(ip: string, label: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await can(user.id, "security.manage"))) return { ok: false, error: "You can't change the network rules." };
  const address = normaliseIp(ip);
  if (!address) return { ok: false, error: "That isn't an address." };
  const result = await saveIpRule({ cidr: address, action: "BLOCK", label: label.trim() || `Blocked from the review list`, roleKeys: [] });
  if (!result.ok) return result;
  await db.networkAddress.updateMany({ where: { ip: address }, data: { dismissedAt: new Date() } });
  return { ok: true, data: null };
}

/** Looked at, and left as it is. Somebody held on it stays held — dismissing is not allowing. */
export async function dismissNetwork(ip: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await can(user.id, "security.manage"))) return { ok: false, error: "You can't review networks." };
  await db.networkAddress.updateMany({ where: { ip }, data: { dismissedAt: new Date() } });
  revalidatePath(REFRESH);
  return { ok: true, data: null };
}

// ─── Devices ─────────────────────────────────────────────────────────────────

const deviceSelect = {
  id: true,
  kind: true,
  label: true,
  status: true,
  firstSeenAt: true,
  lastSeenAt: true,
  lastIp: true,
  lastPlace: true,
  decidedAt: true,
  decisionNote: true,
  userAgent: true,
  user: { select: { id: true, name: true, email: true, role: true, active: true } },
  decidedBy: { select: { name: true } },
} satisfies Prisma.UserDeviceSelect;

export async function listDevices(params: { status?: string; q?: string; page?: number; pageSize?: number } = {}) {
  const user = await requireUser();
  const s = await standing(user.id);
  if (!s.approve && !s.manage) return null;
  const statuses: DeviceStatus[] = ["PENDING", "APPROVED", "REJECTED", "REVOKED"];
  const status = statuses.includes(params.status as DeviceStatus) ? (params.status as DeviceStatus) : null;
  const q = params.q?.trim();
  const where: Prisma.UserDeviceWhereInput = {
    ...(status ? { status } : params.status === "auto" ? { status: "APPROVED", decidedById: null } : {}),
    ...(q
      ? {
          OR: [
            { label: { contains: q, mode: "insensitive" } },
            { user: { name: { contains: q, mode: "insensitive" } } },
            { user: { email: { contains: q, mode: "insensitive" } } },
            { lastPlace: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 50;
  const [rows, total] = await Promise.all([
    db.userDevice.findMany({ where, orderBy: [{ status: "asc" }, { lastSeenAt: "desc" }], select: deviceSelect, ...pageSlice(page, pageSize) }),
    db.userDevice.count({ where }),
  ]);
  return toPlain({ total, rows, me: user.id });
}

export async function decideDevice(
  deviceId: string,
  decision: "APPROVE" | "REJECT" | "REVOKE",
  note?: string,
): Promise<ActionResult<{ endedSessions: number }>> {
  const user = await requireUser();
  const s = await standing(user.id);
  if (!s.approve) return { ok: false, error: "You can't approve devices." };
  const device = await db.userDevice.findUnique({ where: { id: deviceId }, select: { id: true, userId: true, label: true, status: true, user: { select: { name: true } } } });
  if (!device) return { ok: false, error: "That device is no longer on the list." };
  // Separation of duties: approving your own device is the one decision this exists to take away.
  const me = await db.user.findUnique({ where: { id: user.id }, select: { isSuperAdmin: true } });
  if (device.userId === user.id && !me?.isSuperAdmin) return { ok: false, error: "Somebody else has to decide on your own devices." };

  const status: DeviceStatus = decision === "APPROVE" ? "APPROVED" : decision === "REJECT" ? "REJECTED" : "REVOKED";
  const now = new Date();
  await db.userDevice.update({ where: { id: deviceId }, data: { status, decidedById: user.id, decidedAt: now, decisionNote: note?.trim() || null } });

  // Revoking a device ends every session on it — it is the one way to end a session a stolen laptop
  // still holds.
  let endedSessions = 0;
  if (status !== "APPROVED") {
    const ended = await db.signIn.updateMany({ where: { deviceId, endedAt: null }, data: { endedAt: now, endedById: user.id } });
    endedSessions = ended.count;
  }
  clearAccessCache();

  await logActivity({
    kind: status === "APPROVED" ? "DEVICE_APPROVED" : "DEVICE_BLOCKED",
    summary: `${status === "APPROVED" ? "Approved" : status === "REJECTED" ? "Rejected" : "Revoked"} ${device.user.name}'s ${device.label}${endedSessions ? ` and ended ${endedSessions} session${endedSessions === 1 ? "" : "s"} on it` : ""}`,
    entityType: "UserDevice",
    entityId: deviceId,
    metadata: { owner: device.userId, note: note ?? null },
  });
  await notifyUser({
    userId: device.userId,
    type: "SECURITY_ALERT",
    title: status === "APPROVED" ? `Your ${device.label} was approved` : `Your ${device.label} was ${status === "REJECTED" ? "rejected" : "revoked"}`,
    message: status === "APPROVED" ? "You can use the app on it now." : "It can no longer be used to sign in. If that's a mistake, ask an administrator.",
    link: "/profile",
  });
  revalidatePath(REFRESH);
  return { ok: true, data: { endedSessions } };
}

// ─── Sign-ins ────────────────────────────────────────────────────────────────

const signInSelect = {
  id: true,
  at: true,
  lastSeenAt: true,
  provider: true,
  ip: true,
  deviceKind: true,
  city: true,
  region: true,
  country: true,
  countryCode: true,
  gpsLatitude: true,
  gpsLongitude: true,
  gpsAccuracyM: true,
  gpsAt: true,
  flags: true,
  endedAt: true,
  user: { select: { id: true, name: true, role: true } },
  device: { select: { id: true, label: true, status: true } },
  endedBy: { select: { name: true } },
} satisfies Prisma.SignInSelect;

export async function listSignIns(params: { userId?: string; flag?: string; q?: string; from?: string; to?: string; page?: number; pageSize?: number } = {}) {
  const user = await requireUser();
  if (!(await can(user.id, "access.viewSignIns"))) return null;
  const clock = await workspaceClock();
  const from = params.from ? clock.startOfDay(params.from) : null;
  const to = params.to ? clock.endOfDay(params.to) : null;
  const q = params.q?.trim();
  const where: Prisma.SignInWhereInput = {
    ...(params.userId ? { userId: params.userId } : {}),
    ...(params.flag === "flagged" ? { flags: { isEmpty: false } } : params.flag ? { flags: { has: params.flag } } : {}),
    ...(from || to ? { at: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
    ...(q
      ? {
          OR: [
            { ip: { contains: q, mode: "insensitive" } },
            { city: { contains: q, mode: "insensitive" } },
            { user: { name: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 50;
  const [rows, total] = await Promise.all([
    db.signIn.findMany({ where, orderBy: { at: "desc" }, select: signInSelect, ...pageSlice(page, pageSize) }),
    db.signIn.count({ where }),
  ]);
  // "Active": not ended, and seen in the last half hour.
  const activeSince = Date.now() - 30 * 60_000;
  return toPlain({
    total,
    rows: rows.map((r) => ({ ...r, active: !r.endedAt && r.lastSeenAt.getTime() > activeSince })),
    canEnd: await can(user.id, "security.manage"),
  });
}

export async function endSession(signInId: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const signIn = await db.signIn.findUnique({ where: { id: signInId }, select: { id: true, userId: true, endedAt: true, user: { select: { name: true } } } });
  if (!signIn) return { ok: false, error: "That sign-in is no longer on the list." };
  // Your own sessions are yours to end; anybody else's needs the security permission.
  if (signIn.userId !== user.id && !(await can(user.id, "security.manage"))) return { ok: false, error: "You can't end other people's sessions." };
  if (signIn.endedAt) return { ok: true, data: null };
  await db.signIn.update({ where: { id: signInId }, data: { endedAt: new Date(), endedById: user.id } });
  clearAccessCache();
  await logActivity({
    kind: "SESSION_ENDED",
    summary: signIn.userId === user.id ? `${signIn.user.name} ended one of their own sessions` : `Ended ${signIn.user.name}'s session`,
    entityType: "SignIn",
    entityId: signInId,
  });
  revalidatePath(REFRESH);
  revalidatePath("/profile");
  return { ok: true, data: null };
}

// ─── Your own ────────────────────────────────────────────────────────────────

/** What anybody can see about themselves: their devices, and where and when they signed in. */
export async function myAccess() {
  const user = await requireUser();
  const [devices, signIns] = await Promise.all([
    db.userDevice.findMany({
      where: { userId: user.id },
      orderBy: { lastSeenAt: "desc" },
      select: { id: true, kind: true, label: true, status: true, firstSeenAt: true, lastSeenAt: true, lastPlace: true },
    }),
    db.signIn.findMany({
      where: { userId: user.id },
      orderBy: { at: "desc" },
      take: 10,
      select: { id: true, sid: true, at: true, lastSeenAt: true, ip: true, city: true, region: true, country: true, gpsAt: true, endedAt: true, device: { select: { label: true } } },
    }),
  ]);
  const session = await (await import("@/lib/auth")).auth();
  const current = sessionKey(user.id, session?.user.sid ?? null);
  return toPlain({
    devices,
    signIns: signIns.map(({ sid, ...s }) => ({ ...s, current: sid === current })),
  });
}
