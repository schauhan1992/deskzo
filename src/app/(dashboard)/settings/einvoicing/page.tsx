import { getOrganisation } from "@/lib/organisation";
import { listBranchesForSettings } from "@/actions/branch";
import { SettingsPage } from "@/components/settings/settings-page";
import { EInvoiceSettings } from "@/components/settings/organisation-manager";

export default async function Page() {
  // The switch and minimum are the company's; the logins are each registration's (null without settings.manage).
  const [organisation, branches] = await Promise.all([getOrganisation(), listBranchesForSettings()]);

  return (
    <SettingsPage
      title="e-Invoicing"
      description="The IRP connection that stamps an issued invoice with its IRN and signed QR code. The same credentials are used for e-way bills, so they are entered once, here."
      settingsKey="einvoicing"
    >
      <EInvoiceSettings organisation={organisation} registrations={branches?.registrations ?? []} />
    </SettingsPage>
  );
}
