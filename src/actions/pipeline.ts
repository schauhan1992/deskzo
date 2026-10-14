"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { LeadStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { definitionsFor } from "@/lib/custom-fields/server";
import { inPipelineWhere, inStageWhere, leadStages, type Pipeline } from "@/lib/pipeline/server";
import {
  MAIN_PIPELINE_ID,
  MEANINGS,
  PIPELINE_LIMITS,
  RULE_LIMIT,
  STAGE_COLORS,
  checkPipeline,
  checkStage,
  isRuleField,
  kindOf,
  meaningLabel,
  meaningsFor,
  mustKeep,
  pipelineById,
  rehomeTargets,
  stageChangeNote,
  stageKeyFromLabel,
  stagesOfPipeline,
  type LeadStageDef,
  type PipelineDef,
  type StageColor,
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
 *
 * Several pipelines (owner, 14 Oct 2026): every stage action works within the stage's own pipeline. A
 * pipeline is added with a starting set of stages, may count as sales or not, may carry its won leads on
 * into another, and is retired only once it holds no open leads. The main one is always there.
 */

/** Shaping the lead pipelines — part of the leads module, so only where the plan has leads. */
async function manager() {
  const user = await requireModuleUser("leads");
  return (await can(user.id, "pipeline.manage")) ? user : null;
}

/** Shaping an order's steps — the same permission, in a workspace whose plan has orders. */
async function stepsManager() {
  const user = await requireModuleUser("orders");
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
export type ManagedPipeline = PipelineDef & { leads: number; open: number };

/**
 * Everything the settings screen shows: the pipelines and their stages in order, retired ones too, with
 * how many leads each holds — and the workspace's own lead fields, which a stage's rule may ask for.
 */
export async function listPipelineForManage(): Promise<{
  stages: ManagedStage[];
  pipelines: ManagedPipeline[];
  stored: boolean;
  multi: boolean;
  fields: { key: string; label: string }[];
} | null> {
  if (!(await manager())) return null;
  const pipeline = await leadStages();
  const [counts, perPipeline, fields] = await Promise.all([
    leadCounts(pipeline),
    Promise.all(
      pipeline.pipelines.map((p) =>
        Promise.all([
          db.lead.count({ where: inPipelineWhere(pipeline, p.id) }),
          db.lead.count({ where: { AND: [inPipelineWhere(pipeline, p.id), { status: { notIn: ["WON", "LOST", "DISQUALIFIED"] } }] } }),
        ]),
      ),
    ),
    definitionsFor("LEAD"),
  ]);
  return {
    stored: pipeline.stored,
    multi: pipeline.multi,
    stages: pipeline.stages.map((s) => ({ ...s, leads: counts.get(s.id) ?? 0 })),
    pipelines: pipeline.pipelines.map((p, i) => ({ ...p, leads: perPipeline[i]![0], open: perPipeline[i]![1] })),
    fields: fields.filter((f) => !f.archivedAt).map((f) => ({ key: f.key, label: f.label })),
  };
}

// ── Pipelines ─────────────────────────────────────────────────────────────────────────────────────

const pipelineSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1, "Give the pipeline a name.").max(PIPELINE_LIMITS.label, `Keep the name to ${PIPELINE_LIMITS.label} characters.`),
  sales: z.boolean(),
  nextPipelineId: z.string().min(1).nullable().optional(),
});

/** The stages a new pipeline starts with: a short sales pipeline, or a process's four. */
function starterStages(sales: boolean): { label: string; status: LeadStatus; color: StageColor }[] {
  return sales
    ? [
        { label: "New", status: "NEW", color: "default" },
        { label: "Contacted", status: "CONTACTED", color: "blue" },
        { label: "Qualified", status: "QUALIFIED", color: "amber" },
        { label: "Proposal sent", status: "PROPOSAL_SENT", color: "amber" },
        { label: "Won", status: "WON", color: "green" },
        { label: "Lost", status: "LOST", color: "red" },
      ]
    : [
        { label: "Start", status: "NEW", color: "default" },
        { label: "Under way", status: "CONTACTED", color: "blue" },
        { label: "Done", status: "WON", color: "green" },
        { label: "Dropped", status: "LOST", color: "red" },
      ];
}

