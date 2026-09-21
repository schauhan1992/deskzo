import { z } from "zod";
import { MAX_RATING, MIN_RATING } from "@/lib/feedback/rating";

/**
 * What a customer may send us without signing in.
 *
 * Lives outside `src/actions` because a `"use server"` module may only export async functions.
 * Deliberately small: a token, three numbers and a comment. The form asks for nothing that would
 * identify anybody, because everything we know about who this is already came from the request.
 */

const score = z.number().int().min(MIN_RATING).max(MAX_RATING);

export const feedbackSubmissionSchema = z.object({
  token: z.string().trim().min(10),
  rating: score,
  /** Only asked where the request named somebody, so it may be absent rather than zero. */
  personRating: score.nullish(),
  serviceRating: score.nullish(),
  comment: z.string().trim().max(2000).optional().or(z.literal("")),
});

export type FeedbackSubmission = z.infer<typeof feedbackSubmissionSchema>;

/** A review destination has to be a real https address, or the thank-you page links nowhere. */
export const reviewUrlSchema = z
  .string()
  .trim()
  .url("That isn't a web address — paste the whole link, starting with https://")
  .refine((v) => /^https:\/\//i.test(v), "A review link has to start with https://")
  .optional()
  .or(z.literal(""));
