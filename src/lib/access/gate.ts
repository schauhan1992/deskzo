import type { ActivityKind, ActivitySeverity, DeviceKind, DeviceStatus, Prisma } from "@prisma/client";
import { tenantKey } from "@/lib/tenancy/cache";
import { currentTenant } from "@/lib/tenancy/resolve";
import { activeSupportGrant } from "@/lib/platform/support";
import { db } from "@/lib/db";
import { activityKind } from "@/lib/security/activity-kinds";
import { throttle } from "@/lib/security/throttle";
import { OPEN_POLICY, decideAccess, networkStanding, type HoldReason, type IpRuleLike, type RolePolicy, type Verdict } from "@/lib/access/decide";
import { deviceKindFrom, deviceLabel, DEVICE_KIND_LABEL } from "@/lib/access/device";
import { hashDeviceToken, validDeviceToken } from "@/lib/access/device-token";
import { lookupIp, placeText } from "@/lib/access/geo";
import { isPrivateIp, normaliseIp, parseIp } from "@/lib/access/ip";
import { companyLock, companyLockActive, forgetCompanyLock, personalLockActive } from "@/lib/access/lock";
import { isAutomationKind } from "@/lib/people";

/**
 * The access gate: may this signed-in request go on?
 *
 * Asked by the proxy for every page and action, and by `requireUser` for the API routes the proxy
 * does not see. The decision itself is `decideAccess` (pure); this gathers the facts for it — who,
 * which device, which network, which session — and does the bookkeeping that has to happen as
 * requests arrive: a browser seen for the first time becomes a device waiting for approval, an
 * address seen for the first time is recorded with where it is, and the people who need to know
 * are told once.
 *
 * ## Cached, and what that costs
 *
 * A verdict is kept for 20 seconds per person, session, device and address, so a page that fires
 * a dozen requests asks the database once. Approving, revoking or ending anything clears it at
 * once in this process. Across several server processes the others catch up within the 20
 * seconds — stated on the settings screen rather than left to be discovered.
 *
 * Writes nothing through `logActivity`: that module reaches the full auth configuration, which has
 * no business in the proxy. Rows are written directly, as the bot log does.
 */

export type GateInput = {
  userId: string;
  sid: string | null;
  deviceToken: string | null;
  ip: string | null;
  userAgent: string | null;
  mobileHint: string | null;
  path?: string | null;
};

export type GateVerdict = Verdict & { deviceId: string | null; deviceStatus: DeviceStatus | null; kind: DeviceKind };

const VERDICT_TTL_MS = 20_000;
// All four are per workspace: keyed by its id, because every workspace has its own users, rules and
// policies — and role keys ("SALES") and restored user ids are the same in many of them.
const verdicts = new Map<string, { verdict: GateVerdict; expiresAt: number }>();
const rulesCache = new Map<string, { rules: IpRuleLike[]; expiresAt: number }>();
const policyCache = new Map<string, { policy: RolePolicy; expiresAt: number }>();
/** Addresses whose sighting was recorded recently, so a busy page does not write a row per request. */
const seenRecently = new Map<string, number>();

/** After any change to devices, rules, policies or sessions. */
export function clearAccessCache() {
  verdicts.clear();
  rulesCache.clear();
  policyCache.clear();
  seenRecently.clear();
  forgetCompanyLock();
}

export async function activeIpRules(): Promise<IpRuleLike[]> {
  const key = await tenantKey();
  const hit = rulesCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.rules;
  const rules = await db.ipRule.findMany({
    where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    select: { id: true, cidr: true, action: true, label: true, roleKeys: true, expiresAt: true },
  });
  rulesCache.set(key, { rules, expiresAt: Date.now() + 15_000 });
  return rules;
}

