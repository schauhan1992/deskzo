import { getOrganisation } from "@/lib/organisation";
import { SettingsPage } from "@/components/settings/settings-page";
import { FeedbackManager } from "@/components/settings/feedback-manager";

export default async function Page() {
  const organisation = await getOrganisation();

  return (
    <SettingsPage
      title="Customer feedback"
      description="How long a feedback link stays open, and what the customer reads when they follow it."
      settingsKey="feedback"
    >
      <FeedbackManager organisation={organisation} />
    </SettingsPage>
  );
}
