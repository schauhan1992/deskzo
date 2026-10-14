import type { PipelineTrigger } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { automationUserId } from "@/lib/automation-user";
import { notMigratedYet } from "@/lib/custom-fields/server";
import { chooseOwner, signalsForLead } from "@/lib/leads/assign";
import { sendAsUser } from "@/lib/mail/mailbox";
import { leadPath } from "@/lib/record-links";
import { workspaceClock } from "@/lib/time/workspace";
import { calendarDayRange } from "@/lib/time/zone";
import { leadStages, stagesOfLeads } from "@/lib/pipeline/server";
import { pipelineById } from "@/lib/pipeline/rules";
import { OWNER, RULES, mergeText, storedActions, textToHtml, type AutomationAction, type MergeValues } from "@/lib/pipeline/automation-rules";

/**
 * Runs a pipeline's automations for what just happened to a lead (src/lib/pipeline/automation-rules.ts
 * says what they may do). Called after the change is saved — a lead created, or moved into a stage — and
 * never throws: an automation that can't do something leaves the change as it is, says what went wrong
 * on the automation (`lastError`, shown in Settings → Pipeline), and carries on with its next step.
 *
 * Done as the Automation account (src/lib/automation-user.ts): it creates the task and is named on the
 * audit. An email goes from the lead owner's own mailbox, because it is to their customer and the reply
 * should come to them. Nothing an automation does moves a lead between stages, so one never starts another.
 */

const DAY = 86_400_000;

export type LeadEvent = { leadId: string; trigger: PipelineTrigger; pipelineId: string; stageId?: string | null };

export async function runLeadAutomations(event: LeadEvent): Promise<{ ran: number; failed: number }> {
  try {
    return await run(event);
  } catch (err) {
    if (!notMigratedYet(err)) console.error(`[automations] lead ${event.leadId}: could not run`, err);
    return { ran: 0, failed: 0 };
  }
}

