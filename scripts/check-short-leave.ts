/**
 * Short leave by the hour (owner, 18 Oct 2026 — src/lib/hr/short-leave-rules.ts, src/actions/short-leave.ts,
 * the attendance month and grid, the leave page's panel).
 *
 *   · The rules: up to the company's length, inside office hours, this month or later, never a day off,
 *     a leave day or a second one that day; past the month's count, a half day instead.
 *   · Only whoever manages HR changes the length and the count.
 *   · The reporting manager decides — never the person themselves, never somebody else's report — and
 *     both sides are told. Two requests sent at once can't both take the month's last one.
 *   · Withdrawing: a pending one any time, an approved one before its day.
 *   · In the attendance month an approved short leave clears the Late or Left early mark it covers; a
 *     pending or rejected one clears nothing.
 *   · Both screens draw it.
 *
 * Everything is named ZZPROBE_SL and removed in a finally; the workspace's own office hours and short
 * leave rules are put back. The requests are made for next month, so the suite passes on any day.
 *
 *   npm run check:short-leave
 */
import "dotenv/config";
import Module from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";
import type { OfficeHours } from "../src/lib/hr/office-hours-rules";
import {
  draftOrRefusal,
  durationWords,
  excusesEarly,
  excusesLate,
  limitsRefusal,
  policyOrRefusal,
  timingWithShortLeave,
} from "../src/lib/hr/short-leave-rules";

