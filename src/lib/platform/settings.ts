import { controlDb } from "@/lib/platform/control-db";
import { openForPlatform, sealForPlatform } from "@/lib/platform/kek";

/**
 * The platform's own settings, set from the console (src/app/platform-console/(console)/billing).
 *
 * Secrets — the gateways' keys — are typed into the console, sealed under the platform key, and
 * never shown back: the console learns only whether one is set. Nothing here comes from the
 * environment, so a key is changed without a deploy and never sits in a file.
 */

export const SECRET_KEYS = ["stripe.secretKey", "stripe.webhookSecret", "razorpay.keyId", "razorpay.keySecret", "razorpay.webhookSecret"] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];
export const PLAIN_KEYS = ["signup.open", "trial.days", "billing.autoDeprovision", "billing.dailyRanOn", "staff.twoFactor"] as const;
export type PlainKey = (typeof PLAIN_KEYS)[number];

export async function getSetting(key: PlainKey): Promise<string | null> {
  const row = await controlDb().platformSetting.findUnique({ where: { key }, select: { value: true } });
  return row?.value ?? null;
}

export async function setSetting(key: PlainKey, value: string | null, by: string): Promise<void> {
  await controlDb().platformSetting.upsert({ where: { key }, create: { key, value, updatedBy: by }, update: { value, updatedBy: by } });
}

export async function getSecret(key: SecretKey): Promise<string | null> {
  const row = await controlDb().platformSetting.findUnique({ where: { key }, select: { secretCipher: true } });
  return row?.secretCipher ? openForPlatform("platform-setting", row.secretCipher) : null;
}

/** Null removes it. */
export async function setSecret(key: SecretKey, value: string | null, by: string): Promise<void> {
  const secretCipher = value ? sealForPlatform("platform-setting", value) : null;
  await controlDb().platformSetting.upsert({ where: { key }, create: { key, secretCipher, updatedBy: by }, update: { secretCipher, updatedBy: by } });
}

/** Which secrets are set, and nothing about them. */
export async function secretsSet(): Promise<Record<SecretKey, boolean>> {
  const rows = await controlDb().platformSetting.findMany({ where: { key: { in: [...SECRET_KEYS] } }, select: { key: true, secretCipher: true } });
  return Object.fromEntries(SECRET_KEYS.map((k) => [k, rows.some((r) => r.key === k && !!r.secretCipher)])) as Record<SecretKey, boolean>;
}

/** What staff two-factor is when an owner has never said: required in production, optional elsewhere. */
export const staffTwoFactorDefault = (): "required" | "optional" => (process.env.NODE_ENV === "production" ? "required" : "optional");

/**
 * Whether every staff member must use an authenticator to reach the console (src/lib/platform/
 * staff-session.ts) — "required", or "optional": then only those who set one up are asked for it.
 * An owner chooses on the console's Staff page; until then it follows the environment.
 */
export async function staffTwoFactorPolicy(): Promise<{ mode: "required" | "optional"; chosen: boolean }> {
  const value = await getSetting("staff.twoFactor");
  if (value === "required" || value === "optional") return { mode: value, chosen: true };
  return { mode: staffTwoFactorDefault(), chosen: false };
}

/** Anybody may sign up, without an invitation. Off until billing can charge them. */
export async function signupOpen(): Promise<boolean> {
  return (await getSetting("signup.open")) === "1";
}

/** How long a new workspace's trial lasts. */
export async function trialDays(): Promise<number> {
  const n = Number(await getSetting("trial.days"));
  return Number.isInteger(n) && n >= 1 && n <= 90 ? n : 14;
}

/**
 * Whether a workspace whose subscription ended is closed on its own, ninety days after it was held.
 * Off unless staff turn it on: closing drops a database, and the platform should not start doing
 * that by itself until somebody has decided it should.
 */
export async function autoDeprovision(): Promise<boolean> {
  return (await getSetting("billing.autoDeprovision")) === "1";
}
