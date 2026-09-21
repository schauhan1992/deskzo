import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { feedbackSubjects, remainingFeedbackToday } from "@/actions/internal-feedback";
import { SpeakUpForm } from "@/components/engagement/speak-up-form";

export default async function SpeakUpPage() {
  if (!(await isModuleEnabled("engagement"))) return <ModuleDisabledNotice moduleKey="engagement" />;

  const [people, remaining] = await Promise.all([feedbackSubjects(), remainingFeedbackToday()]);

  return (
    <div className="animate-fade-rise">
      <h1 className="text-xl font-semibold text-text">Speak up</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Anonymous feedback about anyone or anything, straight to HR and the directors. Nothing is recorded about
        who sent it — the panel on the right explains exactly how, including the one thing it can&apos;t protect.
      </p>
      <div className="mt-5">
        <SpeakUpForm people={people} remainingToday={remaining} />
      </div>
    </div>
  );
}