/** The pipeline's stages in use that mean something only a sales pipeline may — what stops it becoming a process. */
function salesOnlyStages(stages: LeadStageDef[]): LeadStageDef[] {
  const allowed = new Set(meaningsFor(false).map((m) => m.status));
  return stages.filter((s) => !s.archived && !allowed.has(s.status));
}

/**
 * Adds a pipeline — with its first stages, so it can be used at once — or changes one: its name, whether
 * it counts as sales, and where its won leads carry on. Becoming a process needs every stage in use to
 * mean one of a process's four things first; what was won in it stops counting as sales from then on,
 * which the screen says before it is saved.
 */
export async function savePipeline(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const parsed = pipelineSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the pipeline." };
  const data = { ...parsed.data, nextPipelineId: parsed.data.nextPipelineId ?? null };
  const pipeline = await leadStages();
  if (!pipeline.multi || !pipeline.stored) return { ok: false, error: NOT_READY };

  const existing = data.id ? pipeline.pipelines.find((p) => p.id === data.id) : undefined;
  if (data.id && !existing) return { ok: false, error: "That pipeline no longer exists." };
  const problem = checkPipeline(data, existing?.id ?? null, pipeline.pipelines);
  if (problem) return { ok: false, error: problem };

  if (!existing) {
    if (pipeline.pipelines.filter((p) => !p.archived).length >= PIPELINE_LIMITS.pipelines) {
      return { ok: false, error: `A workspace can have ${PIPELINE_LIMITS.pipelines} pipelines. Retire one first.` };
    }
    const key = stageKeyFromLabel(data.name, pipeline.pipelines.map((p) => p.key));
    const created = await db.$transaction(async (tx) => {
      const made = await tx.leadPipeline.create({
        data: { key, name: data.name, sales: data.sales, nextPipelineId: data.nextPipelineId, sortOrder: pipeline.pipelines.length + 1 },
        select: { id: true },
      });
      const keys: string[] = [];
      for (const [i, s] of starterStages(data.sales).entries()) {
        const stageKey = stageKeyFromLabel(s.label, keys);
        keys.push(stageKey);
        await tx.leadStage.create({ data: { pipelineId: made.id, key: stageKey, label: s.label, status: s.status, color: s.color, sortOrder: i + 1 }, select: { id: true } });
      }
      return made;
    });
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "LeadPipeline", entityId: created.id, entityLabel: `Pipeline ${data.name}${data.sales ? " — counts as sales" : ""}` });
    refresh();
    return { ok: true, data: { id: created.id } };
  }

  if (existing.sales && !data.sales) {
    const blocking = salesOnlyStages(stagesOfPipeline(pipeline.stages, existing.id));
    if (blocking.length) {
      return {
        ok: false,
        error: `${blocking.map((s) => s.label).join(", ")} ${blocking.length === 1 ? "counts" : "count"} as something only a sales pipeline has. Change ${blocking.length === 1 ? "it" : "them"} to start, under way, done or dropped first.`,
      };
    }
  }
  await db.leadPipeline.update({ where: { id: existing.id }, data: { name: data.name, sales: data.sales, nextPipelineId: data.nextPipelineId } });
  const next = data.nextPipelineId ? pipelineById(pipeline.pipelines, data.nextPipelineId).name : null;
  const changes = [
    existing.name !== data.name ? `renamed from ${existing.name}` : null,
    existing.sales !== data.sales ? (data.sales ? "now counts as sales" : "no longer counts as sales") : null,
    existing.nextPipelineId !== data.nextPipelineId ? (next ? `won leads carry on into ${next}` : "won leads no longer carry on") : null,
  ].filter(Boolean);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "LeadPipeline", entityId: existing.id, entityLabel: `Pipeline ${data.name}${changes.length ? ` — ${changes.join(", ")}` : ""}` });
  refresh();
  return { ok: true, data: { id: existing.id } };
}

