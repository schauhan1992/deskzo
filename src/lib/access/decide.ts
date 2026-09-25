import type { DeviceKind, DeviceStatus, IpRuleAction, UnknownNetworkAction } from "@prisma/client";
import { cidrContains, parseCidr, parseIp } from "@/lib/access/ip";

/**
 * Whether a signed-in request may proceed — the whole decision, without a database.
 *
 * Every page load and every action is asked this by the proxy (and, for the API routes the proxy
 * does not see, by `requireUser`), so it is small, pure and ordered. `check:access` holds each rule,
 * and the order between them, on its own.
 *
 * ## The order, and why
 *
 *   1. A session an admin ended, or an account since deactivated — nothing else matters.
 *   2. The super admin: never held. Somebody has to be able to get in to undo a rule that locked
 *      everybody else out, and every sign-in of theirs is still recorded.
 *   3. The network: a block rule, then the role's rule for addresses no allow rule covers.
 *   4. The device: a type the role may not use, then a device that was rejected or revoked, then
 *      one still waiting for approval.
 *   5. Location, last — asking somebody to share where they are from a device that is about to be
 *      turned away would be asking for nothing.
 */

export type RolePolicy = {
  allowMobile: boolean;
  allowTablet: boolean;
  allowComputer: boolean;
  requireDeviceApproval: boolean;
  unknownNetwork: UnknownNetworkAction;
  requireLocation: boolean;
};

/** A role with no policy row. Everything allowed, nothing asked. */
export const OPEN_POLICY: RolePolicy = {
  allowMobile: true,
  allowTablet: true,
  allowComputer: true,
  requireDeviceApproval: false,
  unknownNetwork: "ALLOW",
  requireLocation: false,
};

export function allowsKind(policy: RolePolicy, kind: DeviceKind): boolean {
  return kind === "MOBILE" ? policy.allowMobile : kind === "TABLET" ? policy.allowTablet : policy.allowComputer;
}

export type IpRuleLike = { id?: string; cidr: string; action: IpRuleAction; label: string; roleKeys: string[]; expiresAt: Date | string | null };

export type NetworkStanding = { standing: "ALLOWED" | "BLOCKED" | "UNKNOWN"; rule: string | null };

/**
 * Where an address stands for a role. A block beats an allow wherever both match — somebody who
 * blocks one address inside the office range means that address, whatever the range says.
 */
export function networkStanding(ip: string | null, roleKey: string, rules: IpRuleLike[], now: Date): NetworkStanding {
  const parsed = parseIp(ip);
  if (!parsed) return { standing: "UNKNOWN", rule: null };
  const live = rules.filter(
    (r) => (r.expiresAt === null || new Date(r.expiresAt).getTime() > now.getTime()) && (r.roleKeys.length === 0 || r.roleKeys.includes(roleKey)),
  );
  const matching = live.filter((r) => {
    const cidr = parseCidr(r.cidr);
    return cidr !== null && cidrContains(cidr, parsed);
  });
  const block = matching.find((r) => r.action === "BLOCK");
  if (block) return { standing: "BLOCKED", rule: block.label };
  const allow = matching.find((r) => r.action === "ALLOW");
  if (allow) return { standing: "ALLOWED", rule: allow.label };
  return { standing: "UNKNOWN", rule: null };
}

export type HoldReason =
  | "SESSION_ENDED"
  | "NETWORK_BLOCKED"
  | "NETWORK_NOT_ALLOWED"
  | "NETWORK_HELD"
  | "DEVICE_KIND"
  | "DEVICE_BLOCKED"
  | "DEVICE_PENDING"
  | "LOCATION_NEEDED"
  /** An administrator locked this person, or the whole company — src/lib/access/lock.ts. */
  | "LOCKED";

export type Verdict =
  | { ok: true; alertNewNetwork: boolean; exempt: boolean }
  | { ok: false; reason: HoldReason };

export type AccessFacts = {
  sessionEnded: boolean;
  exempt: boolean;
  policy: RolePolicy;
  network: NetworkStanding;
  device: { kind: DeviceKind; status: DeviceStatus | null };
  locationShared: boolean;
  /** Held by an administrator's lock — their own, or the company's. See src/lib/access/lock.ts. */
  locked?: boolean;
};

