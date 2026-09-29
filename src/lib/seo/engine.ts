import { AEO_CHECKS } from "@/lib/seo/checks/aeo";
import { GEO_CHECKS } from "@/lib/seo/checks/geo";
import { SEO_CHECKS } from "@/lib/seo/checks/seo";
import { isExcluded } from "@/lib/seo/checks/util";
import { analyseKeywords } from "@/lib/seo/keywords";
import type { CheckDef, CheckOutcome, CheckResult, EntityScore, ScoreBreakdown, SeoInput, SeoLabel } from "@/lib/seo/types";

/**
 * The scoring engine: runs a registry's checks on one input and turns them into scores.
 *
 *   · A category's score is 100 × points earned ÷ points available, over the checks that apply to
 *     the entity's kind and were scored (PASS, WARNING, FAIL) — INFO and NOT_APPLICABLE count for
 *     nothing either way. Rounded, clamped to 0–100; with nothing scored it is 100, and says so.
 *   · The overall score weighs SEO, AEO and GEO by `WEIGHTS` (50/25/25).
 *   · Intentional noindex is never a failure: the entity is `excluded`, its robots and indexability
 *     checks say so as INFO, and the checks that only matter for indexed pages do not apply.
 *   · Deterministic: the same input gives the same output — no clock, no randomness, no state.
 */

/**
 * The engine's version, stored with every cached score (control `seo_scores.engineVersion`): a score
 * calculated by another version is stale, and the dashboard recalculates it. **Bump it whenever a
 * check, a weight, a threshold, a label band or an extractor changes what a score comes out as** —
 * otherwise the dashboard keeps showing scores the engine no longer gives. A whole number, from 1.
 */
export const ENGINE_VERSION = 1;

/** How the three categories make up the overall score. Change them here; they need not sum to 1. */
export const WEIGHTS = { seo: 0.5, aeo: 0.25, geo: 0.25 } as const;
export type CategoryWeights = { seo: number; aeo: number; geo: number };

/** The score bands, highest first: a score is labelled by the first band it reaches. */
export const LABEL_BANDS: readonly { min: number; label: SeoLabel }[] = [
  { min: 80, label: "Excellent" },
  { min: 60, label: "Good" },
  { min: 40, label: "Needs improvement" },
  { min: 0, label: "Poor" },
];

/** 0–39 Poor, 40–59 Needs improvement, 60–79 Good, 80–100 Excellent. */
export function labelFor(score: number): SeoLabel {
  const s = Number.isFinite(score) ? score : 0;
  return LABEL_BANDS.find((b) => s >= b.min)?.label ?? "Poor";
}

/** A whole number from 0 to 100; anything not a number is 0. */
export function clampScore(n: number): number {
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0;
}

export const ALL_CHECKS: readonly CheckDef[] = [...SEO_CHECKS, ...AEO_CHECKS, ...GEO_CHECKS];

/** A check by its id, for a label or its weight. */
export function checkDef(id: string): CheckDef | undefined {
  return ALL_CHECKS.find((d) => d.id === id);
}

const EXCLUDED_MESSAGE = "Not scored: intentionally excluded from search.";

/** One check on one input: its outcome, with the points it may earn and the points it did (0 for INFO and NOT_APPLICABLE). */
export function runCheck(def: CheckDef, input: SeoInput): CheckResult {
  const base = { id: def.id, category: def.category, group: def.group, label: def.label };
  let out: CheckOutcome;
  if (def.indexedOnly && isExcluded(input)) {
    out = { status: "NOT_APPLICABLE", pointsEarned: 0, message: EXCLUDED_MESSAGE, recommendation: "" };
  } else {
    try {
      out = def.evaluate(input, def.weight);
    } catch (err) {
      out = { status: "INFO", pointsEarned: 0, message: `This check could not run: ${err instanceof Error ? err.message : String(err)}`, recommendation: "" };
    }
  }
  const scored = out.status === "PASS" || out.status === "WARNING" || out.status === "FAIL";
  const available = scored ? Math.max(0, def.weight) : 0;
  const earned = scored && out.status !== "FAIL" && Number.isFinite(out.pointsEarned) ? Math.min(available, Math.max(0, out.pointsEarned)) : 0;
  const warned = out.status === "FAIL" || out.status === "WARNING";
  return {
    ...base,
    status: out.status,
    pointsEarned: earned,
    pointsAvailable: available,
    message: out.message,
    recommendation: out.recommendation,
    ...(out.field ? { field: out.field } : {}),
    ...(warned && out.severity ? { severity: out.severity } : {}),
  };
}

/** A registry's checks for this input's kind, and the score they make. */
export function scoreCategory(defs: readonly CheckDef[], input: SeoInput): ScoreBreakdown {
  const checks = defs.filter((d) => d.applicableTo.includes(input.kind)).map((d) => runCheck(d, input));
  const available = checks.reduce((n, c) => n + c.pointsAvailable, 0);
  const earned = checks.reduce((n, c) => n + c.pointsEarned, 0);
  if (available <= 0) {
    const note = isExcluded(input) ? "Nothing here is scored: the page is intentionally excluded from search, so it counts as 100." : "No scored checks apply to this page, so it counts as 100.";
    return { score: 100, maxScore: 100, checks, note };
  }
  return { score: clampScore((100 * earned) / available), maxScore: 100, checks, note: null };
}

/** The overall score from the three category scores, weighed by `weights`. */
export function overallScore(scores: { seo: number; aeo: number; geo: number }, weights: CategoryWeights = WEIGHTS): number {
  const total = weights.seo + weights.aeo + weights.geo;
  if (!(total > 0)) return 0;
  return clampScore((scores.seo * weights.seo + scores.aeo * weights.aeo + scores.geo * weights.geo) / total);
}

/** Every check on one entity: SEO, AEO and GEO scores, the overall score and its label, the counts, the keyword analysis. */
export function scoreEntity(input: SeoInput, weights: CategoryWeights = WEIGHTS): EntityScore {
  const seo = scoreCategory(SEO_CHECKS, input);
  const aeo = scoreCategory(AEO_CHECKS, input);
  const geo = scoreCategory(GEO_CHECKS, input);
  const overall = overallScore({ seo: seo.score, aeo: aeo.score, geo: geo.score }, weights);
  const all = [...seo.checks, ...aeo.checks, ...geo.checks];
  return {
    seo,
    aeo,
    geo,
    overall,
    label: labelFor(overall),
    excluded: isExcluded(input),
    critical: all.filter((c) => c.severity === "critical").length,
    warnings: all.filter((c) => c.status === "WARNING").length,
    keywords: analyseKeywords(input),
  };
}
