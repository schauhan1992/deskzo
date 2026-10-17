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
import { parseRunRef, parseWorkflowRef, workflowPath } from "@/lib/automate/refs";
import { cancelRun, createFromTemplate, createWorkflow, duplicateWorkflow, publishWorkflow, restoreVersion, retryRun, saveDraft, setWorkflowStatus, startManualRun, testDraft } from "@/lib/automate/store";
import { platformPause, setWorkspacePaused, workspacePause } from "@/lib/automate/switches";
import { nudgeAutomate } from "@/lib/automate/worker";
import { validateDefinition, type DefinitionProblem } from "@/lib/automate/validate";
import { builderCatalog, type Catalog } from "@/lib/automate/catalog";
import type { Definition } from "@/lib/automate/definition";
import { ensureWebhook, setRequireSignature, webhookOf, type WebhookView } from "@/lib/automate/webhooks";
import { PROVIDER_LABELS, deleteConnection, listConnections, saveConnection, connectionFor, noteConnectionUse, type ConnectionRow } from "@/lib/automate/connections";
import { automateSigningSecret, outboundFetch, statusKind } from "@/lib/automate/outbound";
import { grantsGoogleSheets } from "@/lib/mail/google";
import { mailProviders } from "@/lib/workplace/settings";
import { createFromCompanyTemplate, deleteCompanyTemplate, exportWorkflow, importWorkflow, listCompanyTemplates, readWorkflowFile, saveCompanyTemplate, type ImportPreview } from "@/lib/automate/transfer";
import { draftWithAI, stepCount } from "@/lib/automate/ai/draft";
import { DraftingRefusal, draftingProvider, draftingUnavailable } from "@/lib/automate/ai/model";
import { copilotConfig } from "@/lib/copilot/settings";
import { notMigratedYet } from "@/lib/not-migrated";
import { decide, inboxFor } from "@/lib/automate/approvals";
import { randomUUID } from "node:crypto";
import type { ActionResult } from "@/actions/company";

/**
 * Deskzo Automate, Phase 1 (plan approved 17 Oct 2026). Workflows and their runs, for the workspace's
 * admins: every action needs the Automate module in the plan and `settings.manage`, until the
 * Automate permissions are agreed with the permission redesign. Changes are refused while viewing as
 * somebody, as chat and the copilot refuse them.
 *
 * Phase 3 adds the builder's: a workflow by its number, its draft saved as it is edited, tested on a
 * real record, made from a template, copied, and an earlier version brought back.
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
  revalidatePath("/automate/workflows/[ref]", "page");
  revalidatePath("/automate/runs");
  revalidatePath("/automate/runs/[ref]", "page");
}

// ─── Reading ─────────────────────────────────────────────────────────────────────────────────────

export type WorkflowRow = {
  id: string;
  /** WF-0042 — the builder's address. */
  seq: number;
  source: string;
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
      workflowSeq: true,
      source: true,
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
    seq: w.workflowSeq,
    source: w.source,
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
  /** Null for a test of a draft, which has no version. */
  version: number | null;
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
      workflow: { select: { name: true, draft: true } },
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
    version: run.version?.number ?? null,
    // A test of a draft: the draft's trigger, as it stood.
    trigger: run.version?.triggerType ?? String((run.workflow.draft as { trigger?: { type?: unknown } } | null)?.trigger?.type ?? "manual"),
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

// ─── The builder (Phase 3) ──────────────────────────────────────────────────────────────────────

export type BuilderWorkflow = {
  id: string;
  seq: number;
  name: string;
  description: string | null;
  status: string;
  source: string;
  draft: unknown;
  ownerUserId: string;
  ownerName: string;
  activeVersion: number | null;
  pausedReason: string | null;
  versions: { id: string; number: number; note: string | null; publishedAt: Date; publishedBy: string }[];
  problems: DefinitionProblem[];
  catalog: Catalog;
  /** Its webhook address, once it has one (an outside app calls it). */
  webhook: WebhookView | null;
};

