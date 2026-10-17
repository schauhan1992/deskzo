"use server";

import type { PipelineTrigger } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { notMigratedYet } from "@/lib/custom-fields/server";
import { storedActions, type AutomationAction } from "@/lib/pipeline/automation-rules";

/**
 * Settings → Pipeline → Automations. A pipeline's automations moved onto Deskzo Automate (owner, 17 Oct
 * 2026): each became a workflow marked Migrated (src/lib/automate/migrate-pipeline.ts), and that is where
 * it is changed now. This lists what each one was, with its workflow; new ones are made in Automate.
 */

async function manager() {
  const user = await requireModuleUser("leads");
  return (await can(user.id, "pipeline.manage")) ? user : null;
}

export type ManagedAutomation = {
  id: string;
  pipelineId: string;
  name: string;
  trigger: PipelineTrigger;
  stageId: string | null;
  actions: AutomationAction[];
  active: boolean;
  runs: number;
  lastRunAt: Date | null;
  /** The workflow it became — null until the next pass of Automate moves it. */
  workflow: { seq: number; status: string } | null;
};

/**
 * Every pipeline's automations as they were, each with the workflow it became, and whether this person
 * can open Automate to change them. Null for somebody who can't manage the pipeline.
 */
export async function listAutomationsForManage(): Promise<{ automations: ManagedAutomation[]; people: { id: string; name: string }[]; ready: boolean; canAutomate: boolean } | null> {
  const user = await manager();
  if (!user) return null;
  const people = await db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  const canAutomate = await can(user.id, "settings.manage");
  try {
    const rows = await db.pipelineAutomation.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, pipelineId: true, name: true, trigger: true, stageId: true, actions: true, active: true, runs: true, lastRunAt: true },
    });
    const moved = rows.length
      ? await db.automationWorkflow
          .findMany({ where: { migratedFrom: { in: rows.map((r) => r.id) } }, select: { migratedFrom: true, workflowSeq: true, status: true } })
          .catch((err) => {
            if (notMigratedYet(err)) return [];
            throw err;
          })
      : [];
    const workflowOf = new Map(moved.map((m) => [m.migratedFrom!, { seq: m.workflowSeq, status: m.status }]));
    return {
      ready: true,
      people,
      canAutomate,
      automations: rows.map((r) => ({ ...r, actions: storedActions(r.actions), workflow: workflowOf.get(r.id) ?? null })),
    };
  } catch (err) {
    if (notMigratedYet(err)) return { ready: false, people, canAutomate, automations: [] };
    throw err;
  }
}