export async function rolePolicy(roleKey: string): Promise<RolePolicy> {
  const key = `${await tenantKey()}|${roleKey}`;
  const hit = policyCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.policy;
  const row = await db.roleAccessPolicy.findUnique({ where: { roleKey } });
  const policy: RolePolicy = row
    ? {
        allowMobile: row.allowMobile,
        allowTablet: row.allowTablet,
        allowComputer: row.allowComputer,
        requireDeviceApproval: row.requireDeviceApproval,
        unknownNetwork: row.unknownNetwork,
        requireLocation: row.requireLocation,
      }
    : OPEN_POLICY;
  policyCache.set(key, { policy, expiresAt: Date.now() + 15_000 });
  return policy;
}

/** A session with no sid is one issued before sign-ins were recorded; it shares one key per person. */
export function sessionKey(userId: string, sid: string | null): string {
  return sid ?? `legacy:${userId}`;
}

// ─── Writing ─────────────────────────────────────────────────────────────────

export async function writeActivity(input: {
  kind: ActivityKind;
  summary: string;
  userId: string | null;
  userName?: string | null;
  userEmail?: string | null;
  severity?: ActivitySeverity;
  ip?: string | null;
  userAgent?: string | null;
  path?: string | null;
  metadata?: Prisma.InputJsonValue;
}) {
  try {
    await db.activityLog.create({
      data: {
        kind: input.kind,
        severity: input.severity ?? activityKind(input.kind).severity,
        summary: input.summary,
        userId: input.userId,
        userName: input.userName ?? null,
        userEmail: input.userEmail ?? null,
        ipAddress: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        path: input.path ?? null,
        metadata: input.metadata,
      },
    });
  } catch (err) {
    console.error("access activity could not be written", err);
  }
}

/**
 * Tells everybody who holds a permission. Resolved per person, so a personal grant or deny counts
 * exactly as it does everywhere else.
 */
export async function alertHolders(permission: string, alert: { title: string; message: string; link: string }) {
  try {
    const [{ can }, { notifyUser }] = await Promise.all([import("@/lib/authz/resolve"), import("@/lib/notify")]);
    const people = await db.user.findMany({ where: { active: true }, select: { id: true } });
    for (const person of people) {
      if (await can(person.id, permission)) {
        await notifyUser({ userId: person.id, type: "SECURITY_ALERT", ...alert });
      }
    }
  } catch (err) {
    console.error("access alert could not be sent", err);
  }
}

// ─── The gate ────────────────────────────────────────────────────────────────

