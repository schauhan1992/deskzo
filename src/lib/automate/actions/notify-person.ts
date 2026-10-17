import { z } from "zod";
import { db } from "@/lib/db";
import { notifyUser } from "@/lib/notify";
import { ActionError, defineAction } from "@/lib/automate/action-types";
import { withEffect } from "@/lib/automate/effects";

/**
 * Tell a person something, in the bell (Deskzo Automate, Phase 1). Their notification preferences
 * apply, as for anything else. Recorded before it is sent: a retried step tells nobody twice — at
 * worst, after a crash between the two, once less.
 */

const input = z
  .object({
    /** "owner" (the workflow's owner), or a person's id. */
    to: z.string().min(1).max(40).default("owner"),
    title: z.string().trim().min(1, "Say what the notification is about.").max(120),
    message: z.string().max(300).optional(),
    /** A page in the app to open, such as "/tasks". */
    link: z
      .string()
      .regex(/^\/(?!\/)[^\s]*$/, "A link is a page in the app, starting with /.")
      .max(300)
      .optional(),
  })
  .strict();

export const notifyPerson = defineAction({
  key: "notify.person",
  label: "Notify a person",
  description: "Sends a notification to the workflow's owner or another person.",
  module: "notifications",
  permission: null,
  risk: "change",
  input,
  preview: (i) => `Would notify ${i.to === "owner" ? "the workflow's owner" : "a person"}: "${i.title}".`,
  async run(ctx, i) {
    const userId = i.to === "owner" ? ctx.actorId : i.to;
    const person = await db.user.findUnique({ where: { id: userId }, select: { active: true } });
    if (!person?.active) throw new ActionError("The person to notify isn't an active user.", "PERMANENT");
    const { output, fresh } = await withEffect(ctx, async () => ({ output: { userId }, recordType: "user", recordId: userId }));
    if (fresh) await notifyUser({ userId, type: "WORKFLOW_MESSAGE", title: i.title, message: i.message, link: i.link });
    return output;
  },
});
