import type { LeadStatus } from "@prisma/client";

/**
 * How much a deal at each stage is worth to the forecast — learned from what actually happened.
 *
 * ## The question
 *
 * "Of the deals that got as far as this stage, how many did we win?" Asked of every lead closed in
 * the last twelve months. A deal that reached Negotiation also got past Proposal, so it counts
 * towards both: the cohort for a stage is every closed deal whose *furthest* open stage was that
 * one or later. That makes the rates rise stage by stage, as they should — and where a small
 * sample makes them wobble, they are evened out so a later stage is never worth less than an
 * earlier one.
 *
 * ## Where the stages come from
 *
 * Every stage change writes an activity — "Status changed from QUALIFIED to PROPOSAL_SENT" — and
 * that is the history read here. A deal closed without ever changing stage was closed from the one
 * it was created at, which is New unless its history says otherwise.
 *
 * ## Not enough history
 *
 * A stage with fewer than `MIN_SAMPLE` closed deals behind it is not learned from; it uses the
 * standard figure, and the screen says so. An admin can override any stage outright.
 *
 * Pure, so `check:forecast` can hold it without a database.
 */

export const OPEN_STAGES = ["NEW", "CONTACTED", "QUALIFYING", "QUALIFIED", "PROPOSAL_SENT", "NEGOTIATION"] as const;
export type OpenStage = (typeof OPEN_STAGES)[number];
export const CLOSED_STAGES: LeadStatus[] = ["WON", "LOST", "DISQUALIFIED"];

export const STAGE_LABEL: Record<OpenStage, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  QUALIFYING: "Qualifying",
  QUALIFIED: "Qualified",
  PROPOSAL_SENT: "Proposal sent",
  NEGOTIATION: "Negotiation",
};

/** Used until a stage has history enough to learn from. The usual B2B shape, not anybody's truth. */
export const DEFAULT_WEIGHTS: Record<OpenStage, number> = {
  NEW: 5,
  CONTACTED: 10,
  QUALIFYING: 20,
  QUALIFIED: 30,
  PROPOSAL_SENT: 50,
  NEGOTIATION: 75,
};

export const MIN_SAMPLE = 10;

export function isOpenStage(status: string): status is OpenStage {
  return (OPEN_STAGES as readonly string[]).includes(status);
}

/** "Status changed from QUALIFIED to PROPOSAL_SENT: price" → the two stages. */
export function parseStageChange(note: string): { from: string; to: string } | null {
  const match = /Status changed from ([A-Z_]+) to ([A-Z_]+)/.exec(note);
  return match ? { from: match[1]!, to: match[2]! } : null;
}

/**
 * The furthest open stage a lead ever sat in, from its stage-change history (oldest first).
 * A lead with no history was created at New — the default every lead is created with.
 */
export function furthestOpenStage(changes: { from: string; to: string }[]): OpenStage {
  let furthest = 0;
  const seen = changes.length ? [changes[0]!.from, ...changes.map((c) => c.to)] : ["NEW"];
  for (const status of seen) {
    const index = (OPEN_STAGES as readonly string[]).indexOf(status);
    if (index > furthest) furthest = index;
  }
  return OPEN_STAGES[furthest]!;
}

export type StageWeight = {
  stage: OpenStage;
  label: string;
  /** What the forecast uses. */
  percent: number;
  /** Won ÷ closed among deals that reached this stage, when there were enough of them. */
  learned: number | null;
  /** How many closed deals the learned figure rests on. */
  sample: number;
  source: "learned" | "standard" | "override";
};

export function learnWeights(
  closed: { furthest: OpenStage; won: boolean }[],
  overrides: Partial<Record<OpenStage, number>> = {},
): StageWeight[] {
  let floor = 0;
  return OPEN_STAGES.map((stage, index) => {
    const cohort = closed.filter((c) => OPEN_STAGES.indexOf(c.furthest) >= index);
    const won = cohort.filter((c) => c.won).length;
    const learned = cohort.length >= MIN_SAMPLE ? Math.round((won / cohort.length) * 100) : null;
    // Evened out upwards: a later stage is never worth less than an earlier one.
    const base = Math.max(floor, learned ?? DEFAULT_WEIGHTS[stage]);
    floor = base;
    const override = overrides[stage];
    const hasOverride = override !== undefined && override !== null;
    return {
      stage,
      label: STAGE_LABEL[stage],
      percent: hasOverride ? Math.max(0, Math.min(100, Math.round(override))) : base,
      learned,
      sample: cohort.length,
      source: hasOverride ? "override" : learned !== null ? "learned" : "standard",
    };
  });
}

export function weightMap(weights: StageWeight[]): Record<OpenStage, number> {
  return Object.fromEntries(weights.map((w) => [w.stage, w.percent])) as Record<OpenStage, number>;
}