export async function evaluateAccess(input: GateInput): Promise<GateVerdict> {
  const now = new Date();
  const token = validDeviceToken(input.deviceToken) ? input.deviceToken : null;
  const tokenHash = token ? hashDeviceToken(token) : null;
  const ip = normaliseIp(input.ip);
  const kind = deviceKindFrom(input.userAgent, input.mobileHint);
  const cacheKey = [await tenantKey(), input.userId, input.sid ?? "-", tokenHash ?? "-", ip ?? "-", kind].join("|");

  const cached = verdicts.get(cacheKey);
  if (cached && cached.expiresAt > now.getTime()) return cached.verdict;

  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { id: true, name: true, email: true, role: true, active: true, isSuperAdmin: true, lockedAt: true, lockedUntil: true, kind: true },
  });
  // The Automation account (src/lib/automation-user.ts) never has a session: whatever claims to be it
  // is ended here, before a device or a network is recorded for it.
  if (!user || isAutomationKind(user.kind)) {
    const verdict: GateVerdict = { ok: false, reason: "SESSION_ENDED", deviceId: null, deviceStatus: null, kind };
    verdicts.set(cacheKey, { verdict, expiresAt: now.getTime() + VERDICT_TTL_MS });
    return verdict;
  }

  const [policy, rules, existingDevice, signIn, company] = await Promise.all([
    rolePolicy(user.role),
    activeIpRules(),
    tokenHash ? db.userDevice.findUnique({ where: { userId_tokenHash: { userId: user.id, tokenHash } } }) : null,
    input.sid ? db.signIn.findUnique({ where: { sid: input.sid }, select: { id: true, endedAt: true, lastSeenAt: true, deviceId: true } }) : null,
    companyLock(),
  ]);
  const network = networkStanding(ip, user.role, rules, now);
  const geo = ip ? lookupIp(ip) : null;
  const place = placeText(geo);

  // A browser seen for the first time. Waiting for approval when the role asks for it; allowed
  // automatically otherwise, with nobody recorded as having decided — the list says so.
  let device = existingDevice;
  if (!device && tokenHash) {
    const needsApproval = policy.requireDeviceApproval && !user.isSuperAdmin;
    try {
      device = await db.userDevice.create({
        data: {
          userId: user.id,
          tokenHash,
          kind,
          label: deviceLabel(input.userAgent),
          userAgent: input.userAgent?.slice(0, 500) ?? null,
          status: needsApproval ? "PENDING" : "APPROVED",
          lastIp: ip,
          lastPlace: place,
        },
      });
      await writeActivity({
        kind: "NEW_DEVICE",
        severity: needsApproval ? "WARNING" : "INFO",
        summary: `${user.name} used a new device: ${device.label} (${DEVICE_KIND_LABEL[kind].toLowerCase()})${needsApproval ? " — waiting for approval" : ""}`,
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
        ip,
        userAgent: input.userAgent,
        path: input.path,
        metadata: { deviceId: device.id, kind, place },
      });
      if (needsApproval) {
        await alertHolders("access.approveDevices", {
          title: `${user.name} is waiting for a device to be approved`,
          message: `${device.label}${place ? `, from ${place}` : ""}. They can't use the app on it until it is approved.`,
          link: "/settings/security/access?tab=devices",
        });
      }
    } catch {
      // Two requests from a brand-new browser raced to create it; the other one won.
      device = await db.userDevice.findUnique({ where: { userId_tokenHash: { userId: user.id, tokenHash } } });
    }
  } else if (device && (device.lastIp !== ip || now.getTime() - device.lastSeenAt.getTime() > 5 * 60_000)) {
    await db.userDevice.update({ where: { id: device.id }, data: { lastSeenAt: now, lastIp: ip, lastPlace: place ?? device.lastPlace } }).catch(() => {});
  }

  if (signIn && (now.getTime() - signIn.lastSeenAt.getTime() > 5 * 60_000 || (!signIn.deviceId && device))) {
    await db.signIn.update({ where: { id: signIn.id }, data: { lastSeenAt: now, ...(device && !signIn.deviceId ? { deviceId: device.id } : {}) } }).catch(() => {});
  }

  if (ip) await noteNetwork({ ip, user, network, policy, geo, input });

  /**
   * Platform support is here on the super admin's grant and nothing else (src/lib/platform/support.ts):
   * no grant, no session — checked again within a minute. The grant is the approval, so a support
   * account is not held for a device or a network the way a member would be.
   */
  const support = user.kind === "SUPPORT";
  const supportGranted = support ? !!(await activeSupportGrant((await currentTenant()).id)) : true;
  const verdict = decideAccess({
    sessionEnded: !user.active || !!signIn?.endedAt || !supportGranted,
    exempt: user.isSuperAdmin || support,
    policy,
    network,
    device: { kind, status: device?.status ?? null },
    locationShared: !!device && device.locationSessionId === sessionKey(user.id, input.sid),
    locked: personalLockActive(user, now) || companyLockActive(company, now),
  });

  if (!verdict.ok) {
    const once = throttle(`${await tenantKey()}|access-held:${user.id}:${verdict.reason}`, 15 * 60_000);
    if (once.write) {
      await writeActivity({
        kind: "ACCESS_HELD",
        summary: `${user.name} was held: ${HOLD_SUMMARY[verdict.reason]}${place ? ` (from ${place})` : ""}`,
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
        ip,
        userAgent: input.userAgent,
        path: input.path,
        metadata: { reason: verdict.reason, rule: network.rule, deviceId: device?.id ?? null },
      });
    }
  }

  const result: GateVerdict = { ...verdict, deviceId: device?.id ?? null, deviceStatus: device?.status ?? null, kind };
  verdicts.set(cacheKey, { verdict: result, expiresAt: now.getTime() + VERDICT_TTL_MS });
  return result;
}