/** One place earlier or later among the pipelines in use — the order of the board's pipeline switch. */
export async function movePipeline(id: string, direction: "up" | "down"): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const pipeline = await leadStages();
  if (!pipeline.multi) return { ok: false, error: NOT_READY };
  const active = pipeline.pipelines.filter((p) => !p.archived);
  const at = active.findIndex((p) => p.id === id);
  if (at < 0) return { ok: false, error: "That pipeline no longer exists." };
  const to = direction === "up" ? at - 1 : at + 1;
  if (to < 0 || to >= active.length) return { ok: true, data: null };
  const order = active.map((p) => p.id);
  [order[at], order[to]] = [order[to]!, order[at]!];
  const all = [...order, ...pipeline.pipelines.filter((p) => p.archived).map((p) => p.id)];
  await db.$transaction(async (tx) => {
    for (const [i, pid] of all.entries()) await tx.leadPipeline.update({ where: { id: pid }, data: { sortOrder: i + 1 } });
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "LeadPipeline", entityId: id, entityLabel: `Pipeline ${active[at]!.name} moved ${direction}` });
  refresh();
  return { ok: true, data: null };
}

/**
 * Retires a pipeline: no longer offered for new leads, nor shown on the board's switch. Only once it holds
 * no open leads — they are moved to another pipeline or closed first; its closed ones stay where they
 * are, with their history. Whatever carried its won leads on into it stops doing so.
 */
export async function retirePipeline(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const pipeline = await leadStages();
  if (!pipeline.multi) return { ok: false, error: NOT_READY };
  if (id === MAIN_PIPELINE_ID) return { ok: false, error: "The main pipeline is always there." };
  const target = pipeline.pipelines.find((p) => p.id === id && !p.archived);
  if (!target) return { ok: false, error: "That pipeline no longer exists." };
  const open = await db.lead.count({ where: { AND: [inPipelineWhere(pipeline, id), { status: { notIn: ["WON", "LOST", "DISQUALIFIED"] } }] } });
  if (open > 0) return { ok: false, error: `${open} open lead${open === 1 ? " is" : "s are"} in ${target.name}. Move ${open === 1 ? "it" : "them"} to another pipeline or close ${open === 1 ? "it" : "them"} first.` };
  await db.$transaction(async (tx) => {
    await tx.leadPipeline.update({ where: { id }, data: { archivedAt: new Date(), nextPipelineId: null } });
    await tx.leadPipeline.updateMany({ where: { nextPipelineId: id }, data: { nextPipelineId: null } });
    await tx.pipelineAutomation.updateMany({ where: { pipelineId: id }, data: { active: false } });
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "LeadPipeline", entityId: id, entityLabel: `Pipeline ${target.name} retired` });
  refresh();
  return { ok: true, data: null };
}

/** Puts a retired pipeline back, last. Its automations stay off until they are switched on again. */
export async function restorePipeline(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const pipeline = await leadStages();
  if (!pipeline.multi) return { ok: false, error: NOT_READY };
  const target = pipeline.pipelines.find((p) => p.id === id && p.archived);
  if (!target) return { ok: false, error: "That pipeline isn't retired." };
  const problem = checkPipeline({ name: target.name, sales: target.sales, nextPipelineId: null }, id, pipeline.pipelines);
  if (problem) return { ok: false, error: `${problem} Rename that one first.` };
  if (pipeline.pipelines.filter((p) => !p.archived).length >= PIPELINE_LIMITS.pipelines) {
    return { ok: false, error: `A workspace can have ${PIPELINE_LIMITS.pipelines} pipelines. Retire one first.` };
  }
  await db.leadPipeline.update({ where: { id }, data: { archivedAt: null, sortOrder: pipeline.pipelines.length + 1 } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "LeadPipeline", entityId: id, entityLabel: `Pipeline ${target.name} restored` });
  refresh();
  return { ok: true, data: null };
}

