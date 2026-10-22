/**
 * check:geo-attendance — GPS attendance with administrator exceptions (owner, 22 Oct 2026; src/lib/hr/geofence.ts,
 * src/lib/hr/clock.ts, src/actions/attendance-exceptions.ts).
 *
 *   · Without a database: the geofence's sums and rules — distances, the radius's edge, accuracy, a simulated
 *     location, what a phone may send, what an administrator may type.
 *   · Against this workspace's database, through the app's real routes and the web's real actions:
 *       - an office that checks location: inside clocks in and out, recorded as INSIDE with its distance; outside,
 *         no location, a vague or simulated one, or one that isn't a place is refused and writes nothing;
 *       - the day's own rules come first, as they always did, and clocking out twice is now refused too;
 *       - exceptions: asked for from the phone, never decided, granted or revoked by the person themselves or by
 *         somebody without the permission; approved, it lets one clocking through, marked EXCEPTION, once —
 *         used, expired or revoked, it doesn't; an office that doesn't allow them refuses the asking;
 *       - an office that doesn't check, as before; one that checks with no point set refuses with "not configured";
 *       - two taps at once are one clocking; the app is never told the office's point.
 *
 * Everything is named ZZGEO and removed at the end — the offices too; no existing office is changed.
 *
 *   npm run check:geo-attendance
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";
import {
  ACCURACY_LIMITS,
  RADIUS_LIMITS,
  checkGeofence,
  distanceMetres,
  readOfficeLocation,
  readReading,
  type Office,
} from "../src/lib/hr/geofence";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
process.env.TRUST_PROXY = "1";
process.env.DESKZO_APP = "on";

const TAG = "ZZGEO";
const MAIL = "@zzgeo.invalid";
const requestHeaders = new Headers({ host: "deskzo.localhost:3000", "user-agent": "check:geo-attendance", "x-forwarded-for": "198.51.100.61" });
let browserUser: { id: string; name: string; email: string; role: string } | null = null;

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/headers") return { headers: async () => requestHeaders, cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }) };
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
    };
  }
  // Sign-in as src/lib/auth.ts answers it: the phone's person inside a checked call, else the browser's.
  if (request === "@/lib/auth") {
    return {
      auth: async () => {
        /* eslint-disable-next-line @typescript-eslint/no-require-imports */
        const { apiActor } = require("../src/lib/api/actor") as typeof import("../src/lib/api/actor");
        const api = apiActor();
        if (api) return { user: { id: api.userId, name: api.name, email: api.email, role: api.role }, expires: "" };
        return browserUser ? { user: browserUser, expires: "" } : null;
      },
      signIn: async () => {},
      signOut: async () => {},
      handlers: {},
    };
  }
  if (request === "@/lib/email") return { sendEmailNotification: async () => {} };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

// ─── Places ─────────────────────────────────────────────────────────────────────────────────────

const OFFICE = { latitude: 28.6139, longitude: 77.209 };
const SITE = { latitude: 19.076, longitude: 72.8777 };
/** A point `metres` due north of `from` — a degree of latitude is the same length everywhere on a sphere. */
const north = (from: { latitude: number; longitude: number }, metres: number) => ({ latitude: from.latitude + metres / ((2 * Math.PI * 6371000) / 360), longitude: from.longitude });
/** A point `metres` due east, at this latitude. */
const east = (from: { latitude: number; longitude: number }, metres: number) => ({
  latitude: from.latitude,
  longitude: from.longitude + metres / (((2 * Math.PI * 6371000) / 360) * Math.cos((from.latitude * Math.PI) / 180)),
});

