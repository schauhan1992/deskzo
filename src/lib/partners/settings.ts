import { redactSecrets } from "@/lib/console-shared/redact";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { getSetting, setSetting, type PlainKey } from "@/lib/platform/settings";
import { PARTNER_SETTING_RANGES, PartnerRefused, type PartnerTwoFactorMode } from "@/lib/partners/types";

/**
 * The partner programme's settings, typed — platform settings (PLAIN_KEYS in
 * src/lib/platform/settings.ts), set by owners in the console's programme settings:
 *
 *   partners.twoFactor        "required" / "optional" — the portal's two-factor policy. Until an
 *                             owner chooses: required in production, optional elsewhere.
 *   partners.statementDay     the IST day of the month from which last month's statements are drafted: 1–28, 5.
 *   partners.dealDays         how long an approved deal registration is protected: 30–365 days, 90.
 *   partners.refCookieDays    the referral cookie's life on the public site: 0 (off) to 90 days, 0.
 *   partners.applications     "1" / "0" — the public "Become a partner" form takes applications. On.
 *   partners.directory        "1" / "0" — the public "Find a partner" page. Off.
 *   partners.clawbackMonths   a refund reverses a PAID commission only this many months after its
 *                             statement was paid: 1–60, 12 (owner decision O3).
 *   partners.twoPersonPayout  "1" / "0" — whoever approved a statement cannot also mark it paid (O4). Off.
 *
 * A stored value that is not one this file would have saved reads as the default, so a hand-edited
 * row can never switch something on by accident.
 */

export const PARTNER_SETTING_KEYS = [
  "partners.twoFactor",
  "partners.statementDay",
  "partners.dealDays",
  "partners.refCookieDays",
  "partners.applications",
  "partners.directory",
  "partners.clawbackMonths",
  "partners.twoPersonPayout",
] as const satisfies readonly PlainKey[];
export type PartnerSettingKey = (typeof PARTNER_SETTING_KEYS)[number];

export type PartnerSettings = {
  /** What the portal asks for now. */
  twoFactor: PartnerTwoFactorMode;
  /** An owner chose it; false: it follows the environment (required in production). */
  twoFactorChosen: boolean;
  statementDay: number;
  dealDays: number;
  refCookieDays: number;
  applications: boolean;
  directory: boolean;
  clawbackMonths: number;
  twoPersonPayout: boolean;
};

/** What the console's save sends: any of the settings, as typed or as strings. Missing ones stay as they are. */
export type PartnerSettingsInput = Partial<Record<Exclude<keyof PartnerSettings, "twoFactorChosen">, unknown>>;

const R = PARTNER_SETTING_RANGES;

/** What partner two-factor is until an owner chooses: required in production, optional elsewhere. */
export const partnerTwoFactorDefault = (): PartnerTwoFactorMode => (process.env.NODE_ENV === "production" ? "required" : "optional");

function wholeIn(raw: string | null | undefined, range: { min: number; max: number; fallback: number }): number {
  const text = (raw ?? "").trim();
  const n = /^\d{1,4}$/.test(text) ? Number(text) : NaN;
  return Number.isInteger(n) && n >= range.min && n <= range.max ? n : range.fallback;
}

/** Stored values → typed settings, the defaults where a value is missing or not one this file would have saved. Pure. */
export function parsePartnerSettings(values: Partial<Record<PartnerSettingKey, string | null | undefined>>): PartnerSettings {
  const mode = values["partners.twoFactor"];
  const chosen = mode === "required" || mode === "optional";
  return {
    twoFactor: chosen ? mode : partnerTwoFactorDefault(),
    twoFactorChosen: chosen,
    statementDay: wholeIn(values["partners.statementDay"], R.statementDay),
    dealDays: wholeIn(values["partners.dealDays"], R.dealDays),
    refCookieDays: wholeIn(values["partners.refCookieDays"], R.refCookieDays),
    applications: values["partners.applications"] !== "0",
    directory: values["partners.directory"] === "1",
    clawbackMonths: wholeIn(values["partners.clawbackMonths"], R.clawbackMonths),
    twoPersonPayout: values["partners.twoPersonPayout"] === "1",
  };
}

/** Every programme setting, straight from the control plane. */
export async function partnerSettings(): Promise<PartnerSettings> {
  const rows = await controlDb().platformSetting.findMany({ where: { key: { in: [...PARTNER_SETTING_KEYS] } }, select: { key: true, value: true } });
  return parsePartnerSettings(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}

/** One key read, the rest defaulted — for the getters below, which each need only theirs. */
async function one(key: PartnerSettingKey): Promise<PartnerSettings> {
  return parsePartnerSettings({ [key]: await getSetting(key) });
}

/** The portal's two-factor policy, read on every request so a change applies at once. */
export async function partnerTwoFactorPolicy(): Promise<{ mode: PartnerTwoFactorMode; chosen: boolean }> {
  const s = await one("partners.twoFactor");
  return { mode: s.twoFactor, chosen: s.twoFactorChosen };
}

/** The IST day of the month from which the tick drafts last month's statements. */
export async function statementDay(): Promise<number> {
  return (await one("partners.statementDay")).statementDay;
}

/** How many days an approved deal registration is protected. */
export async function dealDays(): Promise<number> {
  return (await one("partners.dealDays")).dealDays;
}

/** Whether the public "Become a partner" page takes applications. */
export async function applicationsOpen(): Promise<boolean> {
  return (await one("partners.applications")).applications;
}

/** Whether the public "Find a partner" directory is shown. */
export async function directoryOpen(): Promise<boolean> {
  return (await one("partners.directory")).directory;
}

/** How many calendar months after its statement was paid a PAID commission can still be clawed back by a refund. */
export async function clawbackMonths(): Promise<number> {
  return (await one("partners.clawbackMonths")).clawbackMonths;
}

/** Whether a statement must be marked paid by somebody other than whoever approved it. */
export async function twoPersonPayout(): Promise<boolean> {
  return (await one("partners.twoPersonPayout")).twoPersonPayout;
}

// ─── Saving ──────────────────────────────────────────────────────────────────────────────────────

function wholeInput(raw: unknown, range: { min: number; max: number }, refusal: string): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*\d{1,4}\s*$/.test(raw) ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(n) || n < range.min || n > range.max) throw new PartnerRefused(refusal);
  return n;
}

