import { eachStep, type Definition, type Filter, type Rule, type Step } from "@/lib/automate/definition";
import { FIELD_HINTS, humanize } from "@/lib/automate/field-hints";
import { isTemplate } from "@/lib/automate/references";
import { MAIN_PIPELINE_ID } from "@/lib/pipeline/rules";
import type { DefinitionProblem } from "@/lib/automate/validate";

/**
 * What doesn't carry over from one workspace to another (Deskzo Automate, Phase 5): the people a
 * step picks, its outside connections, the records and pipeline stages it names, and the ids a rule
 * compares with. A workflow exported, imported or drafted by AI has them cleared — they would point at
 * another workspace's records, or at nothing — and the builder asks for them again, through the
 * problems publishing raises, before it can run.
 *
 * Kept: references ({{trigger.lead.id}}), a field's special values ("owner", "lead_owner", "rules"),
 * and the main pipeline, which every workspace has. A cleared field is left empty ("" or []), so
 * publishing refuses it until somebody chooses. Pure.
 */

export type Cleared = { stepId: string | null; field: string; label: string };

const ID_FIELD = /Ids?$/;
const KEPT_IDS = new Set([MAIN_PIPELINE_ID]);

/** Whether an action's field holds something of this workspace's — a person, a record, a connection, a stage. */
export function isWorkspaceField(action: string, field: string): boolean {
  const hint = FIELD_HINTS[action]?.[field];
  if (hint?.kind === "person" || hint?.kind === "people" || hint?.kind === "connection" || hint?.kind === "stage" || hint?.record) return true;
  return ID_FIELD.test(field);
}

function portable(action: string, field: string, value: unknown): boolean {
  if (isTemplate(value)) return true;
  if (typeof value === "string" && KEPT_IDS.has(value)) return true;
  const special = FIELD_HINTS[action]?.[field]?.special ?? [];
  return typeof value === "string" && special.some((s) => s.value === value);
}

/** Whether a rule compares an id: trigger.lead.ownerUserId, trigger.to.stageId, steps.x.output.id. */
export function comparesAnId(rule: Rule): boolean {
  const last = rule.ref.split(".").pop() ?? "";
  return last === "id" || /Id$/.test(last);
}

const COMPARING = new Set(["eq", "ne", "in", "notIn"]);

/** A rule that compares an id with nothing — what a cleared rule is until somebody chooses again. */
export function comparesWithNothing(rule: Rule): boolean {
  if (!comparesAnId(rule) || !COMPARING.has(rule.op)) return false;
  const v = rule.value;
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

function clearFilter(filter: Filter, stepId: string | null, field: string, cleared: Cleared[], where: string): Filter {
  const clearRule = (rule: Rule): Rule => {
    if (!comparesAnId(rule) || !COMPARING.has(rule.op)) return rule;
    const keep = (v: unknown) => isTemplate(v) || (typeof v === "string" && KEPT_IDS.has(v));
    if (Array.isArray(rule.value)) {
      const kept = rule.value.filter(keep);
      if (kept.length === rule.value.length) return rule;
      cleared.push({ stepId, field, label: `${where}: the rule on ${rule.ref}` });
      return { ...rule, value: kept };
    }
    if (rule.value === undefined || rule.value === null || rule.value === "" || keep(rule.value)) return rule;
    cleared.push({ stepId, field, label: `${where}: the rule on ${rule.ref}` });
    return { ...rule, value: "" };
  };
  return "all" in filter ? { all: filter.all.map(clearRule) } : { any: filter.any.map(clearRule) };
}

function clearStep(step: Step, cleared: Cleared[]): Step {
  const title = step.name || step.id;
  switch (step.type) {
    case "action": {
      const input: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(step.input)) {
        if (!isWorkspaceField(step.action, field)) {
          input[field] = value;
          continue;
        }
        const label = `${title} › ${FIELD_HINTS[step.action]?.[field]?.label ?? humanize(field)}`;
        // Emptied, not removed: a removed field takes its default ("owner", "rules") without anybody
        // noticing, where an empty one is a problem the builder marks until somebody chooses.
        if (Array.isArray(value)) {
          const kept = value.filter((v) => portable(step.action, field, v));
          if (kept.length !== value.length) cleared.push({ stepId: step.id, field, label });
          input[field] = kept;
        } else if (value === undefined || value === null || value === "" || portable(step.action, field, value)) {
          if (value !== undefined) input[field] = value;
        } else {
          cleared.push({ stepId: step.id, field, label });
          input[field] = "";
        }
      }
      return { ...step, input };
    }
    case "condition":
      return { ...step, if: clearFilter(step.if, step.id, "if", cleared, title) };
    case "branch":
      return {
        ...step,
        paths: step.paths.map((p) => ({ ...p, if: clearFilter(p.if, step.id, "paths", cleared, `${title}, ${p.name}`), steps: p.steps.map((s) => clearStep(s, cleared)) })),
        ...(step.else ? { else: step.else.map((s) => clearStep(s, cleared)) } : {}),
      };
    default:
      return step;
  }
}

/** The definition with everything of this workspace's taken out, and what was. */
export function clearWorkspaceValues(definition: Definition): { definition: Definition; cleared: Cleared[] } {
  const cleared: Cleared[] = [];
  const trigger = definition.trigger.filter ? { ...definition.trigger, filter: clearFilter(definition.trigger.filter, null, "trigger.filter", cleared, "What starts it") } : definition.trigger;
  const steps = definition.steps.map((s) => clearStep(s, cleared));
  return { definition: { ...definition, trigger, steps }, cleared };
}

/**
 * A draft's problems split into blanks — a person, connection, record or stage to choose, a rule to
 * finish — and the rest, which are mistakes in the workflow itself.
 */
export function splitProblems(definition: Definition, problems: DefinitionProblem[]): { blanks: DefinitionProblem[]; others: DefinitionProblem[] } {
  const steps = new Map(eachStep(definition.steps).map(({ step }) => [step.id, step]));
  const blanks: DefinitionProblem[] = [];
  const others: DefinitionProblem[] = [];
  for (const p of problems) {
    const step = p.stepId ? steps.get(p.stepId) : null;
    const top = p.field?.split(".")[0] ?? "";
    const isBlank = p.message === NOTHING_CHOSEN || (step?.type === "action" && !!top && isWorkspaceField(step.action, top) && (step.input[top] === undefined || step.input[top] === "" || (Array.isArray(step.input[top]) && (step.input[top] as unknown[]).length === 0)));
    (isBlank ? blanks : others).push(p);
  }
  return { blanks, others };
}

/** The validator's words for a rule left comparing an id with nothing. */
export const NOTHING_CHOSEN = "Choose what this rule compares with — it was cleared because it named another workspace's record.";
