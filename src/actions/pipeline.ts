"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { inStageWhere, leadStages, type Pipeline } from "@/lib/pipeline/server";
import {
  MEANINGS,
  PIPELINE_LIMITS,
  STAGE_COLORS,
  checkStage,
  kindOf,
  meaningOf,
  mustKeep,
  rehomeTargets,
  stageChangeNote,
  stageKeyFromLabel,
  type LeadStageDef,
} from "@/lib/pipeline/rules";
import { inStepWhere, orderSteps } from "@/lib/pipeline/order-steps-server";
import { STEP_LIMITS, checkStep, stepKeyFromLabel, stepRehomeTargets, stepStatusLabel, stepsOf, type OrderStepDef } from "@/lib/pipeline/order-steps";
import type { ActionResult } from "@/actions/company";

/**
 * Settings → Pipeline (owner, 2 Oct 2026): the stages a workspace's leads move through — its own names,
 * order and colours, and what each counts as (src/lib/pipeline/rules.ts). Moving a lead between stages
 * is the lead's own action (`updateLeadStatus` in src/actions/lead.ts); this is shaping the stages.
 *
 * Shaping them is `pipeline.manage`. What a stage counts as decides what reaching it does, so it changes
 * only where that can't quietly rewrite history: a stage with leads in it may change between open
 * meanings (its leads follow, with a note on each), never between open, won and lost. Every pipeline
 * keeps a stage for new leads, one for won and one for lost. A stage is retired rather than deleted once
 * leads have been in it, and its leads are moved on to a stage of the same kind first.
 */

async function manager() {
  const user = await requireUser();
  return (await can(user.id, "pipeline.manage")) ? user : null;
}

const NOT_ALLOWED = "You can't change the pipeline.";
const NOT_READY = "This workspace is still being updated. Try again in a minute.";

function refresh() {
  revalidatePath("/settings/pipeline");
  revalidatePath("/leads");
}

/** How many leads each stage shows — what retiring or deleting it affects. */
async function leadCounts(pipeline: Pipeline): Promise<Map<string, number>> {
  const counts = await Promise.all(pipeline.stages.map((s) => db.lead.count({ where: inStageWhere(pipeline, s) })));
  return new Map(pipeline.stages.map((s, i) => [s.id, counts[i]!]));
}

export type ManagedStage = LeadStageDef & { leads: number };

/** Everything the settings screen shows: the stages in order, retired ones too, with how many leads each holds. */
export async function listPipelineForManage(): Promise<{ stages: ManagedStage[]; stored: boolean } | null> {
  if (!(await manager())) return null;
  const pipeline = await leadStages();
  const counts = await leadCounts(pipeline);
  return { stored: pipeline.stored, stages: pipeline.stages.map((s) => ({ ...s, leads: counts.get(s.id) ?? 0 })) };
}

const stageSchema = z.object({
  id: z.string().min(1).optional(),
  label: z.string().trim().min(1, "Give the stage a name.").max(PIPELINE_LIMITS.label, `Keep the name to ${PIPELINE_LIMITS.label} characters.`),
  status: z.enum(MEANINGS.map((m) => m.status) as [LeadStageDef["status"], ...LeadStageDef["status"][]]),
  color: z.enum(STAGE_COLORS),
});

/** Renumbers the stages in the order given — one transaction, so a board never sees two stages in one place. */
async function renumber(ids: string[]) {
  await db.$transaction(async (tx) => {
    for (const [i, id] of ids.entries()) await tx.leadStage.update({ where: { id }, data: { sortOrder: i + 1 } });
  });
}

/**
 * Adds a stage or changes one: its name, colour, and what it counts as. A new open stage goes in before
 * the first closed one, so a board's won and lost columns stay at the end; a new closed one goes last.
 */
