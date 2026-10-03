/**
 * check:time-zones — each workspace's clock, and the console's (owner, 2 Oct 2026; src/lib/time).
 *
 * The process runs in St John's — neither India nor UTC, half an hour off the hour, with daylight
 * saving — so nothing here can pass by leaning on the host's zone. It proves:
 *
 *   · the clock: India's reads every instant of a year exactly as src/lib/india-time.ts does; other zones
 *     keep their daylight saving — a skipped time moves forward over the gap, a repeated one is its first
 *     occurrence, a day is 23 or 25 hours long — and their odd offsets (Kathmandu, Chatham); typed times
 *     are read in the zone and shown back as typed; nonsense is refused; an unknown zone is India's;
 *   · the zones to choose from: every one the runtime knows, under today's names, found by country,
 *     west to east; every country starts in a zone of its own;
 *   · the workspace's setting: only with settings.manage; only a zone from the list, an old name taken
 *     under its new one; kept on the workspace in the control plane, where the registry hands it to
 *     every request; audited; refused for a workspace from the server's configuration;
 *   · the console's setting: owners only; stored, audited, and labelled in the audit log;
 *   · the screens: the Profile card and the console's panel; client components keep the zone they are
 *     handed, India's without one;
 *   · and nothing of the real workspace or control plane touched.
 *
 * It builds a scratch control plane and a scratch workspace beside the real ones, and drops both.
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import { renderHtml } from "./lib/render-html";
import { INDIA_ZONE, ZONE_ALIASES, clockFor, indiaClock, isTimeZone } from "../src/lib/time/zone";
import { COUNTRY_ZONES, defaultZoneFor, readTimeZone, zoneOptions } from "../src/lib/time/zones";
import { financialYearStartOf, financialYearWindow, previousIstMonth } from "../src/lib/india-time";
import { WORLD_COUNTRIES } from "../src/lib/geo/world-countries";

// Neither India nor UTC, half an hour off, with daylight saving: the host's zone must never matter.
process.env.TZ = "America/St_Johns";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : r.error);
const iso = (at: Date | null | undefined) => at?.toISOString() ?? null;
const ROOT = `${__dirname}/..`;

/**
 * India's calendar as src/lib/india-time.ts kept it before there were zones: a fixed +5:30, worked out
 * by hand. India's clock must read every instant the same way.
 */
const IST_MS = 5.5 * 3_600_000;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const two = (n: number) => String(n).padStart(2, "0");
const reference = {
  shifted: (at: Date) => new Date(at.getTime() + IST_MS),
  dateKey: (at: Date) => reference.shifted(at).toISOString().slice(0, 10),
  input: (at: Date) => reference.shifted(at).toISOString().slice(0, 16),
  calendarDate: (at: Date) => new Date(`${reference.dateKey(at)}T00:00:00.000Z`),
  midnight: (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d) - IST_MS),
  startOfDay: (key: string) => new Date(`${key}T00:00:00.000Z`).getTime() - IST_MS,
  parseInput: (v: string) => new Date(`${v}:00.000Z`).getTime() - IST_MS,
  month: (at: Date, offset: number) => {
    const s = reference.shifted(at);
    return { from: reference.midnight(s.getUTCFullYear(), s.getUTCMonth() + offset, 1), to: reference.midnight(s.getUTCFullYear(), s.getUTCMonth() + offset + 1, 1) };
  },
  words: (at: Date) => {
    const s = reference.shifted(at);
    const h = s.getUTCHours();
    return `${DOW[s.getUTCDay()]}, ${s.getUTCDate()} ${MON[s.getUTCMonth()]} ${s.getUTCFullYear()}, ${h % 12 === 0 ? 12 : h % 12}:${two(s.getUTCMinutes())} ${h < 12 ? "am" : "pm"}`;
  },
};

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

// ── Who is calling ─────────────────────────────────────────────────────────────────────────────────

