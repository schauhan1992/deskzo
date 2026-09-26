"use server";

import { db } from "@/lib/db";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { getOrganisation } from "@/lib/organisation";
import { notifyUser } from "@/lib/notify";
import { linkState, reviewInvitation, subjectOf } from "@/lib/feedback/rating";
import { feedbackSubmissionSchema } from "@/lib/validation/feedback";
import type { ActionResult } from "@/actions/company";

/**
 * The feedback form, filled in by a customer who has no account here.
 *
 * The second module in the app that serves somebody who isn't signed in (the first is the new-joiner
 * intake), so the same rules apply and are worth restating:
 *
 *   · The token *is* the authentication. 192 bits of randomness, it expires, and it stops working
 *     the moment it is answered — so a forwarded link is worthless afterwards.
 *   · It grants exactly one capability: answer this one request, once. It reads nothing else, and
 *     what it returns is the customer's own name, our name, and what they were asked about — all
 *     of which whoever holds the link already knows, because they were sent it.
 *   · A bad token is indistinguishable from an expired, withdrawn or already-answered one. The
 *     page says the same thing for all four, so it cannot be used to work out which tokens exist.
 *   · There is no rate limiting here, and it doesn't need any: guessing a 192-bit token is not a
 *     thing that happens. What would need it is a form that took an id.
 *
 * The one ordering rule that matters: **the response is written before anything is decided about
 * where they go next.** A customer who rates us 2 and a customer who rates us 5 are recorded by the
 * same code path; the review invitation is worked out afterwards, from what was saved.
 */

/** What the form needs to render itself, and nothing more. */
export async function getFeedbackForm(token: string) {
  if (!token || token.length < 10) return null;
  // Outside the plan, or switched off: the same as a link that never worked.
  if (!(await moduleAvailableForTenant("feedback"))) return null;

  const request = await db.feedbackRequest.findUnique({
    where: { token },
    select: {
      id: true,
      status: true,
      expiresAt: true,
      message: true,
      serviceLabel: true,
      sentToName: true,
      company: { select: { name: true } },
      aboutUser: { select: { name: true } },
      ticket: { select: { title: true } },
      visit: { select: { purpose: true } },
      order: { select: { item: { select: { name: true } } } },
      response: { select: { id: true } },
    },
  });
  if (!request) return null;

  const state = linkState({ status: request.status, expiresAt: request.expiresAt, answered: !!request.response });
  if (!state.usable) return null;

  const org = await getOrganisation();
  return {
    // The first name only. "Hello Rajesh" reads like a person wrote it; the rest of what we hold
    // about Rajesh is none of this page's business.
    greetingName: request.sentToName?.trim().split(/\s+/)[0] ?? null,
    companyName: request.company.name,
    ourName: org.tradeName || org.legalName || "us",
    intro: org.feedbackIntro,
    message: request.message,
    subject: subjectOf(request),
    // Which extra questions to show. Asking "how was the engineer" when nobody was named would be
    // asking about a person the customer never met.
    askAboutPerson: request.aboutUser?.name ?? null,
    askAboutService: request.serviceLabel || request.ticket || request.order || request.visit ? subjectOf(request) : null,
  };
}

export type FeedbackOutcome = {
  /** Always true by the time this returns — the response is saved before this is worked out. */
  recorded: true;
  invite: boolean;
  reviewUrl: string | null;
  rating: number;
  ourName: string;
};

export async function submitFeedback(input: unknown): Promise<ActionResult<FeedbackOutcome>> {
  const parsed = feedbackSubmissionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Please pick a rating." };
  }
  const { token, rating, personRating, serviceRating, comment } = parsed.data;
  if (!(await moduleAvailableForTenant("feedback"))) return { ok: false, error: "This feedback link is no longer active." };

  const request = await db.feedbackRequest.findUnique({
    where: { token },
    select: {
      id: true,
      status: true,
      expiresAt: true,
      companyId: true,
      aboutUserId: true,
      requestedById: true,
      reference: true,
      company: { select: { id: true, name: true, ownerUserId: true } },
      response: { select: { id: true } },
    },
  });

  // One message for every reason a link might not work — a form that distinguished "already
  // answered" from "no such link" would be an oracle for which tokens are real.
  const unusable = { ok: false as const, error: "This feedback link is no longer open." };
  if (!request) return unusable;
  const state = linkState({ status: request.status, expiresAt: request.expiresAt, answered: !!request.response });
  if (!state.usable) return unusable;

  const org = await getOrganisation();
  const invitation = reviewInvitation({
    rating,
    minRating: org.feedbackReviewMinRating,
    reviewUrl: org.feedbackReviewUrl,
  });

  // Saved first, and in one transaction with the status change so a response can never exist
  // against a request that still looks open — or the reverse, which would lose the answer.
  await db.$transaction(async (tx) => {
    await tx.feedbackResponse.create({
      data: {
        requestId: request.id,
        rating,
        personRating: personRating ?? null,
        serviceRating: serviceRating ?? null,
        comment: comment?.trim() || null,
        reviewInvited: invitation.invite,
        // Frozen. Changing the threshold next month must not rewrite whether this person was asked.
        reviewMinRatingAtTime: org.feedbackReviewMinRating,
      },
    });
    await tx.feedbackRequest.update({
      where: { id: request.id },
      data: { status: "ANSWERED" },
    });
  });

  // Told to the people who can do something about it: whoever the feedback is about, whoever asked
  // for it, and whoever owns the account. A low score that sits unread is the whole failure mode
  // this module exists to prevent.
  const tell = new Set(
    [request.aboutUserId, request.requestedById, request.company.ownerUserId].filter(
      (id): id is string => typeof id === "string",
    ),
  );
  const stars = "★".repeat(rating) + "☆".repeat(5 - rating);
  for (const userId of tell) {
    await notifyUser({
      userId,
      type: "FEEDBACK_RECEIVED",
      title: rating <= 3 ? `${request.company.name} rated us ${rating}/5` : `${request.company.name} left feedback`,
      message: `${stars}${comment?.trim() ? ` — “${comment.trim().slice(0, 140)}”` : ""}`,
      link: `/feedback?requestId=${request.id}`,
    });
  }

  return {
    ok: true,
    data: {
      recorded: true,
      invite: invitation.invite,
      reviewUrl: invitation.invite ? invitation.url : null,
      rating,
      ourName: org.tradeName || org.legalName || "us",
    },
  };
}

/**
 * They went on to the public review page.
 *
 * Worth recording because it is the only way to tell an invitation that worked from one that was
 * ignored — and without it, "we sent forty people to Google" is a guess.
 */
export async function noteReviewOpened(token: string): Promise<ActionResult<null>> {
  if (!token || token.length < 10) return { ok: true, data: null };
  if (!(await moduleAvailableForTenant("feedback"))) return { ok: true, data: null };
  const request = await db.feedbackRequest.findUnique({
    where: { token },
    select: { response: { select: { id: true, reviewInvited: true, reviewOpenedAt: true } } },
  });
  // Silent about every failure: this is fired by a click on a thank-you page, and an error message
  // there would be about us rather than about them.
  if (!request?.response || !request.response.reviewInvited || request.response.reviewOpenedAt) {
    return { ok: true, data: null };
  }
  await db.feedbackResponse.update({
    where: { id: request.response.id },
    data: { reviewOpenedAt: new Date() },
  });
  return { ok: true, data: null };
}
