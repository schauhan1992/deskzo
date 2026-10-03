/**
 * check:visit-times — a field visit's time is India time, whatever zone the server runs in
 * (src/actions/visit.ts, the visit pages, the lists that show one). India's because the scratch
 * workspace sets no zone of its own: a workspace's times are on its own clock (src/lib/time/zone.ts).
 *
 * Production runs in UTC, and this suite does too: the process is switched to UTC before anything is
 * read, and the first check proves it. On a machine in India the old code was right by accident — a
 * form's "10:00" read in the process's own zone *is* 10:00 in India there — which is how a visit planned
 * on the live server came to be stored five and a half hours late without anybody seeing it.
 *
 * It builds a scratch workspace database beside the real one (as check:wording does), runs the real
 * actions and renders the real pages as a workspace pointed at it, and drops it at the end:
 *
 *   · a visit planned for 10:00 is stored as 04:30 UTC, and moved to 6:45 pm is stored as 13:15 UTC;
 *     a time that isn't one is refused;
 *   · the edit form is filled with the time as planned, the visit page and the lists show it as
 *     planned, and a new visit's suggested time is the next half hour in India;
 *   · the list's From and To are India days: 1:00 am and 11:30 pm on the day are in, 12:15 am the
 *     day after is out; times typed when completing one are India times too;
 *   · the other times typed into forms that were read the same way, fixed alongside: a call's
 *     callback, a campaign's "Not before" (typed, and sent with its zone), an expected visitor
 *     (and the host's notification), an attendance correction's times, and the notifications
 *     list's dates — which named no column at all;
 *   · and the real workspace untouched.
 *
 *   npm run check:visit-times
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import { indiaClock } from "../src/lib/time/zone";
import { formatVisitId } from "../src/lib/visits";

// As production runs. Node re-reads the zone when TZ is assigned; the first check confirms it took.
process.env.TZ = "UTC";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : r.error);

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const TAG = "ZZVISITTIMES";

// ── Who the code thinks is calling ──────────────────────────────────────────────────────────────

let actor: { id: string; name: string; email: string; role: string } | null = null;

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
// The pages read the session through auth() itself.
const authModule = {
  auth: async () => (actor ? { user: { ...actor } } : null),
  signIn: async () => {},
  signOut: async () => {},
  handlers: {},
};
const navigation = {
  notFound: () => {
    throw new Error("NOT_FOUND_CALLED");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
  permanentRedirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/visits",
  useSearchParams: () => new URLSearchParams(),
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const nextHeaders = {
  headers: async () => new Headers({ host: "zzvisittimes.localhost:3000" }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {}, getAll: () => [] }),
};
const email = { sendEmailNotification: async () => {} };
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/navigation", navigation],
  ["next/headers", nextHeaders],
  ["@/lib/session", session],
  ["@/lib/auth", authModule],
  ["@/lib/email", email],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/navigation"), navigation],
  [load.resolve("next/headers"), nextHeaders],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("../src/lib/auth"), authModule],
  [load.resolve("../src/lib/email"), email],
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

/** Awaits every async server component in a tree, so a static render can take it. */
async function resolveAsync(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: unknown }>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    return resolveAsync(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
  }
  if (el.props && "children" in el.props) {
    const kids = await resolveAsync(el.props.children);
    return Array.isArray(kids) ? cloneElement(el, undefined, ...(kids as ReactNode[])) : cloneElement(el, undefined, kids as ReactNode);
  }
  return el;
}

// ── The scratch database ────────────────────────────────────────────────────────────────────────