/** Everything the builder shows for one workflow, by its number (WF-0042, or 42). */
export async function getWorkflowForBuilder(ref: string): Promise<BuilderWorkflow | null> {
  await admin();
  const seq = parseWorkflowRef(ref);
  if (seq === null) return null;
  const w = await db.automationWorkflow.findUnique({
    where: { workflowSeq: seq },
    select: {
      id: true,
      workflowSeq: true,
      name: true,
      description: true,
      status: true,
      source: true,
      draft: true,
      ownerUserId: true,
      activeVersionId: true,
      pausedReason: true,
      versions: { orderBy: { number: "desc" }, take: 30, select: { id: true, number: true, note: true, publishedAt: true, publishedById: true } },
    },
  });
  if (!w || w.status === "ARCHIVED") return null;
  const names = new Map((await db.user.findMany({ where: { id: { in: [w.ownerUserId, ...w.versions.map((v) => v.publishedById)] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const checked = validateDefinition(w.draft);
  const [catalog, webhook] = await Promise.all([builderCatalog(w.ownerUserId), webhookOf(w.id).catch(() => null)]);
  // What the last call to its address carried, offered field by field in the data picker.
  if (webhook?.sampleKeys.length) {
    const spec = catalog.triggers.find((t) => t.type === "webhook");
    if (spec) spec.paths = [...spec.paths, ...webhook.sampleKeys.map((k) => ({ ref: `trigger.body.${k}`, label: `Body › ${k}` }))];
  }
  return {
    id: w.id,
    seq: w.workflowSeq,
    name: w.name,
    description: w.description,
    status: w.status,
    source: w.source,
    draft: w.draft,
    ownerUserId: w.ownerUserId,
    ownerName: names.get(w.ownerUserId) ?? "Someone who has left",
    activeVersion: w.versions.find((v) => v.id === w.activeVersionId)?.number ?? null,
    pausedReason: w.pausedReason,
    versions: w.versions.map((v) => ({ id: v.id, number: v.number, note: v.note, publishedAt: v.publishedAt, publishedBy: names.get(v.publishedById) ?? "Someone who has left" })),
    problems: checked.ok ? [] : checked.problems,
    catalog,
    webhook,
  };
}

const draftMeta = z.object({ name: z.string().trim().min(1, "Give the workflow a name.").max(120).optional(), description: z.string().max(500).nullable().optional() });

/** Saves the builder's draft as it stands, unfinished or not, and says what publishing would refuse. */
export async function saveWorkflowDraft(id: string, draft: unknown, meta: unknown = {}): Promise<ActionResult<{ problems: DefinitionProblem[] }>> {
  try {
    await changer();
    const parsedMeta = draftMeta.safeParse(meta);
    if (!parsedMeta.success) return { ok: false, error: parsedMeta.error.issues[0]?.message ?? "Check the name." };
    // A draft is the builder's own JSON — kept to a sane size, and never anything but plain data.
    const json = JSON.stringify(draft ?? null);
    if (json.length > 200_000) return { ok: false, error: "The workflow is too large to save." };
    const saved = await saveDraft(id, JSON.parse(json), parsedMeta.data);
    if (!saved.ok) return { ok: false, error: saved.error };
    revalidateAutomate();
    return { ok: true, data: saved.data };
  } catch (err) {
    return refused(err);
  }
}

/** Tests the saved draft on the latest real record of its kind; the run's steps come back with it. */
export async function testWorkflowDraft(id: string, live: boolean): Promise<ActionResult<{ run: RunDetail | null; about: string | null }> & { problems?: DefinitionProblem[] }> {
  try {
    const user = await changer();
    const tested = await testDraft(id, user.id, live === true);
    if (!tested.ok) return { ok: false, error: tested.error, problems: tested.problems };
    const row = await db.automationRun.findUnique({ where: { id: tested.data.runId }, select: { runSeq: true } });
    revalidateAutomate();
    return { ok: true, data: { run: row ? await getAutomationRun(String(row.runSeq)) : null, about: tested.data.about } };
  } catch (err) {
    return refused(err);
  }
}

async function pathOf(id: string): Promise<string> {
  const row = await db.automationWorkflow.findUnique({ where: { id }, select: { workflowSeq: true } });
  return row ? workflowPath(row.workflowSeq) : "/automate/workflows";
}

/** A new, empty workflow of the person's, opened in the builder. */
export async function createBlankWorkflow(): Promise<ActionResult<{ path: string }>> {
  try {
    const user = await changer();
    const workflow = await createWorkflow({ name: "New workflow", ownerUserId: user.id, createdById: user.id });
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "Workflow", entityId: workflow.id, entityLabel: "New workflow" });
    revalidateAutomate();
    return { ok: true, data: { path: await pathOf(workflow.id) } };
  } catch (err) {
    return refused(err);
  }
}

/** A template's workflow(s), filled in, as drafts; the first opens in the builder. */
export async function createWorkflowFromTemplate(key: string, values: unknown): Promise<ActionResult<{ path: string; made: number }>> {
  try {
    const user = await changer();
    const plain = values && typeof values === "object" && !Array.isArray(values) ? (values as Record<string, unknown>) : {};
    const made = await createFromTemplate(String(key), plain, user.id);
    if (!made.ok) return { ok: false, error: made.error };
    for (const id of made.data.ids) {
      const w = await db.automationWorkflow.findUnique({ where: { id }, select: { name: true } });
      await recordAudit({ userId: user.id, action: "CREATE", entityType: "Workflow", entityId: id, entityLabel: `${w?.name ?? "Workflow"} — from a template` });
    }
    revalidateAutomate();
    return { ok: true, data: { path: await pathOf(made.data.ids[0]!), made: made.data.ids.length } };
  } catch (err) {
    return refused(err);
  }
}

export async function duplicateAutomationWorkflow(id: string): Promise<ActionResult<{ path: string }>> {
  try {
    const user = await changer();
    const copy = await duplicateWorkflow(id, user.id);
    if (!copy.ok) return { ok: false, error: copy.error };
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "Workflow", entityId: copy.data.id, entityLabel: "A copy of a workflow" });
    revalidateAutomate();
    return { ok: true, data: { path: await pathOf(copy.data.id) } };
  } catch (err) {
    return refused(err);
  }
}

/** Puts a published version back in the draft; what runs is unchanged until it is published again. */
export async function restoreAutomationVersion(id: string, versionId: string): Promise<ActionResult<null>> {
  try {
    await changer();
    const done = await restoreVersion(id, versionId);
    if (!done.ok) return { ok: false, error: done.error };
    revalidateAutomate();
    return { ok: true, data: null };
  } catch (err) {
    return refused(err);
  }
}

/**
 * A new workflow for one pipeline — "when a lead arrives in it", or "when a lead enters this stage" —
 * as a draft, from the pipeline's settings, where its automations used to be made.
 */
export async function createPipelineWorkflow(pipelineId: string, stageId: string | null = null): Promise<ActionResult<{ path: string }>> {
  try {
    const user = await changer();
    const draft: Definition = stageId
      ? {
          schema: 1,
          trigger: {
            type: "lead.stage_changed",
            filter: { all: [{ ref: "trigger.to.stageId", op: "eq", value: String(stageId) }, { ref: "trigger.from.stageId", op: "ne", value: String(stageId) }] },
          },
          steps: [{ id: "lead", name: "Read the lead", type: "action", action: "lead.get", input: { leadId: "{{trigger.lead.id}}" } }],
        }
      : {
          schema: 1,
          trigger: { type: "lead.arrived", filter: { all: [{ ref: "trigger.lead.pipelineId", op: "eq", value: String(pipelineId) }] } },
          steps: [{ id: "lead", name: "Read the lead", type: "action", action: "lead.get", input: { leadId: "{{trigger.lead.id}}" } }],
        };
    const workflow = await createWorkflow({ name: stageId ? "When a lead enters a stage" : "When a lead arrives", ownerUserId: user.id, createdById: user.id, draft });
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "Workflow", entityId: workflow.id, entityLabel: "A workflow for a pipeline" });
    revalidateAutomate();
    return { ok: true, data: { path: await pathOf(workflow.id) } };
  } catch (err) {
    return refused(err);
  }
}

