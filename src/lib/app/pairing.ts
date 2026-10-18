import { db } from "@/lib/db";
import { alertHolders, rolePolicy, writeActivity } from "@/lib/access/gate";
import { ApiError, personRefusal } from "@/lib/api/handler";
import { PHONE_REFUSALS } from "@/lib/app/handler";
import { digest, newPairingCode, newPhoneSecret, normalisePairingCode, PAIRING_MINUTES, phoneToken } from "@/lib/app/tokens";

/**
 * Pairing a phone with the Deskzo app (owner, 18 Oct 2026).
 *
 * Somebody signed in opens Settings › Deskzo app and asks for a code; the app scans it (or it is typed)
 * and sends it to /api/app/pair. The code is theirs alone, good for ten minutes and once, and its digest is
 * all that is kept. Using it makes the phone a device of theirs — a `UserDevice`, so it sits in Security ›
 * Devices beside their browsers: waiting for an administrator where their role admits only approved
 * devices, and revoked there like any other — with the app's own row beside it, and hands the phone its
 * token, once.
 */

/** Codes one person may have waiting at once — a page left open and asked again, not a flood. */
const MAX_WAITING_PER_PERSON = 3;

export async function startPairing(userId: string): Promise<{ id: string; code: string; expiresAt: Date }> {
  const now = new Date();
  await db.appPairing.deleteMany({ where: { userId, appDeviceId: null, expiresAt: { lt: now } } });
  const waiting = await db.appPairing.findMany({ where: { userId, appDeviceId: null }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (waiting.length >= MAX_WAITING_PER_PERSON) {
    await db.appPairing.deleteMany({ where: { id: { in: waiting.slice(0, waiting.length - MAX_WAITING_PER_PERSON + 1).map((w) => w.id) } } });
  }
  const code = newPairingCode();
  const expiresAt = new Date(now.getTime() + PAIRING_MINUTES * 60_000);
  const made = await db.appPairing.create({ data: { userId, codeHash: digest(code), expiresAt }, select: { id: true } });
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

export type PairInput = { code: unknown; platform: unknown; model?: unknown; appVersion?: unknown };

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
    select: { id: true, expiresAt: true, appDeviceId: true, user: { select: { id: true, name: true, email: true, role: true, isSuperAdmin: true, active: true, kind: true, lockedAt: true, lockedUntil: true } } },
  });
  const now = new Date();
  if (!pairing || pairing.appDeviceId || pairing.expiresAt <= now) throw WRONG;
  const user = pairing.user;

  // The person, where they are now — as at every call afterwards. The phone isn't approved yet: a role that
  // admits only approved devices gets it waiting for an administrator instead of refused.
  const refusal = await personRefusal(user, ip, true);
  if (refusal) throw new ApiError(403, "person_not_allowed", PHONE_REFUSALS[refusal]);
  const needsApproval = (await rolePolicy(user.role)).requireDeviceApproval && !user.isSuperAdmin;

  const model = clip(input.model, 80);
  const appVersion = clip(input.appVersion, 30);
  const secret = newPhoneSecret();
  const label = `Deskzo app on ${model ?? (platform === "ios" ? "an iPhone" : "an Android phone")}`;

  const made = await db.$transaction(async (tx) => {
    // Spent once: a second phone racing the same code finds it already taken.
    const claimed = await tx.appPairing.updateMany({ where: { id: pairing.id, appDeviceId: null, usedAt: null }, data: { usedAt: now } });
    if (claimed.count !== 1) return null;
    const device = await tx.userDevice.create({
      data: {
        userId: user.id,
        tokenHash: digest(secret),
        kind: "MOBILE",
        label,
        userAgent: `Deskzo app${appVersion ? ` ${appVersion}` : ""} (${platform})`,
        status: needsApproval ? "PENDING" : "APPROVED",
        lastIp: ip,
      },
      select: { id: true },
    });
    const phone = await tx.appDevice.create({ data: { deviceId: device.id, userId: user.id, platform, model, appVersion }, select: { id: true } });
    await tx.appPairing.update({ where: { id: pairing.id }, data: { appDeviceId: phone.id } });
    return { device, phone };
  });
  if (!made) throw WRONG;

  await writeActivity({
    kind: "NEW_DEVICE",
    severity: needsApproval ? "WARNING" : "INFO",
    summary: `${user.name} paired a phone: ${label}${needsApproval ? " — waiting for approval" : ""}`,
    userId: user.id,
    userName: user.name,
    userEmail: user.email,
    ip,
    userAgent: `Deskzo app (${platform})`,
    path: "/api/app/pair",
    metadata: { deviceId: made.device.id, appDeviceId: made.phone.id, kind: "MOBILE" },
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
