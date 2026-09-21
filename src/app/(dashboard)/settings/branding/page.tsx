import { getBranding } from "@/actions/branding";
import { SettingsPage } from "@/components/settings/settings-page";
import { BrandingManager } from "@/components/settings/branding-manager";

export default async function Page() {
  const branding = await getBranding();

  return (
    <SettingsPage
      title="Branding"
      description="Make the app your own — name, logo, colour and default theme. Changes apply everywhere the moment you save."
      settingsKey="branding"
    >
      <BrandingManager branding={branding} />
    </SettingsPage>
  );
}
