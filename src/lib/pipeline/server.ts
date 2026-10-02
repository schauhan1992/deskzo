import { cache } from "react";
import type { LeadStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/custom-fields/server";
import { defaultStages, isStageColor, stageForStatus, stageOfLead, type LeadStageDef } from "@/lib/pipeline/rules";

/**
 * The workspace's lead pipeline, read from its database (src/lib/pipeline/rules.ts has the rules).
 *
 * Fails soft while a workspace waits for the migration that brought stages
 * (20261015100000_lead_pipeline): it is shown the stages every workspace starts with, under the ids the
 * migration will give them, and `stored` says so — a lead is then written with its status alone, as
 * before, and the migration gives it its stage when it runs. `Lead.stageId` and `stageChangedAt` are left
 * out of select-less reads until every workspace has them (NOT_YET_EVERYWHERE in
 * src/lib/tenancy/clients.ts), so they are only ever read by name, through here.
 */

export type Pipeline = { stages: LeadStageDef[]; stored: boolean };

/** The stages in their order, retired ones included. Once per request. */
export const leadStages = cache(async (): Promise<Pipeline> => {
  try {
    const rows = await db.leadStage.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
    if (rows.length === 0) return { stages: defaultStages(), stored: false };
    return {
      stored: true,
      stages: rows.map((r) => ({
        id: r.id,
        key: r.key,
        label: r.label,
        status: r.status,
        color: isStageColor(r.color) ? r.color : "default",
        archived: r.archivedAt !== null,
      })),
    };
  } catch (err) {
    if (notMigratedYet(err)) return { stages: defaultStages(), stored: false };
    throw err;
  }
});

/** The stages still in use, in order — what a board shows as columns and a picker offers. */
export async function activeStages(): Promise<LeadStageDef[]> {
  return (await leadStages()).stages.filter((s) => !s.archived);
}

/**
 * What to write on a lead as it enters a stage: the stage and when, in a workspace that has stages;
 * nothing beyond the status in one still waiting for them.
 */
export function stageWrite(pipeline: Pipeline, stage: LeadStageDef, at: Date): { stageId?: string; stageChangedAt?: Date } {
  return pipeline.stored ? { stageId: stage.id, stageChangedAt: at } : {};
}

/**
 * Where a lead starts: the first stage that means "new". Every pipeline keeps one
 * (`REQUIRED_MEANINGS`), so this only falls back for a workspace whose stages were tampered with.
 */
export async function entryStage(): Promise<{ pipeline: Pipeline; stage: LeadStageDef }> {
  const pipeline = await leadStages();
  const stage = stageForStatus(pipeline.stages, "NEW") ?? defaultStages()[0]!;
  return { pipeline, stage };
}

/** `stageWrite` for a lead being created — the status every new lead has, and its stage. */
export async function newLeadStage(at = new Date()): Promise<{ status: LeadStatus; stageId?: string; stageChangedAt?: Date }> {
  const { pipeline, stage } = await entryStage();
  return { status: "NEW", ...stageWrite(pipeline, stage, at) };
}

/**
 * Each of these leads' stage ids, by lead id — read on their own, by name, so a list query needn't know
 * about the column. Empty where the workspace has no stages yet.
 */
export async function stageIdsOf(leadIds: string[]): Promise<Map<string, string | null>> {
  if (leadIds.length === 0) return new Map();
  try {
    const rows = await db.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, stageId: true } });
    return new Map(rows.map((r) => [r.id, r.stageId]));
  } catch (err) {
    if (notMigratedYet(err)) return new Map();
    throw err;
  }
}

/** The stage each of these leads shows, by lead id — for a list, a board or a company's leads. */
export async function stagesOfLeads(leads: { id: string; status: LeadStatus }[]): Promise<Map<string, LeadStageDef>> {
  const [{ stages }, ids] = await Promise.all([leadStages(), stageIdsOf(leads.map((l) => l.id))]);
  return new Map(leads.map((l) => [l.id, stageOfLead(stages, { status: l.status, stageId: ids.get(l.id) })]));
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
 * A `where` for the leads shown in this stage: those placed in it, and — when it is the first stage with
 * its meaning — those with that status and no stage at all (written before the workspace had stages).
 */
export function inStageWhere(pipeline: Pipeline, stage: LeadStageDef) {
  if (!pipeline.stored) return { status: stage.status };
  // The status too: a lead shows the stage its status means (`stageOfLead`), so it is counted there.
  const placed = { stageId: stage.id, status: stage.status };
  const first = stageForStatus(pipeline.stages, stage.status)?.id === stage.id;
  return first ? { OR: [placed, { stageId: null, status: stage.status }] } : placed;
}
