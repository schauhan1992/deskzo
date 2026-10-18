import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Prisma, type AutomationErrorKind, type AutomationRunStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { notifyUser } from "@/lib/notify";
import { notMigratedYet } from "@/lib/not-migrated";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { currentTenant } from "@/lib/tenancy/resolve";
import { clockOfTenant } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";
import { ActionError, type FailureKind } from "@/lib/automate/action-types";
import { filterHolds } from "@/lib/automate/conditions";
import { advance, currentStep, enterBranch, enterList, isCursor, startCursor, stepKey, type Cursor } from "@/lib/automate/cursor";
import { LIMITS, childList, definitionSchema, delayMs, eachStep, type Definition, type Step } from "@/lib/automate/definition";
import { resolveValue, type RunContext } from "@/lib/automate/references";
import { summarize } from "@/lib/automate/redact";
import { actionByKey, actorRefusal } from "@/lib/automate/registry";
import { delayUntil, nextFire } from "@/lib/automate/schedule";
import { workspacePause } from "@/lib/automate/switches";
import { applyTransform } from "@/lib/automate/transform";
import { emitDateEvents, listensForDates } from "@/lib/automate/dates";
import { requestWakeHere } from "@/lib/automate/wake";
import { runRef, workflowPath } from "@/lib/automate/refs";
import { approversToTell, resolveApprovers, tellApprovers } from "@/lib/automate/approvals";
import { eventMeets, fixRules, type WaitRule } from "@/lib/automate/waits";
import { connectorLevelOf, connectorRefusal } from "@/lib/automate/limits";
import { afterStepCounted, countStep, limitsHere, pruneRunHistory, stepsRefusal } from "@/lib/automate/usage";

/**
 * Deskzo Automate's engine: events and schedules become runs, and runs are carried out a step at a
 * time (plan of 17 Oct 2026, "Execution engine"). Everything here runs inside one workspace
 * (`runAsTenant`), usually from the platform worker (src/lib/automate/worker.ts).
 *
 *   · Runs are rows. A worker claims due ones with FOR UPDATE SKIP LOCKED under a two-minute lease;
 *     one whose lease ran out is taken over. Five run at once per workspace.
 *   · Each step is saved before the next starts, in its own short transaction — the workspace's
 *     database role allows 30 s a statement and 60 s idle in a transaction. A worker that dies leaves
 *     the run to be resumed at its first unfinished step.
 *   · Actions get the key `runId:stepId` and record their effect with their write
 *     (src/lib/automate/effects.ts), so resuming never repeats one.
 *   · Network-type failures are tried again after 1 min, 5 min, 30 min, 2 h and 6 h; anything else
 *     fails the run at once; an outcome nobody can know waits for a person.
 *   · Limits: 1,000 runs per workflow an hour, one run per workflow per record a minute, workflows
 *     three deep and never themselves, 120 days a run, and twenty failures in a row pause a workflow.
 *   · Phase 6: an approval waits for its request in the approvals inbox (src/lib/automate/approvals.ts),
 *     a wait for an event for the matcher to find one (src/lib/automate/waits.ts), a for-each goes
 *     round its steps once per item, and a parallel step's paths run as runs of their own — the run
 *     goes on when the last of them is done. A step's key carries the for-each round it is in.
 */

export const ENGINE_LIMITS = {
  runsAtOnce: 5,
  runsPerWorkflowPerHour: 1_000,
  depth: 3,
  sameRecordMs: 60_000,
  runLifeMs: 120 * 86_400_000,
  failureStreakPause: 20,
  leaseMs: 2 * 60_000,
  stepsPerTurn: 25,
  turnMs: 10_000,
  retryDelaysMs: [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000],
  eventDays: 30,
} as const;

/** Which process holds a run: host, pid and a tag, for the lease and the log. */
const HOLDER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

// ─── Context ─────────────────────────────────────────────────────────────────────────────────────

async function sealContext(context: RunContext): Promise<string> {
  return encryptSecret(JSON.stringify(context));
}

async function openContext(cipher: string): Promise<RunContext> {
  const parsed = JSON.parse(await decryptSecret(cipher)) as RunContext;
  return { trigger: parsed.trigger ?? {}, steps: parsed.steps ?? {}, ...(parsed.test ? { test: parsed.test } : {}) };
}

export function parseDefinition(raw: unknown): Definition {
  return definitionSchema.parse(raw);
}

// ─── Making runs ─────────────────────────────────────────────────────────────────────────────────

export type NewRun = {
  workflowId: string;
  /** None for a test of a draft: `test.definition` is what it runs. */
  versionId: string | null;
  idempotencyKey: string;
  trigger: Record<string, unknown>;
  eventId?: string | null;
  recordKey?: string | null;
  depth?: number;
  isTest?: boolean;
  startedById?: string | null;
  /** A test run's draft, and whether its safe steps run for real (`LIVE_IN_TEST`). */
  test?: { definition?: Definition; live: boolean };
  /** Held by this process from the start — a test run carried out in the request that asked for it. */
  claimed?: boolean;
  /** A parallel step's path (Phase 6): where it starts, the outputs it starts with, and whose path it is. */
  cursor?: Cursor;
  steps?: RunContext["steps"];
  parentRunId?: string;
  parentStepKey?: string;
};

/**
 * The steps a test may do for real when the person testing ticks "live": a task, a note on the lead, a
 * notification — each undone by hand in a moment, and none of them reaching a customer.
 */
export const LIVE_IN_TEST: ReadonlySet<string> = new Set(["task.create", "lead.note", "notify.person"]);

/** A new run, or null when one with the same key exists — the same cause never makes two. */
export async function createRun(input: NewRun): Promise<string | null> {
  const contextCipher = await sealContext({ trigger: input.trigger, steps: input.steps ?? {}, ...(input.test ? { test: input.test } : {}) });
  const now = new Date();
  try {
    const run = await db.automationRun.create({
      data: {
        ...(input.claimed ? { status: "RUNNING" as const, lockedBy: HOLDER, lockedUntil: new Date(now.getTime() + ENGINE_LIMITS.leaseMs), startedAt: now } : {}),
        workflowId: input.workflowId,
        versionId: input.versionId,
        idempotencyKey: input.idempotencyKey,
        eventId: input.eventId ?? null,
        recordKey: input.recordKey ?? null,
        cursor: (input.cursor ?? startCursor()) as unknown as Prisma.InputJsonValue,
        contextCipher,
        ...(input.parentRunId ? { parentRunId: input.parentRunId, parentStepKey: input.parentStepKey ?? null } : {}),
        depth: input.depth ?? 0,
        isTest: input.isTest ?? false,
        startedById: input.startedById ?? null,
      },
      select: { id: true },
    });
    return run.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null;
    throw err;
  }
}