export async function saveLeadStage(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const parsed = stageSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the stage." };
  const data = parsed.data;
  const pipeline = await leadStages();
  if (!pipeline.stored) return { ok: false, error: NOT_READY };

  const existing = data.id ? pipeline.stages.find((s) => s.id === data.id) : undefined;
  if (data.id && !existing) return { ok: false, error: "That stage no longer exists." };
  const problem = checkStage(data, pipeline.stages.filter((s) => s.id !== data.id));
  if (problem) return { ok: false, error: problem };

  if (!existing) {
    if (pipeline.stages.filter((s) => !s.archived).length >= PIPELINE_LIMITS.stages) {
      return { ok: false, error: `A pipeline can have ${PIPELINE_LIMITS.stages} stages. Retire one first.` };
    }
    const created = await db.leadStage.create({
      data: {
        key: stageKeyFromLabel(data.label, pipeline.stages.map((s) => s.key)),
        label: data.label,
        status: data.status,
        color: data.color,
        sortOrder: pipeline.stages.length + 1,
      },
      select: { id: true },
    });
    const ordered = pipeline.stages.map((s) => s.id);
    const firstClosed = pipeline.stages.findIndex((s) => kindOf(s.status) !== "OPEN");
    const at = kindOf(data.status) === "OPEN" && firstClosed >= 0 ? firstClosed : ordered.length;
    ordered.splice(at, 0, created.id);
    await renumber(ordered);
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "LeadStage", entityId: created.id, entityLabel: `Pipeline stage ${data.label} — ${meaningOf(data.status).label.toLowerCase()}` });
    refresh();
    return { ok: true, data: { id: created.id } };
  }

  const meaningChanges = existing.status !== data.status;
  if (meaningChanges) {
    const keep = mustKeep(existing, pipeline.stages);
    if (keep) return { ok: false, error: keep };
  }
  const where = inStageWhere(pipeline, existing);
  const held = meaningChanges ? await db.lead.count({ where }) : 0;
  if (meaningChanges && held > 0 && kindOf(existing.status) !== kindOf(data.status)) {
    return {
      ok: false,
      error: `${held} lead${held === 1 ? " is" : "s are"} in ${existing.label}. A stage with leads can only change to another open meaning — move them first, or add a new stage.`,
    };
  }

  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.leadStage.update({ where: { id: existing.id }, data: { label: data.label, color: data.color, status: data.status } });
    if (meaningChanges && held > 0) {
      // Its leads follow: a lead's status is always its stage's meaning. A note on each says why it moved.
      const leads = await tx.lead.findMany({ where, select: { id: true } });
      await tx.lead.updateMany({ where: { id: { in: leads.map((l) => l.id) } }, data: { status: data.status, stageId: existing.id, stageChangedAt: now } });
      await tx.activity.createMany({
        data: leads.map((l) => ({
          leadId: l.id,
          userId: user.id,
          type: "STAGE_CHANGE" as const,
          notes: stageChangeNote(existing, { status: data.status, label: data.label }, `${existing.label} now counts as ${meaningOf(data.status).label.toLowerCase()}`),
        })),
      });
    }
  });
  const changes = [
    existing.label !== data.label ? `renamed from ${existing.label}` : null,
    meaningChanges ? `now counts as ${meaningOf(data.status).label.toLowerCase()}${held > 0 ? `, ${held} lead${held === 1 ? "" : "s"} with it` : ""}` : null,
    existing.color !== data.color ? "colour changed" : null,
  ].filter(Boolean);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "LeadStage", entityId: existing.id, entityLabel: `Pipeline stage ${data.label}${changes.length ? ` — ${changes.join(", ")}` : ""}` });
  refresh();
  return { ok: true, data: { id: existing.id } };
}

/** One place earlier or later among the stages still in use. */
export async function moveLeadStage(id: string, direction: "up" | "down"): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const pipeline = await leadStages();
  if (!pipeline.stored) return { ok: false, error: NOT_READY };
  const active = pipeline.stages.filter((s) => !s.archived);
  const at = active.findIndex((s) => s.id === id);
  if (at < 0) return { ok: false, error: "That stage no longer exists." };
  const to = direction === "up" ? at - 1 : at + 1;
  if (to < 0 || to >= active.length) return { ok: true, data: null };
  const order = active.map((s) => s.id);
  [order[at], order[to]] = [order[to]!, order[at]!];
  // Retired stages keep their places after the ones in use.
  await renumber([...order, ...pipeline.stages.filter((s) => s.archived).map((s) => s.id)]);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "LeadStage", entityId: id, entityLabel: `Pipeline stage ${active[at]!.label} moved ${direction}` });
  refresh();
  return { ok: true, data: null };
}

/**
 * Retires a stage: no longer offered or shown as a column. Its leads move to `moveToId` first — a stage
 * of the same kind (`rehomeTargets`). Between two stages with one meaning they just change column; to an
 * open stage with another meaning they change status too, with a note on each, as any move would.
 */
