"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { PipelineTrigger } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { notMigratedYet } from "@/lib/custom-fields/server";
import { leadStages } from "@/lib/pipeline/server";
import { pipelineById } from "@/lib/pipeline/rules";
import { AUTOMATION_LIMITS, parseActions, storedActions, type AutomationAction } from "@/lib/pipeline/automation-rules";
import type { ActionResult } from "@/actions/company";

/**
 * Settings → Pipeline → Automations (owner, 14 Oct 2026): a pipeline's simple automations — when a lead
 * arrives or enters a stage, make a task, email the contact, give it to someone, tell someone
 * (src/lib/pipeline/automation-rules.ts). Shaping them is `pipeline.manage`, like the stages they hang off.
 * They run in src/lib/pipeline/automations.ts.
 */

async function manager() {
  const user = await requireUser();
  return (await can(user.id, "pipeline.manage")) ? user : null;
}

const NOT_ALLOWED = "You can't change the pipeline's automations.";
const NOT_READY = "This workspace is still being updated. Try again in a minute.";

function refresh() {
  revalidatePath("/settings/pipeline");
}

export type ManagedAutomation = {
  id: string;
  pipelineId: string;
  name: string;
  trigger: PipelineTrigger;
  stageId: string | null;
  actions: AutomationAction[];
  active: boolean;
  runs: number;
  lastRunAt: Date | null;
  lastError: string | null;
};

/** Every pipeline's automations, and the people an action may name. Null for somebody who can't manage them. */
export async function listAutomationsForManage(): Promise<{ automations: ManagedAutomation[]; people: { id: string; name: string }[]; ready: boolean } | null> {
  if (!(await manager())) return null;
  const people = await db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  try {
    const rows = await db.pipelineAutomation.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, pipelineId: true, name: true, trigger: true, stageId: true, actions: true, active: true, runs: true, lastRunAt: true, lastError: true },
    });
    return { ready: true, people, automations: rows.map((r) => ({ ...r, actions: storedActions(r.actions) })) };
  } catch (err) {
    if (notMigratedYet(err)) return { ready: false, people, automations: [] };
    throw err;
  }
}

const automationSchema = z.object({
  id: z.string().min(1).optional(),
  pipelineId: z.string().min(1),
  name: z.string().trim().min(1, "Give the automation a name.").max(AUTOMATION_LIMITS.name, `Keep the name to ${AUTOMATION_LIMITS.name} characters.`),
  trigger: z.enum(["LEAD_CREATED", "STAGE_ENTERED"]),
  stageId: z.string().min(1).nullable().optional(),
  actions: z.array(z.unknown()),
  active: z.boolean().default(true),
});

/**
 * Adds an automation to a pipeline or changes one. It starts on a lead arriving, or on entering one of the
 * pipeline's stages still in use; what it does is checked as a whole (`parseActions`) against the people
 * who are active now.
 */
export async function saveAutomation(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const parsed = automationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the automation." };
  const data = parsed.data;
  const pipeline = await leadStages();
  if (!pipeline.multi) return { ok: false, error: NOT_READY };
  const owner = pipeline.pipelines.find((p) => p.id === data.pipelineId && !p.archived);
  if (!owner) return { ok: false, error: "That pipeline is no longer in use." };
  const stageId = data.trigger === "STAGE_ENTERED" ? (data.stageId ?? null) : null;
  if (data.trigger === "STAGE_ENTERED") {
    const stage = pipeline.stages.find((s) => s.id === stageId && s.pipelineId === owner.id && !s.archived);
    if (!stage) return { ok: false, error: `Choose one of ${owner.name}'s stages.` };
  }
  const people = new Set((await db.user.findMany({ where: { active: true }, select: { id: true } })).map((u) => u.id));
  const actions = parseActions(data.actions, people);
  if (!actions.ok) return { ok: false, error: actions.error };

  const existing = data.id ? await db.pipelineAutomation.findUnique({ where: { id: data.id }, select: { id: true, pipelineId: true } }) : null;
  if (data.id && !existing) return { ok: false, error: "That automation no longer exists." };
  if (existing && existing.pipelineId !== owner.id) return { ok: false, error: "An automation stays with its pipeline." };
  if (!existing && (await db.pipelineAutomation.count({ where: { pipelineId: owner.id } })) >= AUTOMATION_LIMITS.perPipeline) {
    return { ok: false, error: `A pipeline can have ${AUTOMATION_LIMITS.perPipeline} automations. Delete one first.` };
  }
  const fields = { name: data.name, trigger: data.trigger, stageId, actions: actions.actions, active: data.active };
  const saved = existing
    ? await db.pipelineAutomation.update({ where: { id: existing.id }, data: { ...fields, lastError: null }, select: { id: true } })
    : await db.pipelineAutomation.create({ data: { ...fields, pipelineId: owner.id, createdById: user.id }, select: { id: true } });
  await recordAudit({
    userId: user.id,
    action: existing ? "UPDATE" : "CREATE",
    entityType: "PipelineAutomation",
    entityId: saved.id,
    entityLabel: `${pipelineById(pipeline.pipelines, owner.id).name} automation ${data.name}${data.active ? "" : " (off)"}`,
  });
  refresh();
  return { ok: true, data: { id: saved.id } };
}

/** Switches an automation on or off. */
export async function setAutomationActive(id: string, active: boolean): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const row = await db.pipelineAutomation.findUnique({ where: { id }, select: { id: true, name: true, pipelineId: true, stageId: true } });
  if (!row) return { ok: false, error: "That automation no longer exists." };
  if (active) {
    const pipeline = await leadStages();
    if (pipelineById(pipeline.pipelines, row.pipelineId).archived) return { ok: false, error: "Its pipeline is retired." };
    if (row.stageId && !pipeline.stages.some((s) => s.id === row.stageId && !s.archived)) return { ok: false, error: "Its stage is retired. Choose another stage first." };
  }
  await db.pipelineAutomation.update({ where: { id }, data: { active } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "PipelineAutomation", entityId: id, entityLabel: `Automation ${row.name} switched ${active ? "on" : "off"}` });
  refresh();
  return { ok: true, data: null };
}

/** Deletes an automation. What it already did stays done. */
export async function deleteAutomation(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const row = await db.pipelineAutomation.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!row) return { ok: false, error: "That automation no longer exists." };
  await db.pipelineAutomation.delete({ where: { id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "PipelineAutomation", entityId: id, entityLabel: `Automation ${row.name}` });
  refresh();
  return { ok: true, data: null };
}