const HOLD_SUMMARY: Record<HoldReason, string> = {
  SESSION_ENDED: "the session was ended or the account is inactive",
  NETWORK_BLOCKED: "the network is blocked",
  NETWORK_NOT_ALLOWED: "their role only allows approved networks",
  NETWORK_HELD: "the network is waiting for approval",
  DEVICE_KIND: "their role may not use this kind of device",
  DEVICE_BLOCKED: "the device was blocked",
  DEVICE_PENDING: "the device is waiting for approval",
  LOCATION_NEEDED: "location not shared yet",
  LOCKED: "their access is locked by an administrator",
};

/**
 * Recording an address, once per ten minutes per process, and telling the security admins the first
 * time somebody arrives on an unknown one when their role asks to be told or to hold them.
 */
async function noteNetwork(args: {
  ip: string;
  user: { id: string; name: string; email: string; isSuperAdmin: boolean };
  network: { standing: string };
  policy: RolePolicy;
  geo: ReturnType<typeof lookupIp>;
  input: GateInput;
}) {
  const { ip, user, network, policy, geo } = args;
  const flagged = network.standing === "UNKNOWN" && !user.isSuperAdmin && (policy.unknownNetwork === "ALERT" || policy.unknownNetwork === "HOLD");
  // Keyed on whether it is flagged too, so a first arrival that needs telling about is not skipped
  // because somebody on an unflagged role came from the same address a minute earlier.
  const memo = `${await tenantKey()}|${flagged ? `${ip}#flag` : ip}`;
  const last = seenRecently.get(memo);
  if (last && Date.now() - last < 10 * 60_000) return;
  seenRecently.set(memo, Date.now());
  if (seenRecently.size > 5000) seenRecently.delete(seenRecently.keys().next().value!);

  const parsed = parseIp(ip);
  const row = await db.networkAddress
    .upsert({
      where: { ip },
      create: {
        ip,
        lastUserId: user.id,
        lastUserName: user.name,
        city: geo?.city ?? null,
        region: geo?.region ?? null,
        countryCode: geo?.countryCode ?? null,
        country: geo?.country ?? null,
        isPrivate: parsed ? isPrivateIp(parsed) : false,
      },
      update: { lastSeenAt: new Date(), lastUserId: user.id, lastUserName: user.name },
    })
    .catch(() => null);
  if (!row || !flagged || row.alertedAt) return;

  const held = policy.unknownNetwork === "HOLD";
  await db.networkAddress.update({ where: { ip }, data: { alertedAt: new Date(), ...(held ? { heldAt: new Date() } : {}) } }).catch(() => {});
  const place = placeText(geo);
  await writeActivity({
    kind: "NEW_NETWORK",
    severity: held ? "WARNING" : "NOTICE",
    summary: `${user.name} arrived from a network nobody has approved: ${ip}${place ? ` (${place})` : ""}${held ? " — held until it is allowed" : ""}`,
    userId: user.id,
    userName: user.name,
    userEmail: user.email,
    ip,
    userAgent: args.input.userAgent,
    path: args.input.path,
    metadata: { place, held },
  });
  await alertHolders("security.manage", {
    title: held ? `${user.name} is waiting on a new network` : `${user.name} signed in from a new network`,
    message: `${ip}${place ? `, ${place}` : ""}. ${held ? "They can't continue until the address is allowed." : "Allow or block it from the network list."}`,
    link: "/settings/security/access?tab=networks",
  });
}
