import { getOrganisation } from "@/lib/organisation";
import { marketingWebhookSecret } from "@/lib/marketing/webhook-secret";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { listProviders } from "@/actions/messaging-provider";
import { SettingsPage } from "@/components/settings/settings-page";
import { MarketingManager } from "@/components/settings/marketing-manager";
import { planGate } from "@/components/settings/module-disabled-notice";

export default async function Page() {
  // The providers are the marketing module's: campaigns are what they send.
  const gate = await planGate("marketing", "Mail & messaging");
  if (gate) return gate;
  const [organisation, providers, origin, webhookKey] = await Promise.all([getOrganisation(), listProviders(), tenantOrigin(), marketingWebhookSecret()]);
  // For the provider's delivery-report setting: this workspace's address, and its own secret.
  const webhookUrl = `${origin}/api/marketing/webhook/<provider>?key=${webhookKey}`;

  return (
    <SettingsPage
      title="Mail & messaging"
      description="The providers that actually send, the domain mail goes out from, and the hours it may go out in. Marketing is deliberately kept off the domain your invoices come from — a bad campaign should never be able to stop a purchase order arriving."
      settingsKey="messaging"
    >
      <MarketingManager organisation={organisation} providers={providers} webhookUrl={webhookUrl} />
    </SettingsPage>
  );
}
