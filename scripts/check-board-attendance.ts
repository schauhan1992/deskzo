/**
 * The leads board's cards and the attendance grid (owner, 16 Oct 2026 — src/lib/leads/board-extras.ts,
 * src/lib/hr/office-hours*.ts, src/actions/attendance.ts, the two components).
 *
 *   · Office hours: what counts as a time, as a day, and the grace; Late, Left early and Overtime from
 *     a clock-in and clock-out, never for a half day or a day marked without a clock.
 *   · The month: each day's timing, a correction pending, the future, hours worked against hours
 *     expected (working days less leave) — and days instead while no office hours are set.
 *   · Only whoever manages HR sets the hours; they can be cleared.
 *   · A lead's card: tasks done of all, products asked for, calls and notes, the owner and anybody with
 *     a task on it.
 *   · Both screens draw what they should.
 *
 * Everything is named ZZPROBE_BA and removed in a finally; the workspace's own office hours are put back.
 *
 *   npm run check:board-attendance
 */
import "dotenv/config";
import Module from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";
import { dayTiming, minuteOfTime, officeHoursOrRefusal, workedMinutesOf, type OfficeHours } from "../src/lib/hr/office-hours-rules";

let actorId = "";
const roles = new Map<string, string>();
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    return {
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
      usePathname: () => "/people/attendance",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => (actorId ? { id: actorId, role: roles.get(actorId) ?? "PROFILE", name: "Zzprobe Ba", email: `${actorId}${MAIL}` } : null);
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
const TAG = "ZZPROBE_BA";
const MAIL = "@zzprobe-ba.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const companyIds = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  await db.lead.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.item.deleteMany({ where: { sku: { startsWith: TAG } } });
  if (ids.length) {
    await db.task.deleteMany({ where: { OR: [{ createdByUserId: { in: ids } }, { assignedToUserId: { in: ids } }] } });
    await db.attendanceRegularisation.deleteMany({ where: { userId: { in: ids } } });
    await db.attendanceDay.deleteMany({ where: { userId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.notification.deleteMany({ where: { userId: { in: ids } } });
    await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}

async function main() {
  section("Office hours, without a database");

  const nineThirtyToSixThirty: OfficeHours = { startMinute: 570, endMinute: 1110, graceMinutes: 15 };
  ok("a time is hours and minutes", minuteOfTime("09:30") === 570 && minuteOfTime("9:05") === 545 && minuteOfTime("24:00") === null && minuteOfTime("nine") === null);
  const saved = officeHoursOrRefusal({ start: "09:30", end: "18:30", grace: 15 });
  ok("9:30 to 6:30 with 15 minutes' grace is kept", saved.ok && saved.hours.endMinute === 1110);
  ok("  a day that ends before it starts isn't", !officeHoursOrRefusal({ start: "18:00", end: "09:00", grace: 15 }).ok);
  ok("  nor a grace past two hours, or not whole", !officeHoursOrRefusal({ start: "09:30", end: "18:30", grace: 121 }).ok && !officeHoursOrRefusal({ start: "09:30", end: "18:30", grace: 2.5 }).ok);
  // Minutes from midnight as the test writes them: the instant's UTC hour and minute.
  const minuteOf = (at: Date) => at.getUTCHours() * 60 + at.getUTCMinutes();
  const day = (inAt: string | null, outAt: string | null, status = "PRESENT", worked: number | null = null) => ({
    status,
    checkInAt: inAt ? `2026-01-05T${inAt}:00Z` : null,
    checkOutAt: outAt ? `2026-01-05T${outAt}:00Z` : null,
    workedMinutes: worked,
  });
  const t = (d: ReturnType<typeof day>) => dayTiming(d, nineThirtyToSixThirty, minuteOf);
  ok("in at 9:44 is within the grace", !t(day("09:44", "18:30")).late);
  ok("  9:46 is late", t(day("09:46", "18:30")).late);
  ok("out at 6:16 is within it; 6:14 is leaving early", !t(day("09:30", "18:16")).early && t(day("09:30", "18:14")).early);
  ok("nine hours and a half more is overtime; a quarter more isn't", t(day("09:00", "19:05")).overtime && !t(day("09:30", "18:45")).overtime);
  ok("  worked minutes the clock kept win over the times", t(day("09:30", "18:30", "PRESENT", 9 * 60 + 40)).overtime);
  ok("a half day is neither late nor early", !t(day("13:00", "18:30", "HALF_DAY")).late && !t(day("09:30", "13:00", "HALF_DAY")).early);
  ok("a day marked without a clock says nothing of timing", Object.values(t(day(null, null))).every((v) => !v));
  ok("with no office hours, nothing is late", !dayTiming(day("11:00", "12:00"), null, minuteOf).late);
  ok("worked: the clock's minutes; marked by HR, the office day; a half day half; leave nothing",
    workedMinutesOf({ status: "PRESENT", workedMinutes: 500 }, nineThirtyToSixThirty) === 500 &&
      workedMinutesOf({ status: "PRESENT", workedMinutes: null }, nineThirtyToSixThirty) === 540 &&
      workedMinutesOf({ status: "HALF_DAY", workedMinutes: null }, nineThirtyToSixThirty) === 270 &&
      workedMinutesOf({ status: "ON_LEAVE", workedMinutes: null }, nineThirtyToSixThirty) === 0);

  /* eslint-disable @typescript-eslint/no-require-imports */
  const attendance = require("../src/actions/attendance") as typeof import("../src/actions/attendance");
  const { leadBoardExtras } = require("../src/lib/leads/board-extras") as typeof import("../src/lib/leads/board-extras");
  const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");

  const hoursBefore = await db.attendanceSettings.findUnique({ where: { id: "global" } });
  await cleanup();
  try {
    const make = async (key: string, role: "ADMIN" | "PROFILE") => {
      const u = await db.user.create({ data: { name: `${TAG} ${key}`, email: `${key}${MAIL}`, role, passwordHash: "x".repeat(60) } });
      roles.set(u.id, role);
      return u;
    };
    const hr = await make("hr", "ADMIN");
    const worker = await make("worker", "PROFILE");
    const clock = await workspaceClock();
    // January 2026 on the workspace's clock: long past, so nothing in it is the future.
    const at = (dayOfMonth: number, h: number, m: number) => clock.at(2026, 0, dayOfMonth, h, m);
    const date = (dayOfMonth: number) => new Date(Date.UTC(2026, 0, dayOfMonth));
    await db.attendanceDay.createMany({
      data: [
        // Mon 5 Jan: in at 10:00, out at 5:00 — late and early.
        { userId: worker.id, date: date(5), status: "PRESENT", checkInAt: at(5, 10, 0), checkOutAt: at(5, 17, 0), workedMinutes: 420 },
        // Tue 6 Jan: 9:00 to 8:30 pm — overtime.
        { userId: worker.id, date: date(6), status: "PRESENT", checkInAt: at(6, 9, 0), checkOutAt: at(6, 20, 30), workedMinutes: 690 },
        // Wed 7 Jan: marked present by HR, no clock.
        { userId: worker.id, date: date(7), status: "PRESENT" },
        { userId: worker.id, date: date(8), status: "HALF_DAY" },
        { userId: worker.id, date: date(9), status: "ON_LEAVE" },
      ],
    });
    await db.attendanceRegularisation.create({ data: { userId: worker.id, date: date(12), requestedStatus: "PRESENT", reason: "Forgot to clock in" } });

    section("Office hours: who sets them");

    actorId = worker.id;
    ok("somebody who doesn't manage HR can't set them", !(await attendance.saveOfficeHours({ start: "09:30", end: "18:30", grace: 15 })).ok);
    actorId = hr.id;
    ok("  bad times are refused", !(await attendance.saveOfficeHours({ start: "18:30", end: "09:30", grace: 15 })).ok);
    const set = await attendance.saveOfficeHours({ start: "09:30", end: "18:30", grace: 15 });
    ok("whoever manages HR sets them", set.ok && set.data?.startMinute === 570);

    section("The month");

    const month = await attendance.attendanceMonth({ year: 2026, month: 1, search: `${TAG} worker` });
    const row = month.rows.find((r) => r.userId === worker.id);
    const cell = (d: number) => row?.cells.find((c) => c.date === `2026-01-${String(d).padStart(2, "0")}`);
    ok("the month carries the office hours", month.officeHours?.startMinute === 570);
    ok("in at 10:00, out at 5:00: late and left early", !!cell(5)?.late && !!cell(5)?.early && !cell(5)?.overtime, JSON.stringify(cell(5)));
    ok("  with the times, for the hover", !!cell(5)?.checkInAt && !!cell(5)?.checkOutAt);
    ok("9:00 to 8:30 pm: overtime, not late", !!cell(6)?.overtime && !cell(6)?.late);
    ok("marked present with no clock: nothing about timing", !!cell(7) && !cell(7)!.late && !cell(7)!.early && !cell(7)!.overtime);
    ok("a correction asked for shows as pending", !!cell(12)?.pending && !cell(13)?.pending);
    ok("a past month has no future days", row?.cells.every((c) => !c.future) === true);
    // January 2026: 22 weekdays; whatever holidays this workspace has closed come off.
    const workingDays = row?.workingDays ?? 0;
    ok("working days are the weekdays less closed holidays", workingDays > 15 && workingDays <= 22, workingDays);
    ok("hours worked: 7 + 11.5 + 9 (marked) + 4.5 (half) = 32", row?.workedHours === 32, row?.workedHours);
    ok("hours expected: working days less a day and a half of leave, nine hours each", row?.expectedHours === Math.round((workingDays - 1.5) * 9 * 10) / 10, `${row?.expectedHours} for ${workingDays} days`);
    ok("the photo's version travels, for the avatar", row !== undefined && "photoUpdatedAt" in row);

    const cleared = await attendance.saveOfficeHours(null);
    const withoutHours = await attendance.attendanceMonth({ year: 2026, month: 1, search: `${TAG} worker` });
    const plain = withoutHours.rows.find((r) => r.userId === worker.id);
    ok("cleared, the month goes back to days", cleared.ok && withoutHours.officeHours === null && plain?.workedHours === null && plain.cells.every((c) => !c.late && !c.overtime));

    section("A lead's card");

    const company = await db.company.create({ data: { name: `${TAG} Customer`, normalizedName: `${TAG} customer`.toLowerCase(), createdById: hr.id, ownerUserId: hr.id } });
    const item = await db.item.create({ data: { name: `${TAG} Licence`, sku: `${TAG}-1`, type: "SERVICE", sellingPrice: 100, taxRatePercent: 18, createdById: hr.id } });
    const lead = await db.lead.create({ data: { companyId: company.id, title: `${TAG} Big deal`, ownerUserId: hr.id } });
    await db.task.createMany({
      data: [
        { title: "Send the quote", createdByUserId: hr.id, leadId: lead.id, assignedToUserId: worker.id, done: true },
        { title: "Book the demo", createdByUserId: hr.id, leadId: lead.id, assignedToUserId: worker.id },
        { title: "Chase", createdByUserId: hr.id, leadId: lead.id },
      ],
    });
    await db.leadRequirement.create({ data: { leadId: lead.id, itemId: item.id } });
    await db.activity.create({ data: { leadId: lead.id, userId: hr.id, type: "NOTE", notes: "Spoke to the buyer" } });
    const extras = (await leadBoardExtras([{ id: lead.id, ownerUserId: hr.id }]))[lead.id];
    ok("tasks done of all", extras?.tasksDone === 1 && extras.tasksTotal === 3, JSON.stringify(extras));
    ok("  products asked for, calls and notes", extras?.products === 1 && extras.touches === 1);
    ok("  the owner first, then whoever has a task on it, once each", extras?.people.map((p) => p.id).join() === `${hr.id},${worker.id}`);
    ok("a lead with nothing has nothing", JSON.stringify((await leadBoardExtras([{ id: "zz-none", ownerUserId: null }]))["zz-none"]) === JSON.stringify({ tasksDone: 0, tasksTotal: 0, products: 0, touches: 0, people: [] }));

    section("What the screens draw");

    const { LeadsBoard } = await import("../src/components/leads/leads-board");
    const stage = { id: "s1", pipelineId: "p", key: "new", label: "Unqualified", status: "OPEN" as never, color: "blue" as const, archived: false, requiredFields: [] };
    const board = renderToStaticMarkup(
      createElement(LeadsBoard, {
        stages: [stage],
        leads: [{ id: lead.id, leadSeq: 1, title: "Big deal", status: "OPEN" as never, stage, lostReason: null, estimatedValue: "120000", expectedCloseDate: "2026-01-10", company: { id: company.id, name: "Acme" }, owner: { id: hr.id, name: "Asha Rao" }, score: 70 }],
        extras: { [lead.id]: extras! },
      }),
    );
    ok("the column is in its stage's colour, with its count", board.includes("bg-info-bg") && board.includes("text-info") && />1</.test(board));
    ok("  the card counts tasks, products, calls and notes", board.includes("1/3") && board.includes("products asked for") && board.includes("calls and notes"));
    ok("  and a close date passed on an open deal is red", /bg-danger-bg[^"]*"[^>]*>.*10 Jan 2026/.test(board) || (board.includes("bg-danger-bg") && board.includes("10 Jan 2026")));

    const { AttendanceGrid } = await import("../src/components/hr/attendance-grid");
    const grid = (hours: boolean) =>
      renderToStaticMarkup(
        createElement(AttendanceGrid, {
          month: { ...(hours ? month : withoutHours), rows: (hours ? month : withoutHours).rows.filter((r) => r.userId === worker.id) },
          today: null,
          canMark: true,
          year: 2026,
          monthNumber: 1,
          canSetHours: true,
        }),
      ).replace(/&#x27;/g, "'");
    const withHours = grid(true);
    ok("the report is titled with its month", withHours.includes("Attendance report: JANUARY 2026"));
    ok("  with a legend, late, left early and overtime among it", ["Present", "Absent", "Half day", "On leave", "Holiday", "Week off", "Future", "Late", "Left early", "Overtime"].every((t) => withHours.includes(t)));
    ok("  each day its weekday", withHours.includes(">MON<") && withHours.includes(">SUN<"));
    ok("  the total in hours of hours expected", withHours.includes("32.0") && withHours.includes(" h<"));
    ok("  and the hours, with a way to change them", withHours.includes("Office hours 9:30 am – 6:30 pm") && withHours.includes("Change"));
    const daysOnly = grid(false);
    ok("without office hours: days, no timing in the legend, and a way to set them", daysOnly.includes(" days<") && !daysOnly.includes("Left early") && daysOnly.includes("Set office hours"));
  } finally {
    await db.attendanceSettings.deleteMany({ where: { id: "global" } });
    if (hoursBefore) await db.attendanceSettings.create({ data: hoursBefore });
    await cleanup();
  }

  console.log(failures === 0 ? "\nAll board and attendance checks passed." : `\n${failures} board and attendance check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