export function decideAccess(f: AccessFacts): Verdict {
  if (f.sessionEnded) return { ok: false, reason: "SESSION_ENDED" };
  if (f.exempt) return { ok: true, alertNewNetwork: false, exempt: true };
  // Before the network and device: a locked person is locked wherever they are and whatever they use.
  if (f.locked) return { ok: false, reason: "LOCKED" };

  if (f.network.standing === "BLOCKED") return { ok: false, reason: "NETWORK_BLOCKED" };
  const unknown = f.network.standing === "UNKNOWN";
  if (unknown && f.policy.unknownNetwork === "BLOCK") return { ok: false, reason: "NETWORK_NOT_ALLOWED" };
  if (unknown && f.policy.unknownNetwork === "HOLD") return { ok: false, reason: "NETWORK_HELD" };

  if (!allowsKind(f.policy, f.device.kind)) return { ok: false, reason: "DEVICE_KIND" };
  // A rejected or revoked device stays out whatever the role requires: revoking is how a session on
  // it is ended, and that has to work for roles that never asked for approval.
  if (f.device.status === "REJECTED" || f.device.status === "REVOKED") return { ok: false, reason: "DEVICE_BLOCKED" };
  if (f.policy.requireDeviceApproval && f.device.status !== "APPROVED") return { ok: false, reason: "DEVICE_PENDING" };

  if (f.policy.requireLocation && !f.locationShared) return { ok: false, reason: "LOCATION_NEEDED" };

  return { ok: true, alertNewNetwork: unknown && f.policy.unknownNetwork === "ALERT", exempt: false };
}

/** What the person being held is told. Written to them, not about them. */
export const HOLD_MESSAGE: Record<HoldReason, { title: string; body: string }> = {
  SESSION_ENDED: {
    title: "You've been signed out",
    body: "This session was ended — by an administrator, or because the account is no longer active. Sign in again to carry on.",
  },
  NETWORK_BLOCKED: {
    title: "This network is blocked",
    body: "Sign-ins from the network you're on aren't allowed. Try again from the office or another approved connection.",
  },
  NETWORK_NOT_ALLOWED: {
    title: "Not from this network",
    body: "Your role can only use the app from approved networks, such as the office. This one isn't on the list.",
  },
  NETWORK_HELD: {
    title: "Waiting for this network to be approved",
    body: "You're on a network nobody has approved yet. The administrators have been told; once they allow it, this page lets you in.",
  },
  DEVICE_KIND: {
    title: "Not on this kind of device",
    body: "Your role can't use the app on this type of device. Use one of the device types your administrator allows.",
  },
  DEVICE_BLOCKED: {
    title: "This device isn't allowed",
    body: "An administrator has blocked this device. If that's a mistake, ask them to approve it again.",
  },
  DEVICE_PENDING: {
    title: "Waiting for this device to be approved",
    body: "The first time you sign in on a device it needs an administrator's approval. They've been told; once it's approved, this page lets you in.",
  },
  LOCKED: {
    title: "Your access is locked",
    body: "An administrator has locked your access to the CRM. You can sign in, but nothing else until they lift it.",
  },
  LOCATION_NEEDED: {
    title: "Share your location to continue",
    body: "Your role records where you are when you sign in. Your browser will ask for permission — it's recorded once for this sign-in, not tracked afterwards.",
  },
};

// ─── Distance and travel ─────────────────────────────────────────────────────

export type Point = { lat: number; lng: number };

export function haversineKm(a: Point, b: Point): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Faster than an airliner, over a distance too long to be the location database's own error.
 *
 * City-level locations are wrong by a region at a time — mobile data surfaces in the operator's hub
 * city, a VPN surfaces wherever its server is — so anything under 500 km is not flagged at all, and
 * the flag says "worth a look", not "compromised".
 */
export const TRAVEL_MIN_KM = 500;
export const TRAVEL_MAX_KMH = 900;

export function impossibleTravel(
  previous: (Point & { at: Date }) | null,
  next: Point & { at: Date },
): { km: number; minutes: number } | null {
  if (!previous) return null;
  const km = haversineKm(previous, next);
  if (km < TRAVEL_MIN_KM) return null;
  const hours = Math.max((next.at.getTime() - previous.at.getTime()) / 3_600_000, 1 / 60);
  if (km / hours <= TRAVEL_MAX_KMH) return null;
  return { km: Math.round(km), minutes: Math.round(hours * 60) };
}