let actorId = "";
const roles = new Map<string, string>();
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    return {
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
      usePathname: () => "/people/leave",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => (actorId ? { id: actorId, role: roles.get(actorId) ?? "PROFILE", name: "Zzprobe Sl", email: `${actorId}${MAIL}` } : null);
    return {
      requireUser: async () => {
        const u = user();
        if (!u) throw new Error("Unauthorized");
        return u;
      },
      currentUser: async () => user(),
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_SL";
const MAIL = "@zzprobe-sl.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

async function cleanup() {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  if (!ids.length) return;
  await db.shortLeaveRequest.deleteMany({ where: { OR: [{ userId: { in: ids } }, { approverId: { in: ids } }] } });
  await db.attendanceDay.deleteMany({ where: { userId: { in: ids } } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.user.updateMany({ where: { id: { in: ids } }, data: { managerId: null } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  section("The rules, without a database");

  const hours: OfficeHours = { startMinute: 570, endMinute: 1110, graceMinutes: 15 };
  const policy = { maxMinutes: 120, perMonth: 2 };
  const today = "2026-10-18";
  const draft = (date: string, from: string, to: string, reason = "Doctor's appointment") => draftOrRefusal({ date, from, to, reason }, { today, policy, hours });
  const refusal = (r: ReturnType<typeof draft>) => (r.ok ? "" : r.error);

  ok("durations read as people say them", durationWords(120) === "2 hours" && durationWords(90) === "1 hour 30 minutes" && durationWords(45) === "45 minutes" && durationWords(61) === "1 hour 1 minute");
  ok("the company's rules: 15 minutes to 8 hours, 0 to 31 a month", policyOrRefusal({ maxMinutes: 120, perMonth: 2 }).ok && policyOrRefusal({ maxMinutes: 480, perMonth: 0 }).ok);
  ok("  anything else is refused", [{ maxMinutes: 10, perMonth: 2 }, { maxMinutes: 481, perMonth: 2 }, { maxMinutes: 90.5, perMonth: 2 }, { maxMinutes: 120, perMonth: 32 }, { maxMinutes: 120, perMonth: -1 }, { maxMinutes: "x", perMonth: 2 }].every((p) => !policyOrRefusal(p).ok));

  const kept = draft("2026-10-20", "09:30", "11:00");
  ok("an hour and a half on a later day is kept, as minutes", kept.ok && kept.value.fromMinute === 570 && kept.value.toMinute === 660 && kept.value.date === "2026-10-20");
  ok("  so is a day earlier this month — asked for afterwards", draft("2026-10-01", "16:30", "18:30").ok);
  ok("  and a day next year", draft("2027-01-04", "09:30", "10:00").ok);
  ok("a day in a past month is refused", refusal(draft("2026-09-30", "09:30", "10:00")).includes("past month"));
  ok("  so is a day that doesn't exist, or none", !draft("2026-02-30", "09:30", "10:00").ok && refusal(draft("", "09:30", "10:00")) === "Pick the day.");
  ok("past the length: a half day instead", refusal(draft("2026-10-20", "09:30", "11:31")).includes("at most 2 hours — for longer, apply for a half day"));
  ok("  exactly the length is fine", draft("2026-10-20", "09:30", "11:30").ok);
  ok("under a quarter of an hour is refused", refusal(draft("2026-10-20", "09:30", "09:40")).includes("at least 15 minutes"));
  ok("it has to end after it starts", refusal(draft("2026-10-20", "11:00", "09:30")).includes("end after it starts"));
  ok("outside office hours is refused, in words", refusal(draft("2026-10-20", "08:30", "10:00")).includes("9:30 am to 6:30 pm") && !draft("2026-10-20", "17:00", "19:00").ok);
  ok("  with no office hours set, any time of day", draftOrRefusal({ date: "2026-10-20", from: "07:00", to: "08:30", reason: "Early train" }, { today, policy, hours: null }).ok);
  ok("a reason is needed", refusal(draft("2026-10-20", "09:30", "10:00", " ")).includes("Say why"));
  ok("a company offering none says so", refusal(draftOrRefusal({ date: "2026-10-20", from: "09:30", to: "10:00", reason: "Bank" }, { today, policy: { maxMinutes: 120, perMonth: 0 }, hours })).includes("doesn't offer short leave"));

  const limits = (over: Partial<Parameters<typeof limitsRefusal>[0]>) =>
    limitsRefusal({ date: "2026-10-20", today, perMonth: 2, offDay: null, onLeave: false, sameDay: false, usedInMonth: 0, ...over });
  ok("a free working day with one used is fine", limits({ usedInMonth: 1 }) === null);
  ok("a week off or a holiday has nothing to excuse", limits({ offDay: "week off" })!.includes("week off") && limits({ offDay: "holiday" })!.includes("holiday"));
  ok("  a leave day, or a second one that day, is refused", limits({ onLeave: true })!.includes("leave that day") && limits({ sameDay: true })!.includes("short leave that day"));
  ok("past the month's count: a half day instead", limits({ usedInMonth: 2 }) === "You've had this month's 2 short leaves — apply for a half day instead.");
  ok("  naming the month when it isn't this one", limits({ date: "2026-11-03", usedInMonth: 2 })!.startsWith("You've had November's 2 short leaves"));
  ok("  and one a month reads as one", limits({ perMonth: 1, usedInMonth: 1 })!.includes("this month's 1 short leave —"));

  const span = (from: number, to: number) => ({ fromMinute: from, toMinute: to });
  ok("late in at 11:05 is covered by 9:30–11:00 (the grace reaches 11:15)", excusesLate(span(570, 660), 665, hours));
  ok("  in at 11:20 isn't", !excusesLate(span(570, 660), 680, hours));
  ok("  nor by one starting at 9:50, after the grace", !excusesLate(span(590, 660), 650, hours));
  ok("out at 4:40 is covered by 4:30–6:30", excusesEarly(span(990, 1110), 1000, hours));
  ok("  not by 4:30–6:00, which stops short of the end", !excusesEarly(span(990, 1080), 1000, hours));
  ok("  nor out at 4:00 by 4:30–6:30", !excusesEarly(span(990, 1110), 960, hours));
  const minuteOf = (at: Date) => at.getUTCHours() * 60 + at.getUTCMinutes();
  const lateEarly = { late: true, early: true, overtime: false };
  const times = { checkInAt: "2026-10-20T11:05:00Z", checkOutAt: "2026-10-20T16:40:00Z" };
  const approvedMorning = timingWithShortLeave(lateEarly, times, { ...span(570, 660), approved: true }, hours, minuteOf);
  ok("an approved one clears the mark it covers and only that", !approvedMorning.late && approvedMorning.early && approvedMorning.excused);
  const waiting = timingWithShortLeave(lateEarly, times, { ...span(570, 660), approved: false }, hours, minuteOf);
  ok("  a pending one clears nothing", waiting.late && waiting.early && !waiting.excused);
  ok("  nor does one that covers neither", timingWithShortLeave(lateEarly, times, { ...span(780, 840), approved: true }, hours, minuteOf).excused === false);

  /* eslint-disable @typescript-eslint/no-require-imports */
  const shortLeave = require("../src/actions/short-leave") as typeof import("../src/actions/short-leave");
  const attendance = require("../src/actions/attendance") as typeof import("../src/actions/attendance");
  const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
  const { closedDates, eachDay, isWeekOff, monthRange, toKey } = require("../src/lib/hr/calendar") as typeof import("../src/lib/hr/calendar");

  const hoursBefore = await db.attendanceSettings.findUnique({ where: { id: "global" } });
  const policyBefore = await db.shortLeavePolicy.findUnique({ where: { id: "global" } });
  await cleanup();
  try {
    const make = async (key: string, role: "ADMIN" | "PROFILE", managerId?: string) => {
      const u = await db.user.create({ data: { name: `${TAG} ${key}`, email: `${key}${MAIL}`, role, passwordHash: "x".repeat(60), managerId } });
      roles.set(u.id, role);
      return u;
    };
    const hr = await make("hr", "ADMIN");
    const manager = await make("manager", "PROFILE");
    const worker = await make("worker", "PROFILE", manager.id);
    const racer = await make("racer", "PROFILE", manager.id);
    const outsider = await make("outsider", "PROFILE");

    const clock = await workspaceClock();
    const now = clock.today();
    const [y, m] = [Number(now.slice(0, 4)), Number(now.slice(5, 7))];
    const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
    const { from, to } = monthRange(ny, nm);
    const closed = closedDates(await db.holiday.findMany({ where: { date: { gte: from, lte: to } }, select: { date: true, optional: true } }));
    const all = eachDay(from, to);
    const working = all.filter((d) => !isWeekOff(d) && !closed.has(toKey(d))).map(toKey);
    const weekOff = toKey(all.find((d) => isWeekOff(d))!);
    const [d1, d2, d3, d4] = working;
    const [p1, p2, p3] = working.slice(4);
    const prevMonth = m === 1 ? `${y - 1}-12-15` : `${y}-${String(m - 1).padStart(2, "0")}-15`;
    const at = (key: string, h: number, min: number) => clock.at(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)), h, min);

    section("The rules: who sets them");

    actorId = hr.id;
    const hoursSet = await attendance.saveOfficeHours({ start: "09:30", end: "18:30", grace: 15 });
    actorId = worker.id;
    ok("somebody who doesn't manage HR can't change them", !(await shortLeave.saveShortLeavePolicy({ maxMinutes: 240, perMonth: 4 })).ok);
    actorId = hr.id;
    ok("  bad numbers are refused", !(await shortLeave.saveShortLeavePolicy({ maxMinutes: 600, perMonth: 2 })).ok);
    const saved = await shortLeave.saveShortLeavePolicy({ maxMinutes: 120, perMonth: 2 });
    ok("whoever manages HR sets two hours, twice a month", hoursSet.ok && saved.ok && saved.data.maxMinutes === 120);

    section("Asking");

    actorId = worker.id;
    const first = await shortLeave.applyForShortLeave({ date: d1, from: "09:30", to: "11:00", reason: `${TAG} doctor` });
    ok("a working day next month, an hour and a half: sent", first.ok, JSON.stringify(first));
    const row1 = first.ok ? await db.shortLeaveRequest.findUnique({ where: { id: first.data.id } }) : null;
    ok("  pending, with the manager as approver, in minutes", row1?.status === "PENDING" && row1.approverId === manager.id && row1.fromMinute === 570 && row1.toMinute === 660 && toKey(row1.date) === d1);
    const asked = await db.notification.findFirst({ where: { userId: manager.id, type: "LEAVE_REQUESTED" }, orderBy: { createdAt: "desc" } });
    ok("  and the manager is told, with the hours", !!asked && asked.title === "Short leave request" && (asked.message ?? "").includes("9:30 am – 11:00 am"), asked?.message);
    const again = await shortLeave.applyForShortLeave({ date: d1, from: "16:30", to: "18:30", reason: "Again" });
    ok("a second one the same day is refused", !again.ok && again.error.includes("short leave that day"));
    const offDay = await shortLeave.applyForShortLeave({ date: weekOff, from: "09:30", to: "10:00", reason: "Weekend" });
    ok("a week off is refused", !offDay.ok && offDay.error.includes("week off"), JSON.stringify(offDay));
    const tooLong = await shortLeave.applyForShortLeave({ date: d2, from: "09:30", to: "12:30", reason: "Long" });
    ok("three hours: a half day instead", !tooLong.ok && tooLong.error.includes("apply for a half day"));
    const past = await shortLeave.applyForShortLeave({ date: prevMonth, from: "09:30", to: "10:00", reason: "Last month" });
    ok("last month is refused", !past.ok && past.error.includes("past month"));
    const second = await shortLeave.applyForShortLeave({ date: d2, from: "16:30", to: "18:30", reason: `${TAG} school` });
    ok("a second day, the last two hours: sent", second.ok);
    const third = await shortLeave.applyForShortLeave({ date: d3, from: "09:30", to: "10:30", reason: "Third" });
    ok("the month's third is refused — a half day instead, naming the month", !third.ok && third.error === `You've had ${MONTHS[nm - 1]}'s 2 short leaves — apply for a half day instead.`, third.ok ? "" : third.error);

    actorId = racer.id;
    const race = await Promise.all([p1, p2, p3].map((d) => shortLeave.applyForShortLeave({ date: d, from: "09:30", to: "10:00", reason: `${TAG} race` })));
    ok("three sent at once with two a month: exactly two are kept", race.filter((r) => r.ok).length === 2 && (await db.shortLeaveRequest.count({ where: { userId: racer.id } })) === 2, race.map((r) => (r.ok ? "ok" : r.error)).join(" | "));

    section("Deciding");

    const id1 = first.ok ? first.data.id : "";
    const id2 = second.ok ? second.data.id : "";
    actorId = outsider.id;
    ok("somebody else's report can't be decided", !(await shortLeave.decideShortLeave({ id: id1, approve: true })).ok);
    actorId = worker.id;
    ok("  nor one's own", !(await shortLeave.decideShortLeave({ id: id1, approve: true })).ok);
    actorId = manager.id;
    const approved = await shortLeave.decideShortLeave({ id: id1, approve: true, note: "Get well" });
    ok("the reporting manager approves it", approved.ok && (await db.shortLeaveRequest.findUnique({ where: { id: id1 } }))?.status === "APPROVED");
    const told = await db.notification.findFirst({ where: { userId: worker.id, type: "LEAVE_DECIDED" }, orderBy: { createdAt: "desc" } });
    ok("  and the person is told, with the note", told?.title === "Short leave approved" && (told.message ?? "").includes("Get well"), told?.message);
    ok("  it can't be decided twice", !(await shortLeave.decideShortLeave({ id: id1, approve: false })).ok);
    ok("the other is rejected", (await shortLeave.decideShortLeave({ id: id2, approve: false })).ok);
    actorId = worker.id;
    const afterReject = await shortLeave.applyForShortLeave({ date: d3, from: "09:30", to: "10:30", reason: `${TAG} bank` });
    ok("a rejected one gives the month's place back", afterReject.ok);
    const id3 = afterReject.ok ? afterReject.data.id : "";

    section("Withdrawing");

    actorId = outsider.id;
    ok("somebody else's can't be withdrawn", !(await shortLeave.cancelShortLeave(id3)).ok);
    actorId = worker.id;
    ok("a pending one can", (await shortLeave.cancelShortLeave(id3)).ok);
    const fourth = await shortLeave.applyForShortLeave({ date: d4, from: "10:00", to: "11:00", reason: `${TAG} plumber` });
    actorId = manager.id;
    if (fourth.ok) await shortLeave.decideShortLeave({ id: fourth.data.id, approve: true });
    actorId = worker.id;
    ok("an approved one before its day can", fourth.ok && (await shortLeave.cancelShortLeave(fourth.data.id)).ok);
    const todays = await db.shortLeaveRequest.create({ data: { userId: worker.id, date: new Date(`${now}T00:00:00Z`), fromMinute: 570, toMinute: 600, reason: TAG, status: "APPROVED", approverId: manager.id } });
    const lateWithdraw = await shortLeave.cancelShortLeave(todays.id);
    ok("  an approved one whose day has come can't", !lateWithdraw.ok && lateWithdraw.error.includes("ask HR"));
    const back = await shortLeave.applyForShortLeave({ date: d3, from: "09:30", to: "10:30", reason: `${TAG} bank again` });
    ok("withdrawn ones give the month's place back too", back.ok, back.ok ? "" : back.error);

    section("What each person sees");

    const mine = await shortLeave.shortLeaveOverview();
    ok("the person: the rules, their own from this month on", mine?.policy.perMonth === 2 && mine.mine.some((r) => r.id === id1) && !mine.canManage);
    actorId = manager.id;
    const managers = await shortLeave.shortLeaveOverview();
    ok("the manager: their reports' pending ones", managers?.pending.some((r) => back.ok && r.id === back.data.id) === true && managers.pending.every((r) => r.status === "PENDING"));
    ok("  and what they decided", managers?.recent.some((r) => r.id === id1) === true);
    actorId = outsider.id;
    const outsiders = await shortLeave.shortLeaveOverview();
    ok("somebody else sees none of it", outsiders?.pending.every((r) => r.user.id !== worker.id) === true);

    section("The attendance month");

    await db.attendanceDay.createMany({
      data: [
        // d1: in at 11:05 — late, but the approved 9:30–11:00 covers it. Out at 5:00 — early, uncovered.
        { userId: worker.id, date: new Date(`${d1}T00:00:00Z`), status: "PRESENT", checkInAt: at(d1, 11, 5), checkOutAt: at(d1, 17, 0), workedMinutes: 355 },
        // d2: the rejected 4:30–6:30, out at 4:40 — still early.
        { userId: worker.id, date: new Date(`${d2}T00:00:00Z`), status: "PRESENT", checkInAt: at(d2, 9, 30), checkOutAt: at(d2, 16, 40), workedMinutes: 430 },
        // d3: the pending 9:30–10:30, in at 10:30 — still late.
        { userId: worker.id, date: new Date(`${d3}T00:00:00Z`), status: "PRESENT", checkInAt: at(d3, 10, 30), checkOutAt: at(d3, 18, 30), workedMinutes: 480 },
      ],
    });
    actorId = hr.id;
    const month = await attendance.attendanceMonth({ year: ny, month: nm, search: `${TAG} worker` });
    const cells = month.rows.find((r) => r.userId === worker.id)?.cells ?? [];
    const cell = (key: string) => cells.find((c) => c.date === key);
    ok("approved: the late mark it covers is cleared, the early one isn't", cell(d1)?.late === false && cell(d1)?.early === true && cell(d1)?.shortLeave?.approved === true && cell(d1)?.shortLeave?.excused === true, JSON.stringify(cell(d1)));
    ok("  with its hours in words", cell(d1)?.shortLeave?.words === "9:30 am – 11:00 am");
    ok("rejected: nothing on the day, still early", cell(d2)?.shortLeave === null && cell(d2)?.early === true);
    ok("pending: shown as waiting, still late", cell(d3)?.shortLeave?.approved === false && cell(d3)?.late === true && cell(d3)?.shortLeave?.excused === false);
    ok("worked minutes are what the clock says", cell(d1)?.workedMinutes === 355);

    section("What the screens draw");

    const { AttendanceGrid } = await import("../src/components/hr/attendance-grid");
    const grid = renderToStaticMarkup(
      createElement(AttendanceGrid, { month: { ...month, rows: month.rows.filter((r) => r.userId === worker.id) }, today: null, canMark: true, year: ny, monthNumber: nm, canSetHours: true }),
    ).replace(/&#x27;/g, "'");
    ok("the grid's legend has short leave", grid.includes("Short leave"));
    ok("  and the day says it in words", grid.includes("short leave 9:30 am – 11:00 am, excused the mark") && grid.includes("short leave 9:30 am – 10:30 am, waiting for approval"));

    const { ShortLeavePanel } = await import("../src/components/hr/short-leave-panel");
    actorId = worker.id;
    const workerView = await shortLeave.shortLeaveOverview();
    const panel = renderToStaticMarkup(createElement(ShortLeavePanel, { overview: workerView! })).replace(/&#x27;/g, "'");
    ok("the leave page's panel: the count, the length, and a way to ask", /\d of 2 used this month · up to 2 hours each/.test(panel) && panel.includes("Ask for a short leave"));
    ok("  their own, with a way to withdraw the pending one", panel.includes(`${TAG} bank again`) && panel.includes("Withdraw"));
    ok("  and no rules button for them", !panel.includes(">Rules<") && !panel.includes("Rules</button>"));
    actorId = hr.id;
    const hrPanel = renderToStaticMarkup(createElement(ShortLeavePanel, { overview: (await shortLeave.shortLeaveOverview())! }));
    ok("whoever manages HR gets the rules", hrPanel.includes("Rules"));
    await db.shortLeavePolicy.update({ where: { id: "global" }, data: { perMonth: 0 } });
    const offPanel = renderToStaticMarkup(createElement(ShortLeavePanel, { overview: (await shortLeave.shortLeaveOverview())! })).replace(/&#x27;/g, "'");
    ok("none a month: it says so, with nothing to ask for", offPanel.includes("doesn't offer short leave") && !offPanel.includes("Ask for a short leave"));
  } finally {
    await db.attendanceSettings.deleteMany({ where: { id: "global" } });
    if (hoursBefore) await db.attendanceSettings.create({ data: hoursBefore });
    await db.shortLeavePolicy.deleteMany({ where: { id: "global" } });
    if (policyBefore) await db.shortLeavePolicy.create({ data: policyBefore });
    await cleanup();
  }

  console.log(failures === 0 ? "\nAll short leave checks passed." : `\n${failures} short leave check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
