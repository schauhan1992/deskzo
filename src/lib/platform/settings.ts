import { controlDb } from "@/lib/platform/control-db";
import { openForPlatform, sealForPlatform } from "@/lib/platform/kek";

/**
 * The platform's own settings, set from the console (src/app/platform-console/(console)/settings and
 * billing) — and a few the platform keeps for itself, like when the daily billing work last ran.
 *
 * Secrets — the gateways' keys — are typed into the console, sealed under the platform key, and
 * never shown back: the console learns only whether one is set. Nothing here comes from the
 * environment, so a key is changed without a deploy and never sits in a file.
 */

export const SECRET_KEYS = ["stripe.secretKey", "stripe.webhookSecret", "razorpay.keyId", "razorpay.keySecret", "razorpay.webhookSecret"] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];
/**
 * `platform.lastTick`: what the platform tick did last, as JSON (src/lib/platform/tick-summary.ts).
 * `support.*`: Contact Support — typed, with their defaults, in src/lib/support/settings.ts.
 * `partners.*`: the partner programme — typed, with their defaults, in src/lib/partners/settings.ts.
 */
export const PLAIN_KEYS = [
  "signup.open",
  "trial.days",
  "billing.autoDeprovision",
  "billing.dailyRanOn",
  "staff.twoFactor",
  "platform.lastTick",
  "support.enabled",
  "support.email",
  "support.helpline",
  "support.hours",
  "support.recording",
  "support.retentionDays",
  "partners.twoFactor",
  "partners.statementDay",
  "partners.dealDays",
  "partners.refCookieDays",
  "partners.applications",
  "partners.directory",
  "partners.clawbackMonths",
  "partners.twoPersonPayout",
] as const;
export type PlainKey = (typeof PLAIN_KEYS)[number];

/** Whether a gateway's keys are its test or live ones — from the key's prefix; null when none is set. */
export type GatewayMode = "test" | "live" | "unknown" | null;
export type GatewayModes = { stripe: GatewayMode; razorpay: GatewayMode };

/** One setting as the console lists it: a secret only as set or not, a plain one with its value, and who changed it last. */
export type SettingRow = {
  key: SecretKey | PlainKey;
  kind: "secret" | "plain";
  set: boolean;
  value: string | null;
  updatedBy: string | null;
  /** The staff member's name, or `updatedBy` as it is ("tick", "check", "billing", a script). */
  updatedByName: string | null;
  updatedAt: Date | null;
};

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

/** A key's mode from its prefix. The key itself goes no further than this. */
function modeOf(sealed: string | null | undefined, test: RegExp, live: RegExp): GatewayMode {
  if (!sealed) return null;
  let key: string;
  try {
    key = openForPlatform("platform-setting", sealed).trim();
  } catch {
    return "unknown"; // Set, but not readable under this platform key.
  }
  return test.test(key) ? "test" : live.test(key) ? "live" : "unknown";
}

/**
 * Whether each gateway runs on its test keys or its live ones — Stripe from its secret key
 * (sk_/rk_ test or live), Razorpay from its key id (rzp_test_/rzp_live_). Only the mode leaves here.
 */
export async function gatewayModes(): Promise<GatewayModes> {
  const rows = await controlDb().platformSetting.findMany({ where: { key: { in: ["stripe.secretKey", "razorpay.keyId"] } }, select: { key: true, secretCipher: true } });
  const sealed = (key: SecretKey) => rows.find((r) => r.key === key)?.secretCipher;
  return {
    stripe: modeOf(sealed("stripe.secretKey"), /^(sk|rk)_test_/, /^(sk|rk)_live_/),
    razorpay: modeOf(sealed("razorpay.keyId"), /^rzp_test_/, /^rzp_live_/),
  };
}

/**
 * Every setting the platform has, each once and in a fixed order — unset ones included — for the
 * console's settings page. A secret is only "set" or not; nothing sealed leaves this function.
 */
export async function settingsOverview(): Promise<SettingRow[]> {
  const control = controlDb();
  const rows = await control.platformSetting.findMany({ select: { key: true, value: true, secretCipher: true, updatedBy: true, updatedAt: true } });
  const byKey = new Map(rows.map((r) => [r.key, { set: !!r.secretCipher, value: r.value, updatedBy: r.updatedBy, updatedAt: r.updatedAt }]));
  const ids = [...new Set(rows.map((r) => r.updatedBy).filter((by): by is string => !!by))];
  const staff = ids.length ? await control.platformUser.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const names = new Map(staff.map((s) => [s.id, s.name]));
  const row = (key: SecretKey | PlainKey, kind: SettingRow["kind"]): SettingRow => {
    const r = byKey.get(key);
    const updatedBy = r?.updatedBy ?? null;
    return {
      key,
      kind,
      set: kind === "secret" ? !!r?.set : r?.value !== null && r?.value !== undefined,
      value: kind === "plain" ? (r?.value ?? null) : null,
      updatedBy,
      updatedByName: updatedBy === null ? null : (names.get(updatedBy) ?? updatedBy),
      updatedAt: r?.updatedAt ?? null,
    };
  };
  return [...SECRET_KEYS.map((k) => row(k, "secret")), ...PLAIN_KEYS.map((k) => row(k, "plain"))];
}

/** What staff two-factor is when an owner has never said: required in production, optional elsewhere. */
export const staffTwoFactorDefault = (): "required" | "off" => (process.env.NODE_ENV === "production" ? "required" : "off");

/**
 * Whether staff use an authenticator to reach the console (src/lib/platform/staff-session.ts) —
 * "required" of everyone, or "off": a password alone for everyone, owners and whoever set one up
 * included (their authenticators are kept, for when it is required again). An owner chooses on the
 * console's Staff page; until then it follows the environment. "optional", stored before, meant off.
 */
export async function staffTwoFactorPolicy(): Promise<{ mode: "required" | "off"; chosen: boolean }> {
  const value = await getSetting("staff.twoFactor");
  if (value === "required") return { mode: "required", chosen: true };
  if (value === "off" || value === "optional") return { mode: "off", chosen: true };
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
