import type { z } from "zod";
import { definitionSchema, eachStep, LIMITS, type Definition, type Filter, type Step } from "@/lib/automate/definition";
import { isReference, isTemplate, referencesIn } from "@/lib/automate/references";
import { actionByKey } from "@/lib/automate/registry";
import { triggerByType } from "@/lib/automate/triggers";
import { comparesWithNothing, NOTHING_CHOSEN } from "@/lib/automate/blanks";

/**
 * Whether a definition may be published (Deskzo Automate). Pure but for the action and trigger
 * lists. Refuses, naming the step and field:
 *
 *   · anything the shape doesn't allow, or past the limits (50 steps, 5 paths a branch, branches 3
 *     deep, 20 rules, delays up to 90 days);
 *   · a step id used twice;
 *   · an unknown trigger, or a schedule without its timing;
 *   · a reference to a step that hasn't run by then — a later one, one inside a branch that may not
 *     have been taken — or to a trigger field the trigger doesn't have;
 *   · an unknown action, or input its schema refuses. A field holding a reference is checked when
 *     the step runs, once the reference has a value;
 *   · a rule comparing an id with nothing — one cleared on import because it named another
 *     workspace's record (src/lib/automate/blanks.ts).
 *
 * Who may publish, and whether the owner may take each action, is checked by the caller
 * (src/lib/automate/store.ts): that needs the database.
 */

export type DefinitionProblem = { stepId: string | null; field: string | null; message: string };
export type Validated = { ok: true; definition: Definition } | { ok: false; problems: DefinitionProblem[] };

function zodProblems(error: z.ZodError, stepId: string | null = null): DefinitionProblem[] {
  return error.issues.map((issue) => ({ stepId, field: issue.path.length ? issue.path.join(".") : null, message: issue.message }));
}

function filterRefs(filter: Filter | undefined): string[] {
  if (!filter) return [];
  const rules = "all" in filter ? filter.all : filter.any;
  return rules.flatMap((rule) => [rule.ref, ...referencesIn(rule.value)]);
}

function refsOfStep(step: Step): string[] {
  switch (step.type) {
    case "action": {
      // An action's own merge fields, in the fields it names, are its to fill — not references.
      const own = actionByKey(step.action)?.ownMergeFields;
      if (!own) return referencesIn(step.input);
      return Object.entries(step.input).flatMap(([field, value]) => referencesIn(value).filter((ref) => !(own.fields.includes(field) && own.names.includes(ref))));
    }
    case "condition":
      return filterRefs(step.if);
    case "branch":
      return step.paths.flatMap((p) => filterRefs(p.if));
    case "transform":
      return Object.values(step.set).flatMap((expr) => referencesIn(expr.args));
    case "delay":
      return step.on ? referencesIn(step.on.value) : [];
    default:
      return [];
  }
}

export function validateDefinition(raw: unknown): Validated {
  const parsed = definitionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: zodProblems(parsed.error) };
  const definition = parsed.data;
  const problems: DefinitionProblem[] = [];
  const all = eachStep(definition.steps);

  if (all.length > LIMITS.steps) problems.push({ stepId: null, field: null, message: `A workflow has at most ${LIMITS.steps} steps; this one has ${all.length}.` });
  const seen = new Set<string>();
  for (const { step, depth } of all) {
    if (seen.has(step.id)) problems.push({ stepId: step.id, field: "id", message: `Two steps are called "${step.id}".` });
    seen.add(step.id);
    if (step.type === "branch") {
      if (depth + 1 > LIMITS.branchDepth) problems.push({ stepId: step.id, field: null, message: `Branches go at most ${LIMITS.branchDepth} deep.` });
      if (step.paths.length + (step.else ? 1 : 0) > LIMITS.branchPaths) problems.push({ stepId: step.id, field: "paths", message: `A branch has at most ${LIMITS.branchPaths} paths, its else included.` });
    }
    if (step.type === "delay") {
      if ([step.for, step.until, step.on].filter(Boolean).length !== 1) problems.push({ stepId: step.id, field: null, message: "A delay waits for a length of time, until a time of day, or until a time the data names." });
      if (step.for) {
        const minutes = (step.for.days ?? 0) * 1440 + (step.for.hours ?? 0) * 60 + (step.for.minutes ?? 0);
        if (minutes <= 0) problems.push({ stepId: step.id, field: "for", message: "A delay needs a length." });
        if (minutes > LIMITS.delayDays * 1440) problems.push({ stepId: step.id, field: "for", message: `A delay is at most ${LIMITS.delayDays} days.` });
      }
    }
  }

  const trigger = triggerByType(definition.trigger.type);
  if (!trigger) problems.push({ stepId: null, field: "trigger.type", message: `"${definition.trigger.type}" isn't something a workflow can start from.` });
  if (definition.trigger.type === "schedule" && !definition.trigger.schedule) problems.push({ stepId: null, field: "trigger.schedule", message: "A schedule needs its timing." });
  if (definition.trigger.type !== "schedule" && definition.trigger.schedule) problems.push({ stepId: null, field: "trigger.schedule", message: "Only a schedule trigger has a timing." });

  const checkRef = (ref: string, stepId: string | null, inScope: Set<string>) => {
    if (!isReference(ref)) {
      problems.push({ stepId, field: null, message: `"${ref}" isn't a reference: it starts with trigger. or steps.<id>.output.` });
      return;
    }
    const parts = ref.split(".");
    if (parts[0] === "trigger") {
      if (trigger && parts[1] && !trigger.fields.includes(parts[1])) problems.push({ stepId, field: null, message: `This trigger has no field "${parts[1]}".` });
    } else if (!inScope.has(parts[1]!)) {
      problems.push({ stepId, field: null, message: `"${ref}" refers to a step that hasn't run by this point.` });
    }
  };
  for (const ref of filterRefs(definition.trigger.filter)) checkRef(ref, null, new Set());
  const unfinished = (filter: Filter | undefined, stepId: string | null, field: string) => {
    const rules = !filter ? [] : "all" in filter ? filter.all : filter.any;
    if (rules.some(comparesWithNothing)) problems.push({ stepId, field, message: NOTHING_CHOSEN });
  };
  unfinished(definition.trigger.filter, null, "trigger.filter");

  // Walked in running order: a step sees the steps before it on its own path, and its branches'.
  const walk = (steps: Step[], scope: Set<string>) => {
    const inScope = new Set(scope);
    for (const step of steps) {
      for (const ref of refsOfStep(step)) checkRef(ref, step.id, inScope);
      if (step.type === "action") {
        const action = actionByKey(step.action);
        if (!action) {
          problems.push({ stepId: step.id, field: "action", message: `"${step.action}" isn't an action a workflow can take.` });
        } else {
          const result = action.input.safeParse(step.input);
          if (!result.success) {
            for (const issue of result.error.issues) {
              const top = issue.path[0];
              // A field holding a reference is checked when the step runs, with its value.
              if (typeof top === "string" && isTemplate(step.input[top])) continue;
              problems.push({ stepId: step.id, field: issue.path.join(".") || null, message: issue.message });
            }
          }
        }
      }
      if (step.type === "condition") unfinished(step.if, step.id, "if");
      if (step.type === "branch") {
        for (const path of step.paths) unfinished(path.if, step.id, "paths");
        for (const path of step.paths) walk(path.steps, inScope);
        if (step.else) walk(step.else, inScope);
      }
      inScope.add(step.id);
    }
  };
  walk(definition.steps, new Set());

  return problems.length ? { ok: false, problems } : { ok: true, definition };
}
