import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { definitionSchema, eachStep, type Definition } from "@/lib/automate/definition";
import { clearWorkspaceValues, splitProblems, type Cleared } from "@/lib/automate/blanks";
import { validateDefinition, type DefinitionProblem } from "@/lib/automate/validate";
import { actionByKey } from "@/lib/automate/registry";
import { triggerByType } from "@/lib/automate/triggers";
import { createWorkflow, type StoreResult } from "@/lib/automate/store";

/**
 * Workflows as files, and a company's own templates (Deskzo Automate, Phase 5).
 *
 *   · Export writes the draft as a JSON file — `{"deskzo": "automate-workflow", "version": 1, …}` —
 *     with what belongs to this workspace cleared (src/lib/automate/blanks.ts): people, connections,
 *     records, stages, the ids a rule compares with. No secret is ever in a definition.
 *   · Import reads a file, refuses one that isn't a workflow or names a trigger or action Deskzo
 *     doesn't have, clears again (a file can be edited), and says before anything is made what it
 *     would call outside and what has to be chosen. It lands as a draft; nothing runs until a person
 *     publishes it.
 *   · A company template is the same cleared definition, kept in the workspace to start others from.
 */

export const FILE_KIND = "automate-workflow";
export const FILE_VERSION = 1;
const MAX_FILE_BYTES = 512 * 1024;

export type WorkflowFile = { deskzo: typeof FILE_KIND; version: number; exportedAt: string; name: string; description: string | null; definition: Definition; cleared: string[] };

/** A workflow's draft as a file, and a name to save it under. Refused when the draft isn't a workflow yet. */
export async function exportWorkflow(workflowId: string): Promise<StoreResult<{ fileName: string; text: string; cleared: Cleared[] }>> {
  const workflow = await db.automationWorkflow.findUnique({ where: { id: workflowId }, select: { name: true, description: true, draft: true, workflowSeq: true } });
  if (!workflow) return { ok: false, error: "That workflow no longer exists." };
  const parsed = definitionSchema.safeParse(workflow.draft);
  if (!parsed.success) return { ok: false, error: "The draft isn't a whole workflow yet — finish its steps first." };
  const { definition, cleared } = clearWorkspaceValues(parsed.data);
  const file: WorkflowFile = { deskzo: FILE_KIND, version: FILE_VERSION, exportedAt: new Date().toISOString(), name: workflow.name, description: workflow.description, definition, cleared: cleared.map((c) => c.label) };
  const slug = workflow.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "workflow";
  return { ok: true, data: { fileName: `WF-${String(workflow.workflowSeq).padStart(4, "0")}-${slug}.json`, text: JSON.stringify(file, null, 2), cleared } };
}

export type ImportPreview = {
  name: string;
  description: string | null;
  trigger: string;
  steps: string[];
  /** Outside places it would send to: an API's host, or the kind of app for a saved connection. */
  calls: string[];
  /** Cleared because they named something of another workspace's. */
  cleared: Cleared[];
  /** To choose after import: a person, a connection, a record, a stage. */
  blanks: DefinitionProblem[];
  /** Mistakes in the workflow itself, to fix in the builder. */
  others: DefinitionProblem[];
};

type Read = { ok: true; name: string; description: string | null; definition: Definition; preview: ImportPreview } | { ok: false; error: string };

const OUTSIDE: Record<string, string> = { "slack.post": "Slack", "teams.post": "Microsoft Teams", "whatsapp.send": "WhatsApp", "sheets.append": "Google Sheets" };

/** What an outside step would reach: the host of an address typed in, or the kind of app. */
function callsOf(definition: Definition): string[] {
  const out = new Set<string>();
  for (const { step } of eachStep(definition.steps)) {
    if (step.type !== "action") continue;
    if (step.action === "http.request") {
      const url = step.input.url;
      if (typeof url === "string" && url.trim()) {
        try {
          out.add(/\{\{/.test(new URL(url).host) ? url : new URL(url).host);
        } catch {
          out.add(url.slice(0, 120));
        }
      } else {
        out.add("An outside API (choose a saved connection)");
      }
    } else if (OUTSIDE[step.action]) {
      out.add(OUTSIDE[step.action]!);
    }
  }
  return [...out];
}

/** A file's workflow, checked and cleared, with what importing it would mean — or why it can't be. */
export function readWorkflowFile(text: string): Read {
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) return { ok: false, error: "That file is over 512 KB — too big to be a workflow." };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file isn't JSON. Choose a workflow file exported from Deskzo Automate." };
  }
  const file = (raw ?? {}) as Partial<WorkflowFile>;
  if (file.deskzo !== FILE_KIND) return { ok: false, error: "That file isn't a Deskzo Automate workflow." };
  if (typeof file.version !== "number" || file.version > FILE_VERSION) return { ok: false, error: "That file is from a newer Deskzo than this one. Export it again from here, or wait for this workspace to be updated." };
  const parsed = definitionSchema.safeParse(file.definition);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `The workflow in that file isn't one Deskzo can read${issue ? `: ${issue.path.join(".") || "the workflow"} — ${issue.message}` : "."}` };
  }
  const unknown = [
    ...(triggerByType(parsed.data.trigger.type) ? [] : [`what starts it, "${parsed.data.trigger.type}"`]),
    ...eachStep(parsed.data.steps).flatMap(({ step }) => (step.type === "action" && !actionByKey(step.action) ? [`the step "${step.name || step.id}", "${step.action}"`] : [])),
  ];
  if (unknown.length) return { ok: false, error: `That file uses what this Deskzo doesn't have: ${unknown.join("; ")}.` };

  const { definition, cleared } = clearWorkspaceValues(parsed.data);
  const checked = validateDefinition(definition);
  const { blanks, others } = splitProblems(definition, checked.ok ? [] : checked.problems);
  const name = (typeof file.name === "string" && file.name.trim() ? file.name.trim() : "Imported workflow").slice(0, 120);
  const description = typeof file.description === "string" && file.description.trim() ? file.description.trim().slice(0, 500) : null;
  return {
    ok: true,
    name,
    description,
    definition,
    preview: {
      name,
      description,
      trigger: triggerByType(definition.trigger.type)?.label ?? definition.trigger.type,
      steps: eachStep(definition.steps).map(({ step }) => step.name || (step.type === "action" ? (actionByKey(step.action)?.label ?? step.action) : step.type)),
      calls: callsOf(definition),
      cleared,
      blanks,
      others,
    },
  };
}