function pure() {
  section("The geofence's sums");
  const office: Office = { ...OFFICE, radiusM: 100, maxAccuracyM: 50 };
  ok("the same point: 0 m", distanceMetres(OFFICE, OFFICE) === 0);
  ok("50 m north is 50 m", Math.abs(distanceMetres(OFFICE, north(OFFICE, 50)) - 50) < 0.01, distanceMetres(OFFICE, north(OFFICE, 50)));
  ok("80 m east is 80 m", Math.abs(distanceMetres(OFFICE, east(OFFICE, 80)) - 80) < 0.05, distanceMetres(OFFICE, east(OFFICE, 80)));
  const delhiMumbai = distanceMetres(OFFICE, SITE) / 1000;
  ok("Delhi to Mumbai, about 1,150 km as the crow flies", delhiMumbai > 1130 && delhiMumbai < 1160, delhiMumbai.toFixed(1));
  ok("symmetrical", distanceMetres(OFFICE, SITE) === distanceMetres(SITE, OFFICE));

  section("Inside or not");
  const at = (p: { latitude: number; longitude: number }, accuracy: number | null = 10, mocked: boolean | null = null) => checkGeofence(office, { ...p, accuracy, mocked });
  const atOffice = at(OFFICE);
  ok("at the office's point: inside, 0 m", atOffice.ok && atOffice.distanceM === 0);
  ok("40 m away: inside", at(north(OFFICE, 40)).ok);
  ok("99.4 m away: inside (99 m)", at(north(OFFICE, 99.4)).ok);
  ok("100.4 m away — rounds to the radius: inside", at(north(OFFICE, 100.4)).ok);
  const justOut = at(north(OFFICE, 100.6));
  ok("100.6 m away — rounds past it: outside, 101 m", !justOut.ok && justOut.problem === "outside_office" && justOut.distanceM === 101, JSON.stringify(justOut));
  const far = at(SITE);
  ok("another city: outside, its distance said", !far.ok && far.problem === "outside_office" && (far.distanceM ?? 0) > 1_000_000);
  const vague = at(north(OFFICE, 120), 40);
  ok("120 m out, ±40 m: still outside — accuracy never widens the radius", !vague.ok && vague.problem === "outside_office");
  ok("inside but ±51 m with a 50 m limit: not accurate enough", (() => { const r = at(north(OFFICE, 10), 51); return !r.ok && r.problem === "accuracy_low"; })());
  ok("inside at exactly ±50 m: accepted", at(north(OFFICE, 10), 50).ok);
  ok("inside, accuracy unknown: refused as unknown", (() => { const r = at(north(OFFICE, 10), null); return !r.ok && r.problem === "accuracy_unknown"; })());
  ok("inside, but the phone says simulated: refused", (() => { const r = at(north(OFFICE, 10), 5, true); return !r.ok && r.problem === "mock_location"; })());
  ok("  not simulated, or the phone can't say: counted", at(north(OFFICE, 10), 5, false).ok && at(north(OFFICE, 10), 5, null).ok);
  ok("no reading at all: location required", (() => { const r = checkGeofence(office, null); return !r.ok && r.problem === "location_required"; })());
  ok("a latitude of 123: not a place", (() => { const r = checkGeofence(office, { latitude: 123, longitude: 77, accuracy: 5 }); return !r.ok && r.problem === "invalid_location"; })());
  ok("NaN: not a place", (() => { const r = checkGeofence(office, { latitude: Number.NaN, longitude: 77, accuracy: 5 }); return !r.ok && r.problem === "invalid_location"; })());
  const wide: Office = { ...SITE, radiusM: 300, maxAccuracyM: 100 };
  const twoHundred = { ...north(SITE, 200), accuracy: 80 };
  ok("different offices, different radii: 200 m ±80 is inside a 300 m office with a 100 m limit…", checkGeofence(wide, twoHundred).ok);
  ok("  …and outside a 100 m office in the same place", !checkGeofence({ ...SITE, radiusM: 100, maxAccuracyM: 100 }, twoHundred).ok);
  ok("  and a reading at one office is outside the other", !checkGeofence(office, { ...SITE, accuracy: 5 }).ok && !checkGeofence(wide, { ...OFFICE, accuracy: 5 }).ok);

  section("What a phone or browser may send");
  ok("nothing: no reading", readReading({}) === null && readReading(null) === null && readReading({ action: "in" }) === null);
  ok("a latitude without a longitude: invalid, not nothing", readReading({ latitude: 28.6 }) === "invalid");
  ok("out of range or not a number: invalid", readReading({ latitude: 123, longitude: 77 }) === "invalid" && readReading({ latitude: "abc", longitude: 77 }) === "invalid" && readReading({ latitude: 28, longitude: 181 }) === "invalid");
  const read = readReading({ latitude: "28.6139", longitude: "77.209", accuracy: 18.6, mocked: true });
  ok("numbers as text are read; accuracy to the metre; simulated kept", typeof read === "object" && read !== null && read.latitude === 28.6139 && read.accuracy === 19 && read.mocked === true, JSON.stringify(read));
  const noAcc = readReading({ latitude: 28.6, longitude: 77.2, accuracy: -3, mocked: "yes" });
  ok("a negative accuracy is unknown; a 'mocked' that isn't true or false is unknown", typeof noAcc === "object" && noAcc !== null && noAcc.accuracy === null && noAcc.mocked === null, JSON.stringify(noAcc));
  ok("nothing the phone sends names an office or a radius", Object.keys(read as object).sort().join() === "accuracy,latitude,longitude,mocked");

  section("What an administrator may type");
  const blank = readOfficeLocation({ latitude: "", longitude: "", radiusM: "", maxAccuracyM: "", enforced: false, exceptionsAllowed: true });
  ok("blank: no point, the defaults — 100 m and 50 m", blank.ok && blank.value.latitude === null && blank.value.geofenceRadiusM === 100 && blank.value.geoMaxAccuracyM === 50, JSON.stringify(blank));
  const set = readOfficeLocation({ latitude: "28.6139", longitude: "77.2090", radiusM: "150", maxAccuracyM: 40, enforced: true, exceptionsAllowed: false });
  ok("a point, a radius and switches", set.ok && set.value.latitude === 28.6139 && set.value.geofenceRadiusM === 150 && set.value.geofenceEnforced && !set.value.geoExceptionsAllowed);
  const refused = (input: Parameters<typeof readOfficeLocation>[0]) => !readOfficeLocation(input).ok;
  ok("a latitude without a longitude: refused", refused({ latitude: 28.6, longitude: "", enforced: false }));
  ok("latitude past ±90, longitude past ±180: refused", refused({ latitude: 91, longitude: 77 }) && refused({ latitude: -90.5, longitude: 77 }) && refused({ latitude: 28, longitude: 180.1 }) && refused({ latitude: 28, longitude: -181 }));
  ok("the edges themselves: accepted", readOfficeLocation({ latitude: 90, longitude: -180 }).ok && readOfficeLocation({ latitude: -90, longitude: 180 }).ok);
  ok(`a radius of 0, ${RADIUS_LIMITS.min - 1}, ${RADIUS_LIMITS.max + 1}, -5 or 10.5: refused`, [0, RADIUS_LIMITS.min - 1, RADIUS_LIMITS.max + 1, -5, 10.5].every((r) => refused({ latitude: 28, longitude: 77, radiusM: r })));
  ok(`an accuracy limit of ${ACCURACY_LIMITS.min - 1} or ${ACCURACY_LIMITS.max + 1}: refused`, refused({ latitude: 28, longitude: 77, maxAccuracyM: ACCURACY_LIMITS.min - 1 }) && refused({ latitude: 28, longitude: 77, maxAccuracyM: ACCURACY_LIMITS.max + 1 }));
  ok("turning GPS attendance on with no point: refused — nobody could clock in", refused({ latitude: "", longitude: "", enforced: true }));
}