export async function retireLeadStage(id: string, moveToId?: string | null): Promise<ActionResult<{ moved: number }>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const pipeline = await leadStages();
  if (!pipeline.stored) return { ok: false, error: NOT_READY };
  const stage = pipeline.stages.find((s) => s.id === id && !s.archived);
  if (!stage) return { ok: false, error: "That stage no longer exists." };
  const keep = mustKeep(stage, pipeline.stages);
  if (keep) return { ok: false, error: keep };

  const where = inStageWhere(pipeline, stage);
  const leads = await db.lead.findMany({ where, select: { id: true } });
  const target = moveToId ? rehomeTargets(stage, pipeline.stages).find((s) => s.id === moveToId) : undefined;
  if (leads.length > 0 && !target) {
    return { ok: false, error: `Choose where ${stage.label}'s ${leads.length} lead${leads.length === 1 ? " goes" : "s go"} first.` };
  }

  const now = new Date();
  await db.$transaction(async (tx) => {
    if (target && leads.length > 0) {
      const ids = leads.map((l) => l.id);
      if (target.status === stage.status) {
        // Same meaning: only the column changes. Not a stage change — when a lead was won stays as it was.
        await tx.lead.updateMany({ where: { id: { in: ids } }, data: { stageId: target.id } });
      } else {
        await tx.lead.updateMany({ where: { id: { in: ids } }, data: { stageId: target.id, status: target.status, stageChangedAt: now } });
        await tx.activity.createMany({
          data: ids.map((leadId) => ({ leadId, userId: user.id, type: "STAGE_CHANGE" as const, notes: stageChangeNote(stage, target, `${stage.label} was retired`) })),
        });
      }
    }
    await tx.leadStage.update({ where: { id: stage.id }, data: { archivedAt: now } });
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "LeadStage",
    entityId: stage.id,
    entityLabel: `Pipeline stage ${stage.label} retired${target && leads.length ? ` — ${leads.length} lead${leads.length === 1 ? "" : "s"} moved to ${target.label}` : ""}`,
  });
  refresh();
  return { ok: true, data: { moved: leads.length } };
}

/** Puts a retired stage back, at the end of the ones in use of its kind. */
export async function restoreLeadStage(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const pipeline = await leadStages();
  if (!pipeline.stored) return { ok: false, error: NOT_READY };
  const stage = pipeline.stages.find((s) => s.id === id && s.archived);
  if (!stage) return { ok: false, error: "That stage isn't retired." };
  const problem = checkStage(stage, pipeline.stages.filter((s) => s.id !== id));
  if (problem) return { ok: false, error: `${problem} Rename that one first.` };
  if (pipeline.stages.filter((s) => !s.archived).length >= PIPELINE_LIMITS.stages) {
    return { ok: false, error: `A pipeline can have ${PIPELINE_LIMITS.stages} stages. Retire one first.` };
  }
  await db.leadStage.update({ where: { id }, data: { archivedAt: null } });
  const active = pipeline.stages.filter((s) => !s.archived);
  const lastOfKind = active.map((s) => kindOf(s.status)).lastIndexOf(kindOf(stage.status));
  const order = active.map((s) => s.id);
  order.splice(lastOfKind >= 0 ? lastOfKind + 1 : order.length, 0, id);
  await renumber([...order, ...pipeline.stages.filter((s) => s.archived && s.id !== id).map((s) => s.id)]);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "LeadStage", entityId: id, entityLabel: `Pipeline stage ${stage.label} restored` });
  refresh();
  return { ok: true, data: null };
}

