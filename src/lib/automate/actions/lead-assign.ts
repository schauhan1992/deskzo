import { z } from "zod";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { mayChangeLeadOwner } from "@/lib/authz/reassign-rules";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { chooseOwner, signalsForLead } from "@/lib/leads/assign";
import { leadPath } from "@/lib/record-links";
import { ActionError, defineAction } from "@/lib/automate/action-types";
import { priorOutput, withEffect } from "@/lib/automate/effects";
import { activePerson, byWorkflow, notReached, personField, reach, recordIdField } from "@/lib/automate/actions/shared";

/**
 * Give a lead to somebody (Deskzo Automate, Phase 2): a named person, the workflow's owner, or whoever
 * the assignment rules choose (Settings → Lead assignment), as a pipeline automation's "Assign" step
 * does. Under the same rules as the list's bulk "Change owner": the owner may hand on what they can
 * reach for assigning, and only their own leads when they hold `accounts.handOffOwn` alone.
 *
 * The output's `ownerUserId` is who has it now, for the steps after: `{{steps.<id>.output.ownerUserId}}`.
 */

type Output = { leadId: string; ownerUserId: string; changed: boolean };

const input = z
  .object({
    leadId: recordIdField("lead"),
    /** "rules" (the assignment rules), "owner" (the workflow's owner), or a person's id. */
    to: personField.default("rules"),
  })
  .strict();

export const leadAssign = defineAction({
  key: "lead.assign",
  label: "Assign a lead",
  description: "Gives a lead to a person, or to whoever the assignment rules choose.",
  module: "leads",
  permission: null,
  risk: "change",
  input,
  preview: (i) => `Would give the lead to ${i.to === "rules" ? "whoever the assignment rules choose" : i.to === "owner" ? "the workflow's owner" : "a person"}.`,
  async run(ctx, i): Promise<Output> {
    const done = await priorOutput<Output>(ctx);
    if (done) return done.output;

    await reach(ctx, "leads", "assign", i.leadId, "lead");
    const lead = await db.lead.findUnique({ where: { id: i.leadId }, select: { id: true, leadSeq: true, title: true, ownerUserId: true } });
    if (!lead) throw notReached("lead");
    const rights = { any: await can(ctx.actorId, "accounts.reassign"), own: await can(ctx.actorId, "accounts.handOffOwn") };
    if (!mayChangeLeadOwner(rights, ctx.actorId, lead)) throw new ActionError("The workflow's owner may not hand this lead on.", "PERMANENT");

    let to: string;
    let note: string;
    if (i.to === "rules") {
      const signals = await signalsForLead(lead.id);
      const chosen = signals ? await chooseOwner(signals) : null;
      if (!chosen) throw new ActionError("No assignment rule matched this lead, so nobody was given it.", "PERMANENT");
      to = chosen.userId;
      note = `${byWorkflow(ctx)} — ${chosen.note}`;
    } else {
      to = (await activePerson(ctx, i.to, "person to give the lead to")).id;
      note = `Assigned ${byWorkflow(ctx)}`;
    }
    if (to === lead.ownerUserId) return { leadId: lead.id, ownerUserId: to, changed: false };

    const { output, fresh } = await withEffect(ctx, async (tx) => {
      await tx.lead.update({ where: { id: lead.id }, data: { ownerUserId: to, assignmentNote: note.slice(0, 300) } });
      return { output: { leadId: lead.id, ownerUserId: to, changed: true }, recordType: "lead", recordId: lead.id };
    });
    if (fresh) {
      await recordAudit({ userId: ctx.actorId, action: "UPDATE", entityType: "Lead", entityId: lead.id, entityLabel: `${lead.title} — owner changed ${byWorkflow(ctx)}` });
      if (to !== ctx.actorId) await notifyUser({ userId: to, type: "LEAD_ASSIGNED", title: "A lead was assigned to you", message: lead.title, link: leadPath(lead.leadSeq) });
    }
    return output;
  },
});
