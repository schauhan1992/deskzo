import { redactSecrets } from "@/lib/console-shared/redact";
import { platformBrandName } from "@/lib/platform/brand";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { ConsoleRefused } from "@/lib/platform/refused";
import { setSetting, type PlainKey } from "@/lib/platform/settings";
import { HELPLINE_PATTERN, RETENTION_DAYS, SETTINGS_LIMITS, SUPPORT_EMAIL_PLACEHOLDER, type SupportSettingsView } from "@/lib/support/types";

/**
 * Contact Support's console settings, typed — platform settings (PLAIN_KEYS in
 * src/lib/platform/settings.ts), edited on the console's Settings page:
 *
 *   support.enabled        "1" / "0" — the button in every workspace. On unless switched off.
 *   support.email          where new requests are announced, and the Reply-To of every mail to a
 *                          requester. A placeholder until somebody sets the real one.
 *   support.helpline       shown in the dialog, with support.hours; neither shows when unset.
 *   support.hours
 *   support.recording      "1" / "0" — whether screen recording is offered at all. On unless switched off.
 *   support.retentionDays  how long after a request is closed its files are kept: 30–3650, 365 unless set.
 *
 * Two ways to read them: `getSupportSettings`, straight from the database (sending a request, the
 * console), and `cachedSupportConfig`, for the dashboard layout on every workspace page — one shared,
 * minute-long copy, given 1.5 s to load, and nothing (no button) for that minute when it can't be read.
 * Importing so little is deliberate, for the same reason as src/lib/platform/announcements.ts.
 */

// The constants a client form needs too live in the client-safe types file.
export { RETENTION_DAYS, SUPPORT_EMAIL_PLACEHOLDER };
export const SUPPORT_SETTING_KEYS = [
  "support.enabled",
  "support.email",
  "support.helpline",
  "support.hours",
  "support.recording",
  "support.retentionDays",
] as const satisfies readonly PlainKey[];
export type SupportSettingKey = (typeof SUPPORT_SETTING_KEYS)[number];

export type SupportSettings = SupportSettingsView;
/** The settings and the brand name the dialog shows: what every workspace page needs. */
export type SupportConfig = SupportSettings & { brandName: string };