// ─── Outside apps (Phase 4) ─────────────────────────────────────────────────────────────────────

/** A workflow's webhook address and secret — made the first time; `fresh` replaces the old one. */
export async function workflowWebhook(id: string, fresh = false): Promise<ActionResult<WebhookView>> {
  try {
    const user = await changer();
    const workflow = await db.automationWorkflow.findUnique({ where: { id }, select: { name: true } });
    if (!workflow) return { ok: false, error: "That workflow no longer exists." };
    const hook = await ensureWebhook(id, fresh);
    if (fresh) await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Workflow", entityId: id, entityLabel: `${workflow.name} — a new webhook address; the old one stops` });
    return { ok: true, data: hook };
  } catch (err) {
    return refused(err);
  }
}

export async function setWorkflowWebhookSigned(id: string, required: boolean): Promise<ActionResult<WebhookView | null>> {
  try {
    await changer();
    await setRequireSignature(id, required === true);
    return { ok: true, data: await webhookOf(id) };
  } catch (err) {
    return refused(err);
  }
}

export type ConnectionsPage = {
  connections: (ConnectionRow & { ownerName: string; mine: boolean })[];
  /** This person's mailbox: Sheets rides on a Google one. `available`: Google is set up for mailboxes here. */
  sheets: { provider: string | null; connected: boolean; available: boolean };
  /** A WhatsApp provider is on and carries transactional messages (Settings › Messaging). */
  whatsappReady: boolean;
};