/** Events not yet looked at, turned into runs of the active workflows they trigger. */
export async function matchEvents(now: Date = new Date(), limit = 200): Promise<{ events: number; runs: number; skipped: number }> {
  const events = await db.automationEvent.findMany({ where: { matchedAt: null }, orderBy: { occurredAt: "asc" }, take: limit });
  if (!events.length) return { events: 0, runs: 0, skipped: 0 };

  const triggers = await db.automationTrigger.findMany({
    where: { type: { in: [...new Set(events.map((e) => e.type))] }, workflow: { status: "ACTIVE" } },
    select: { workflowId: true, versionId: true, type: true, workflow: { select: { activeVersionId: true } } },
  });
  const versions = new Map(
    (await db.automationVersion.findMany({ where: { id: { in: triggers.map((t) => t.versionId) } }, select: { id: true, definition: true } })).map((v) => [v.id, parseDefinition(v.definition)]),
  );
  const causes = new Map(
    (
      await db.automationRun.findMany({
        where: { id: { in: events.map((e) => e.causedByRunId).filter((id): id is string => !!id) } },
        select: { id: true, workflowId: true },
      })
    ).map((r) => [r.id, r.workflowId]),
  );

  let runs = 0;
  let skipped = 0;
  let woke = false;
  // This month's steps used: runs already going carry on, but these events start none.
  const outOfSteps = triggers.length ? await stepsRefusal(clockOfTenant(await currentTenant()), now) : null;
  for (const event of events) {
    if (await wakeWaiting(event, now)) woke = true;
    for (const trigger of triggers) {
      if (outOfSteps) {
        if (trigger.type === event.type) skipped += 1;
        continue;
      }
      if (trigger.type !== event.type || trigger.versionId !== trigger.workflow.activeVersionId) continue;
      // A webhook call is for the one workflow whose address it came to.
      if (event.type === "webhook" && (event.payload as { workflowId?: string } | null)?.workflowId !== trigger.workflowId) continue;
      // Workflows feeding workflows stop three deep, and none ever sets itself off.
      if (event.depth >= ENGINE_LIMITS.depth || (event.causedByRunId && causes.get(event.causedByRunId) === trigger.workflowId)) {
        skipped += 1;
        continue;
      }
      const definition = versions.get(trigger.versionId);
      if (!definition) continue;
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (!filterHolds(definition.trigger.filter, { trigger: payload, steps: {} })) continue;

      const recordKey = event.recordType && event.recordId ? `${event.recordType}:${event.recordId}` : null;
      if (recordKey) {
        const recent = await db.automationRun.count({ where: { workflowId: trigger.workflowId, recordKey, createdAt: { gte: new Date(now.getTime() - ENGINE_LIMITS.sameRecordMs) } } });
        if (recent > 0) {
          skipped += 1;
          continue;
        }
      }
      const lastHour = await db.automationRun.count({ where: { workflowId: trigger.workflowId, createdAt: { gte: new Date(now.getTime() - 3_600_000) } } });
      if (lastHour >= ENGINE_LIMITS.runsPerWorkflowPerHour) {
        skipped += 1;
        console.warn(`[automate] workflow ${trigger.workflowId} is over ${ENGINE_LIMITS.runsPerWorkflowPerHour} runs this hour; event ${event.id} skipped`);
        continue;
      }
      const id = await createRun({
        workflowId: trigger.workflowId,
        versionId: trigger.versionId,
        idempotencyKey: `${trigger.workflowId}:event:${event.id}`,
        eventId: event.id,
        recordKey,
        trigger: payload,
        depth: event.depth,
      });
      if (id) runs += 1;
    }
    await db.automationEvent.update({ where: { id: event.id }, data: { matchedAt: now } });
  }
  if (woke) await requestWakeHere(now);
  return { events: events.length, runs, skipped };
}

/**
 * Runs waiting for this kind of event (Phase 6): each whose rules the event meets — and that began
 * waiting before it happened — takes it and wakes. True when one did.
 */
async function wakeWaiting(event: { id: string; type: string; payload: Prisma.JsonValue; occurredAt: Date }, now: Date): Promise<boolean> {
  const waits = await db.automationEventWait.findMany({
    where: { eventType: event.type, matchedEventId: null, expiresAt: { gt: now }, createdAt: { lte: event.occurredAt } },
    select: { id: true, runId: true, rules: true, matchAny: true },
  });
  let woke = false;
  for (const wait of waits) {
    if (!eventMeets(event.payload, (wait.rules ?? []) as WaitRule[], wait.matchAny)) continue;
    const taken = await db.automationEventWait.updateMany({ where: { id: wait.id, matchedEventId: null }, data: { matchedEventId: event.id, matchedPayload: (event.payload ?? {}) as Prisma.InputJsonValue } });
    if (!taken.count) continue;
    await db.automationRun.updateMany({ where: { id: wait.runId, status: "WAITING" }, data: { runAfter: now } });
    woke = true;
  }
  return woke;
}

/** Schedules whose time has come: one run each, for the slot that came due — never one per slot missed. */
export async function fireSchedules(clock: Clock, now: Date = new Date()): Promise<number> {
  const due = await db.automationTrigger.findMany({
    where: { type: "schedule", nextFireAt: { lte: now }, workflow: { status: "ACTIVE" } },
    select: { id: true, workflowId: true, versionId: true, nextFireAt: true, workflow: { select: { activeVersionId: true } } },
  });
  let fired = 0;
  const outOfSteps = due.length ? await stepsRefusal(clock, now) : null;
  for (const trigger of due) {
    if (!trigger.nextFireAt || trigger.versionId !== trigger.workflow.activeVersionId) continue;
    const version = await db.automationVersion.findUnique({ where: { id: trigger.versionId }, select: { definition: true } });
    const schedule = version ? parseDefinition(version.definition).trigger.schedule : undefined;
    if (!schedule) continue;
    const slot = trigger.nextFireAt;
    // Claimed by moving it on: a second worker finds it already moved and leaves it.
    const claimed = await db.automationTrigger.updateMany({ where: { id: trigger.id, nextFireAt: slot }, data: { nextFireAt: nextFire(schedule, clock, now) } });
    if (!claimed.count || outOfSteps) continue;
    const id = await createRun({
      workflowId: trigger.workflowId,
      versionId: trigger.versionId,
      idempotencyKey: `${trigger.workflowId}:schedule:${slot.toISOString()}`,
      trigger: { scheduledFor: slot.toISOString(), firedAt: now.toISOString() },
    });
    if (id) fired += 1;
  }
  return fired;
}

// ─── Carrying runs out ───────────────────────────────────────────────────────────────────────────

