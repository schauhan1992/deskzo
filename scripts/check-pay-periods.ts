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
 *   · a settlement that pays the leaving month's salary takes them off that month's payroll, and one
 *     that paid none (a locked payslip got there first) does not;
 *   · a run calculated before such a settlement names who it would pay twice, which is what stops
 *     it being locked;
 *   · a carried balance is last year's closing, capped; worked out again when last year moves; never
 *     taken back when the type stops carrying; nothing for a type that does not carry;
 *   · last year's accrual is brought to the full year before it is carried;
 *   · a year nobody opened is made for somebody who was here, and not for somebody who joined after
 *     it or a record made after it;
 *   · a balance made before carrying worked (opening 0) is put right the next time it is looked at.
 *
 *   npm run check:pay-periods
 */
import "dotenv/config";
import { directClient } from "../src/lib/tenancy/direct-client";

const db = directClient();
const TAG = "ZZPROBE_PAY";
const ROLE = "ZZPROBE_PAY";
const MAIL = "@zzprobe-pay.invalid";
const CODES = ["ZZCF", "ZZCM", "ZZNC"];

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const num = (v: unknown) => Number(v ?? 0);

async function cleanup() {
  await db.payslip.deleteMany({ where: { run: { month: 3, year: 2001 } } });
  await db.payrollRun.deleteMany({ where: { month: 3, year: 2001 } });
  // Balances and settlements go with the people and types (onDelete: Cascade).
  await db.leaveType.deleteMany({ where: { code: { in: CODES } } });
  await db.user.deleteMany({ where: { email: { endsWith: MAIL } } });
  await db.role.deleteMany({ where: { key: ROLE } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { alsoPaidBySettlement, payrollMonth } = require("../src/lib/hr/payroll-month") as typeof import("../src/lib/hr/payroll-month");
  const { ensureBalance } = require("../src/lib/hr/leave-balance") as typeof import("../src/lib/hr/leave-balance");
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
    await person("Leaver", { joinedOn: "2000-01-10", exitedOn: "2001-03-10" });
    await person("GoneLoginKept", { joinedOn: "2000-01-10", exitedOn: "2001-02-15" }, true);
    await person("GoneLoginOff", { joinedOn: "2000-01-10", exitedOn: "2001-02-15" }, false);
    const settled = await person("Settled", { joinedOn: "2000-01-10", exitedOn: "2001-03-12" });
    const settledNone = await person("SettledNone", { joinedOn: "2000-01-10", exitedOn: "2001-03-25" });
    await person("NoProfile", null);
    const settlement = (userId: string, lastWorkingDay: string, salaryDays: number) =>
      db.finalSettlement.create({ data: { userId, lastWorkingDay: d(lastWorkingDay), serviceYears: 1, salaryDays } });
    await settlement(settled.id, "2001-03-12", 12);
    await settlement(settledNone.id, "2001-03-25", 0);

    const march = await payrollMonth(2001, 3);
    const paid = new Map(march.people.filter((p) => p.name.startsWith("Zzprobe ")).map((p) => [p.name.replace("Zzprobe ", ""), p.employment]));
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
    ok("a settlement that pays March's days takes them off March's payroll", !paid.has("Settled"));
    ok("...and says why", skipped.some((s) => s.includes("Settled") && s.includes("settlement")), skipped.join(" | "));
    ok("a settlement that paid none of March leaves them on it", span("SettledNone") === "1–25 (25)", span("SettledNone"));
    ok("no employee record is paid as before — the whole month", span("NoProfile") === "1–31 (31)", span("NoProfile"));

    const february = await payrollMonth(2001, 2);
    const febNames = new Set(february.people.map((p) => p.name));
    ok("February pays the February leaver to the 15th", february.people.find((p) => p.name === "Zzprobe GoneLoginKept")?.employment.days === 15);
    ok("...with the login off too: leaving in the month still pays the month", febNames.has("Zzprobe GoneLoginOff"));
    ok("February doesn't pay March's joiner", !febNames.has("Zzprobe Joiner"));
    ok("...but names them as joining later", february.skipped.some((s) => s.includes("Zzprobe Joiner") && s.includes("joins on")));
    ok("steady is still there", febNames.has(steady.name));

    section("A run calculated before the settlement was made");
    // March 2001 as if it had been run before Settled's settlement existed: it pays them too.
    const run = await db.payrollRun.create({ data: { month: 3, year: 2001 } });
    const slip = (userId: string, days: number) =>
      db.payslip.create({
        data: { runId: run.id, userId, monthDays: 31, paidDays: days, basic: 0, grossEarnings: 0, totalDeductions: 0, netPay: 0, employerCost: 0 },
      });
    await slip(steady.id, 31);
    await slip(settled.id, 12);
    await slip(settledNone.id, 25);
    const twice = await alsoPaidBySettlement(run.id, 2001, 3);
    ok("the person the settlement pays is named, so the run can't be locked", twice.length === 1 && twice[0] === settled.name, twice.join(", ") || "nobody");
    ok("...not somebody whose settlement left the month to the payroll", !twice.includes(settledNone.name));
    ok("...nor anybody who hasn't left", !twice.includes(steady.name));

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
