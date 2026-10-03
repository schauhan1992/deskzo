"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Copy, MessageSquareQuote, X } from "lucide-react";
import type { listFeedback } from "@/actions/feedback";
import { acknowledgeFeedback, cancelFeedbackRequest, feedbackLink } from "@/actions/feedback";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { RatingStars } from "@/components/feedback/feedback-summary";
import { linkState, ratingLabels, ratingTone, subjectOf } from "@/lib/feedback/rating";
import { useClock } from "@/components/time/clock-provider";

type Row = Awaited<ReturnType<typeof listFeedback>>["rows"][number];

/**
 * What customers said, and what we sent that nobody answered.
 *
 * Both in one list on purpose. A page showing only the answers reads far better than the business
 * is doing — the requests that went quiet are the ones worth chasing, and separating them onto
 * another tab is how they stop being looked at.
 */
export function FeedbackList({
  rows,
  origin,
  showCompany = true,
  emptyHint,
}: {
  rows: Row[];
  origin: string;
  showCompany?: boolean;
  emptyHint?: string;
}) {
  if (rows.length === 0) {
    return (
      <Card className="px-4 py-12 text-center">
        <MessageSquareQuote className="mx-auto mb-2 h-5 w-5 text-subtle" />
        <p className="text-sm text-subtle">{emptyHint ?? "Nothing here yet."}</p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <FeedbackRow key={row.id} row={row} origin={origin} showCompany={showCompany} />
      ))}
    </div>
  );
}

function FeedbackRow({ row, origin, showCompany }: { row: Row; origin: string; showCompany: boolean }) {
  const router = useRouter();
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  const [answering, setAnswering] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Fetched only when somebody asks for it — a token is a live credential, and the list never
  // carries one. See `feedbackLink` for why.
  const [link, setLink] = useState<string | null>(null);

  const response = row.response;
  const state = linkState({ status: row.status, expiresAt: row.expiresAt, answered: !!response });

  return (
    <Card className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {showCompany && (
              <Link href={`/companies/${row.company.id}`} className="text-sm font-medium text-brand hover:underline">
                {row.company.name}
              </Link>
            )}
            <span className="font-mono text-[11px] text-subtle">{row.reference}</span>
            {response ? (
              <Badge tone={ratingTone(response.rating)}>
                {response.rating}/5 · {ratingLabels[response.rating]}
              </Badge>
            ) : (
              <Badge tone={state.key === "LIVE" ? "default" : "red"}>{state.label}</Badge>
            )}
            {response?.reviewInvited && (
              <Badge tone="blue">
                {response.reviewOpenedAt ? "Went to the review page" : "Offered the review page"}
              </Badge>
            )}
          </div>

          <p className="text-sm text-text">{subjectOf(row)}</p>

          <p className="text-xs text-subtle">
            {row.sentToName ? `Asked ${row.sentToName}` : "Asked"}
            {row.aboutUser && ` · about ${row.aboutUser.name}`}
            {row.sentAt && ` · sent ${clock.date(row.sentAt)}`}
            {response && ` · replied ${clock.date(response.submittedAt)}`}
          </p>
        </div>

        {response && (
          <div className="shrink-0 text-right">
            <RatingStars rating={response.rating} />
            {(response.personRating !== null || response.serviceRating !== null) && (
              <div className="mt-1 space-y-0.5 text-[11px] text-subtle">
                {response.personRating !== null && row.aboutUser && (
                  <div>
                    {row.aboutUser.name}: {response.personRating}/5
                  </div>
                )}
                {response.serviceRating !== null && <div>The work: {response.serviceRating}/5</div>}
              </div>
            )}
          </div>
        )}
      </div>

      {response?.comment && (
        <blockquote className="mt-3 border-l-2 border-line pl-3 text-sm text-muted">
          &ldquo;{response.comment}&rdquo;
        </blockquote>
      )}

      {/* Closing the loop. Shown for anything at 3 or below, because a reply of "okay" is somebody
          being polite about a problem — treating it as satisfied is how a business stops hearing. */}
      {response && response.rating <= 3 && (
        <div className="mt-3 rounded-lg bg-surface-sunken px-3 py-2">
          {response.acknowledgedAt ? (
            <p className="text-xs text-muted">
              <span className="font-medium text-text">Answered</span> by {response.acknowledgedBy?.name ?? "somebody"}{" "}
              on {clock.date(response.acknowledgedAt)} — {response.actionNote}
            </p>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-warning">Nobody has answered this one yet.</p>
              <Button size="sm" variant="secondary" onClick={() => setAnswering(true)}>
                Record what was done
              </Button>
            </div>
          )}
        </div>
      )}

      {/* An unanswered request is still a live link, so it can be copied again or withdrawn. */}
      {!response && state.key === "LIVE" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {link ? (
            <>
              {/* One of these per feedback card, so the name carries the reference to tell them apart. */}
              <Input
                readOnly
                value={`${origin}${link}`}
                aria-label={`Feedback link for ${row.reference}`}
                className="h-8 max-w-sm font-mono text-[11px]"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  navigator.clipboard.writeText(`${origin}${link}`).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  });
                }}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await feedbackLink(row.id);
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  setLink(result.data.url);
                });
              }}
            >
              <Copy className="mr-1 h-3 w-3" />
              Show the link again
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              startTransition(async () => {
                const result = await cancelFeedbackRequest(row.id);
                if (!result.ok) setError(result.error);
                router.refresh();
              });
            }}
          >
            <X className="mr-1 h-3 w-3" />
            Withdraw
          </Button>
          {row.expiresAt && <span className="text-[11px] text-subtle">Closes {clock.date(row.expiresAt)}</span>}
        </div>
      )}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      <Dialog open={answering} onClose={() => setAnswering(false)} title="What was done about it?">
        <div className="space-y-4">
          <p className="text-sm text-muted">
            {row.company.name} rated us {response?.rating}/5
            {response?.comment ? ` — “${response.comment}”` : ""}.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor={`note-${row.id}`}>What happened next</Label>
            <Textarea
              id={`note-${row.id}`}
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Called them back, replaced the switch, no charge."
            />
            <p className="text-xs text-subtle">
              Recorded against this response with your name and today&apos;s date. It is what makes &ldquo;we always
              follow up&rdquo; checkable rather than a belief.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              disabled={pending || !note.trim() || !response}
              onClick={() => {
                if (!response) return;
                setError(null);
                startTransition(async () => {
                  const result = await acknowledgeFeedback({ responseId: response.id, note });
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  setAnswering(false);
                  setNote("");
                  router.refresh();
                });
              }}
            >
              {pending ? "Saving…" : "Save"}
            </Button>
            <Button variant="secondary" onClick={() => setAnswering(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}