/** Due runs this worker now holds, within the five a workspace may have going at once. */
export async function claimRuns(now: Date = new Date()): Promise<string[]> {
  const busy = await db.automationRun.count({ where: { status: "RUNNING", lockedUntil: { gt: now } } });
  const room = ENGINE_LIMITS.runsAtOnce - busy;
  if (room <= 0) return [];
  const until = new Date(now.getTime() + ENGINE_LIMITS.leaseMs);
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE "automation_runs"
       SET "status" = 'RUNNING', "lockedBy" = ${HOLDER}, "lockedUntil" = ${until}, "startedAt" = COALESCE("startedAt", ${now})
     WHERE "id" IN (
       SELECT "id" FROM "automation_runs"
        WHERE ("status" IN ('QUEUED', 'WAITING') AND "runAfter" <= ${now})
           OR ("status" = 'RUNNING' AND "lockedUntil" < ${now})
        ORDER BY "runAfter" ASC
        LIMIT ${room}
        FOR UPDATE SKIP LOCKED)
     RETURNING "id"`;
  return rows.map((r) => r.id);
}

type Held = {
  id: string;
  workflowId: string;
  versionId: string | null;
  parentRunId: string | null;
  parentStepKey: string | null;
  workflowName: string;
  ownerUserId: string;
  depth: number;
  isTest: boolean;
  attempts: number;
  stepsUsed: number;
  createdAt: Date;
  definition: Definition;
  cursor: Cursor;
  context: RunContext;
};

/** Saves where the run is, extending its lease — or false when another worker has taken it over. */
async function checkpoint(run: Held, data: Prisma.AutomationRunUpdateManyMutationInput, tx: Prisma.TransactionClient | null = null): Promise<boolean> {
  const client = tx ?? db;
  const saved = await client.automationRun.updateMany({
    where: { id: run.id, lockedBy: HOLDER },
    data: { lockedUntil: new Date(Date.now() + ENGINE_LIMITS.leaseMs), ...data },
  });
  return saved.count === 1;
}

/** The workflow's page in the builder; the list, in a workspace not migrated to its number yet. */
async function workflowLink(workflowId: string): Promise<string> {
  try {
    const row = await db.automationWorkflow.findUnique({ where: { id: workflowId }, select: { workflowSeq: true } });
    return row ? workflowPath(row.workflowSeq) : "/automate/workflows";
  } catch (err) {
    if (notMigratedYet(err)) return "/automate/workflows";
    throw err;
  }
}

async function pauseWorkflow(workflowId: string, reason: string, tell: string | null) {
  const paused = await db.automationWorkflow.updateMany({ where: { id: workflowId, status: "ACTIVE" }, data: { status: "PAUSED", pausedReason: reason } });
  if (paused.count && tell) {
    await notifyUser({ userId: tell, type: "WORKFLOW_PAUSED", title: "A workflow of yours paused itself", message: reason, link: await workflowLink(workflowId) });
  }
}

/** The run is over: its record, and the workflow's run of failures. */
async function finish(run: Held, status: AutomationRunStatus, error: string | null, extra: Prisma.AutomationRunUpdateManyMutationInput = {}) {
  const terminal = status !== "NEEDS_ATTENTION";
  const saved = await db.automationRun.updateMany({
    where: { id: run.id, lockedBy: HOLDER },
    data: { status, error: error ? error.slice(0, 1000) : null, lockedBy: null, lockedUntil: null, ...(terminal ? { finishedAt: new Date() } : {}), ...extra },
  });
  if (!saved.count) return;
  if (terminal) await afterEnd(run, status);
  // A test counts for nothing; a parallel path's run is counted by the run it belongs to.
  if (run.isTest || run.parentRunId) return;
  if (status === "SUCCEEDED") {
    await db.automationWorkflow.updateMany({ where: { id: run.workflowId, failureStreak: { gt: 0 } }, data: { failureStreak: 0 } });
  } else if (status === "FAILED") {
    const workflow = await db.automationWorkflow.update({ where: { id: run.workflowId }, data: { failureStreak: { increment: 1 } }, select: { failureStreak: true, ownerUserId: true } });
    if (workflow.failureStreak >= ENGINE_LIMITS.failureStreakPause) {
      await pauseWorkflow(run.workflowId, `It failed ${workflow.failureStreak} times in a row. The latest: ${error ?? "no reason given"}`.slice(0, 500), workflow.ownerUserId);
    }
  }
}

const OPEN: AutomationRunStatus[] = ["QUEUED", "RUNNING", "WAITING", "NEEDS_ATTENTION"];

/** A run that has ended: its approvals and waits go, its own paths stop, and the run it is a path of hears. */
async function afterEnd(run: Pick<Held, "id" | "parentRunId" | "parentStepKey">, status: AutomationRunStatus) {
  await db.approvalRequest.updateMany({ where: { runId: run.id, status: "PENDING" }, data: { status: "CANCELLED" } });
  await db.automationEventWait.deleteMany({ where: { runId: run.id } });
  if (status !== "SUCCEEDED") await stopPaths(run.id);
  if (run.parentRunId) await wakeParentIfDone(run.parentRunId, run.parentStepKey);
}

/** A run ended outside the engine — cancelled while it waited — settled as one the engine ended. */
export async function settleEndedRun(runId: string, status: AutomationRunStatus) {
  const run = await db.automationRun.findUnique({ where: { id: runId }, select: { id: true, parentRunId: true, parentStepKey: true } });
  if (run) await afterEnd(run, status);
}

/** The parallel paths of a run that has stopped, stopped too. */
export async function stopPaths(runId: string) {
  const now = new Date();
  const children = await db.automationRun.findMany({ where: { parentRunId: runId, status: { in: OPEN } }, select: { id: true, status: true } });
  for (const child of children) {
    if (child.status === "RUNNING") {
      await db.automationRun.updateMany({ where: { id: child.id, status: "RUNNING" }, data: { cancelRequested: true } });
    } else {
      const done = await db.automationRun.updateMany({ where: { id: child.id, status: { in: ["QUEUED", "WAITING", "NEEDS_ATTENTION"] } }, data: { status: "CANCELLED", finishedAt: now, error: "The run it is a path of stopped.", lockedBy: null, lockedUntil: null } });
      if (done.count) await afterEnd({ id: child.id, parentRunId: null, parentStepKey: null }, "CANCELLED");
    }
  }
}

/** Wakes a run waiting on its parallel paths once none of them is still going. */
export async function wakeParentIfDone(parentRunId: string, parentStepKey: string | null) {
  const open = await db.automationRun.count({ where: { parentRunId, ...(parentStepKey ? { parentStepKey } : {}), status: { in: OPEN } } });
  if (open) return;
  const woken = await db.automationRun.updateMany({ where: { id: parentRunId, status: "WAITING" }, data: { runAfter: new Date() } });
  if (woken.count) await requestWakeHere();
}

function failureKindOf(err: unknown): FailureKind {
  if (err instanceof ActionError) return err.kind;
  // Prisma's validation and constraint errors fail the same way every time; anything else may pass.
  if (err instanceof Prisma.PrismaClientValidationError) return "PERMANENT";
  if (err instanceof Prisma.PrismaClientKnownRequestError && /^P2(00[0-9]|01[0-9]|02[0-9])$/.test(err.code) && err.code !== "P2024" && err.code !== "P2028" && err.code !== "P2034") return "PERMANENT";
  return "TRANSIENT";
}

type StepRow = { id: string; startedAt: number };

async function startStep(run: Held, step: Step, inputSummary: unknown): Promise<StepRow> {
  const row = await db.automationRunStep.create({
    data: { runId: run.id, stepId: step.id, type: step.type, attempt: run.attempts + 1, status: "RUNNING", inputSummary: (inputSummary ?? Prisma.JsonNull) as Prisma.InputJsonValue },
    select: { id: true },
  });
  return { id: row.id, startedAt: Date.now() };
}

function stepDone(row: StepRow, status: "SUCCEEDED" | "FAILED" | "SKIPPED" | "UNKNOWN", output: unknown, error: string | null = null, kind: AutomationErrorKind | null = null, retryAt: Date | null = null) {
  return {
    where: { id: row.id },
    data: {
      status,
      finishedAt: new Date(),
      durationMs: Date.now() - row.startedAt,
      outputSummary: output === undefined ? Prisma.JsonNull : (summarize(output) as Prisma.InputJsonValue),
      error: error ? error.slice(0, 1000) : null,
      errorKind: kind,
      retryAt,
    },
  };
}

async function load(runId: string): Promise<Held | null> {
  const row = await db.automationRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      status: true,
      lockedBy: true,
      workflowId: true,
      versionId: true,
      parentRunId: true,
      parentStepKey: true,
      depth: true,
      isTest: true,
      attempts: true,
      stepsUsed: true,
      createdAt: true,
      cursor: true,
      contextCipher: true,
      version: { select: { definition: true } },
      workflow: { select: { name: true, ownerUserId: true } },
    },
  });
  if (!row || row.status !== "RUNNING" || row.lockedBy !== HOLDER) return null;
  const context = await openContext(row.contextCipher);
  return {
    id: row.id,
    workflowId: row.workflowId,
    versionId: row.versionId,
    parentRunId: row.parentRunId,
    parentStepKey: row.parentStepKey,
    workflowName: row.workflow.name,
    ownerUserId: row.workflow.ownerUserId,
    depth: row.depth,
    isTest: row.isTest,
    attempts: row.attempts,
    stepsUsed: row.stepsUsed,
    createdAt: row.createdAt,
    // A test of a draft runs the draft it carries; everything else, its published version.
    definition: parseDefinition(row.version ? row.version.definition : context.test?.definition),
    cursor: isCursor(row.cursor) ? row.cursor : startCursor(),
    context,
  };
}

/**
 * Carries a run this worker holds as far as it can now: to its end, a delay, a retry, or the turn's
 * limit (25 steps or 10 seconds, then it goes back in the queue so other runs get a turn).
 */
export async function advanceRun(runId: string, clock: Clock): Promise<AutomationRunStatus | "LOST"> {
  let run: Held | null;
  try {
    run = await load(runId);
  } catch (err) {
    // A run that can't be read (its context, its definition) will never be readable: it fails.
    await db.automationRun.updateMany({
      where: { id: runId, lockedBy: HOLDER },
      data: { status: "FAILED", error: `The run could not be read: ${err instanceof Error ? err.message : String(err)}`.slice(0, 1000), finishedAt: new Date(), lockedBy: null, lockedUntil: null },
    });
    return "FAILED";
  }
  if (!run) return "LOST";
  if (Date.now() - run.createdAt.getTime() > ENGINE_LIMITS.runLifeMs) {
    await finish(run, "FAILED", "The run passed its 120-day limit.");
    return "FAILED";
  }

  const turnEnds = Date.now() + ENGINE_LIMITS.turnMs;
  for (let taken = 0; ; taken += 1) {
    const live = await db.automationRun.findUnique({ where: { id: run.id }, select: { cancelRequested: true, lockedBy: true } });
    if (!live || live.lockedBy !== HOLDER) return "LOST";
    if (live.cancelRequested) {
      await finish(run, "CANCELLED", "Cancelled by a person.");
      return "CANCELLED";
    }

    const here = currentStep(run.definition, run.cursor);
    run.cursor = here.cursor;
    keepItems(run);
    const step = here.step;
    if (!step) {
      // A workflow that carries on past failures still says which steps failed.
      const failed = Object.entries(run.context.steps).filter(([, s]) => s.failed);
      const note = failed.length ? `${failed.length} step${failed.length === 1 ? "" : "s"} failed and ${failed.length === 1 ? "was" : "were"} passed over: ${failed.map(([id, s]) => `${id} — ${s.failed}`).join("; ")}` : null;
      await finish(run, "SUCCEEDED", note, { cursor: run.cursor as unknown as Prisma.InputJsonValue });
      return "SUCCEEDED";
    }
    if (taken >= ENGINE_LIMITS.stepsPerTurn || Date.now() > turnEnds) {
      if (!(await checkpoint(run, { status: "QUEUED", runAfter: new Date(), lockedBy: null, lockedUntil: null, cursor: run.cursor as unknown as Prisma.InputJsonValue }))) return "LOST";
      await requestWakeHere();
      return "QUEUED";
    }

    const outcome = await runStep(run, step, clock);
    if (outcome !== "NEXT") return outcome;
  }
}

/** Each for-each the cursor is in: its output names the item this time round. */
function keepItems(run: Held) {
  for (const frame of run.cursor.frames) {
    if (frame.of === undefined || !frame.branch) continue;
    const output = run.context.steps[frame.branch]?.output as { items?: unknown[] } | undefined;
    if (!output?.items) continue;
    const index = frame.iteration ?? 0;
    run.context.steps[frame.branch] = { output: { ...output, item: output.items[index] ?? null, index } };
  }
}

/** Parks a run until `until`, on the step it is on — an approval, a wait, a parallel step — to look again then, or when woken. */
async function park(run: Held, until: Date): Promise<"WAITING" | "LOST"> {
  const saved = await checkpoint(run, { status: "WAITING", runAfter: until, lockedBy: null, lockedUntil: null, attempts: 0, cursor: run.cursor as unknown as Prisma.InputJsonValue, contextCipher: await sealContext(run.context) });
  if (!saved) return "LOST";
  await requestWakeHere(until);
  return "WAITING";
}

/**
 * Parks the run, then looks once more: an answer that came while it was being parked — a decision, an
 * event, the last parallel path — found nobody waiting to wake, so the run wakes itself.
 */
async function parkUnless(run: Held, until: Date, ready: () => Promise<boolean>): Promise<"WAITING" | "LOST"> {
  const parked = await park(run, until);
  if (parked === "WAITING" && (await ready())) {
    const woken = await db.automationRun.updateMany({ where: { id: run.id, status: "WAITING" }, data: { runAfter: new Date() } });
    if (woken.count) await requestWakeHere();
  }
  return parked;
}

/** A step that can't go on, ever: recorded, and the run failed. */
async function failHere(run: Held, row: StepRow, message: string): Promise<"FAILED"> {
  await db.automationRunStep.update(stepDone(row, "FAILED", undefined, message, "PERMANENT"));
  await finish(run, "FAILED", message);
  return "FAILED";
}

/** Into one of a step's lists, or past the step when that list has nothing in it. */
function into(run: Held, step: Step, path: number, extra: Parameters<typeof enterList>[3] = {}): Cursor {
  return (childList(step, path) ?? []).length ? enterList(run.cursor, step.id, path, extra) : advance(run.cursor);
}

/** One step: saved, then the run moved on — or ended, put to wait, or put back for a retry. */
async function runStep(run: Held, step: Step, clock: Clock): Promise<"NEXT" | AutomationRunStatus | "LOST"> {
  const now = new Date();
  switch (step.type) {
    case "condition": {
      const row = await startStep(run, step, null);
      const passed = filterHolds(step.if, run.context);
      await db.automationRunStep.update(stepDone(row, "SUCCEEDED", { passed }));
      run.context.steps[step.id] = { output: { passed } };
      if (!passed) {
        await finish(run, "SUCCEEDED", null, { cursor: run.cursor as unknown as Prisma.InputJsonValue, contextCipher: await sealContext(run.context) });
        return "SUCCEEDED";
      }
      return (await save(run, advance(run.cursor))) ? "NEXT" : "LOST";
    }
    case "branch": {
      const row = await startStep(run, step, null);
      const index = step.paths.findIndex((p) => filterHolds(p.if, run.context));
      const path = index >= 0 ? step.paths[index]!.name : step.else ? "else" : "none";
      await db.automationRunStep.update(stepDone(row, "SUCCEEDED", { path }));
      run.context.steps[step.id] = { output: { path } };
      const next = index >= 0 ? enterBranch(run.cursor, step.id, index) : step.else ? enterBranch(run.cursor, step.id, -1) : advance(run.cursor);
      return (await save(run, next)) ? "NEXT" : "LOST";
    }
    case "transform": {
      const row = await startStep(run, step, null);
      const output: Record<string, unknown> = {};
      for (const [key, expr] of Object.entries(step.set)) output[key] = applyTransform(expr, run.context, clock);
      await db.automationRunStep.update(stepDone(row, "SUCCEEDED", output));
      run.context.steps[step.id] = { output };
      return (await save(run, advance(run.cursor))) ? "NEXT" : "LOST";
    }
    case "delay": {
      const row = await startStep(run, step, null);
      let until = delayUntil(step, clock, now);
      if (run.isTest) {
        // A test says when it would go on, and goes on now.
        const would = step.on ? String(resolveValue(step.on.value, run.context) ?? "") : until.toISOString();
        await db.automationRunStep.update(stepDone(row, "SUCCEEDED", { wouldWaitUntil: would, waited: false }));
        run.context.steps[step.id] = { output: { until: would, waited: false } };
        return (await save(run, advance(run.cursor))) ? "NEXT" : "LOST";
      }
      if (step.on) {
        // A time the data names, moved before or after it; never past the longest delay.
        const named = resolveValue(step.on.value, run.context);
        const at = typeof named === "string" || named instanceof Date ? new Date(named) : null;
        if (!at || Number.isNaN(at.getTime())) {
          const message = `"${step.on.value}" isn't a time to wait for.`;
          await db.automationRunStep.update(stepDone(row, "FAILED", undefined, message, "PERMANENT"));
          await finish(run, "FAILED", message);
          return "FAILED";
        }
        const moved = at.getTime() - (step.on.before ? delayMs(step.on.before) : 0) + (step.on.after ? delayMs(step.on.after) : 0);
        until = new Date(Math.min(moved, now.getTime() + LIMITS.delayDays * 86_400_000));
        if (until <= now) {
          // Already gone: nothing to wait for, on to the next step.
          await db.automationRunStep.update(stepDone(row, "SUCCEEDED", { until: until.toISOString(), waited: false }));
          run.context.steps[step.id] = { output: { until: until.toISOString(), waited: false } };
          const cursor = advance(run.cursor);
          if (!(await checkpoint(run, { cursor: cursor as unknown as Prisma.InputJsonValue, contextCipher: await sealContext(run.context), attempts: 0 }))) return "LOST";
          run.cursor = cursor;
          return "NEXT";
        }
      }
      await db.automationRunStep.update(stepDone(row, "SUCCEEDED", { until: until.toISOString() }));
      run.context.steps[step.id] = { output: { until: until.toISOString() } };
      const saved = await checkpoint(run, {
        status: "WAITING",
        runAfter: until,
        lockedBy: null,
        lockedUntil: null,
        attempts: 0,
        cursor: advance(run.cursor) as unknown as Prisma.InputJsonValue,
        contextCipher: await sealContext(run.context),
      });
      if (!saved) return "LOST";
      await requestWakeHere(until);
      return "WAITING";
    }
    case "stop": {
      const row = await startStep(run, step, null);
      await db.automationRunStep.update(stepDone(row, "SUCCEEDED", { outcome: step.outcome }));
      await finish(run, step.outcome === "succeeded" ? "SUCCEEDED" : "FAILED", step.outcome === "failed" ? (step.message ?? "Stopped as failed.") : null);
      return step.outcome === "succeeded" ? "SUCCEEDED" : "FAILED";
    }
    case "action":
      return runAction(run, step, clock);
    case "approval":
      return runApproval(run, step, now);
    case "waitForEvent":
      return runWait(run, step, now);
    case "forEach": {
      const row = await startStep(run, step, null);
      const items = resolveValue(step.items, run.context);
      if (!Array.isArray(items)) return failHere(run, row, `${typeof step.items === "string" ? step.items : "The items"} isn't a list.`);
      if (items.length > LIMITS.forEachItems) return failHere(run, row, `The list has ${items.length} items; a for-each goes through at most ${LIMITS.forEachItems}.`);
      await db.automationRunStep.update(stepDone(row, "SUCCEEDED", { count: items.length }));
      run.context.steps[step.id] = { output: { items, count: items.length, item: items[0] ?? null, index: 0 } };
      const next = items.length ? into(run, step, 0, { iteration: 0, of: items.length }) : advance(run.cursor);
      return (await save(run, next)) ? "NEXT" : "LOST";
    }
    case "parallel":
      return runParallel(run, step);
  }
}