export const SUPPORT_DEFAULTS: SupportSettings = {
  enabled: true,
  email: SUPPORT_EMAIL_PLACEHOLDER,
  helpline: null,
  hours: null,
  recording: true,
  retentionDays: RETENTION_DAYS.fallback,
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = HELPLINE_PATTERN;
const LIMITS = SETTINGS_LIMITS;

/** One line of text: control characters and the bidi overrides dropped, whitespace collapsed, trimmed. */
function line(value: unknown): string {
  if (typeof value !== "string") return "";
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const bad = code < 32 || code === 127 || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    out += bad ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

const chars = (s: string) => [...s].length;

/** Stored values → typed settings, the defaults where a value is missing or not one this would have saved. Pure. */
export function parseSupportSettings(values: Partial<Record<SupportSettingKey, string | null | undefined>>): SupportSettings {
  const email = line(values["support.email"]);
  const helpline = line(values["support.helpline"]);
  const hours = line(values["support.hours"]);
  const days = Number(values["support.retentionDays"]);
  return {
    enabled: values["support.enabled"] !== "0",
    email: email && chars(email) <= LIMITS.email && EMAIL.test(email) ? email : SUPPORT_EMAIL_PLACEHOLDER,
    helpline: helpline && chars(helpline) <= LIMITS.helpline ? helpline : null,
    hours: hours ? [...hours].slice(0, LIMITS.hours).join("") : null,
    recording: values["support.recording"] !== "0",
    retentionDays: Number.isInteger(days) && days >= RETENTION_DAYS.min && days <= RETENTION_DAYS.max ? days : RETENTION_DAYS.fallback,
  };
}

/** Straight from the control plane. Throws when it can't be read — callers that must not, catch. */
export async function getSupportSettings(): Promise<SupportSettings> {
  const rows = await controlDb().platformSetting.findMany({ where: { key: { in: [...SUPPORT_SETTING_KEYS] } }, select: { key: true, value: true } });
  return parseSupportSettings(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}

/**
 * The console's save, checked: a real email address, a helpline that looks like a phone number
 * (at most 30 characters), hours on one line (at most 80), retention 30–3650 whole days. Refuses
 * with ConsoleRefused, saying what to fix. Pure.
 */
export function validateSupportSettings(input: unknown): SupportSettings {
  if (!input || typeof input !== "object") throw new ConsoleRefused("Nothing to save.");
  const x = input as Record<string, unknown>;
  const email = line(x.email);
  if (!email) throw new ConsoleRefused("Give the support email address.");
  if (chars(email) > LIMITS.email || !EMAIL.test(email)) throw new ConsoleRefused("The support email isn't an email address.");
  const helpline = line(x.helpline);
  if (helpline && (chars(helpline) > LIMITS.helpline || !PHONE.test(helpline))) throw new ConsoleRefused("The helpline doesn't look like a phone number — digits, spaces, brackets, + and - only, at most 30.");
  const hours = line(x.hours);
  if (chars(hours) > LIMITS.hours) throw new ConsoleRefused(`Keep the hours to ${LIMITS.hours} characters.`);
  const days = typeof x.retentionDays === "number" ? x.retentionDays : typeof x.retentionDays === "string" && x.retentionDays.trim() ? Number(x.retentionDays.trim()) : NaN;
  if (!Number.isInteger(days) || days < RETENTION_DAYS.min || days > RETENTION_DAYS.max) {
    throw new ConsoleRefused(`Keep files for ${RETENTION_DAYS.min} to ${RETENTION_DAYS.max} days after a request is closed.`);
  }
  return { enabled: x.enabled === true, email, helpline: helpline || null, hours: hours || null, recording: x.recording === true, retentionDays: days };
}

/** Saves validated settings under the staff member's id, and forgets this process's cached copy. */
export async function saveSupportSettingsValues(values: SupportSettings, by: string): Promise<void> {
  const writes: [SupportSettingKey, string | null][] = [
    ["support.enabled", values.enabled ? "1" : "0"],
    ["support.email", values.email],
    ["support.helpline", values.helpline],
    ["support.hours", values.hours],
    ["support.recording", values.recording ? "1" : "0"],
    ["support.retentionDays", String(values.retentionDays)],
  ];
  for (const [key, value] of writes) await setSetting(key, value, by);
  forgetSupportSettings();
}

// ─── The workspace side's cached copy ────────────────────────────────────────────────────────────

const CACHE_MS = 60_000;
const LOAD_TIMEOUT_MS = 1_500;

/**
 * The platform's support settings and brand name — the same for every workspace, so one copy serves
 * them all. Null for a minute after they could not be read. This process's copy only: a save in the
 * console clears it here, and every other process follows within the minute.
 */
let cache: { at: number; config: SupportConfig | null } | null = null;

async function within(load: () => Promise<SupportConfig>): Promise<SupportConfig | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      // A loader that throws before returning a promise is caught here too.
      new Promise<SupportConfig>((resolve) => resolve(load())),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${LOAD_TIMEOUT_MS} ms`)), LOAD_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim().slice(0, 300);
    console.warn(`[support] could not read the support settings, so Contact Support is hidden for now: ${redactSecrets(message)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The settings and brand name for the dashboard layout: never throws, never waits more than 1.5 s,
 * and null — no button — without a control plane or while it can't be read. `load` replaces the
 * read, for a check suite's proof of the failing path; what it returns is never cached.
 */
export async function cachedSupportConfig(now: number = Date.now(), load?: () => Promise<SupportConfig>): Promise<SupportConfig | null> {
  try {
    if (!controlConfigured()) return null;
    if (load) return await within(load);
    if (cache && now >= cache.at && now - cache.at < CACHE_MS) return cache.config;
    // A failure is remembered as "nothing" for the same minute, so a control plane that is down is
    // asked once a minute, not on every page of every workspace.
    const config = await within(async () => {
      const [settings, brandName] = await Promise.all([getSupportSettings(), platformBrandName()]);
      return { ...settings, brandName };
    });
    cache = { at: now, config };
    return config;
  } catch {
    return null;
  }
}

/** Forget this process's copy — after a save in the console, and between a check suite's cases. */
export function forgetSupportSettings(): void {
  cache = null;
}
