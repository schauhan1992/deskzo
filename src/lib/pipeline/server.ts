import { cache } from "react";
import type { LeadStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/custom-fields/server";
import {
  MAIN_PIPELINE_ID,
  defaultPipelines,
  defaultStages,
  isStageColor,
  pipelineById,
  stageForStatus,
  stageOfLead,
  type LeadStageDef,
  type PipelineDef,
} from "@/lib/pipeline/rules";

/**
 * The workspace's lead pipelines, read from its database (src/lib/pipeline/rules.ts has the rules).
 *
 * Fails soft while a workspace waits for a migration:
 *   · before 20261015100000_lead_pipeline it is shown the stages every workspace starts with, under the
 *     ids the migration will give them, and `stored` says so — a lead is then written with its status
 *     alone, as before, and the migration gives it its stage when it runs;
 *   · before 20261102100000_team_pipelines it has one pipeline, the main one, whose stages have no rule,
 *     and `multi` says so — a lead is written without a pipeline, which means the main one anyway.
 * `Lead.stageId`, `stageChangedAt`, `pipelineId` and `fromLeadId` are left out of select-less reads until
 * every workspace has them (NOT_YET_EVERYWHERE in src/lib/tenancy/clients.ts), so they are only ever read
 * by name, through here.
 */

export type Pipeline = {
  stages: LeadStageDef[];
  pipelines: PipelineDef[];
  /** The workspace has stages of its own. */
  stored: boolean;
  /** The workspace has the tables for several pipelines. */
  multi: boolean;
};

const ORDER = [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }];

function stageOf(r: { id: string; key: string; label: string; status: LeadStatus; color: string; archivedAt: Date | null; pipelineId?: string; requiredFields?: string[] | null }): LeadStageDef {
  return {
    id: r.id,
    pipelineId: r.pipelineId ?? MAIN_PIPELINE_ID,
    key: r.key,
    label: r.label,
    status: r.status,
    color: isStageColor(r.color) ? r.color : "default",
    archived: r.archivedAt !== null,
    requiredFields: r.requiredFields ?? [],
  };
}

/** Every pipeline and stage in their order, retired ones included. Once per request. */
export const leadStages = cache(async (): Promise<Pipeline> => {
  try {
    const [rows, pipelines] = await Promise.all([
      db.leadStage.findMany({
        orderBy: ORDER,
        select: { id: true, key: true, label: true, status: true, color: true, archivedAt: true, pipelineId: true, requiredFields: true },
      }),
      db.leadPipeline.findMany({ orderBy: ORDER, select: { id: true, key: true, name: true, sales: true, nextPipelineId: true, archivedAt: true } }),
    ]);
    const defs: PipelineDef[] = pipelines.length
      ? pipelines.map((p) => ({ id: p.id, key: p.key, name: p.name, sales: p.sales, nextPipelineId: p.nextPipelineId, archived: p.archivedAt !== null }))
      : defaultPipelines();
    if (rows.length === 0) return { stages: defaultStages(), pipelines: defs, stored: false, multi: pipelines.length > 0 };
    return { stored: true, multi: true, pipelines: defs, stages: rows.map(stageOf) };
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  // Waiting for the team pipelines: one pipeline, its stages without a rule.
  try {
    const rows = await db.leadStage.findMany({ orderBy: ORDER, select: { id: true, key: true, label: true, status: true, color: true, archivedAt: true } });
    if (rows.length === 0) return { stages: defaultStages(), pipelines: defaultPipelines(), stored: false, multi: false };
    return { stored: true, multi: false, pipelines: defaultPipelines(), stages: rows.map(stageOf) };
  } catch (err) {
    if (notMigratedYet(err)) return { stages: defaultStages(), pipelines: defaultPipelines(), stored: false, multi: false };
    throw err;
  }
});

/** The pipelines still in use, in order — the main one first. */
export async function activePipelines(): Promise<PipelineDef[]> {
  return (await leadStages()).pipelines.filter((p) => !p.archived);
}

/** One pipeline's stages still in use, in order — what its board shows as columns and a picker offers. */
export async function activeStages(pipelineId: string = MAIN_PIPELINE_ID): Promise<LeadStageDef[]> {
  return (await leadStages()).stages.filter((s) => !s.archived && s.pipelineId === pipelineId);
}

/**
 * What to write on a lead as it enters a stage: the stage, when, and its pipeline, in a workspace that
 * has them; nothing beyond the status in one still waiting for stages.
 */
export function stageWrite(pipeline: Pipeline, stage: LeadStageDef, at: Date): { stageId?: string; stageChangedAt?: Date; pipelineId?: string } {
  if (!pipeline.stored) return {};
  return { stageId: stage.id, stageChangedAt: at, ...(pipeline.multi ? { pipelineId: stage.pipelineId } : {}) };
}

/**
 * Where a lead starts in a pipeline — the main one unless named: its first stage that means "new". Every
 * pipeline keeps one (`REQUIRED_MEANINGS`), so this only falls back for a pipeline retired meanwhile, or
 * stages that were tampered with.
 */
export async function entryStage(pipelineId?: string | null): Promise<{ pipeline: Pipeline; stage: LeadStageDef }> {
  const pipeline = await leadStages();
  const wanted = pipelineById(pipeline.pipelines, pipelineId);
  const into = wanted.archived ? MAIN_PIPELINE_ID : wanted.id;
  const stage = stageForStatus(pipeline.stages, "NEW", into) ?? stageForStatus(pipeline.stages, "NEW") ?? defaultStages()[0]!;
  return { pipeline, stage };
}

/** `stageWrite` for a lead being created — the status every new lead has, and its stage and pipeline. */
export async function newLeadStage(at = new Date(), pipelineId?: string | null): Promise<{ status: LeadStatus; stageId?: string; stageChangedAt?: Date; pipelineId?: string }> {
  const { pipeline, stage } = await entryStage(pipelineId);
  return { status: "NEW", ...stageWrite(pipeline, stage, at) };
}

export type LeadPlace = { stageId: string | null; pipelineId: string | null };

/**
 * Each of these leads' stage and pipeline, by lead id — read on their own, by name, so a list query
 * needn't know about the columns. Empty where the workspace has no stages yet.
 */
export async function placesOf(leadIds: string[]): Promise<Map<string, LeadPlace>> {
  if (leadIds.length === 0) return new Map();
  try {
    const rows = await db.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, stageId: true, pipelineId: true } });
    return new Map(rows.map((r) => [r.id, { stageId: r.stageId, pipelineId: r.pipelineId }]));
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  try {
    const rows = await db.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, stageId: true } });
    return new Map(rows.map((r) => [r.id, { stageId: r.stageId, pipelineId: null }]));
  } catch (err) {
    if (notMigratedYet(err)) return new Map();
    throw err;
  }
}