/** Deletes a pipeline no lead has ever been in — a mistake made a minute ago. One that has is retired instead. */
export async function deletePipeline(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const pipeline = await leadStages();
  if (!pipeline.multi) return { ok: false, error: NOT_READY };
  if (id === MAIN_PIPELINE_ID) return { ok: false, error: "The main pipeline is always there." };
  const target = pipeline.pipelines.find((p) => p.id === id);
  if (!target) return { ok: false, error: "That pipeline no longer exists." };
  const held = await db.lead.count({ where: { pipelineId: id } });
  if (held > 0) return { ok: false, error: `${held} lead${held === 1 ? " is" : "s are"} in ${target.name}. Retire it instead.` };
  await db.$transaction(async (tx) => {
    await tx.leadPipeline.updateMany({ where: { nextPipelineId: id }, data: { nextPipelineId: null } });
    await tx.bookingPage.updateMany({ where: { pipelineId: id }, data: { pipelineId: null } });
    await tx.leadPipeline.delete({ where: { id } });
  });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "LeadPipeline", entityId: id, entityLabel: `Pipeline ${target.name}` });
  refresh();
  return { ok: true, data: null };
}

// ── Stages ────────────────────────────────────────────────────────────────────────────────────────

const stageSchema = z.object({
  id: z.string().min(1).optional(),
  /** The pipeline a new stage is added to; the main one when not given. A stage never changes pipeline. */
  pipelineId: z.string().min(1).optional(),
  label: z.string().trim().min(1, "Give the stage a name.").max(PIPELINE_LIMITS.label, `Keep the name to ${PIPELINE_LIMITS.label} characters.`),
  status: z.enum(MEANINGS.map((m) => m.status) as [LeadStageDef["status"], ...LeadStageDef["status"][]]),
  color: z.enum(STAGE_COLORS),
  /** The stage's rule (src/lib/pipeline/rules.ts `RULE_FIELDS`, or "cf:<key>"); left out, it stays as it was. */
  requiredFields: z.array(z.string().trim().min(1).max(44)).max(RULE_LIMIT, `A stage can ask for ${RULE_LIMIT} fields at most.`).optional(),
});

/** Renumbers the stages in the order given — one transaction, so a board never sees two stages in one place. */
async function renumber(ids: string[]) {
  await db.$transaction(async (tx) => {
    for (const [i, id] of ids.entries()) await tx.leadStage.update({ where: { id }, data: { sortOrder: i + 1 } });
  });
}

/** What a stage's rule may ask for, checked: known fields, the workspace's own lead fields in use, each once. */
async function checkRule(fields: string[]): Promise<{ ok: true; fields: string[] } | { ok: false; error: string }> {
  const unique = [...new Set(fields)];
  if (unique.some((f) => !isRuleField(f))) return { ok: false, error: "A stage's rule can ask only for the fields listed." };
  const custom = unique.filter((f) => f.startsWith("cf:")).map((f) => f.slice(3));
  if (custom.length) {
    const known = new Set((await definitionsFor("LEAD")).filter((d) => !d.archivedAt).map((d) => d.key));
    if (custom.some((k) => !known.has(k))) return { ok: false, error: "One of those fields is no longer in use. Refresh the page." };
  }
  return { ok: true, fields: unique };
}

