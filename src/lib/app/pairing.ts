import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { alertHolders, rolePolicy, writeActivity } from "@/lib/access/gate";
import { lookupIp } from "@/lib/access/geo";
import { ApiError, personRefusal } from "@/lib/api/handler";
import { appLocationKey, PHONE_REFUSALS } from "@/lib/app/handler";
import { digest, newPairingCode, newPhoneSecret, normalisePairingCode, PAIRING_MINUTES, phoneToken, verifierMatches } from "@/lib/app/tokens";

/**
 * Pairing a phone with the Deskzo app (owner, 18 Oct 2026).
 *
 * Somebody signed in opens Settings › Deskzo app and asks for a code; the app scans it (or it is typed)
 * and sends it to /api/app/pair. The code is theirs alone, good for ten minutes and once, and its digest is
 * all that is kept. Using it makes the phone a device of theirs — a `UserDevice`, so it sits in Security ›
 * Devices beside their browsers: waiting for an administrator where their role admits only approved
 * devices, and revoked there like any other — with the app's own row beside it, and hands the phone its
 * token, once.
 *
 * Or the person signs in through the phone's own browser (owner, 18 Oct 2026): the app opens
 * /app-sign-in/<phone|tablet>/<challenge> on the workspace, the web's sign-in runs with every rule it has —
 * two-factor, single sign-on, sign-in rules, the network and device rules — and the person's "Allow" makes a
 * code bound to the app's PKCE challenge, sent back to the app by a deskzo:// link. Only the app holding the
 * secret behind the challenge can spend it, so another app catching the link gets nothing.
 *
 * Either way the phone signs in as a phone or a tablet, which the person's role may not allow; shares where it
 * is when the role asks for that at every sign-in; and the sign-in is written to Security › Sign-ins.
 */

/** Codes one person may have waiting at once — a page left open and asked again, not a flood. */
const MAX_WAITING_PER_PERSON = 3;