const decided = async (requestId: string) => (await db.approvalRequest.findUnique({ where: { id: requestId }, select: { status: true } }))?.status !== "PENDING";
const taken = async (waitId: string) => !!(await db.automationEventWait.findUnique({ where: { id: waitId }, select: { matchedEventId: true } }))?.matchedEventId;
const pathsDone = async (runId: string, key: string) => (await db.automationRun.count({ where: { parentRunId: runId, parentStepKey: key, status: { in: OPEN } } })) === 0;

/**
 * An approval: the first time here, a request in the approvals inbox and the run parked until it
 * times out; woken by a decision — or the time running out — the approved or rejected steps.
 */
async function runApproval(run: Held, step: Extract<Step, { type: "approval" }>, now: Date): Promise<"NEXT" | AutomationRunStatus | "LOST"> {
  const key = stepKey(run.cursor, step.id);
  const title = String(resolveValue(step.title, run.context) ?? "").slice(0, 200) || "Approve this";
  if (run.isTest) {
    // A test says who it would ask, and goes on as approved.
    const row = await startStep(run, step, null);
    const asked = await resolveApprovers(step.approvers, run.context, run.ownerUserId);
    await db.automationRunStep.update(stepDone(row, "SUCCEEDED", { wouldAsk: asked.length, role: step.role ?? null, decision: "approved", test: true }));
    run.context.steps[step.id] = { output: { decision: "approved", decidedById: null, comment: null, timedOut: false } };
    return (await save(run, into(run, step, 0))) ? "NEXT" : "LOST";
  }
  let request = await db.approvalRequest.findUnique({ where: { runId_stepKey: { runId: run.id, stepKey: key } } });
  if (!request) {
    const row = await startStep(run, step, null);
    const approverIds = await resolveApprovers(step.approvers, run.context, run.ownerUserId);
    const tell = await approversToTell(approverIds, step.role ?? null);
    if (!tell.length) return failHere(run, row, "Nobody is left to approve this: the people named have left, and nobody holds the role.");
    const expiresAt = new Date(now.getTime() + delayMs(step.timeout));
    const message = step.message ? String(resolveValue(step.message, run.context) ?? "").slice(0, 2000) : null;
    const made = await db.approvalRequest.create({
      data: { kind: "WORKFLOW_STEP", workflowId: run.workflowId, runId: run.id, stepKey: key, title, summary: message, approverIds, approverRole: step.role ?? null, expiresAt, onTimeout: step.onTimeout },
      select: { id: true },
    });
    await db.automationRunStep.update(stepDone(row, "SUCCEEDED", { asked: tell.length, until: expiresAt.toISOString() }));
    const parked = await parkUnless(run, expiresAt, () => decided(made.id));
    if (parked === "WAITING") await tellApprovers(tell, title, run.workflowName);
    return parked;
  }
  if (request.status === "PENDING") {
    const id = request.id;
    if (request.expiresAt > now) return parkUnless(run, request.expiresAt, () => decided(id));
    // Nobody decided in time: it goes the way it was set to — unless a decision landed just now.
    const timed = await db.approvalRequest.updateMany({ where: { id: request.id, status: "PENDING" }, data: { status: "TIMED_OUT", decidedAt: now } });
    request = (await db.approvalRequest.findUnique({ where: { id: request.id } }))!;
    if (!timed.count && request.status === "PENDING") return parkUnless(run, request.expiresAt, () => decided(id));
  }
  if (request.status === "CANCELLED") {
    await finish(run, "CANCELLED", "The approval was cancelled.");
    return "CANCELLED";
  }
  const timedOut = request.status === "TIMED_OUT";
  const decision = timedOut ? (request.onTimeout === "approved" ? "approved" : "rejected") : request.status === "APPROVED" ? "approved" : "rejected";
  const row = await startStep(run, step, null);
  const by = request.decidedById ? (await db.user.findUnique({ where: { id: request.decidedById }, select: { name: true } }))?.name ?? null : null;
  await db.automationRunStep.update(stepDone(row, "SUCCEEDED", { decision, by, timedOut, comment: request.comment }));
  run.context.steps[step.id] = { output: { decision, decidedById: request.decidedById, decidedBy: by, comment: request.comment, timedOut } };
  return (await save(run, into(run, step, decision === "approved" ? 0 : 1))) ? "NEXT" : "LOST";
}

