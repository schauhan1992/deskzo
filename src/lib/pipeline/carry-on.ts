import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { notMigratedYet } from "@/lib/custom-fields/server";
import { leadPath } from "@/lib/record-links";
import { refreshLeadScore } from "@/lib/leads/score-store";
import { emitLeadCreated } from "@/lib/automate/emit-leads";
import { leadStages, newLeadStage } from "@/lib/pipeline/server";
import { pipelineById } from "@/lib/pipeline/rules";

/**
 * Connected pipelines (owner, 14 Oct 2026 — Bigin's "connected pipelines"): a lead won in a pipeline that
 * carries its won leads on starts again, as a new lead, at the first stage of the next one — a deal won
 * in Sales arriving in Onboarding, say. The new lead keeps the company, contact, owner, value, title and
 * the workspace's own fields, and names the lead it came from (`fromLeadId`); the won lead keeps its
 * history and a note saying where it went.
 *
 * Once per won lead and pipeline: a lead won, reopened and won again finds the one it already made. Never
 * throws — the win is saved whatever happens here.
 */
export async function carryOnWonLead(leadId: string, actorId: string): Promise<{ id: string; leadSeq: number } | null> {
  try {
    return await carryOn(leadId, actorId);
  } catch (err) {
    if (!notMigratedYet(err)) console.error(`[pipeline] lead ${leadId} could not be carried on`, err);
    return null;
  }
}

async function carryOn(leadId: string, actorId: string) {
  const pipeline = await leadStages();
  if (!pipeline.multi) return null;
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: {
      id: true,
      leadSeq: true,
      status: true,
      pipelineId: true,
      title: true,
      description: true,
      companyId: true,
      contactId: true,
      ownerUserId: true,
      sourcedByUserId: true,
      estimatedValue: true,
      expectedCloseDate: true,
      source: true,
      sourceDetail: true,
      customFields: true,
    },
  });
  if (!lead || lead.status !== "WON") return null;
  const from = pipelineById(pipeline.pipelines, lead.pipelineId);
  const next = from.nextPipelineId ? pipeline.pipelines.find((p) => p.id === from.nextPipelineId && !p.archived) : undefined;
  if (!next) return null;

  const already = await db.lead.findFirst({ where: { fromLeadId: lead.id, pipelineId: next.id }, select: { id: true, leadSeq: true } });
  if (already) return already;

  const owner = lead.ownerUserId ? await db.user.findUnique({ where: { id: lead.ownerUserId }, select: { active: true } }) : null;
  const entry = await newLeadStage(new Date(), next.id);
  const made = await db.$transaction(async (tx) => {
    const created = await tx.lead.create({
      data: {
        ...entry,
        companyId: lead.companyId,
        contactId: lead.contactId,
        title: lead.title,
        description: lead.description,
        estimatedValue: lead.estimatedValue,
        expectedCloseDate: lead.expectedCloseDate,
        ownerUserId: owner?.active ? lead.ownerUserId : null,
        sourcedByUserId: lead.sourcedByUserId,
        createdByUserId: actorId,
        source: lead.source,
        sourceDetail: lead.sourceDetail,
        customFields: lead.customFields ?? {},
        fromLeadId: lead.id,
        assignmentNote: `Carried on from ${from.name} when it was won`,
      },
      select: { id: true, leadSeq: true },
    });
    await tx.activity.create({ data: { leadId: lead.id, userId: actorId, type: "NOTE", notes: `Carried on into ${next.name} as lead #${created.leadSeq}.` } });
    await emitLeadCreated(tx, created.id, actorId, "carried-on");
    return created;
  });

  await recordAudit({ userId: actorId, action: "CREATE", entityType: "Lead", entityId: made.id, entityLabel: `${lead.title} — carried on from ${from.name} into ${next.name}` });
  if (owner?.active && lead.ownerUserId && lead.ownerUserId !== actorId) {
    await notifyUser({ userId: lead.ownerUserId, type: "LEAD_ASSIGNED", title: `Carried on into ${next.name}`, message: lead.title, link: leadPath(made.leadSeq) });
  }
  await refreshLeadScore(made.id);
  return made;
}
