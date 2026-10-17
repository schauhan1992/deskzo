import type { z } from "zod";
import type { Clock } from "@/lib/time/zone";

/**
 * What an action is (Deskzo Automate's action registry — the one door the copilot and future agents
 * will also use). An action runs as a named person with no session: `actorId` is the workflow's
 * owner, and the registry checks that person's module access and permission before it runs, every
 * time (src/lib/automate/registry.ts). `key` is the same on every try of the step, and an action that
 * writes records it in `automation_effects` in the same transaction (src/lib/automate/effects.ts), so
 * a retry hands back what the first try made instead of making it again.
 */

export type ActionRisk = "read" | "draft" | "change" | "irreversible";

export type ActionContext = {
  actorId: string;
  workflowId: string;
  workflowName: string;
  runId: string;
  stepId: string;
  /** `runId:stepId` — the same on every try of this step. */
  key: string;
  /** How many workflows deep this run is; events it causes are one deeper. */
  depth: number;
  clock: Clock;
};

export type ActionDefinition<I = unknown, O = unknown> = {
  /** noun.verb */
  key: string;
  label: string;
  description: string;
  /** Hidden and refused when the workspace's plan or switch leaves this module out, or the actor can't open it. */
  module: string;
  /** Checked with `can(actor, permission)` when it runs; null when module access is enough. */
  permission: string | null;
  risk: ActionRisk;
  input: z.ZodType<I>;
  /** What a test run says it would do, without doing it. */
  preview(input: I): string;
  run(ctx: ActionContext, input: I): Promise<O>;
};

/** How a failed action should be treated: tried again, given up on, or left for a person to decide. */
export type FailureKind = "TRANSIENT" | "PERMANENT" | "UNKNOWN";

export class ActionError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
  ) {
    super(message);
    this.name = "ActionError";
  }
}

export function defineAction<I, O>(definition: ActionDefinition<I, O>): ActionDefinition<I, O> {
  return definition;
}

/** For an event a step's change records: caused by this run, one level deeper (src/lib/automate/engine.ts). */
export type EventCause = { causedByRunId: string; depth: number };

export function causedBy(ctx: ActionContext): EventCause {
  return { causedByRunId: ctx.runId, depth: ctx.depth + 1 };
}