/** A wait for an event: the first time here, a wait the matcher looks at; woken by an event, or the time running out. */
async function runWait(run: Held, step: Extract<Step, { type: "waitForEvent" }>, now: Date): Promise<"NEXT" | AutomationRunStatus | "LOST"> {
  const key = stepKey(run.cursor, step.id);
  if (run.isTest) {
    const row = await startStep(run, step, null);
    await db.automationRunStep.update(stepDone(row, "SUCCEEDED", { wouldWaitFor: step.event, test: true }));
    run.context.steps[step.id] = { output: { timedOut: false, event: null } };
    return (await save(run, advance(run.cursor))) ? "NEXT" : "LOST";
  }
  const wait = await db.automationEventWait.findUnique({ where: { runId_stepKey: { runId: run.id, stepKey: key } }, select: { id: true, expiresAt: true, matchedEventId: true, matchedPayload: true } });
  if (!wait) {
    const row = await startStep(run, step, null);
    const { rules, any } = fixRules(step.filter, run.context);
    const expiresAt = new Date(now.getTime() + delayMs(step.timeout));
    const made = await db.automationEventWait.create({ data: { runId: run.id, stepKey: key, eventType: step.event, rules: rules as unknown as Prisma.InputJsonValue, matchAny: any, expiresAt }, select: { id: true } });
    await db.automationRunStep.update(stepDone(row, "SUCCEEDED", { waitingFor: step.event, until: expiresAt.toISOString() }));
    return parkUnless(run, expiresAt, () => taken(made.id));
  }
  let came = wait.matchedEventId ? wait.matchedPayload : null;
  if (!wait.matchedEventId) {
    if (wait.expiresAt > now) return parkUnless(run, wait.expiresAt, () => taken(wait.id));
    // Out of time — unless the event was taken just now.
    const gone = await db.automationEventWait.deleteMany({ where: { id: wait.id, matchedEventId: null } });
    if (!gone.count) came = (await db.automationEventWait.findUnique({ where: { id: wait.id }, select: { matchedPayload: true } }))?.matchedPayload ?? null;
  }
  await db.automationEventWait.deleteMany({ where: { id: wait.id } });
  const row = await startStep(run, step, null);
  const timedOut = came === null;
  await db.automationRunStep.update(stepDone(row, "SUCCEEDED", { timedOut, event: came }));
  run.context.steps[step.id] = { output: { timedOut, event: came } };
  if (timedOut && step.onTimeout === "stop") {
    await finish(run, "SUCCEEDED", null, { cursor: run.cursor as unknown as Prisma.InputJsonValue, contextCipher: await sealContext(run.context) });
    return "SUCCEEDED";
  }
  return (await save(run, advance(run.cursor))) ? "NEXT" : "LOST";
}

