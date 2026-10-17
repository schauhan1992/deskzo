/**
 * What can start a workflow (Deskzo Automate), and the fields each hands to `{{trigger.…}}`.
 *
 * Phase 1: a schedule, a person pressing Run, and a task being created. Phase 2 adds the Deskzo
 * events — a lead created or moved, a ticket opened, an invoice paid, a form sent — each emitted
 * where the change happens (src/lib/automate/events.ts).
 */

export type TriggerDefinition = {
  type: string;
  label: string;
  /** The top-level fields of `{{trigger.…}}`. */
  fields: readonly string[];
  /** Recorded by `emitEvent`, as opposed to started by the worker or a person. */
  event: boolean;
};

export const TRIGGERS: readonly TriggerDefinition[] = [
  { type: "schedule", label: "On a schedule", fields: ["scheduledFor", "firedAt"], event: false },
  { type: "manual", label: "When somebody presses Run", fields: ["startedById", "data"], event: false },
  { type: "task.created", label: "A task is created by a workflow", fields: ["task"], event: true },
];

export function triggerByType(type: string): TriggerDefinition | null {
  return TRIGGERS.find((t) => t.type === type) ?? null;
}
