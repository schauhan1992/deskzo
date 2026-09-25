import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { impossibleTravel, networkStanding, type HoldReason } from "@/lib/access/decide";
import { deviceKindFrom } from "@/lib/access/device";
import { hashDeviceToken, validDeviceToken } from "@/lib/access/device-token";
import { lookupIp, placeText } from "@/lib/access/geo";
import { normaliseIp } from "@/lib/access/ip";
import { activeIpRules, alertHolders, clearAccessCache, evaluateAccess, rolePolicy, sessionKey, writeActivity } from "@/lib/access/gate";
import { requestFacts } from "@/lib/access/request";

/**
 * What happens at the moment of signing in: the door check, and the record of where from.
 *
 * Called from the auth configuration — the door check from `authorize` and the Microsoft `signIn`
 * callback, the record from the `jwt` callback, which is the one place that sees a sign-in *and*
 * can write into the session token. The sid it returns goes into the token, and is what lets one
 * session be ended, or its location asked for, without touching any other.
 */

/**
 * Refuses a sign-in from a network the person may not use at all — a block rule, or a role that
 * only allows approved networks. Everything else (a device awaiting approval, an unknown network
 * on a role that holds, location) is let through to the gate, which can explain itself on a page;
 * a refused sign-in can only say "no".
 */
export async function doorCheck(user: { id: string; role: string; isSuperAdmin: boolean }): Promise<HoldReason | null> {
  if (user.isSuperAdmin) return null;
  const facts = await requestFacts();
  const [rules, policy] = await Promise.all([activeIpRules(), rolePolicy(user.role)]);
  const network = networkStanding(normaliseIp(facts.ip), user.role, rules, new Date());
  if (network.standing === "BLOCKED") return "NETWORK_BLOCKED";
  if (network.standing === "UNKNOWN" && policy.unknownNetwork === "BLOCK") return "NETWORK_NOT_ALLOWED";
  return null;
}

export async function recordSignIn(input: { userId: string; provider: string }): Promise<string> {
  const sid = randomUUID();
  try {
    const facts = await requestFacts();
    const ip = normaliseIp(facts.ip);
    const geo = ip ? lookupIp(ip) : null;
    const user = await db.user.findUnique({ where: { id: input.userId }, select: { id: true, name: true, email: true } });
    if (!user) return sid;

    const tokenHash = validDeviceToken(facts.deviceToken) ? hashDeviceToken(facts.deviceToken) : null;
    const [deviceBefore, previous, usedNetworkBefore] = await Promise.all([
      tokenHash ? db.userDevice.findUnique({ where: { userId_tokenHash: { userId: user.id, tokenHash } }, select: { id: true } }) : null,
      db.signIn.findFirst({
        where: { userId: user.id, latitude: { not: null } },
        orderBy: { at: "desc" },
        select: { at: true, latitude: true, longitude: true, city: true, country: true },
      }),
      ip ? db.signIn.count({ where: { userId: user.id, ip } }) : Promise.resolve(1),
    ]);

    const now = new Date();
    const here = geo?.latitude !== null && geo?.latitude !== undefined && geo.longitude !== null ? { lat: geo.latitude, lng: geo.longitude, at: now } : null;
    const travel = here && previous?.latitude && previous.longitude
      ? impossibleTravel({ lat: Number(previous.latitude), lng: Number(previous.longitude), at: previous.at }, here)
      : null;

    const flags = [
      ...(!deviceBefore ? ["NEW_DEVICE"] : []),
      ...(ip && usedNetworkBefore === 0 ? ["NEW_NETWORK"] : []),
      ...(travel ? ["IMPOSSIBLE_TRAVEL"] : []),
    ];

    await db.signIn.create({
      data: {
        sid,
        userId: user.id,
        provider: input.provider,
        ip,
        userAgent: facts.userAgent?.slice(0, 500) ?? null,
        deviceKind: deviceKindFrom(facts.userAgent, facts.mobileHint),
        city: geo?.city ?? null,
        region: geo?.region ?? null,
        countryCode: geo?.countryCode ?? null,
        country: geo?.country ?? null,
        latitude: geo?.latitude ?? null,
        longitude: geo?.longitude ?? null,
        flags,
      },
    });

    // The gate registers the device and the network exactly as it would on the next page load,
    // and the sign-in is linked to the device it came from.
    const verdict = await evaluateAccess({ userId: user.id, sid, ip: facts.ip, userAgent: facts.userAgent, mobileHint: facts.mobileHint, deviceToken: facts.deviceToken, path: "/login" });
    if (verdict.deviceId) await db.signIn.update({ where: { sid }, data: { deviceId: verdict.deviceId } });

    if (travel && previous) {
      const from = placeText({ city: previous.city, region: null, country: previous.country }) ?? "one place";
      const to = placeText(geo) ?? "another";
      await writeActivity({
        kind: "IMPOSSIBLE_TRAVEL",
        summary: `${user.name} signed in from ${to}, ${travel.km} km from ${from} only ${travel.minutes} minutes earlier`,
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
        ip,
        userAgent: facts.userAgent,
        path: "/login",
        metadata: { km: travel.km, minutes: travel.minutes, sid },
      });
      await alertHolders("security.manage", {
        title: `Possible impossible travel: ${user.name}`,
        message: `Signed in from ${to}, ${travel.km} km from ${from} ${travel.minutes} minutes before. A VPN or mobile network can do this too — worth a look, not a verdict.`,
        link: "/settings/security/access?tab=sign-ins",
      });
    }
  } catch (err) {
    // A sign-in that works but is not recorded is bad; one that fails because the record could not
    // be written is worse. The sid still goes into the token.
    console.error("sign-in could not be recorded", err);
  }
  return sid;
}

/**
 * The browser's location, shared from the page that asked for it. Recorded against this sign-in and
 * this device, which is what satisfies a role that requires it — once per sign-in.
 */
export async function recordLocation(input: {
  userId: string;
  sid: string | null;
  latitude: number;
  longitude: number;
  accuracyM: number | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { latitude, longitude } = input;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return { ok: false, error: "That location didn't come through. Try again." };
  }
  // 0,0 is in the Gulf of Guinea, and it is what a broken sensor reports.
  if (latitude === 0 && longitude === 0) return { ok: false, error: "Your device couldn't work out where it is. Try again with location turned on." };

  const facts = await requestFacts();
  if (!validDeviceToken(facts.deviceToken)) return { ok: false, error: "This browser isn't set up yet. Reload the page and try again." };
  const device = await db.userDevice.findUnique({
    where: { userId_tokenHash: { userId: input.userId, tokenHash: hashDeviceToken(facts.deviceToken) } },
    select: { id: true },
  });
  if (!device) return { ok: false, error: "This browser isn't set up yet. Reload the page and try again." };

  const accuracy = input.accuracyM !== null && Number.isFinite(input.accuracyM) ? Math.max(0, Math.round(input.accuracyM)) : null;
  await db.userDevice.update({ where: { id: device.id }, data: { locationSessionId: sessionKey(input.userId, input.sid) } });
  if (input.sid) {
    await db.signIn.updateMany({
      where: { sid: input.sid, userId: input.userId },
      data: {
        gpsLatitude: Math.round(latitude * 1e6) / 1e6,
        gpsLongitude: Math.round(longitude * 1e6) / 1e6,
        gpsAccuracyM: accuracy,
        gpsAt: new Date(),
        deviceId: device.id,
      },
    });
  }
  clearAccessCache();
  return { ok: true };
}