async function main() {
  section("The process is in UTC, as production is");
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  ok("no offset, and Intl agrees", new Date(2026, 9, 5, 10, 0).getTimezoneOffset() === 0 && (zone === "UTC" || zone === "Etc/UTC"), zone);
  ok("  so a form's 10:00 read the old way would be 10:00 UTC — the bug this suite is here for", new Date("2026-10-05T10:00").toISOString() === "2026-10-05T10:00:00.000Z");

  const realUrl = process.env.DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);

  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_visittimes`;
  const scratchUrl = withDatabase(realUrl, scratchName);
  ok("  and it is not the real one", scratchName !== realName, scratchName);

  const real = directClient(realUrl, { max: 1 });
  const realBefore = await snapshot(real);

  const admin = directClient(withDatabase(realUrl, "postgres"), { max: 1 });
  let closeAll: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60 * 1000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);

    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = "";

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    closeAll = () => db.$disconnect();
    /* eslint-enable @typescript-eslint/no-require-imports */
    await run(scratchUrl);
  } finally {
    await closeAll?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const gone = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratchName}'`);
    ok("the scratch database is dropped", Number(gone[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  section("The real workspace was not touched");
  const realAfter = await snapshot(real);
  await real.$disconnect();
  ok("its visits are as they were", realAfter === realBefore, realAfter);

  console.log(failures === 0 ? `\nAll ${passes} visit time checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** What the suite must never change in the real workspace. Read-only. */
async function snapshot(client: PrismaClient): Promise<string> {
  const [visits, latest, tagged] = await Promise.all([
    client.visit.count(),
    client.visit.findFirst({ orderBy: { updatedAt: "desc" }, select: { id: true, scheduledFor: true, updatedAt: true } }),
    client.company.count({ where: { name: { startsWith: TAG } } }),
  ]);
  return JSON.stringify({ visits, latest, tagged });
}

// ── The suite ───────────────────────────────────────────────────────────────────────────────────

async function run(scratchUrl: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const visits = require("../src/actions/visit") as typeof import("../src/actions/visit");
  const calls = require("../src/actions/call") as typeof import("../src/actions/call");
  const marketing = require("../src/actions/marketing") as typeof import("../src/actions/marketing");
  const visitors = require("../src/actions/visitor") as typeof import("../src/actions/visitor");
  const regularisation = require("../src/actions/regularisation") as typeof import("../src/actions/regularisation");
  const notifications = require("../src/actions/notification") as typeof import("../src/actions/notification");
  const { VisitsTable } = require("../src/components/visits/visits-table") as typeof import("../src/components/visits/visits-table");
  const NewVisitPage = (require("../src/app/(dashboard)/visits/new/page") as { default: (p: unknown) => Promise<ReactElement> }).default;
  const EditVisitPage = (require("../src/app/(dashboard)/visits/[id]/edit/page") as { default: (p: unknown) => Promise<ReactElement> }).default;
  const VisitPage = (require("../src/app/(dashboard)/visits/[id]/page") as { default: (p: unknown) => Promise<ReactElement> }).default;
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const tenant = {
    id: randomUUID(),
    slug: "zzvisittimes",
    name: "zzvisittimes",
    status: "ACTIVE" as const,
    dbUrl: scratchUrl,
    primaryHost: "zzvisittimes.localhost",
    hosts: ["zzvisittimes.localhost"],
    source: "env" as const,
    isDefault: false,
    keyBundleCipher: null,
    country: "IN",
    entitlements: { v: 1 as const, all: true, modules: [], seats: null, copilotTokens: null, customDomains: null, plans: [] },
    holdReason: null,
  };
  const render = async (page: Promise<ReactElement>) => renderToStaticMarkup((await resolveAsync(await page)) as ReactElement);

  await runAsTenant(tenant, async () => {
    // ── Fixture ────────────────────────────────────────────────────────────────────────────────
    section("Fixture");
    const planner = await db.user.create({
      data: { name: `${TAG} Planner`, email: `${TAG.toLowerCase()}-planner@example.test`, passwordHash: "!", role: "SALES" },
      select: { id: true, name: true, email: true, role: true },
    });
    actor = planner;
    const company = await db.company.create({
      data: { name: `${TAG} Sunrise Towers`, normalizedName: `${TAG} sunrise towers`.toLowerCase(), createdById: planner.id, ownerUserId: planner.id },
      select: { id: true },
    });
    ok("a salesperson and their customer", !!company.id);
    const plan = (at: string) => visits.createVisit({ companyId: company.id, purpose: "INTRO_MEETING", scheduledFor: at });
    const storedOf = async (id: string) => (await db.visit.findUniqueOrThrow({ where: { id }, select: { scheduledFor: true } })).scheduledFor.toISOString();

    // ── Planning ───────────────────────────────────────────────────────────────────────────────
    section("Planning and moving a visit");
    const planned = await plan("2026-10-05T10:00");
    ok("planned for 10:00: stored as 04:30 UTC — 10:00 in India", planned.ok && (await storedOf(planned.data.id)) === "2026-10-05T04:30:00.000Z", errorOf(planned));
    if (!planned.ok) return;
    const visitId = planned.data.id;
    const moved = await visits.updateVisit({ id: visitId, companyId: company.id, purpose: "INTRO_MEETING", scheduledFor: "2026-10-05T18:45" });
    ok("moved to 6:45 pm: stored as 13:15 UTC", moved.ok && (await storedOf(visitId)) === "2026-10-05T13:15:00.000Z", errorOf(moved));
    const nonsense = await visits.createVisit({ companyId: company.id, purpose: "INTRO_MEETING", scheduledFor: "next tuesday" });
    ok("a time that isn't one is refused", !nonsense.ok && /date and time/i.test(errorOf(nonsense) ?? ""), errorOf(nonsense));
    const nonsenseMove = await visits.updateVisit({ id: visitId, companyId: company.id, purpose: "INTRO_MEETING", scheduledFor: "2026-13-45T99:00" });
    ok("  and so is moving one to it, leaving the visit where it was", !nonsenseMove.ok && (await storedOf(visitId)) === "2026-10-05T13:15:00.000Z");

    // ── What people see ────────────────────────────────────────────────────────────────────────
    section("The forms and the pages");
    const ref = formatVisitId((await db.visit.findUniqueOrThrow({ where: { id: visitId }, select: { visitSeq: true } })).visitSeq);
    const edit = await render(EditVisitPage({ params: Promise.resolve({ id: visitId }) }));
    ok("the edit form is filled with 6:45 pm, as planned", edit.includes('value="2026-10-05T18:45"'), (/id="scheduledFor"[^>]*/.exec(edit) ?? [""])[0]);
    const page = textOf(await render(VisitPage({ params: Promise.resolve({ id: ref }), searchParams: Promise.resolve({}) })));
    ok("the visit page shows 6:45 pm on 5 Oct", page.includes("5 Oct") && page.includes("6:45 pm") && !page.includes("1:15 pm"), page.slice(0, 240));
    const listed = await visits.listVisitsPaged({ page: 1, pageSize: 50 });
    const table = textOf(renderToStaticMarkup(createElement(VisitsTable, { visits: listed.rows as Parameters<typeof VisitsTable>[0]["visits"] })));
    ok("  and so does the list", table.includes("6:45 pm") && table.includes("5 Oct 2026") && !table.includes("1:15 pm"), table.slice(0, 240));
    const before = Date.now();
    const fresh = await render(NewVisitPage({ searchParams: Promise.resolve({}) }));
    const suggested = (/id="scheduledFor"[^>]*value="([^"]+)"/.exec(fresh) ?? /value="([^"]+)"[^>]*id="scheduledFor"/.exec(fresh))?.[1] ?? "";
    const suggestedAt = indiaClock.parseInput(suggested);
    ok(
      "a new visit suggests the next half hour in India",
      !!suggestedAt && /:(00|30)$/.test(suggested) && suggestedAt.getTime() > before && suggestedAt.getTime() <= before + 30 * 60_000 + 1000,
      suggested,
    );

    // ── The list's days ────────────────────────────────────────────────────────────────────────
    section("From and To are India days");
    const early = await plan("2026-10-05T01:00"); // 19:30 UTC on the 4th
    const late = await plan("2026-10-05T23:30"); // 18:00 UTC on the 5th
    const nextDay = await plan("2026-10-06T00:15"); // 18:45 UTC on the 5th
    if (!early.ok || !late.ok || !nextDay.ok) {
      ok("the edge visits were planned", false, `${errorOf(early)} ${errorOf(late)} ${errorOf(nextDay)}`);
      return;
    }
    const onTheFifth = await visits.listVisitsPaged({ from: "2026-10-05", to: "2026-10-05", page: 1, pageSize: 50 });
    const ids = new Set((onTheFifth.rows as { id: string }[]).map((r) => r.id));
    ok("1:00 am and 11:30 pm on the 5th are on the 5th", ids.has(early.data.id) && ids.has(late.data.id) && ids.has(visitId));
    ok("  12:15 am on the 6th is not, though it is still the 5th in UTC", !ids.has(nextDay.data.id), [...ids]);

    // ── Completing one with the times typed in ─────────────────────────────────────────────────
    section("Completing a visit with its times typed in");
    const done = await visits.completeVisit({ id: late.data.id, outcome: "Signed the order", checkInAt: "2026-10-05T23:35", checkOutAt: "2026-10-05T23:55" });
    const times = await db.visit.findUniqueOrThrow({ where: { id: late.data.id }, select: { checkInAt: true, checkOutAt: true } });
    ok(
      "arrived 11:35 pm, left 11:55 pm — India time",
      done.ok && times.checkInAt?.toISOString() === "2026-10-05T18:05:00.000Z" && times.checkOutAt?.toISOString() === "2026-10-05T18:25:00.000Z",
      errorOf(done),
    );
    const zoned = await visits.completeVisit({ id: early.data.id, outcome: "Met the CFO", checkInAt: "2026-10-04T19:35:00Z", checkOutAt: "2026-10-05T01:40+05:30" });
    const zonedTimes = await db.visit.findUniqueOrThrow({ where: { id: early.data.id }, select: { checkInAt: true, checkOutAt: true } });
    ok(
      "  a timestamp that says its own zone is taken as it says",
      zoned.ok && zonedTimes.checkInAt?.toISOString() === "2026-10-04T19:35:00.000Z" && zonedTimes.checkOutAt?.toISOString() === "2026-10-04T20:10:00.000Z",
      errorOf(zoned),
    );
    const garbled = await visits.completeVisit({ id: nextDay.data.id, outcome: "x", checkInAt: "soon" });
    ok("  and one that isn't a time is refused", !garbled.ok && /check-in time/i.test(errorOf(garbled) ?? ""), errorOf(garbled));

    // ── The other times typed into forms ─────────────────────────────────────────────────────────
    section("Other times typed into forms, read the same way");
    const boss = await db.user.create({
      data: { name: `${TAG} Boss`, email: `${TAG.toLowerCase()}-boss@example.test`, passwordHash: "!", role: "ADMIN", isSuperAdmin: true },
      select: { id: true, name: true, email: true, role: true },
    });
    actor = boss;

    const call = await calls.logCall({ companyId: company.id, phoneNumber: "+919800000001", outcome: "NO_ANSWER", followUpAt: "2026-10-06T15:00" });
    const callBack = call.ok ? (await db.callLog.findUniqueOrThrow({ where: { id: call.data.id }, select: { followUpAt: true } })).followUpAt : null;
    ok("a call's callback at 3:00 pm is 3:00 pm in India — 09:30 UTC", callBack?.toISOString() === "2026-10-06T09:30:00.000Z", errorOf(call));

    const template = await db.marketingTemplate.create({ data: { name: `${TAG} offer`, body: "Hello {{contact.firstName}}", createdById: boss.id }, select: { id: true } });
    const list = await db.marketingList.create({ data: { name: `${TAG} list`, consentNote: "Met at the expo", createdById: boss.id }, select: { id: true } });
    const typedCampaign = await marketing.saveCampaign({ name: `${TAG} typed`, templateId: template.id, listId: list.id, channel: "EMAIL", scheduledFor: "2026-10-06T09:00" });
    const zonedCampaign = await marketing.saveCampaign({ name: `${TAG} zoned`, templateId: template.id, listId: list.id, channel: "EMAIL", scheduledFor: "2026-10-06T03:30:00.000Z" });
    const notBefore = async (r: typeof typedCampaign) => (r.ok ? (await db.campaign.findUniqueOrThrow({ where: { id: r.data.id }, select: { scheduledFor: true } })).scheduledFor?.toISOString() : errorOf(r));
    ok("a campaign's \"Not before\" typed as 9:00 am is 9:00 am in India", (await notBefore(typedCampaign)) === "2026-10-06T03:30:00.000Z", await notBefore(typedCampaign));
    ok("  and the same moment sent with its zone, as the mass-mail wizard sends it, is that moment", (await notBefore(zonedCampaign)) === "2026-10-06T03:30:00.000Z", await notBefore(zonedCampaign));
    const badCampaign = await marketing.saveCampaign({ name: `${TAG} bad`, templateId: template.id, listId: list.id, channel: "EMAIL", scheduledFor: "whenever" });
    ok("  a send time that isn't one is refused", !badCampaign.ok, errorOf(badCampaign));

    const invite = await visitors.createInvite({ name: "Ravi Kumar", expectedAt: "2026-10-06T10:00", hostUserId: planner.id });
    const expected = invite.ok ? (await db.visitorInvite.findUniqueOrThrow({ where: { id: invite.data.id }, select: { expectedAt: true } })).expectedAt : null;
    ok("a visitor expected at 10:00 is expected at 10:00 in India", expected?.toISOString() === "2026-10-06T04:30:00.000Z", errorOf(invite));
    const told = await db.notification.findFirst({ where: { userId: planner.id, type: "VISITOR_EXPECTED" }, select: { message: true } });
    ok("  and the host is told 10:00 am, not the server's day", !!told?.message?.includes("10:00 am"), told?.message);

    const correction = await regularisation.requestRegularisation({ date: "2026-10-01", requestedStatus: "PRESENT", checkIn: "09:30", checkOut: "18:00", reason: "Forgot to clock in" });
    const asked = correction.ok
      ? await db.attendanceRegularisation.findUniqueOrThrow({ where: { id: correction.data.id }, select: { requestedCheckIn: true, requestedCheckOut: true } })
      : null;
    ok(
      "an attendance correction's 9:30 to 6:00 pm are India times — not UTC, which came back as 3:00 pm",
      asked?.requestedCheckIn?.toISOString() === "2026-10-01T04:00:00.000Z" && asked?.requestedCheckOut?.toISOString() === "2026-10-01T12:30:00.000Z",
      errorOf(correction),
    );

    const morning = await db.notification.create({ data: { userId: boss.id, type: "VISIT_SCHEDULED", title: `${TAG} 1:00 am on the 5th`, createdAt: new Date("2026-10-04T19:30:00.000Z") }, select: { id: true } });
    const pastMidnight = await db.notification.create({ data: { userId: boss.id, type: "VISIT_SCHEDULED", title: `${TAG} 12:15 am on the 6th`, createdAt: new Date("2026-10-05T18:45:00.000Z") }, select: { id: true } });
    let inbox: Awaited<ReturnType<typeof notifications.listNotifications>> | null = null;
    let threw = "";
    try {
      inbox = await notifications.listNotifications({ page: 1, pageSize: 50, from: "2026-10-05", to: "2026-10-05" });
    } catch (err) {
      threw = (err as Error).message.split("\n")[0];
    }
    const shown = new Set((inbox?.rows ?? []).map((r) => r.id));
    ok("the notifications list filters by date at all — it used to name no column", !!inbox, threw);
    ok("  in India days: 1:00 am on the 5th is in, 12:15 am on the 6th is out", shown.has(morning.id) && !shown.has(pastMidnight.id));
  });
  actor = null;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
