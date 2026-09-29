/**
 * Most active of the fortnight — the fortnightly awards on the wins wall, with their prizes.
 *
 *   · The arithmetic, without a database: fortnight boundaries in India time (month ends, leap years,
 *     the year's turn), the announcement window, the points, the cap on time, ties, the area leaders,
 *     and the words.
 *   · Through the real code, on a fortnight in March 2099 that nothing real touches: what each kind of
 *     work is worth and what is not counted (an admin's edits made while viewing as somebody, a call
 *     counted twice, ten saves of one record, a deal won and reopened, a visit only planned); then an
 *     announcement to each audience — everybody, managers, the winners — checked for who was told,
 *     who was not, and who gets the splash; exactly once however often and however concurrently it
 *     runs; and what each person can read afterwards on the awards page.
 *
 * Announcing to "everybody" really does write a notification for every active user, so every one the
 * run writes is removed in the finally — found by the probe names in its text. The award settings are
 * global and the module switches are too: both are saved first and put back after.
 *
 *   npm run check:activity-awards
 */
import "dotenv/config";
import Module from "node:module";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { type AwardAudience } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import {
  ACTIVE_HOURS_CAP,
  NO_ACTIVITY,
  announcementCopy,
  announcementDue,
  areaLeader,
  fortnightContaining,
  previousFortnight,
  rank,
  score,
  shortLabel,
  winnerCopy,
} from "../src/lib/performance/awards";
import { momentsFor } from "../src/lib/hr/celebrations";
import { istMidnight } from "../src/lib/india-time";
import { PEOPLE_ONLY } from "../src/lib/people";

