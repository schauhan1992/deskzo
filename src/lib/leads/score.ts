import type { ContactDesignation, LeadSource, LeadStatus } from "@prisma/client";
import { bandForCount } from "@/lib/company-size";

/**
 * How promising a lead is, out of 100 — and why.
 *
 * ## Additive, and every point explained
 *
 * A single opaque number gets ignored the first time it disagrees with a salesperson's instinct. So
 * the score is a sum of named parts, each with its reason — "Talking to a decision-maker +10",
 * "Gone quiet: 34 days since last contact −10" — and the lead page shows them. A number somebody can
 * argue with line by line is one they will use.
 *
 * Four parts, capped so no one of them can carry a lead on its own:
 *
 *   Fit         up to 30   is this the kind of customer who buys — size, existing relationship, who we talk to
 *   Intent      up to 35   are they actually asking — how they came, what it is worth, how soon it renews
 *   Engagement  up to 20   is the conversation alive — recent touches, a meeting held
 *   Stage       up to 15   how far along the pipeline it has got
 *
 * minus penalties for the two ways a live lead goes cold: silence, and a close date that has passed.
 *
 * ## Closed leads have no score
 *
 * Won and lost are outcomes, not predictions. They score null and grade CLOSED, and sort last.
 *
 * Pure: no database, no clock of its own — `now` is passed in, so every rule is checkable.
 */

export type LeadSignals = {
  status: LeadStatus;
  source: LeadSource;
  estimatedValue: number | null;
  expectedCloseDate: Date | null;
  createdAt: Date;
  employeeCount: number | null;
  /** The company already has at least one order with us. */
  isExistingCustomer: boolean;
  contactDesignation: ContactDesignation | null;
  requirementCount: number;
  /** The soonest renewal date among the lead's product lines, if any. */
  nearestRenewal: Date | null;
  /** Activities and calls logged against the lead in the last 14 days. */
  touchesLast14Days: number;
  meetingsHeld: number;
  /** The most recent activity or call — or null if there has never been one. */
  lastTouchAt: Date | null;
  now: Date;
};

export type ScoreFactor = { label: string; points: number };
export type LeadGrade = "HOT" | "WARM" | "COLD" | "CLOSED";
export type LeadScore = { score: number | null; grade: LeadGrade; factors: ScoreFactor[] };

export const GRADE_LABELS: Record<LeadGrade, string> = { HOT: "Hot", WARM: "Warm", COLD: "Cold", CLOSED: "Closed" };

const DAY = 24 * 60 * 60 * 1000;
const CLOSED: LeadStatus[] = ["WON", "LOST", "DISQUALIFIED"];

const SIZE_POINTS: Record<string, number> = {
  "1-10": 2,
  "11-50": 5,
  "51-200": 8,
  "201-500": 10,
};

const DESIGNATION_POINTS: Partial<Record<ContactDesignation, [number, string]>> = {
  CEO: [10, "Talking to a decision-maker"],
  CIO: [10, "Talking to a decision-maker"],
  DIRECTOR: [10, "Talking to a decision-maker"],
  IT_HEAD: [10, "Talking to a decision-maker"],
  IT_MANAGER: [6, "Talking to someone who influences the decision"],
  PURCHASE_MANAGER: [6, "Talking to someone who influences the decision"],
  HR: [2, "A contact, though not the buyer"],
  OTHER: [2, "A contact, though not the buyer"],
};

/** How warm each channel tends to be. A referral or an existing customer asking is worth more than a cold call. */
export const SOURCE_POINTS: Record<LeadSource, number> = {
  REFERRAL: 12,
  EXISTING_CUSTOMER: 12,
  WEBSITE: 10,
  WALK_IN: 8,
  EVENT: 8,
  PARTNER: 8,
  EMAIL: 5,
  LINKEDIN: 5,
  ADVERTISEMENT: 5,
  CALLING: 3,
  OTHER: 3,
};

const STAGE_POINTS: Partial<Record<LeadStatus, number>> = {
  CONTACTED: 3,
  QUALIFYING: 5,
  QUALIFIED: 8,
  PROPOSAL_SENT: 12,
  NEGOTIATION: 15,
};

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

