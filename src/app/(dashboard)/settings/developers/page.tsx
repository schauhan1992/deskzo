import { notFound } from "next/navigation";
import { listApiKeys } from "@/actions/api-keys";
import { SettingsPage } from "@/components/settings/settings-page";
import { ApiKeysManager } from "@/components/settings/api-keys-manager";
import { siteOrigin } from "@/lib/billing/tax-invoice";
import { tenantOrigin } from "@/lib/tenancy/resolve";

/**
 * Settings › Developers & API (owner, 17 Oct 2026) — keys for the public API, acting as whoever makes
 * them, and its documentation. "Make API keys"; anybody else gets a 404, as every refused page does.
 */
export default async function DevelopersSettingsPage() {
  const data = await listApiKeys();
  if (!data) notFound();
  return (
    <SettingsPage settingsKey="developers" description="Keys for the public API — for Zapier, Make or your own systems. A key acts as you and can never do more than you can.">
      <ApiKeysManager keys={data.keys} everyone={data.everyone} origin={await tenantOrigin()} docsUrl={`${siteOrigin()}/developers`} />
    </SettingsPage>
  );
}
