import { listNumberSettings } from "@/actions/document-number";
import { SettingsPage } from "@/components/settings/settings-page";
import { NumberingManager } from "@/components/settings/numbering-manager";

export default async function Page() {
  const settings = await listNumberSettings();

  return (
    <SettingsPage
      title="Document numbering"
      description="The prefix and running number each kind of document is issued with. A number that has been issued is never reused, so changing a series affects what comes next and nothing that has already gone out."
      settingsKey="numbering"
    >
      <NumberingManager settings={settings} />
    </SettingsPage>
  );
}