async function run(event: LeadEvent): Promise<{ ran: number; failed: number }> {
  const automations = await db.pipelineAutomation.findMany({
    where: { pipelineId: event.pipelineId, trigger: event.trigger, active: true, ...(event.trigger === "STAGE_ENTERED" ? { stageId: event.stageId ?? "-" } : {}) },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, actions: true },
  });
  if (automations.length === 0) return { ran: 0, failed: 0 };

  const actor = await automationUserId();
  let failed = 0;
  for (const automation of automations) {
    const errors: string[] = [];
    for (const action of storedActions(automation.actions)) {
      try {
        const problem = await perform(action, event, automation.name, actor);
        if (problem) errors.push(problem);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (errors.length) failed += 1;
    await db.pipelineAutomation.update({
      where: { id: automation.id },
      data: { runs: { increment: 1 }, lastRunAt: new Date(), lastError: errors.length ? errors.join(" · ").slice(0, 1000) : null },
    });
  }
  return { ran: automations.length, failed };
}

/** What the lead looks like now — read afresh for each action, so an ASSIGN step is seen by the steps after it. */
async function leadNow(leadId: string) {
  return db.lead.findUnique({
    where: { id: leadId },
    select: {
      id: true,
      leadSeq: true,
      title: true,
      status: true,
      estimatedValue: true,
      companyId: true,
      ownerUserId: true,
      company: { select: { name: true } },
      contact: { select: { name: true, email: true } },
      owner: { select: { name: true, active: true } },
    },
  });
}

async function mergeValuesFor(lead: NonNullable<Awaited<ReturnType<typeof leadNow>>>, event: LeadEvent): Promise<MergeValues> {
  const [pipeline, stages] = await Promise.all([leadStages(), stagesOfLeads([{ id: lead.id, status: lead.status }])]);
  return {
    lead: lead.title,
    company: lead.company.name,
    contact: lead.contact?.name ?? "",
    owner: lead.owner?.name ?? "",
    stage: stages.get(lead.id)?.label ?? "",
    pipeline: pipelineById(pipeline.pipelines, event.pipelineId).name,
    value: lead.estimatedValue ? Number(lead.estimatedValue).toLocaleString("en-IN") : "",
  };
}

/** Who "the owner" or a named person is — someone active, or null. */
async function personFor(who: string, ownerUserId: string | null): Promise<string | null> {
  const id = who === OWNER ? ownerUserId : who;
  if (!id) return null;
  const user = await db.user.findUnique({ where: { id }, select: { active: true } });
  return user?.active ? id : null;
}

/** Does one action; returns what stopped it, in words, or null when it was done. */
async function perform(action: AutomationAction, event: LeadEvent, name: string, actor: string): Promise<string | null> {
  const lead = await leadNow(event.leadId);
  if (!lead) return "The lead was deleted.";
  const values = await mergeValuesFor(lead, event);

  switch (action.type) {
    case "TASK": {
      const assignee = await personFor(action.assignTo, lead.ownerUserId);
      if (!assignee) return action.assignTo === OWNER ? "No task: the lead has no owner." : "No task: that person can no longer be given tasks.";
      // A due date is a calendar day, held as UTC midnight of the day (as src/actions/task.ts keeps it).
      const clock = await workspaceClock();
      const day = clock.dateKey(new Date(Date.now() + action.dueInDays * DAY));
      const title = mergeText(action.title, values).slice(0, 200);
      await db.task.create({
        data: { title, dueDate: calendarDayRange(day, null)?.gte ?? null, assignedToUserId: assignee, createdByUserId: actor, companyId: lead.companyId, leadId: lead.id },
      });
      if (assignee !== actor) {
        await notifyUser({ userId: assignee, type: "TASK_ASSIGNED", title: "A task was made for you", message: `${title} — ${lead.title}`, link: leadPath(lead.leadSeq) });
      }
      return null;
    }
    case "EMAIL": {
      if (!lead.contact?.email) return "No email: the lead's contact has no email address.";
      if (!lead.ownerUserId || !lead.owner?.active) return "No email: the lead has no owner to send it from.";
      const subject = mergeText(action.subject, values);
      const sent = await sendAsUser(lead.ownerUserId, { subject, html: textToHtml(mergeText(action.body, values)), to: [{ name: lead.contact.name, email: lead.contact.email }], attachments: [] });
      if (!sent.ok) return `No email: ${sent.error}`;
      await db.activity.create({ data: { leadId: lead.id, userId: lead.ownerUserId, type: "EMAIL", notes: `Sent automatically (${name}): ${subject}` } });
      return null;
    }
    case "ASSIGN": {
      let to: string | null = null;
      let note = `Automation: ${name}`;
      if (action.userId === RULES) {
        const signals = await signalsForLead(lead.id);
        const chosen = signals ? await chooseOwner(signals) : null;
        if (!chosen) return "Not given to anyone: no assignment rule matched.";
        to = chosen.userId;
        note = `${note} — ${chosen.note}`;
      } else {
        to = await personFor(action.userId, null);
        if (!to) return "Not given to anyone: that person can no longer take leads.";
      }
      if (to === lead.ownerUserId) return null;
      await db.lead.update({ where: { id: lead.id }, data: { ownerUserId: to, assignmentNote: note.slice(0, 300) } });
      await recordAudit({ userId: actor, action: "UPDATE", entityType: "Lead", entityId: lead.id, entityLabel: `${lead.title} — owner changed by automation ${name}` });
      await notifyUser({ userId: to, type: "LEAD_ASSIGNED", title: "A lead was assigned to you", message: lead.title, link: leadPath(lead.leadSeq) });
      return null;
    }
    case "NOTIFY": {
      const to = await personFor(action.to, lead.ownerUserId);
      if (!to) return action.to === OWNER ? "No notification: the lead has no owner." : "No notification: that person is no longer active.";
      await notifyUser({ userId: to, type: "LEAD_ACTIVITY", title: name, message: mergeText(action.message, values), link: leadPath(lead.leadSeq) });
      return null;
    }
  }
}