/**
 * A parallel step: its paths start as runs of their own, with this run's data, and this run waits.
 * Woken when the last is done, it takes in the outputs of every path's steps and goes on — or fails,
 * when a path failed or was cancelled. A test runs the paths one after another, in itself.
 */
async function runParallel(run: Held, step: Extract<Step, { type: "parallel" }>): Promise<"NEXT" | AutomationRunStatus | "LOST"> {
  if (run.isTest) {
    const row = await startStep(run, step, null);
    await db.automationRunStep.update(stepDone(row, "SUCCEEDED", { paths: step.paths.length, test: true }));
    run.context.steps[step.id] = { output: { paths: step.paths.length } };
    return (await save(run, enterList(run.cursor, step.id, 0, { paths: step.paths.length }))) ? "NEXT" : "LOST";
  }
  const key = stepKey(run.cursor, step.id);
  const children = await db.automationRun.findMany({ where: { parentRunId: run.id, parentStepKey: key }, orderBy: { runSeq: "asc" }, select: { id: true, runSeq: true, status: true, error: true, contextCipher: true, cursor: true } });
  const lastly = new Date(run.createdAt.getTime() + ENGINE_LIMITS.runLifeMs);
  // Every path started — or, after a worker died part way, the ones not started yet (each path's key
  // makes a second try at one that exists a no-op).
  if (children.length < step.paths.length) {
    const row = await startStep(run, step, null);
    for (const [i] of step.paths.entries()) {
      await createRun({
        workflowId: run.workflowId,
        versionId: run.versionId,
        idempotencyKey: `${run.id}:${key}:path${i}`,
        trigger: run.context.trigger,
        steps: run.context.steps,
        cursor: enterList(run.cursor, step.id, i, { scope: true }),
        depth: run.depth,
        parentRunId: run.id,
        parentStepKey: key,
      });
    }
    await db.automationRunStep.update(stepDone(row, "SUCCEEDED", { paths: step.paths.length, started: true }));
    await requestWakeHere();
    return parkUnless(run, lastly, () => pathsDone(run.id, key));
  }
  if (children.some((c) => OPEN.includes(c.status))) return parkUnless(run, lastly, () => pathsDone(run.id, key));

  const row = await startStep(run, step, null);
  const pathOf = (c: { cursor: Prisma.JsonValue }) => (isCursor(c.cursor) ? (c.cursor.frames.find((f) => f.branch === step.id)?.path ?? 0) : 0);
  const bad = children.find((c) => c.status !== "SUCCEEDED");
  if (bad) {
    const name = step.paths[pathOf(bad)]?.name ?? "A path";
    const message = `${name} ${bad.status === "CANCELLED" ? "was cancelled" : `failed: ${bad.error ?? "no reason given"}`} (${runRef(bad.runSeq)}).`;
    if (run.definition.settings?.onError === "continue") {
      await db.automationRunStep.update(stepDone(row, "FAILED", undefined, message, "PERMANENT"));
      run.context.steps[step.id] = { output: null, failed: message.slice(0, 300) };
      return (await save(run, advance(run.cursor))) ? "NEXT" : "LOST";
    }
    return failHere(run, row, message);
  }
  // Every path's steps' outputs, as each path's run left them.
  for (const child of children) {
    const context = await openContext(child.contextCipher);
    for (const { step: inner } of eachStep(step.paths[pathOf(child)]?.steps ?? [])) {
      const output = context.steps[inner.id];
      if (output) run.context.steps[inner.id] = output;
    }
  }
  await db.automationRunStep.update(stepDone(row, "SUCCEEDED", { paths: step.paths.length, runs: children.map((c) => runRef(c.runSeq)) }));
  run.context.steps[step.id] = { output: { paths: step.paths.length } };
  return (await save(run, advance(run.cursor))) ? "NEXT" : "LOST";
}

