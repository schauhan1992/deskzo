import { getOrganisation, isOrganisationReady } from "@/lib/organisation";
import { SettingsPage } from "@/components/settings/settings-page";
import { OrganisationManager } from "@/components/settings/organisation-manager";
import { Card } from "@/components/ui/card";

export default async function Page() {
  const organisation = await getOrganisation();

  return (
    <SettingsPage
      title="Profile"
      description="Who this company is on paper. These details print on every proposal, invoice and purchase order, and are what the government portal checks a document against."
      settingsKey="organisation"
    >
      {!isOrganisationReady(organisation) && (
        <Card className="border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
          Your legal name, GSTIN, state code and registered address need to be filled in before an invoice can be
          reported to the e-invoice portal.
        </Card>
      )}
      <OrganisationManager organisation={organisation} />
    </SettingsPage>
  );
}