/** A file's workflow, as a new draft of `ownerId`'s. */
export async function importWorkflow(text: string, ownerId: string): Promise<StoreResult<{ id: string; preview: ImportPreview }>> {
  const read = readWorkflowFile(text);
  if (!read.ok) return read;
  const made = await createWorkflow({ name: read.name, description: read.description, ownerUserId: ownerId, createdById: ownerId, draft: read.definition });
  return { ok: true, data: { id: made.id, preview: read.preview } };
}

// ─── A company's own templates ──────────────────────────────────────────────────────────────────

export type CompanyTemplate = { id: string; name: string; description: string | null; steps: string[]; trigger: string; createdById: string; createdAt: Date };

/** Saves a workflow's draft as one of the company's templates, cleared of what belongs to it. */
export async function saveCompanyTemplate(workflowId: string, byUserId: string, meta: { name?: string; description?: string | null } = {}): Promise<StoreResult<{ id: string; cleared: Cleared[] }>> {
  const workflow = await db.automationWorkflow.findUnique({ where: { id: workflowId }, select: { name: true, description: true, draft: true } });
  if (!workflow) return { ok: false, error: "That workflow no longer exists." };
  const parsed = definitionSchema.safeParse(workflow.draft);
  if (!parsed.success) return { ok: false, error: "The draft isn't a whole workflow yet — finish its steps first." };
  const { definition, cleared } = clearWorkspaceValues(parsed.data);
  const name = (meta.name ?? workflow.name).trim().slice(0, 120) || "Untitled template";
  const description = (meta.description === undefined ? workflow.description : meta.description)?.trim().slice(0, 500) || null;
  const saved = await db.automationTemplate.create({ data: { name, description, definition: definition as unknown as Prisma.InputJsonValue, createdById: byUserId }, select: { id: true } });
  return { ok: true, data: { id: saved.id, cleared } };
}

export async function listCompanyTemplates(): Promise<CompanyTemplate[]> {
  const rows = await db.automationTemplate.findMany({ orderBy: { createdAt: "desc" }, take: 200, select: { id: true, name: true, description: true, definition: true, createdById: true, createdAt: true } });
  return rows.map((r) => {
    const parsed = definitionSchema.safeParse(r.definition);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      createdById: r.createdById,
      createdAt: r.createdAt,
      trigger: parsed.success ? (triggerByType(parsed.data.trigger.type)?.label ?? parsed.data.trigger.type) : "",
      steps: parsed.success ? eachStep(parsed.data.steps).map(({ step }) => step.name || (step.type === "action" ? (actionByKey(step.action)?.label ?? step.action) : step.type)) : [],
    };
  });
}

export async function deleteCompanyTemplate(id: string): Promise<boolean> {
  return (await db.automationTemplate.deleteMany({ where: { id } })).count === 1;
}

/** A company template as a new draft of `ownerId`'s, with its blanks to fill in the builder. */
export async function createFromCompanyTemplate(id: string, ownerId: string): Promise<StoreResult<{ id: string }>> {
  const template = await db.automationTemplate.findUnique({ where: { id }, select: { name: true, description: true, definition: true } });
  if (!template) return { ok: false, error: "That template no longer exists." };
  const parsed = definitionSchema.safeParse(template.definition);
  if (!parsed.success) return { ok: false, error: "That template can't be read any more." };
  const made = await createWorkflow({ name: template.name, description: template.description, ownerUserId: ownerId, createdById: ownerId, draft: clearWorkspaceValues(parsed.data).definition, source: "TEMPLATE", templateKey: `company:${id}` });
  return { ok: true, data: made };
}
