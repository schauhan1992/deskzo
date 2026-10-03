/**
 * check:zone-pages — a workspace outside India keeps its own time, end to end (owner, 2 Oct 2026;
 * src/lib/time). check:time-zones proves the clock and the settings; this proves the app uses them.
 *
 * A scratch workspace in New York (daylight saving: UTC−4 in October) on a server in Tokyo, so neither
 * India's clock nor the server's can make a check pass. Through the real actions and pages:
 *
 *   · a visit typed for 10:00 am is 10:00 am in New York, moved and shown in the edit form as typed;
 *     the visit page and the list show New York's time; a new visit suggests New York's next half hour;
 *   · the list's From and To are New York's days, half-open;
 *   · the clocks' change: an hour that happens twice is its first, a skipped one is moved forward;
 *   · times typed when completing a visit, a call's callback, a campaign's "Not before", an expected
 *     visitor (and the host's notification), an attendance correction — all New York's;
 *   · the notifications list's From and To are New York's days;
 *   · and the real workspace untouched.
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import { clockFor } from "../src/lib/time/zone";
import { formatVisitId } from "../src/lib/visits";
import { renderHtml } from "./lib/render-html";

// A server in Tokyo: neither the workspace's zone nor India's, and nine hours from UTC.
process.env.TZ = "Asia/Tokyo";

const ZONE = "America/New_York";
const newYork = clockFor(ZONE);

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

const TAG = "ZZZONEPAGES";

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
  headers: async () => new Headers({ host: "zzzonepages.localhost:3000" }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {}, getAll: () => [] }),
};
const email = { sendEmailNotification: async () => {} };
// The root layout's fonts come from Next's build; outside it, a class name will do.
const fonts = { Geist: () => ({ variable: "font-sans" }), Geist_Mono: () => ({ variable: "font-mono" }) };
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/navigation", navigation],
  ["next/headers", nextHeaders],
  ["@/lib/session", session],
  ["@/lib/auth", authModule],
  ["@/lib/email", email],
  ["next/font/google", fonts],
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
  if (request.endsWith(".css")) return {};
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
  section("The server is in Tokyo; the workspace in New York");
  ok("nine hours ahead of UTC", new Date("2026-10-05T12:00:00Z").getTimezoneOffset() === -540);
  ok("  New York is four behind in October", newYork.offsetLabel(new Date("2026-10-05T12:00:00Z")) === "UTC-04:00");

  const realUrl = process.env.DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);

  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_zonepages`;
  const scratchUrl = withDatabase(realUrl, scratchName);

  const real = directClient(realUrl, { max: 1 });
  const realBefore = await snapshot(real);
  const admin = directClient(withDatabase(realUrl, "postgres"), { max: 1 });
  let closeAll: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60 * 1000 });
    ok("built from the migrations", true);
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
  ok("nothing of this suite's in it", realAfter === realBefore, realAfter);

  console.log(failures === 0 ? `\nAll ${passes} zone page checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** What the suite must never change in the real workspace — narrow, since people may be using it. Read-only. */