export function gradeFor(score: number | null): LeadGrade {
  if (score === null) return "CLOSED";
  if (score >= 70) return "HOT";
  if (score >= 40) return "WARM";
  return "COLD";
}

export function scoreLead(s: LeadSignals): LeadScore {
  if (CLOSED.includes(s.status)) return { score: null, grade: "CLOSED", factors: [] };

  const factors: ScoreFactor[] = [];
  const add = (points: number, label: string) => {
    if (points !== 0) factors.push({ label, points });
  };

  // ── Fit ────────────────────────────────────────────────────────────────────────────────────
  const band = bandForCount(s.employeeCount);
  if (band) add(SIZE_POINTS[band.key] ?? 12, `${band.label} employees`);
  if (s.isExistingCustomer) add(8, "Already a customer");
  const designation = s.contactDesignation ? DESIGNATION_POINTS[s.contactDesignation] : undefined;
  if (designation) add(designation[0], designation[1]);

  // ── Intent ─────────────────────────────────────────────────────────────────────────────────
  add(SOURCE_POINTS[s.source], `Came in by ${sourceWords(s.source)}`);
  const value = s.estimatedValue ?? 0;
  if (value >= 1_000_000) add(12, `Worth ${inr(value)}`);
  else if (value >= 200_000) add(9, `Worth ${inr(value)}`);
  else if (value >= 50_000) add(6, `Worth ${inr(value)}`);
  else if (value > 0) add(3, `Worth ${inr(value)}`);
  if (s.requirementCount > 0) add(5, `${s.requirementCount} product${s.requirementCount === 1 ? "" : "s"} named`);
  if (s.nearestRenewal) {
    const days = Math.ceil((s.nearestRenewal.getTime() - s.now.getTime()) / DAY);
    if (days >= 0 && days <= 90) add(6, `Renewal due in ${days} day${days === 1 ? "" : "s"}`);
  }

  // ── Engagement ─────────────────────────────────────────────────────────────────────────────
  if (s.touchesLast14Days >= 4) add(14, `${s.touchesLast14Days} touches in the last two weeks`);
  else if (s.touchesLast14Days >= 2) add(10, `${s.touchesLast14Days} touches in the last two weeks`);
  else if (s.touchesLast14Days === 1) add(6, "Touched in the last two weeks");
  if (s.meetingsHeld > 0) add(6, "A meeting has been held");

  // ── Stage ──────────────────────────────────────────────────────────────────────────────────
  const stage = STAGE_POINTS[s.status];
  if (stage) add(stage, `At ${s.status.replaceAll("_", " ").toLowerCase()}`);

  // ── Going cold ─────────────────────────────────────────────────────────────────────────────
  // Silence is measured from the last touch, or from creation for a lead nobody has touched — a
  // brand-new lead is not "quiet", but one a month old with no call logged certainly is.
  const since = s.lastTouchAt ?? s.createdAt;
  const quietDays = Math.floor((s.now.getTime() - since.getTime()) / DAY);
  if (quietDays >= 30) add(-10, `Gone quiet: ${quietDays} days since ${s.lastTouchAt ? "the last contact" : "it came in"}`);
  if (s.expectedCloseDate && s.expectedCloseDate.getTime() < s.now.getTime() - DAY) {
    add(-8, "Expected close date has passed");
  }

  const score = Math.max(0, Math.min(100, factors.reduce((sum, f) => sum + f.points, 0)));
  return { score, grade: gradeFor(score), factors };
}

function sourceWords(source: LeadSource): string {
  return (
    {
      WEBSITE: "the website",
      REFERRAL: "referral",
      LINKEDIN: "LinkedIn",
      CALLING: "a call we made",
      EMAIL: "email",
      EVENT: "an event",
      PARTNER: "a partner",
      ADVERTISEMENT: "an advert",
      EXISTING_CUSTOMER: "an existing customer",
      WALK_IN: "walking in",
      OTHER: "another route",
    } satisfies Record<LeadSource, string>
  )[source];
}