/**
 * Adds a stage to a pipeline or changes one: its name, colour, what it counts as, and its rule. A new
 * open stage goes in before the pipeline's first closed one, so a board's won and lost columns stay at
 * the end; a new closed one goes last.
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
  const pipelineId = existing?.pipelineId ?? data.pipelineId ?? MAIN_PIPELINE_ID;
  const owner = pipeline.pipelines.find((p) => p.id === pipelineId && !p.archived);
  if (!owner) return { ok: false, error: "That pipeline is no longer in use." };
  if (pipelineId !== MAIN_PIPELINE_ID && !pipeline.multi) return { ok: false, error: NOT_READY };
  const siblings = stagesOfPipeline(pipeline.stages, pipelineId);
  const problem = checkStage(data, siblings.filter((s) => s.id !== data.id), owner.sales);
  if (problem) return { ok: false, error: problem };
  let rule: string[] | undefined;
  if (data.requiredFields !== undefined) {
    if (!pipeline.multi) return { ok: false, error: NOT_READY };
    const checked = await checkRule(data.requiredFields);
    if (!checked.ok) return { ok: false, error: checked.error };
    rule = checked.fields;
  }

  if (!existing) {
    if (siblings.filter((s) => !s.archived).length >= PIPELINE_LIMITS.stages) {
      return { ok: false, error: `A pipeline can have ${PIPELINE_LIMITS.stages} stages. Retire one first.` };
    }
    const created = await db.leadStage.create({
      data: {
        ...(pipeline.multi ? { pipelineId } : {}),
        key: stageKeyFromLabel(data.label, siblings.map((s) => s.key)),
        label: data.label,
        status: data.status,
        color: data.color,
        sortOrder: siblings.length + 1,
        ...(rule ? { requiredFields: rule } : {}),
      },
      select: { id: true },
    });
    const ordered = siblings.map((s) => s.id);
    const firstClosed = siblings.findIndex((s) => kindOf(s.status) !== "OPEN");
    const at = kindOf(data.status) === "OPEN" && firstClosed >= 0 ? firstClosed : ordered.length;
    ordered.splice(at, 0, created.id);
    await renumber(ordered);
    await recordAudit({
      userId: user.id,
      action: "CREATE",
      entityType: "LeadStage",
      entityId: created.id,
      entityLabel: `${owner.name} stage ${data.label} — ${meaningLabel(data.status, owner.sales).toLowerCase()}`,
    });
    refresh();
    return { ok: true, data: { id: created.id } };
  }

  const meaningChanges = existing.status !== data.status;
  if (meaningChanges) {
    const keep = mustKeep(existing, pipeline.stages, owner.sales);
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
    await tx.leadStage.update({ where: { id: existing.id }, data: { label: data.label, color: data.color, status: data.status, ...(rule ? { requiredFields: rule } : {}) } });
    if (meaningChanges && held > 0) {
      // Its leads follow: a lead's status is always its stage's meaning. A note on each says why it moved.
      const leads = await tx.lead.findMany({ where, select: { id: true } });
      await tx.lead.updateMany({ where: { id: { in: leads.map((l) => l.id) } }, data: { status: data.status, stageId: existing.id, stageChangedAt: now } });
      await tx.activity.createMany({
        data: leads.map((l) => ({
          leadId: l.id,
          userId: user.id,
          type: "STAGE_CHANGE" as const,
          notes: stageChangeNote(existing, { status: data.status, label: data.label }, `${existing.label} now counts as ${meaningLabel(data.status, owner.sales).toLowerCase()}`),
        })),
      });
    }
  });
  const ruleChanged = rule !== undefined && rule.join() !== existing.requiredFields.join();
  const changes = [
    existing.label !== data.label ? `renamed from ${existing.label}` : null,
    meaningChanges ? `now counts as ${meaningLabel(data.status, owner.sales).toLowerCase()}${held > 0 ? `, ${held} lead${held === 1 ? "" : "s"} with it` : ""}` : null,
    existing.color !== data.color ? "colour changed" : null,
    ruleChanged ? (rule!.length ? `asks for ${rule!.length} field${rule!.length === 1 ? "" : "s"} first` : "asks for nothing first") : null,
  ].filter(Boolean);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "LeadStage", entityId: existing.id, entityLabel: `${owner.name} stage ${data.label}${changes.length ? ` — ${changes.join(", ")}` : ""}` });
  refresh();
  return { ok: true, data: { id: existing.id } };
}

/** One place earlier or later among its pipeline's stages still in use. */
export async function moveLeadStage(id: string, direction: "up" | "down"): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const pipeline = await leadStages();
  if (!pipeline.stored) return { ok: false, error: NOT_READY };
  const stage = pipeline.stages.find((s) => s.id === id);
  if (!stage) return { ok: false, error: "That stage no longer exists." };
  const siblings = stagesOfPipeline(pipeline.stages, stage.pipelineId);
  const active = siblings.filter((s) => !s.archived);
  const at = active.findIndex((s) => s.id === id);
  if (at < 0) return { ok: false, error: "That stage no longer exists." };
  const to = direction === "up" ? at - 1 : at + 1;
  if (to < 0 || to >= active.length) return { ok: true, data: null };
  const order = active.map((s) => s.id);
  [order[at], order[to]] = [order[to]!, order[at]!];
  // Retired stages keep their places after the ones in use.
  await renumber([...order, ...siblings.filter((s) => s.archived).map((s) => s.id)]);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "LeadStage", entityId: id, entityLabel: `Pipeline stage ${active[at]!.label} moved ${direction}` });
  refresh();
  return { ok: true, data: null };
}