function switchInput(raw: unknown, refusal: string): boolean {
  if (raw === true || raw === "1" || raw === "true" || raw === "on") return true;
  if (raw === false || raw === "0" || raw === "false" || raw === "off") return false;
  throw new PartnerRefused(refusal);
}

/**
 * The console's save (OWNERS), checked value by value, writing only what changed from what is in
 * force now — under the staff member's id. Refuses with PartnerRefused, saying what to fix; nothing
 * is written unless every given value is good. The caller writes the platform audit (it knows who,
 * and gets the changed keys back to say what).
 */
export async function setPartnerSettings(input: PartnerSettingsInput, staffId: string): Promise<{ changed: PartnerSettingKey[]; settings: PartnerSettings }> {
  if (!input || typeof input !== "object") throw new PartnerRefused("Nothing to save.");
  const by = String(staffId ?? "").slice(0, 60);
  if (!by) throw new PartnerRefused("Nothing to save.");
  const x = input as Record<string, unknown>;
  const writes: [PartnerSettingKey, string][] = [];
  const current = await partnerSettings();

  if (x.twoFactor !== undefined) {
    if (x.twoFactor !== "required" && x.twoFactor !== "optional") throw new PartnerRefused("Partner two-factor is either required or optional.");
    if (x.twoFactor !== current.twoFactor) writes.push(["partners.twoFactor", x.twoFactor]);
  }
  const whole: [keyof typeof R, PartnerSettingKey, string][] = [
    ["statementDay", "partners.statementDay", `Statements are drafted on a day from ${R.statementDay.min} to ${R.statementDay.max} of the month.`],
    ["dealDays", "partners.dealDays", `Deal registrations are protected for ${R.dealDays.min} to ${R.dealDays.max} days.`],
    ["refCookieDays", "partners.refCookieDays", `The referral cookie lasts ${R.refCookieDays.min} (off) to ${R.refCookieDays.max} days.`],
    ["clawbackMonths", "partners.clawbackMonths", `Refunds are clawed back within ${R.clawbackMonths.min} to ${R.clawbackMonths.max} months of the payout.`],
  ];
  for (const [field, key, refusal] of whole) {
    if (x[field] === undefined) continue;
    const n = wholeInput(x[field], R[field], refusal);
    if (n !== current[field]) writes.push([key, String(n)]);
  }
  const switches: ["applications" | "directory" | "twoPersonPayout", PartnerSettingKey, string][] = [
    ["applications", "partners.applications", "Partner applications are either open or closed."],
    ["directory", "partners.directory", "The partner directory is either shown or not."],
    ["twoPersonPayout", "partners.twoPersonPayout", "The two-person payout rule is either on or off."],
  ];
  for (const [field, key, refusal] of switches) {
    if (x[field] === undefined) continue;
    const on = switchInput(x[field], refusal);
    if (on !== current[field]) writes.push([key, on ? "1" : "0"]);
  }

  for (const [key, value] of writes) await setSetting(key, value, by);
  if (writes.some(([key]) => key === "partners.refCookieDays")) forgetPartnerSettings();
  return { changed: writes.map(([key]) => key), settings: writes.length ? await partnerSettings() : current };
}

// ─── The proxy's cached copy of the referral cookie's life ───────────────────────────────────────

const CACHE_MS = 60_000;
const LOAD_TIMEOUT_MS = 1_500;

/**
 * `partners.refCookieDays`, as the proxy last read it — the same for every visitor and every
 * workspace, and no workspace's data. This process's copy only: a save in the console clears it
 * here, and every other process follows within the minute.
 */
let referralCookieCache: { at: number; days: number } | null = null;

async function readReferralCookieDays(): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      // A read that throws before returning a promise is caught here too.
      new Promise<number>((resolve) => resolve(one("partners.refCookieDays").then((s) => s.refCookieDays))),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${LOAD_TIMEOUT_MS} ms`)), LOAD_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim().slice(0, 300);
    console.warn(`[partners] could not read the referral cookie setting, so no referral cookie is set for now: ${redactSecrets(message)}`);
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How many days the public site's referral cookie lasts; 0 is off (the default — spec D8). For the
 * proxy, on a public-host GET that carries `?ref=`: cached for a minute, never throws, never waits
 * more than 1.5 s, and 0 for that minute when the setting can't be read.
 */
export async function referralCookieDays(now: number = Date.now()): Promise<number> {
  try {
    if (!controlConfigured()) return 0;
    if (referralCookieCache && now >= referralCookieCache.at && now - referralCookieCache.at < CACHE_MS) return referralCookieCache.days;
    const days = await readReferralCookieDays();
    referralCookieCache = { at: now, days };
    return days;
  } catch {
    return 0;
  }
}

/** Forget this process's copy — after a save in the console, and between a check suite's cases. */
export function forgetPartnerSettings(): void {
  referralCookieCache = null;
}
