import { z } from "zod";
import { db } from "@/lib/db";
import { notifyUser } from "@/lib/notify";
import { refreshLeadScore } from "@/lib/leads/score-store";
import { leadPath } from "@/lib/record-links";
import { defineAction } from "@/lib/automate/action-types";
import { withEffect } from "@/lib/automate/effects";
import { notReached, reach, recordIdField } from "@/lib/automate/actions/shared";

/**
 * Add a note, call, email or meeting to a lead's timeline (Deskzo Automate, Phase 2), as the workflow's
 * owner — the "Log activity" box on the lead's page, with its rules: a lead they may change, and its
 * owner told when it isn't them.
 */

const input = z
  .object({
    leadId: recordIdField("lead"),
    note: z.string().trim().min(1, "Write the note.").max(2000),
    type: z.enum(["NOTE", "CALL", "EMAIL", "MEETING"]).default("NOTE"),
  })
  .strict();

export const leadNote = defineAction({
  key: "lead.note",
  label: "Add a note to a lead",
  description: "Adds a note, call, email or meeting to a lead's timeline.",
  module: "leads",
  permission: null,
  risk: "change",
  input,
  preview: (i) => `Would add a ${i.type.toLowerCase()} to the lead's timeline: "${i.note.slice(0, 80)}".`,
  async run(ctx, i) {
    await reach(ctx, "leads", "edit", i.leadId, "lead");
    const lead = await db.lead.findUnique({ where: { id: i.leadId }, select: { id: true, leadSeq: true, title: true, ownerUserId: true } });
    if (!lead) throw notReached("lead");

    const { output, fresh } = await withEffect(ctx, async (tx) => {
      const activity = await tx.activity.create({ data: { leadId: lead.id, userId: ctx.actorId, type: i.type, notes: i.note }, select: { id: true } });
      return { output: { activityId: activity.id, leadId: lead.id }, recordType: "lead", recordId: lead.id };
    });
    if (fresh) {
      if (lead.ownerUserId && lead.ownerUserId !== ctx.actorId) {
        await notifyUser({ userId: lead.ownerUserId, type: "LEAD_ACTIVITY", title: "New activity on your lead", message: `${lead.title} — ${i.note}`.slice(0, 300), link: leadPath(lead.leadSeq) });
      }
      await refreshLeadScore(lead.id);
    }
    return output;
  },
});