/** Each of these leads' stage ids, by lead id (`placesOf`). */
export async function stageIdsOf(leadIds: string[]): Promise<Map<string, string | null>> {
  return new Map([...(await placesOf(leadIds))].map(([id, place]) => [id, place.stageId]));
}

/** The stage each of these leads shows, by lead id — for a list, a board or a company's leads. */
export async function stagesOfLeads(leads: { id: string; status: LeadStatus }[]): Promise<Map<string, LeadStageDef>> {
  const [{ stages }, places] = await Promise.all([leadStages(), placesOf(leads.map((l) => l.id))]);
  return new Map(leads.map((l) => [l.id, stageOfLead(stages, { status: l.status, ...(places.get(l.id) ?? {}) })]));
}

/** The pipeline each of these leads is in, by lead id — the main one for a lead written before there were several. */
export async function pipelinesOfLeads(leads: { id: string; status: LeadStatus }[]): Promise<Map<string, PipelineDef>> {
  const [pipeline, stages] = await Promise.all([leadStages(), stagesOfLeads(leads)]);
  return new Map(leads.map((l) => [l.id, pipelineById(pipeline.pipelines, stages.get(l.id)?.pipelineId)]));
}

/**
 * Runs a lead query dated by when leads last moved stage (`stageChangedAt`) — what "won in September",
 * "lost ninety days ago" and "no movement for three weeks" mean. Never by `updatedAt`: every view of a
 * lead moves that, because its score is rewritten, and so does the periodic tick. In a workspace still
 * waiting for the migration the column isn't there, and the query runs once more on `updatedAt`, as it
 * always did.
 */
export async function byStageDate<T>(query: (moved: (range: Prisma.DateTimeFilter<"Lead">) => Prisma.LeadWhereInput) => Promise<T>): Promise<T> {
  try {
    return await query((range) => ({ stageChangedAt: range }));
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    return query((range) => ({ updatedAt: range }));
  }
}

/**
 * A `where` for the leads shown in this stage: those placed in it, and — when it is the main pipeline's
 * first stage with its meaning — those with that status and no stage at all (written before the workspace
 * had stages, so in the main pipeline).
 */
export function inStageWhere(pipeline: Pipeline, stage: LeadStageDef): Prisma.LeadWhereInput {
  if (!pipeline.stored) return { status: stage.status };
  // The status too: a lead shows the stage its status means (`stageOfLead`), so it is counted there.
  const placed = { stageId: stage.id, status: stage.status };
  const first = stage.pipelineId === MAIN_PIPELINE_ID && stageForStatus(pipeline.stages, stage.status)?.id === stage.id;
  return first ? { OR: [placed, { stageId: null, status: stage.status }] } : placed;
}

/** A `where` for the leads in a pipeline. The main one holds every lead written without a pipeline. */
export function inPipelineWhere(pipeline: Pipeline, pipelineId: string): Prisma.LeadWhereInput {
  if (!pipeline.multi) return pipelineId === MAIN_PIPELINE_ID ? {} : { id: { in: [] } };
  return pipelineId === MAIN_PIPELINE_ID ? { OR: [{ pipelineId: null }, { pipelineId: MAIN_PIPELINE_ID }] } : { pipelineId };
}

/**
 * A `where` for the leads that are sales — in a pipeline that counts as sales. What targets, wins,
 * incentives, the forecast and the dashboard's pipeline value read: a partner-onboarding record finished
 * is not a deal won. Nothing at all while every pipeline counts as sales, which is every workspace that
 * has only the main one, or is still waiting for the migration.
 */
export function salesLeadWhere(pipeline: Pipeline): Prisma.LeadWhereInput {
  if (!pipeline.multi || pipeline.pipelines.every((p) => p.sales)) return {};
  return { OR: [{ pipelineId: null }, { pipelineId: { in: pipeline.pipelines.filter((p) => p.sales).map((p) => p.id) } }] };
}

/** `salesLeadWhere` for this workspace, read once per request. */
export const salesLeads = cache(async (): Promise<Prisma.LeadWhereInput> => salesLeadWhere(await leadStages()));

/**
 * `salesLeads` for a query on rows that belong to a lead — the stage changes the wins and performance
 * read: a filter on their lead, or nothing at all (never an empty relation filter, which matches
 * nothing in some places).
 */
export async function salesLeadRelation(): Promise<{ lead?: { is: Prisma.LeadWhereInput } }> {
  const sales = await salesLeads();
  return Object.keys(sales).length ? { lead: { is: sales } } : {};
}
