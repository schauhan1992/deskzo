import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { automationUserId } from "@/lib/automation-user";
import { runRevenueRecognition, hasActiveSchedules } from "@/lib/revenue/run";
import { indiaToday, lastCompletedMonth, monthKeyOf } from "@/lib/close/months";
import { ensureDefaultTemplates } from "@/lib/close/templates";
import { evaluateAutoChecks, generateTasks, sendCloseNotifications } from "@/lib/close/checklist";
import { anyActiveAccountingSchedule, runAccountingSchedules } from "@/lib/close/schedules";
import { readCloseSettings } from "@/lib/close/settings";

/**
 * Revenue & Close's nightly work (spec §5), for the workspace in hand — called from the five-minute
 * heartbeat (src/lib/marketing/heartbeat.ts), which runs it once a day per workspace:
 *
 *   1. With the add-on in the plan and switched on: the checklist templates seeded if they never were,
 *      last month's checklist generated, every open month's automatic checks run.
 *   2. With "Post recognition and schedules automatically" on — and the add-on on, **or** any revenue
 *      or prepaid/accrual schedule still running, so nothing is stranded on the balance sheet when the
 *      add-on is dropped — revenue recognition and the prepaid/accrual run through the last completed
 *      month, as the workspace's Automation account. The checks those postings move (revenue
 *      recognised, schedules posted, flux explained) are then run again, so the checklist reflects them.
 *   3. Owners told of tasks due in two days, and of overdue ones — after the checks, so nobody is
 *      chased for a task a check has just ticked.
 *
 * **Once per workspace per India day.** The claim is a `DailyJobRun (revenue-close, day)` row: the first
 * heartbeat to insert it does the work, and every later one — the next five-minute tick, or a second
 * server firing the same tick — hits the key and leaves, as ActivityAward's claim works. A workspace
 * with nothing to do (no add-on, no schedules) is not claimed at all, so the table stays empty there.
 *
 * **A failure in one step never stops the others**, and none reaches the heartbeat. Each step is timed
 * and logged; the row records `ok` and, when a step failed, which and why. Reads and writes go through
 * the workspace's own client (`db`) as the rest of the heartbeat's do; nothing here needs a session.
 */

export const NIGHTLY_JOB = "revenue-close";

export type NightlyStep = { step: string; ok: boolean; ms: number; result?: unknown; error?: string };
export type NightlyReport = { ran: boolean; reason?: string; day: string; steps: NightlyStep[] };

/** The affected checks: what a posting run can turn from failing to passing. */
const POSTING_CHECKS = ["revenue-recognised", "schedules-posted", "flux-explained"] as const;

export async function runRevenueAndClose(now: Date = new Date()): Promise<NightlyReport> {
  const day = indiaToday(now);
  const dayKey = day.toISOString().slice(0, 10);
  const report: NightlyReport = { ran: false, day: dayKey, steps: [] };

  if (await db.dailyJobRun.findUnique({ where: { job_day: { job: NIGHTLY_JOB, day } }, select: { job: true } })) {
    return { ...report, reason: "already ran today" };
  }

  const moduleOn = await moduleAvailableForTenant("revenue_close");
  const settings = await readCloseSettings();
  const stranded = !moduleOn && settings.autoPost && ((await hasActiveSchedules()) || (await anyActiveAccountingSchedule()));
  if (!moduleOn && !stranded) return { ...report, reason: "the add-on is off and no schedule is running" };

  // The claim. Whoever inserts the row runs; anybody else gets the unique violation and leaves.
  try {
    await db.dailyJobRun.create({ data: { job: NIGHTLY_JOB, day, ranAt: now } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { ...report, reason: "another run claimed today" };
    throw err;
  }
  report.ran = true;

  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    const started = Date.now();
    try {
      const result = await fn();
      report.steps.push({ step: name, ok: true, ms: Date.now() - started, result });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      report.steps.push({ step: name, ok: false, ms: Date.now() - started, error });
      console.error(`revenue & close nightly: ${name} failed`, err);
      return undefined;
    }
  };

  const through = lastCompletedMonth(now);
  const openMonths = async () => {
    const withTasks = await db.closeTask.groupBy({ by: ["month"] });
    const closed = new Set(
      (await db.closeMonth.findMany({ where: { status: "CLOSED" }, select: { month: true } })).map((m) => m.month.getTime()),
    );
    return withTasks.map((t) => t.month).filter((m) => !closed.has(m.getTime())).sort((a, b) => a.getTime() - b.getTime());
  };

  if (moduleOn) {
    await step("seed templates", () => ensureDefaultTemplates(now));
    await step(`generate ${monthKeyOf(through)}`, () => generateTasks(through, { now }));
    await step("evaluate checks", async () => {
      const results = [];
      for (const month of await openMonths()) results.push(await evaluateAutoChecks(month, { now }));
      return results;
    });
  }

  if (settings.autoPost) {
    const actorId = await step("automation account", () => automationUserId());
    if (actorId) {
      const revenue = await step("recognise revenue", () => runRevenueRecognition({ throughMonth: monthKeyOf(through), actorId }));
      const schedules = await step("post prepaids and accruals", () => runAccountingSchedules({ throughMonth: through, actorId, now }));
      const posted = (revenue?.months.length ?? 0) + (schedules?.months.length ?? 0);
      if (moduleOn && posted > 0) {
        await step("re-check after posting", async () => {
          const results = [];
          for (const month of await openMonths()) results.push(await evaluateAutoChecks(month, { now, keys: [...POSTING_CHECKS] }));
          return results;
        });
      }
    }
  }

  if (moduleOn) await step("notify owners", () => sendCloseNotifications(now));

  const failed = report.steps.filter((s) => !s.ok);
  await db.dailyJobRun
    .update({
      where: { job_day: { job: NIGHTLY_JOB, day } },
      data: { ok: failed.length === 0, error: failed.length ? failed.map((s) => `${s.step}: ${s.error}`).join("; ").slice(0, 2000) : null },
    })
    .catch((err) => console.error("revenue & close nightly: could not record the run", err));
  console.log(
    `revenue & close nightly ${dayKey}: ${report.steps.map((s) => `${s.step} ${s.ok ? "ok" : "FAILED"} ${s.ms}ms`).join(", ")}`,
  );
  return report;
}
