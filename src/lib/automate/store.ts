import { createHash, randomUUID } from "node:crypto";
import type { AutomationWorkflowStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { currentTenant } from "@/lib/tenancy/resolve";
import { clockOfTenant } from "@/lib/time/workspace";
import { blankDefinition, eachStep, type Definition } from "@/lib/automate/definition";
import { advanceRun, createRun, ENGINE_LIMITS, settleEndedRun } from "@/lib/automate/engine";
import { actionByKey, actorRefusal } from "@/lib/automate/registry";
import { nextFire } from "@/lib/automate/schedule";
import { validateDefinition, type DefinitionProblem } from "@/lib/automate/validate";
import { requestWakeHere } from "@/lib/automate/wake";
import { sampleTrigger } from "@/lib/automate/samples";
import { blankProblem, templateByKey, type BlankValues } from "@/lib/automate/templates";
import { connectorLevelOf, connectorRefusal, type AutomationLimits } from "@/lib/automate/limits";
import { WorkflowLimitReached, claimActivePlace, limitsHere, stepsRefusal } from "@/lib/automate/usage";
import { forgetSending, sentKey } from "@/lib/automate/sent";

/**
 * Making and changing workflows, and the person-led things done to runs (Deskzo Automate). Server-only,
 * inside a workspace. The server actions (src/actions/automate.ts) check who may do these; the check
 * suite calls them directly.
 */

export type StoreResult<T> = { ok: true; data: T } | { ok: false; error: string; problems?: DefinitionProblem[] };

/**
 * A workflow runs as its owner — their mailbox, their connections, the records they may see — so only
 * they change, test or publish it (owner, 18 Oct 2026). Anybody else with Automate may pause it, run it,
 * duplicate it, or take it over (`takeOverWorkflow`).
 */
export const NOT_OWNER = "Only the workflow's owner can change, test or publish it — it runs as them. Duplicate it to make your own, or take it over.";

export type NewWorkflow = {
  name: string;
  description?: string | null;
  ownerUserId: string;
  createdById: string;
  draft?: Definition;
  /** Where it came from: built, a template's (`templateKey`), drafted by AI, or converted (`migratedFrom`). */
  source?: "BUILDER" | "TEMPLATE" | "AI" | "MIGRATED";
  templateKey?: string | null;
  migratedFrom?: string | null;
};

export async function createWorkflow(input: NewWorkflow): Promise<{ id: string }> {
  return db.automationWorkflow.create({
    data: {
      name: input.name.trim().slice(0, 120) || "Untitled workflow",
      description: input.description?.trim() || null,
      ownerUserId: input.ownerUserId,
      createdById: input.createdById,
      draft: (input.draft ?? blankDefinition()) as unknown as Prisma.InputJsonValue,
      ...(input.source ? { source: input.source } : {}),
      ...(input.templateKey ? { templateKey: input.templateKey } : {}),
      ...(input.migratedFrom ? { migratedFrom: input.migratedFrom } : {}),
    },
    select: { id: true },
  });
}

export async function saveDraft(workflowId: string, draft: unknown, meta: { name?: string; description?: string | null } = {}): Promise<StoreResult<{ problems: DefinitionProblem[] }>> {
  const workflow = await db.automationWorkflow.findUnique({ where: { id: workflowId }, select: { status: true } });
  if (!workflow) return { ok: false, error: "That workflow no longer exists." };
  if (workflow.status === "ARCHIVED") return { ok: false, error: "An archived workflow can't be changed." };
  // Saved as typed, even unfinished; the problems are what publishing would refuse.
  await db.automationWorkflow.update({
    where: { id: workflowId },
    data: {
      draft: draft as Prisma.InputJsonValue,
      ...(meta.name !== undefined ? { name: meta.name.trim().slice(0, 120) || "Untitled workflow" } : {}),
      ...(meta.description !== undefined ? { description: meta.description?.trim() || null } : {}),
    },
  });
  const checked = validateDefinition(draft);
  return { ok: true, data: { problems: checked.ok ? [] : checked.problems } };
}

/** The steps of a definition that reach further than the plan's connectors, each with why. */
function connectorProblems(definition: Definition, limits: AutomationLimits): DefinitionProblem[] {
  const problems: DefinitionProblem[] = [];
  for (const { step } of eachStep(definition.steps)) {
    if (step.type !== "action") continue;
    const refusal = connectorRefusal(connectorLevelOf(step.action, step.input as Record<string, unknown>), limits);
    if (refusal) problems.push({ stepId: step.id, field: null, message: refusal });
  }
  return problems;
}

/**
 * Publishes the draft as the next version and makes it the one that runs. Refused, with the problems
 * named, when the draft isn't valid — or when the owner or the person publishing can't take one of
 * its actions now, or the plan doesn't have one of its connectors or room for one more workflow on.
 * `converting`: a pipeline automation moved onto Automate (migrate-pipeline.ts), kept on as it was
 * whatever the plan's limits.
 */
export async function publishWorkflow(
  workflowId: string,
  publisherId: string,
  note: string | null = null,
  options: { converting?: boolean } = {},
): Promise<StoreResult<{ versionId: string; number: number }>> {
  const workflow = await db.automationWorkflow.findUnique({ where: { id: workflowId }, select: { draft: true, status: true, ownerUserId: true } });
  if (!workflow) return { ok: false, error: "That workflow no longer exists." };
  if (workflow.status === "ARCHIVED") return { ok: false, error: "An archived workflow can't be published." };
  if (publisherId !== workflow.ownerUserId) return { ok: false, error: NOT_OWNER };
  const checked = validateDefinition(workflow.draft);
  if (!checked.ok) return { ok: false, error: "The workflow has problems to fix before it can be published.", problems: checked.problems };
  const definition = checked.definition;

  const problems: DefinitionProblem[] = [];
  for (const { step } of eachStep(definition.steps)) {
    if (step.type !== "action") continue;
    const action = actionByKey(step.action);
    if (!action) continue;
    const ownerRefusal = await actorRefusal(workflow.ownerUserId, action);
    if (ownerRefusal) problems.push({ stepId: step.id, field: null, message: ownerRefusal });
  }
  if (problems.length) return { ok: false, error: "Its owner can't take one of its actions.", problems };
  const limits = await limitsHere();
  if (!options.converting) {
    const outside = connectorProblems(definition, limits);
    if (outside.length) return { ok: false, error: "This workspace's plan doesn't include a connector it uses.", problems: outside };
  }

  const clock = clockOfTenant(await currentTenant());
  const schedule = definition.trigger.type === "schedule" ? definition.trigger.schedule : undefined;
  const nextFireAt = schedule ? nextFire(schedule, clock, new Date()) : null;
  const hash = createHash("sha256").update(JSON.stringify(definition)).digest("hex");

  let version: { id: string; number: number };
  try {
    version = await db.$transaction(async (tx) => {
      // Publishing switches it on: refused when the plan has no room for one more on.
      if (!options.converting && workflow.status !== "ACTIVE") await claimActivePlace(tx, workflowId, limits);
      const last = await tx.automationVersion.findFirst({ where: { workflowId }, orderBy: { number: "desc" }, select: { number: true } });
      const created = await tx.automationVersion.create({
        data: { workflowId, number: (last?.number ?? 0) + 1, definition: definition as unknown as Prisma.InputJsonValue, definitionHash: hash, triggerType: definition.trigger.type, note, publishedById: publisherId },
        select: { id: true, number: true },
      });
      await tx.automationWorkflow.update({ where: { id: workflowId }, data: { activeVersionId: created.id, status: "ACTIVE", pausedReason: null, failureStreak: 0 } });
      await tx.automationTrigger.upsert({
        where: { workflowId },
        create: { workflowId, versionId: created.id, type: definition.trigger.type, nextFireAt },
        update: { versionId: created.id, type: definition.trigger.type, nextFireAt },
      });
      return created;
    });
  } catch (err) {
    if (err instanceof WorkflowLimitReached) return { ok: false, error: err.message };
    throw err;
  }
  if (nextFireAt) await requestWakeHere(nextFireAt);
  return { ok: true, data: { versionId: version.id, number: version.number } };
}

/** Pause, resume or archive. Resuming starts its schedule afresh from now and clears its run of failures. */
export async function setWorkflowStatus(workflowId: string, status: Extract<AutomationWorkflowStatus, "ACTIVE" | "PAUSED" | "ARCHIVED">): Promise<StoreResult<null>> {
  const workflow = await db.automationWorkflow.findUnique({ where: { id: workflowId }, select: { status: true, activeVersionId: true } });
  if (!workflow) return { ok: false, error: "That workflow no longer exists." };
  if (workflow.status === "ARCHIVED") return { ok: false, error: "An archived workflow stays archived." };
  if (status === "ACTIVE" && !workflow.activeVersionId) return { ok: false, error: "Publish the workflow before switching it on." };
  if (status === "ACTIVE" && workflow.status !== "ACTIVE") {
    const limits = await limitsHere();
    const version = await db.automationVersion.findUnique({ where: { id: workflow.activeVersionId! }, select: { definition: true } });
    const checked = version ? validateDefinition(version.definition) : null;
    const outside = checked?.ok ? connectorProblems(checked.definition, limits) : [];
    if (outside.length) return { ok: false, error: outside[0]!.message, problems: outside };
    try {
      await db.$transaction(async (tx) => {
        await claimActivePlace(tx, workflowId, limits);
        await tx.automationWorkflow.update({ where: { id: workflowId }, data: { status, pausedReason: null, failureStreak: 0 } });
      });
    } catch (err) {
      if (err instanceof WorkflowLimitReached) return { ok: false, error: err.message };
      throw err;
    }
  } else {
    await db.automationWorkflow.update({ where: { id: workflowId }, data: { status, ...(status === "ACTIVE" ? { pausedReason: null, failureStreak: 0 } : {}) } });
  }
  if (status === "ACTIVE") {
    const trigger = await db.automationTrigger.findUnique({ where: { workflowId }, select: { type: true, versionId: true } });
    if (trigger?.type === "schedule") {
      const version = await db.automationVersion.findUnique({ where: { id: trigger.versionId }, select: { definition: true } });
      const schedule = (version?.definition as unknown as Definition | undefined)?.trigger.schedule;
      if (schedule) {
        const nextFireAt = nextFire(schedule, clockOfTenant(await currentTenant()), new Date());
        await db.automationTrigger.update({ where: { workflowId }, data: { nextFireAt } });
        await requestWakeHere(nextFireAt);
      }
    }
  }
  return { ok: true, data: null };
}

/**
 * Makes `userId` a workflow's owner. Its published version is let go, so it is off and nothing runs as
 * them until they publish it themselves — checked then against their own access, as anyone's first
 * publish is. Its draft and versions stay. Runs already going carry on, as the new owner.
 */
export async function takeOverWorkflow(workflowId: string, userId: string): Promise<StoreResult<{ previousOwnerId: string }>> {
  const workflow = await db.automationWorkflow.findUnique({ where: { id: workflowId }, select: { ownerUserId: true, status: true } });
  if (!workflow) return { ok: false, error: "That workflow no longer exists." };
  if (workflow.status === "ARCHIVED") return { ok: false, error: "An archived workflow stays as it is." };
  if (workflow.ownerUserId === userId) return { ok: false, error: "It's yours already." };
  const taken = await db.automationWorkflow.updateMany({
    where: { id: workflowId, ownerUserId: workflow.ownerUserId },
    data: { ownerUserId: userId, status: "DRAFT", activeVersionId: null, pausedReason: "Taken over: publish it to switch it on as its new owner.", failureStreak: 0 },
  });
  if (!taken.count) return { ok: false, error: "That workflow changed meanwhile; look again." };
  return { ok: true, data: { previousOwnerId: workflow.ownerUserId } };
}

/** Starts a workflow whose trigger is "manual", now, as `byUserId`. */
export async function startManualRun(workflowId: string, byUserId: string, data: Record<string, unknown> = {}): Promise<StoreResult<{ runId: string }>> {
  const workflow = await db.automationWorkflow.findUnique({ where: { id: workflowId }, select: { status: true, activeVersionId: true, triggers: { select: { type: true } } } });
  if (!workflow?.activeVersionId) return { ok: false, error: "Publish the workflow before running it." };
  if (workflow.status !== "ACTIVE") return { ok: false, error: "Switch the workflow on before running it." };
  if (workflow.triggers[0]?.type !== "manual") return { ok: false, error: "Only a workflow started by hand can be run from here." };
  const outOfSteps = await stepsRefusal(clockOfTenant(await currentTenant()));
  if (outOfSteps) return { ok: false, error: outOfSteps };
  const runId = await createRun({
    workflowId,
    versionId: workflow.activeVersionId,
    idempotencyKey: `${workflowId}:manual:${randomUUID()}`,
    trigger: { startedById: byUserId, data },
    startedById: byUserId,
  });
  if (!runId) return { ok: false, error: "The run could not be started." };
  await requestWakeHere();
  return { ok: true, data: { runId } };
}

/** Stops a run: at once when it is waiting, at the next step when a worker holds it. */
export async function cancelRun(runId: string): Promise<StoreResult<null>> {
  const now = new Date();
  const waiting = await db.automationRun.updateMany({
    where: { id: runId, status: { in: ["QUEUED", "WAITING", "NEEDS_ATTENTION"] } },
    data: { status: "CANCELLED", finishedAt: now, error: "Cancelled by a person.", lockedBy: null, lockedUntil: null },
  });
  if (waiting.count) {
    // Its approvals, waits and parallel paths go with it; a path cancelled tells the run it belongs to.
    await settleEndedRun(runId, "CANCELLED");
    return { ok: true, data: null };
  }
  const running = await db.automationRun.updateMany({ where: { id: runId, status: "RUNNING" }, data: { cancelRequested: true } });
  if (running.count) return { ok: true, data: null };
  return { ok: false, error: "That run has already finished." };
}

/**
 * Tries a failed run again from the step that failed, keeping what the steps before it did. One whose
 * outcome was unknown is tried again only because a person has looked and said so.
 */
export async function retryRun(runId: string): Promise<StoreResult<null>> {
  const run = await db.automationRun.findUnique({ where: { id: runId }, select: { status: true, createdAt: true, idempotencyKey: true } });
  if (!run) return { ok: false, error: "That run no longer exists." };
  if (run.status !== "FAILED" && run.status !== "NEEDS_ATTENTION") return { ok: false, error: "Only a failed run, or one waiting for a decision, can be tried again." };
  if (Date.now() - run.createdAt.getTime() > ENGINE_LIMITS.runLifeMs) return { ok: false, error: "The run is past its 120-day limit; start a new one instead." };
  const retried = await db.automationRun.updateMany({
    where: { id: runId, status: { in: ["FAILED", "NEEDS_ATTENTION"] } },
    data: { status: "QUEUED", runAfter: new Date(), attempts: 0, error: null, finishedAt: null, cancelRequested: false, lockedBy: null, lockedUntil: null },
  });
  if (!retried.count) return { ok: false, error: "That run changed meanwhile; look again." };
  // A person has looked and says it didn't happen: the step's "under way" mark goes, so it is done now.
  // Its record outside the database too (sent.ts), or a step done before a restore would wait again.
  if (run.status === "NEEDS_ATTENTION") {
    const marked = await db.automationEffect.findMany({ where: { runId, output: { path: ["$sending"], equals: true } }, select: { key: true } });
    await db.automationEffect.deleteMany({ where: { key: { in: marked.map((m) => m.key) } } });
    await forgetSending(marked.map((m) => sentKey({ key: m.key, runId, runKey: run.idempotencyKey })));
  }
  await requestWakeHere();
  return { ok: true, data: null };
}

/** The most failed runs one "Retry failed runs" takes up — the newest first. */
export const BULK_RETRY_LIMIT = 200;

/**
 * Failed runs tried again in bulk — one workflow's, or all of them — once their cause is fixed (the
 * runbook: a connection mended, a module switched back on). Each goes back to its failed step, as
 * Retry does one. Runs waiting for a decision are left for a person: each needs looking at.
 */
export async function retryFailedRuns(filter: { workflowId?: string | null } = {}): Promise<{ retried: number; left: number }> {
  const where = { status: "FAILED" as const, isTest: false, parentRunId: null, createdAt: { gte: new Date(Date.now() - ENGINE_LIMITS.runLifeMs) }, ...(filter.workflowId ? { workflowId: filter.workflowId } : {}) };
  const [runs, total] = await Promise.all([
    db.automationRun.findMany({ where, orderBy: { createdAt: "desc" }, take: BULK_RETRY_LIMIT, select: { id: true } }),
    db.automationRun.count({ where }),
  ]);
  let retried = 0;
  for (const run of runs) if ((await retryRun(run.id)).ok) retried += 1;
  return { retried, left: total - retried };
}

// ─── The builder (Phase 3) ──────────────────────────────────────────────────────────────────────

/** A template's workflows, as drafts owned by `ownerId` — nothing runs until somebody publishes them. */
export async function createFromTemplate(key: string, values: BlankValues, ownerId: string): Promise<StoreResult<{ ids: string[] }>> {
  const template = templateByKey(key);
  if (!template) return { ok: false, error: "That template isn't one Deskzo has." };
  const problem = blankProblem(template, values);
  if (problem) return { ok: false, error: problem };
  for (const blank of template.blanks) {
    const person = values[blank.key];
    if (blank.kind === "person" && typeof person === "string" && person && person !== "owner") {
      const found = await db.user.findUnique({ where: { id: person }, select: { active: true } });
      if (!found?.active) return { ok: false, error: `The person for "${blank.label}" isn't an active user.` };
    }
  }
  const ids: string[] = [];
  for (const made of template.build(values)) {
    const workflow = await createWorkflow({ name: made.name, description: made.description, ownerUserId: ownerId, createdById: ownerId, draft: made.definition, source: "TEMPLATE", templateKey: key });
    ids.push(workflow.id);
  }
  return { ok: true, data: { ids } };
}

/** A copy of a workflow's draft, as a new draft of `byUserId`'s. */
export async function duplicateWorkflow(workflowId: string, byUserId: string): Promise<StoreResult<{ id: string }>> {
  const workflow = await db.automationWorkflow.findUnique({ where: { id: workflowId }, select: { name: true, description: true, draft: true } });
  if (!workflow) return { ok: false, error: "That workflow no longer exists." };
  const copy = await createWorkflow({ name: `Copy of ${workflow.name}`.slice(0, 120), description: workflow.description, ownerUserId: byUserId, createdById: byUserId, draft: workflow.draft as unknown as Definition });
  return { ok: true, data: copy };
}

/** A published version, back in the draft to work from. What runs doesn't change until it is published again. */
export async function restoreVersion(workflowId: string, versionId: string): Promise<StoreResult<null>> {
  const version = await db.automationVersion.findFirst({ where: { id: versionId, workflowId }, select: { definition: true } });
  if (!version) return { ok: false, error: "That version isn't one of this workflow's." };
  const workflow = await db.automationWorkflow.findUnique({ where: { id: workflowId }, select: { status: true } });
  if (!workflow || workflow.status === "ARCHIVED") return { ok: false, error: "An archived workflow can't be changed." };
  await db.automationWorkflow.update({ where: { id: workflowId }, data: { draft: version.definition as Prisma.InputJsonValue } });
  return { ok: true, data: null };
}

export type TestOutcome = { runId: string; status: string; about: string | null };

/**
 * Tests the draft as it stands, now, on the latest real record of its kind that `testerId` can see
 * (src/lib/automate/samples.ts): conditions and branches for real, delays not waited for, reads done,
 * every other step said and not done — except the safe ones when `live` (engine.ts `LIVE_IN_TEST`).
 * Carried out here rather than by the worker, so the builder shows the result straight away.
 */
export async function testDraft(workflowId: string, testerId: string, live: boolean): Promise<StoreResult<TestOutcome>> {
  const workflow = await db.automationWorkflow.findUnique({ where: { id: workflowId }, select: { draft: true, status: true, ownerUserId: true } });
  if (!workflow) return { ok: false, error: "That workflow no longer exists." };
  // A test reads for real as the owner, and shows what it read: theirs alone.
  if (testerId !== workflow.ownerUserId) return { ok: false, error: NOT_OWNER };
  const checked = validateDefinition(workflow.draft);
  if (!checked.ok) return { ok: false, error: "Fix the problems marked before testing.", problems: checked.problems };
  const sample = await sampleTrigger(testerId, checked.definition.trigger.type, new Date(), workflowId);
  const runId = await createRun({
    workflowId,
    versionId: null,
    idempotencyKey: `${workflowId}:test:${randomUUID()}`,
    trigger: sample?.payload ?? {},
    isTest: true,
    startedById: testerId,
    test: { definition: checked.definition, live },
    claimed: true,
  });
  if (!runId) return { ok: false, error: "The test could not be started." };
  const status = await advanceRun(runId, clockOfTenant(await currentTenant()));
  return { ok: true, data: { runId, status, about: sample?.about ?? null } };
}