async function snapshot(client: PrismaClient): Promise<string> {
  const [companies, users] = await Promise.all([client.company.count({ where: { name: { startsWith: TAG } } }), client.user.count({ where: { email: { startsWith: TAG.toLowerCase() } } })]);
  return JSON.stringify({ companies, users });
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
  const { ClockProvider } = require("../src/components/time/clock-provider") as typeof import("../src/components/time/clock-provider");
  const { VisitsTable } = require("../src/components/visits/visits-table") as typeof import("../src/components/visits/visits-table");
  const NewVisitPage = (require("../src/app/(dashboard)/visits/new/page") as { default: (p: unknown) => Promise<ReactElement> }).default;
  const EditVisitPage = (require("../src/app/(dashboard)/visits/[id]/edit/page") as { default: (p: unknown) => Promise<ReactElement> }).default;
  const VisitPage = (require("../src/app/(dashboard)/visits/[id]/page") as { default: (p: unknown) => Promise<ReactElement> }).default;
  const RootLayout = (require("../src/app/layout") as { default: (p: unknown) => Promise<ReactElement> }).default;
  const { useClock } = require("../src/components/time/clock-provider") as typeof import("../src/components/time/clock-provider");
  const portableOut = require("../src/lib/portability/export") as typeof import("../src/lib/portability/export");
  const portableIn = require("../src/lib/portability/import") as typeof import("../src/lib/portability/import");
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const tenant = {
    id: randomUUID(),
    slug: "zzzonepages",
    name: "zzzonepages",
    status: "ACTIVE" as const,
    dbUrl: scratchUrl,
    primaryHost: "zzzonepages.localhost",
    hosts: ["zzzonepages.localhost"],
    source: "env" as const,
    isDefault: false,
    keyBundleCipher: null,
    country: "US",
    timezone: ZONE,
    entitlements: { v: 1 as const, all: true, modules: [], seats: null, copilotTokens: null, customDomains: null, plans: [] },
    holdReason: null,
  };
  // As the dashboard layout hands the workspace's zone down to client components.
  const render = async (page: Promise<ReactElement>) => renderToStaticMarkup(createElement(ClockProvider, { zone: ZONE }, (await resolveAsync(await page)) as ReactElement));

  await runAsTenant(tenant, async () => {
    section("Fixture");
    const planner = await db.user.create({
      data: { name: `${TAG} Planner`, email: `${TAG.toLowerCase()}-planner@example.test`, passwordHash: "!", role: "SALES" },
      select: { id: true, name: true, email: true, role: true },
    });
    actor = planner;
    const company = await db.company.create({
      data: { name: `${TAG} Liberty Plaza`, normalizedName: `${TAG} liberty plaza`.toLowerCase(), createdById: planner.id, ownerUserId: planner.id },
      select: { id: true },
    });
    ok("a salesperson and their customer, in New York", !!company.id);
    const plan = (at: string) => visits.createVisit({ companyId: company.id, purpose: "INTRO_MEETING", scheduledFor: at });
    const storedOf = async (id: string) => (await db.visit.findUniqueOrThrow({ where: { id }, select: { scheduledFor: true } })).scheduledFor.toISOString();

    section("Planning and moving a visit");
    const planned = await plan("2026-10-05T10:00");
    ok("planned for 10:00: stored as 14:00 UTC — 10:00 in New York", planned.ok && (await storedOf(planned.data.id)) === "2026-10-05T14:00:00.000Z", errorOf(planned));
    if (!planned.ok) return;
    const visitId = planned.data.id;
    const moved = await visits.updateVisit({ id: visitId, companyId: company.id, purpose: "INTRO_MEETING", scheduledFor: "2026-10-05T18:45" });
    ok("moved to 6:45 pm: stored as 22:45 UTC", moved.ok && (await storedOf(visitId)) === "2026-10-05T22:45:00.000Z", errorOf(moved));

    section("The forms and the pages, in New York's time");
    const ref = formatVisitId((await db.visit.findUniqueOrThrow({ where: { id: visitId }, select: { visitSeq: true } })).visitSeq);
    const edit = await render(EditVisitPage({ params: Promise.resolve({ id: visitId }) }));
    ok("the edit form is filled with 6:45 pm, as planned", edit.includes('value="2026-10-05T18:45"'), (/id="scheduledFor"[^>]*/.exec(edit) ?? [""])[0]);
    const page = textOf(await render(VisitPage({ params: Promise.resolve({ id: ref }), searchParams: Promise.resolve({}) })));
    ok("the visit page shows 6:45 pm on 5 Oct — not India's 4:15 am on the 6th", page.includes("5 Oct") && page.includes("6:45 pm") && !page.includes("4:15 am"), page.slice(0, 240));
    const listed = await visits.listVisitsPaged({ page: 1, pageSize: 50 });
    const table = textOf(renderToStaticMarkup(createElement(ClockProvider, { zone: ZONE }, createElement(VisitsTable, { visits: listed.rows as Parameters<typeof VisitsTable>[0]["visits"] }))));
    ok("  and so does the list", table.includes("6:45 pm") && table.includes("5 Oct 2026") && !table.includes("4:15 am"), table.slice(0, 240));
    const before = Date.now();
    const fresh = await render(NewVisitPage({ searchParams: Promise.resolve({}) }));
    const suggested = (/id="scheduledFor"[^>]*value="([^"]+)"/.exec(fresh) ?? /value="([^"]+)"[^>]*id="scheduledFor"/.exec(fresh))?.[1] ?? "";
    const suggestedAt = newYork.parseInput(suggested);
    ok(
      "a new visit suggests New York's next half hour",
      !!suggestedAt && /:(00|30)$/.test(suggested) && suggestedAt.getTime() > before && suggestedAt.getTime() <= before + 30 * 60_000 + 1000,
      suggested,
    );

    // Every client component's clock comes from the root layout: a page under it in a probe's place.
    const ZoneProbe = () => createElement("output", null, `zone ${useClock().zone}`);
    const root = await renderHtml(RootLayout({ children: createElement(ZoneProbe), params: Promise.resolve({}) }));
    ok("the root layout hands every client component New York's zone", root.includes("zone America/New_York"), (/zone [^<]*/.exec(root) ?? ["(no probe)"])[0]);

    section("From and To are New York's days");
    const early = await plan("2026-10-05T01:00"); // 05:00 UTC on the 5th
    const late = await plan("2026-10-05T23:30"); // 03:30 UTC on the 6th
    const nextDay = await plan("2026-10-06T00:15"); // 04:15 UTC on the 6th
    if (!early.ok || !late.ok || !nextDay.ok) {
      ok("the edge visits were planned", false, `${errorOf(early)} ${errorOf(late)} ${errorOf(nextDay)}`);
      return;
    }
    const onTheFifth = await visits.listVisitsPaged({ from: "2026-10-05", to: "2026-10-05", page: 1, pageSize: 50 });
    const ids = new Set((onTheFifth.rows as { id: string }[]).map((r) => r.id));
    ok("1:00 am and 11:30 pm on the 5th are on the 5th — though 11:30 pm is the 6th in UTC", ids.has(early.data.id) && ids.has(late.data.id) && ids.has(visitId));
    ok("  12:15 am on the 6th is not", !ids.has(nextDay.data.id), [...ids]);

    section("Out to a spreadsheet and back");
    const lateRef = formatVisitId((await db.visit.findUniqueOrThrow({ where: { id: late.data.id }, select: { visitSeq: true } })).visitSeq);
    const exported = await portableOut.areaRows(planner.id, "visits");
    const lateRow = exported.find((r) => r.Visit === lateRef);
    ok("11:30 pm on the 5th is exported as New York's 11:30 pm on the 5th — not UTC's 3:30 am on the 6th", lateRow?.["Scheduled for"] === "2026-10-05 23:30", lateRow?.["Scheduled for"]);
    const differences = (p: Awaited<ReturnType<typeof portableIn.plan>>) =>
      p.rows
        .filter((r) => r.action !== "skip")
        .map((r) => `${r.action} ${r.label} ${r.error ?? ""} [${r.changes.map((c) => `${c.field}: ${c.from}→${c.to}`).join(", ")}]`)
        .join(" | ") || `${p.skips} already match`;
    const workbook = await portableOut.toWorkbookBuffer([{ name: "visits", rows: exported }], { title: "visits", by: "check", generatedAt: new Date() });
    const fromXlsx = await portableIn.plan("visits", await portableIn.parseFile(workbook.toString("base64"), "visits.xlsx"), planner.id);
    ok("  the xlsx re-imports unchanged — each visit on its New York day", fromXlsx.creates + fromXlsx.updates + fromXlsx.errors === 0, differences(fromXlsx));
    const csv = Buffer.from(portableOut.toCsv(exported), "utf8").toString("base64");
    const fromCsv = await portableIn.plan("visits", await portableIn.parseFile(csv, "visits.csv"), planner.id);
    ok("  and so does the csv", fromCsv.creates + fromCsv.updates + fromCsv.errors === 0, differences(fromCsv));
    // A file exported before the times were written as the workspace's: each a UTC timestamp.
    const stored = new Map(
      (await db.visit.findMany({ select: { visitSeq: true, scheduledFor: true } })).map((v) => [formatVisitId(v.visitSeq), v.scheduledFor.toISOString()]),
    );
    const older: Record<string, unknown>[] = exported.map((r) => ({ ...r, "Scheduled for": stored.get(String(r.Visit)) ?? "" }));
    ok("  a csv exported before, in UTC, still reads 11:30 pm as the 5th", older.find((r) => r.Visit === lateRef)?.["Scheduled for"] === "2026-10-06T03:30:00.000Z");
    const fromOlder = await portableIn.plan("visits", await portableIn.parseFile(Buffer.from(portableOut.toCsv(older), "utf8").toString("base64"), "visits.csv"), planner.id);
    ok("    and re-imports unchanged", fromOlder.creates + fromOlder.updates + fromOlder.errors === 0, differences(fromOlder));

    section("When the clocks change");
    const twice = await plan("2026-11-01T01:30");
    ok("1:30 am the night the clocks go back happens twice: the first, 05:30 UTC", twice.ok && (await storedOf(twice.data.id)) === "2026-11-01T05:30:00.000Z", errorOf(twice));
    const skipped = await plan("2026-03-08T02:30");
    ok("2:30 am the night they go forward doesn't exist: 3:30 am, 07:30 UTC", skipped.ok && (await storedOf(skipped.data.id)) === "2026-03-08T07:30:00.000Z", errorOf(skipped));

    section("Other times typed into forms");
    const done = await visits.completeVisit({ id: late.data.id, outcome: "Signed the order", checkInAt: "2026-10-05T23:35", checkOutAt: "2026-10-05T23:55" });
    const times = await db.visit.findUniqueOrThrow({ where: { id: late.data.id }, select: { checkInAt: true, checkOutAt: true } });
    ok(
      "a visit completed with 11:35 pm to 11:55 pm typed: New York's",
      done.ok && times.checkInAt?.toISOString() === "2026-10-06T03:35:00.000Z" && times.checkOutAt?.toISOString() === "2026-10-06T03:55:00.000Z",
      errorOf(done),
    );
    const boss = await db.user.create({
      data: { name: `${TAG} Boss`, email: `${TAG.toLowerCase()}-boss@example.test`, passwordHash: "!", role: "ADMIN", isSuperAdmin: true },
      select: { id: true, name: true, email: true, role: true },
    });
    actor = boss;
    const call = await calls.logCall({ companyId: company.id, phoneNumber: "+12125550100", outcome: "NO_ANSWER", followUpAt: "2026-10-06T15:00" });
    const callBack = call.ok ? (await db.callLog.findUniqueOrThrow({ where: { id: call.data.id }, select: { followUpAt: true } })).followUpAt : null;
    ok("a call's callback at 3:00 pm: 19:00 UTC", callBack?.toISOString() === "2026-10-06T19:00:00.000Z", errorOf(call));
    const template = await db.marketingTemplate.create({ data: { name: `${TAG} offer`, body: "Hello {{contact.firstName}}", createdById: boss.id }, select: { id: true } });
    const list = await db.marketingList.create({ data: { name: `${TAG} list`, consentNote: "Met at the expo", createdById: boss.id }, select: { id: true } });
    const campaign = await marketing.saveCampaign({ name: `${TAG} typed`, templateId: template.id, listId: list.id, channel: "EMAIL", scheduledFor: "2026-10-06T09:00" });
    const notBefore = campaign.ok ? (await db.campaign.findUniqueOrThrow({ where: { id: campaign.data.id }, select: { scheduledFor: true } })).scheduledFor?.toISOString() : errorOf(campaign);
    ok("a campaign's \"Not before\" of 9:00 am: 13:00 UTC", notBefore === "2026-10-06T13:00:00.000Z", notBefore);
    const invite = await visitors.createInvite({ name: "Alex Rivera", expectedAt: "2026-10-06T10:00", hostUserId: planner.id });
    const expected = invite.ok ? (await db.visitorInvite.findUniqueOrThrow({ where: { id: invite.data.id }, select: { expectedAt: true } })).expectedAt : null;
    ok("a visitor expected at 10:00: 14:00 UTC", expected?.toISOString() === "2026-10-06T14:00:00.000Z", errorOf(invite));
    const told = await db.notification.findFirst({ where: { userId: planner.id, type: "VISITOR_EXPECTED" }, select: { message: true } });
    ok("  and the host is told 10:00 am", !!told?.message?.includes("10:00 am"), told?.message);
    const correction = await regularisation.requestRegularisation({ date: "2026-10-01", requestedStatus: "PRESENT", checkIn: "09:30", checkOut: "18:00", reason: "Forgot to clock in" });
    const asked = correction.ok
      ? await db.attendanceRegularisation.findUniqueOrThrow({ where: { id: correction.data.id }, select: { requestedCheckIn: true, requestedCheckOut: true } })
      : null;
    ok(
      "an attendance correction's 9:30 am to 6:00 pm: 13:30 to 22:00 UTC",
      asked?.requestedCheckIn?.toISOString() === "2026-10-01T13:30:00.000Z" && asked?.requestedCheckOut?.toISOString() === "2026-10-01T22:00:00.000Z",
      errorOf(correction),
    );

    section("The notifications list's days");
    const morning = await db.notification.create({ data: { userId: boss.id, type: "VISIT_SCHEDULED", title: `${TAG} 1:00 am on the 5th`, createdAt: new Date("2026-10-05T05:00:00.000Z") }, select: { id: true } });
    const pastMidnight = await db.notification.create({ data: { userId: boss.id, type: "VISIT_SCHEDULED", title: `${TAG} 12:15 am on the 6th`, createdAt: new Date("2026-10-06T04:15:00.000Z") }, select: { id: true } });
    const inbox = await notifications.listNotifications({ page: 1, pageSize: 50, from: "2026-10-05", to: "2026-10-05" });
    const shown = new Set(inbox.rows.map((r) => r.id));
    ok("1:00 am on the 5th is in, 12:15 am on the 6th is out", shown.has(morning.id) && !shown.has(pastMidnight.id));
  });
  actor = null;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