/** Automate › Connections: the outside apps, and whether this person has Google Sheets and the workspace WhatsApp. */
export async function getAutomationConnections(): Promise<ConnectionsPage> {
  const user = await admin();
  const [rows, mailbox, providers, whatsapp] = await Promise.all([
    listConnections(),
    db.mailConnection.findUnique({ where: { userId: user.id }, select: { provider: true, scopes: true } }),
    mailProviders(),
    db.messagingProvider.count({ where: { kind: "WHATSAPP", enabled: true, classes: { has: "TRANSACTIONAL" } } }),
  ]);
  const names = new Map((await db.user.findMany({ where: { id: { in: rows.map((r) => r.ownerUserId) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return {
    connections: rows.map((r) => ({ ...r, ownerName: names.get(r.ownerUserId) ?? "Someone who has left", mine: r.ownerUserId === user.id })),
    sheets: { provider: mailbox?.provider ?? null, connected: mailbox?.provider === "GOOGLE" && grantsGoogleSheets(mailbox.scopes), available: providers.includes("GOOGLE") },
    whatsappReady: whatsapp > 0,
  };
}

/** The workspace's signing secret, asked for on purpose — it signs every outside call a workflow makes. */
export async function revealAutomationSigningSecret(): Promise<ActionResult<{ secret: string }>> {
  try {
    await changer();
    return { ok: true, data: { secret: await automateSigningSecret() } };
  } catch (err) {
    return refused(err);
  }
}

export async function saveAutomationConnection(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const user = await changer();
    const i = (input ?? {}) as { id?: unknown; provider?: unknown; name?: unknown; shared?: unknown; secret?: unknown };
    if (i.id) {
      const row = await db.automationConnection.findUnique({ where: { id: String(i.id) }, select: { ownerUserId: true } });
      if (row && row.ownerUserId !== user.id) return { ok: false, error: "Only the person who added a connection changes it." };
    }
    const saved = await saveConnection({ id: i.id ? String(i.id) : undefined, provider: String(i.provider ?? ""), name: String(i.name ?? ""), shared: i.shared === true, secret: i.secret }, user.id);
    if (!saved.ok) return saved;
    await recordAudit({ userId: user.id, action: i.id ? "UPDATE" : "CREATE", entityType: "AutomationConnection", entityId: saved.id, entityLabel: `${PROVIDER_LABELS[String(i.provider) as keyof typeof PROVIDER_LABELS] ?? "Connection"}: ${String(i.name ?? "")}` });
    revalidatePath("/automate/connections");
    return { ok: true, data: { id: saved.id } };
  } catch (err) {
    return refused(err);
  }
}

export async function deleteAutomationConnection(id: string): Promise<ActionResult<null>> {
  try {
    const user = await changer();
    const row = await db.automationConnection.findUnique({ where: { id }, select: { ownerUserId: true, name: true } });
    if (!row) return { ok: false, error: "That connection no longer exists." };
    if (row.ownerUserId !== user.id) return { ok: false, error: "Only the person who added a connection removes it." };
    await deleteConnection(id);
    await recordAudit({ userId: user.id, action: "DELETE", entityType: "AutomationConnection", entityId: id, entityLabel: row.name });
    revalidatePath("/automate/connections");
    return { ok: true, data: null };
  } catch (err) {
    return refused(err);
  }
}

/** Sends a test message to a Slack or Teams connection, as its owner would — to see it arrive. */
export async function testAutomationConnection(id: string): Promise<ActionResult<{ status: number }>> {
  try {
    const user = await changer();
    const row = await db.automationConnection.findUnique({ where: { id }, select: { provider: true } });
    if (!row || (row.provider !== "slack" && row.provider !== "teams")) return { ok: false, error: "Only Slack and Teams connections send a test message." };
    const connection = await connectionFor(user.id, id, row.provider);
    const text = "A test from Deskzo Automate — this connection works.";
    const body = row.provider === "slack" ? { text } : { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: { type: "AdaptiveCard", version: "1.4", body: [{ type: "TextBlock", text, wrap: true }] } }] };
    try {
      const response = await outboundFetch({ key: `test:${randomUUID()}` }, { method: "POST", url: connection.secret.url, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const ok = statusKind(response.status) === "ok";
      await noteConnectionUse(id, ok ? null : `It answered ${response.status}: ${response.body.slice(0, 200)}`);
      revalidatePath("/automate/connections");
      return ok ? { ok: true, data: { status: response.status } } : { ok: false, error: `It answered ${response.status}: ${response.body.slice(0, 200) || "no reason given"}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await noteConnectionUse(id, message);
      return { ok: false, error: message };
    }
  } catch (err) {
    return refused(err);
  }
}

// ─── AI drafting, workflow files and company templates (Phase 5) ────────────────────────────────

export type DraftingAvailability = { available: boolean; reason: string | null; provider: string | null };

/** Whether "Describe it" works for this person, why not, and which AI service the words go to. */
export async function getDraftingAvailability(): Promise<DraftingAvailability> {
  const user = await admin();
  const reason = await draftingUnavailable(user.id);
  return { available: !reason, reason, provider: (await copilotConfig()).enabled ? await draftingProvider() : null };
}

export type DraftResult = { path: string; name: string; steps: number; questions: string[]; blanks: string[]; others: number };

/**
 * A workflow drafted from a description, saved as a draft of this person's to finish and publish.
 * The AI never publishes: what it made waits in the builder with its blanks and any mistakes marked.
 */
export async function draftWorkflowWithAI(description: string): Promise<ActionResult<DraftResult>> {
  try {
    const user = await changer();
    let drafted;
    try {
      drafted = await draftWithAI({ userId: user.id, description: String(description ?? "") });
    } catch (err) {
      if (err instanceof DraftingRefusal) return { ok: false, error: err.message };
      throw err;
    }
    const made = await createWorkflow({ name: drafted.name, description: drafted.description, ownerUserId: user.id, createdById: user.id, draft: drafted.definition, source: "AI" });
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "Workflow", entityId: made.id, entityLabel: `${drafted.name} — drafted by AI from a description` });
    revalidateAutomate();
    return {
      ok: true,
      data: { path: await pathOf(made.id), name: drafted.name, steps: stepCount(drafted.definition), questions: drafted.questions, blanks: drafted.blanks.map((b) => b.message), others: drafted.others.length },
    };
  } catch (err) {
    return refused(err);
  }
}

/** A workflow's draft as a file to download — people, connections and records cleared. */
export async function exportAutomationWorkflow(id: string): Promise<ActionResult<{ fileName: string; text: string; cleared: string[] }>> {
  try {
    const user = await admin();
    const exported = await exportWorkflow(id);
    if (!exported.ok) return exported;
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Workflow", entityId: id, entityLabel: `Exported as a file, ${exported.data.fileName} — nothing changed` });
    return { ok: true, data: { fileName: exported.data.fileName, text: exported.data.text, cleared: exported.data.cleared.map((c) => c.label) } };
  } catch (err) {
    return refused(err);
  }
}

/** What importing a file would make, before anything is made. */
export async function previewWorkflowImport(text: string): Promise<ActionResult<ImportPreview>> {
  try {
    await changer();
    const read = readWorkflowFile(String(text ?? ""));
    return read.ok ? { ok: true, data: read.preview } : read;
  } catch (err) {
    return refused(err);
  }
}

/** A file's workflow as a new draft of this person's. */
export async function importAutomationWorkflow(text: string): Promise<ActionResult<{ path: string }>> {
  try {
    const user = await changer();
    const imported = await importWorkflow(String(text ?? ""), user.id);
    if (!imported.ok) return imported;
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "Workflow", entityId: imported.data.id, entityLabel: `${imported.data.preview.name} — imported from a file` });
    revalidateAutomate();
    return { ok: true, data: { path: await pathOf(imported.data.id) } };
  } catch (err) {
    return refused(err);
  }
}

/** Saves a workflow's draft as one of the company's own templates. */
export async function saveAsCompanyTemplate(workflowId: string): Promise<ActionResult<{ cleared: string[] }>> {
  try {
    const user = await changer();
    const saved = await saveCompanyTemplate(workflowId, user.id);
    if (!saved.ok) return saved;
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "AutomationTemplate", entityId: saved.data.id, entityLabel: "A company workflow template, saved from a workflow" });
    revalidatePath("/automate/templates");
    return { ok: true, data: { cleared: saved.data.cleared.map((c) => c.label) } };
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: "Company templates are being set up for this workspace. Try again in a few minutes." };
    return refused(err);
  }
}

export type CompanyTemplateCard = { id: string; name: string; description: string | null; trigger: string; steps: string[]; by: string; createdAt: string };

/** The company's own templates, newest first — or null while the workspace isn't ready for them. */
export async function listAutomationCompanyTemplates(): Promise<CompanyTemplateCard[] | null> {
  await admin();
  let rows;
  try {
    rows = await listCompanyTemplates();
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
  const names = new Map((await db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.createdById))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, trigger: r.trigger, steps: r.steps, by: names.get(r.createdById) ?? "Someone who has left", createdAt: r.createdAt.toISOString() }));
}

export async function startFromCompanyTemplate(id: string): Promise<ActionResult<{ path: string }>> {
  try {
    const user = await changer();
    const made = await createFromCompanyTemplate(id, user.id);
    if (!made.ok) return made;
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "Workflow", entityId: made.data.id, entityLabel: "From a company template" });
    revalidateAutomate();
    return { ok: true, data: { path: await pathOf(made.data.id) } };
  } catch (err) {
    return refused(err);
  }
}

export async function deleteAutomationCompanyTemplate(id: string): Promise<ActionResult<null>> {
  try {
    const user = await changer();
    if (!(await deleteCompanyTemplate(id))) return { ok: false, error: "That template no longer exists." };
    await recordAudit({ userId: user.id, action: "DELETE", entityType: "AutomationTemplate", entityId: id, entityLabel: "A company workflow template" });
    revalidatePath("/automate/templates");
    return { ok: true, data: null };
  } catch (err) {
    return refused(err);
  }
}

// ─── The approvals inbox (Phase 6) ─────────────────────────────────────────────────────────────────

export type InboxItem = {
  id: string;
  /** A workflow's approval step, or something the AI copilot drafted for this person to confirm. */
  source: "workflow" | "copilot";
  title: string;
  summary: string | null;
  from: string;
  askedAt: Date;
  expiresAt: Date | null;
  status: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  comment: string | null;
};

/**
 * What waits on this person to approve or reject — named on a workflow's approval step, or holding
 * its role — with the copilot's drafts waiting on them, and what they decided lately. For anybody
 * signed in: approvers needn't be admins.
 */
export async function getApprovalsInbox(): Promise<{ waiting: InboxItem[]; decided: InboxItem[] }> {
  const user = await requireModuleUser("automate");
  let requests: Awaited<ReturnType<typeof inboxFor>>;
  try {
    requests = await inboxFor(user.id);
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    requests = { waiting: [], decided: [] };
  }
  const all = [...requests.waiting, ...requests.decided];
  const [workflows, people, proposals] = await Promise.all([
    db.automationWorkflow.findMany({ where: { id: { in: [...new Set(all.map((r) => r.workflowId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }),
    db.user.findMany({ where: { id: { in: [...new Set(all.map((r) => r.decidedById).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }),
    db.copilotProposal.findMany({ where: { userId: user.id, status: "PENDING" }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, kind: true, summary: true, createdAt: true } }),
  ]);
  const workflowName = new Map(workflows.map((w) => [w.id, w.name]));
  const personName = new Map(people.map((p) => [p.id, p.name]));
  const item = (r: (typeof all)[number]): InboxItem => ({
    id: r.id,
    source: "workflow",
    title: r.title,
    summary: r.summary,
    from: r.workflowId ? `The workflow "${workflowName.get(r.workflowId) ?? "that has since gone"}"` : "Deskzo",
    askedAt: r.createdAt,
    expiresAt: r.expiresAt,
    status: r.status,
    decidedBy: r.decidedById ? (personName.get(r.decidedById) ?? "Someone who has left") : null,
    decidedAt: r.decidedAt,
    comment: r.comment,
  });
  const drafts: InboxItem[] = proposals.map((p) => ({
    id: p.id,
    source: "copilot",
    title: `${p.kind === "TASK" ? "A task" : "A note"}: ${p.summary}`,
    summary: null,
    from: "The AI copilot, in your chat",
    askedAt: p.createdAt,
    expiresAt: null,
    status: "PENDING",
    decidedBy: null,
    decidedAt: null,
    comment: null,
  }));
  return { waiting: [...requests.waiting.map(item), ...drafts], decided: requests.decided.map(item) };
}

/** Approves or rejects a workflow's request — only somebody it names, or who holds its role. */
export async function decideApproval(id: string, decision: "approved" | "rejected", comment: string | null): Promise<ActionResult<null>> {
  try {
    const user = await requireModuleUser("automate");
    const viewing = await refuseWhileViewingAs();
    if (viewing) return { ok: false, error: viewing };
    if (decision !== "approved" && decision !== "rejected") return { ok: false, error: "Approve it or reject it." };
    const done = await decide(String(id), user.id, decision, typeof comment === "string" ? comment : null);
    if (!done.ok) return done;
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ApprovalRequest", entityId: String(id), entityLabel: `${decision === "approved" ? "Approved" : "Rejected"} in the approvals inbox` });
    revalidatePath("/approvals");
    return { ok: true, data: null };
  } catch (err) {
    return refused(err);
  }
}