export async function startPairing(userId: string, browser?: { challenge: string; minutes: number }): Promise<{ id: string; code: string; expiresAt: Date }> {
  const now = new Date();
  await db.appPairing.deleteMany({ where: { userId, appDeviceId: null, expiresAt: { lt: now } } });
  const waiting = await db.appPairing.findMany({ where: { userId, appDeviceId: null }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (waiting.length >= MAX_WAITING_PER_PERSON) {
    await db.appPairing.deleteMany({ where: { id: { in: waiting.slice(0, waiting.length - MAX_WAITING_PER_PERSON + 1).map((w) => w.id) } } });
  }
  const code = newPairingCode();
  const expiresAt = new Date(now.getTime() + (browser?.minutes ?? PAIRING_MINUTES) * 60_000);
  const made = await db.appPairing.create({ data: { userId, codeHash: digest(code), expiresAt, codeChallenge: browser?.challenge ?? null }, select: { id: true } });
  return { id: made.id, code, expiresAt };
}

/** Where a code one person asked for has got to — for the page showing it. */
export async function pairingState(userId: string, pairingId: string): Promise<{ state: "WAITING" | "EXPIRED" } | { state: "PAIRED"; phone: string; approved: boolean }> {
  const pairing = await db.appPairing.findFirst({ where: { id: pairingId, userId }, select: { expiresAt: true, appDeviceId: true } });
  if (!pairing) return { state: "EXPIRED" };
  if (pairing.appDeviceId) {
    const phone = await db.appDevice.findUnique({ where: { id: pairing.appDeviceId }, select: { model: true, platform: true, device: { select: { status: true } } } });
    if (phone) return { state: "PAIRED", phone: phone.model ?? phone.platform, approved: phone.device.status === "APPROVED" };
  }
  return pairing.expiresAt > new Date() ? { state: "WAITING" } : { state: "EXPIRED" };
}

export type PairInput = {
  code: unknown;
  platform: unknown;
  model?: unknown;
  appVersion?: unknown;
  /** The secret behind the challenge a browser sign-in's code was made for; nothing for a typed code. */
  verifier?: unknown;
  /** "tablet", or a phone. */
  formFactor?: unknown;
  /** Where the phone is — sent when the person's role asks for it at every sign-in. */
  location?: { latitude: number; longitude: number; accuracy: number | null } | null;
};

const clip = (value: unknown, max: number): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

/**
 * The phone's side: a code for a token. Throws an `ApiError` — the same one for a code that is wrong,
 * spent or out of date, so a guess learns nothing.
 */
export async function pairPhone(input: PairInput, ip: string | null): Promise<{ token: string; appDeviceId: string; approved: boolean; person: { name: string; email: string } }> {
  const code = normalisePairingCode(input.code);
  const platform = input.platform === "android" || input.platform === "ios" ? input.platform : null;
  if (!platform) throw new ApiError(400, "invalid_request", "Say which platform the phone is: android or ios.", { platform: "android or ios" });
  const WRONG = new ApiError(401, "wrong_code", "That code isn't right, or it has been used or run out. Ask for a new one in Settings › Deskzo app.");
  if (!code) throw WRONG;

  const pairing = await db.appPairing.findUnique({
    where: { codeHash: digest(code) },
    select: {
      id: true,
      expiresAt: true,
      appDeviceId: true,
      codeChallenge: true,
      user: { select: { id: true, name: true, email: true, role: true, isSuperAdmin: true, active: true, kind: true, lockedAt: true, lockedUntil: true } },
    },
  });
  const now = new Date();
  if (!pairing || pairing.appDeviceId || pairing.expiresAt <= now) throw WRONG;
  // A browser sign-in's code is spent only with the secret its challenge was made from.
  if (pairing.codeChallenge && !verifierMatches(input.verifier, pairing.codeChallenge)) throw WRONG;
  const user = pairing.user;
  const kind = input.formFactor === "tablet" ? "TABLET" : "MOBILE";
  const location = input.location ?? null;

  // The person, where they are now — as at every call afterwards. The phone isn't approved yet: a role that
  // admits only approved devices gets it waiting for an administrator instead of refused.
  const refusal = await personRefusal(user, ip, true, kind, !!location);
  // A role that asks where you are: the app asks the phone and tries again.
  if (refusal === "location") throw new ApiError(403, "location_needed", "Your company asks where you are when you sign in. Let the app share your location to carry on.");
  if (refusal) throw new ApiError(403, "person_not_allowed", PHONE_REFUSALS[refusal]);
  const needsApproval = (await rolePolicy(user.role)).requireDeviceApproval && !user.isSuperAdmin;

  const model = clip(input.model, 80);
  const appVersion = clip(input.appVersion, 30);
  // Two secrets: the phone's own, for /api/app; and its device row's, which only the in-app pages' device cookie
  // ever holds — made afresh each time they open (src/lib/app/web-session.ts), so this first one is never handed out.
  const secret = newPhoneSecret();
  const deviceSecret = newPhoneSecret();
  const what = kind === "TABLET" ? (platform === "ios" ? "an iPad" : "an Android tablet") : platform === "ios" ? "an iPhone" : "an Android phone";
  const label = `Deskzo app on ${model ?? what}`;

  const made = await db.$transaction(async (tx) => {
    // Spent once: a second phone racing the same code finds it already taken.
    const claimed = await tx.appPairing.updateMany({ where: { id: pairing.id, appDeviceId: null, usedAt: null }, data: { usedAt: now } });
    if (claimed.count !== 1) return null;
    const device = await tx.userDevice.create({
      data: {
        userId: user.id,
        tokenHash: digest(deviceSecret),
        kind,
        label,
        userAgent: `Deskzo app${appVersion ? ` ${appVersion}` : ""} (${platform})`,
        status: needsApproval ? "PENDING" : "APPROVED",
        lastIp: ip,
      },
      select: { id: true },
    });
    const phone = await tx.appDevice.create({ data: { deviceId: device.id, userId: user.id, platform, model, appVersion, secretDigest: digest(secret) }, select: { id: true } });
    await tx.appPairing.update({ where: { id: pairing.id }, data: { appDeviceId: phone.id } });
    // The location it shared is this sign-in's, as a browser's is its session's.
    if (location) await tx.userDevice.update({ where: { id: device.id }, data: { locationSessionId: appLocationKey(phone.id) } });
    return { device, phone };
  });
  if (!made) throw WRONG;

  // In Security › Sign-ins beside the browsers' — the network's place, and the phone's own when it shared one.
  const geo = ip ? lookupIp(ip) : null;
  await db.signIn
    .create({
      data: {
        sid: randomUUID(),
        userId: user.id,
        deviceId: made.device.id,
        provider: pairing.codeChallenge ? "app-browser" : "app-code",
        ip,
        userAgent: `Deskzo app${appVersion ? ` ${appVersion}` : ""} (${platform})`,
        deviceKind: kind,
        city: geo?.city ?? null,
        region: geo?.region ?? null,
        countryCode: geo?.countryCode ?? null,
        country: geo?.country ?? null,
        latitude: geo?.latitude ?? null,
        longitude: geo?.longitude ?? null,
        ...(location
          ? { gpsLatitude: Math.round(location.latitude * 1e6) / 1e6, gpsLongitude: Math.round(location.longitude * 1e6) / 1e6, gpsAccuracyM: location.accuracy, gpsAt: now }
          : {}),
        flags: ["NEW_DEVICE"],
      },
    })
    .catch((err) => console.error("[app] the sign-in could not be recorded", err));

  await writeActivity({
    kind: "NEW_DEVICE",
    severity: needsApproval ? "WARNING" : "INFO",
    summary: `${user.name} ${pairing.codeChallenge ? "signed in to" : "paired"} ${kind === "TABLET" ? "a tablet" : "a phone"}: ${label}${needsApproval ? " — waiting for approval" : ""}`,
    userId: user.id,
    userName: user.name,
    userEmail: user.email,
    ip,
    userAgent: `Deskzo app (${platform})`,
    path: "/api/app/pair",
    metadata: { deviceId: made.device.id, appDeviceId: made.phone.id, kind, via: pairing.codeChallenge ? "browser" : "code" },
  });
  if (needsApproval) {
    await alertHolders("access.approveDevices", {
      title: `${user.name} is waiting for a phone to be approved`,
      message: `${label}. They can't use the Deskzo app on it until it is approved.`,
      link: "/settings/security/access?tab=devices",
    });
  }

  return { token: phoneToken(made.phone.id, secret), appDeviceId: made.phone.id, approved: !needsApproval, person: { name: user.name, email: user.email } };
}

/**
 * A phone signed out — by its person, from the phone or from Settings, or by an administrator in Security ›
 * Devices (which revokes the device row, and that is all it takes). Its push address goes, and so do the
 * calls it was asked to make.
 */
export async function unpairPhone(appDeviceId: string, byUserId: string): Promise<void> {
  const phone = await db.appDevice.findUnique({ where: { id: appDeviceId }, select: { deviceId: true } });
  if (!phone) return;
  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.userDevice.update({ where: { id: phone.deviceId }, data: { status: "REVOKED", decidedById: byUserId, decidedAt: now, decisionNote: "Signed out of the Deskzo app" } });
    await tx.appDevice.update({ where: { id: appDeviceId }, data: { pushToken: null, callSync: false } });
    await tx.appCallRequest.updateMany({ where: { appDeviceId, status: { in: ["WAITING", "TAKEN"] } }, data: { status: "EXPIRED" } });
  });
}
