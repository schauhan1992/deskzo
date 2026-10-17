import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { notMigratedYet } from "@/lib/not-migrated";
import { leadStages } from "@/lib/pipeline/server";
import { pipelineById } from "@/lib/pipeline/rules";
import { OWNER, RULES, storedActions, type AutomationAction } from "@/lib/pipeline/automation-rules";
import type { Definition, Step } from "@/lib/automate/definition";
import { createWorkflow, publishWorkflow, setWorkflowStatus } from "@/lib/automate/store";
import { workflowPath } from "@/lib/automate/refs";

/**
 * Pipeline automations moving onto Automate (owner, 17 Oct 2026: converted automatically, once per
 * workspace). Each one becomes a workflow marked Migrated that does what it did:
 *
 *   · "When a lead arrives" — made in the pipeline, carried on into it or moved into it — is
 *     `lead.arrived` for that pipeline; "When a lead enters a stage" is `lead.stage_changed` into that
 *     stage from another one of the same pipeline (a lead moved in from another pipeline arrives
 *     instead, as before).
 *   · Its steps read the lead afresh first, and again after giving it to somebody — as the old runner
 *     read it before each action — so {{owner}} and "the lead's owner" are whoever has it by then.
 *   · A step that fails doesn't stop the rest (`onError: "continue"`), as before.
 *   · It runs as the person who made the automation, or the workspace's super admin if they have left;
 *     an automation that was off is moved but stays off.
 *
 * The old automation stays where it was, read-only, linked to its workflow (`migratedFrom`), so this
 * happens once however often it is asked — by the worker and the heartbeat at the start of every pass.
 */

/** The old merge tags, as fields of the lead read afresh. */
const TAG_FIELDS: Record<string, string> = { lead: "title", company: "company", contact: "contact", owner: "owner", stage: "stage", pipeline: "pipeline", value: "valueText" };

/** Text with the old {{tag}}s made references to the lead read last; an unknown tag stays as typed, as before. */
export function convertMergeText(text: string, leadStep: string): string {
  return text.replace(/\{\{\s*([a-z]+)\s*\}\}/g, (whole, tag: string) => (TAG_FIELDS[tag] ? `{{steps.${leadStep}.output.${TAG_FIELDS[tag]}}}` : whole.replace("{{", "{ {").replace("}}", "} }")));
}

export type OldAutomation = { name: string; trigger: "LEAD_CREATED" | "STAGE_ENTERED"; pipelineId: string; stageId: string | null; actions: AutomationAction[] };

/** What a pipeline automation becomes. Pure. */
export function definitionFromPipelineAutomation(old: OldAutomation): Definition {
  const lead = "{{trigger.lead.id}}";
  const trigger: Definition["trigger"] =
    old.trigger === "LEAD_CREATED"
      ? { type: "lead.arrived", filter: { all: [{ ref: "trigger.lead.pipelineId", op: "eq", value: old.pipelineId }] } }
      : {
          type: "lead.stage_changed",
          filter: {
            all: [
              { ref: "trigger.to.stageId", op: "eq", value: old.stageId ?? "" },
              { ref: "trigger.from.stageId", op: "ne", value: old.stageId ?? "" },
              { ref: "trigger.to.pipelineId", op: "eq", value: "{{trigger.from.pipelineId}}" },
            ],
          },
        };
  const steps: Step[] = [{ id: "lead", name: "Read the lead", type: "action", action: "lead.get", input: { leadId: lead } }];
  let current = "lead";
  old.actions.forEach((a, index) => {
    const n = index + 1;
    switch (a.type) {
      case "TASK":
        steps.push({
          id: `task${n}`,
          type: "action",
          action: "task.create",
          input: { title: convertMergeText(a.title, current), assignTo: a.assignTo === OWNER ? "lead_owner" : a.assignTo, dueInDays: a.dueInDays, leadId: lead },
        });
        break;
      case "EMAIL":
        steps.push({
          id: `email${n}`,
          type: "action",
          action: "email.send",
          input: { to: "lead_contact", leadId: lead, from: "lead_owner", subject: convertMergeText(a.subject, current), body: convertMergeText(a.body, current) },
        });
        break;
      case "ASSIGN":
        steps.push({ id: `assign${n}`, type: "action", action: "lead.assign", input: { leadId: lead, to: a.userId === RULES ? "rules" : a.userId } });
        // Read again, so the steps after see who has it now.
        current = `lead${n}`;
        steps.push({ id: current, name: "Read the lead again", type: "action", action: "lead.get", input: { leadId: lead } });
        break;
      case "NOTIFY":
        steps.push({
          id: `notify${n}`,
          type: "action",
          action: "notify.person",
          input: { to: a.to === OWNER ? "lead_owner" : a.to, title: old.name.slice(0, 120), message: convertMergeText(a.message, current), leadId: lead },
        });
        break;
    }
  });
  return { schema: 1, trigger, steps, settings: { onError: "continue" } };
}