async function save(run: Held, cursor: Cursor): Promise<boolean> {
  const ok = await checkpoint(run, { cursor: cursor as unknown as Prisma.InputJsonValue, contextCipher: await sealContext(run.context), attempts: 0 });
  if (ok) run.cursor = cursor;
  return ok;
}

async function runAction(run: Held, step: Extract<Step, { type: "action" }>, clock: Clock): Promise<"NEXT" | AutomationRunStatus | "LOST"> {
  const action = actionByKey(step.action);
  const resolved = resolveValue(step.input, run.context);
  const row = await startStep(run, step, summarize(resolved));
  const fail = async (kind: FailureKind, message: string): Promise<"NEXT" | AutomationRunStatus | "LOST"> => {
    if (kind === "TRANSIENT" && !run.isTest && run.attempts < ENGINE_LIMITS.retryDelaysMs.length) {
      const retryAt = new Date(Date.now() + ENGINE_LIMITS.retryDelaysMs[run.attempts]!);
      await db.automationRunStep.update(stepDone(row, "FAILED", undefined, message, "TRANSIENT", retryAt));
      const saved = await checkpoint(run, { status: "QUEUED", runAfter: retryAt, attempts: run.attempts + 1, lockedBy: null, lockedUntil: null });
      if (!saved) return "LOST";
      await requestWakeHere(retryAt);
      return "QUEUED";
    }
    if (kind === "UNKNOWN") {
      await db.automationRunStep.update(stepDone(row, "UNKNOWN", undefined, message, "UNKNOWN"));
      await finish(run, "NEEDS_ATTENTION", message);
      return "NEEDS_ATTENTION";
    }
    const said = kind === "TRANSIENT" ? `${message} (gave up after ${run.attempts + 1} tries)` : message;
    await db.automationRunStep.update(stepDone(row, "FAILED", undefined, said, kind === "TRANSIENT" ? "TRANSIENT" : "PERMANENT"));
    if (run.definition.settings?.onError === "continue") {
      // Recorded on the step and the run, then on to the next step, as a pipeline automation did.
      run.context.steps[step.id] = { output: null, failed: said.slice(0, 300) };
      const cursor = advance(run.cursor);
      if (!(await checkpoint(run, { cursor: cursor as unknown as Prisma.InputJsonValue, contextCipher: await sealContext(run.context), attempts: 0 }))) return "LOST";
      run.cursor = cursor;
      return "NEXT";
    }
    await finish(run, "FAILED", said);
    return "FAILED";
  };

  if (!action) return fail("PERMANENT", `"${step.action}" isn't an action this version of Deskzo knows.`);
  const input = action.input.safeParse(resolved);
  if (!input.success) return fail("PERMANENT", input.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));

  const refusal = await actorRefusal(run.ownerUserId, action);
  if (refusal) {
    // An owner who has gone, or lost what the step needs, can't run any of it: the workflow pauses.
    if (!run.isTest) await pauseWorkflow(run.workflowId, refusal, null);
    return fail("PERMANENT", refusal);
  }

  // A test reads for real and says what the rest would do — except the safe steps, done for real
  // when the person testing asked for it (`LIVE_IN_TEST`).
  const really = !run.isTest || action.risk === "read" || (run.context.test?.live === true && LIVE_IN_TEST.has(action.key));
  const limits = await limitsHere();
  if (really) {
    // A plan that no longer has this connector (it changed since the workflow was published): the workflow pauses, its owner told.
    const outside = connectorRefusal(connectorLevelOf(action.key, input.data as Record<string, unknown>), limits);
    if (outside) {
      if (!run.isTest) await pauseWorkflow(run.workflowId, outside, run.ownerUserId);
      return fail("PERMANENT", outside);
    }
  }
  let output: unknown;
  if (!really) {
    output = { preview: action.preview(input.data as never) };
  } else {
    try {
      output = await action.run(
        { actorId: run.ownerUserId, workflowId: run.workflowId, workflowName: run.workflowName, runId: run.id, stepId: step.id, key: `${run.id}:${stepKey(run.cursor, step.id)}`, depth: run.depth, clock },
        input.data as never,
      );
    } catch (err) {
      return fail(failureKindOf(err), err instanceof Error ? err.message : String(err));
    }
  }
  run.context.steps[step.id] = { output };
  const cursor = advance(run.cursor);
  // Counted with the step, in its transaction: a step lost to another worker is never counted.
  let counted = null as number | null;
  const ok = await db.$transaction(async (tx) => {
    await tx.automationRunStep.update(stepDone(row, "SUCCEEDED", output));
    const saved = await checkpoint(
      run,
      { cursor: cursor as unknown as Prisma.InputJsonValue, contextCipher: await sealContext(run.context), attempts: 0, stepsUsed: run.isTest ? run.stepsUsed : run.stepsUsed + 1 },
      tx,
    );
    if (saved && !run.isTest) counted = await countStep(tx, clock);
    return saved;
  });
  if (!ok) return "LOST";
  run.cursor = cursor;
  if (!run.isTest) run.stepsUsed += 1;
  if (counted !== null) await afterStepCounted(counted, clock, new Date(), limits);
  return "NEXT";
}