let actor: { id: string; name: string; email: string; role: string } | null = null;
let staffActor: { id: string; email: string; name: string; role: "OWNER" | "ADMIN" | "SUPPORT" | "BILLING" | "READONLY" } | null = null;

const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
class UnauthorizedError extends Error {}
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
  UnauthorizedError,
};
class StaffRefused extends Error {}
const staffSession = {
  ...(load("../src/lib/platform/staff-session") as Record<string, unknown>),
  StaffRefused,
  // The console's frame asks who is signed in, through the second factor.
  currentStaffSession: async () => (staffActor ? { staff: staffActor, sessionId: "zz-session", mfaDone: true, enrolled: true, twoFactorRequired: false } : null),
  requireStaff: async (roles?: readonly string[]) => {
    if (!staffActor || (roles && !roles.includes(staffActor.role))) throw new StaffRefused("Only an owner can change that.");
    return staffActor;
  },
};
const navigation = {
  notFound: () => {
    throw new Error("NOT_FOUND_CALLED");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/settings/organisation",
  useSearchParams: () => new URLSearchParams(),
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/navigation", navigation],
  ["@/lib/session", session],
  ["@/lib/platform/staff-session", staffSession],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/navigation"), navigation],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("../src/lib/platform/staff-session"), staffSession],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (byName.has(request)) return byName.get(request);
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

const textOf = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");

// ── The clock, and the zones ────────────────────────────────────────────────────────────────────────

function clockChecks() {
  section("The process keeps St John's time");
  ok("half an hour off the hour, and not India's nor UTC", new Date("2026-07-01T12:00:00Z").getTimezoneOffset() === 150 && new Date("2026-01-01T12:00:00Z").getTimezoneOffset() === 210);

  section("India's clock, as it always was");
  let differ = 0;
  const firstDiffers: unknown[] = [];
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 3_600_000 * 7 + 60_000 * 13) {
    const at = new Date(t);
    const key = reference.dateKey(at);
    const typed = reference.input(at);
    const pairs: [string, unknown, unknown][] = [
      ["dateKey", indiaClock.dateKey(at), key],
      ["calendarDate", iso(indiaClock.calendarDate(at)), iso(reference.calendarDate(at))],
      ["input", indiaClock.input(at), typed],
      ["dateTime", indiaClock.dateTime(at), reference.words(at)],
      ["month", JSON.stringify(indiaClock.monthWindow(at, -1)), JSON.stringify(reference.month(at, -1))],
      ["startOfDay", indiaClock.startOfDay(key)?.getTime(), reference.startOfDay(key)],
      ["endOfDay", indiaClock.endOfDay(key)?.getTime(), reference.startOfDay(key) + 86_400_000],
      ["parseInput", indiaClock.parseInput(typed)?.getTime(), reference.parseInput(typed)],
    ];
    for (const [name, a, b] of pairs) {
      if (a === b) continue;
      differ += 1;
      if (firstDiffers.length < 3) firstDiffers.push({ name, a, b });
    }
  }
  ok("reads every instant of a year as India's fixed +5:30 always did — days, months, form values, words", differ === 0, firstDiffers.length ? firstDiffers : "");
  ok(
    "the statutory calendar stays India's: the financial year from 1 April, last month's return",
    financialYearStartOf(new Date("2026-03-31T18:29:00Z")) === 2025 &&
      financialYearStartOf(new Date("2026-03-31T18:30:00Z")) === 2026 &&
      iso(financialYearWindow(2026).from) === "2026-03-31T18:30:00.000Z" &&
      JSON.stringify(previousIstMonth(new Date("2026-09-30T18:30:00Z"))) === JSON.stringify({ month: 9, year: 2026 }),
  );

  section("Daylight saving");
  const ny = clockFor("America/New_York");
  const hours = (clock: ReturnType<typeof clockFor>, key: string) => ((clock.endOfDay(key)?.getTime() ?? 0) - (clock.startOfDay(key)?.getTime() ?? 0)) / 3_600_000;
  ok("New York: 2:30 am the night the clocks go forward doesn't exist — it is 3:30 am", iso(ny.parseInput("2026-03-08T02:30")) === "2026-03-08T07:30:00.000Z");
  ok("  1:30 am the night they go back happens twice — the first", iso(ny.parseInput("2026-11-01T01:30")) === "2026-11-01T05:30:00.000Z");
  ok("  those days are 23 hours and 25 hours long", hours(ny, "2026-03-08") === 23 && hours(ny, "2026-11-01") === 25, [hours(ny, "2026-03-08"), hours(ny, "2026-11-01")]);
  ok(
    "  a day is half-open: 11:59 pm is in it, the next midnight is not",
    ny.dateKey(new Date("2026-03-09T03:59:00Z")) === "2026-03-08" && ny.dateKey(new Date(ny.endOfDay("2026-03-08")!.getTime())) === "2026-03-09",
  );
  const march = ny.monthWindow(new Date("2026-03-15T12:00:00Z"));
  ok("  March there runs from midnight EST to midnight EDT", iso(march.from) === "2026-03-01T05:00:00.000Z" && iso(march.to) === "2026-04-01T04:00:00.000Z", march);
  const syd = clockFor("Australia/Sydney");
  ok(
    "Sydney, the other hemisphere: forward over the gap, the first of the repeated hour",
    iso(syd.parseInput("2026-10-04T02:30")) === "2026-10-03T16:30:00.000Z" && iso(syd.parseInput("2026-04-05T02:30")) === "2026-04-04T15:30:00.000Z",
  );
  ok(
    "odd offsets: Kathmandu is 5:45 ahead, Chatham 12:45 in its winter, St John's 2:30 behind in summer",
    clockFor("Asia/Kathmandu").offsetLabel() === "UTC+05:45" &&
      clockFor("Pacific/Chatham").offsetLabel(new Date("2026-07-01T00:00:00Z")) === "UTC+12:45" &&
      clockFor("America/St_Johns").offsetLabel(new Date("2026-07-01T00:00:00Z")) === "UTC-02:30",
  );

  section("Times typed and shown");
  const dubai = clockFor("Asia/Dubai");
  ok("a form's 3:00 pm is 3:00 pm in the workspace's zone, wherever the server is", iso(dubai.parseInput("2026-10-06T15:00")) === "2026-10-06T11:00:00.000Z");
  ok(
    "  what isn't a time is refused: 31 February, 24:00, a date alone, words",
    [dubai.parseInput("2026-02-31T10:00"), dubai.parseInput("2026-10-06T24:00"), dubai.parseInput("2026-10-06"), dubai.parseInput("tomorrow")].every((v) => v === null),
  );
  ok(
    "  a timestamp that states its zone is taken as it says; a bare one is the zone's",
    iso(dubai.parseTyped("2026-10-06T11:00:00.000Z")) === "2026-10-06T11:00:00.000Z" && iso(dubai.parseTyped("2026-10-06T15:00")) === "2026-10-06T11:00:00.000Z" && dubai.parseTyped("soon") === null,
  );
  const zones = ["Asia/Kolkata", "America/New_York", "Europe/London", "Australia/Sydney", "Asia/Kathmandu", "Pacific/Chatham", "America/St_Johns"];
  let roundTrip = true;
  for (const zone of zones) {
    const clock = clockFor(zone);
    for (let t = Date.UTC(2026, 0, 1, 0, 7); t < Date.UTC(2027, 0, 1); t += 3_600_000 * 11) {
      if (clock.parseInput(clock.input(new Date(t)))?.getTime() !== t) {
        // A repeated hour's second occurrence reads back as its first: that is the rule, not a fault.
        const back = clock.parseInput(clock.input(new Date(t)));
        if (!back || clock.input(back) !== clock.input(new Date(t))) roundTrip = false;
      }
    }
  }
  ok("  a time shown in a form reads back as itself, in every zone, all year", roundTrip);
  ok(
    "words spelled the same on any server and in any browser: Sep, not Sept, and no comma after the month",
    indiaClock.dateTime("2026-09-15T13:00:00Z") === "Tue, 15 Sep 2026, 6:30 pm" &&
      indiaClock.dateTimeShort("2026-09-15T13:00:00Z") === "15 Sep 2026, 6:30 pm" &&
      indiaClock.date("2026-09-15T13:00:00Z") === "15 Sep 2026" &&
      indiaClock.dayMonth("2026-09-15T13:00:00Z") === "15 Sep" &&
      indiaClock.time("2026-09-15T18:35:00Z") === "12:05 am" &&
      indiaClock.time("2026-09-15T06:35:00Z") === "12:05 pm",
    indiaClock.dateTime("2026-09-15T13:00:00Z"),
  );
  ok("  nothing, or what isn't a date, is a dash", indiaClock.dateTime(null) === "—" && indiaClock.date("not a date") === "—");
  ok("words in the zone: Dubai's 3:00 pm, which India's clock calls 4:30 pm", dubai.time("2026-10-06T11:00:00Z") === "3:00 pm" && indiaClock.time("2026-10-06T11:00:00Z") === "4:30 pm");
  ok("a zone nobody knows is India's, as before there was a choice", clockFor("Mars/Olympus").zone === INDIA_ZONE && clockFor(null).zone === INDIA_ZONE && clockFor("").zone === INDIA_ZONE);

  section("The zones to choose from");
  const options = zoneOptions(new Date("2026-10-02T00:00:00Z"));
  ok(
    "every zone the runtime knows, under today's names — Asia/Kolkata, never Asia/Calcutta",
    options.length > 300 && options.some((o) => o.zone === "Asia/Kolkata") && !options.some((o) => o.zone in ZONE_ALIASES) && options.every((o) => isTimeZone(o.zone)),
    options.length,
  );
  ok("  found by its country: India's says India, and its offset", options.find((o) => o.zone === "Asia/Kolkata")?.label === "Asia/Kolkata — India (UTC+05:30)");
  ok(
    "  west to east, with UTC among them",
    options.every((o, i) => i === 0 || options[i - 1]!.offsetMinutes <= o.offsetMinutes) && options.some((o) => o.zone === "UTC"),
  );
  ok(
    "a zone a person may choose: an old name under its new one; nonsense is not one",
    readTimeZone("Asia/Calcutta") === "Asia/Kolkata" && readTimeZone(" Asia/Dubai ") === "Asia/Dubai" && readTimeZone("Mars/Base") === null && readTimeZone(42) === null,
  );
  const missing = WORLD_COUNTRIES.filter((c) => !COUNTRY_ZONES[c.code] || !isTimeZone(defaultZoneFor(c.code))).map((c) => c.code);
  ok(
    "every country starts in a zone of its own — UTC where nobody lives, or for a country unknown",
    missing.length === 0 && defaultZoneFor("AE") === "Asia/Dubai" && defaultZoneFor("in") === "Asia/Kolkata" && defaultZoneFor("AQ") === "UTC" && defaultZoneFor("ZZ") === "UTC",
    missing,
  );
}

// ── The settings ────────────────────────────────────────────────────────────────────────────────────

async function main() {
  clockChecks();

  const realUrl = process.env.DATABASE_URL;
  const realControlUrl = process.env.CONTROL_DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);

  section("A scratch control plane and workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database server is a local one, so scratch databases may be made beside the real ones", local, host);
  if (!local) throw new Error("not a local database");
  const controlName = `${realName}_tzcheck_control`;
  const workspaceName = `${realName}_tzcheck`;
  const controlUrl = withDatabase(realUrl, controlName);
  const workspaceUrl = withDatabase(realUrl, workspaceName);

  const real = directClient(realUrl, { max: 1 });
  const realBefore = await snapshotWorkspace(real);
  const realControl = realControlUrl ? directClient(realControlUrl, { max: 1 }) : null;
  const realControlBefore = realControl ? await snapshotControl(realControl) : null;

  const admin = directClient(withDatabase(realUrl, "postgres"), { max: 1 });
  let close: (() => Promise<void>) | null = null;
  try {
    for (const name of [controlName, workspaceName]) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    }
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { cwd: ROOT, stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    execSync("npx prisma migrate deploy", { cwd: ROOT, stdio: "pipe", env: { ...process.env, DATABASE_URL: workspaceUrl }, timeout: 10 * 60_000 });
    ok("both built from their migrations", true);
    process.env.CONTROL_DATABASE_URL = controlUrl;
    process.env.DATABASE_URL = workspaceUrl;
    close = await run(workspaceUrl);
  } finally {
    await close?.().catch(() => {});
    for (const name of [controlName, workspaceName]) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    const gone = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname in ('${controlName}', '${workspaceName}')`);
    ok("the scratch databases are dropped", Number(gone[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  section("The real ones were not touched");
  ok("the real workspace has no time zone change of this suite's, nor its people", (await snapshotWorkspace(real)) === realBefore);
  await real.$disconnect();
  if (realControl) {
    ok("  nor the real control plane its workspaces' zones or the console's", (await snapshotControl(realControl)) === realControlBefore);
    await realControl.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} time zone checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** What this suite could wrongly write in the real workspace — narrow, since people may be using it meanwhile. */
async function snapshotWorkspace(client: PrismaClient): Promise<string> {
  const [audits, users] = await Promise.all([client.auditLog.count({ where: { entityId: "timezone" } }), client.user.count({ where: { email: { endsWith: "@zztz.example" } } })]);
  return JSON.stringify({ audits, users });
}

async function snapshotControl(client: PrismaClient): Promise<string> {
  const rows = await client.$queryRawUnsafe<{ zones: string | null; settings: string | null }[]>(
    `select (select string_agg(slug || '=' || timezone, ',' order by slug) from tenants)::text as zones, (select value from platform_settings where key = 'console.timezone')::text as settings`,
  );
  return JSON.stringify(rows[0] ?? null);
}

async function run(workspaceUrl: string): Promise<() => Promise<void>> {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
  const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
  const timeZone = require("../src/actions/time-zone") as typeof import("../src/actions/time-zone");
  const consoleTimeZone = require("../src/actions/platform/console-time-zone") as typeof import("../src/actions/platform/console-time-zone");
  const { consoleZone } = require("../src/lib/platform/console-clock") as typeof import("../src/lib/platform/console-clock");
  const { workspaceZone, clockOfTenant } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
  const { auditLabel, auditSummary } = require("../src/lib/console-shared/labels") as typeof import("../src/lib/console-shared/labels");
  const { ClockProvider, useClock } = require("../src/components/time/clock-provider") as typeof import("../src/components/time/clock-provider");
  const { TimeZoneCard } = require("../src/components/settings/time-zone-card") as typeof import("../src/components/settings/time-zone-card");
  const { ConsoleTimeZoneSetting } = require("../src/components/console/settings/time-zone-setting") as typeof import("../src/components/console/settings/time-zone-setting");
  const ConsoleLayout = (require("../src/app/platform-console/(console)/layout") as { default: (p: unknown) => Promise<unknown> }).default;
  type Tenant = import("../src/lib/tenancy/state").Tenant;
  /* eslint-enable @typescript-eslint/no-require-imports */

  const control = controlDb();
  const row = await control.tenant.create({
    data: { slug: "zztimezones", name: "Zz Time Zones", status: "ACTIVE", keyBundleCipher: "zz-never-opened", country: "IN", timezone: "Asia/Kolkata" },
    select: { id: true },
  });
  const tenant: Tenant = {
    id: row.id,
    slug: "zztimezones",
    name: "Zz Time Zones",
    status: "ACTIVE",
    dbUrl: workspaceUrl,
    primaryHost: "zztimezones.localhost",
    hosts: ["zztimezones.localhost"],
    source: "control",
    isDefault: false,
    keyBundleCipher: "zz-never-opened",
    country: "IN",
    timezone: "Asia/Kolkata",
    entitlements: { v: 1 as const, all: true, modules: [], seats: null, copilotTokens: null, customDomains: null, plans: [] },
    holdReason: null,
  };
  const zoneInRegistry = async () => {
    registry.forgetRegistry();
    return (await registry.activeTenants()).find((t) => t.id === row.id)?.timezone;
  };

  await runAsTenant(tenant, async () => {
    section("The workspace's time zone");
    const owner = await db.user.create({ data: { name: "Zz Owner", email: "owner@zztz.example", passwordHash: "!", role: "ADMIN", isSuperAdmin: true }, select: { id: true, name: true, email: true, role: true } });
    const rep = await db.user.create({ data: { name: "Zz Rep", email: "rep@zztz.example", passwordHash: "!", role: "SALES" }, select: { id: true, name: true, email: true, role: true } });

    ok("the registry hands every request the workspace's zone from the control plane", (await zoneInRegistry()) === "Asia/Kolkata");
    ok("  and a page asks it of the workspace it is in", (await workspaceZone()) === "Asia/Kolkata" && clockOfTenant({ timezone: "Asia/Dubai" }).zone === "Asia/Dubai" && clockOfTenant(null).zone === INDIA_ZONE);

    actor = rep;
    ok("someone without settings.manage can neither see nor change it", (await timeZone.getTimeZoneSetting()) === null && !(await timeZone.setWorkspaceTimeZone({ zone: "Asia/Dubai" })).ok);
    actor = owner;
    const setting = await timeZone.getTimeZoneSetting();
    ok("the owner sees it, the zones to choose from, and that it can be changed", setting?.zone === "Asia/Kolkata" && setting.changeable && setting.options.length > 300);
    const bogus = await timeZone.setWorkspaceTimeZone({ zone: "Mars/Base" });
    ok("  only a zone from the list", !bogus.ok && /Choose a time zone/.test(errorOf(bogus) ?? ""), errorOf(bogus));
    const oldName = await timeZone.setWorkspaceTimeZone({ zone: "Asia/Calcutta" });
    ok("  an old name is the zone it already has: nothing changes, nothing is logged", oldName.ok && (await db.auditLog.count({ where: { entityId: "timezone" } })) === 0);
    // A request finds its workspace through the registry's half-minute memory: India's is remembered now.
    const remembered = (await registry.tenantById(row.id))?.timezone;
    const newYork = await timeZone.setWorkspaceTimeZone({ zone: "America/New_York" });
    ok("New York chosen: kept on the workspace in the control plane", newYork.ok && (await control.tenant.findUniqueOrThrow({ where: { id: row.id }, select: { timezone: true } })).timezone === "America/New_York", errorOf(newYork));
    ok("  and every request has it at once — not India's for another half a minute", remembered === "Asia/Kolkata" && (await registry.tenantById(row.id))?.timezone === "America/New_York", remembered);
    const logged = await db.auditLog.findFirst({ where: { entityType: "OrganisationSettings", entityId: "timezone" }, select: { userId: true, entityLabel: true } });
    ok("  audited, from and to", logged?.userId === owner.id && /Asia\/Kolkata/.test(logged.entityLabel) && /America\/New York/.test(logged.entityLabel), logged?.entityLabel);
    const envTenant: Tenant = { ...tenant, source: "env" };
    const fromEnv = await runAsTenant(envTenant, async () => await timeZone.setWorkspaceTimeZone({ zone: "Asia/Dubai" }));
    ok("a workspace from the server's configuration keeps the zone set there", !fromEnv.ok && /server's configuration/.test(errorOf(fromEnv) ?? ""), errorOf(fromEnv));

    section("The screens");
    const card = renderToStaticMarkup(createElement(TimeZoneCard, { setting: setting! }));
    ok(
      "the Profile card: the zone by name and country, what it governs, and India's tax dates kept",
      card.includes('value="Asia/Kolkata — India (UTC+05:30)"') && textOf(card).includes("India's tax dates") && textOf(card).includes("Save time zone"),
    );
    ok("  the time there now is the browser's to say — the server renders without it", !textOf(card).includes("there now"));
    const at = "2026-10-06T11:00:00.000Z";
    const Shows = () => createElement("span", null, useClock().dateTime(at));
    const inDubai = renderToStaticMarkup(createElement(ClockProvider, { zone: "Asia/Dubai" }, createElement(Shows)));
    const unprovided = renderToStaticMarkup(createElement(Shows));
    ok("client components keep the zone they are handed — and India's without one", textOf(inDubai).includes("3:00 pm") && textOf(unprovided).includes("4:30 pm"), [textOf(inDubai), textOf(unprovided)]);
  });

  section("The console's time zone");
  ok("India's until an owner chooses", (await consoleZone()) === INDIA_ZONE);
  staffActor = { id: "zz-staff-admin", email: "admin@zztz.example", name: "Zz Admin", role: "ADMIN" };
  ok("an admin can't change it", !(await consoleTimeZone.consoleSetTimeZone("Asia/Dubai")).ok && (await consoleZone()) === INDIA_ZONE);
  staffActor = { id: "zz-staff-owner", email: "owner@zztz.example", name: "Zz Staff Owner", role: "OWNER" };
  const badZone = await consoleTimeZone.consoleSetTimeZone("Mars/Base");
  ok("  an owner only to a zone from the list", !badZone.ok && /Choose a time zone/.test(badZone.ok ? "" : badZone.error));
  const dubaiSet = await consoleTimeZone.consoleSetTimeZone("Asia/Dubai");
  ok("an owner sets it: stored for all staff", dubaiSet.ok && (await consoleZone()) === "Asia/Dubai");
  // Every client component in the console has its clock from the console's frame: a page in a probe's place.
  const ZoneProbe = () => createElement("output", null, `zone ${useClock().zone}`);
  const frame = await renderHtml(ConsoleLayout({ children: createElement(ZoneProbe), params: Promise.resolve({}) }));
  ok("  and the console's frame hands every client component Dubai's zone", frame.includes("zone Asia/Dubai"), (/zone [^<]*/.exec(frame) ?? ["(no probe)"])[0]);
  const consoleLog = await control.platformAuditLog.findFirst({ where: { action: "console.time-zone" }, select: { actor: true, detail: true } });
  ok(
    "  audited, and the audit log says it in words",
    consoleLog?.actor === "zz-staff-owner" &&
      auditLabel("console.time-zone", consoleLog.detail).title === "Console time zone changed" &&
      /Asia\/Kolkata/.test(auditSummary("console.time-zone", consoleLog.detail, indiaClock) ?? "") &&
      /Asia\/Dubai/.test(auditSummary("console.time-zone", consoleLog.detail, indiaClock) ?? ""),
    consoleLog ? auditSummary("console.time-zone", consoleLog.detail, indiaClock) : null,
  );
  const options = zoneOptions();
  const panel = renderToStaticMarkup(createElement(ConsoleTimeZoneSetting, { zone: "Asia/Dubai", options, change: null }));
  const readOnly = renderToStaticMarkup(createElement(ConsoleTimeZoneSetting, { zone: "Asia/Dubai", options, change: null, readOnly: true }));
  ok(
    "the console's panel: a picker and Save for an owner, the zone in words for everyone else",
    panel.includes('value="Asia/Dubai — United Arab Emirates (UTC+04:00)"') && textOf(panel).includes("Save") && textOf(readOnly).includes("Asia/Dubai — United Arab Emirates") && !textOf(readOnly).includes("Save"),
  );

  return async () => {
    await db.$disconnect().catch(() => {});
    await closeControlDb().catch(() => {});
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
