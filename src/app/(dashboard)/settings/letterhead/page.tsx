import { getOrganisation } from "@/lib/organisation";
import { getBranding } from "@/actions/branding";
import { SettingsPage } from "@/components/settings/settings-page";
import { LetterheadManager } from "@/components/settings/letterhead-manager";

export default async function Page() {
  const [organisation, branding] = await Promise.all([getOrganisation(), getBranding()]);

  return (
    <SettingsPage
      title="Letterhead"
      description="What sits at the top and bottom of a printed document. Separate from the app's own branding, because the logo on an invoice is the company's and the logo in the sidebar is the software's."
      settingsKey="letterhead"
    >
      <LetterheadManager organisation={organisation} appLogoDataUrl={branding.logoDataUrl} />
    </SettingsPage>
  );
}
