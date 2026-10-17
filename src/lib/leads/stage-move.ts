import type { Lead, LeadStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { definitionsFor, notMigratedYet } from "@/lib/custom-fields/server";
import { leadStages, stageWrite, stagesOfLeads, type Pipeline } from "@/lib/pipeline/server";
import { missingForStage, pipelineById, ruleFieldLabel, ruleRefusal, stageChangeNote, stageForStatus, type LeadStageDef } from "@/lib/pipeline/rules";
import { runLeadAutomations } from "@/lib/pipeline/automations";
import { carryOnWonLead } from "@/lib/pipeline/carry-on";
import { emitLeadMoved } from "@/lib/automate/emit-leads";
import type { EventCause } from "@/lib/automate/action-types";
import { refreshLeadScore } from "@/lib/leads/score-store";
import { detectSalesWins } from "@/lib/wins/detect";
import { leadPath } from "@/lib/record-links";

/**
 * Moving a lead to a stage of its pipeline — the one way it is done, by a person on the board or the
 * list (`updateLeadStatus`, src/actions/lead.ts) or by a workflow's step (src/lib/automate/actions).
 * Who may move which lead is the caller's question; this is what a move is, in three parts:
 *
 *   · `planStageMove` — where to, and whether the stage's rule lets it in. Reads only.
 *   · `writeStageMove` — the change, inside the caller's transaction: the stage, the stage-change note
 *     the forecast and wins read, the customer a sales win makes, and the event for workflows.
 *   · `afterStageMove` — what follows once it is saved: the owner told, the audit, the score, wins,
 *     connected pipelines and the stage's own automations.
 */

export type StageMoveRequest = { leadId: string; stageId?: string | null; status?: LeadStatus | null; lostReason?: string | null };

export type StageMove = {
  lead: Lead;
  from: LeadStageDef;
  target: LeadStageDef;
  status: LeadStatus;
  lostReason: string | null;
  pipeline: Pipeline;
  /** Into another stage, rather than a lost lead given a new reason. */
  moves: boolean;
  /** Won now, and wasn't before. */
  won: boolean;
  /** Its pipeline counts as sales: a win there is a sale. */
  sales: boolean;
};

/** A lead's own fields, read by name — none in a workspace still waiting for the column. */
async function leadCustomFields(leadId: string): Promise<unknown> {
  try {
    return (await db.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields ?? {};
  } catch (err) {
    if (notMigratedYet(err)) return {};
    throw err;
  }
}

/**
 * Why a lead can't move into this stage under its rule (Settings → Pipeline), in words — or null. The
 * rule asks for fields before the lead moves there: a value and a close date before "Proposal sent".
 */
export async function ruleStops(
  target: { label: string; requiredFields: string[] },
  lead: { id: string; estimatedValue: unknown; expectedCloseDate: unknown; contactId: string | null; ownerUserId: string | null; description: string | null },
): Promise<string | null> {
  if (target.requiredFields.length === 0) return null;
  const missing = missingForStage(target, { ...lead, customFields: await leadCustomFields(lead.id) });
  if (missing.length === 0) return null;
  const labels = new Map((await definitionsFor("LEAD")).map((d) => [d.key, d.label]));
  return ruleRefusal(target.label, missing.map((k) => ruleFieldLabel(k, labels)));
}

/**
 * Where the lead would go, or why it can't. `move` null: it is there already, and nothing is recorded —
 * a bulk change used to log "from WON to WON" — unless it is a lost lead being given a new reason.
 */
export async function planStageMove(request: StageMoveRequest): Promise<{ ok: true; move: StageMove | null } | { ok: false; error: string }> {
  const { leadId, stageId, status: named } = request;
  const lead = await db.lead.findUnique({ where: { id: leadId } });
  if (!lead) return { ok: false, error: "Lead not found." };
  // Where it is now, as the board shows it — which says which pipeline it is in.
  const from = (await stagesOfLeads([{ id: leadId, status: lead.status }])).get(leadId)!;

  // The stage it moves to, in its own pipeline (Settings → Pipeline, src/lib/pipeline) — or, from a caller
  // that still names a status, that pipeline's first stage in use with that meaning. Its status is always
  // the stage's meaning. Another pipeline's stage is a move between pipelines, which is its own action.
  const pipeline = await leadStages();
  const inUse = pipeline.stages.filter((s) => !s.archived && s.pipelineId === from.pipelineId);
  const target = stageId ? inUse.find((s) => s.id === stageId) : named ? stageForStatus(inUse, named, from.pipelineId) : null;
  if (!target) {
    const elsewhere = stageId ? pipeline.stages.find((s) => s.id === stageId && !s.archived) : undefined;
    return {
      ok: false,
      error: elsewhere
        ? `${elsewhere.label} is a stage of ${pipelineById(pipeline.pipelines, elsewhere.pipelineId).name}. Move the lead to that pipeline first.`
        : "That stage is no longer in use. Refresh the page and choose another.",
    };
  }
  const status = target.status;
  const lostReason = request.lostReason?.trim() || null;
  if ((status === "LOST" || status === "DISQUALIFIED") && !lostReason) {
    return { ok: false, error: "A reason is required when marking a lead lost or disqualified." };
  }
  if (from.id === target.id && lead.status === status && !(lostReason && lostReason !== lead.lostReason)) return { ok: true, move: null };

  const moves = from.id !== target.id;
  if (moves) {
    const stop = await ruleStops(target, lead);
    if (stop) return { ok: false, error: stop };
  }
  return {
    ok: true,
    move: {
      lead,
      from,
      target,
      status,
      lostReason,
      pipeline,
      moves,
      won: status === "WON" && lead.status !== "WON",
      // A win is a sale only in a pipeline that counts as sales; a partner onboarding finished is not one.
      sales: pipelineById(pipeline.pipelines, target.pipelineId).sales,
    },
  };
}

/** The move itself, in the caller's transaction. `cause` when a workflow's step made it. */
export async function writeStageMove(tx: Prisma.TransactionClient, move: StageMove, actorId: string, cause: EventCause | null = null): Promise<void> {
  const { lead, from, target, status, lostReason } = move;
  await tx.lead.update({
    where: { id: lead.id },
    data: {
      status,
      ...stageWrite(move.pipeline, target, new Date()),
      lostReason: status === "LOST" || status === "DISQUALIFIED" ? lostReason : null,
      qualifiedByUserId: status === "QUALIFIED" && !lead.qualifiedByUserId ? actorId : lead.qualifiedByUserId,
    },
  });
  await tx.activity.create({
    data: {
      leadId: lead.id,
      userId: actorId,
      type: "STAGE_CHANGE",
      // The forecast and wins read this note; the timeline shows it in the stages' names (`readStageNote`).
      notes: stageChangeNote(from, target, lostReason),
    },
  });
  if (status === "WON" && move.sales) await tx.company.update({ where: { id: lead.companyId }, data: { stage: "CUSTOMER" } });
  await emitLeadMoved(tx, lead.id, actorId, { stageId: from.id, status: lead.status, pipelineId: from.pipelineId }, { stageId: target.id, status, pipelineId: target.pipelineId }, cause);
}

/** What follows a saved move. `byline` is added to the audit entry: "by workflow …". */
export async function afterStageMove(move: StageMove, actorId: string, byline: string | null = null): Promise<void> {
  const { lead, target } = move;
  if (lead.ownerUserId && lead.ownerUserId !== actorId) {
    await notifyUser({
      userId: lead.ownerUserId,
      type: "LEAD_STATUS_CHANGED",
      title: "Your lead's status changed",
      message: `${lead.title} — now ${target.label}`,
      link: leadPath(lead.leadSeq),
    });
  }
  await recordAudit({ userId: actorId, action: "UPDATE", entityType: "Lead", entityId: lead.id, entityLabel: byline ? `${lead.title} — ${byline}` : lead.title });
  await refreshLeadScore(lead.id);
  // A deal just won may be one to celebrate, and may have taken somebody past their target. Now,
  // rather than at the next tick, so the room hears about it while it is news.
  if (move.status === "WON" && move.sales) await detectSalesWins().catch((err) => console.error("sales wins could not be detected", err));
  // Connected pipelines: a lead won here may start again in the next one (src/lib/pipeline/carry-on.ts).
  if (move.won) await carryOnWonLead(lead.id, actorId);
  // The stage's automations (Settings → Pipeline → Automations).
  if (move.moves) await runLeadAutomations({ leadId: lead.id, trigger: "STAGE_ENTERED", pipelineId: target.pipelineId, stageId: target.id });
}