/** Deletes a stage no lead is in — a mistake made a minute ago. One that has held leads is retired instead. */
export async function deleteLeadStage(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const pipeline = await leadStages();
  if (!pipeline.stored) return { ok: false, error: NOT_READY };
  const stage = pipeline.stages.find((s) => s.id === id);
  if (!stage) return { ok: false, error: "That stage no longer exists." };
  const keep = stage.archived ? null : mustKeep(stage, pipeline.stages);
  if (keep) return { ok: false, error: keep };
  const held = await db.lead.count({ where: inStageWhere(pipeline, stage) });
  if (held > 0) return { ok: false, error: `${held} lead${held === 1 ? " is" : "s are"} in ${stage.label}. Retire it instead — its leads are moved on first.` };
  await db.leadStage.delete({ where: { id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "LeadStage", entityId: id, entityLabel: `Pipeline stage ${stage.label}` });
  refresh();
  return { ok: true, data: null };
}

// ── Order steps (Settings → Pipeline → Orders) ───────────────────────────────────────────────────

/**
 * A workspace's own steps within an order status (src/lib/pipeline/order-steps.ts). The same
 * permission as the lead stages: both are how the workspace's work is shaped. Moving an order between
 * steps is the order's own action (`setOrderStep` in src/actions/order-progress.ts).
 */

function refreshOrders() {
  revalidatePath("/settings/pipeline");
  revalidatePath("/orders");
}

/**
 * `orders` is how many orders show at the step (the first also shows those with none); `placed`, how
 * many were moved to it and are still in its status — an order that has since moved on to another
 * status still names the step, but is no longer at it.
 */
export type ManagedStep = OrderStepDef & { orders: number; placed: number };

/** The steps by status, retired ones too, with how many orders each shows and how many were moved to it. */
export async function listOrderStepsForManage(): Promise<{ steps: ManagedStep[]; stored: boolean } | null> {
  if (!(await manager())) return null;
  const data = await orderSteps();
  const counts = await Promise.all(
    data.steps.map((s) => Promise.all([db.companyProduct.count({ where: inStepWhere(data, s) }), db.companyProduct.count({ where: { stepId: s.id, orderStatus: s.status } })])),
  );
  return { stored: data.stored, steps: data.steps.map((s, i) => ({ ...s, orders: counts[i]![0], placed: counts[i]![1] })) };
}

const stepSchema = z.object({
  id: z.string().min(1).optional(),
  label: z.string().trim().min(1, "Give the step a name.").max(STEP_LIMITS.label, `Keep the name to ${STEP_LIMITS.label} characters.`),
  status: z.enum(["APPROVED", "PROCESSING", "FULFILLED"]),
  color: z.enum(STAGE_COLORS),
});

/** Renumbers the steps in the order given, in one transaction. */
async function renumberSteps(ids: string[]) {
  await db.$transaction(async (tx) => {
    for (const [i, id] of ids.entries()) await tx.orderStep.update({ where: { id }, data: { sortOrder: i + 1 } });
  });
}

/** Adds a step at the end of its status, or renames and recolours one. A step's status is fixed once made. */
export async function saveOrderStep(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const parsed = stepSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the step." };
  const data = parsed.data;
  const current = await orderSteps();
  if (!current.stored) return { ok: false, error: NOT_READY };

  const existing = data.id ? current.steps.find((s) => s.id === data.id) : undefined;
  if (data.id && !existing) return { ok: false, error: "That step no longer exists." };
  // Its orders sit within its status, so the status stays put once orders can be at it.
  const status = existing ? existing.status : data.status;
  const problem = checkStep({ ...data, status }, current.steps.filter((s) => s.id !== data.id));
  if (problem) return { ok: false, error: problem };

  if (!existing) {
    if (stepsOf(current.steps, status).length >= STEP_LIMITS.perStatus) {
      return { ok: false, error: `${stepStatusLabel(status)} can have ${STEP_LIMITS.perStatus} steps. Retire one first.` };
    }
    const created = await db.orderStep.create({
      data: { key: stepKeyFromLabel(data.label, current.steps.map((s) => s.key)), label: data.label, status, color: data.color, sortOrder: current.steps.length + 1 },
      select: { id: true },
    });
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "OrderStep", entityId: created.id, entityLabel: `Order step ${data.label} — ${stepStatusLabel(status).toLowerCase()}` });
    refreshOrders();
    return { ok: true, data: { id: created.id } };
  }

  await db.orderStep.update({ where: { id: existing.id }, data: { label: data.label, color: data.color } });
  const changes = [existing.label !== data.label ? `renamed from ${existing.label}` : null, existing.color !== data.color ? "colour changed" : null].filter(Boolean);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "OrderStep", entityId: existing.id, entityLabel: `Order step ${data.label}${changes.length ? ` — ${changes.join(", ")}` : ""}` });
  refreshOrders();
  return { ok: true, data: { id: existing.id } };
}

/** One place earlier or later among its status's steps. */
export async function moveOrderStep(id: string, direction: "up" | "down"): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const current = await orderSteps();
  if (!current.stored) return { ok: false, error: NOT_READY };
  const step = current.steps.find((s) => s.id === id && !s.archived);
  if (!step) return { ok: false, error: "That step no longer exists." };
  const siblings = stepsOf(current.steps, step.status);
  const at = siblings.findIndex((s) => s.id === id);
  const to = direction === "up" ? at - 1 : at + 1;
  if (to < 0 || to >= siblings.length) return { ok: true, data: null };
  const order = current.steps.filter((s) => !s.archived).map((s) => s.id);
  const a = order.indexOf(siblings[at]!.id);
  const b = order.indexOf(siblings[to]!.id);
  [order[a], order[b]] = [order[b]!, order[a]!];
  await renumberSteps([...order, ...current.steps.filter((s) => s.archived).map((s) => s.id)]);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "OrderStep", entityId: id, entityLabel: `Order step ${step.label} moved ${direction}` });
  refreshOrders();
  return { ok: true, data: null };
}

