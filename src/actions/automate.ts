"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { AutomationRunStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/authz/resolve";
import { requireModuleUser } from "@/lib/modules-access";
import { refuseWhileViewingAs } from "@/lib/session";
import { summarize } from "@/lib/automate/redact";
import { parseRunRef } from "@/lib/automate/refs";
import { cancelRun, createWorkflow, publishWorkflow, retryRun, saveDraft, setWorkflowStatus, startManualRun } from "@/lib/automate/store";
import { platformPause, setWorkspacePaused, workspacePause } from "@/lib/automate/switches";
import { nudgeAutomate } from "@/lib/automate/worker";
import type { DefinitionProblem } from "@/lib/automate/validate";
import type { ActionResult } from "@/actions/company";

/**
 * Deskzo Automate, Phase 1 (plan approved 17 Oct 2026). Workflows and their runs, for the workspace's
 * admins: every action needs the Automate module in the plan and `settings.manage`, until the
 * Automate permissions are agreed with the permission redesign. Changes are refused while viewing as
 * somebody, as chat and the copilot refuse them.
 *
 * The builder is Phase 3; until then a workflow's definition is JSON, saved and published here.
 */

class NotAllowed extends Error {}

async function admin() {
  const user = await requireModuleUser("automate");
  if (!(await can(user.id, "settings.manage"))) throw new NotAllowed("Only workspace admins can use Automate for now.");
  return user;
}

async function changer() {
  const user = await admin();
  const refusal = await refuseWhileViewingAs();
  if (refusal) throw new NotAllowed(refusal);
  return user;
}

function refused<T>(err: unknown): ActionResult<T> {
  if (err instanceof NotAllowed) return { ok: false, error: err.message };
  throw err;
}

function revalidateAutomate() {
  revalidatePath("/automate/workflows");
  revalidatePath("/automate/runs");
  revalidatePath("/automate/runs/[ref]", "page");
}

// ─── Reading ─────────────────────────────────────────────────────────────────────────────────────

export type WorkflowRow = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  trigger: string | null;
  ownerName: string;
  version: number | null;
  failureStreak: number;
  pausedReason: string | null;
  lastRun: { id: string; seq: number; status: AutomationRunStatus; at: Date } | null;
  updatedAt: Date;
};

