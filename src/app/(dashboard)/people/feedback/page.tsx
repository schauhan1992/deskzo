import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listInternalFeedback } from "@/actions/internal-feedback";
import { FeedbackInbox } from "@/components/engagement/feedback-inbox";

export default async function FeedbackInboxPage() {
  if (!(await isModuleEnabled("engagement"))) return <ModuleDisabledNotice moduleKey="engagement" />;

  const items = await listInternalFeedback();
  // Null means the permission is absent. Not found rather than an explanation, because a page that
  // says "you can't see the anonymous feedback" is itself a small disclosure.
  if (items === null) notFound();

  return (
    <div className="animate-fade-rise">
      <h1 className="text-xl font-semibold text-text">Anonymous feedback</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        What people have sent through the Speak up channel.
      </p>
      <div className="mt-5">
        <FeedbackInbox items={items} />
      </div>
    </div>
  );
}
