import type { FeedbackRequestStatus } from "@prisma/client";

/**
 * What a score means, and what happens next.
 *
 * Pure, because two decisions here are easy to get quietly wrong and expensive when they are. The
 * first is the boundary: "4 or above" has to mean 4, and an off-by-one sends a happy customer to
 * an apology or an unhappy one to a public review page. The second is that a response is recorded
 * whatever the score — the invitation is a thing that happens *after* the answer is saved, never
 * a branch that decides whether to save it.
 */

export const MIN_RATING = 1;
export const MAX_RATING = 5;

export const ratingLabels: Record<number, string> = {
  1: "Very poor",
  2: "Poor",
  3: "Okay",
  4: "Good",
  5: "Excellent",
};

export type RatingTone = "green" | "amber" | "red" | "default";

/**
 * Three bands, not five. A 3 is not a small 4 — it is somebody being polite about something that
 * went wrong, and colouring it green because it is above the midpoint hides exactly the responses
 * worth reading.
 */
export function ratingTone(rating: number | null | undefined): RatingTone {
  if (rating === null || rating === undefined) return "default";
  if (rating >= 4) return "green";
  if (rating === 3) return "amber";
  return "red";
}

export function clampRating(value: number): number {
  if (!Number.isFinite(value)) return MIN_RATING;
  return Math.min(MAX_RATING, Math.max(MIN_RATING, Math.round(value)));
}

export function isValidRating(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_RATING && value <= MAX_RATING;
}

// ─── The gate ─────────────────────────────────────────────────────────────────

export type ReviewInvitation = {
  /** Whether to put the public review page in front of them. */
  invite: boolean;
  url: string | null;
  /** Said plainly, because this is the decision somebody will come back to argue about. */
  reason: string;
};

/**
 * Whether this response earns an invitation to review publicly.
 *
 * The threshold is a setting rather than a constant for one reason worth stating: Google's review
 * policy prohibits *review gating* — soliciting reviews only from customers you already know are
 * happy. Setting `minRating` to 1 shows the link to everyone, which is the compliant setting;
 * anything higher filters by sentiment, which is what the policy is about. Either way the response
 * is stored here in full, so nothing is ever thrown away.
 */
export function reviewInvitation(params: {
  rating: number;
  minRating: number;
  reviewUrl: string | null | undefined;
}): ReviewInvitation {
  const url = params.reviewUrl?.trim() || null;
  if (!url) {
    return { invite: false, url: null, reason: "No public review page is set up, so there is nowhere to send them." };
  }

  const threshold = clampRating(params.minRating);
  if (!isValidRating(params.rating)) {
    return { invite: false, url, reason: "That isn't a score between 1 and 5." };
  }

  if (params.rating >= threshold) {
    return {
      invite: true,
      url,
      reason:
        threshold <= MIN_RATING
          ? "Everybody is offered the review page, whatever they scored."
          : `Rated ${params.rating}, which is at or above the ${threshold} set for offering a public review.`,
    };
  }

  return {
    invite: false,
    url,
    reason: `Rated ${params.rating}, below the ${threshold} set for offering a public review. It stays with us, and somebody should answer it.`,
  };
}

/** What the settings screen says about the threshold it is about to save. */
export function thresholdNote(minRating: number): { tone: "default" | "amber"; text: string } {
  const threshold = clampRating(minRating);
  if (threshold <= MIN_RATING) {
    return {
      tone: "default",
      text: "Every customer is offered the review page. This is what Google's review policy asks for — it prohibits soliciting reviews only from people you already know are happy.",
    };
  }
  return {
    tone: "amber",
    text: `Only customers who rate ${threshold} or more are offered the review page. Google's review policy prohibits this kind of filtering ("review gating") and can remove reviews or penalise the profile over it. Everything is still recorded here either way.`,
  };
}

// ─── Whether a link still works ───────────────────────────────────────────────

export type LinkState = {
  usable: boolean;
  key: "LIVE" | "ANSWERED" | "EXPIRED" | "CANCELLED";
  /** For us, on the internal screens. The public page deliberately says less — see the action. */
  label: string;
};

export function linkState(
  request: { status: FeedbackRequestStatus; expiresAt: Date | string | null; answered?: boolean },
  now: Date = new Date(),
): LinkState {
  if (request.status === "CANCELLED") return { usable: false, key: "CANCELLED", label: "Withdrawn" };
  if (request.status === "ANSWERED" || request.answered) {
    return { usable: false, key: "ANSWERED", label: "Answered" };
  }
  if (request.expiresAt && new Date(request.expiresAt) < now) {
    return { usable: false, key: "EXPIRED", label: "Expired" };
  }
  return { usable: true, key: "LIVE", label: "Waiting for a reply" };
}

// ─── Reading a pile of responses ──────────────────────────────────────────────

export function averageOf(values: (number | null | undefined)[]): number | null {
  const scores = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (scores.length === 0) return null;
  return Math.round((scores.reduce((t, v) => t + v, 0) / scores.length) * 100) / 100;
}

export type FeedbackSummary = {
  asked: number;
  answered: number;
  /** Of those asked, how many replied. The number that says whether the rest of this means anything. */
  responseRate: number | null;
  average: number | null;
  personAverage: number | null;
  serviceAverage: number | null;
  /** 1–5 → how many gave that score. */
  distribution: Record<number, number>;
  happy: number;
  unhappy: number;
  /** Low scores nobody has answered yet. */
  unanswered: number;
};

/**
 * The numbers a page shows above a list of responses.
 *
 * `responseRate` is in here rather than left to the caller because an average without it is
 * misleading in a specific direction: the people who don't reply are disproportionately the ones
 * who were unimpressed, so a 4.8 from three replies out of forty is not a 4.8.
 */
export function summarise(
  requests: {
    response: { rating: number; personRating: number | null; serviceRating: number | null; acknowledgedAt: Date | string | null } | null;
  }[],
): FeedbackSummary {
  const responses = requests.map((r) => r.response).filter((r): r is NonNullable<typeof r> => r !== null);
  const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of responses) {
    if (isValidRating(r.rating)) distribution[r.rating] += 1;
  }

  return {
    asked: requests.length,
    answered: responses.length,
    responseRate: requests.length === 0 ? null : Math.round((responses.length / requests.length) * 100),
    average: averageOf(responses.map((r) => r.rating)),
    personAverage: averageOf(responses.map((r) => r.personRating)),
    serviceAverage: averageOf(responses.map((r) => r.serviceRating)),
    distribution,
    happy: responses.filter((r) => r.rating >= 4).length,
    unhappy: responses.filter((r) => r.rating <= 3).length,
    // A 3 counts as needing an answer. Somebody who took the trouble to reply "okay" is telling
    // you something, and treating it as satisfied is how a business stops hearing anything.
    unanswered: responses.filter((r) => r.rating <= 3 && !r.acknowledgedAt).length,
  };
}

/** What a feedback request is about, in one line, for a list. */
export function subjectOf(request: {
  serviceLabel?: string | null;
  aboutUser?: { name: string } | null;
  ticket?: { title: string } | null;
  visit?: { purpose: string } | null;
  order?: { item: { name: string } } | null;
}): string {
  if (request.serviceLabel?.trim()) return request.serviceLabel.trim();
  if (request.ticket) return request.ticket.title;
  if (request.order) return request.order.item.name;
  if (request.visit) return "A site visit";
  if (request.aboutUser) return `Working with ${request.aboutUser.name}`;
  return "How we're doing";
}