/**
 * Retires a stage: no longer offered or shown as a column. Its leads move to `moveToId` first — a stage
 * of the same pipeline and kind (`rehomeTargets`). Between two stages with one meaning they just change
 * column; to an open stage with another meaning they change status too, with a note on each, as any move
 * would.
 */
export async function retireLeadStage(id: string, moveToId?: string | null): Promise<ActionResult<{ moved: number }>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const pipeline = await leadStages();
  if (!pipeline.stored) return { ok: false, error: NOT_READY };
  const stage = pipeline.stages.find((s) => s.id === id && !s.archived);
  if (!stage) return { ok: false, error: "That stage no longer exists." };
  const owner = pipelineById(pipeline.pipelines, stage.pipelineId);
  const keep = mustKeep(stage, pipeline.stages, owner.sales);
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
    // Its automations have nothing left to start them.
    if (pipeline.multi) await tx.pipelineAutomation.updateMany({ where: { stageId: stage.id }, data: { active: false } });
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

/** Puts a retired stage back, at the end of its pipeline's ones in use of its kind. */
export async function restoreLeadStage(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const pipeline = await leadStages();
  if (!pipeline.stored) return { ok: false, error: NOT_READY };
  const stage = pipeline.stages.find((s) => s.id === id && s.archived);
  if (!stage) return { ok: false, error: "That stage isn't retired." };
  const owner = pipelineById(pipeline.pipelines, stage.pipelineId);
  if (owner.archived) return { ok: false, error: `Restore ${owner.name} first.` };
  const siblings = stagesOfPipeline(pipeline.stages, stage.pipelineId);
  const problem = checkStage(stage, siblings.filter((s) => s.id !== id), owner.sales);
  if (problem) return { ok: false, error: `${problem} Rename that one first.` };
  if (siblings.filter((s) => !s.archived).length >= PIPELINE_LIMITS.stages) {
    return { ok: false, error: `A pipeline can have ${PIPELINE_LIMITS.stages} stages. Retire one first.` };
  }
  await db.leadStage.update({ where: { id }, data: { archivedAt: null } });
  const active = siblings.filter((s) => !s.archived);
  const lastOfKind = active.map((s) => kindOf(s.status)).lastIndexOf(kindOf(stage.status));
  const order = active.map((s) => s.id);
  order.splice(lastOfKind >= 0 ? lastOfKind + 1 : order.length, 0, id);
  await renumber([...order, ...siblings.filter((s) => s.archived && s.id !== id).map((s) => s.id)]);
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
  const keep = stage.archived ? null : mustKeep(stage, pipeline.stages, pipelineById(pipeline.pipelines, stage.pipelineId).sales);
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
  if (!(await stepsManager())) return null;
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
  const user = await stepsManager();
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
  const user = await stepsManager();
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
  const user = await stepsManager();
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
  const user = await stepsManager();
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
  const user = await stepsManager();
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