// ─── Through the routes and actions ─────────────────────────────────────────────────────────────

async function cleanup() {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  const exceptions = (await db.attendanceException.findMany({ where: { OR: [{ userId: { in: ids } }, { requestedById: { in: ids } }] }, select: { id: true } })).map((e) => e.id);
  const branches = (await db.branch.findMany({ where: { code: { startsWith: TAG } }, select: { id: true } })).map((b) => b.id);
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: [...exceptions, ...branches] } }] } });
  await db.activityLog.deleteMany({ where: { userId: { in: ids } } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.attendanceLocation.deleteMany({ where: { OR: [{ userId: { in: ids } }, { branchId: { in: branches } }] } });
  await db.attendanceException.deleteMany({ where: { id: { in: exceptions } } });
  await db.attendanceDay.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.branch.deleteMany({ where: { id: { in: branches } } });
}

const ROUTES: [RegExp, string, string[]][] = [
  [/^\/today$/, "today", []],
  [/^\/attendance$/, "attendance", []],
  [/^\/attendance\/exception$/, "attendance/exception", []],
  [/^\/approvals$/, "approvals", []],
  [/^\/approvals\/([^/]+)\/([^/]+)$/, "approvals/[kind]/[id]", ["kind", "id"]],
];

type Answer<T = unknown> = { status: number; data: T; error?: { code: string; message: string; fields?: Record<string, string> } };

async function call<T = unknown>(token: string, method: string, path: string, body?: unknown): Promise<Answer<T>> {
  const route = ROUTES.find(([re]) => re.test(path));
  if (!route) throw new Error(`no route for ${path}`);
  const [re, dir, names] = route;
  const match = re.exec(path)!;
  const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(match[i + 1]!)]));
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const mod = require(`../src/app/api/app/${dir}/route`) as Record<string, (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>>;
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  for (const [k, v] of requestHeaders) headers[k] ??= v;
  const req = new Request(`http://deskzo.localhost:3000/api/app${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await mod[method]!(req, { params: Promise.resolve(params) });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  return { status: res.status, data: json.data as T, error: json.error };
}

type Clocked = { check_in_at: string | null; check_out_at: string | null; worked_minutes: number | null; check: string | null; distance_m: number | null; location: Record<string, unknown> };
type Today = { attendance: { check_in_at: string | null } | null; location: { required: boolean; configured: boolean; office: string | null; radius_m: number | null; exceptions_allowed: boolean; exception: { status: string; used_in: boolean } | null } | null };
type Approval = { kind: string; id: string; from: string | null };

const reading = (p: { latitude: number; longitude: number }, accuracy: number | null = 12, extra: Record<string, unknown> = {}) => ({ latitude: p.latitude, longitude: p.longitude, accuracy, ...extra });

async function main() {
  pure();

  /* eslint-disable @typescript-eslint/no-require-imports */
  const pairing = require("../src/lib/app/pairing") as typeof import("../src/lib/app/pairing");
  const { moduleAvailableForTenant } = require("../src/lib/modules-access") as typeof import("../src/lib/modules-access");
  const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
  const attendance = require("../src/actions/attendance") as typeof import("../src/actions/attendance");
  const exceptionsApi = require("../src/actions/attendance-exceptions") as typeof import("../src/actions/attendance-exceptions");
  const locationApi = require("../src/actions/attendance-location") as typeof import("../src/actions/attendance-location");
  const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
  /* eslint-enable @typescript-eslint/no-require-imports */

  await cleanup();
  try {
    if (!(await moduleAvailableForTenant("hr"))) {
      ok("HR is in this workspace's plan and switched on — the suite needs it", false);
      return;
    }
    try {
      await db.attendanceException.count();
    } catch {
      ok("this workspace's database has GPS attendance (prisma/migrations/20261122120000_geo_attendance) — run the migration first", false);
      return;
    }
    const clock = await workspaceClock();
    const today = clock.today();
    const headBefore = await db.branch.findMany({ select: { id: true, latitude: true, longitude: true, geofenceRadiusM: true, geofenceEnforced: true, geoExceptionsAllowed: true } });

    section("The offices, the people and their phones");
    const office = await db.branch.create({ data: { name: `${TAG} Delhi office`, code: `${TAG}-DEL`, ...OFFICE, geofenceRadiusM: 100, geoMaxAccuracyM: 50, geofenceEnforced: true, geoExceptionsAllowed: true } });
    const strict = await db.branch.create({ data: { name: `${TAG} Mumbai office`, code: `${TAG}-BOM`, ...SITE, geofenceRadiusM: 300, geoMaxAccuracyM: 100, geofenceEnforced: true, geoExceptionsAllowed: false } });
    const relaxed = await db.branch.create({ data: { name: `${TAG} Pune office`, code: `${TAG}-PNQ`, latitude: 18.5204, longitude: 73.8567, geofenceEnforced: false } });
    // Enforced with no point — only possible by hand in the database: the settings screen refuses it.
    const bare = await db.branch.create({ data: { name: `${TAG} Jaipur office`, code: `${TAG}-JAI`, geofenceEnforced: true } });
    const person = (name: string, role: string, branchId: string | null) =>
      db.user.create({ data: { name: `${TAG} ${name}`, email: `${name.toLowerCase()}${MAIL}`, role, passwordHash: "x".repeat(60), branchId } });
    const worker = await person("Worker", "SALES", office.id);
    const remote = await person("Remote", "SALES", office.id);
    const traveller = await person("Traveller", "SALES", office.id);
    const mumbai = await person("Mumbai", "SALES", strict.id);
    const pune = await person("Pune", "SALES", relaxed.id);
    const jaipur = await person("Jaipur", "SALES", bare.id);
    const twin = await person("Twin", "SALES", office.id);
    const webby = await person("Webby", "SALES", office.id);
    const approver = await person("Approver", "HR", null);
    const approverHeld = await can(approver.id, "hr.approveAttendanceExceptions");
    const workerHeld = await can(worker.id, "hr.approveAttendanceExceptions");
    ok("an HR person holds the new permission by role; a salesperson doesn't", approverHeld && !workerHeld, `${approverHeld}/${workerHeld}`);
    const pair = async (userId: string, model: string) => {
      const code = await pairing.startPairing(userId);
      /* eslint-disable-next-line @typescript-eslint/no-require-imports */
      const mod = require("../src/app/api/app/pair/route") as { POST: (req: Request) => Promise<Response> };
      const res = await mod.POST(new Request("http://deskzo.localhost:3000/api/app/pair", { method: "POST", headers: { ...Object.fromEntries(requestHeaders), "content-type": "application/json" }, body: JSON.stringify({ code: code.code, platform: "android", model }) }));
      return ((await res.json()) as { data: { token: string } }).data.token;
    };
    const phone: Record<string, string> = {};
    for (const u of [worker, remote, traveller, mumbai, pune, jaipur, twin, approver]) phone[u.id] = await pair(u.id, `${TAG} ${u.name}`);
    ok("every phone paired", Object.values(phone).every((t) => t.startsWith("dzp_")));
    const as = (u: { id: string; name: string; email: string; role: string }) => {
      browserUser = { id: u.id, name: u.name, email: u.email, role: u.role };
    };
    const nothingWritten = async (userId: string) => (await db.attendanceDay.count({ where: { userId } })) === 0 && (await db.attendanceLocation.count({ where: { userId } })) === 0;

    section("What the app is told");
    const todayScreen = await call<Today>(phone[worker.id]!, "GET", "/today");
    const policy = todayScreen.data.location;
    ok("Today says location is required, at which office, within what radius", todayScreen.status === 200 && policy?.required === true && policy.configured && policy.office === office.name && policy.radius_m === 100 && policy.exceptions_allowed, JSON.stringify(policy));
    ok("  and never where the office is", !JSON.stringify(todayScreen.data).includes(String(OFFICE.latitude)) && !JSON.stringify(policy).includes("latitude"));

    section("Clocking in where the office checks location");
    const refusedWith = async (who: string, body: Record<string, unknown>, code: string) => {
      const res = await call(phone[who]!, "POST", "/attendance", body);
      return { res, pass: res.status === 422 && res.error?.code === code };
    };
    const none = await refusedWith(worker.id, { action: "in" }, "location_required");
    ok("no location: refused — location required, an exception may be asked for", none.pass && none.res.error?.fields?.can_request_exception === "true", JSON.stringify(none.res.error));
    const outside = await refusedWith(worker.id, { action: "in", ...reading(north(OFFICE, 500)) }, "outside_office");
    ok("500 m away: refused — outside, the distance said", outside.pass && outside.res.error?.fields?.distance_m === "500" && outside.res.error?.message === "You are outside the permitted office area.", JSON.stringify(outside.res.error));
    ok("  the refusal names no coordinates", !JSON.stringify(outside.res.error).includes(String(OFFICE.longitude)));
    ok("inside but ±80 m: refused — accuracy", (await refusedWith(worker.id, { action: "in", ...reading(north(OFFICE, 20), 80) }, "accuracy_low")).pass);
    ok("inside, accuracy not sent: refused — unknown", (await refusedWith(worker.id, { action: "in", ...reading(north(OFFICE, 20), null) }, "accuracy_unknown")).pass);
    ok("inside, phone says simulated: refused", (await refusedWith(worker.id, { action: "in", ...reading(north(OFFICE, 20), 5, { mocked: true }) }, "mock_location")).pass);
    ok("a latitude of 123: refused — not a place, rather than clocked in without one", (await refusedWith(worker.id, { action: "in", latitude: 123, longitude: 77 }, "invalid_location")).pass);
    ok("  after all six refusals, nothing written — no day, no place", await nothingWritten(worker.id));
    const inside = await call<Clocked>(phone[worker.id]!, "POST", "/attendance", { action: "in", ...reading(north(OFFICE, 30), 12) });
    ok("30 m away, ±12 m: clocked in, checked INSIDE, 30 m", inside.status === 200 && !!inside.data.check_in_at && inside.data.check === "INSIDE" && inside.data.distance_m === 30, JSON.stringify(inside.data ?? inside.error));
    const inRow = await db.attendanceLocation.findFirst({ where: { userId: worker.id, kind: "IN" } });
    ok("  recorded with how it was checked: the office, the distance, the radius, the accuracy, the phone", inRow?.check === "INSIDE" && inRow.branchId === office.id && inRow.distanceM === 30 && inRow.radiusM === 100 && inRow.accuracyM === 12 && !!inRow.appDeviceId && inRow.exceptionId === null, JSON.stringify(inRow));
    const twice = await refusedWith(worker.id, { action: "in", ...reading(north(OFFICE, 10)) }, "already_clocked_in");
    ok("clocking in again, inside: the day's own rule first — already clocked in", twice.pass && twice.res.error?.message === "You're already clocked in today.", JSON.stringify(twice.res.error));
    ok("clocking out from outside: refused, still clocked in", (await refusedWith(worker.id, { action: "out", ...reading(east(OFFICE, 400)) }, "outside_office")).pass && !(await db.attendanceDay.findFirst({ where: { userId: worker.id } }))?.checkOutAt);
    const out = await call<Clocked>(phone[worker.id]!, "POST", "/attendance", { action: "out", ...reading(east(OFFICE, 60), 20) });
    ok("clocking out inside: out, INSIDE, minutes worked", out.status === 200 && !!out.data.check_out_at && out.data.check === "INSIDE" && out.data.worked_minutes !== null, JSON.stringify(out.data ?? out.error));
    ok("clocking out twice: refused — the second would have moved the time", (await refusedWith(worker.id, { action: "out", ...reading(OFFICE) }, "already_clocked_out")).pass && (await db.attendanceLocation.count({ where: { userId: worker.id } })) === 2);

    section("Two taps at once");
    const both = await Promise.all([0, 1].map(() => call<Clocked>(phone[twin.id]!, "POST", "/attendance", { action: "in", ...reading(OFFICE, 8) })));
    ok("one clocking and one refusal; one day, one place", both.filter((r) => r.status === 200).length === 1 && both.filter((r) => r.error?.code === "already_clocked_in").length === 1 && (await db.attendanceLocation.count({ where: { userId: twin.id } })) === 1, both.map((r) => r.status).join());

    section("Asking for an exception");
    const remoteOut = await refusedWith(remote.id, { action: "in", ...reading(north(OFFICE, 2500), 15) }, "outside_office");
    ok("2.5 km away: refused, may ask", remoteOut.pass && remoteOut.res.error?.fields?.can_request_exception === "true");
    const ask = await call<{ id: string; location: Today["location"] }>(phone[remote.id]!, "POST", "/attendance/exception", { action: "in", reason_code: "ALTERNATE_LOCATION", reason: `${TAG} at the client's office`, ...reading(north(OFFICE, 2500), 15) });
    ok("asked from the phone: waiting, and Today says so", ask.status === 200 && ask.data.location?.exception?.status === "PENDING", JSON.stringify(ask.data ?? ask.error));
    const asked = await db.attendanceException.findUnique({ where: { id: ask.data.id } });
    ok("  for clocking in, today, with the server's own distance and why — no coordinates kept", asked?.status === "PENDING" && asked.scope === "IN" && asked.attemptDistanceM === 2500 && asked.attemptAccuracyM === 15 && asked.attemptProblem === "outside_office" && asked.requestedById === remote.id && asked.validUntil.getTime() === clock.endOfDay(today)!.getTime(), JSON.stringify(asked));
    ok("  a second while it waits: refused", (await call(phone[remote.id]!, "POST", "/attendance/exception", { action: "in", reason_code: "OTHER", reason: "again please" })).status === 422);
    ok("  no reason: refused", (await call(phone[remote.id]!, "POST", "/attendance/exception", { action: "out", reason_code: "OTHER", reason: "" })).status === 422);
    const badReason = await call(phone[remote.id]!, "POST", "/attendance/exception", { action: "out", reason_code: "BECAUSE", reason: "just because" });
    ok("  a reason that isn't one: refused, in plain words", badReason.status === 422 && badReason.error?.message === "Pick a reason.", badReason.error?.message);
    ok("waiting isn't approved: still refused", (await refusedWith(remote.id, { action: "in", ...reading(north(OFFICE, 2500)) }, "outside_office")).pass && (await nothingWritten(remote.id)));
    const told = await db.notification.findFirst({ where: { userId: approver.id, type: "ATTENDANCE_EXCEPTION_REQUESTED" } });
    ok("the approver is told", !!told && told.link === "/people/attendance/exceptions");

    section("Deciding it");
    const queue = await call<Approval[]>(phone[approver.id]!, "GET", "/approvals");
    ok("on the approver's Approvals in the app", queue.status === 200 && queue.data.some((a) => a.kind === "attendance-exception" && a.id === ask.data.id && a.from === remote.name), queue.status);
    ok("  not on the person's own", !(await call<Approval[]>(phone[remote.id]!, "GET", "/approvals")).data.some((a) => a.id === ask.data.id));
    const selfPhone = await call(phone[remote.id]!, "POST", `/approvals/attendance-exception/${ask.data.id}`, { approve: true });
    as(remote);
    const selfWeb = await exceptionsApi.decideAttendanceException({ id: ask.data.id, approve: true });
    ok("the person can't approve their own — from the phone or the web", selfPhone.status === 422 && !selfWeb.ok && selfWeb.error === "You can't decide your own exception.", `${selfPhone.status} ${selfWeb.ok ? "" : selfWeb.error}`);
    as(worker);
    const stranger = await exceptionsApi.decideAttendanceException({ id: ask.data.id, approve: true });
    ok("somebody without the permission can't either", !stranger.ok && stranger.error === "You can't decide attendance exceptions.", stranger.ok ? "" : stranger.error);
    ok("  still waiting", (await db.attendanceException.findUnique({ where: { id: ask.data.id } }))?.status === "PENDING");
    as(approver);
    const unknown = await exceptionsApi.decideAttendanceException({ id: "c0000000000000000000000zz", approve: true });
    ok("an exception that isn't there (another workspace's, say): refused", !unknown.ok && unknown.error === "That request no longer exists.");
    browserUser = null;
    const approved = await call(phone[approver.id]!, "POST", `/approvals/attendance-exception/${ask.data.id}`, { approve: true, note: "Fine for today" });
    const decided = await db.attendanceException.findUnique({ where: { id: ask.data.id } });
    ok("approved from the approver's phone: who and when recorded", approved.status === 200 && decided?.status === "APPROVED" && decided.decidedById === approver.id && !!decided.decidedAt && decided.decisionNote === "Fine for today", approved.error?.message ?? approved.status);
    ok("  deciding it again: refused", (await call(phone[approver.id]!, "POST", `/approvals/attendance-exception/${ask.data.id}`, { approve: false })).status === 422);
    ok("  the person is told", !!(await db.notification.findFirst({ where: { userId: remote.id, type: "ATTENDANCE_EXCEPTION_DECIDED" } })));
    ok("  and Today shows it approved", (await call<Today>(phone[remote.id]!, "GET", "/today")).data.location?.exception?.status === "APPROVED");

    section("Using it — once");
    const viaException = await call<Clocked>(phone[remote.id]!, "POST", "/attendance", { action: "in", ...reading(north(OFFICE, 2500), 15) });
    ok("2.5 km away with the exception: clocked in, checked EXCEPTION", viaException.status === 200 && viaException.data.check === "EXCEPTION" && viaException.data.distance_m === 2500, JSON.stringify(viaException.data ?? viaException.error));
    const exRow = await db.attendanceLocation.findFirst({ where: { userId: remote.id, kind: "IN" } });
    const spent = await db.attendanceException.findUnique({ where: { id: ask.data.id } });
    ok("  told apart from a GPS clocking: EXCEPTION, naming the exception, the distance kept", exRow?.check === "EXCEPTION" && exRow.exceptionId === ask.data.id && exRow.distanceM === 2500, JSON.stringify(exRow));
    ok("  the exception spent for clocking in", !!spent?.usedInAt && spent.usedOutAt === null);
    ok("  audited", (await db.auditLog.count({ where: { entityType: "AttendanceException", entityId: ask.data.id } })) >= 3);
    ok("it was for clocking in only: clocking out from there is refused", (await refusedWith(remote.id, { action: "out", ...reading(north(OFFICE, 2500), 15) }, "outside_office")).pass);
    await db.attendanceDay.deleteMany({ where: { userId: remote.id } });
    ok("used: with the day cleared, the same exception doesn't let them in again", (await refusedWith(remote.id, { action: "in", ...reading(north(OFFICE, 2500), 15) }, "outside_office")).pass && (await db.attendanceDay.count({ where: { userId: remote.id } })) === 0);
    as(approver);
    const revokeUsed = await exceptionsApi.revokeAttendanceException({ id: ask.data.id, reason: "too late" });
    ok("  and a used one can't be revoked", !revokeUsed.ok);

    section("Granting, expiry and revoking");
    const grant = (input: Record<string, unknown>) => exceptionsApi.grantAttendanceException({ scope: "IN_AND_OUT", reasonCode: "ALTERNATE_LOCATION", reason: `${TAG} site visit`, fromDate: today, toDate: today, ...input });
    as(approver);
    ok("granting yourself one: refused", !(await grant({ userId: approver.id })).ok);
    const tooLong = clock.dateKey(new Date(Date.now() + 10 * 86_400_000));
    ok("granting more than a week: refused", !(await grant({ userId: traveller.id, toDate: tooLong })).ok);
    ok("granting for days gone: refused", !(await grant({ userId: traveller.id, fromDate: "2020-01-01", toDate: "2020-01-02" })).ok);
    as(worker);
    ok("somebody without the permission granting: refused", !(await grant({ userId: traveller.id })).ok);
    as(approver);
    const granted = await grant({ userId: traveller.id });
    ok("an approver grants one, approved from the start, recorded as theirs", granted.ok && (await db.attendanceException.findUnique({ where: { id: granted.ok ? granted.data.id : "" } }))?.decidedById === approver.id, granted.ok ? "" : granted.error);
    const grantedId = granted.ok ? granted.data.id : "";
    await db.attendanceException.update({ where: { id: grantedId }, data: { validFrom: new Date(Date.now() - 3 * 3_600_000), validUntil: new Date(Date.now() - 60_000) } });
    ok("expired: refused, and it reads as expired", (await refusedWith(traveller.id, { action: "in", ...reading(SITE) }, "outside_office")).pass && (await exceptionsApi.attendanceExceptionHistory({ userId: traveller.id })).find((r) => r.id === grantedId)?.state === "EXPIRED");
    const second = await grant({ userId: traveller.id });
    const secondId = second.ok ? second.data.id : "";
    as(traveller);
    ok("the person can't revoke their own", !(await exceptionsApi.revokeAttendanceException({ id: secondId, reason: "mine" })).ok);
    as(worker);
    ok("nor can somebody without the permission", !(await exceptionsApi.revokeAttendanceException({ id: secondId, reason: "theirs" })).ok);
    as(approver);
    const revoked = await exceptionsApi.revokeAttendanceException({ id: secondId, reason: "Plans changed" });
    const revRow = await db.attendanceException.findUnique({ where: { id: secondId } });
    ok("an approver revokes one not yet used: who, when and why recorded", revoked.ok && revRow?.status === "REVOKED" && revRow.revokedById === approver.id && revRow.revokeReason === "Plans changed", revoked.ok ? "" : revoked.error);
    ok("revoked: refused", (await refusedWith(traveller.id, { action: "in", ...reading(SITE) }, "outside_office")).pass && (await nothingWritten(traveller.id)));
    const third = await grant({ userId: traveller.id });
    browserUser = null;
    const travelIn = await call<Clocked>(phone[traveller.id]!, "POST", "/attendance", { action: "in" });
    const travelOut = await call<Clocked>(phone[traveller.id]!, "POST", "/attendance", { action: "out" });
    ok("granted for in and out: both through with no location at all, each marked EXCEPTION", third.ok && travelIn.data?.check === "EXCEPTION" && travelOut.data?.check === "EXCEPTION" && (await db.attendanceLocation.count({ where: { userId: traveller.id, check: "EXCEPTION", latitude: null } })) === 2, `${travelIn.error?.message ?? ""} ${travelOut.error?.message ?? ""}`);
    as(approver);
    const history = await exceptionsApi.attendanceExceptionHistory({ userId: traveller.id });
    ok("the history shows each: expired, revoked, used", ["EXPIRED", "REVOKED", "USED"].every((s) => history.some((h) => h.state === s)), history.map((h) => h.state).join());
    as(worker);
    ok("  and only to approvers", (await exceptionsApi.attendanceExceptionHistory({})).length === 0 && (await exceptionsApi.attendanceExceptionQueue()).length === 0);
    browserUser = null;

    section("Offices that differ");
    const noExceptions = await refusedWith(mumbai.id, { action: "in", ...reading(north(SITE, 900), 20) }, "outside_office");
    ok("an office that doesn't allow exceptions: refused, may not ask", noExceptions.pass && noExceptions.res.error?.fields?.can_request_exception === "false");
    ok("  asking anyway: refused", (await call(phone[mumbai.id]!, "POST", "/attendance/exception", { action: "in", reason_code: "OTHER", reason: "please let me" })).status === 422);
    as(approver);
    ok("  and granting there: refused", !(await grant({ userId: mumbai.id })).ok);
    browserUser = null;
    const mumbaiIn = await call<Clocked>(phone[mumbai.id]!, "POST", "/attendance", { action: "in", ...reading(north(SITE, 250), 90) });
    ok("  its own wider radius and looser accuracy: 250 m ±90 is inside", mumbaiIn.status === 200 && mumbaiIn.data.check === "INSIDE", JSON.stringify(mumbaiIn.error ?? ""));
    const notConfigured = await refusedWith(jaipur.id, { action: "in", ...reading(OFFICE) }, "office_not_configured");
    ok("an office that checks with no point set: refused — not configured", notConfigured.pass && notConfigured.res.error?.message === "Office location has not been configured. Please contact your administrator." && (await nothingWritten(jaipur.id)));
    const bareAsk = await call(phone[jaipur.id]!, "POST", "/attendance/exception", { action: "in", reason_code: "OTHER", reason: "office not set up" });
    ok("  asking for an exception there: refused — HR must set the office first", bareAsk.status === 422 && bareAsk.error?.message === "Office location has not been configured. Please contact your administrator.", bareAsk.error?.message);
    const relaxedNone = await call<Clocked>(phone[pune.id]!, "POST", "/attendance", { action: "in" });
    ok("an office that doesn't check: clocked in without a location, as before", relaxedNone.status === 200 && relaxedNone.data.check === "NOT_ENFORCED" && (await db.attendanceLocation.count({ where: { userId: pune.id } })) === 0);
    const relaxedOut = await call<Clocked>(phone[pune.id]!, "POST", "/attendance", { action: "out", ...reading(SITE, 30) });
    const puneRow = await db.attendanceLocation.findFirst({ where: { userId: pune.id } });
    ok("  and a location sent there is kept, the distance noted, NOT_ENFORCED", relaxedOut.status === 200 && puneRow?.check === "NOT_ENFORCED" && (puneRow.distanceM ?? 0) > 100_000, JSON.stringify(puneRow));

    section("The web's buttons");
    as(webby);
    const webPolicy = await attendance.myClockPolicy();
    ok("the policy the web reads: required, the office, the radius — no coordinates", webPolicy.required && webPolicy.officeName === office.name && webPolicy.radiusM === 100 && !("latitude" in webPolicy), JSON.stringify(webPolicy));
    const webNone = await attendance.clockIn();
    ok("Clock in with nothing from the browser: refused in plain words, may ask", !webNone.ok && webNone.code === "location_required" && webNone.canRequestException === true, JSON.stringify(webNone));
    const webIn = await attendance.clockIn(reading(east(OFFICE, 45), 25));
    ok("with the browser's location, inside: clocked in", webIn.ok && (await db.attendanceLocation.findFirst({ where: { userId: webby.id } }))?.check === "INSIDE", JSON.stringify(webIn));
    const webOut = await attendance.clockOut({ latitude: "x", longitude: 77 });
    ok("clocking out with something that isn't a place: refused", !webOut.ok && webOut.code === "invalid_location");

    section("Setting an office's location");
    as(worker);
    const notHr = await locationApi.saveOfficeLocation({ branchId: office.id, latitude: 1, longitude: 1, radiusM: 5000, maxAccuracyM: 1000, enforced: false, exceptionsAllowed: true });
    ok("somebody who isn't HR: refused, the office as it was", !notHr.ok && (await db.branch.findUnique({ where: { id: office.id } }))?.latitude === OFFICE.latitude);
    ok("  and the settings list isn't theirs", (await locationApi.listOfficeLocations()) === null);
    as(approver);
    const badLat = await locationApi.saveOfficeLocation({ branchId: office.id, latitude: 95, longitude: 77, radiusM: 100, maxAccuracyM: 50, enforced: true, exceptionsAllowed: true });
    ok("HR, with a latitude of 95: refused, unchanged", !badLat.ok && (await db.branch.findUnique({ where: { id: office.id } }))?.latitude === OFFICE.latitude, badLat.ok ? "" : badLat.error);
    const saved = await locationApi.saveOfficeLocation({ branchId: relaxed.id, latitude: "18.5204", longitude: "73.8567", radiusM: "", maxAccuracyM: "", enforced: true, exceptionsAllowed: true });
    const puneNow = await db.branch.findUnique({ where: { id: relaxed.id } });
    ok("HR sets one: saved, the defaults filled, audited", saved.ok && puneNow?.geofenceEnforced === true && puneNow.geofenceRadiusM === 100 && puneNow.geoMaxAccuracyM === 50 && (await db.auditLog.count({ where: { entityType: "Branch", entityId: relaxed.id } })) === 1, saved.ok ? "" : saved.error);
    const listed = await locationApi.listOfficeLocations();
    ok("  and listed for HR, with how many people clock against it", !!listed?.migrated && listed.offices.find((o) => o.id === office.id)?.people === 5);
    browserUser = null;

    const headAfter = await db.branch.findMany({ where: { id: { in: headBefore.map((b) => b.id) } }, select: { id: true, latitude: true, longitude: true, geofenceRadiusM: true, geofenceEnforced: true, geoExceptionsAllowed: true } });
    ok("no existing office was touched", JSON.stringify(headAfter.sort((a, b) => a.id.localeCompare(b.id))) === JSON.stringify(headBefore.sort((a, b) => a.id.localeCompare(b.id))));
  } finally {
    browserUser = null;
    await cleanup();
  }
}

main()
  .catch((e) => {
    console.error(e);
    failures += 1;
  })
  .finally(async () => {
    console.log(failures ? `\n${failures} failed.` : "\nAll passed.");
    process.exit(failures ? 1 : 0);
  });
