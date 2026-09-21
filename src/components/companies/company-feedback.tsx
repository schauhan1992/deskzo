import { headers } from "next/headers";
import { companyFeedback } from "@/actions/feedback";
import { getOrganisation } from "@/lib/organisation";
import { Card, CardContent } from "@/components/ui/card";
import { FeedbackList } from "@/components/feedback/feedback-list";
import { FeedbackSummaryStrip } from "@/components/feedback/feedback-summary";
import { AskFeedbackDialog } from "@/components/feedback/ask-feedback-dialog";
import { MIN_RATING } from "@/lib/feedback/rating";

/**
 * What this customer has told us, on their own page.
 *
 * Sat next to the tickets and the orders rather than on a page of its own because that is where the
 * question comes up: somebody opens an account before a renewal call and wants to know whether the
 * last engineer visit went well before they pick up the phone.
 */
export async function CompanyFeedback({ companyId, companyName }: { companyId: string; companyName: string }) {
  const [{ rows, summary, canRequest }, org] = await Promise.all([companyFeedback(companyId), getOrganisation()]);

  const head = await headers();
  const host = head.get("x-forwarded-host") ?? head.get("host") ?? "localhost:3000";
  const proto = head.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${proto}://${host}`;

  const gated = org.feedbackReviewUrl && org.feedbackReviewMinRating > MIN_RATING;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">
          Ask them how it went — about the person who dealt with them, and about what they bought. The link works
          once and expires.{" "}
          {org.feedbackReviewUrl
            ? gated
              ? `A score of ${org.feedbackReviewMinRating} or more is also offered your public review page; anything lower stays here.`
              : "Everyone is also offered your public review page afterwards."
            : "No public review page is set up, so nothing is offered."}
        </p>
        {canRequest && <AskFeedbackDialog companyId={companyId} companyName={companyName} origin={origin} />}
      </div>

      {summary.asked > 0 ? (
        <FeedbackSummaryStrip summary={summary} />
      ) : (
        <Card>
          <CardContent className="py-10 text-center text-sm text-subtle">
            {companyName} hasn&apos;t been asked for feedback yet.
          </CardContent>
        </Card>
      )}

      {summary.asked > 0 && (
        <FeedbackList rows={rows} origin={origin} showCompany={false} emptyHint="Nothing recorded for them yet." />
      )}
    </div>
  );
}
