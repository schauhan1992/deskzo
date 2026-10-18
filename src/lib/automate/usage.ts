import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { notifyUser } from "@/lib/notify";
import { notMigratedYet } from "@/lib/not-migrated";
import { currentTenant } from "@/lib/tenancy/resolve";
import type { Tenant } from "@/lib/tenancy/state";
import { clockOfTenant } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";
import { PLAN_LIMITS, automationLimits, type AutomationLimits } from "@/lib/automate/limits";

/**
 * Deskzo Automate against its plan's limits (Phase 7), inside a workspace.
 *
 *   · Steps: every action that ran and did something, never a test, counted in this month's row
 *     (`automation_usage`, the month by the workspace's own clock) in the same transaction that
 *     records the step — so a step is counted exactly when it is. Once the month's allowance is used
 *     no new run starts (src/lib/automate/engine.ts, store.ts); runs already going finish, and their
 *     steps still count. Admins — whoever manages settings, as Automate is theirs — are told once a
 *     month at four fifths, and once when none are left.
 *   · Workflows switched on: refused past the limit when one is published or switched on, under a lock
 *     so two at once can't both take the last place. Workflows already on stay on when a plan shrinks.
 *   · History: finished runs older than the plan keeps are deleted once a day, their steps with them,
 *     and the approval requests made from them.
 *
 * A workspace whose entitlements were worked out before Phase 7 has no limits written: none apply.
 */

/** Four fifths: the first warning. */
export const LOW_SHARE = 0.8;

/** A month's row: its first day by the workspace's clock, as a `@db.Date` holds a day. */
export function usageMonth(clock: Clock, at: Date = new Date()): { key: string; date: Date } {
  const key = clock.monthKey(at);
  return { key, date: new Date(`${key}-01T00:00:00.000Z`) };
}

/** This workspace's Automate limits. */
export async function limitsHere(): Promise<AutomationLimits> {
  return automationLimits((await currentTenant()).entitlements);
}

/** Counts one step in this month's row, inside the step's own transaction; the month's count after it. */
export async function countStep(tx: Prisma.TransactionClient, clock: Clock, at: Date = new Date()): Promise<number> {
  const { key } = usageMonth(clock, at);
  const rows = await tx.$queryRaw<{ steps: number }[]>`
    INSERT INTO "automation_usage" ("month", "steps", "updatedAt")
    VALUES (${`${key}-01`}::date, 1, now())
    ON CONFLICT ("month") DO UPDATE SET "steps" = "automation_usage"."steps" + 1, "updatedAt" = now()
    RETURNING "steps"`;
  return Number(rows[0]?.steps ?? 0);
}

/** Steps used in the month an instant falls in; 0 in a workspace not migrated to Phase 7 yet. */
export async function stepsUsed(clock: Clock, at: Date = new Date()): Promise<number> {
  try {
    const row = await db.automationUsage.findUnique({ where: { month: usageMonth(clock, at).date }, select: { steps: true } });
    return row?.steps ?? 0;
  } catch (err) {
    if (notMigratedYet(err)) return 0;
    throw err;
  }
}

/** Why no new run may start now — this month's steps are used — or null when one may. */
export async function stepsRefusal(clock: Clock, now: Date = new Date(), limits?: AutomationLimits): Promise<string | null> {
  const { steps } = limits ?? (await limitsHere());
  if (steps === null) return null;
  if ((await stepsUsed(clock, now)) < steps) return null;
  return `This month's ${steps.toLocaleString("en-IN")} Automate steps are used, so no new run starts until ${clock.date(clock.monthWindow(now).to)}.`;
}

/** The people told about steps: whoever manages the workspace's settings, as Automate is theirs. */
async function automateAdmins(): Promise<string[]> {
  const people = await db.user.findMany({ where: { active: true, kind: "MEMBER" }, select: { id: true }, take: 2000 });
  const allowed = await Promise.all(people.map(async (p) => ((await can(p.id, "settings.manage")) ? p.id : null)));
  return allowed.filter((id): id is string => id !== null);
}

/**
 * After a step is counted: at four fifths of the month's steps, and at all of them, the admins are told —
 * once a month each, claimed with a conditional update first so two steps crossing at once tell them once.
 */
