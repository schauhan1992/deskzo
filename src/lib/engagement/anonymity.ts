import type {
  InternalFeedbackKind,
  SurveyAudience,
  SurveyKind,
  SurveyQuestionKind,
  SurveyStatus,
} from "@prisma/client";

/**
 * The rules that make "anonymous" true rather than merely claimed.
 *
 * Pure, because these are the parts an employee is being asked to trust and the parts that fail
 * without anything going wrong on screen. A coarsening that keeps the time, or a threshold that
 * lets one response through, produces a working feature that quietly identifies people.
 */

/**
 * How few responses is too few to show a result.
 *
 * Five. Below that, a percentage and a headcount are simultaneous equations: "2 of 3 said no" in a
 * team of three names everybody. The threshold is applied to every breakdown, not only the total —
 * a company-wide result of two hundred is no protection at all if it can be sliced by a department
 * of four.
 */
export const MIN_RESPONSES_TO_REVEAL = 5;

export function resultsAreSafe(responseCount: number) {
  return responseCount >= MIN_RESPONSES_TO_REVEAL;
}

/** How many more are needed before anybody may see the answers. */
export function stillNeeded(responseCount: number) {
  return Math.max(0, MIN_RESPONSES_TO_REVEAL - responseCount);
}

/**
 * Today, with the time removed.
 *
 * Not a formatting nicety. A timestamp to the second, against a company of forty, correlates with
 * a login, a door swipe and an idle-time record — three things this application already stores.
 * The date is enough to sort by and too coarse to single anybody out.
 */
export function submissionDate(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** How many anonymous items one person may send in a day. Generous, and still not a flood. */
export const DAILY_FEEDBACK_LIMIT = 10;

export const feedbackKindLabels: Record<InternalFeedbackKind, string> = {
  PRAISE: "Praise",
  CONCERN: "Concern",
  SUGGESTION: "Suggestion",
  GRIEVANCE: "Grievance",
  OTHER: "Something else",
};

export const surveyKindLabels: Record<SurveyKind, string> = {
  FORM: "Form",
  POLL: "Poll",
  VOTE: "Vote",
};

export const surveyStatusLabels: Record<SurveyStatus, string> = {
  DRAFT: "Draft",
  OPEN: "Open",
  CLOSED: "Closed",
};

export const audienceLabels: Record<SurveyAudience, string> = {
  EVERYONE: "Everyone",
  DEPARTMENT: "Selected departments",
  INDIVIDUAL: "Selected people",
};

export const questionKindLabels: Record<SurveyQuestionKind, string> = {
  RATING: "Rating out of 5",
  SCALE_1_10: "Scale of 1 to 10",
  SINGLE_CHOICE: "Choose one",
  MULTI_CHOICE: "Choose any",
  YES_NO: "Yes or no",
  TEXT: "Written answer",
};

/** The kinds whose answers are a number, and can therefore be averaged. */
export function isNumeric(kind: SurveyQuestionKind) {
  return kind === "RATING" || kind === "SCALE_1_10" || kind === "YES_NO";
}

/** The kinds whose answers come from a fixed list, and can be counted per option. */
export function isChoice(kind: SurveyQuestionKind) {
  return kind === "SINGLE_CHOICE" || kind === "MULTI_CHOICE";
}

/**
 * Whether a survey is accepting answers right now.
 *
 * The expiry wins over the status, on purpose. A survey somebody forgot to close is closed on its
 * expiry date, because "we'll close it later" is how a form stays open for a year.
 */
export function isAcceptingResponses(
  survey: { status: SurveyStatus; opensAt: Date | null; expiresAt: Date | null },
  now: Date,
): boolean {
  if (survey.status !== "OPEN") return false;
  if (survey.opensAt && survey.opensAt > now) return false;
  if (survey.expiresAt && survey.expiresAt < now) return false;
  return true;
}

/** Whether this person is in a survey's audience. */
export function isTargeted(
  survey: { audience: SurveyAudience; targets: { userId: string | null; departmentId: string | null }[] },
  viewer: { id: string; departmentId: string | null },
): boolean {
  if (survey.audience === "EVERYONE") return true;
  if (survey.audience === "INDIVIDUAL") return survey.targets.some((t) => t.userId === viewer.id);
  return viewer.departmentId !== null && survey.targets.some((t) => t.departmentId === viewer.departmentId);
}

/**
 * Whether the blocking splash screen should appear.
 *
 * Mandatory, open, aimed at them, not yet answered, and not skipped in this session. The skip is
 * held per session rather than stored, so it returns next time they sign in — pressure without
 * trapping somebody who needs to get into the app right now.
 */
export function needsSplash(
  survey: { mandatory: boolean; status: SurveyStatus; opensAt: Date | null; expiresAt: Date | null },
  participation: { respondedAt: Date | null } | null,
  skippedThisSession: boolean,
  now: Date,
): boolean {
  if (!survey.mandatory) return false;
  if (!isAcceptingResponses(survey, now)) return false;
  if (participation?.respondedAt) return false;
  return !skippedThisSession;
}

export type QuestionResult =
  | { kind: "hidden"; needed: number }
  | { kind: "numeric"; average: number; count: number; distribution: { value: number; count: number }[] }
  | { kind: "choice"; options: { option: string; count: number; percent: number }[]; count: number }
  | { kind: "text"; answers: string[]; count: number };

/**
 * One question's results, or a refusal to show them.
 *
 * The refusal is the important branch. It is computed here rather than left to each screen, because
 * a threshold enforced in the page and forgotten in the export is not a threshold.
 *
 * Text answers are returned in the order given, which is the order the rows came back in — callers
 * shuffle them before display so that the reading order does not reconstruct the submission order,
 * and through it the roll.
 */
export function summarise(
  kind: SurveyQuestionKind,
  answers: { number: number | null; text: string | null; choices: string[] }[],
  options: string[],
  totalResponses: number,
): QuestionResult {
  if (!resultsAreSafe(totalResponses)) return { kind: "hidden", needed: stillNeeded(totalResponses) };

  if (isNumeric(kind)) {
    const numbers = answers.map((a) => a.number).filter((n): n is number => n !== null);
    const byValue = new Map<number, number>();
    for (const n of numbers) byValue.set(n, (byValue.get(n) ?? 0) + 1);
    return {
      kind: "numeric",
      count: numbers.length,
      average: numbers.length === 0 ? 0 : Math.round((numbers.reduce((a, b) => a + b, 0) / numbers.length) * 100) / 100,
      distribution: [...byValue].sort((a, b) => a[0] - b[0]).map(([value, count]) => ({ value, count })),
    };
  }

  if (isChoice(kind)) {
    const counts = new Map<string, number>(options.map((o) => [o, 0]));
    let picks = 0;
    for (const a of answers) {
      for (const c of a.choices) {
        counts.set(c, (counts.get(c) ?? 0) + 1);
        picks += 1;
      }
    }
    return {
      kind: "choice",
      count: answers.length,
      options: [...counts].map(([option, count]) => ({
        option,
        count,
        percent: picks === 0 ? 0 : Math.round((count / picks) * 100),
      })),
    };
  }

  const texts = answers.map((a) => a.text?.trim()).filter((t): t is string => !!t);
  return { kind: "text", answers: texts, count: texts.length };
}
