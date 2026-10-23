import { isModuleEnabled } from "@/actions/module";
import { paymentCollectionView } from "@/actions/payment-collection";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SettingsPage } from "@/components/settings/settings-page";
import { PaymentCollectionSettings } from "@/components/settings/payment-collection-settings";

export const metadata = { title: "Payment collection" };

/**
 * Settings › Payment collection (owner, 23 Oct 2026 — src/lib/collect). `settings.manage` (the catalogue's
 * gate) opens it, where Receivables is on.
 */
export default async function Page() {
  if (!(await isModuleEnabled("receivables"))) return <ModuleDisabledNotice moduleKey="receivables" />;
  return (
    <SettingsPage
      settingsKey="payment-collection"
      description="Pay-now links through your own Razorpay or Cashfree account, the reminders customers get before and after an invoice is due, credit hold for customers who pay late, and MSME late-payment interest."
    >
      <Overview />
    </SettingsPage>
  );
}

/** Read only once the page's gate has let the person in. */
async function Overview() {
  const view = await paymentCollectionView();
  if (!view.ok) return <p className="text-sm text-danger">{view.error}</p>;
  return <PaymentCollectionSettings view={view.data} />;
}
