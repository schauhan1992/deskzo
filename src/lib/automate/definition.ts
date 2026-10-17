import { z } from "zod";

/**
 * What a workflow is (Deskzo Automate, plan of 17 Oct 2026): one trigger, then an ordered list of
 * steps, kept as JSON — the draft people edit and every published version. Pure: the builder, the
 * publish check and the engine all read it the same way.
 *
 *   { "schema": 1,
 *     "trigger": { "type": "task.created", "filter": { "all": [{ "ref": "trigger.task.title", "op": "contains", "value": "urgent" }] } },
 *     "steps": [
 *       { "id": "remind", "type": "action", "action": "task.create", "input": { "title": "Follow up: {{trigger.task.title}}" } },
 *       { "id": "wait", "type": "delay", "for": { "hours": 2 } },
 *       { "id": "tell", "type": "action", "action": "notify.person", "input": { "to": "owner", "title": "Still open" } } ] }
 *
 * Phase 1 steps: action, condition, branch, delay, transform, stop. There is no code anywhere in a
 * workflow: data comes in only through `{{trigger.…}}` and `{{steps.<id>.output.…}}` references and
 * the fixed function list in transforms (src/lib/automate/transform.ts).
 */

export const LIMITS = {
  /** Steps in a whole workflow, counting the ones inside branches. */
  steps: 50,
  /** Paths a branch may have, its else included. */
  branchPaths: 5,
  /** Branches inside branches. */
  branchDepth: 3,
  /** Rules in one condition. */
  rules: 20,
  /** The longest delay. */
  delayDays: 90,
} as const;

const STEP_ID = /^[a-z][a-z0-9_-]{0,39}$/i;

export const RULE_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "notIn", "contains", "notContains", "isEmpty", "isNotEmpty"] as const;
export type RuleOp = (typeof RULE_OPS)[number];

export const ruleSchema = z.object({
  /** A reference without braces: "trigger.task.title", "steps.assign.output.ownerId". */
  ref: z.string().min(1).max(200),
  op: z.enum(RULE_OPS),
  value: z.unknown().optional(),
});
export type Rule = z.infer<typeof ruleSchema>;

export const filterSchema = z.union([
  z.object({ all: z.array(ruleSchema).max(LIMITS.rules) }).strict(),
  z.object({ any: z.array(ruleSchema).max(LIMITS.rules) }).strict(),
]);
export type Filter = z.infer<typeof filterSchema>;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const scheduleSchema = z
  .object({
    every: z.enum(["hour", "day", "week", "month"]),
    /** "09:30" on the workspace's clock — for every day, week or month. */
    at: z.string().regex(TIME, "A time is hh:mm, 24-hour.").optional(),
    /** The minute past each hour, for every hour. */
    minute: z.number().int().min(0).max(59).optional(),
    /** Which days it may run on: 0 is Sunday. All of them when not given. */
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    /** For every week: the day, 0 is Sunday. Monday when not given. */
    weekday: z.number().int().min(0).max(6).optional(),
    /** For every month: the day of the month, up to 28 so every month has it. */
    dayOfMonth: z.number().int().min(1).max(28).optional(),
  })
  .strict();
export type Schedule = z.infer<typeof scheduleSchema>;

export const triggerSchema = z
  .object({
    /** An event type ("task.created"), "schedule" or "manual". */
    type: z.string().min(1).max(80),
    filter: filterSchema.optional(),
    schedule: scheduleSchema.optional(),
  })
  .strict();
export type Trigger = z.infer<typeof triggerSchema>;

const durationSchema = z
  .object({
    minutes: z.number().int().min(0).optional(),
    hours: z.number().int().min(0).optional(),
    days: z.number().int().min(0).optional(),
  })
  .strict();
export type Duration = z.infer<typeof durationSchema>;

export const TRANSFORM_FNS = [
  "text.upper",
  "text.lower",
  "text.trim",
  "text.join",
  "text.slice",
  "number.add",
  "number.subtract",
  "number.multiply",
  "number.round",
  "date.addDays",
  "date.day",
  "date.text",
  "value.default",
] as const;
export type TransformFn = (typeof TRANSFORM_FNS)[number];

const transformExprSchema = z.object({ fn: z.enum(TRANSFORM_FNS), args: z.array(z.unknown()).max(6) }).strict();
export type TransformExpr = z.infer<typeof transformExprSchema>;

