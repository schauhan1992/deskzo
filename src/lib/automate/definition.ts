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
 * Phase 1 steps: action, condition, branch, delay, transform, stop. Phase 6 adds approval (waits for
 * named people or a role), waitForEvent (waits for something to happen), forEach (its steps once per
 * item of a list) and parallel (up to three paths at once). There is no code anywhere in a workflow:
 * data comes in only through `{{trigger.…}}` and `{{steps.<id>.output.…}}` references and the fixed
 * function list in transforms (src/lib/automate/transform.ts).
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
  /** The longest an approval or a wait for an event waits. */
  waitDays: 30,
  /** People named on one approval. */
  approvers: 10,
  /** Items a for-each goes through. */
  forEachItems: 100,
  /** Paths of one parallel step. */
  parallelPaths: 3,
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

/** `note`: one line saying what the step is for — written by an AI draft, or by a person. */
type StepBase = { id: string; name?: string; note?: string };
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
/**
 * Waits until one of the people named — a person's id, "owner", a reference to a person — or anybody
 * with `role` approves or rejects in the approvals inbox; nobody deciding within `timeout` goes the
 * `onTimeout` way. Then the `approved` or `rejected` steps, and on after the step.
 */
export type ApprovalStep = StepBase & {
  type: "approval";
  title: string;
  message?: string;
  approvers: string[];
  role?: string;
  timeout: Duration;
  onTimeout: "approved" | "rejected";
  approved?: Step[];
  rejected?: Step[];
};
/**
 * Waits for an event — a task done, a ticket answered — whose fields meet `filter` (rules on
 * "event.…", their values worked out when the wait begins). Nothing within `timeout`: "continue"
 * goes on, "stop" ends the run quietly.
 */
export type WaitStep = StepBase & { type: "waitForEvent"; event: string; filter?: Filter; timeout: Duration; onTimeout: "continue" | "stop" };
/** Its steps once per item: of a list the data names ("{{steps.x.output.items}}"), or a list typed in. */
export type ForEachStep = StepBase & { type: "forEach"; items: string | unknown[]; steps: Step[] };
/** Up to three paths at once; the run goes on when every one is done. */
export type ParallelPath = { name: string; steps: Step[] };
export type ParallelStep = StepBase & { type: "parallel"; paths: ParallelPath[] };
export type Step = ActionStep | ConditionStep | BranchStep | DelayStep | TransformStep | StopStep | ApprovalStep | WaitStep | ForEachStep | ParallelStep;

const base = { id: z.string().regex(STEP_ID, "A step id is a letter, then letters, digits, - or _ (40 at most)."), name: z.string().max(80).optional(), note: z.string().max(300).optional() };

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
    z
      .object({
        ...base,
        type: z.literal("approval"),
        title: z.string().trim().min(1, "Say what is to be approved.").max(200),
        message: z.string().max(2000).optional(),
        approvers: z.array(z.string().max(200)).max(LIMITS.approvers, `At most ${LIMITS.approvers} people.`),
        role: z.string().trim().max(60).optional(),
        timeout: durationSchema,
        onTimeout: z.enum(["approved", "rejected"]),
        approved: z.array(stepSchema).optional(),
        rejected: z.array(stepSchema).optional(),
      })
      .strict(),
    z
      .object({
        ...base,
        type: z.literal("waitForEvent"),
        event: z.string().min(1).max(80),
        filter: filterSchema.optional(),
        timeout: durationSchema,
        onTimeout: z.enum(["continue", "stop"]),
      })
      .strict(),
    z
      .object({
        ...base,
        type: z.literal("forEach"),
        items: z.union([z.string().max(200), z.array(z.unknown()).max(LIMITS.forEachItems, `A for-each goes through at most ${LIMITS.forEachItems} items.`)]),
        steps: z.array(stepSchema),
      })
      .strict(),
    z
      .object({
        ...base,
        type: z.literal("parallel"),
        paths: z
          .array(z.object({ name: z.string().min(1).max(80), steps: z.array(stepSchema) }).strict())
          .min(1)
          .max(LIMITS.parallelPaths, `At most ${LIMITS.parallelPaths} paths at once.`),
      })
      .strict(),
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

/**
 * The lists of steps a step holds, each with the key the cursor and the builder know it by: a branch's
 * paths (0, 1…) and else (-1); an approval's approved (0) and rejected (1); a for-each's steps (0); a
 * parallel step's paths (0, 1, 2).
 */
export function childLists(step: Step): { path: number; label: string; steps: Step[] }[] {
  switch (step.type) {
    case "branch":
      return [...step.paths.map((p, i) => ({ path: i, label: p.name, steps: p.steps })), ...(step.else ? [{ path: -1, label: "Otherwise", steps: step.else }] : [])];
    case "approval":
      return [
        { path: 0, label: "If approved", steps: step.approved ?? [] },
        { path: 1, label: "If rejected", steps: step.rejected ?? [] },
      ];
    case "forEach":
      return [{ path: 0, label: "For each item", steps: step.steps }];
    case "parallel":
      return step.paths.map((p, i) => ({ path: i, label: p.name, steps: p.steps }));
    default:
      return [];
  }
}

/** One of a step's lists by its key, or null. */
export function childList(step: Step, path: number): Step[] | null {
  return childLists(step).find((l) => l.path === path)?.steps ?? null;
}

/** The step with each of its lists replaced by `fn`'s. */
export function mapChildLists(step: Step, fn: (steps: Step[], path: number) => Step[]): Step {
  switch (step.type) {
    case "branch":
      return { ...step, paths: step.paths.map((p, i) => ({ ...p, steps: fn(p.steps, i) })), ...(step.else ? { else: fn(step.else, -1) } : {}) };
    case "approval":
      return { ...step, ...(step.approved ? { approved: fn(step.approved, 0) } : {}), ...(step.rejected ? { rejected: fn(step.rejected, 1) } : {}) };
    case "forEach":
      return { ...step, steps: fn(step.steps, 0) };
    case "parallel":
      return { ...step, paths: step.paths.map((p, i) => ({ ...p, steps: fn(p.steps, i) })) };
    default:
      return step;
  }
}

/** Every step, depth-first in the order they would run, with how deep in branches and the like each sits. */
export function eachStep(steps: Step[], depth = 0, out: { step: Step; depth: number }[] = []): { step: Step; depth: number }[] {
  for (const step of steps) {
    out.push({ step, depth });
    for (const list of childLists(step)) eachStep(list.steps, depth + 1, out);
  }
  return out;
}

/** Every step inside a step's lists, at any depth — not the step itself. */
export function allStepsIn(step: Step): Step[] {
  return childLists(step).flatMap((list) => eachStep(list.steps).map((e) => e.step));
}

export function delayMs(duration: Duration): number {
  return ((duration.days ?? 0) * 24 * 60 + (duration.hours ?? 0) * 60 + (duration.minutes ?? 0)) * 60_000;
}

/** A new workflow's starting point: run by hand, one step to fill in. */
export function blankDefinition(): Definition {
  return { schema: 1, trigger: { type: "manual" }, steps: [{ id: "first", type: "action", action: "notify.person", input: { to: "owner", title: "Hello from a workflow" } }] };
}
