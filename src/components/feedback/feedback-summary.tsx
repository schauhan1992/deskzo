import { Star } from "lucide-react";
import type { FeedbackSummary } from "@/lib/feedback/rating";
import { MAX_RATING, MIN_RATING, ratingTone } from "@/lib/feedback/rating";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const TONE_BAR: Record<string, string> = {
  green: "bg-success",
  amber: "bg-warning",
  red: "bg-danger",
  default: "bg-line",
};

/**
 * The numbers above a list of responses.
 *
 * The response rate is given the same weight as the average on purpose. People who didn't reply
 * skew unhappy, so "4.8" from three replies out of forty is not a 4.8 — and a page that shows the
 * average alone quietly turns a silence problem into a congratulation.
 */
export function FeedbackSummaryStrip({ summary }: { summary: FeedbackSummary }) {
  const scores = Array.from({ length: MAX_RATING - MIN_RATING + 1 }, (_, i) => MAX_RATING - i);
  const most = Math.max(1, ...scores.map((s) => summary.distribution[s] ?? 0));

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      <Card className="px-4 py-3">
        <div className="text-xs uppercase tracking-wide text-subtle">Average</div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums text-text">
            {summary.average === null ? "—" : summary.average.toFixed(1)}
          </span>
          {summary.average !== null && (
            <span className="flex items-center gap-0.5">
              {scores
                .slice()
                .reverse()
                .map((s) => (
                  <Star
                    key={s}
                    className={cn(
                      "h-3.5 w-3.5",
                      summary.average !== null && s <= Math.round(summary.average)
                        ? "fill-warning text-warning"
                        : "text-line",
                    )}
                    aria-hidden
                  />
                ))}
            </span>
          )}
        </div>
        <div className="mt-0.5 text-xs text-muted">
          {summary.answered === 0
            ? "Nobody has replied yet"
            : `${summary.answered} ${summary.answered === 1 ? "reply" : "replies"} · ${summary.happy} happy, ${summary.unhappy} not`}
        </div>
      </Card>

      <Card className="px-4 py-3">
        <div className="text-xs uppercase tracking-wide text-subtle">Replied</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums text-text">
          {summary.responseRate === null ? "—" : `${summary.responseRate}%`}
        </div>
        <div className="mt-0.5 text-xs text-muted">
          {summary.answered} of {summary.asked} asked
          {summary.unanswered > 0 && ` · ${summary.unanswered} low score${summary.unanswered === 1 ? "" : "s"} unanswered`}
        </div>
      </Card>

      <Card className="px-4 py-3">
        <div className="text-xs uppercase tracking-wide text-subtle">Spread</div>
        <div className="mt-2 space-y-1">
          {scores.map((score) => {
            const count = summary.distribution[score] ?? 0;
            return (
              <div key={score} className="flex items-center gap-2">
                <span className="w-3 text-right text-[11px] tabular-nums text-subtle">{score}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                  <div
                    className={cn("h-full rounded-full", TONE_BAR[ratingTone(score)])}
                    style={{ width: `${(count / most) * 100}%` }}
                  />
                </div>
                <span className="w-5 text-right text-[11px] tabular-nums text-subtle">{count}</span>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

/** The same average, small, for a header or a person's row. */
export function RatingStars({ rating, className }: { rating: number | null; className?: string }) {
  const stars = Array.from({ length: MAX_RATING - MIN_RATING + 1 }, (_, i) => MIN_RATING + i);
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)} aria-label={rating === null ? "Not rated" : `${rating} out of ${MAX_RATING}`}>
      {stars.map((s) => (
        <Star
          key={s}
          className={cn("h-3.5 w-3.5", rating !== null && s <= rating ? "fill-warning text-warning" : "text-line")}
          aria-hidden
        />
      ))}
    </span>
  );
}
