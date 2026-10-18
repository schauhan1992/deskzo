import { getCustomerEmails } from "@/actions/customer-emails";
import { SettingsPage } from "@/components/settings/settings-page";
import { CustomerEmailSettings } from "@/components/settings/customer-email-settings";

export const metadata = { title: "Customer emails" };

/**
 * Settings → Customer emails (owner, 18 Oct 2026) — src/lib/customer-emails.ts. `settings.manage` (the
 * catalogue's gate) opens it; each row is there only where its module is.
 */
export default async function Page() {
  return (
    <SettingsPage
      settingsKey="customer-emails"
      description="Every email your customers get from here: which go on their own and which a person sends, where each goes from, and what stops it."
    >
      <Overview />
    </SettingsPage>
  );
}

/** Read only once the page's gate has let the person in. */
async function Overview() {
  const overview = await getCustomerEmails();
  if (!overview.ok) return <p className="text-sm text-danger">{overview.error}</p>;
  return <CustomerEmailSettings overview={overview.data} />;
}
