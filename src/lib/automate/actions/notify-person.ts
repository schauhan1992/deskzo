import { z } from "zod";
import { db } from "@/lib/db";
import { notifyUser } from "@/lib/notify";
import { leadPath, ticketPath } from "@/lib/record-links";
import { ActionError, defineAction } from "@/lib/automate/action-types";
import { withEffect } from "@/lib/automate/effects";
import { notReached, reach } from "@/lib/automate/actions/shared";

/**
 * Tell a person something, in the bell (Deskzo Automate). Their notification preferences apply, as for
 * anything else. Recorded before it is sent: a retried step tells nobody twice — at worst, after a
 * crash between the two, once less.
 *
 * About a lead or a ticket (one the workflow's owner reaches), it opens that record when clicked, and
 * "lead_owner" tells whoever owns the lead when the step runs — as a pipeline automation's notification did.
 */

const input = z
  .object({
    /** "owner" (the workflow's owner), "lead_owner" (the lead's owner now), or a person's id. */
    to: z.string().min(1).max(40).default("owner"),
    title: z.string().trim().min(1, "Say what the notification is about.").max(120),
    message: z.string().max(300).optional(),
    /** A page in the app to open, such as "/tasks". The lead's or ticket's page when it is about one. */
    link: z
      .string()
      .regex(/^\/(?!\/)[^\s]*$/, "A link is a page in the app, starting with /.")
      .max(300)
      .optional(),
    leadId: z.string().trim().min(1).max(60).optional(),
    ticketId: z.string().trim().min(1).max(60).optional(),
  })
  .strict()
  .refine((i) => i.to !== "lead_owner" || !!i.leadId, { message: "Say which lead, to tell its owner.", path: ["leadId"] });

export const notifyPerson = defineAction({
  key: "notify.person",
  label: "Notify a person",
  description: "Sends a notification to the workflow's owner, a lead's owner or another person.",
  module: "notifications",
  permission: null,
  risk: "change",
  input,
  outputs: ["userId"],
  preview: (i) => `Would notify ${i.to === "owner" ? "the workflow's owner" : i.to === "lead_owner" ? "the lead's owner" : "a person"}: "${i.title}".`,
  async run(ctx, i) {
    let link = i.link;
    let leadOwner: string | null = null;
    if (i.leadId) {
      await reach(ctx, "leads", "view", i.leadId, "lead");
      const lead = await db.lead.findUnique({ where: { id: i.leadId }, select: { leadSeq: true, ownerUserId: true } });
      if (!lead) throw notReached("lead");
      link ??= leadPath(lead.leadSeq);
      leadOwner = lead.ownerUserId;
    }
    if (i.ticketId) {
      await reach(ctx, "tickets", "view", i.ticketId, "ticket");
      const ticket = await db.ticket.findUnique({ where: { id: i.ticketId }, select: { ticketSeq: true } });
      if (!ticket) throw notReached("ticket");
      link ??= ticketPath(ticket.ticketSeq);
    }
    const userId = i.to === "owner" ? ctx.actorId : i.to === "lead_owner" ? leadOwner : i.to;
    if (!userId) throw new ActionError("No notification: the lead has no owner.", "PERMANENT");
    const person = await db.user.findUnique({ where: { id: userId }, select: { active: true } });
    if (!person?.active) throw new ActionError("The person to notify isn't an active user.", "PERMANENT");
    const { output, fresh } = await withEffect(ctx, async () => ({ output: { userId }, recordType: "user", recordId: userId }));
    if (fresh) await notifyUser({ userId, type: "WORKFLOW_MESSAGE", title: i.title, message: i.message, link });
    return output;
  },
});