/**
 * Retires a step: no longer offered. The orders moved to it go to `moveToId` — another step of its
 * status — first; ones only shown at it (it was the first) fall to whichever step is first now.
 */
export async function retireOrderStep(id: string, moveToId?: string | null): Promise<ActionResult<{ moved: number }>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const current = await orderSteps();
  if (!current.stored) return { ok: false, error: NOT_READY };
  const step = current.steps.find((s) => s.id === id && !s.archived);
  if (!step) return { ok: false, error: "That step no longer exists." };
  const placed = await db.companyProduct.findMany({ where: { stepId: step.id, orderStatus: step.status }, select: { id: true } });
  const target = moveToId ? stepRehomeTargets(step, current.steps).find((s) => s.id === moveToId) : undefined;
  if (placed.length > 0 && !target) {
    return { ok: false, error: `Choose where the ${placed.length} order${placed.length === 1 ? "" : "s"} at ${step.label} should go first.` };
  }
  const now = new Date();
  await db.$transaction(async (tx) => {
    if (target && placed.length > 0) {
      const ids = placed.map((o) => o.id);
      await tx.companyProduct.updateMany({ where: { id: { in: ids } }, data: { stepId: target.id, stepChangedAt: now } });
      await tx.orderStepChange.createMany({
        data: ids.map((orderId) => ({ orderId, fromStepId: step.id, fromLabel: step.label, toStepId: target.id, toLabel: target.label, userId: user.id, note: `${step.label} was retired` })),
      });
    }
    await tx.orderStep.update({ where: { id: step.id }, data: { archivedAt: now } });
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "OrderStep",
    entityId: step.id,
    entityLabel: `Order step ${step.label} retired${target && placed.length ? ` — ${placed.length} order${placed.length === 1 ? "" : "s"} moved to ${target.label}` : ""}`,
  });
  refreshOrders();
  return { ok: true, data: { moved: placed.length } };
}

/** Puts a retired step back, last among its status's steps. */
export async function restoreOrderStep(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const current = await orderSteps();
  if (!current.stored) return { ok: false, error: NOT_READY };
  const step = current.steps.find((s) => s.id === id && s.archived);
  if (!step) return { ok: false, error: "That step is not retired." };
  const problem = checkStep(step, current.steps.filter((s) => s.id !== id));
  if (problem) return { ok: false, error: `${problem} Rename that one first.` };
  if (stepsOf(current.steps, step.status).length >= STEP_LIMITS.perStatus) {
    return { ok: false, error: `${stepStatusLabel(step.status)} can have ${STEP_LIMITS.perStatus} steps. Retire one first.` };
  }
  await db.orderStep.update({ where: { id }, data: { archivedAt: null } });
  const active = current.steps.filter((s) => !s.archived).map((s) => s.id);
  await renumberSteps([...active, id, ...current.steps.filter((s) => s.archived && s.id !== id).map((s) => s.id)]);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "OrderStep", entityId: id, entityLabel: `Order step ${step.label} restored` });
  refreshOrders();
  return { ok: true, data: null };
}

/** Deletes a step no order is at — a mistake made a minute ago. The history keeps its name. */
export async function deleteOrderStep(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const current = await orderSteps();
  if (!current.stored) return { ok: false, error: NOT_READY };
  const step = current.steps.find((s) => s.id === id);
  if (!step) return { ok: false, error: "That step no longer exists." };
  // Only orders still in its status are at it; one that moved on still names it, and simply lets go.
  const placed = await db.companyProduct.count({ where: { stepId: step.id, orderStatus: step.status } });
  if (placed > 0) return { ok: false, error: `${placed} order${placed === 1 ? " is" : "s are"} at ${step.label}. Retire it instead — they are moved on first.` };
  await db.orderStep.delete({ where: { id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "OrderStep", entityId: id, entityLabel: `Order step ${step.label}` });
  refreshOrders();
  return { ok: true, data: null };
}
