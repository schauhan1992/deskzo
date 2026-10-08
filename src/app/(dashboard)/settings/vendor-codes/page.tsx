import { isModuleEnabled } from "@/actions/module";
import { getVendorCodeSettings } from "@/actions/vendor-codes";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SettingsPage } from "@/components/settings/settings-page";
import { VendorCodesManager } from "@/components/settings/vendor-codes-manager";

/** The prefix new vendors are numbered under (owner, 8 Oct 2026) — src/actions/vendor-codes.ts. */
export default async function Page() {
  if (!(await isModuleEnabled("vendors"))) return <ModuleDisabledNotice moduleKey="vendors" />;
  const settings = await getVendorCodeSettings();
  return (
    <SettingsPage
      settingsKey="vendor-codes"
      description="Every vendor, OEM, distributor and partner is given a code as it is added: this prefix, then the next number. A code can still be changed by hand on the vendor; numbering carries on after the highest one in use."
    >
      {settings && <VendorCodesManager settings={settings} />}
    </SettingsPage>
  );
}