// ─── A workspace's turn ──────────────────────────────────────────────────────────────────────────

export type TenantWork = { skipped?: "not-migrated" | "paused" | "off"; fired: number; matched: number; runs: number; turns: number };

/** Whether this workspace's database has Automate's tables yet. */
async function migrated(): Promise<boolean> {
  try {
    await db.automationRun.findFirst({ select: { id: true } });
    return true;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

/**
 * Everything due in the workspace this runs as: schedules, events, then runs, until nothing is due or
 * `budgetMs` is spent. Inside `runAsTenant`, under the worker's per-workspace lease.
 */
export async function workTenant(options: { budgetMs?: number } = {}): Promise<TenantWork> {
  const result: TenantWork = { fired: 0, matched: 0, runs: 0, turns: 0 };
  if (!(await migrated())) return { ...result, skipped: "not-migrated" };
  if ((await workspacePause()).paused) return { ...result, skipped: "paused" };
  if (!(await moduleAvailableForTenant("automate"))) return { ...result, skipped: "off" };
  // Pipeline automations not moved onto Automate yet, moved first — before the events they wait for are matched.
  // Loaded here: the conversion publishes through the store, which starts runs through this file.
  const { convertPipelineAutomations } = await import("@/lib/automate/migrate-pipeline");
  await convertPipelineAutomations().catch((err) => console.error("[automate] pipeline automations could not be moved", err instanceof Error ? err.message : err));

  const clock = clockOfTenant(await currentTenant());
  const deadline = Date.now() + (options.budgetMs ?? 20_000);
  result.fired = await fireSchedules(clock);
  // Once a day: invoices overdue, renewals coming, deals gone quiet (src/lib/automate/dates.ts).
  await emitDateEvents(clock);
  // Once a day: finished runs older than the plan keeps.
  await pruneRunHistory(clock);
  const matched = await matchEvents();
  result.matched = matched.runs;
  result.runs = result.fired + result.matched;
  while (Date.now() < deadline) {
    const ids = await claimRuns();
    if (!ids.length) break;
    for (const id of ids) {
      await advanceRun(id, clock);
      result.turns += 1;
    }
  }
  // Events are kept 30 days.
  await db.automationEvent.deleteMany({ where: { matchedAt: { not: null }, occurredAt: { lt: new Date(Date.now() - ENGINE_LIMITS.eventDays * 86_400_000) } } });
  return result;
}

/** When this workspace next has something due, or null when nothing is. */
export async function nextDueAt(now: Date = new Date()): Promise<Date | null> {
  const [unmatched, queued, held, schedule] = await Promise.all([
    db.automationEvent.findFirst({ where: { matchedAt: null }, select: { id: true } }),
    db.automationRun.findFirst({ where: { status: { in: ["QUEUED", "WAITING"] } }, orderBy: { runAfter: "asc" }, select: { runAfter: true } }),
    db.automationRun.findFirst({ where: { status: "RUNNING" }, orderBy: { lockedUntil: "asc" }, select: { lockedUntil: true } }),
    db.automationTrigger.findFirst({ where: { type: "schedule", nextFireAt: { not: null }, workflow: { status: "ACTIVE" } }, orderBy: { nextFireAt: "asc" }, select: { nextFireAt: true } }),
  ]);
  // Workflows on a date check wake a minute after the workspace's midnight, for the day's.
  let tomorrow: Date | null = null;
  if (await listensForDates()) {
    const clock = clockOfTenant(await currentTenant());
    const today = clock.parts(now);
    tomorrow = clock.at(today.year, today.month, today.day + 1, 0, 1);
  }
  const times = [unmatched ? now : null, queued?.runAfter ?? null, held?.lockedUntil ?? null, schedule?.nextFireAt ?? null, tomorrow].filter((t): t is Date => !!t);
  if (!times.length) return null;
  return new Date(Math.min(...times.map((t) => t.getTime())));
}
