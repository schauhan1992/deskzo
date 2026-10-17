/**
 * check:pay-periods — who a month's payroll pays and for which days, the month somebody leaves in
 * being paid once, and leave carried from one year into the next.
 *
 * The arithmetic is checked by hand-worked cases in check:payroll and check:settlement. This drives
 * the parts that read the database — src/lib/hr/payroll-month.ts and src/lib/hr/leave-balance.ts —
 * against a fixture of people and leave types made here and removed in a finally. The fixture's
 * months are in 2000–2001, so nothing it makes can meet a real payroll run or balance.
 *
 * What it proves:
 *   · March 2001's payroll pays somebody joining on the 20th for the 20th to the 31st, names somebody
 *     joining in April as skipped, and leaves out everybody who left in February — with their login
 *     kept on as much as with it off;
 *   · somebody leaving on 10 March is paid the 1st to the 10th;
 *   · a settlement that pays the leaving month's salary marks them so the run pays them no days, one
 *     that paid none (a locked payslip got there first) does not, and one made for an exit date that
 *     has since moved counts for nothing;
 *   · a run calculated before such a settlement names who it would pay twice — which stops it being
 *     locked — but not a payslip of no days carrying an incentive;
 *   · a run whose payslip an approved settlement left part of the month to names them — which stops
 *     it being unlocked;
 *   · the settlement counts a locked payslip's days and not a draft's, reports a locked month that
 *     overpaid, and reports locked months after the exit that paid salary;
 *   · a carried balance is last year's closing, capped; worked out again when last year moves; never
 *     taken back when the type stops carrying or the cap is lowered; nothing for a type that does not
 *     carry;
 *   · last year's accrual is brought to the full year before it is carried;
 *   · a year nobody opened is made for somebody who was here, and not for somebody who joined after
 *     it or a record made after it — and for somebody who joined in its last month, with that month's
 *     share of it;
 *   · what a year grants follows the joining and leaving dates;
 *   · a balance made before carrying worked (opening 0) is put right the next time it is looked at;
 *   · a salary revised inside a month is paid each part at its own rate by the run itself, a day off
 *     docked at the rate of the part it fell in; a settlement pays at the salary they left on, not a
 *     revision dated after;
 *   · a plan without Incentives (Deskzo People on its own) still runs payroll, leaving an approved
 *     incentive waiting, unpaid, until the plan has Incentives again;
 *   · a balance brought from the old system stands in for the carry Deskzo can't work out, the next
 *     year carries from it, and what was taken before Deskzo is counted as used — typed through the
 *     opening balances sheet by HR only, for this year or last;
 *   · TDS is worked out from a person's declaration and pay outside Deskzo, warns when earlier months
 *     of the tax year are missing, and a figure typed on a payslip survives the run being recalculated.
 *
 *   npm run check:pay-periods
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

// The run is a server action: whoever runs it is the fixture's payroll clerk.
let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => ({ id: actorId, role: "ADMIN", name: "Zzprobe Clerk", email: `clerk${MAIL}` });
    return { requireUser: user, currentUser: user, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_PAY";
const ROLE = "ZZPROBE_PAY";
const MAIL = "@zzprobe-pay.invalid";
const CODES = ["ZZCF", "ZZCM", "ZZNC", "ZZUP"];

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const num = (v: unknown) => Number(v ?? 0);

async function cleanup() {
  const fixtureMonths = [{ month: 3, year: 2001 }, { month: 10, year: 2000 }, { month: 1, year: 2001 }, { month: 5, year: 2001 }, { month: 6, year: 2001 }];
  await db.payslip.deleteMany({ where: { run: { OR: fixtureMonths } } });
  await db.payrollRun.deleteMany({ where: { OR: fixtureMonths } });
  // Balances and settlements go with the people and types (onDelete: Cascade).
  await db.leaveType.deleteMany({ where: { code: { in: CODES } } });
  await db.auditLog.deleteMany({ where: { user: { email: { endsWith: MAIL } } } });
  // Before the people: an award's maker (the clerk) can't be deleted from under it.
  await db.incentiveEarning.deleteMany({ where: { user: { email: { endsWith: MAIL } } } });
  await db.user.deleteMany({ where: { email: { endsWith: MAIL } } });
  await db.role.deleteMany({ where: { key: ROLE } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { alsoPaidBySettlement, finalMonthFor, monthsBefore, paidAfterLeaving, payrollMonth, ptHistoryFor, settlementsRelyingOn, workStateOf } =
    require("../src/lib/hr/payroll-month") as typeof import("../src/lib/hr/payroll-month");
  const { accruedTo, ensureBalance } = require("../src/lib/hr/leave-balance") as typeof import("../src/lib/hr/leave-balance");
  /* eslint-enable @typescript-eslint/no-require-imports */

  await cleanup();
  try {
    await db.role.create({ data: { key: ROLE, name: "Zzprobe pay" } });
    const person = async (key: string, profile: { joinedOn?: string; exitedOn?: string } | null, active = true) =>
      db.user.create({
        data: {
          name: `Zzprobe ${key}`,
          email: `${key.toLowerCase()}${MAIL}`,
          role: ROLE,
          passwordHash: "x".repeat(60),
          active,
          ...(profile
            ? {
                employeeProfile: {
                  create: {
                    joinedOn: profile.joinedOn ? d(profile.joinedOn) : null,
                    exitedOn: profile.exitedOn ? d(profile.exitedOn) : null,
                  },
                },
              }
            : {}),
        },
      });

    section("Who March 2001's payroll pays");
    const steady = await person("Steady", { joinedOn: "2000-01-10" });
    await person("Joiner", { joinedOn: "2001-03-20" });
    await person("Future", { joinedOn: "2001-04-05" });
    const leaverId = (await person("Leaver", { joinedOn: "2000-01-10", exitedOn: "2001-03-10" })).id;
    const goneKept = await person("GoneLoginKept", { joinedOn: "2000-01-10", exitedOn: "2001-02-15" }, true);
    await person("GoneLoginOff", { joinedOn: "2000-01-10", exitedOn: "2001-02-15" }, false);
    const settled = await person("Settled", { joinedOn: "2000-01-10", exitedOn: "2001-03-12" });
    const settledNone = await person("SettledNone", { joinedOn: "2000-01-10", exitedOn: "2001-03-25" });
    const incentiveOnly = await person("IncentiveOnly", { joinedOn: "2000-01-10", exitedOn: "2001-03-08" });
    const moved = await person("Moved", { joinedOn: "2000-01-10", exitedOn: "2001-04-05" });
    const remainder = await person("Remainder", { joinedOn: "2000-01-10", exitedOn: "2001-03-20" });
    await person("NoProfile", null);
    const settlement = (userId: string, lastWorkingDay: string, salaryDays: number, status: "DRAFT" | "APPROVED" = "DRAFT") =>
      db.finalSettlement.create({ data: { userId, lastWorkingDay: d(lastWorkingDay), serviceYears: 1, salaryDays, status } });
    await settlement(settled.id, "2001-03-12", 12);
    await settlement(settledNone.id, "2001-03-25", 0);
    await settlement(incentiveOnly.id, "2001-03-08", 8);
    // Worked out for 12 March; the exit has since moved to 5 April.
    await settlement(moved.id, "2001-03-12", 12);
    // Approved for the 2 days a locked payslip of 18 left it.
    await settlement(remainder.id, "2001-03-20", 2, "APPROVED");

    const march = await payrollMonth(2001, 3);
    const mine = march.people.filter((p) => p.name.startsWith("Zzprobe "));
    const paid = new Map(mine.map((p) => [p.name.replace("Zzprobe ", ""), p.employment]));
    const inSettlement = new Set(mine.filter((p) => p.salaryInSettlement).map((p) => p.name.replace("Zzprobe ", "")));
    const skipped = march.skipped.filter((s) => s.startsWith("Zzprobe "));
    const span = (key: string) => {
      const e = paid.get(key);
      return e ? `${e.firstDay}–${e.lastDay} (${e.days})` : "not paid";
    };

    ok("somebody here all month is paid all of it", span("Steady") === "1–31 (31)", span("Steady"));
    ok("joining on 20 March is the 20th to the 31st", span("Joiner") === "20–31 (12)", span("Joiner"));
    ok("joining in April is not on March's payroll", !paid.has("Future"), span("Future"));
    ok("...and is named as skipped, with the day", skipped.some((s) => s.includes("Future") && s.includes("joins on")), skipped.join(" | "));
    ok("leaving on 10 March is the 1st to the 10th", span("Leaver") === "1–10 (10)", span("Leaver"));
    ok("left in February, login kept on: not paid in March", !paid.has("GoneLoginKept"));
    ok("left in February, login off: not paid in March", !paid.has("GoneLoginOff"));
    ok("...and neither is named as skipped (they left; that is no news)", !skipped.some((s) => s.includes("Gone")));
    ok("a settlement that pays March's days: marked, so the run pays them no days", inSettlement.has("Settled"), [...inSettlement].join(", "));
    ok("...the same for one with an incentive to go out (runPayroll pays only that)", inSettlement.has("IncentiveOnly"));
    ok("a settlement that paid none of March leaves the days to the payroll", span("SettledNone") === "1–25 (25)" && !inSettlement.has("SettledNone"), span("SettledNone"));
    ok("a settlement for a day the exit has moved from counts for nothing", span("Moved") === "1–31 (31)" && !inSettlement.has("Moved"), span("Moved"));
    ok("nobody else is marked", [...inSettlement].every((k) => ["Settled", "IncentiveOnly", "Remainder"].includes(k)), [...inSettlement].join(", "));
    ok("no employee record is paid as before — the whole month", span("NoProfile") === "1–31 (31)", span("NoProfile"));

    const february = await payrollMonth(2001, 2);
    const febNames = new Set(february.people.map((p) => p.name));
    ok("February pays the February leaver to the 15th", february.people.find((p) => p.name === "Zzprobe GoneLoginKept")?.employment.days === 15);
    ok("...with the login off too: leaving in the month still pays the month", febNames.has("Zzprobe GoneLoginOff"));
    ok("February doesn't pay March's joiner", !febNames.has("Zzprobe Joiner"));
    ok("...but names them as joining later", february.skipped.some((s) => s.includes("Zzprobe Joiner") && s.includes("joins on")));
    ok("steady is still there", febNames.has(steady.name));

    section("Locking, unlocking, and the settlement's view of the month");
    // March 2001 as if it had been run before some of these settlements were made.
    const run = await db.payrollRun.create({ data: { month: 3, year: 2001 } });
    const slip = (userId: string, days: number, gross = 0) =>
      db.payslip.create({
        data: { runId: run.id, userId, monthDays: 31, paidDays: days, basic: 0, grossEarnings: gross, totalDeductions: 0, netPay: 0, employerCost: 0 },
      });
    await slip(steady.id, 31);
    await slip(settled.id, 12);
    await slip(settledNone.id, 25);
    await slip(incentiveOnly.id, 0, 5000);
    await slip(moved.id, 31);
    await slip(remainder.id, 18);
    await slip(goneKept.id, 31, 62000);

    const twice = await alsoPaidBySettlement(run.id, 2001, 3);
    ok("the lock is refused for the person a settlement pays the month to", twice.includes(settled.name), twice.join(", ") || "nobody");
    ok("...and for one whose settlement is out of date, so it gets recalculated", twice.includes(moved.name));
    ok("...not for a payslip of no days, carrying an incentive", !twice.includes(incentiveOnly.name));
    ok("...not for somebody whose settlement left the month to the payroll", !twice.includes(settledNone.name));
    ok("...nor anybody who hasn't left", !twice.includes(steady.name));

    const relying = await settlementsRelyingOn(run.id, 2001, 3);
    ok("unlocking is refused while an approved settlement leaves part of the month to this run", relying.length === 1 && relying[0] === remainder.name, relying.join(", ") || "nobody");

    const draftView = await finalMonthFor(remainder.id, d("2000-01-10"), d("2001-03-20"));
    ok("a draft run's payslip isn't counted by the settlement: all 20 days are its own", draftView.days.salaryDays === 20, draftView.days.salaryDays);
    await db.payrollRun.update({ where: { id: run.id }, data: { status: "LOCKED" } });
    const lockedView = await finalMonthFor(remainder.id, d("2000-01-10"), d("2001-03-20"));
    ok("once locked, its 18 days come off: 2 left", lockedView.days.salaryDays === 2 && lockedView.days.onPayslip === 18, JSON.stringify(lockedView.days));
    const overView = await finalMonthFor(steady.id, d("2000-01-10"), d("2001-03-20"));
    ok("a locked full month for somebody who left on the 20th: 11 days overpaid", overView.days.salaryDays === 0 && overView.days.overpaidDays === 11, JSON.stringify(overView.days));

    const lateSlips = await paidAfterLeaving(goneKept.id, d("2001-02-15"));
    ok("an exit recorded late: March's locked payslip is reported as paid after leaving", lateSlips.length === 1 && lateSlips[0]!.label === "March 2001" && lateSlips[0]!.days === 31 && lateSlips[0]!.gross === 62000, JSON.stringify(lateSlips));
    ok("...and nothing for somebody who left after it", (await paidAfterLeaving(steady.id, d("2001-03-31"))).length === 0);

    section("Professional tax's look back at the year");
    ok("March's financial year began eleven months before it", monthsBefore(2001, 3).length === 11 && monthsBefore(2000, 4).length === 0);
    // October and January, both in the second half of FY 2000: ₹50,000 and ₹200 of tax on each.
    for (const month of [{ month: 10, year: 2000 }, { month: 1, year: 2001 }]) {
      const earlier = await db.payrollRun.create({ data: { ...month, status: "LOCKED" } });
      await db.payslip.create({
        data: { runId: earlier.id, userId: steady.id, monthDays: 31, paidDays: 31, basic: 25000, grossEarnings: 50000, professionalTax: 200, totalDeductions: 200, netPay: 49800, employerCost: 50000 },
      });
    }
    const march2001 = (await ptHistoryFor([steady.id, leaverId], 2001, 3)).get(steady.id);
    ok("March's half so far: October and January, 1,00,000", march2001?.halfYearGrossBefore === 100000, march2001?.halfYearGrossBefore);
    ok("...and 400 of tax already this year, for the ₹2,500 cap", march2001?.paidThisYear === 400, march2001?.paidThisYear);
    const september2000 = (await ptHistoryFor([steady.id], 2000, 9)).get(steady.id);
    ok("September 2000 looks back at April to August only — none of it", september2000?.halfYearGrossBefore === 0 && september2000.paidThisYear === 0);
    ok("somebody with no payslips starts at nothing", (await ptHistoryFor([leaverId], 2001, 3)).get(leaverId)?.paidThisYear === 0);
    const tnWorker = await person("TnWorker", { joinedOn: "2000-01-10" });
    await db.employeeProfile.update({ where: { userId: tnWorker.id }, data: { state: "Tamil Nadu" } });
    ok("with no branch, their work state is the one on their record", (await workStateOf(tnWorker.id)) === "Tamil Nadu");

    section("Leave carried into a year");
    const type = (code: string, data: { annualQuota: number; accrual: "ANNUAL" | "MONTHLY"; carryForward: boolean; maxCarryForward?: number }) =>
      db.leaveType.create({
        data: {
          code,
          name: `${TAG} ${code}`,
          active: false,
          paid: true,
          // Made after FY 2000 began and before FY 2001 did, so FY 2000 is the first year it can carry from.
          createdAt: d("2000-06-01"),
          ...data,
          maxCarryForward: data.maxCarryForward ?? null,
        },
      });
    const capped = await type("ZZCF", { annualQuota: 12, accrual: "ANNUAL", carryForward: true, maxCarryForward: 5 });
    const monthly = await type("ZZCM", { annualQuota: 18, accrual: "MONTHLY", carryForward: true });
    const lapses = await type("ZZNC", { annualQuota: 10, accrual: "ANNUAL", carryForward: false });
    const june = d("2001-06-15");

    const carrier = await person("Carrier", { joinedOn: "2000-01-10" });
    const balance = (typeId: string, year: number, figures: { opening?: number; credited: number; used?: number; adjustment?: number }) =>
      db.leaveBalance.create({ data: { userId: carrier.id, typeId, year, ...figures } });
    await balance(capped.id, 2000, { credited: 12, used: 4 });
    // Made the way the old code made every row: no opening, whatever last year left.
    await balance(capped.id, 2001, { opening: 0, credited: 12 });
    await balance(monthly.id, 2000, { credited: 13.5, used: 2 }); // last looked at in December: 9 months
    await balance(lapses.id, 2000, { credited: 10 });

    const cf = await ensureBalance(carrier.id, capped.id, 2001, june);
    ok("8 left last year, capped at 5: 5 carried", num(cf?.opening) === 5, num(cf?.opening));
    ok("...into the row made before carrying worked", (await db.leaveBalance.count({ where: { userId: carrier.id, typeId: capped.id, year: 2001 } })) === 1);

    await db.leaveBalance.update({ where: { userId_typeId_year: { userId: carrier.id, typeId: capped.id, year: 2000 } }, data: { used: 9 } });
    const after = await ensureBalance(carrier.id, capped.id, 2001, june);
    ok("a March leave approved late leaves 3, and 3 is carried", num(after?.opening) === 3, num(after?.opening));

    await db.leaveType.update({ where: { id: capped.id }, data: { carryForward: false } });
    const stopped = await ensureBalance(carrier.id, capped.id, 2001, june);
    ok("the type stops carrying: what was carried stays", num(stopped?.opening) === 3, num(stopped?.opening));

    const cm = await ensureBalance(carrier.id, monthly.id, 2001, june);
    const cmLast = await db.leaveBalance.findUnique({ where: { userId_typeId_year: { userId: carrier.id, typeId: monthly.id, year: 2000 } } });
    ok("last year's accrual is brought to the full 18 first", num(cmLast?.credited) === 18, num(cmLast?.credited));
    ok("...so 16 is carried, with no cap", num(cm?.opening) === 16, num(cm?.opening));
    ok("...and this year accrues April to June, 4.5", num(cm?.credited) === 4.5, num(cm?.credited));

    const nc = await ensureBalance(carrier.id, lapses.id, 2001, june);
    ok("a type that doesn't carry opens at nothing", num(nc?.opening) === 0, num(nc?.opening));

    await db.leaveType.update({ where: { id: capped.id }, data: { carryForward: true } });
    const quiet = await person("Quiet", { joinedOn: "2000-01-10" });
    const q = await ensureBalance(quiet.id, capped.id, 2001, june);
    const qLast = await db.leaveBalance.findUnique({ where: { userId_typeId_year: { userId: quiet.id, typeId: capped.id, year: 2000 } } });
    ok("nobody opened their FY 2000 balance: it is made now, the full 12", num(qLast?.credited) === 12, qLast ? num(qLast.credited) : "no row");
    ok("...and 5 of it carried", num(q?.opening) === 5, num(q?.opening));
    ok("...and nothing before FY 2000, when the type didn't exist", (await db.leaveBalance.count({ where: { userId: quiet.id, year: 1999 } })) === 0);

    const newcomer = await person("Newcomer", { joinedOn: "2001-05-01" });
    const nw = await ensureBalance(newcomer.id, capped.id, 2001, june);
    ok("joined in FY 2001: nothing carried", num(nw?.opening) === 0, num(nw?.opening));
    ok("...and no FY 2000 balance made for them", (await db.leaveBalance.count({ where: { userId: newcomer.id, year: 2000 } })) === 0);

    const undated = await person("Undated", {});
    const un = await ensureBalance(undated.id, capped.id, 2001, june);
    ok("no joining date and a record made after FY 2001 began: nothing carried", num(un?.opening) === 0, num(un?.opening));

    section("A cap lowered, and last year moving again");
    await db.leaveType.update({ where: { id: capped.id }, data: { maxCarryForward: 2 } });
    const lowered = await ensureBalance(carrier.id, capped.id, 2001, june);
    ok("the cap lowered to 2 after 3 were carried: the 3 stay", num(lowered?.opening) === 3, num(lowered?.opening));
    await db.leaveBalance.update({ where: { userId_typeId_year: { userId: carrier.id, typeId: capped.id, year: 2000 } }, data: { used: 10 } });
    const spent = await ensureBalance(carrier.id, capped.id, 2001, june);
    ok("...but another late March leave leaves 2 last year, and 2 is carried", num(spent?.opening) === 2, num(spent?.opening));

    section("What a year grants somebody who joined or left in it");
    const annual = { annualQuota: 12, accrual: "ANNUAL" };
    const accruing = { annualQuota: 18, accrual: "MONTHLY" };
    ok("annual, joined 20 October: six months of it", accruedTo(annual, 2001, june, { joinedOn: d("2001-10-20") }) === 6, accruedTo(annual, 2001, june, { joinedOn: d("2001-10-20") }));
    ok("annual, joined in March: one month of it", accruedTo(annual, 2001, june, { joinedOn: d("2002-03-20") }) === 1);
    ok("annual, joined before the year: all of it", accruedTo(annual, 2001, june, { joinedOn: d("2000-01-10") }) === 12);
    ok("annual, leaving in June doesn't shrink it", accruedTo(annual, 2001, d("2001-09-02"), { exitedOn: d("2001-06-15") }) === 12);
    ok("annual, left before the year: nothing", accruedTo(annual, 2001, june, { exitedOn: d("2001-03-31") }) === 0);
    ok("accruing, joined 10 May, asked in mid-June: May and June", accruedTo(accruing, 2001, june, { joinedOn: d("2001-05-10") }) === 3);
    ok("accruing, left 15 June, asked in September: April to June only", accruedTo(accruing, 2001, d("2001-09-02"), { exitedOn: d("2001-06-15") }) === 4.5);
    ok("accruing, nothing known: April to June", accruedTo(accruing, 2001, june) === 4.5);

    const mayJoiner = await person("MayJoiner", { joinedOn: "2001-05-10" });
    const may = await ensureBalance(mayJoiner.id, monthly.id, 2001, june);
    ok("a balance for somebody who joined in May accrues from May", num(may?.credited) === 3, num(may?.credited));
    const exiter = await person("Exiter", { joinedOn: "2000-01-10", exitedOn: "2001-06-15" });
    const ex = await ensureBalance(exiter.id, monthly.id, 2001, d("2001-09-02"));
    ok("...and for somebody who left in June stops at June, though opened in September", num(ex?.credited) === 4.5, num(ex?.credited));

    const lateJoiner = await person("LateJoiner", { joinedOn: "2001-03-20" });
    const late = await ensureBalance(lateJoiner.id, lapses.id, 2001, june);
    await db.leaveType.update({ where: { id: capped.id }, data: { maxCarryForward: 5 } });
    const lateCarry = await ensureBalance(lateJoiner.id, capped.id, 2001, june);
    const lateLast = await db.leaveBalance.findUnique({ where: { userId_typeId_year: { userId: lateJoiner.id, typeId: capped.id, year: 2000 } } });
    ok("joined 20 March 2001: FY 2000 is made with one month of the annual 12", num(lateLast?.credited) === 1, lateLast ? num(lateLast.credited) : "no row");
    ok("...so 1 is carried, not the 5 a whole year would", num(lateCarry?.opening) === 1, num(lateCarry?.opening));
    ok("...and this year's own grant is whole: they were here from its first day", num(late?.credited) === 10, num(late?.credited));

    section("A salary revised inside the month, through the run");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { runPayroll } = require("../src/actions/payroll") as typeof import("../src/actions/payroll");
    const { buildSettlement } = require("../src/actions/settlement") as typeof import("../src/actions/settlement");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const clerk = await person("Clerk", { joinedOn: "2000-01-10" });
    await db.userPermission.create({ data: { userId: clerk.id, permission: "payroll.manage", allowed: true, reason: TAG } });
    actorId = clerk.id;
    const flat = (userId: string, from: string, gross: number) =>
      db.salaryStructure.create({ data: { userId, effectiveFrom: d(from), basic: gross, pfApplicable: false, esiApplicable: false, ptApplicable: false } });
    // May 2001, 31 days: ₹31,000 to the 15th, ₹46,500 from the 16th; a day absent on the 20th.
    const raised = await person("Raised", { joinedOn: "2000-01-10" });
    await flat(raised.id, "2000-01-10", 31000);
    await flat(raised.id, "2001-05-16", 46500);
    await db.attendanceDay.create({ data: { userId: raised.id, date: d("2001-05-20"), status: "ABSENT" } });
    // Raised the same, absent on the 5th instead — before the raise.
    const earlyOff = await person("EarlyOff", { joinedOn: "2000-01-10" });
    await flat(earlyOff.id, "2000-01-10", 31000);
    await flat(earlyOff.id, "2001-05-16", 46500);
    await db.attendanceDay.create({ data: { userId: earlyOff.id, date: d("2001-05-05"), status: "ABSENT" } });
    const mayRun = await runPayroll({ month: 5, year: 2001 });
    ok("the run goes through", mayRun.ok, mayRun.ok ? "" : mayRun.error);
    const slipOf = (userId: string) => db.payslip.findFirst({ where: { userId, run: { month: 5, year: 2001 } } });
    const raisedSlip = await slipOf(raised.id);
    ok("15 days at ₹31,000 and 15 at ₹46,500 (one off after the raise): ₹37,500", num(raisedSlip?.grossEarnings) === 37500, num(raisedSlip?.grossEarnings));
    ok("...30 days paid, 1 loss of pay", num(raisedSlip?.paidDays) === 30 && num(raisedSlip?.lopDays) === 1);
    ok("...and the payslip says when it changed", /Salary revised in the month/.test(raisedSlip?.note ?? ""), raisedSlip?.note);
    const earlySlip = await slipOf(earlyOff.id);
    ok("the day off before the raise is docked at the old rate: ₹38,000", num(earlySlip?.grossEarnings) === 38000, num(earlySlip?.grossEarnings));

    section("A plan without Incentives — Deskzo People on its own");
    {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { currentTenant, runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
      const { moduleEntitled } = require("../src/lib/entitlements") as typeof import("../src/lib/entitlements");
      const { productByKey } = require("../src/lib/products") as typeof import("../src/lib/products");
      /* eslint-enable @typescript-eslint/no-require-imports */
      const here = await currentTenant();
      // The People product's own modules (hr, payroll, visitors, engagement): payroll is in it, Incentives is not.
      const peopleOnly = { ...here, entitlements: { ...here.entitlements, all: false, modules: [...(productByKey("people")?.modules ?? [])] } };
      ok(
        "(the plan here is the People product's: payroll in it, Incentives not)",
        moduleEntitled(peopleOnly.entitlements, here.country, "payroll") && !moduleEntitled(peopleOnly.entitlements, here.country, "incentives"),
      );
      // June 2001, 30 days, nobody absent: ₹30,000 — and a ₹5,000 award approved for the month.
      const earner = await person("Earner", { joinedOn: "2000-01-10" });
      await flat(earner.id, "2000-01-10", 30000);
      const award = await db.incentiveEarning.create({
        data: { userId: earner.id, createdById: clerk.id, fromDate: d("2001-06-01"), toDate: d("2001-06-30"), label: "Zzprobe award", amount: 5000, workings: TAG, status: "APPROVED" },
      });
      const juneSlip = () => db.payslip.findFirst({ where: { userId: earner.id, run: { month: 6, year: 2001 } } });
      const failed = (err: unknown) => ({ ok: false as const, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
      const peopleRun = await runAsTenant(peopleOnly, () => runPayroll({ month: 6, year: 2001 })).catch(failed);
      ok("payroll runs on a plan without Incentives", peopleRun.ok, peopleRun.ok ? "" : peopleRun.error);
      const unpaid = await juneSlip();
      ok("...the month's salary is paid, with no incentive on the payslip", num(unpaid?.grossEarnings) === 30000 && num(unpaid?.incentive) === 0, unpaid ? `${num(unpaid.grossEarnings)} / ${num(unpaid.incentive)}` : "no payslip");
      const waiting = await db.incentiveEarning.findUnique({ where: { id: award.id }, select: { status: true, payslipId: true } });
      ok("...and the approved award waits, unpaid, for a plan that has Incentives", waiting?.status === "APPROVED" && waiting.payslipId === null, JSON.stringify(waiting));
      const fullRun = await runPayroll({ month: 6, year: 2001 }).catch(failed);
      const paid = await juneSlip();
      const attached = await db.incentiveEarning.findUnique({ where: { id: award.id }, select: { payslipId: true } });
      ok(
        "with Incentives in the plan, recalculating the month puts the award on the payslip",
        fullRun.ok && num(paid?.incentive) === 5000 && !!paid && attached?.payslipId === paid.id,
        fullRun.ok ? `${num(paid?.incentive)} / ${attached?.payslipId ?? "not attached"}` : fullRun.error,
      );
    }

    // Leaving on 20 May with a raise saved for 1 June: the settlement pays at what they were on.
    const leaving = await person("LeavesBeforeRaise", { joinedOn: "2000-01-10", exitedOn: "2001-05-20" });
    await flat(leaving.id, "2000-01-10", 31000);
    await flat(leaving.id, "2001-06-01", 62000);
    const fnf = await buildSettlement(leaving.id);
    const settledFnf = fnf.ok ? await db.finalSettlement.findUnique({ where: { userId: leaving.id } }) : null;
    ok("a settlement pays the final month at the salary they left on, not a raise dated after", num(settledFnf?.salaryAmount) === 20000, fnf.ok ? num(settledFnf?.salaryAmount) : fnf.error);

    section("Balances brought from the old system");
    // FY 2000: the type was made in June, so Deskzo has no year before it to carry from.
    const mover = await person("Mover", { joinedOn: "2000-01-10" });
    const october2000 = d("2000-10-15");
    await db.leaveBalance.create({ data: { userId: mover.id, typeId: capped.id, year: 2000, openingTyped: 7, usedBefore: 2, used: 2 } });
    const typed = await ensureBalance(mover.id, capped.id, 2000, october2000);
    ok("a typed opening stands in for the carry Deskzo can't work out", num(typed?.opening) === 7, num(typed?.opening));
    const unTyped = await ensureBalance((await person("NotMoved", { joinedOn: "2000-01-10" })).id, capped.id, 2000, october2000);
    ok("...without one, nothing is carried into the type's first year, as before", num(unTyped?.opening) === 0, num(unTyped?.opening));
    const nextYear = await ensureBalance(mover.id, capped.id, 2001, june);
    ok("the next year carries from it: 7 + 12 − 2 taken before Deskzo = 17, capped at 5", num(nextYear?.opening) === 5, num(nextYear?.opening));

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { leaveOpeningSheet, saveLeaveOpenings } = require("../src/actions/leave-openings") as typeof import("../src/actions/leave-openings");
    const { financialYearOf } = require("../src/lib/hr/calendar") as typeof import("../src/lib/hr/calendar");
    const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const thisYear = financialYearOf((await workspaceClock()).calendarDate(new Date()));
    const unpaid = await db.leaveType.create({ data: { code: "ZZUP", name: `${TAG} unpaid`, active: false, paid: false, annualQuota: 0, accrual: "ANNUAL", carryForward: false } });
    actorId = clerk.id;
    ok("the sheet is HR's alone", (await leaveOpeningSheet()) === null);
    const refused = await saveLeaveOpenings({ year: thisYear, rows: [{ userId: mover.id, typeId: lapses.id, opening: 4, usedBefore: 3 }] });
    ok("...and so is saving it", !refused.ok, refused.ok ? "saved" : refused.error);
    await db.userPermission.create({ data: { userId: clerk.id, permission: "hr.manage", allowed: true, reason: TAG } });
    ok("with hr.manage, the sheet opens on this year", (await leaveOpeningSheet())?.year === thisYear);
    const saved = await saveLeaveOpenings({ year: thisYear, rows: [{ userId: mover.id, typeId: lapses.id, opening: 4, usedBefore: 3 }], note: "greytHR, 30 Sep" });
    const row = () => db.leaveBalance.findUnique({ where: { userId_typeId_year: { userId: mover.id, typeId: lapses.id, year: thisYear } } });
    const afterSave = await row();
    ok("saved: carried in 4, taken before 3, counted as used", saved.ok && num(afterSave?.opening) === 4 && num(afterSave?.openingTyped) === 4 && num(afterSave?.used) === 3 && num(afterSave?.usedBefore) === 3, saved.ok ? JSON.stringify({ opening: num(afterSave?.opening), used: num(afterSave?.used) }) : saved.error);
    await saveLeaveOpenings({ year: thisYear, rows: [{ userId: mover.id, typeId: lapses.id, opening: 4, usedBefore: 1 }] });
    ok("...taken before corrected to 1: used moves by the difference", num((await row())?.used) === 1, num((await row())?.used));
    await saveLeaveOpenings({ year: thisYear, rows: [{ userId: mover.id, typeId: lapses.id, opening: null, usedBefore: 1 }] });
    const cleared = await row();
    ok("...carried in taken back out: worked out again — nothing, for a type that doesn't carry", cleared?.openingTyped === null && num(cleared?.opening) === 0, num(cleared?.opening));
    const unpaidSave = await saveLeaveOpenings({ year: thisYear, rows: [{ userId: mover.id, typeId: unpaid.id, opening: 2, usedBefore: 0 }] });
    ok("an unpaid type has no balance to bring", !unpaidSave.ok, unpaidSave.ok ? "saved" : unpaidSave.error);
    const tooOld = await saveLeaveOpenings({ year: thisYear - 2, rows: [{ userId: mover.id, typeId: lapses.id, opening: 2, usedBefore: 0 }] });
    ok("this year or last only", !tooOld.ok, tooOld.ok ? "saved" : tooOld.error);
    const halfDay = await saveLeaveOpenings({ year: thisYear, rows: [{ userId: mover.id, typeId: lapses.id, opening: 2.25, usedBefore: 0 }] });
    ok("whole or half days", !halfDay.ok, halfDay.ok ? "saved" : halfDay.error);

    section("TDS worked out from the tax year");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { workOutTds } = require("../src/lib/hr/tds") as typeof import("../src/lib/hr/tds");
    const { adjustPayslip, saveTaxDeclaration, taxDeclarations } = require("../src/actions/payroll") as typeof import("../src/actions/payroll");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const rateOf = (basic: number) => ({ basic, hra: 0, conveyance: 0, medical: 0, specialAllowance: 0, otherAllowance: 0 });
    const noStatutory = { pfApplicable: false, esiApplicable: false, ptApplicable: false };
    const october = (userId: string, monthly: number, exitedOn: Date | null = null) =>
      workOutTds({ userId, year: 2026, month: 10, thisMonth: { gross: monthly, pf: 0, pt: 0 }, rate: { components: rateOf(monthly), flags: noStatutory, state: null, gender: null }, joinedOn: d("2000-01-10"), exitedOn, dateOfBirth: d("1990-05-05") });

    const joiner = await person("TaxedJoiner", { joinedOn: "2000-01-10" });
    const saved2 = await saveTaxDeclaration({ userId: joiner.id, taxYear: 2026, regime: "NEW", previousGross: 600000, previousTds: 30000 });
    ok("payroll saves a declaration", saved2.ok, saved2.ok ? "" : saved2.error);
    const fromPrevious = await october(joiner.id, 200000);
    ok("October, 2 lakh a month, 6 lakh and 30,000 TDS from a previous employer: 20,133", fromPrevious?.amount === 20133, fromPrevious?.amount);
    ok("...with nothing to warn about", fromPrevious?.warnings.length === 0, fromPrevious?.warnings.join(" | "));
    const untaxed = await person("Untaxed", { joinedOn: "2000-01-10" });
    const missing = await october(untaxed.id, 300000);
    ok("no payslips April to September and nothing declared: worked out on what's known", missing?.amount === 25133, missing?.amount);
    ok("...and says six months are missing", missing?.warnings.some((w) => w.startsWith("6 earlier month(s)")) === true, missing?.warnings.join(" | "));
    const leavingDec = await october(untaxed.id, 300000, d("2026-12-31"));
    ok("leaving in December: two months to come, not five", leavingDec?.monthsLeft === 3, leavingDec?.monthsLeft);
    await saveTaxDeclaration({ userId: untaxed.id, taxYear: 2026, regime: "OLD", section80C: 150000 });
    ok("the old regime when they've chosen it", (await october(untaxed.id, 300000))?.regime === "OLD");
    ok("a tax year Deskzo has no rates for: nothing worked out", (await workOutTds({ userId: untaxed.id, year: 2001, month: 5, thisMonth: { gross: 1, pf: 0, pt: 0 }, rate: { components: rateOf(1), flags: noStatutory, state: null, gender: null }, joinedOn: null, exitedOn: null, dateOfBirth: null })) === null);
    const view = await taxDeclarations(untaxed.id);
    ok("the declarations read back for the record", view?.declarations.some((x) => x.taxYear === 2026 && x.regime === "OLD" && x.section80C === 150000) === true);

    // The run keeps a typed figure: May 2001's payslip, typed 500.
    const raisedMay = await db.payslip.findFirstOrThrow({ where: { userId: raised.id, run: { month: 5, year: 2001 } } });
    ok("a payslip in a year without rates says to type TDS", /doesn't work out TDS for this tax year/.test(raisedMay.note ?? "") && raisedMay.incomeTaxBasis === null, raisedMay.note);
    const typedSave = await adjustPayslip({ id: raisedMay.id, incomeTax: 500, otherDeduction: 0 });
    ok("TDS typed on it", typedSave.ok && (await db.payslip.findUniqueOrThrow({ where: { id: raisedMay.id } })).incomeTaxBasis === "TYPED", typedSave.ok ? "" : typedSave.error);
    await runPayroll({ month: 5, year: 2001 });
    const afterRerun = await db.payslip.findFirstOrThrow({ where: { userId: raised.id, run: { month: 5, year: 2001 } } });
    ok("...and kept when the month is recalculated", num(afterRerun.incomeTax) === 500 && afterRerun.incomeTaxBasis === "TYPED", num(afterRerun.incomeTax));
    const workOut = await adjustPayslip({ id: afterRerun.id, incomeTax: 500, otherDeduction: 0, workOutTax: true });
    ok("'work it out' in a year without rates is refused", !workOut.ok, workOut.ok ? "worked out" : workOut.error);
  } finally {
    await cleanup();
    const left =
      (await db.user.count({ where: { email: { endsWith: MAIL } } })) +
      (await db.leaveType.count({ where: { code: { in: CODES } } })) +
      (await db.role.count({ where: { key: ROLE } }));
    ok("nothing of the fixture is left behind", left === 0, left);
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll pay-period checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
