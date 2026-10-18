/**
 * check:call-report — Calls › Team report (src/lib/call-report.ts, src/actions/call-report.ts) against this
 * workspace's database, with a fixture whose answers are known (owner, 18 Oct 2026).
 *
 *   · Per person: calls made and taken, connected and the rate, talk time and the average connected call,
 *     the first and last call of the day (the middle value across days), what the Deskzo app logged and what
 *     still waits for a word, callbacks promised and overdue, and how fast new leads were first called.
 *   · Team totals and a count for each day.
 *   · Somebody who called lately but not in the period shows, with nothing.
 *   · Within the viewer's reach: a rep sees what the Calls list shows them; without Calls, no report.
 *   · A period longer than three months is cut to its last three; the page renders.
 *
 * The fixture's calls are a year and more ahead, where no real call is, so the totals are exact. Everything is
 * named ZZREPORT and removed at the end.
 *
 *   npm run check:call-report
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";
import { renderHtml } from "./lib/render-html";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";

const TAG = "ZZREPORT";
const MAIL = "@zzreport.invalid";
const ROLE = "ZZREPORT_NOTHING";
let browserUser: { id: string; name: string; email: string; role: string } | null = null;

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/headers") {
    return { headers: async () => new Headers({ host: "deskzo.localhost:3000" }), cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }) };
  }
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
      usePathname: () => "/calls/report",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  if (request === "@/lib/auth") return { auth: async () => (browserUser ? { user: browserUser, expires: "" } : null), signIn: async () => {}, signOut: async () => {}, handlers: {} };
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

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const companies = await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);
  await db.callLog.deleteMany({ where: { OR: [{ companyId: { in: companyIds } }, { userId: { in: ids } }] } });
  await db.task.deleteMany({ where: { OR: [{ companyId: { in: companyIds } }, { createdByUserId: { in: ids } }] } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.role.deleteMany({ where: { key: ROLE } });
}

const shift = (key: string, days: number) => new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { callingReport } = require("../src/actions/call-report") as typeof import("../src/actions/call-report");
  const lib = require("../src/lib/call-report") as typeof import("../src/lib/call-report");
  const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
  const { peopleReached } = require("../src/lib/authz/access") as typeof import("../src/lib/authz/access");
  const { moduleAvailableForTenant } = require("../src/lib/modules-access") as typeof import("../src/lib/modules-access");

  await cleanup();
  try {
    if (!(await moduleAvailableForTenant("calls")) || !(await moduleAvailableForTenant("leads"))) {
      ok("Calls and Leads are in this workspace's plan and switched on — the suite needs both", false);
      return;
    }
    const clock = await workspaceClock();

    section("Reading the figures");
    ok("9:15 am, 6:00 pm, nothing", lib.minuteOfDay(555) === "9:15 am" && lib.minuteOfDay(1080) === "6:00 pm" && lib.minuteOfDay(0) === "12:00 am" && lib.minuteOfDay(null) === "—");
    ok("15 min, 2 h 10 min, 3 days", lib.waited(15) === "15 min" && lib.waited(130) === "2 h 10 min" && lib.waited(3 * 1440) === "3 days" && lib.waited(null) === "—");
    ok("the middle value", lib.median([3, 1, 2]) === 2 && lib.median([1, 2, 3, 10]) === 3 && lib.median([]) === null);

    section("The team and their calls");
    // Days well ahead, where no real call is — the totals are the fixture's alone.
    const day1 = shift(clock.today(), 500);
    const day2 = shift(day1, 1);
    const at = (key: string, hour: number, minute: number) => {
      const [y, m, d] = key.split("-").map(Number);
      return clock.at(y!, m! - 1, d!, hour, minute);
    };
    const boss = await db.user.create({ data: { name: `${TAG} Boss`, email: `boss${MAIL}`, role: "ADMIN", passwordHash: "x".repeat(60) } });
    const a = await db.user.create({ data: { name: `${TAG} Rep A`, email: `a${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    const b = await db.user.create({ data: { name: `${TAG} Rep B`, email: `b${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    const c = await db.user.create({ data: { name: `${TAG} Rep C`, email: `c${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    const acme = await db.company.create({ data: { name: `${TAG} Acme`, normalizedName: `${TAG} acme`.toLowerCase(), createdById: a.id, ownerUserId: a.id } });
    const quiet = await db.company.create({ data: { name: `${TAG} Quiet`, normalizedName: `${TAG} quiet`.toLowerCase(), createdById: a.id, ownerUserId: a.id } });
    const theirs = await db.company.create({ data: { name: `${TAG} Theirs`, normalizedName: `${TAG} theirs`.toLowerCase(), createdById: b.id, ownerUserId: b.id } });
    const call = (userId: string, companyId: string, startedAt: Date, outcome: string, duration: number, extra: Record<string, unknown> = {}) =>
      db.callLog.create({ data: { userId, companyId, phoneNumber: "9000000000", outcome: outcome as never, startedAt, durationSeconds: duration, ...extra } });
    // Rep A: day 1 — 9:15 connected 2 min from the app (said how it went), 11:00 no answer from the app (not yet),
    // 17:45 taken and connected 1 min, a callback promised; day 2 — 10:00 connected 30 s, 18:00 busy.
    await call(a.id, acme.id, at(day1, 9, 15), "CONNECTED", 120, { source: "PHONE", reviewedAt: new Date() });
    await call(a.id, acme.id, at(day1, 11, 0), "NO_ANSWER", 0, { source: "PHONE" });
    await call(a.id, acme.id, at(day1, 17, 45), "CONNECTED", 60, { direction: "INBOUND", followUpAt: at(day2, 12, 0) });
    await call(a.id, acme.id, at(day2, 10, 0), "CONNECTED", 30);
    await call(a.id, acme.id, at(day2, 18, 0), "BUSY", 0);
    // A callback promised three weeks ago and never made: overdue, whatever the period.
    await call(a.id, acme.id, new Date(Date.now() - 21 * 86_400_000), "CALLBACK_REQUESTED", 40, { followUpAt: new Date(Date.now() - 2 * 86_400_000) });
    // Rep B: one call on day 1 at 8:30.
    await call(b.id, theirs.id, at(day1, 8, 30), "CONNECTED", 300);
    // Rep C: called ten days ago — one of the callers — and not in the period.
    await call(c.id, theirs.id, new Date(Date.now() - 10 * 86_400_000), "NO_ANSWER", 0);
    // Rep A's new leads: one at Acme at 9:00, first called at 9:15; one at Quiet at 12:00, never called.
    await db.lead.create({ data: { companyId: acme.id, title: `${TAG} called`, ownerUserId: a.id, createdAt: at(day1, 9, 0) } });
    await db.lead.create({ data: { companyId: quiet.id, title: `${TAG} waiting`, ownerUserId: a.id, createdAt: at(day1, 12, 0) } });
    ok("three reps, their customers, calls over two days and two new leads", true);

    section("As somebody who sees everyone's calls");
    browserUser = { id: boss.id, name: boss.name, email: boss.email, role: "ADMIN" };
    const report = (await callingReport({ from: day1, to: day2 }))!;
    const rowA = report.rows.find((r) => r.userId === a.id);
    const rowB = report.rows.find((r) => r.userId === b.id);
    const rowC = report.rows.find((r) => r.userId === c.id);
    ok("the period as asked, its two days", report.from === day1 && report.to === day2 && report.days.length === 2 && !report.clamped);
    ok(
      "Rep A: 5 calls (4 made, 1 taken), 3 connected — 60%",
      rowA?.calls === 5 && rowA.outgoing === 4 && rowA.incoming === 1 && rowA.connected === 3 && rowA.connectRate === 60,
      JSON.stringify(rowA && { calls: rowA.calls, out: rowA.outgoing, in: rowA.incoming, connected: rowA.connected, rate: rowA.connectRate }),
    );
    ok("  3 min 30 s on the phone, 70 s a connected call", rowA?.talkSeconds === 210 && rowA.averageSeconds === 70, `${rowA?.talkSeconds} ${rowA?.averageSeconds}`);
    ok("  usually starts at 9:38 and stops at 5:53 — the middle of 9:15/10:00 and 5:45/6:00", rowA?.firstCallMinute === 578 && rowA.lastCallMinute === 1073 && rowA.daysCalling === 2, `${rowA?.firstCallMinute} ${rowA?.lastCallMinute}`);
    ok("  2 from the app, 1 still waiting for a word", rowA?.fromApp === 2 && rowA.waitingForWord === 1);
    ok("  1 callback promised in the period, 1 overdue from before it", rowA?.callbacksPromised === 1 && rowA.callbacksOverdue === 1, `${rowA?.callbacksPromised} ${rowA?.callbacksOverdue}`);
    ok(
      "  2 new leads: one called in 15 min, one not yet",
      rowA?.leads?.new === 2 && rowA.leads.called === 1 && rowA.leads.withinHour === 1 && rowA.leads.notCalled === 1 && rowA.leads.medianMinutes === 15,
      JSON.stringify(rowA?.leads),
    );
    ok("Rep B: one call, connected, at 8:30", rowB?.calls === 1 && rowB.connected === 1 && rowB.firstCallMinute === 510 && rowB.leads?.new === 0);
    ok("Rep C, who called lately but not in the period: there, with nothing", rowC?.calls === 0 && rowC.firstCallMinute === null && rowC.talkSeconds === 0);
    ok("busiest first", report.rows.findIndex((r) => r.userId === a.id) < report.rows.findIndex((r) => r.userId === b.id) && report.rows.findIndex((r) => r.userId === b.id) < report.rows.findIndex((r) => r.userId === c.id));
    ok("the team: 6 calls, 4 connected, 8 min 30 s", report.totals.calls === 6 && report.totals.connected === 4 && report.totals.talkSeconds === 510, JSON.stringify({ calls: report.totals.calls, connected: report.totals.connected, talk: report.totals.talkSeconds }));
    ok("  each day: 4 calls (3 connected), then 2 (1 connected)", JSON.stringify(report.days) === JSON.stringify([{ day: day1, calls: 4, connected: 3 }, { day: day2, calls: 2, connected: 1 }]), JSON.stringify(report.days));
    const single = (await callingReport({ from: day1, to: day1 }))!;
    ok("one day: Rep A's first call at 9:15, last at 5:45", single.rows.find((r) => r.userId === a.id)?.firstCallMinute === 555 && single.rows.find((r) => r.userId === a.id)?.lastCallMinute === 1065);

    section("Within the viewer's reach");
    browserUser = { id: a.id, name: a.name, email: a.email, role: "SALES" };
    const reached = await peopleReached(a.id, "activities", "view");
    const own = (await callingReport({ from: day1, to: day2 }))!;
    ok(`a rep sees the people the Calls list shows them (${reached === null ? "everyone" : `${reached.length} people`})`, own.rows.every((r) => reached === null || reached.includes(r.userId)) && own.rows.some((r) => r.userId === a.id));
    ok("  their own figures the same as their manager sees them", own.rows.find((r) => r.userId === a.id)?.calls === 5);
    if (reached !== null && !reached.includes(b.id)) ok("  nobody else's calls in the team's totals", own.totals.calls === own.rows.reduce((t, r) => t + r.calls, 0) && !own.rows.some((r) => r.userId === b.id));
    await db.role.create({ data: { key: ROLE, name: `${TAG} nothing` } });
    const nobody = await db.user.create({ data: { name: `${TAG} Nobody`, email: `nobody${MAIL}`, role: ROLE, passwordHash: "x".repeat(60) } });
    browserUser = { id: nobody.id, name: nobody.name, email: nobody.email, role: ROLE };
    ok("without View calls: no report", (await callingReport({ from: day1, to: day2 })) === null);

    section("The period, and the page");
    browserUser = { id: boss.id, name: boss.name, email: boss.email, role: "ADMIN" };
    const long = (await callingReport({ from: shift(day2, -400), to: day2 }))!;
    ok("a period of over three months: its last three", long.clamped && long.days.length === lib.REPORT_MAX_DAYS && long.to === day2);
    const swapped = (await callingReport({ from: day2, to: day1 }))!;
    ok("from after to: read the right way round", swapped.from === day1 && swapped.to === day2);
    const today = (await callingReport({}))!;
    ok("no period: today", today.from === clock.today() && today.to === clock.today());
    const Page = (require("../src/app/(dashboard)/calls/report/page") as { default: (p: { searchParams: Promise<Record<string, string>> }) => Promise<unknown> }).default;
    const html = (await renderHtml((await Page({ searchParams: Promise.resolve({ from: day1, to: day2 }) })) as never)).replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
    ok("the page renders the team, the day's calling and the new leads", html.includes(`${TAG} Rep A`) && html.includes("Team report") && html.includes("9:38 am – 5:53 pm") && html.includes("first call in 15 min") && html.includes("1 not called yet"));
    const bare = await Page({ searchParams: Promise.resolve({}) }).then(
      () => "",
      (e: Error) => e.message,
    );
    ok("  opened with no period: sent to today's, so the period picker shows it", bare === `redirect /calls/report?from=${clock.today()}&to=${clock.today()}`, bare);
  } finally {
    await cleanup();
  }
}

main()
  .then(async () => {
    await db.$disconnect();
    console.log(failures === 0 ? "\nAll calling report checks passed." : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exit(1);
  });
