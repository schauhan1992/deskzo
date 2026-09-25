import { listCaptureKeys } from "@/actions/lead-capture";
import { SettingsPage } from "@/components/settings/settings-page";
import { LeadCaptureManager } from "@/components/settings/lead-capture-manager";
import { tenantOrigin } from "@/lib/tenancy/resolve";

/**
 * API keys for websites, and the documentation their developers need.
 *
 * The address in the documentation is the one this page was opened on — behind a proxy, the
 * forwarded host — because that is the address a developer outside can reach.
 */
export default async function Page() {
  const [keys, origin] = await Promise.all([listCaptureKeys(), tenantOrigin()]);

  return (
    <SettingsPage
      title="Lead capture API"
      description="Let your websites send enquiries straight into the CRM as leads — scored, assigned by your rules, and marked with the website they came from."
      settingsKey="lead-capture"
    >
      <LeadCaptureManager keys={keys} baseUrl={origin} />
    </SettingsPage>
  );
}