let actor = { id: "", name: "Zzprobe" };
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actor.id, role: "SALES", name: actor.name, email: `x${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user() };
  }
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => "/performance/awards",
    };
  }
  // Nothing in a check goes on the wire.
  if (request === "@/lib/email") return { sendEmailNotification: async () => {} };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_AWARDS";
const NAME = "Zzprobe";
const MAIL = "@zzprobe-awards.invalid";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

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

/** The fortnights this run announces. None may exist before it starts. */
const PERIODS = ["2099-03-A", "2099-05-A"];

/**
 * Every notification this run's awards wrote — including the ones to real users: anything naming the
 * probe people, and anything about the probe's empty May fortnight, which names nobody.
 */
const suiteStart = new Date();
const probeNotes = {
  type: "ACTIVITY_AWARD" as const,
  OR: [{ title: { contains: NAME } }, { message: { contains: NAME } }, { title: { contains: "1–15 May" }, createdAt: { gte: suiteStart } }],
};

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const companies = await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);
  await db.notification.deleteMany({ where: probeNotes });
  await db.celebration.deleteMany({ where: { OR: [{ occasionKey: { startsWith: "active:2099-" } }, { subjectUserId: { in: userIds } }] } });
  await db.celebrationSeen.deleteMany({ where: { userId: { in: userIds } } });
  await db.activityAward.deleteMany({ where: { period: { in: PERIODS } } });
  await db.prizeWinner.deleteMany({ where: { period: { in: PERIODS } } });
  await db.prize.deleteMany({ where: { period: { in: PERIODS } } });
  await db.callLog.deleteMany({ where: { userId: { in: userIds } } });
  await db.visit.deleteMany({ where: { userId: { in: userIds } } });
  await db.ticket.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.activity.deleteMany({ where: { userId: { in: userIds } } });
  await db.lead.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.userDailyActivity.deleteMany({ where: { userId: { in: userIds } } });
  await db.notification.deleteMany({ where: { userId: { in: userIds } } });
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { impersonatedByUserId: { in: userIds } }] } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  // ─────────────────────────────────────────────────────────────────────────────
  section("Fortnights, in India time");

  const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(istMidnight(y, m, d).getTime() + h * HOUR + min * 60_000);

  const a = fortnightContaining(at(2026, 8, 15, 23, 59));
  const b = fortnightContaining(at(2026, 8, 16, 0, 0));
  ok("the 15th at 23:59 is the first half, the 16th at midnight the second", a.key === "2026-09-A" && b.key === "2026-09-B", `${a.key} / ${b.key}`);
  ok("  the first half starts at India midnight on the 1st, not UTC midnight", a.from.toISOString() === "2026-08-31T18:30:00.000Z" && a.to.getTime() === b.from.getTime(), a.from.toISOString());
  ok("  and ends where the second begins — half-open, so no moment is in both", a.to.toISOString() === "2026-09-15T18:30:00.000Z");
  ok("the second half runs to the month's end", b.label === "16–30 September 2026" && b.lastDay.toISOString().slice(0, 10) === "2026-09-30" && b.to.getTime() === istMidnight(2026, 9, 1).getTime(), b.label);
  ok("  to the 29th in a leap February", fortnightContaining(at(2028, 1, 20)).label === "16–29 February 2028" && fortnightContaining(at(2027, 1, 20)).label === "16–28 February 2027");
  ok("  and its date-only days are calendar days, for date columns", a.firstDay.toISOString() === "2026-09-01T00:00:00.000Z" && a.lastDay.toISOString() === "2026-09-15T00:00:00.000Z");
  ok("the one before the 16th is the 1st–15th; the one before the 1st is last month's second half", previousFortnight(at(2026, 8, 20)).key === "2026-09-A" && previousFortnight(at(2026, 8, 3)).key === "2026-08-B");
  ok("  across the year's turn", previousFortnight(at(2027, 0, 1, 10)).key === "2026-12-B" && previousFortnight(at(2027, 0, 1, 10)).label === "16–31 December 2026");
  ok("the short label, for a notification", shortLabel(a) === "1–15 Sept" || shortLabel(a) === "1–15 Sep", shortLabel(a));

  ok("announced from 9 am on the day after it closes", announcementDue(at(2026, 8, 16, 9))?.key === "2026-09-A" && announcementDue(at(2026, 9, 1, 9, 30))?.key === "2026-09-B");
  ok("  not at 8:59 — nobody wakes to a leaderboard", announcementDue(at(2026, 8, 16, 8, 59)) === null);
  ok("  still on the fourth day, not on the fifth", announcementDue(at(2026, 8, 19, 23, 59))?.key === "2026-09-A" && announcementDue(at(2026, 8, 20, 0, 0)) === null);
  ok("  and not mid-fortnight — switched on on the 24th, the 1st–15th stays unannounced", announcementDue(at(2026, 8, 24, 12)) === null);

  // ─────────────────────────────────────────────────────────────────────────────
  section("Points");

  const c = (over: Partial<typeof NO_ACTIVITY>) => ({ ...NO_ACTIVITY, ...over });
  const s1 = score(c({ created: 3, edited: 2, calls: 5, visits: 2, dealsWon: 1, activeSeconds: 3 * 3600 + 1800 }));
  ok("each kind of work is worth its points", s1.work === 3 * 2 + 2 * 1 + 5 * 2 + 2 * 8 + 15 && s1.sales === 5 * 2 + 2 * 8 + 15 && s1.support === 0, JSON.stringify(s1));
  ok("  time is a point an hour, whole hours only", s1.time === 3 && s1.points === s1.work + 3);
  const s2 = score(c({ ticketsResolved: 6, ticketsInSla: 5, activeSeconds: 40 * 3600 }));
  ok("a ticket inside its SLA is worth more than one outside it", s2.support === 6 * 5 + 5 * 3 && s2.sales === 0);
  ok(`  and time stops counting at ${ACTIVE_HOURS_CAP} points however long the tab was open`, s2.time === ACTIVE_HOURS_CAP, s2.time);
  ok("  so time is worth less than a single deal", ACTIVE_HOURS_CAP < score(c({ dealsWon: 1 })).points);

  const ranked = rank([
    { userId: "idle", name: "Idle", counts: c({ activeSeconds: 80 * 3600 }) },
    { userId: "a-bina", name: "Bina", counts: c({ calls: 5, activeSeconds: 2 * 3600 }) },
    { userId: "z-arun", name: "Arun", counts: c({ calls: 5, activeSeconds: 2 * 3600 }) },
    { userId: "t", name: "Tara", counts: c({ calls: 4, activeSeconds: 4 * 3600 }) },
    { userId: "w", name: "Wes", counts: c({ calls: 6 }) },
  ]);
  ok("nobody is ranked for being logged in", !ranked.some((r) => r.userId === "idle"));
  ok("equal points go to more work before more time", ranked.findIndex((r) => r.userId === "w") < ranked.findIndex((r) => r.userId === "t"), ranked.map((r) => `${r.name}:${r.points}/${r.work}`).join(" "));
  ok("  and a dead heat to the alphabet, never to row order or id", ranked.findIndex((r) => r.userId === "z-arun") < ranked.findIndex((r) => r.userId === "a-bina"));
  const areaRank = rank([
    { userId: "s", name: "Sales", counts: c({ visits: 3 }) },
    { userId: "x", name: "Busy", counts: c({ created: 30, visits: 1 }) },
    { userId: "h", name: "Help", counts: c({ ticketsResolved: 1 }) },
  ]);
  ok("the sales leader is by sales points, not overall rank", areaRank[0]!.userId === "x" && areaLeader(areaRank, "sales")?.userId === "s");
  ok("  and there is no support leader when nobody resolved anything", areaLeader(rank([{ userId: "s", name: "S", counts: c({ calls: 1 }) }]), "support") === null && areaLeader(areaRank, "support")?.userId === "h");

  // ─────────────────────────────────────────────────────────────────────────────
  section("The words");

  const e = (name: string, points: number) => ({ userId: name, name, points, sales: 0, support: 0 });
  const everybody = announcementCopy({ label: "1–15 Sep", winners: [e("Priya", 142), e("Rahul", 120), e("Anita", 98)], sales: e("Rahul", 120), support: e("Sam", 60) });
  ok("everybody is told the winner in the title", everybody.title === "Most active, 1–15 Sep: Priya", everybody.title);
  ok("  and the runners-up and area leaders in the line", everybody.message === "Priya — 142 points. Then Rahul (120), Anita (98). Sales: Rahul. Support: Sam.", everybody.message);
  const note = winnerCopy({ label: "1–15 Sep", entry: e("Priya", 142), place: 1, ledSales: true, ledSupport: false });
  ok("a winner's note says every place they earned, once", note.title === "You were the most active, 1–15 Sep" && note.message === "You were the most active person and the most active in sales for 1–15 Sep, with 142 points. Thank you.", note.message);
  ok("  a runner-up is told their place", winnerCopy({ label: "L", entry: e("R", 1), place: 2, ledSales: false, ledSupport: false }).message.startsWith("You were the second most active person"));
  ok("  and an area leader outside the top places is still told", winnerCopy({ label: "L", entry: e("S", 1), place: null, ledSales: false, ledSupport: true }).message.startsWith("You were the most active in support"));

  // ─────────────────────────────────────────────────────────────────────────────
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const announce = require("../src/lib/performance/announce") as typeof import("../src/lib/performance/announce");
  const awards = require("../src/actions/activity-awards") as typeof import("../src/actions/activity-awards");
  const { todaysMoments } = require("../src/lib/hr/today") as typeof import("../src/lib/hr/today");
  const prizes = require("../src/actions/prizes") as typeof import("../src/actions/prizes");
  const AwardsPage = (require("../src/app/(dashboard)/wins/most-active/page") as { default: () => Promise<ReactElement> }).default;
  const SettingsPage = (require("../src/app/(dashboard)/wins/settings/page") as { default: () => Promise<ReactElement> }).default;
  const html = async (el: Promise<ReactElement>) => renderToStaticMarkup((await resolveAsync(await el)) as ReactElement);

  const existing = await db.activityAward.findMany({ where: { period: { in: PERIODS } }, select: { period: true } });
  if (existing.length) throw new Error(`Refusing to run: ${existing.map((r) => r.period).join(", ")} already exists and is not this check's.`);
  const priorSettings = await db.activityAwardSettings.findUnique({ where: { id: "global" } });
  const priorWins = await db.salesCelebrationSettings.findUnique({ where: { id: "global" } });
  const priorModules = await db.systemModule.findMany({ where: { key: { in: ["hr", "wins"] } } });
  await cleanup();
  try {
    const make = (name: string, grants: Record<string, boolean>, active = true) =>
      db.user.create({
        data: {
          name: `${NAME} ${name}`,
          email: `${name.toLowerCase()}${MAIL}`,
          role: "SALES",
          active,
          passwordHash: "x".repeat(60),
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
      });
    const noView = { "performance.view": false, "wins.manage": false };
    const ana = await make("Ana", noView);
    const raj = await make("Raj", noView);
    const meh = await make("Meh", noView);
    const idle = await make("Idle", noView);
    const outsider = await make("Outsider", noView);
    const gone = await make("Gone", noView, false);
    const boss = await make("Boss", { "performance.view": true, "wins.manage": true });
    const probeIds = new Set([ana, raj, meh, idle, outsider, gone, boss].map((u) => u.id));
    const as = (u: { id: string; name: string }) => {
      actor = { id: u.id, name: u.name };
    };
    // The awards are part of the wins wall now: on for the run, put back after.
    await db.systemModule.upsert({ where: { key: "wins" }, create: { key: "wins", enabled: true }, update: { enabled: true } });

    // ───────────────────────────────────────────────────────────────────────────
    section("Settings");

    as(outsider);
    ok("somebody without the permission can't change the awards", !(await awards.saveActivityAwardSettings({ enabled: true, audience: "EVERYONE", topCount: 3, splash: true })).ok);
    as(boss);
    ok("  the person with it can't name eleven", !(await awards.saveActivityAwardSettings({ enabled: true, audience: "EVERYONE", topCount: 11, splash: true })).ok);
    ok("  nor an audience that isn't one", !(await awards.saveActivityAwardSettings({ enabled: true, audience: "PUBLIC" as AwardAudience, topCount: 3, splash: true })).ok);
    const saved = await awards.saveActivityAwardSettings({ enabled: true, audience: "EVERYONE", topCount: 3, splash: true });
    ok("  but can set them", saved.ok && (await announce.awardSettings()).audience === "EVERYONE", saved.ok ? "" : saved.error);

    // ───────────────────────────────────────────────────────────────────────────
    section("What counts, in 1–15 March 2099");

    // Inside the fortnight: the 3rd to the 12th. Outside: the last day of February and the 16th.
    const d = (day: number, h = 11) => at(2099, 2, day, h);
    const before = at(2099, 1, 28, 20);
    const after = at(2099, 2, 16, 1);
    const company = await db.company.create({ data: { name: `${TAG} Acme`, normalizedName: `${TAG} acme`.toLowerCase(), createdById: ana.id, relationshipType: "CLIENT", stage: "CUSTOMER" } as never });
    const audit = (userId: string, action: "CREATE" | "UPDATE" | "DELETE", entityType: string, entityId: string, createdAt: Date, impersonatedByUserId: string | null = null) =>
      db.auditLog.create({ data: { userId, action, entityType, entityId, entityLabel: TAG, createdAt, impersonatedByUserId } });

    // Ana — sales. 3 records created, one record saved four times on the 4th and once on the 5th.
    for (const i of [1, 2, 3]) await audit(ana.id, "CREATE", "Company", `${TAG}-c${i}`, d(3));
    for (const h of [10, 11, 12, 13]) await audit(ana.id, "UPDATE", "Company", `${TAG}-c1`, d(4, h));
    await audit(ana.id, "UPDATE", "Company", `${TAG}-c1`, d(5));
    // Not hers, or not a record: an admin's change while viewing as her, a call's audit row, a delete,
    // and work either side of the fortnight.
    await audit(ana.id, "CREATE", "Lead", `${TAG}-imp`, d(6), boss.id);
    await audit(ana.id, "CREATE", "CallLog", `${TAG}-call`, d(6));
    await audit(ana.id, "CREATE", "Visit", `${TAG}-visit`, d(6));
    await audit(ana.id, "DELETE", "Company", `${TAG}-c3`, d(6));
    await audit(ana.id, "CREATE", "Company", `${TAG}-before`, before);
    await audit(ana.id, "CREATE", "Company", `${TAG}-after`, after);
    // 5 calls in, 1 out.
    for (const day of [3, 4, 5, 6, 7]) await db.callLog.create({ data: { companyId: company.id, phoneNumber: "9999999999", outcome: "CONNECTED", startedAt: d(day), userId: ana.id } });
    await db.callLog.create({ data: { companyId: company.id, phoneNumber: "9999999999", outcome: "CONNECTED", startedAt: after, userId: ana.id } });
    // 2 visits completed; one only planned; one completed after the fortnight.
    await db.visit.create({ data: { companyId: company.id, userId: ana.id, scheduledFor: d(8), status: "COMPLETED", checkInAt: d(8, 10), checkOutAt: d(8, 12) } });
    await db.visit.create({ data: { companyId: company.id, userId: ana.id, scheduledFor: d(9), status: "COMPLETED" } });
    await db.visit.create({ data: { companyId: company.id, userId: ana.id, scheduledFor: d(10), status: "PLANNED" } });
    await db.visit.create({ data: { companyId: company.id, userId: ana.id, scheduledFor: d(15), status: "COMPLETED", checkInAt: d(15, 22), checkOutAt: after } });
    // A deal Meh moved to Won but Ana owns — hers. One won and then reopened — nobody's.
    const won = await db.lead.create({ data: { companyId: company.id, title: `${TAG} Won`, status: "WON", ownerUserId: ana.id } });
    const reopened = await db.lead.create({ data: { companyId: company.id, title: `${TAG} Reopened`, status: "NEGOTIATION", ownerUserId: ana.id } });
    await db.activity.create({ data: { leadId: won.id, userId: meh.id, type: "STAGE_CHANGE", notes: "Status changed from NEGOTIATION to WON", occurredAt: d(10) } });
    await db.activity.create({ data: { leadId: won.id, userId: meh.id, type: "STAGE_CHANGE", notes: "Status changed from NEGOTIATION to WON", occurredAt: d(11) } });
    await db.activity.create({ data: { leadId: reopened.id, userId: ana.id, type: "STAGE_CHANGE", notes: "Status changed from NEGOTIATION to WON", occurredAt: d(10) } });
    await db.userDailyActivity.create({ data: { userId: ana.id, date: new Date(Date.UTC(2099, 2, 5)), activeSeconds: 3 * 3600 + 1200, lastHeartbeatAt: d(5) } });

    // Raj — support. 6 tickets resolved, 5 inside their SLA; one resolved after the fortnight; one
    // resolved but nobody's.
    const ticket = (resolvedAt: Date, hoursTaken: number, assignedToUserId: string | null, priority: "MEDIUM" | "URGENT" = "MEDIUM") =>
      db.ticket.create({
        data: { companyId: company.id, title: `${TAG} ticket`, createdByUserId: raj.id, assignedToUserId, priority, status: "RESOLVED", createdAt: new Date(resolvedAt.getTime() - hoursTaken * HOUR), resolvedAt },
      });
    for (const day of [3, 4, 5, 6, 7]) await ticket(d(day), 10, raj.id);
    await ticket(d(8), 5, raj.id, "URGENT"); // 5 hours for a 4-hour SLA
    await ticket(after, 1, raj.id);
    await ticket(d(9), 1, null);
    await audit(raj.id, "CREATE", "Ticket", `${TAG}-t`, d(3));
    for (const day of [3, 4, 5, 6]) await db.userDailyActivity.create({ data: { userId: raj.id, date: new Date(Date.UTC(2099, 2, day)), activeSeconds: 10 * 3600, lastHeartbeatAt: d(day) } });
    // The day before the fortnight, in a date column — not counted.
    await db.userDailyActivity.create({ data: { userId: raj.id, date: new Date(Date.UTC(2099, 1, 28)), activeSeconds: 10 * 3600, lastHeartbeatAt: before } });

    // Meh — one record. Idle — all day in the app, nothing done. Gone — plenty done, but has left.
    await audit(meh.id, "CREATE", "Contact", `${TAG}-m`, d(12));
    await db.userDailyActivity.create({ data: { userId: meh.id, date: new Date(Date.UTC(2099, 2, 15)), activeSeconds: 3600, lastHeartbeatAt: d(15, 20) } });
    await db.userDailyActivity.create({ data: { userId: idle.id, date: new Date(Date.UTC(2099, 2, 7)), activeSeconds: 12 * 3600, lastHeartbeatAt: d(7) } });
    for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) await audit(gone.id, "CREATE", "Company", `${TAG}-g${i}`, d(4));

    const march = fortnightContaining(d(5));
    const counts = await announce.activityCounts(march);
    const anaCounts = counts.get(ana.id);
    ok("records created — not a call's or a visit's audit row, not an admin's viewing as her, not outside the fortnight", anaCounts?.created === 3, anaCounts?.created);
    ok("  five saves of one record on one day are one edit; the next day is another", anaCounts?.edited === 2, anaCounts?.edited);
    ok("calls in the fortnight", anaCounts?.calls === 5, anaCounts?.calls);
    ok("  visits completed — with or without a check-out — not planned, not after", anaCounts?.visits === 2, anaCounts?.visits);
    ok("  a deal won, once, to its owner rather than whoever moved it — and not one reopened since", anaCounts?.dealsWon === 1 && (counts.get(meh.id)?.dealsWon ?? 0) === 0, `${anaCounts?.dealsWon} / ${counts.get(meh.id)?.dealsWon}`);
    const rajCounts = counts.get(raj.id);
    ok("tickets resolved in the fortnight, and which were inside their SLA", rajCounts?.ticketsResolved === 6 && rajCounts?.ticketsInSla === 5, `${rajCounts?.ticketsResolved} / ${rajCounts?.ticketsInSla}`);
    ok("  active time from the fortnight's own calendar days", rajCounts?.activeSeconds === 40 * 3600, rajCounts?.activeSeconds);
    ok("  its last calendar day included", counts.get(meh.id)?.activeSeconds === 3600, counts.get(meh.id)?.activeSeconds);

    const standings = await announce.standingsFor(march);
    const strangers = standings.filter((s) => !probeIds.has(s.userId));
    if (strangers.length) throw new Error(`Something real is recorded in March 2099 (${strangers.length} people) — this check needs that fortnight to itself.`);
    ok("the ranking: Raj, then Ana, then Meh", standings.map((s) => s.userId).join() === [raj.id, ana.id, meh.id].join(), standings.map((s) => `${s.name}:${s.points}`).join(" "));
    ok("  Raj on 45 support + 2 + the 10-point time cap", standings[0]?.points === 57 && standings[0]?.time === ACTIVE_HOURS_CAP, standings[0]?.points);
    ok("  Ana on 41 sales + 8 records + 3 hours", standings[1]?.points === 52 && standings[1]?.sales === 41, standings[1]?.points);
    ok("  nobody for time alone, nobody who has left", !standings.some((s) => s.userId === idle.id || s.userId === gone.id));

    // ───────────────────────────────────────────────────────────────────────────
    section("When it is announced");

    const morning = at(2099, 2, 16, 10);
    ok("not before 9 am on the 16th", (await announce.announceActivityAwards(at(2099, 2, 16, 8))).announced === null && !(await db.activityAward.findUnique({ where: { period: "2099-03-A" } })));
    await db.activityAwardSettings.update({ where: { id: "global" }, data: { enabled: false } });
    ok("  nor at all while switched off", (await announce.announceActivityAwards(morning)).announced === null && !(await db.activityAward.findUnique({ where: { period: "2099-03-A" } })));
    await db.activityAwardSettings.update({ where: { id: "global" }, data: { enabled: true } });
    await db.systemModule.update({ where: { key: "wins" }, data: { enabled: false } });
    ok("  nor while the wins module is switched off", (await announce.announceActivityAwards(morning)).announced === null && !(await db.activityAward.findUnique({ where: { period: "2099-03-A" } })));
    await db.systemModule.update({ where: { key: "wins" }, data: { enabled: true } });

    // Prizes planned for this fortnight, every slot — so whatever standing prizes the real list holds,
    // this fortnight's are these.
    const GOLD_IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const SALES_IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const PRIZE_NAMES = { "1": "ZZ Gold", "2": "ZZ Silver", "3": "ZZ Bronze", sales: "ZZ Sales prize", support: "ZZ Support prize" } as const;
    for (const [slot, name] of Object.entries(PRIZE_NAMES)) {
      await db.prize.create({ data: { race: "MOST_ACTIVE", period: "2099-03-A", slot, name, imageDataUrl: slot === "1" ? GOLD_IMG : slot === "sales" ? SALES_IMG : null } });
    }
    const hall = async () => ((await prizes.getHallOfFame())?.rows ?? []).filter((r) => r.period === "2099-03-A");

    // A winner's own note doesn't name them ("You were the most active…"), so the probe people's notes
    // are found by who they went to, and everybody else's by the probe names in them.
    const notesTo = async (userId: string) => db.notification.findMany({ where: { userId, type: "ACTIVITY_AWARD" }, select: { title: true, message: true, link: true } });
    const everyNote = () =>
      db.notification.findMany({ where: { OR: [probeNotes, { type: "ACTIVITY_AWARD", userId: { in: [...probeIds] } }] }, select: { userId: true, title: true } });
    const reset = async () => {
      await db.notification.deleteMany({ where: { OR: [probeNotes, { type: "ACTIVITY_AWARD", userId: { in: [...probeIds] } }] } });
      await db.celebration.deleteMany({ where: { occasionKey: { startsWith: "active:2099-" } } });
      await db.activityAward.deleteMany({ where: { period: { in: PERIODS } } });
      await db.prizeWinner.deleteMany({ where: { period: { in: PERIODS } } });
    };

    // ───────────────────────────────────────────────────────────────────────────
    section("To everybody");

    const runs = await Promise.all([1, 2, 3].map(() => announce.announceActivityAwards(morning)));
    ok("three at once announce it once", runs.filter((r) => r.announced === "2099-03-A").length === 1, runs.map((r) => r.announced).join());
    ok("  and a fourth later says nothing new", (await announce.announceActivityAwards(new Date(morning.getTime() + HOUR))).announced === null);
    // People only: this is the raw client, which also sees the workspace's Automation account (never notified).
    const activeCount = await db.user.count({ where: { active: true, ...PEOPLE_ONLY } });
    const all = await everyNote();
    const perPerson = new Map<string, number>();
    for (const n of all) perPerson.set(n.userId, (perPerson.get(n.userId) ?? 0) + 1);
    ok("everybody still here is told, once each", [...perPerson.values()].every((n) => n === 1) && perPerson.size === activeCount && perPerson.has(outsider.id) && perPerson.has(idle.id), `${perPerson.size} of ${activeCount}`);
    ok("  but not somebody who has left", !perPerson.has(gone.id));
    const toOutsider = (await notesTo(outsider.id))[0];
    ok("  the rest of us hear who won, and are sent to the wins wall", toOutsider?.title.startsWith(`Most active, 1–15 `) === true && toOutsider.title.endsWith(`${NAME} Raj`) && toOutsider.link === "/wins/most-active", toOutsider?.title);
    ok("  with what each place wins", toOutsider?.message?.startsWith(`${NAME} Raj — 57 points, wins ZZ Gold.`) === true, toOutsider?.message);
    ok("  the runners-up and the area leaders, with theirs", toOutsider?.message?.includes(`Then ${NAME} Ana (52, ZZ Silver), ${NAME} Meh (3, ZZ Bronze).`) === true && toOutsider.message.includes(`Sales: ${NAME} Ana (ZZ Sales prize). Support: ${NAME} Raj (ZZ Support prize).`), toOutsider?.message);
    const toAna = await notesTo(ana.id);
    ok("each winner gets a note of their own instead", toAna.length === 1 && toAna[0]!.message?.startsWith("You were the second most active person and the most active in sales") === true, toAna[0]?.message);
    ok("  naming everything they win — second place and the sales prize", toAna[0]?.message?.includes("You win ZZ Silver and ZZ Sales prize.") === true, toAna[0]?.message);
    ok("  Raj is told he was first and led support", (await notesTo(raj.id))[0]?.title.startsWith("You were the most active") === true && (await notesTo(raj.id))[0]?.message?.includes("You win ZZ Gold and ZZ Support prize.") === true);
    const splash = await db.celebration.findUnique({ where: { occasionKey: "active:2099-03-A" } });
    ok("the whole company gets the splash, about the winner", splash?.audience === "EVERYONE" && splash.splashFor === "EVERYONE" && splash.subjectUserId === raj.id && splash.source === "MOST_ACTIVE", splash?.splashFor);
    ok("  with the first prize's picture on it", splash?.imageDataUrl === GOLD_IMG && splash.message?.includes("wins ZZ Gold") === true);
    ok("  from the day it is announced, for two days", splash?.startsOn.toISOString().slice(0, 10) === "2099-03-16" && splash.endsOn.toISOString().slice(0, 10) === "2099-03-17");
    const stored = await db.activityAward.findUnique({ where: { period: "2099-03-A" } });
    ok("the result is kept as it was announced", stored?.audience === "EVERYONE" && stored.label === "1–15 March 2099" && (stored.overall as { named: number }).named === 3);
    const hallRows = await db.prizeWinner.findMany({ where: { race: "MOST_ACTIVE", period: "2099-03-A" }, orderBy: { slot: "asc" } });
    const bySlot = Object.fromEntries(hallRows.map((w) => [w.slot, w]));
    ok(
      "the hall of fame gets every place and area leader, with the prize each won",
      hallRows.length === 5 && bySlot["1"]?.userId === raj.id && bySlot["1"]?.prizeName === "ZZ Gold" && bySlot["1"]?.prizeImage === GOLD_IMG && bySlot["2"]?.userId === ana.id && bySlot.sales?.userId === ana.id && bySlot.sales?.prizeName === "ZZ Sales prize" && bySlot.support?.userId === raj.id,
      hallRows.map((w) => `${w.slot}:${w.prizeName}`).join(" "),
    );
    ok("  scored in points — overall for a place, the area's for an area", Number(bySlot["1"]?.score) === 57 && Number(bySlot.sales?.score) === 41 && Number(bySlot.support?.score) === 45);
    await db.prize.update({ where: { race_period_slot: { race: "MOST_ACTIVE", period: "2099-03-A", slot: "1" } }, data: { name: "ZZ Gold, renamed" } });
    ok("  and a prize renamed afterwards doesn't change what was won", (await db.prizeWinner.findFirst({ where: { race: "MOST_ACTIVE", period: "2099-03-A", slot: "1" } }))?.prizeName === "ZZ Gold");
    await db.prize.update({ where: { race_period_slot: { race: "MOST_ACTIVE", period: "2099-03-A", slot: "1" } }, data: { name: "ZZ Gold" } });
    as(outsider);
    ok("told to everybody, anybody reads it in the hall of fame", (await hall()).length === 5);

    // What each person can read afterwards.
    let view = (await awards.getActivityAwards())!.history.find((h) => h.period === "2099-03-A");
    ok("anybody can read an award told to everybody — the winners, not the ranking", view?.winners.length === 3 && view.ranking === null && view.sales?.userId === ana.id && !view.mine);
    as(boss);
    view = (await awards.getActivityAwards())!.history.find((h) => h.period === "2099-03-A");
    ok("  somebody who can see team performance gets the ranking behind it", view?.ranking?.length === 3 && view.ranking[0]!.counts.ticketsResolved === 6);
    const bossPage = await html(AwardsPage());
    ok("the page, for them: the full ranking and how points work — settings live on their own tab now", bossPage.includes("The full ranking") && bossPage.includes("How the points work") && bossPage.includes("1–15 March 2099") && !bossPage.includes("Who hears about it"));
    const settingsPage = await html(SettingsPage());
    ok("  the settings tab has the award settings and both prize lists", settingsPage.includes("Who hears about it") && settingsPage.includes("Prizes — top sellers of the month") && settingsPage.includes("Prizes — most active of the fortnight"));
    as(outsider);
    const outsiderPage = await html(AwardsPage());
    ok("  for anybody else: the winners, their own tally, and no ranking", outsiderPage.includes(`${NAME} Raj`) && outsiderPage.includes("Your points so far") && !outsiderPage.includes("The full ranking") && !outsiderPage.includes("What for"));
    ok("  and not the settings tab", !(await html(SettingsPage())).includes("Who hears about it"));
    ok("  and not this fortnight's race either — only their own place in it", (await awards.getActivityAwards())!.current.standings === null);

    // ───────────────────────────────────────────────────────────────────────────
    section("To managers only");

    await reset();
    await db.activityAwardSettings.update({ where: { id: "global" }, data: { audience: "MANAGERS" } });
    ok("announced", (await announce.announceActivityAwards(morning)).announced === "2099-03-A");
    const managerNotes = await everyNote();
    ok("the people who can see team performance are told", (await notesTo(boss.id)).length === 1);
    ok("  nobody else — not even the winners", (await notesTo(outsider.id)).length === 0 && (await notesTo(raj.id)).length === 0 && (await notesTo(ana.id)).length === 0, managerNotes.length);
    ok("  and nobody gets a splash", (await db.celebration.count({ where: { occasionKey: { startsWith: "active:2099-" } } })) === 0);
    as(ana);
    ok("afterwards, a winner who is not a manager can't read it either", !(await awards.getActivityAwards())!.history.some((h) => h.period === "2099-03-A"));
    ok("  nor find it in the hall of fame", (await hall()).length === 0);
    as(boss);
    ok("  a manager can — and sees who to hand the prizes to", (await awards.getActivityAwards())!.history.some((h) => h.period === "2099-03-A") && (await hall()).length === 5);

    // ───────────────────────────────────────────────────────────────────────────
    section("To the winners only");

    await reset();
    await db.activityAwardSettings.update({ where: { id: "global" }, data: { audience: "WINNERS", topCount: 1 } });
    ok("announced", (await announce.announceActivityAwards(morning)).announced === "2099-03-A");
    const winnerNotes = await everyNote();
    ok("with one named overall, the winner and the sales leader are told — two notes, nobody else", winnerNotes.length === 2 && winnerNotes.every((n) => n.userId === raj.id || n.userId === ana.id), winnerNotes.map((n) => n.userId === raj.id ? "raj" : n.userId === ana.id ? "ana" : "?").join());
    ok("  Ana, not in the top one, is told she led sales", (await notesTo(ana.id))[0]?.message?.startsWith("You were the most active in sales") === true);
    const personal = await db.celebration.findMany({ where: { occasionKey: { startsWith: "active:2099-03-A:" } } });
    ok("each winner gets a splash of their own", personal.length === 2 && personal.every((p) => p.audience === "PERSON" && p.splashFor === "SUBJECT"));
    ok("  with a picture of their own prize", personal.find((p) => p.subjectUserId === ana.id)?.imageDataUrl === SALES_IMG && personal.find((p) => p.subjectUserId === raj.id)?.imageDataUrl === GOLD_IMG);
    const stored2 = personal.map((p) => ({ ...p, startsOn: new Date(Date.UTC(2099, 2, 16)), endsOn: new Date(Date.UTC(2099, 2, 16)) }));
    const seenBy = (userId: string) => momentsFor({ today: new Date(Date.UTC(2099, 2, 16)), viewer: { userId, departmentId: null }, people: [], holidays: [], seen: [], celebrations: stored2 });
    ok("  which nobody else sees", seenBy(outsider.id).length === 0 && seenBy(ana.id).length === 1 && seenBy(ana.id)[0]!.splash === true && seenBy(ana.id)[0]!.confetti === true);
    as(ana);
    view = (await awards.getActivityAwards())!.history.find((h) => h.period === "2099-03-A");
    ok("afterwards a winner reads their own line and nobody else's", view?.mine === true && view.winners.length === 0 && view.sales?.userId === ana.id && view.support === null);
    const anasHall = await hall();
    ok("  in the hall of fame too", anasHall.length === 1 && anasHall[0]!.userId === ana.id && anasHall[0]!.prizeName === "ZZ Sales prize", anasHall.map((r) => r.slot).join());
    as(outsider);
    ok("  and anybody else reads nothing", !(await awards.getActivityAwards())!.history.some((h) => h.period === "2099-03-A") && (await hall()).length === 0);

    await reset();
    await db.activityAwardSettings.update({ where: { id: "global" }, data: { audience: "EVERYONE", topCount: 3, splash: false } });
    await announce.announceActivityAwards(morning);
    ok("with the splash off, everybody is told and nobody is splashed", (await everyNote()).length > 0 && (await db.celebration.count({ where: { occasionKey: { startsWith: "active:2099-" } } })) === 0);

    // ───────────────────────────────────────────────────────────────────────────
    section("A fortnight with nothing in it");

    ok("is recorded", (await announce.announceActivityAwards(at(2099, 4, 16, 10))).announced === "2099-05-A" && !!(await db.activityAward.findUnique({ where: { period: "2099-05-A" } })));
    ok("  and nobody is told about it", (await db.notification.count({ where: { type: "ACTIVITY_AWARD", title: { contains: "1–15 May" }, createdAt: { gte: suiteStart } } })) === 0);

    // ───────────────────────────────────────────────────────────────────────────
    section("The greeting");

    // An award splash is part of the wins wall: it shows while wins is on — HR or no HR — and not after.
    const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    await db.celebration.create({
      data: { kind: "ACHIEVEMENT", audience: "PERSON", source: "MOST_ACTIVE", occasionKey: "active:2099-greeting", title: `${TAG} greeting`, subjectUserId: outsider.id, splashFor: "SUBJECT", startsOn: new Date(today.getTime() - DAY), endsOn: new Date(today.getTime() + DAY) },
    });
    // The greeting runs the real detectors while wins is on. With every kind of win, the awards and
    // the top performer switched off, they find nothing real to announce.
    await db.activityAwardSettings.update({ where: { id: "global" }, data: { enabled: false } });
    const quiet = { dealWon: false, targetHit: false, firstOrder: false, topPerformer: false };
    await db.salesCelebrationSettings.upsert({ where: { id: "global" }, create: { id: "global", ...quiet }, update: quiet });
    await db.systemModule.upsert({ where: { key: "hr" }, create: { key: "hr", enabled: false }, update: { enabled: false } });
    as(outsider);
    const greeting = await todaysMoments();
    ok("the award shows in the greeting with HR off and wins on", greeting.moments.some((m) => m.title === `${TAG} greeting`), greeting.moments.map((m) => m.title).join(" | "));
    await db.systemModule.update({ where: { key: "wins" }, data: { enabled: false } });
    ok("  and not once the wins module is switched off", !(await todaysMoments()).moments.some((m) => m.title === `${TAG} greeting`));
  } finally {
    if (priorWins) {
      const { id: _wid, updatedAt: _wu, ...winsRest } = priorWins;
      void _wid;
      void _wu;
      await db.salesCelebrationSettings.update({ where: { id: "global" }, data: winsRest });
    } else {
      await db.salesCelebrationSettings.deleteMany({ where: { id: "global" } });
    }
    for (const key of ["hr", "wins"]) {
      const prior = priorModules.find((m) => m.key === key);
      if (prior) await db.systemModule.update({ where: { key }, data: { enabled: prior.enabled } });
      else await db.systemModule.deleteMany({ where: { key } });
    }
    if (priorSettings) {
      const { id: _id, updatedAt: _u, ...rest } = priorSettings;
      void _id;
      void _u;
      await db.activityAwardSettings.update({ where: { id: "global" }, data: rest });
    } else {
      await db.activityAwardSettings.deleteMany({ where: { id: "global" } });
    }
    await cleanup();
    const left = await db.notification.count({ where: probeNotes });
    ok("nothing left behind — not one notification to a real person", left === 0 && (await db.user.count({ where: { email: { endsWith: MAIL } } })) === 0 && (await db.activityAward.count({ where: { period: { in: PERIODS } } })) === 0, left);
  }

  console.log(failures ? `\n${failures} failed.` : "\nAll activity-award checks pass.");
  process.exitCode = failures ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
