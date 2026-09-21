"use client";

import { useEffect, useState, useTransition } from "react";
import { ExternalLink, Heart } from "lucide-react";
import type { getFeedbackForm, FeedbackOutcome } from "@/actions/feedback-public";
import { noteReviewOpened, submitFeedback } from "@/actions/feedback-public";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";
import { OutboundLink } from "@/components/ui/outbound-link";
import { StarPicker } from "@/components/feedback/star-picker";

type FormInfo = NonNullable<Awaited<ReturnType<typeof getFeedbackForm>>>;

/** How long the thank-you page waits before taking a happy customer on to the review page. */
const REDIRECT_SECONDS = 6;

/**
 * The form a customer fills in, on their phone, from a link in a WhatsApp message.
 *
 * Written for that: one question above the fold, big targets, nothing to log into, and no field
 * that asks them for anything we already know. The extra questions about a person and about the
 * work are only shown when the request named them — asking "how was the engineer" when nobody was
 * named is asking about somebody they never met.
 */
export function FeedbackForm({ token, info }: { token: string; info: FormInfo }) {
  const [rating, setRating] = useState<number | null>(null);
  const [personRating, setPersonRating] = useState<number | null>(null);
  const [serviceRating, setServiceRating] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<FeedbackOutcome | null>(null);

  if (outcome) return <ThankYou outcome={outcome} token={token} />;

  return (
    <Card className="mx-auto max-w-lg">
      <CardContent className="space-y-6 py-6">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-text">
            {info.greetingName ? `Hello ${info.greetingName},` : "Hello,"}
          </h1>
          <p className="text-sm text-muted">
            {info.intro?.trim() ||
              `We'd like to know how we did. It takes about a minute, and it goes straight to the people who can act on it.`}
          </p>
          {info.message && (
            <p className="rounded-lg bg-surface-sunken px-3 py-2 text-sm text-muted">{info.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="overall">
            Overall, how was your experience with {info.ourName}?
          </Label>
          <p className="text-xs text-subtle">{info.subject}</p>
          <StarPicker name="overall" value={rating} onChange={setRating} />
        </div>

        {info.askAboutPerson && (
          <div className="space-y-2 border-t border-line pt-4">
            <Label>How was {info.askAboutPerson} to deal with?</Label>
            <StarPicker name="person" value={personRating} onChange={setPersonRating} size="sm" />
          </div>
        )}

        {info.askAboutService && (
          <div className="space-y-2 border-t border-line pt-4">
            <Label>And the work itself?</Label>
            <p className="text-xs text-subtle">{info.askAboutService}</p>
            <StarPicker name="service" value={serviceRating} onChange={setServiceRating} size="sm" />
          </div>
        )}

        <div className="space-y-1.5 border-t border-line pt-4">
          <Label htmlFor="comment">Anything you&apos;d like to add?</Label>
          <Textarea
            id="comment"
            rows={4}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={
              rating !== null && rating <= 3
                ? "What went wrong? We read all of these."
                : "Optional — but it's the part we learn the most from."
            }
          />
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <Button
          className="w-full"
          disabled={pending || rating === null}
          onClick={() => {
            if (rating === null) return;
            setError(null);
            startTransition(async () => {
              const result = await submitFeedback({
                token,
                rating,
                personRating: personRating ?? undefined,
                serviceRating: serviceRating ?? undefined,
                comment,
              });
              if (!result.ok) {
                setError(result.error);
                return;
              }
              setOutcome(result.data);
            });
          }}
        >
          {pending ? "Sending…" : "Send my feedback"}
        </Button>

        <p className="text-center text-xs text-subtle">
          Your answer goes to {info.ourName} and nobody else.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * What they see the moment it is saved.
 *
 * The score has already been recorded by the time this renders — it is not a branch that decides
 * whether to keep the answer, only where the person goes next.
 */
function ThankYou({ outcome, token }: { outcome: FeedbackOutcome; token: string }) {
  const [staying, setStaying] = useState(false);
  const [left, setLeft] = useState(REDIRECT_SECONDS);
  const url = outcome.reviewUrl;
  const redirecting = outcome.invite && !!url && !staying;

  useEffect(() => {
    if (!redirecting || !url) return;
    const tick = setInterval(() => setLeft((n) => n - 1), 1000);
    const go = setTimeout(() => {
      void noteReviewOpened(token);
      // Safe to navigate the page itself: this route sets `referrer: "no-referrer"`, so the token
      // in this URL is not handed to the far end. Without that it would be, in a request header.
      window.location.href = url;
    }, REDIRECT_SECONDS * 1000);
    return () => {
      clearInterval(tick);
      clearTimeout(go);
    };
  }, [redirecting, url, token]);

  if (outcome.invite && url) {
    return (
      <Card className="mx-auto max-w-lg">
        <CardContent className="space-y-5 py-10 text-center">
          <Heart className="mx-auto h-8 w-8 text-danger" aria-hidden />
          <div className="space-y-1">
            <h1 className="text-lg font-semibold text-text">Thank you — that&apos;s recorded.</h1>
            <p className="text-sm text-muted">
              Since it went well, would you say so publicly? It takes a moment and it genuinely helps a small
              business.
            </p>
          </div>

          <OutboundLink
            href={url}
            onClick={() => void noteReviewOpened(token)}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white hover:opacity-90"
          >
            Leave a review
            <ExternalLink className="h-3.5 w-3.5" />
          </OutboundLink>

          {redirecting ? (
            <p className="text-xs text-subtle">
              Taking you there in {Math.max(0, left)}s ·{" "}
              <button type="button" className="underline hover:text-text" onClick={() => setStaying(true)}>
                stay here
              </button>
            </p>
          ) : (
            <p className="text-xs text-subtle">No pressure — your feedback is already saved either way.</p>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mx-auto max-w-lg">
      <CardContent className="space-y-3 py-12 text-center">
        <h1 className="text-lg font-semibold text-text">Thank you — that&apos;s recorded.</h1>
        <p className="text-sm text-muted">
          {outcome.rating <= 3
            ? `That wasn't good enough, and somebody at ${outcome.ourName} will be in touch about it.`
            : `We appreciate you taking the time.`}
        </p>
      </CardContent>
    </Card>
  );
}
