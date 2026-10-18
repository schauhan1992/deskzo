import { isModuleEnabled } from "@/actions/module";
import { notificationEmailChoices } from "@/actions/notification";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SettingsPage } from "@/components/settings/settings-page";
import { NotificationEmailSettings, type NotificationSender } from "@/components/settings/notification-email-settings";
import { emailRouteFor } from "@/lib/marketing/pipeline";

export const metadata = { title: "Email notifications" };

/**
 * Settings → Email notifications (owner, 18 Oct 2026) — src/lib/notifications/email-settings.ts.
 * `settings.manage` and the notifications module (the catalogue's gate) open it.
 */
export default async function Page() {
  if (!(await isModuleEnabled("notifications"))) return <ModuleDisabledNotice moduleKey="notifications" />;
  return (
    <SettingsPage
      settingsKey="notification-emails"
      description="Which notifications go to people's inboxes as well as their bell. The choice is the same for everyone, and a person can't switch an email off for themselves."
    >
      <Choices />
    </SettingsPage>
  );
}

/** Read only once the page's gate has let the person in. */
async function Choices() {
  const [choices, route] = await Promise.all([notificationEmailChoices(), emailRouteFor("TRANSACTIONAL")]);
  if (!choices.ok) return <p className="text-sm text-danger">{choices.error}</p>;
  const sender: NotificationSender = route ? { via: "COMPANY", from: route.fromEmail ?? route.label } : { via: "DESKZO" };
  return <NotificationEmailSettings choices={choices.data} sender={sender} />;
}
