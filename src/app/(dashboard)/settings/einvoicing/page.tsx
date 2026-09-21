import { getOrganisation } from "@/lib/organisation";
import { SettingsPage } from "@/components/settings/settings-page";
import { EInvoiceSettings } from "@/components/settings/organisation-manager";

export default async function Page() {
  const organisation = await getOrganisation();

  return (
    <SettingsPage
      title="e-Invoicing"
      description="The IRP connection that stamps an issued invoice with its IRN and signed QR code. The same credentials are used for e-way bills, so they are entered once, here."
      settingsKey="einvoicing"
    >
      <EInvoiceSettings organisation={organisation} />
    </SettingsPage>
  );
}
