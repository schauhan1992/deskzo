import { getOrganisation } from "@/lib/organisation";
import { listProviders } from "@/actions/messaging-provider";
import { SettingsPage } from "@/components/settings/settings-page";
import { MarketingManager } from "@/components/settings/marketing-manager";

export default async function Page() {
  const [organisation, providers] = await Promise.all([getOrganisation(), listProviders()]);

  return (
    <SettingsPage
      title="Mail & messaging"
      description="The providers that actually send, the domain mail goes out from, and the hours it may go out in. Marketing is deliberately kept off the domain your invoices come from — a bad campaign should never be able to stop a purchase order arriving."
      settingsKey="messaging"
    >
      <MarketingManager organisation={organisation} providers={providers} />
    </SettingsPage>
  );
}
