import type { Metadata } from "next";
import { getFeedbackForm } from "@/actions/feedback-public";
import { Card } from "@/components/ui/card";
import { FeedbackForm } from "@/components/feedback/feedback-form";

/**
 * Two things are set here rather than in the layout, and both matter.
 *
 * `referrer: "no-referrer"` because the token is in this URL. Any navigation away from this page —
 * including the one to the public review site — would otherwise hand the far end a `Referer`
 * header containing a live credential. `OutboundLink` covers links; this covers everything,
 * including the scripted redirect on the thank-you page.
 *
 * `robots: noindex` because a feedback link that turns up in a search result is a feedback link
 * somebody else can answer.
 */
export const metadata: Metadata = {
  title: "Your feedback",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

/**
 * The feedback form, reached without signing in.
 *
 * Every failure — no such token, expired, withdrawn, already answered — renders the same page.
 * Telling them apart would turn this into an oracle for working out which tokens are real.
 */
export default async function ReviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const info = await getFeedbackForm(token);

  if (!info) {
    return (
      <Card className="mx-auto max-w-lg px-6 py-12 text-center">
        <h1 className="text-lg font-semibold text-text">This feedback link is closed</h1>
        <p className="mt-2 text-sm text-muted">
          It may have expired, or already been answered. If you still have something to tell us, reply to the message
          it came from — it reaches the same people.
        </p>
      </Card>
    );
  }

  return <FeedbackForm token={token} info={info} />;
}
