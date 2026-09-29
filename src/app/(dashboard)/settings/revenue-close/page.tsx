import { getCloseSettings } from "@/actions/close";
import { SettingsPage } from "@/components/settings/settings-page";
import { planGate } from "@/components/settings/module-disabled-notice";
import { CloseSettingsForm } from "@/components/close/close-settings-form";
import { CLOSE_SETTINGS_DEFAULTS } from "@/lib/close/settings";

/** Revenue & Close's settings: automatic posting, how revenue spreads, and the flux thresholds (`close.manage`). */
export default async function RevenueCloseSettingsPage() {
  const gate = await planGate("revenue_close", "Revenue & Close");
  if (gate) return gate;
  const settings = (await getCloseSettings()) ?? CLOSE_SETTINGS_DEFAULTS;

  return (
    <SettingsPage
      settingsKey="revenue-close"
      description="Whether revenue recognition and prepaids post themselves each night, how a new revenue schedule spreads its amount, and how large a month-on-month change must be before the close asks for an explanation."
    >
      <CloseSettingsForm settings={settings} />
    </SettingsPage>
  );
}