export async function listAutomationWorkflows(): Promise<WorkflowRow[]> {
  await admin();
  const workflows = await db.automationWorkflow.findMany({
    where: { status: { not: "ARCHIVED" } },
    orderBy: { updatedAt: "desc" },
    take: 200,
    select: {
      id: true,
      name: true,
      description: true,
      status: true,
      ownerUserId: true,
      activeVersionId: true,
      failureStreak: true,
      pausedReason: true,
      updatedAt: true,
      triggers: { select: { type: true } },
      versions: { orderBy: { number: "desc" }, take: 1, select: { number: true } },
      runs: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, runSeq: true, status: true, createdAt: true } },
    },
  });
  const owners = new Map((await db.user.findMany({ where: { id: { in: workflows.map((w) => w.ownerUserId) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return workflows.map((w) => ({
    id: w.id,
    name: w.name,
    description: w.description,
    status: w.status,
    trigger: w.triggers[0]?.type ?? null,
    ownerName: owners.get(w.ownerUserId) ?? "Someone who has left",
    version: w.versions[0]?.number ?? null,
    failureStreak: w.failureStreak,
    pausedReason: w.pausedReason,
    lastRun: w.runs[0] ? { id: w.runs[0].id, seq: w.runs[0].runSeq, status: w.runs[0].status, at: w.runs[0].createdAt } : null,
    updatedAt: w.updatedAt,
  }));
}

export type RunRow = {
  id: string;
  seq: number;
  workflowId: string;
  workflowName: string;
  status: AutomationRunStatus;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  runAfter: Date;
  stepsUsed: number;
  isTest: boolean;
  error: string | null;
};

const RUN_STATUSES = ["QUEUED", "RUNNING", "WAITING", "SUCCEEDED", "FAILED", "CANCELLED", "NEEDS_ATTENTION"] as const;

export async function listAutomationRuns(filter: { status?: string; workflowId?: string } = {}): Promise<RunRow[]> {
  await admin();
  const status = (RUN_STATUSES as readonly string[]).includes(filter.status ?? "") ? (filter.status as AutomationRunStatus) : undefined;
  const runs = await db.automationRun.findMany({
    where: { ...(status ? { status } : {}), ...(filter.workflowId ? { workflowId: filter.workflowId } : {}) },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true, runSeq: true, workflowId: true, status: true, createdAt: true, startedAt: true, finishedAt: true, runAfter: true, stepsUsed: true, isTest: true, error: true, workflow: { select: { name: true } } },
  });
  return runs.map((r) => ({
    id: r.id,
    seq: r.runSeq,
    workflowId: r.workflowId,
    workflowName: r.workflow.name,
    status: r.status,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    runAfter: r.runAfter,
    stepsUsed: r.stepsUsed,
    isTest: r.isTest,
    error: r.error,
  }));
}

export type RunDetail = RunRow & {
  version: number;
  trigger: string;
  steps: {
    id: string;
    stepId: string;
    type: string;
    attempt: number;
    status: string;
    startedAt: Date;
    finishedAt: Date | null;
    durationMs: number | null;
    input: unknown;
    output: unknown;
    error: string | null;
    errorKind: string | null;
    retryAt: Date | null;
  }[];
};

/** One run by its number (RUN-000123, or 123), and every try of every step — inputs and outputs as their redacted summaries, never the full values. */
export async function getAutomationRun(ref: string): Promise<RunDetail | null> {
  await admin();
  const seq = parseRunRef(ref);
  if (seq === null) return null;
  const run = await db.automationRun.findUnique({
    where: { runSeq: seq },
    select: {
      id: true,
      runSeq: true,
      workflowId: true,
      status: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      runAfter: true,
      stepsUsed: true,
      isTest: true,
      error: true,
      workflow: { select: { name: true } },
      version: { select: { number: true, triggerType: true } },
      steps: { orderBy: { startedAt: "asc" } },
    },
  });
  if (!run) return null;
  return {
    id: run.id,
    seq: run.runSeq,
    workflowId: run.workflowId,
    workflowName: run.workflow.name,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    runAfter: run.runAfter,
    stepsUsed: run.stepsUsed,
    isTest: run.isTest,
    error: run.error,
    version: run.version.number,
    trigger: run.version.triggerType,
    steps: run.steps.map((s) => ({
      id: s.id,
      stepId: s.stepId,
      type: s.type,
      attempt: s.attempt,
      status: s.status,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      durationMs: s.durationMs,
      // Summarised again on the way out: a summary stored before a rule changed still shows safely.
      input: summarize(s.inputSummary),
      output: summarize(s.outputSummary),
      error: s.error,
      errorKind: s.errorKind,
      retryAt: s.retryAt,
    })),
  };
}

export async function automateSwitches(): Promise<{ workspacePaused: boolean; pausedAt: Date | null; platformPaused: boolean }> {
  await admin();
  const [workspace, platform] = await Promise.all([workspacePause(), platformPause().catch(() => ({ paused: false }))]);
  return { workspacePaused: workspace.paused, pausedAt: workspace.pausedAt, platformPaused: platform.paused };
}

// ─── Changing ────────────────────────────────────────────────────────────────────────────────────

const nameSchema = z.object({ name: z.string().trim().min(1, "Give the workflow a name.").max(120), description: z.string().max(500).optional() });

export async function createAutomationWorkflow(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const user = await changer();
    const parsed = nameSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the name." };
    const workflow = await createWorkflow({ name: parsed.data.name, description: parsed.data.description, ownerUserId: user.id, createdById: user.id });
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "Workflow", entityId: workflow.id, entityLabel: parsed.data.name });
    revalidateAutomate();
    return { ok: true, data: workflow };
  } catch (err) {
    return refused(err);
  }
}

/** Saves the draft — a definition as JSON, until the builder (Phase 3) — and says what publishing would refuse. */
export async function saveAutomationDraft(id: string, draftJson: string): Promise<ActionResult<{ problems: DefinitionProblem[] }>> {
  try {
    await changer();
    let draft: unknown;
    try {
      draft = JSON.parse(draftJson);
    } catch {
      return { ok: false, error: "That isn't valid JSON." };
    }
    const saved = await saveDraft(id, draft);
    if (!saved.ok) return { ok: false, error: saved.error };
    revalidateAutomate();
    return { ok: true, data: saved.data };
  } catch (err) {
    return refused(err);
  }
}

export async function publishAutomationWorkflow(id: string, note?: string): Promise<ActionResult<{ number: number }> & { problems?: DefinitionProblem[] }> {
  try {
    const user = await changer();
    const published = await publishWorkflow(id, user.id, note?.trim().slice(0, 300) || null);
    if (!published.ok) return { ok: false, error: published.error, problems: published.problems };
    const workflow = await db.automationWorkflow.findUnique({ where: { id }, select: { name: true } });
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Workflow", entityId: id, entityLabel: `${workflow?.name ?? "Workflow"} — published version ${published.data.number}` });
    revalidateAutomate();
    return { ok: true, data: { number: published.data.number } };
  } catch (err) {
    return refused(err);
  }
}

export async function setAutomationWorkflowStatus(id: string, status: "ACTIVE" | "PAUSED" | "ARCHIVED"): Promise<ActionResult<null>> {
  try {
    const user = await changer();
    if (!["ACTIVE", "PAUSED", "ARCHIVED"].includes(status)) return { ok: false, error: "Choose on, paused or archived." };
    const changed = await setWorkflowStatus(id, status);
    if (!changed.ok) return { ok: false, error: changed.error };
    const workflow = await db.automationWorkflow.findUnique({ where: { id }, select: { name: true } });
    const word = status === "ACTIVE" ? "switched on" : status === "PAUSED" ? "paused" : "archived";
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Workflow", entityId: id, entityLabel: `${workflow?.name ?? "Workflow"} — ${word}` });
    revalidateAutomate();
    return { ok: true, data: null };
  } catch (err) {
    return refused(err);
  }
}

export async function runAutomationWorkflowNow(id: string): Promise<ActionResult<{ runId: string }>> {
  try {
    const user = await changer();
    const started = await startManualRun(id, user.id);
    if (!started.ok) return { ok: false, error: started.error };
    await nudgeAutomate();
    revalidateAutomate();
    return { ok: true, data: started.data };
  } catch (err) {
    return refused(err);
  }
}

export async function cancelAutomationRun(id: string): Promise<ActionResult<null>> {
  try {
    await changer();
    const done = await cancelRun(id);
    if (!done.ok) return { ok: false, error: done.error };
    revalidateAutomate();
    return { ok: true, data: null };
  } catch (err) {
    return refused(err);
  }
}

export async function retryAutomationRun(id: string): Promise<ActionResult<null>> {
  try {
    await changer();
    const done = await retryRun(id);
    if (!done.ok) return { ok: false, error: done.error };
    await nudgeAutomate();
    revalidateAutomate();
    return { ok: true, data: null };
  } catch (err) {
    return refused(err);
  }
}

/** The workspace's kill switch: nothing starts or moves on while it is on. */
export async function setAutomationPaused(paused: boolean): Promise<ActionResult<null>> {
  try {
    const user = await changer();
    if (paused !== true && paused !== false) return { ok: false, error: "Choose paused or running." };
    await setWorkspacePaused(paused, user.id);
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Automate", entityId: "global", entityLabel: paused ? "Every workflow paused" : "Workflows running again" });
    if (!paused) await nudgeAutomate();
    revalidateAutomate();
    return { ok: true, data: null };
  } catch (err) {
    return refused(err);
  }
}
