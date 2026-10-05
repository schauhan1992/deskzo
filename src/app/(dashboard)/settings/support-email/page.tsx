import { getSupportMailSetup } from "@/actions/support-mail";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SettingsPage } from "@/components/settings/settings-page";
import { SupportEmailSettings } from "@/components/settings/support-email-settings";

/**
 * Settings → Support email (owner, 5 Oct 2026) — src/actions/support-mail.ts, src/lib/support-mail.
 * `settings.manage` and the helpdesk (the catalogue's gate) open it.
 */
export default async function Page() {
  if (!(await isModuleEnabled("helpdesk"))) return <ModuleDisabledNotice moduleKey="helpdesk" />;
  const setup = await getSupportMailSetup();
  return (
    <SettingsPage
      settingsKey="support-email"
      description="Forward your support mail to your helpdesk address and every email becomes a ticket — replies go back to the customer from the ticket, and their answers land on it."
    >
      {setup && <SupportEmailSettings setup={setup} />}
    </SettingsPage>
  );
}