export async function afterStepCounted(steps: number, clock: Clock, now: Date = new Date(), limits?: AutomationLimits): Promise<void> {
  const limit = (limits ?? (await limitsHere())).steps;
  if (limit === null || limit <= 0) return;
  const which = steps >= limit ? "warned100At" : steps >= limit * LOW_SHARE ? "warned80At" : null;
  if (!which) return;
  const month = usageMonth(clock, now).date;
  // Crossing all of them at once counts as crossing four fifths too.
  const claimed = await db.automationUsage.updateMany({
    where: { month, [which]: null },
    data: which === "warned100At" ? { warned100At: now } : { warned80At: now },
  });
  if (!claimed.count) return;
  if (which === "warned100At") await db.automationUsage.updateMany({ where: { month, warned80At: null }, data: { warned80At: now } });
  const renews = clock.date(clock.monthWindow(now).to);
  const plus = `Automate Plus adds ${PLAN_LIMITS.plus.steps.toLocaleString("en-IN")} a month.`;
  const title = which === "warned100At" ? "Automate steps are used up" : "Automate steps are running low";
  const message =
    which === "warned100At"
      ? `All ${limit.toLocaleString("en-IN")} of this month's steps are used, so no new workflow run starts until ${renews}. Runs already going finish. ${plus}`
      : `Four fifths of this month's ${limit.toLocaleString("en-IN")} steps are used — ${Math.max(0, limit - steps).toLocaleString("en-IN")} left. They renew on ${renews}. ${plus}`;
  for (const userId of await automateAdmins()) await notifyUser({ userId, type: "AUTOMATE_STEPS", title, message, link: "/automate/workflows" });
}

/** Thrown inside a publish or a switch-on's transaction to undo it: the workspace is at its limit. */
export class WorkflowLimitReached extends Error {}

/** What a workspace at its limit of workflows switched on is told. */
export const workflowLimitText = (limit: number) =>
  limit === 0
    ? "This workspace's plan doesn't let workflows be switched on."
    : `This workspace's plan allows ${limit.toLocaleString("en-IN")} workflow${limit === 1 ? "" : "s"} switched on at once, and that many are. Switch one off first, or raise the limit with Automate Plus.`;

/**
 * Inside the transaction switching a workflow on: refuses (throws `WorkflowLimitReached`) when as many
 * others are on as the plan allows. One switch-on at a time takes the workspace's lock, so the count
 * can't be read twice before either is saved.
 */
export async function claimActivePlace(tx: Prisma.TransactionClient, workflowId: string, limits: AutomationLimits): Promise<void> {
  if (limits.workflows === null) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('automate:active-workflows'))`;
  const others = await tx.automationWorkflow.count({ where: { status: "ACTIVE", NOT: { id: workflowId } } });
  if (others >= limits.workflows) throw new WorkflowLimitReached(workflowLimitText(limits.workflows));
}

const PRUNE_JOB = "automate-history";
const DAY_MS = 86_400_000;

/**
 * Once a day: finished runs — succeeded, failed or stopped — older than the plan's history, deleted
 * with their steps. Runs waiting on a person (an unknown outcome) are kept whatever their age.
 */
export async function pruneRunHistory(clock: Clock, now: Date = new Date(), limits?: AutomationLimits): Promise<number | null> {
  const { historyDays } = limits ?? (await limitsHere());
  if (historyDays === null) return null;
  const day = clock.calendarDate(now);
  try {
    await db.dailyJobRun.create({ data: { job: PRUNE_JOB, day } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null;
    throw err;
  }
  const gone = await db.automationRun.deleteMany({
    where: { status: { in: ["SUCCEEDED", "FAILED", "CANCELLED"] }, finishedAt: { lt: new Date(now.getTime() - historyDays * DAY_MS) } },
  });
  // Approval requests are built from a run's data but not tied to it in the database: they go with it.
  await db.$executeRaw`
    DELETE FROM "approval_requests" a
     WHERE a."runId" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "automation_runs" r WHERE r."id" = a."runId")`;
  return gone.count;
}

/** The daily usage snapshot's Automate columns (src/lib/billing/reconcile.ts), inside the workspace; nothing yet in one not migrated. */
export async function automationSnapshot(tenant: Tenant, now: Date = new Date()): Promise<{ automationSteps: number; automationStepsLimit: number | null; automationWorkflows: number }> {
  const automationStepsLimit = automationLimits(tenant.entitlements).steps;
  try {
    const [automationSteps, automationWorkflows] = await Promise.all([stepsUsed(clockOfTenant(tenant), now), db.automationWorkflow.count({ where: { status: "ACTIVE" } })]);
    return { automationSteps, automationStepsLimit, automationWorkflows };
  } catch (err) {
    if (notMigratedYet(err)) return { automationSteps: 0, automationStepsLimit, automationWorkflows: 0 };
    throw err;
  }
}

/** What the Workflows page shows: this month's steps and the workflows on, against the plan's limits. */
export async function usageSummary(clock: Clock, now: Date = new Date()): Promise<{ limits: AutomationLimits; steps: number; active: number; renews: string }> {
  const [limits, steps, active] = await Promise.all([limitsHere(), stepsUsed(clock, now), db.automationWorkflow.count({ where: { status: "ACTIVE" } })]);
  return { limits, steps, active, renews: clock.date(clock.monthWindow(now).to) };
}
