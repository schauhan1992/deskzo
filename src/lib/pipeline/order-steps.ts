import type { OrderStatus } from "@prisma/client";
import { isStageColor, stageKeyFromLabel, type StageColor } from "@/lib/pipeline/rules";

/**
 * A workspace's own steps within an order status (Settings → Pipeline → Orders).
 *
 * An order's statuses are the app's — waiting for approval, approved, processing, fulfilled — and the
 * process behind them stays as it is: approval and its credit checks, purchase taking the order on,
 * fulfilment. What differs from one business to the next is what happens inside a status. A system
 * integrator's "processing" is material ordered, material received, installed; a manufacturer's is
 * raw material, production, quality check, dispatched. Those are steps: the workspace names them,
 * orders them, and moves each order through them.
 *
 * An order entering a status sits at its first step until somebody moves it (`stepOfOrder`), so the
 * actions that approve, process and fulfil an order never have to know steps exist — and an order
 * whose status has since moved on simply reads as the first step of the status it is in now.
 *
 * Pure, so the settings screen, the order page and `check:order-steps` share it.
 */

/** The statuses an order can have steps within, and what each is for. */
export const STEP_STATUSES: { status: OrderStatus; label: string; hint: string }[] = [
  { status: "APPROVED", label: "Approved", hint: "Approved, before purchase takes it on — waiting for an advance, a site to be ready." },
  { status: "PROCESSING", label: "Processing", hint: "Purchase has it — material ordered, received, installed." },
  { status: "FULFILLED", label: "Fulfilled", hint: "Delivered — commissioning, handover, training." },
];

export const stepStatusLabel = (status: OrderStatus) => STEP_STATUSES.find((s) => s.status === status)?.label ?? status;
export const takesSteps = (status: OrderStatus) => STEP_STATUSES.some((s) => s.status === status);

export const STEP_LIMITS = { perStatus: 15, label: 40 } as const;

export type OrderStepDef = {
  id: string;
  /** Fixed once made: what a link or a saved filter names. The label is free to change. */
  key: string;
  label: string;
  status: OrderStatus;
  color: StageColor;
  archived: boolean;
};

/** A status's steps still in use, in their order. */
export function stepsOf<S extends OrderStepDef>(steps: S[], status: OrderStatus): S[] {
  return steps.filter((s) => s.status === status && !s.archived);
}

/**
 * The step an order shows: its own, while that is a step of the status it is in now and still in use;
 * otherwise the first step of that status; and none where the status has no steps.
 */
export function stepOfOrder<S extends OrderStepDef>(steps: S[], order: { orderStatus: OrderStatus; stepId?: string | null }): S | null {
  const own = order.stepId ? steps.find((s) => s.id === order.stepId) : undefined;
  if (own && !own.archived && own.status === order.orderStatus) return own;
  return stepsOf(steps, order.orderStatus)[0] ?? null;
}

export type StepInput = { label: string; status: OrderStatus; color: StageColor };

/**
 * What is wrong with a step as entered, or null. `others` is every other step: a name may repeat
 * across statuses ("Booked" before and after purchase) but not within one, where two columns of the
 * same name would leave nobody sure which an order is at.
 */
export function checkStep(input: StepInput, others: OrderStepDef[]): string | null {
  const label = input.label.trim();
  if (!label) return "Give the step a name.";
  if (label.length > STEP_LIMITS.label) return `Keep the name to ${STEP_LIMITS.label} characters.`;
  if (!takesSteps(input.status)) return "Steps go within Approved, Processing or Fulfilled.";
  if (!isStageColor(input.color)) return "Choose one of the colours.";
  if (others.some((s) => !s.archived && s.status === input.status && s.label.trim().toLowerCase() === label.toLowerCase())) {
    return `${stepStatusLabel(input.status)} already has a step called ${label}.`;
  }
  return null;
}

/** A new step's key from its label, as a stage's is made. */
export const stepKeyFromLabel = stageKeyFromLabel;

/** Where a retired step's orders may go: another step of the same status still in use. */
export function stepRehomeTargets(step: OrderStepDef, steps: OrderStepDef[]): OrderStepDef[] {
  return stepsOf(steps, step.status).filter((s) => s.id !== step.id);
}