export type ConversionOutcome = { converted: number; failed: number };

/**
 * Converts every pipeline automation not converted yet, in the workspace this runs as. Cheap when there
 * is nothing to do: one count. A workspace without the tables yet has nothing to convert.
 */
export async function convertPipelineAutomations(): Promise<ConversionOutcome> {
  const outcome: ConversionOutcome = { converted: 0, failed: 0 };
  let pending: { id: string; name: string; trigger: "LEAD_CREATED" | "STAGE_ENTERED"; pipelineId: string; stageId: string | null; actions: unknown; active: boolean; createdById: string }[];
  try {
    const done = await db.automationWorkflow.findMany({ where: { migratedFrom: { not: null } }, select: { migratedFrom: true } });
    pending = await db.pipelineAutomation.findMany({
      where: { id: { notIn: done.map((d) => d.migratedFrom!) } },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, trigger: true, pipelineId: true, stageId: true, actions: true, active: true, createdById: true },
    });
  } catch (err) {
    if (notMigratedYet(err)) return outcome;
    throw err;
  }
  if (pending.length === 0) return outcome;

  const pipeline = await leadStages();
  const superAdmin = (await db.user.findFirst({ where: { isSuperAdmin: true, active: true }, select: { id: true } }))?.id ?? null;
  for (const old of pending) {
    try {
      const maker = await db.user.findUnique({ where: { id: old.createdById }, select: { id: true, active: true } });
      const ownerUserId = maker?.active ? maker.id : superAdmin;
      if (!ownerUserId) {
        outcome.failed += 1;
        continue;
      }
      const lane = pipelineById(pipeline.pipelines, old.pipelineId);
      const stage = old.stageId ? pipeline.stages.find((s) => s.id === old.stageId) : null;
      const draft = definitionFromPipelineAutomation({ name: old.name, trigger: old.trigger, pipelineId: old.pipelineId, stageId: old.stageId, actions: storedActions(old.actions) });
      const when = old.trigger === "LEAD_CREATED" ? `a lead arrives in ${lane.name}` : `a lead enters ${stage?.label ?? "a stage"} in ${lane.name}`;
      const workflow = await createWorkflow({
        name: old.name,
        description: `Moved from ${lane.name}'s automations: when ${when}.`,
        ownerUserId,
        createdById: ownerUserId,
        draft,
        source: "MIGRATED",
        migratedFrom: old.id,
      });
      // On as it was, or off as it was — and off when its pipeline or stage has been retired since.
      const live = old.active && !lane.archived && (!old.stageId || (stage && !stage.archived));
      const published = await publishWorkflow(workflow.id, ownerUserId, "Moved from the pipeline's automations");
      if (published.ok && !live) await setWorkflowStatus(workflow.id, "PAUSED");
      if (!published.ok) {
        const why = published.problems?.map((p) => p.message).join(" ") || published.error;
        await db.automationWorkflow.update({ where: { id: workflow.id }, data: { pausedReason: `Moved from the pipeline's automations, but couldn't be switched on: ${why}`.slice(0, 500) } });
      }
      const seq = (await db.automationWorkflow.findUnique({ where: { id: workflow.id }, select: { workflowSeq: true } }))!.workflowSeq;
      await recordAudit({ userId: ownerUserId, action: "CREATE", entityType: "Workflow", entityId: workflow.id, entityLabel: `${lane.name} automation "${old.name}" moved to Automate` });
      if (live && !published.ok) {
        await notifyUser({ userId: ownerUserId, type: "WORKFLOW_PAUSED", title: `"${old.name}" moved to Automate and needs a look`, message: "It couldn't be switched on as it was. Open it to see why.", link: workflowPath(seq) });
      }
      outcome.converted += 1;
    } catch (err) {
      // Another pass converted it a moment ago: the unique link says so. Anything else is said and retried next pass.
      if (err instanceof Error && "code" in err && (err as { code?: string }).code === "P2002") continue;
      console.error(`[automate] pipeline automation ${old.id} could not be moved`, err instanceof Error ? err.message : err);
      outcome.failed += 1;
    }
  }
  return outcome;
}