type StepBase = { id: string; name?: string };
export type ActionStep = StepBase & { type: "action"; action: string; input: Record<string, unknown> };
export type ConditionStep = StepBase & { type: "condition"; if: Filter };
export type BranchPath = { name: string; if: Filter; steps: Step[] };
export type BranchStep = StepBase & { type: "branch"; paths: BranchPath[]; else?: Step[] };
/**
 * A delay: `for` a while, `until` the next hh:mm here, or `on` a time the data names — a booking's
 * start, "{{trigger.booking.startsAt}}" — moved `before` or `after` it. A time already gone waits for nothing.
 */
export type DelayStep = StepBase & { type: "delay"; for?: Duration; until?: { at: string; days?: number[] }; on?: { value: string; before?: Duration; after?: Duration } };
export type TransformStep = StepBase & { type: "transform"; set: Record<string, TransformExpr> };
export type StopStep = StepBase & { type: "stop"; outcome: "succeeded" | "failed"; message?: string };
export type Step = ActionStep | ConditionStep | BranchStep | DelayStep | TransformStep | StopStep;

const base = { id: z.string().regex(STEP_ID, "A step id is a letter, then letters, digits, - or _ (40 at most)."), name: z.string().max(80).optional() };

export const stepSchema: z.ZodType<Step> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ ...base, type: z.literal("action"), action: z.string().min(1).max(80), input: z.record(z.string(), z.unknown()) }).strict(),
    z.object({ ...base, type: z.literal("condition"), if: filterSchema }).strict(),
    z
      .object({
        ...base,
        type: z.literal("branch"),
        paths: z.array(z.object({ name: z.string().min(1).max(80), if: filterSchema, steps: z.array(stepSchema) }).strict()).min(1),
        else: z.array(stepSchema).optional(),
      })
      .strict(),
    z
      .object({
        ...base,
        type: z.literal("delay"),
        for: durationSchema.optional(),
        until: z.object({ at: z.string().regex(TIME, "A time is hh:mm, 24-hour."), days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional() }).strict().optional(),
        on: z.object({ value: z.string().min(1).max(200), before: durationSchema.optional(), after: durationSchema.optional() }).strict().optional(),
      })
      .strict()
      .refine((d) => [d.for, d.until, d.on].filter(Boolean).length === 1, "A delay waits for a while, until a time of day, or until a time the data names — one of them."),
    z.object({ ...base, type: z.literal("transform"), set: z.record(z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/), transformExprSchema) }).strict(),
    z.object({ ...base, type: z.literal("stop"), outcome: z.enum(["succeeded", "failed"]), message: z.string().max(300).optional() }).strict(),
  ]),
) as z.ZodType<Step>;

export const definitionSchema = z
  .object({
    schema: z.literal(1),
    trigger: triggerSchema,
    steps: z.array(stepSchema).min(1),
    /**
     * What a step that fails does to the run: "stop" (the default) ends it as failed; "continue" records
     * the step as failed and goes on to the next — as a pipeline automation always did, and what the
     * converted ones keep doing. A step that may have been done already still waits for a person.
     */
    settings: z.object({ onError: z.enum(["stop", "continue"]).optional() }).strict().optional(),
  })
  .strict();
export type Definition = z.infer<typeof definitionSchema>;

/** Every step, depth-first in the order they would run, with how deep in branches each sits. */
export function eachStep(steps: Step[], depth = 0, out: { step: Step; depth: number }[] = []): { step: Step; depth: number }[] {
  for (const step of steps) {
    out.push({ step, depth });
    if (step.type === "branch") {
      for (const path of step.paths) eachStep(path.steps, depth + 1, out);
      if (step.else) eachStep(step.else, depth + 1, out);
    }
  }
  return out;
}

export function delayMs(duration: Duration): number {
  return ((duration.days ?? 0) * 24 * 60 + (duration.hours ?? 0) * 60 + (duration.minutes ?? 0)) * 60_000;
}

/** A new workflow's starting point: run by hand, one step to fill in. */
export function blankDefinition(): Definition {
  return { schema: 1, trigger: { type: "manual" }, steps: [{ id: "first", type: "action", action: "notify.person", input: { to: "owner", title: "Hello from a workflow" } }] };
}
