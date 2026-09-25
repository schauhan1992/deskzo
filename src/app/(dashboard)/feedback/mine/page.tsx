import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { feedbackAbout } from "@/actions/feedback";
import { currentUser } from "@/lib/session";
import { Card } from "@/components/ui/card";
import { FeedbackList } from "@/components/feedback/feedback-list";
import { FeedbackSummaryStrip } from "@/components/feedback/feedback-summary";
import { tenantOrigin } from "@/lib/tenancy/resolve";

/**
 * What customers have said about you, by name.
 *
 * Shown to the person themselves without any permission, on purpose. Feedback about somebody's own
 * work that they are not allowed to read is worse than useless — it is a file being kept on them.
 */
export default async function MyFeedbackPage() {
  const enabled = await isModuleEnabled("feedback");
  if (!enabled) return <ModuleDisabledNotice moduleKey="feedback" />;

  const user = await currentUser();
  const data = user ? await feedbackAbout(user.id) : null;

  // The workspace's own address — links from here are pasted into WhatsApp and emails.
  const origin = await tenantOrigin();

  if (!data) {
    return (
      <div className="animate-fade-rise">
        <h1 className="text-xl font-semibold text-text">About me</h1>
        <Card className="mt-5 px-4 py-12 text-center text-sm text-subtle">Nothing to show.</Card>
      </div>
    );
  }

  return (
    <div className="animate-fade-rise">
      <h1 className="text-xl font-semibold text-text">What customers said about me</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Only feedback where you were named as the person they dealt with. The overall score is about the company; the
        one next to your name is about you.
      </p>

      <div className="mt-5">
        <FeedbackSummaryStrip summary={data.summary} />
      </div>

      <div className="mt-4">
        <FeedbackList
          rows={data.rows}
          origin={origin}
          emptyHint="No customer has been asked about you yet."
        />
      </div>
    </div>
  );
}
