import { Badge } from "@/components/ui/card";
import { RATING_LABELS, RATING_TONE, type CreditRating } from "@/lib/credit/engine";

/** A customer's credit rating, with the score beside it when there is one. */
export function CreditBadge({ rating, score }: { rating: CreditRating; score: number | null }) {
  return (
    <Badge tone={RATING_TONE[rating]} title={score !== null ? `Credit score ${score} out of 100` : "Not enough payment history to score"}>
      {RATING_LABELS[rating]}
      {score !== null && <span className="ml-1 opacity-80">· {score}</span>}
    </Badge>
  );
}
