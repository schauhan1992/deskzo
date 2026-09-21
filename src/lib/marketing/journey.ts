/**
 * Moving somebody through a sequence, and knowing when to stop.
 *
 * The rule that earns this its own module is the exit. A nurture sequence that keeps sending after
 * the customer has replied, bought, or raised a ticket about the very thing being advertised is
 * worse than no sequence at all — it tells them plainly that nobody is reading. Exits are checked
 * before every step, not only at the start.
 */

export type ExitCondition =
  | "REPLIED"
  | "ORDERED"
  | "RENEWED"
  | "TICKET_RAISED"
  | "LEAD_WON"
  | "LEAD_LOST"
  | "UNSUBSCRIBED"
  | "SUPPRESSED";

export const exitLabels: Record<ExitCondition, string> = {
  REPLIED: "They replied",
  ORDERED: "They placed an order",
  RENEWED: "They renewed",
  TICKET_RAISED: "They raised a ticket",
  LEAD_WON: "The lead was won",
  LEAD_LOST: "The lead was lost",
  UNSUBSCRIBED: "They unsubscribed",
  SUPPRESSED: "They can no longer be contacted",
};

/** What the tick knows about an enrolled company since it was enrolled. */
export type ExitSignals = {
  replied: boolean;
  ordered: boolean;
  renewed: boolean;
  ticketRaised: boolean;
  leadWon: boolean;
  leadLost: boolean;
  unsubscribed: boolean;
  suppressed: boolean;
};

export const NO_SIGNALS: ExitSignals = {
  replied: false,
  ordered: false,
  renewed: false,
  ticketRaised: false,
  leadWon: false,
  leadLost: false,
  unsubscribed: false,
  suppressed: false,
};

const SIGNAL_OF: Record<ExitCondition, keyof ExitSignals> = {
  REPLIED: "replied",
  ORDERED: "ordered",
  RENEWED: "renewed",
  TICKET_RAISED: "ticketRaised",
  LEAD_WON: "leadWon",
  LEAD_LOST: "leadLost",
  UNSUBSCRIBED: "unsubscribed",
  SUPPRESSED: "suppressed",
};

/**
 * Whether to take somebody out now.
 *
 * Unsubscribing and becoming unreachable always end a sequence, whatever the journey was
 * configured with — those are not preferences an author gets to opt out of honouring.
 */
export function shouldExit(
  exitOn: ExitCondition[] | null | undefined,
  signals: ExitSignals,
): { exit: boolean; reason?: ExitCondition; label?: string } {
  const always: ExitCondition[] = ["UNSUBSCRIBED", "SUPPRESSED"];
  const conditions = [...new Set([...(exitOn ?? []), ...always])];
  for (const condition of conditions) {
    if (signals[SIGNAL_OF[condition]]) {
      return { exit: true, reason: condition, label: exitLabels[condition] };
    }
  }
  return { exit: false };
}

/**
 * The key that makes an enrolment idempotent.
 *
 * `renewal:<companyProductId>` rather than `renewal:<companyId>`, because a customer with three
 * subscriptions has three renewal conversations — but the *same* subscription found again by
 * tomorrow's tick is the same conversation, not a second one. The same trick as
 * `Notification.dedupeKey`, against a unique index.
 */
export function enrolmentKey(trigger: string, subjectId: string, window?: number | null): string {
  const suffix = window === null || window === undefined ? "" : `:${window}`;
  return `${trigger}:${subjectId}${suffix}`;
}

const DAY = 86400000;

/** When the next step is due. Day granularity: nobody schedules nurture to the minute. */
export function stepDueAt(from: Date, delayDays: number): Date {
  return new Date(from.getTime() + Math.max(0, delayDays) * DAY);
}

export type StepLike = { id: string; order: number; delayDays: number };

/**
 * What happens after a step completes.
 *
 * Steps are addressed by their `order`, not their position in the array, so inserting a step into a
 * running journey doesn't silently shunt everybody onto the wrong message.
 */
export function advance(
  currentStep: number,
  steps: StepLike[],
  now: Date,
): { done: true } | { done: false; step: StepLike; dueAt: Date } {
  const remaining = steps.filter((s) => s.order > currentStep).sort((a, b) => a.order - b.order);
  const next = remaining[0];
  if (!next) return { done: true };
  return { done: false, step: next, dueAt: stepDueAt(now, next.delayDays) };
}

/** The first step, which is whichever has the lowest order — not necessarily order 1. */
export function firstStep(steps: StepLike[]): StepLike | null {
  return [...steps].sort((a, b) => a.order - b.order)[0] ?? null;
}

/**
 * Whether the same subject may enrol again.
 *
 * Null means never: a welcome sequence should run once in a customer's life. A number is for the
 * ones that genuinely recur — a renewal comes round every year, and blocking it forever would mean
 * the journey worked exactly once.
 */
export function mayReEnrol(params: {
  reEnrolAfterDays: number | null | undefined;
  lastEnrolledAt: Date | string | null;
  now?: Date;
}): { ok: boolean; reason: string } {
  if (params.lastEnrolledAt === null) return { ok: true, reason: "Never enrolled before." };
  if (params.reEnrolAfterDays === null || params.reEnrolAfterDays === undefined) {
    return { ok: false, reason: "This journey runs once per subject." };
  }
  const now = params.now ?? new Date();
  const since = Math.floor((now.getTime() - new Date(params.lastEnrolledAt).getTime()) / DAY);
  if (since >= params.reEnrolAfterDays) {
    return { ok: true, reason: `Last enrolled ${since} days ago.` };
  }
  return { ok: false, reason: `Enrolled ${since} days ago; this journey waits ${params.reEnrolAfterDays}.` };
}

/** Parses whatever is in the `exitOn` JSON column into conditions, ignoring anything unrecognised. */
export function parseExitConditions(value: unknown): ExitCondition[] {
  if (!Array.isArray(value)) return [];
  const known = new Set(Object.keys(exitLabels) as ExitCondition[]);
  return value.filter((v): v is ExitCondition => typeof v === "string" && known.has(v as ExitCondition));
}
